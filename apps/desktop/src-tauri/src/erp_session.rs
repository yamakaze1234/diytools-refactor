// 常驻 ERP 进程的请求会话：串行交换带编号的 JSON，凭据交给辅助进程处理，退出时回收进程。
use crate::erp_runtime::{self, ProcessGuard};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionInput {
    action: String,
    domain: Option<String>,
    username: Option<String>,
    password: Option<String>,
    cookie: Option<String>,
    sku: Option<String>,
    settings: Option<Value>,
    remember: Option<bool>,
}

#[derive(Default)]
pub struct ErpSessionState {
    worker: Mutex<Option<Worker>>,
    vault: std::sync::OnceLock<std::path::PathBuf>,
}

struct Worker {
    _guard: ProcessGuard,
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Worker {
    // 启动常驻 worker 并建立独立管道；凭据文件位置仅由宿主初始化传入。
    fn spawn(vault: Option<&std::path::PathBuf>) -> Result<Self, String> {
        let data_dir = vault
            .and_then(|path| path.parent())
            .ok_or("ERP_RUNTIME_UNAVAILABLE: 本机数据目录尚未配置")?;
        let mut command = erp_runtime::command(data_dir)?;
        command.env_remove("DIYTOOLS_SQL_VAULT");
        if let Some(vault) = vault {
            command.env("DIYTOOLS_SQL_VAULT", vault);
        }
        let mut child = command
            .arg("--serve")
            .spawn()
            .map_err(|_| "无法启动 ERP 辅助程序")?;
        let guard = ProcessGuard::attach(&child)?;
        let input = child.stdin.take().ok_or("无法建立 ERP 请求通道")?;
        let output = BufReader::new(child.stdout.take().ok_or("无法建立 ERP 响应通道")?);
        Ok(Self {
            _guard: guard,
            _child: child,
            input,
            output,
        })
    }

    // 按换行交换单条响应并限制字节数，截断或未结束响应不能当作成功结果。
    async fn exchange(&mut self, bytes: &[u8], maximum: usize) -> Result<Value, String> {
        self.input
            .write_all(bytes)
            .await
            .map_err(|_| "ERP 请求通道已关闭")?;
        self.input.flush().await.map_err(|_| "ERP 请求通道已关闭")?;
        let mut response = Vec::new();
        (&mut self.output)
            .take(maximum as u64 + 1)
            .read_until(b'\n', &mut response)
            .await
            .map_err(|_| "ERP 响应通道已关闭")?;
        if response.len() > maximum || response.last() != Some(&b'\n') {
            return Err("ERP 响应超出限制或连接已断开".into());
        }
        serde_json::from_slice(&response).map_err(|_| "ERP 返回格式无效".into())
    }
}

impl ErpSessionState {
    // 凭据存储路径只允许初始化一次，不能由后续页面请求切换。
    pub fn configure_vault(&self, path: std::path::PathBuf) -> Result<(), String> {
        self.vault
            .set(path)
            .map_err(|_| "本机凭据目录已经配置".into())
    }

    // SQL 入口只开放读取和本机凭据管理，拒绝辅助程序的其他动作。
    pub(crate) async fn sql_request(&self, input: Value) -> Result<Value, String> {
        let input: SessionInput = serde_json::from_value(input).map_err(|_| "SQL 请求字段无效")?;
        if !["sql_read", "sql_credentials_load", "sql_credentials_clear"]
            .contains(&input.action.as_str())
        {
            return Err("不支持此 SQL 操作".into());
        }
        self.request(input).await
    }
    // 用状态与断开动作验证 worker 协议，完成后释放辅助进程。
    pub async fn offline_probe(&self) -> Result<Value, String> {
        let status = self
            .request(serde_json::from_value(json!({"action":"status"})).unwrap())
            .await?;
        let disconnected = self
            .request(serde_json::from_value(json!({"action":"disconnect"})).unwrap())
            .await?;
        self.shutdown().await;
        Ok(json!({"status": status, "disconnected": disconnected}))
    }

    // 先关闭管道让 Python 正常收尾，超时后依靠进程保护回收后代。
    pub async fn shutdown(&self) {
        let mut state = self.worker.lock().await;
        if let Some(worker) = state.take() {
            // EOF lets Python close the connection and the bootloader reclaim its files.
            let Worker {
                _guard,
                mut _child,
                input,
                output,
            } = worker;
            drop(input);
            drop(output);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), _child.wait()).await;
            drop(_guard);
        }
    }
    // 串行发送带唯一编号的请求；超时、协议错误或管道失败都丢弃旧 worker。
    async fn request(&self, input: SessionInput) -> Result<Value, String> {
        if ![
            "status",
            "connect",
            "query_goods",
            "disconnect",
            "sql_read",
            "sql_credentials_load",
            "sql_credentials_clear",
        ]
        .contains(&input.action.as_str())
        {
            return Err("不支持此 ERP 操作".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let maximum = if input.action == "sql_read" {
            32 * 1024 * 1024
        } else {
            2 * 1024 * 1024
        };
        let mut request = json!({"id":id,"action":input.action});
        if let Some(settings) = input.settings {
            request["settings"] = settings;
        }
        if let Some(remember) = input.remember {
            request["remember"] = Value::Bool(remember);
        }
        for (key, value) in [
            ("domain", input.domain),
            ("username", input.username),
            ("password", input.password),
            ("cookie", input.cookie),
            ("sku", input.sku),
        ] {
            if let Some(value) = value {
                request[key] = Value::String(value);
            }
        }
        let mut bytes = serde_json::to_vec(&request).map_err(|_| "ERP 请求格式无效")?;
        bytes.push(b'\n');
        if bytes.len() > 64 * 1024 {
            return Err("ERP 请求超过 64 KiB 限制".into());
        }
        // 已有请求占用 worker 时立即返回忙碌提示，不能把两条响应交错读入同一管道。
        let mut state = self
            .worker
            .try_lock()
            .map_err(|_| "ERP 正在处理请求，请稍后重试")?;
        if state.is_none() {
            *state = Some(Worker::spawn(self.vault.get())?);
        }
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(75),
            state.as_mut().unwrap().exchange(&bytes, maximum),
        )
        .await;
        let response = match response {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                *state = None;
                return Err(error);
            }
            Err(_) => {
                *state = None;
                return Err("ERP 请求超时，连接已断开，请重新登录。".into());
            }
        };
        // 请求编号和成功标记必须同时匹配，否则断开会话以免把旧响应当成本次结果。
        if response["id"] != id || !response["ok"].is_boolean() {
            *state = None;
            return Err("ERP 响应校验失败，连接已断开。".into());
        }
        if response["ok"] == true {
            return response
                .get("result")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or("ERP 返回结果无效".into());
        }
        // The worker's error code is trusted; never forward arbitrary exception/message text.
        Err(match response["error"]["code"].as_str().unwrap_or("") {
            "AUTH_FAILED" => "ERP 登录失败，请核对账号密码或 Cookie。",
            "NOT_CONNECTED" => "请先连接 ERP。",
            "AMBIGUOUS" => "同一 SKU 对应多个 ERP 商品，无法唯一确定。",
            "NOT_LINKED" => "该 SKU 尚未关联 ERP 商品。",
            "MISSING_CREDENTIALS" => "请填写完整账号密码或单个 _wdb Cookie。",
            "SESSION_EXPIRED" => "ERP 会话已失效，请重新登录。",
            "NETWORK_ERROR" => "ERP 网络连接失败，连接已断开，请检查公司网络并重新登录。",
            "QUERY_FAILED" => "ERP 查询失败，连接已断开，请重新登录后查询。",
            "INVALID_RESPONSE" | "INCOMPLETE_RESULTS" => "ERP 返回数据不完整，未展示不确定的结果。",
            "PACKAGE_UNAVAILABLE" => "公司 ERP 依赖不可用，请检查本机环境。",
            "INVALID_REQUEST" | "INVALID_DOMAIN" => "ERP 输入无效，请核对填写内容。",
            "TOO_MANY_RESULTS" | "OUTPUT_TOO_LARGE" => "ERP 返回结果超出本次查询限制。",
            "SQL_CONNECTION" => "数据库连接失败，请核对公司网络和连接设置。本机数据未改动。",
            "SQL_TIMEOUT" => "数据库查询超时，请稍后重新读取。本机数据未改动。",
            "SQL_CERTIFICATE" => "数据库证书校验失败；公司使用自签证书时可选择信任服务器证书。",
            "SQL_DATABASE" => "数据库不存在或无权打开，请填写实际数据库名。",
            "SQL_LOGIN" => "数据库登录失败，请核对只读账号和密码。",
            "SQL_SCHEMA" => "缺少库存视图、字段或只读查询权限。",
            "SQL_SETTINGS" => "请填写有效的服务器、端口、数据库、只读账号和密码。",
            "SQL_INVALID_DATA" | "SQL_INVALID_RESPONSE" => {
                "数据库返回数据不完整或存在无效字段，原数据已保留。"
            }
            "SQL_TOO_MANY_RESULTS" => "数据库返回超过 100000 行，已拒收截断结果。",
            "SQL_CREDENTIALS" | "SQL_CREDENTIALS_FAILED" => {
                "无法读取或保存本机加密连接，请重新填写后重试。"
            }
            "SQL_CREDENTIALS_UNAVAILABLE" => "当前环境无法使用本机加密连接存储。",
            _ => "ERP 请求未完成，请检查输入和公司网络后重试。",
        }
        .into())
    }
}

#[tauri::command]
// 页面 ERP 会话入口不接受 SQL 动作，SQL 必须经过专用预览及确认通路。
pub async fn erp_session_request(
    state: tauri::State<'_, ErpSessionState>,
    input: SessionInput,
) -> Result<Value, String> {
    if input.action.starts_with("sql_") {
        return Err("SQL 操作请通过 ERP 同步入口使用。".into());
    }
    state.request(input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires locally installed optional ERP worker"]
    fn worker_status_disconnect_and_forbidden_action() {
        tauri::async_runtime::block_on(async {
            let state = ErpSessionState::default();
            // 离线探针只绑定独立示例目录，不读取当前使用版保存的 SQL 或服务配置。
            state
                .configure_vault(
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../../sandbox/erp-portable-tests/sql-test.dpapi.json"),
                )
                .unwrap();
            for action in ["status", "disconnect"] {
                let result = state
                    .request(serde_json::from_value(json!({"action":action})).unwrap())
                    .await
                    .unwrap();
                assert_eq!(result["connected"], false);
                assert_eq!(result["package_version"], "external-adapter");
            }
            assert!(
                state
                    .request(serde_json::from_value(json!({"action":"write"})).unwrap())
                    .await
                    .is_err()
            );
            assert!(
                state
                    .request(
                        serde_json::from_value(
                            json!({"action":"query_goods","sku":"offline-probe"})
                        )
                        .unwrap()
                    )
                    .await
                    .is_err()
            );
            state.shutdown().await;
        });
    }
}
