// 云同步原生入口：隔离登录凭据，协调本机绑定、原图缓存、取消状态与持久队列授权。
//! Native IPC boundary for cloud access. No credentials are returned to the renderer.
use crate::{
    cloud_transport::{CLOUD_NOT_CONFIGURED, CloudTransport, CloudTransportConfig},
    workbench_store::{self, ApiResponse, WorkbenchStore},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

pub struct CloudRuntime {
    transport: Arc<CloudTransport>,
    plan: Mutex<Option<CachedPlan>>,
    identity_gate: RwLock<()>,
    assets_gate: Mutex<()>,
    connect_gate: Mutex<()>,
    epoch: AtomicU64,
    asset_cancel_epoch: AtomicU64,
    cancelled_assets: Mutex<BTreeSet<String>>,
}
struct CachedPlan {
    token: String,
    bytes: Vec<u8>,
    document: Value,
    epoch: u64,
}
impl CloudRuntime {
    // 创建共享传输会话及身份、原图、首次绑定的独立互斥门，避免任务相互覆盖。
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        let path = data_dir.join("integrations.json");
        // 只读取应用数据目录的本机配置；缺文件或缺 cloud 字段允许使用本地工作台。
        let transport = match fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(64 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "CLOUD_CONFIG_INVALID: 无法读取本机接入配置")?;
                if bytes.len() > 64 * 1024 {
                    return Err("CLOUD_CONFIG_INVALID: 本机接入配置过大".into());
                }
                let document: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "CLOUD_CONFIG_INVALID: 本机接入配置格式无效")?;
                if document["version"] != 1 {
                    return Err("CLOUD_CONFIG_INVALID: 本机接入配置版本无效".into());
                }
                match document.get("cloud").filter(|value| !value.is_null()) {
                    Some(value) => CloudTransport::new(
                        serde_json::from_value::<CloudTransportConfig>(value.clone())
                            .map_err(|_| "CLOUD_CONFIG_INVALID: 本机云服务配置格式无效")?,
                    )?,
                    None => CloudTransport::unconfigured()?,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                CloudTransport::unconfigured()?
            }
            Err(_) => return Err("CLOUD_CONFIG_INVALID: 无法读取本机接入配置".into()),
        };
        Ok(Self {
            transport: Arc::new(transport),
            plan: Mutex::new(None),
            identity_gate: RwLock::new(()),
            assets_gate: Mutex::new(()),
            connect_gate: Mutex::new(()),
            epoch: AtomicU64::new(0),
            asset_cancel_epoch: AtomicU64::new(0),
            cancelled_assets: Mutex::new(BTreeSet::new()),
        })
    }
}
fn response(status: u16, value: Value) -> ApiResponse {
    ApiResponse {
        status,
        body: value.to_string(),
    }
}
// 仅使用原生传输层已验证的成员身份，不能以页面传入值替代。
fn member(runtime: &CloudRuntime) -> Result<Value, String> {
    // 本地模式不能通过加载或绑定入口间接触发云操作。
    if runtime.transport.status()?["configured"] == false {
        return Err(CLOUD_NOT_CONFIGURED.into());
    }
    runtime
        .transport
        .current_member()?
        .ok_or_else(|| "请先登录成员账号".into())
}

// 原图必须使用 SHA-256 文件名和允许的扩展名，不能接受任意路径或地址。
fn asset_name(url: &str) -> Result<&str, String> {
    let name = url.strip_prefix("/uploads/").ok_or("原图路径无效")?;
    let (hash, ext) = name.split_once('.').ok_or("原图路径无效")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !["png", "jpg"].contains(&ext)
    {
        return Err("原图路径无效".into());
    }
    Ok(name)
}
// 验证非空原图、大小上限和内容摘要，命名一致才可复用已有缓存。
fn verified(name: &str, bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len() <= 24 * 1024 * 1024
        && name.split('.').next() == Some(format!("{:x}", Sha256::digest(bytes)).as_str())
}
// 先校验再暂存并同步落盘；同名文件只有内容正确时可复用，不覆盖异常文件。
fn cache_bytes(store: &WorkbenchStore, name: &str, bytes: &[u8]) -> Result<(), String> {
    if !verified(name, bytes) {
        return Err("原图内容校验失败".into());
    }
    let root = store.assets.join("uploads");
    fs::create_dir_all(&root).map_err(|_| "无法创建原图缓存目录")?;
    let target = root.join(name);
    if target.exists() {
        let current = fs::read(&target).map_err(|_| "无法读取已有原图")?;
        if verified(name, &current) {
            return Ok(());
        }
        return Err("本机已有同名原图校验失败，请检查；未覆盖原文件".into());
    }
    let temporary = root.join(format!(".cloud-{}.partial", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法暂存原图")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "原图暂存失败，未替换已有图片")?;
    drop(file);
    // MoveFileW is atomic and never replaces a concurrently created destination.
    // Failed staging files remain available for recoverable cleanup.
    if install_staged(&temporary, &target).is_err()
        && !fs::read(&target).is_ok_and(|current| verified(name, &current))
    {
        return Err("原图缓存安装未完成，请重试；已保留暂存文件".into());
    }
    Ok(())
}

// Windows 原子安装暂存图且不覆盖并发创建的目标；失败时保留暂存内容。
fn install_staged(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
        }
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both paths are generated under the validated content-addressed cache root.
        if unsafe { MoveFileW(source.as_ptr(), destination.as_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}
// 按环境、工作区和文件名记录已验证的云端原图，避免跨账号复用上传确认。
fn asset_db(store: &WorkbenchStore) -> Result<Connection, String> {
    let c = Connection::open(&store.path).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS workbench_cloud_assets(environment TEXT NOT NULL,workspace TEXT NOT NULL,name TEXT NOT NULL,verified_at TEXT NOT NULL,PRIMARY KEY(environment,workspace,name))").map_err(|e|e.to_string())?;
    Ok(c)
}
// 本机有合格原图时直接复用；上传确认只在云端可用且成员身份未变化后登记。
fn ensure_one(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    owner: &Value,
    url: &str,
    upload: bool,
    check_cancel: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check_cancel()?;
    let name = asset_name(url)?;
    let workspace = owner["workspaceId"].as_str().ok_or("成员工作区无效")?;
    let file = store.assets.join("uploads").join(name);
    let local = if file.exists() {
        if fs::metadata(&file).map_err(|_| "无法读取本机原图")?.len() > 24 * 1024 * 1024 {
            return Err("本机原图超过24MiB".into());
        }
        let bytes = fs::read(&file).map_err(|_| "无法读取本机原图")?;
        if !verified(name, &bytes) {
            return Err("本机原图摘要与文件名不一致".into());
        }
        Some(bytes)
    } else {
        None
    };
    if !upload && local.is_some() {
        return Ok(());
    }
    if upload {
        let c = asset_db(store)?;
        let cached:Option<i64>=c.query_row("SELECT 1 FROM workbench_cloud_assets WHERE environment=?1 AND workspace=?2 AND name=?3",params![runtime.transport.environment(),workspace,name],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if cached.is_some() && local.is_some() {
            return Ok(());
        }
    }
    check_cancel()?;
    match runtime.transport.storage_get(name) {
        Ok(bytes) => cache_bytes(store, name, &bytes)?,
        Err(error) if upload && error.starts_with("STORAGE_NOT_FOUND:") => {
            check_cancel()?;
            let bytes = local.ok_or("本机和云端均缺少原图，已停止提交配置")?;
            runtime.transport.storage_upload(
                name,
                &bytes,
                if name.ends_with(".png") {
                    "image/png"
                } else {
                    "image/jpeg"
                },
            )?;
        }
        Err(error) => return Err(error),
    }
    if runtime
        .transport
        .current_member()?
        .as_ref()
        .is_none_or(|current| {
            current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"]
        })
    {
        return Err("登录成员已变化，未确认原图上传".into());
    }
    if upload {
        check_cancel()?;
        asset_db(store)?
            .execute(
                "INSERT OR REPLACE INTO workbench_cloud_assets VALUES(?1,?2,?3,?4)",
                params![
                    runtime.transport.environment(),
                    workspace,
                    name,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
// 去重并校验原图列表，绑定当前成员与取消代次，再以最多四路并发补齐图片。
fn ensure_assets(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    payload: &Value,
    upload: bool,
) -> Result<Value, String> {
    let operation = asset_operation(payload)?;
    let epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
    let check_cancel = || check_asset_operation(runtime, &operation, epoch);
    check_cancel()?;
    let _assets = runtime.assets_gate.lock().map_err(|_| "原图任务状态异常")?;
    check_cancel()?;
    let owner = member(runtime)?;
    workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
    let urls = payload["urls"].as_array().ok_or("原图列表无效")?;
    if urls.len() > 20000 {
        return Err("原图列表超过允许上限".into());
    }
    let urls: Vec<String> = urls
        .iter()
        .map(|v| {
            let s = v.as_str().ok_or("原图路径无效")?;
            asset_name(s)?;
            Ok(s.to_string())
        })
        .collect::<Result<BTreeSet<_>, String>>()?
        .into_iter()
        .collect();
    bounded_assets(&urls, |url| {
        check_cancel()?;
        ensure_one(runtime, store, &owner, url, upload, &check_cancel)
    })?;
    check_cancel()?;
    Ok(json!({"ok":true,"images":urls.len(),"concurrency":4}))
}

fn asset_operation(payload: &Value) -> Result<String, String> {
    let value = payload["operationId"].as_str().ok_or("原图任务ID无效")?;
    Ok(uuid::Uuid::parse_str(value)
        .map_err(|_| "原图任务ID无效".to_string())?
        .to_string())
}

// 全局取消代次与单任务取消记录任一变化都停止后续工作，已验证缓存仍保留。
fn check_asset_operation(
    runtime: &CloudRuntime,
    operation: &str,
    epoch: u64,
) -> Result<(), String> {
    if runtime.asset_cancel_epoch.load(Ordering::SeqCst) != epoch
        || runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?
            .contains(operation)
    {
        return Err("原图任务已暂停，已验证并缓存的图片保留在本机".into());
    }
    Ok(())
}

// 四个线程共享任务游标；遇错停止领取新图片，并等待已经开始的任务收尾。
fn bounded_assets(
    urls: &[String],
    task: impl Fn(&str) -> Result<(), String> + Sync,
) -> Result<(), String> {
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let error = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..urls.len().min(4) {
            let task = &task;
            let next = &next;
            let stopped = &stopped;
            let error = &error;
            scope.spawn(move || {
                while !stopped.load(Ordering::SeqCst) {
                    let position = next.fetch_add(1, Ordering::SeqCst);
                    let Some(url) = urls.get(position) else {
                        break;
                    };
                    if let Err(message) = task(url) {
                        stopped.store(true, Ordering::SeqCst);
                        if let Ok(mut error) = error.lock() {
                            *error = Some(message);
                        }
                        break;
                    }
                }
            });
        }
    });
    match error.into_inner().map_err(|_| "原图任务状态异常")? {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// First connection is local only: use the verified migration seed when present,
/// otherwise bind only a factory-empty workspace for downloading existing records.
/// Never derive publish records from unbound business data or renderer paths/tokens.
// 有准备文件时保留迁移流程；无准备文件只允许全新空库从当前成员下载云端已有数据。
fn connect_seed(
    store: &WorkbenchStore,
    owner: &Value,
    check_session: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check_session()?;
    let status = workbench_store::cloud_checkpoint_status(store)?;
    if status["initialized"] == true {
        workbench_store::cloud_checkpoint_authorize(store, owner, None)?;
        return Ok(
            json!({"ok":true,"connected":true,"initialized":true,"imported":false,"checkpoint":status}),
        );
    }
    let path = store
        .path
        .parent()
        .ok_or("本机数据目录无效")?
        .join("cloud-bootstrap.json");
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let status = workbench_store::cloud_checkpoint_bind_empty(store, owner, check_session)?;
            return Ok(json!({"ok":true,"connected":true,"initialized":true,"imported":false,"checkpoint":status}));
        }
        Err(_) => return Err("无法读取本机同步准备信息，数据已保留。".into()),
    };
    let mut bytes = Vec::new();
    file.take(512 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取本机同步准备信息")?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("本机同步准备信息超过大小限制".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let plan: Value =
        serde_json::from_slice(&bytes).map_err(|_| "本机同步准备信息无效，数据已保留。")?;
    drop(bytes);
    workbench_store::cloud_checkpoint_preview_plan(store, &plan, owner).map_err(connect_error)?;
    check_session()?;
    // apply rechecks member, raw local-state hash and revision under IMMEDIATE
    // transaction, then backs up before changing state/queue atomically.
    workbench_store::cloud_checkpoint_apply_plan(store, &plan, owner, &hash)
        .map_err(connect_error)?;
    drop(plan);
    let status = workbench_store::cloud_checkpoint_status(store)?;
    Ok(json!({"ok":true,"connected":true,"initialized":true,"imported":true,"checkpoint":status}))
}

fn connect_error(message: String) -> String {
    if message.contains("成员不一致") {
        return "当前账号与本机数据所属成员不一致，请登录原成员账号。".into();
    }
    if message.contains("对应的数据已变化") {
        return "本机数据已更新，同步准备信息已过期；修改已保留，请更新工作台后重试。".into();
    }
    message.replace("接入计划", "同步准备信息")
}

// 登录独占身份门，普通操作共享身份门；退出只推进取消代次，不等待慢网络返回。
fn dispatch(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    action: &str,
    payload: Value,
) -> Result<ApiResponse, String> {
    if action == "assetsCancel" {
        let operation = asset_operation(&payload)?;
        let mut cancelled = runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?;
        if cancelled.len() >= 10000 && !cancelled.contains(&operation) {
            return Err("原图取消记录达到上限，请重新登录后继续".into());
        }
        cancelled.insert(operation.clone());
        return Ok(response(
            200,
            json!({"ok":true,"cancelled":true,"operationId":operation}),
        ));
    }
    let epoch = runtime.epoch.load(Ordering::SeqCst);
    if action == "logout" {
        // Never wait for an identity reader/network or an in-flight SQLite transaction.
        runtime.epoch.fetch_add(1, Ordering::SeqCst);
        runtime.asset_cancel_epoch.fetch_add(1, Ordering::SeqCst);
        runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?
            .clear();
        let value = runtime.transport.logout()?;
        if let Ok(mut plan) = runtime.plan.try_lock() {
            *plan = None;
        }
        return Ok(response(200, value));
    }
    if action == "login" {
        let _identity = runtime.identity_gate.write().map_err(|_| "登录状态异常")?;
        if runtime.epoch.load(Ordering::SeqCst) != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        let value = runtime.transport.login(
            payload["username"].as_str().ok_or("请输入账号")?,
            payload["password"].as_str().ok_or("请输入密码")?,
        )?;
        if runtime.epoch.load(Ordering::SeqCst) != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        runtime.epoch.fetch_add(1, Ordering::SeqCst);
        *runtime.plan.lock().map_err(|_| "接入计划状态异常")? = None;
        return Ok(response(200, value));
    }
    let _identity = runtime.identity_gate.read().map_err(|_| "登录状态异常")?;
    if runtime.epoch.load(Ordering::SeqCst) != epoch {
        return Err("云同步操作已取消".into());
    }
    let result = dispatch_bound(runtime, store, action, payload, epoch)?;
    if runtime.epoch.load(Ordering::SeqCst) != epoch {
        return Err("登录状态已变化，本机数据已保留".into());
    }
    Ok(result)
}

// 在固定登录代次下路由云业务和本机检查点，持久请求校验通过后才允许发送。
fn dispatch_bound(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    action: &str,
    payload: Value,
    epoch: u64,
) -> Result<ApiResponse, String> {
    let value = match action {
        "connect" => {
            if payload.as_object().is_none_or(|object| !object.is_empty()) {
                return Err("连接同步不接受路径或其他参数".into());
            }
            let _connect = runtime
                .connect_gate
                .lock()
                .map_err(|_| "同步连接状态异常")?;
            let owner = member(runtime)?;
            connect_seed(store, &owner, || {
                if runtime.epoch.load(Ordering::SeqCst) != epoch {
                    return Err("同步连接已取消，本机数据已保留".into());
                }
                let current = member(runtime)?;
                if current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"]
                {
                    return Err("登录成员已变化，请重新连接同步".into());
                }
                Ok(())
            })?
        }
        "resume" => runtime.transport.resume()?,
        "status" => {
            json!({"session":runtime.transport.status()?,"checkpoint":workbench_store::cloud_checkpoint_status(store)?})
        }
        "load" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
            // 先转换旧上传引用，再给同步引擎建立基线；不改写已生成的云 mutation。
            workbench_store::normalize_upload_references(store)?;
            return workbench_store::cloud_checkpoint_load(store);
        }
        "commit" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
            return workbench_store::cloud_checkpoint_commit(store, &payload);
        }
        "call" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, Some(&payload))?;
            runtime.transport.call(payload)?
        }
        "assetsEnsure" => ensure_assets(runtime, store, &payload, true)?,
        "assetsDownload" => ensure_assets(runtime, store, &payload, false)?,
        "planPreview" => {
            let owner = member(runtime)?;
            // Invoked only by the user's explicit button, never by background work.
            let Some(path) = rfd::FileDialog::new()
                .set_title("选择已核验的云同步接入计划")
                .add_filter("JSON 接入计划", &["json"])
                .pick_file()
            else {
                return Ok(response(200, json!({"cancelled":true})));
            };
            if fs::metadata(&path).map_err(|_| "无法读取接入计划")?.len() > 512 * 1024 * 1024
            {
                return Err("接入计划过大".into());
            }
            let mut bytes = Vec::new();
            fs::File::open(path)
                .map_err(|_| "无法读取接入计划")?
                .take(512 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "无法读取接入计划")?;
            if bytes.len() > 512 * 1024 * 1024 {
                return Err("接入计划过大".into());
            }
            let plan: Value = serde_json::from_slice(&bytes).map_err(|_| "接入计划JSON格式无效")?;
            let summary = workbench_store::cloud_checkpoint_preview_plan(store, &plan, &owner)?;
            let token = format!("{:x}", Sha256::digest(&bytes));
            *runtime.plan.lock().map_err(|_| "接入计划状态异常")? = Some(CachedPlan {
                token: token.clone(),
                bytes,
                document: plan,
                epoch,
            });
            json!({"token":token,"summary":summary})
        }
        "planApply" => {
            let owner = member(runtime)?;
            let mut guard = runtime.plan.lock().map_err(|_| "接入计划状态异常")?;
            let plan = guard.as_ref().ok_or("请先选择并预览接入计划")?;
            if payload["token"].as_str() != Some(plan.token.as_str())
                || plan.epoch != epoch
                || plan.token != format!("{:x}", Sha256::digest(&plan.bytes))
            {
                return Err("接入计划已变化，请重新预览".into());
            }
            let result = workbench_store::cloud_checkpoint_apply_plan(
                store,
                &plan.document,
                &owner,
                &plan.token,
            )?;
            *guard = None;
            return Ok(result);
        }
        _ => return Err("未知云同步操作".into()),
    };
    Ok(response(200, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    // 未配置时 status 与 resume 都保持本地模式，接入动作在身份核验前被拒绝。
    #[test]
    fn absent_config_status_resume_and_connect_are_local_only() {
        let (store, _, _) = connect_fixture();
        let runtime = CloudRuntime::new(store.path.parent().unwrap()).unwrap();
        for action in ["status", "resume"] {
            let result = dispatch(&runtime, &store, action, json!({})).unwrap();
            let document: Value = serde_json::from_str(&result.body).unwrap();
            let session = if action == "status" {
                &document["session"]
            } else {
                &document
            };
            assert_eq!(session["configured"], false);
            assert_eq!(session["authenticated"], false);
        }
        assert_eq!(
            dispatch(&runtime, &store, "connect", json!({})).unwrap_err(),
            CLOUD_NOT_CONFIGURED
        );
    }

    fn connect_fixture() -> (WorkbenchStore, Value, Value) {
        let empty = store();
        let root = empty.path.parent().unwrap();
        let initial = root.join("initial.json");
        fs::write(&initial,json!({"revision":7,"configs":[{"id":"a","name":"old","parts":[]}],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{},"logs":[]}).to_string()).unwrap();
        let store = workbench_store::initialize(&empty.path, &initial, &empty.assets).unwrap();
        let c = Connection::open(&store.path).unwrap();
        let raw: String = c
            .query_row(
                "SELECT document FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut after: Value = serde_json::from_str(&raw).unwrap();
        after["configs"][0]["name"] = json!("old-pending-kept");
        let mut records = vec![
            json!({"type":"configuration","id":"a","version":2,"base":{"id":"a","name":"old"},"draft":{"id":"a","name":"old-pending-kept"},"conflict":null}),
        ];
        for n in 0..30 {
            let row = json!({"id":format!("old-deleted-{n}"),"name":"old deleted fixture","parts":[],"deletedAt":"2026-10-12T00:00:00Z"});
            after["configs"].as_array_mut().unwrap().push(row.clone());
            records.push(json!({"type":"configuration","id":row["id"],"version":2,"base":row,"draft":row,"conflict":null}));
        }
        let owner =
            json!({"uid":"fixture-member","workspaceId":"fixture-workspace","name":"测试成员"});
        let outbox = json!([{"protocolVersion":2,"action":"sync.push","requestId":"original-request","payload":{"mutationId":"original-mutation","deviceId":"original-device","entityType":"configuration","entityId":"a","baseVersion":2,"after":{"id":"a","name":"old-pending-kept"}}}]);
        let plan = json!({"format":1,"ready":true,"origin":"cutover-preflight","nativeTargetStateSha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"nativeBaseRevision":7,
            "member":{"uid":owner["uid"],"workspaceId":owner["workspaceId"],"deviceId":"new-device"},"state":after,"cursor":5,"records":records,"outbox":outbox,"materializedProjection":[],
            "oldSourceSnapshotSha256":"frozen-fixture-only","resolutionPolicy":{"kind":"keep-old-deleted-record","authorizedByUser":true}});
        (store, owner, plan)
    }
    fn write_connect_seed(store: &WorkbenchStore, plan: &Value) -> Vec<u8> {
        let bytes = serde_json::to_vec_pretty(plan).unwrap();
        fs::write(
            store.path.parent().unwrap().join("cloud-bootstrap.json"),
            &bytes,
        )
        .unwrap();
        bytes
    }

    // 与 lib.rs 出厂初始化一致，不能用“删掉所有配置”冒充全新工作区。
    fn factory_fixture() -> WorkbenchStore {
        let empty = store();
        let initial = empty.path.parent().unwrap().join("initial.json");
        fs::write(&initial, r#"{"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{},"logs":[]}"#).unwrap();
        workbench_store::initialize(&empty.path, &initial, &empty.assets).unwrap()
    }

    #[test]
    fn factory_connect_without_seed_binds_empty_checkpoint_idempotently_and_isolates_owner() {
        let store = factory_fixture();
        let owner = json!({"uid":"fresh-member","workspaceId":"team"});
        assert_eq!(connect_seed(&store, &owner, || Ok(())).unwrap()["connected"], true);
        let first: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body).unwrap();
        let document = &first["document"];
        assert_eq!(document["cursor"], 0);
        assert_eq!(document["records"], json!([]));
        assert_eq!(document["outbox"], json!([]));
        assert_eq!(document["materializedProjection"], json!([]));
        assert!(uuid::Uuid::parse_str(document["deviceId"].as_str().unwrap()).is_ok());
        connect_seed(&store, &owner, || Ok(())).unwrap();
        let second: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body).unwrap();
        assert_eq!(first, second);
        assert!(connect_seed(&store, &json!({"uid":"other","workspaceId":"team"}), || Ok(())).is_err());
        assert!(connect_seed(&store, &json!({"uid":"fresh-member","workspaceId":"other"}), || Ok(())).is_err());
        let other = factory_fixture();
        connect_seed(&other, &owner, || Ok(())).unwrap();
        let third: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&other).unwrap().body).unwrap();
        assert_ne!(third["document"]["deviceId"], document["deviceId"]);
    }

    #[test]
    fn factory_connect_rejects_each_business_collection_unknown_fields_and_archived_data() {
        let owner = json!({"uid":"u","workspaceId":"w"});
        for key in ["configs","templates","sourceCatalog","costSource","caseGallery","shopSettings","unknownBusiness"] {
            let store = factory_fixture();
            let c = Connection::open(&store.path).unwrap();
            let raw: String = c.query_row("SELECT document FROM workbench_state", [], |r| r.get(0)).unwrap();
            let mut doc: Value = serde_json::from_str(&raw).unwrap();
            doc[key] = json!([{"id":"preserved-config","preserve":true}]);
            workbench_store::replace_fixture(&c, &doc);
            assert!(connect_seed(&store, &owner, || Ok(())).is_err(), "{key}");
            assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        }
        for sql in ["UPDATE workbench_log_archive SET document='[{\"old\":true}]'", "CREATE TABLE future_business(value TEXT); INSERT INTO future_business VALUES('kept')", "INSERT INTO workbench_recovery VALUES('draft','now','{}')", "INSERT INTO workbench_history(at,revision,document) VALUES('old',1,'{}')"] {
            let store = factory_fixture();
            Connection::open(&store.path).unwrap().execute_batch(sql).unwrap();
            assert!(connect_seed(&store, &owner, || Ok(())).is_err());
            assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        }
    }

    #[test]
    fn factory_connect_rechecks_state_session_and_rolls_back_failed_binding() {
        use std::cell::Cell;
        let owner = json!({"uid":"u","workspaceId":"w"});
        let store = factory_fixture();
        let calls = Cell::new(0);
        assert!(connect_seed(&store, &owner, || {
            calls.set(calls.get() + 1);
            // connect首次检查、存储事务前、插入前、提交前：最后一次模拟退出。
            if calls.get() == 4 { Err("session cancelled".into()) } else { Ok(()) }
        }).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        let c = Connection::open(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_empty_binding BEFORE INSERT ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(connect_seed(&store, &owner, || Ok(())).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        c.execute_batch("DROP TRIGGER reject_empty_binding").unwrap();
        let calls = Cell::new(0);
        assert!(connect_seed(&store, &owner, || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 { c.execute("UPDATE workbench_metadata SET document=json_set(document,'$.unknownBusiness','concurrent')", []).unwrap(); }
            Ok(())
        }).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
    }
    #[test]
    fn automatic_connect_uses_fixed_seed_preserves_deletions_outbox_and_is_idempotent() {
        let (store, owner, plan) = connect_fixture();
        let raw = write_connect_seed(&store, &plan);
        let result = connect_seed(&store, &owner, || Ok(())).unwrap();
        assert_eq!(result["connected"], true);
        assert_eq!(result["imported"], true);
        assert!(result.to_string().len() < 2000);
        let snapshot: Value =
            serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body)
                .unwrap();
        assert_eq!(snapshot["state"]["revision"], 8);
        assert_eq!(snapshot["document"]["outbox"], plan["outbox"]);
        assert_eq!(snapshot["document"]["records"], plan["records"]);
        assert_eq!(
            snapshot["state"]["configs"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| !row["deletedAt"].is_null())
                .count(),
            30
        );
        let backup_path = fs::read_dir(store.path.parent().unwrap().join("cloud-cutover-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let backup: Value = serde_json::from_slice(&fs::read(&backup_path).unwrap()).unwrap();
        assert_eq!(backup["planHash"], format!("{:x}", Sha256::digest(&raw)));
        assert_eq!(backup["state"]["revision"], 7);
        assert_eq!(
            fs::read(store.path.parent().unwrap().join("cloud-bootstrap.json")).unwrap(),
            raw
        );
        // Once bound, reconnect never reconsumes the seed or overwrites local state.
        fs::write(
            store.path.parent().unwrap().join("cloud-bootstrap.json"),
            b"invalid-after-initial-connect",
        )
        .unwrap();
        let again = connect_seed(&store, &owner, || Ok(())).unwrap();
        assert_eq!(again["imported"], false);
        assert_eq!(again["checkpoint"]["cloudVersion"], 1);
        assert_eq!(again["checkpoint"]["workspaceRevision"], 8);
        assert!(
            connect_seed(
                &store,
                &json!({"uid":"other","workspaceId":owner["workspaceId"]}),
                || Ok(())
            )
            .is_err()
        );
    }
    #[test]
    fn automatic_connect_rejects_missing_stale_or_wrong_member_seed_without_changes() {
        let (store, owner, plan) = connect_fixture();
        let missing = connect_seed(&store, &owner, || Ok(())).unwrap_err();
        assert!(missing.contains("准备信息缺失"));
        write_connect_seed(&store, &plan);
        let wrong = connect_seed(
            &store,
            &json!({"uid":"other","workspaceId":owner["workspaceId"]}),
            || Ok(()),
        )
        .unwrap_err();
        assert!(wrong.contains("原成员账号"));
        let mut stale = plan.clone();
        stale["nativeBaseRevision"] = json!(6);
        write_connect_seed(&store, &stale);
        let error = connect_seed(&store, &owner, || Ok(())).unwrap_err();
        assert!(error.contains("过期"));
        assert!(!error.contains("接入计划"));
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        let c = Connection::open(&store.path).unwrap();
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT json_extract(document,'$.revision') FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            7
        );
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
        let runtime = CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap();
        assert!(
            dispatch(
                &runtime,
                &store,
                "connect",
                json!({"path":"arbitrary.json"})
            )
            .unwrap_err()
            .contains("不接受路径")
        );
    }
    #[test]
    fn automatic_connect_checks_session_after_preflight_and_rolls_back_failed_apply() {
        let (store, owner, plan) = connect_fixture();
        write_connect_seed(&store, &plan);
        let checks = AtomicUsize::new(0);
        assert!(
            connect_seed(&store, &owner, || {
                if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err("fixture logout".into())
                }
            })
            .is_err()
        );
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
        let c = Connection::open(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_auto_connect BEFORE INSERT ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(connect_seed(&store, &owner, || Ok(())).is_err());
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT json_extract(document,'$.revision') FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            7
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_activity", [], |row| row
                .get(0))
                .unwrap(),
            0
        );
        c.execute_batch("DROP TRIGGER reject_auto_connect").unwrap();
        assert_eq!(
            connect_seed(&store, &owner, || Ok(())).unwrap()["connected"],
            true
        );
    }
    #[test]
    fn cancel_before_asset_dispatch_remains_recorded_without_waiting_for_gates() {
        let runtime = CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap();
        let store = store();
        let operation = uuid::Uuid::new_v4().to_string();
        let _identity = runtime.identity_gate.read().unwrap();
        let _assets = runtime.assets_gate.lock().unwrap();
        let result = dispatch(
            &runtime,
            &store,
            "assetsCancel",
            json!({"operationId":operation}),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.body).unwrap()["cancelled"],
            true
        );
        // The late job is rejected before trying either gate or requiring login.
        let error = ensure_assets(
            &runtime,
            &store,
            &json!({"operationId":operation,"urls":[]}),
            false,
        )
        .unwrap_err();
        assert!(error.contains("暂停"));
        assert!(asset_operation(&json!({"operationId":"invalid"})).is_err());
    }
    #[test]
    fn cancel_leaves_current_four_assets_and_does_not_start_the_next_image() {
        let runtime =
            Arc::new(CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap());
        let store = store();
        let operation = uuid::Uuid::new_v4().to_string();
        let epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
        let started = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let (sender, receiver) = mpsc::channel();
        let other = runtime.clone();
        let other_operation = operation.clone();
        let other_started = started.clone();
        let other_completed = completed.clone();
        let other_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            let urls: Vec<String> = (0..20).map(|n| n.to_string()).collect();
            bounded_assets(&urls, |_| {
                check_asset_operation(&other, &other_operation, epoch)?;
                other_started.fetch_add(1, Ordering::SeqCst);
                sender.send(()).unwrap();
                other_barrier.wait();
                other_completed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });
        for _ in 0..4 {
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        dispatch(
            &runtime,
            &store,
            "assetsCancel",
            json!({"operationId":operation}),
        )
        .unwrap();
        barrier.wait();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(completed.load(Ordering::SeqCst), 4);
        let previous_epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
        dispatch(&runtime, &store, "logout", json!({})).unwrap();
        assert!(runtime.cancelled_assets.lock().unwrap().is_empty());
        assert!(check_asset_operation(&runtime, &operation, previous_epoch).is_err());
    }
    #[test]
    fn serialized_payload_parse_errors_never_echo_credentials() {
        assert!(parse_payload("{}").unwrap().is_object());
        for input in ["[1]", "null", "{\"password\":\"test-secret\", invalid"] {
            let error = parse_payload(input).unwrap_err();
            assert!(!error.contains("test-secret"));
            assert!(!error.contains(input));
        }
    }
    fn store() -> WorkbenchStore {
        // 使用短暂存根，避免源码在深层验收副本时使 Win32 测试文件名超过 MAX_PATH。
        let root = std::env::temp_dir()
            .join("diy-cloud-native-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        WorkbenchStore {
            path: root.join("workbench.sqlite"),
            assets: root.join("assets"),
        }
    }
    #[test]
    fn content_cache_is_verified_atomic_and_preserves_wrong_existing_bytes() {
        let store = store();
        let bytes = b"test-native-image";
        let name = format!("{:x}.png", Sha256::digest(bytes));
        assert!(asset_name(&format!("/uploads/{name}")).is_ok());
        assert!(asset_name("/uploads/../secret.png").is_err());
        cache_bytes(&store, &name, bytes).unwrap();
        let path = store.assets.join("uploads").join(&name);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        cache_bytes(&store, &name, bytes).unwrap();
        fs::write(&path, b"wrong-existing-owned-fixture").unwrap();
        assert!(cache_bytes(&store, &name, bytes).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"wrong-existing-owned-fixture");
        assert!(cache_bytes(&store, &name, b"bad-hash").is_err());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn four_asset_lanes_finish_each_independent_image_and_stop_on_failure() {
        let urls: Vec<String> = (0..24).map(|n| n.to_string()).collect();
        let active = AtomicUsize::new(0);
        let high = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        bounded_assets(&urls, |_| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            high.fetch_max(count, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(3));
            active.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert_eq!(done.load(Ordering::SeqCst), 24);
        assert_eq!(high.load(Ordering::SeqCst), 4);
        let calls = AtomicUsize::new(0);
        assert!(
            bounded_assets(&urls, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("fixture failure".into())
            })
            .is_err()
        );
        assert!(calls.load(Ordering::SeqCst) <= 4);
    }
    #[test]
    fn logout_invalidates_epoch_without_waiting_for_identity_reader() {
        let runtime =
            Arc::new(CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap());
        let store = store();
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let other = runtime.clone();
        let worker = std::thread::spawn(move || {
            let _guard = other.identity_gate.read().unwrap();
            started.send(()).unwrap();
            wait.recv().unwrap();
        });
        ready.recv().unwrap();
        let result = dispatch(&runtime, &store, "logout", json!({})).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.body).unwrap()["authenticated"],
            false
        );
        assert_eq!(runtime.epoch.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        worker.join().unwrap();
    }
}

#[tauri::command]
// 把云端阻塞操作移出界面线程，并沿用统一的状态码与 JSON 回执。
pub async fn cloud_native_request(
    action: String,
    payload: Value,
    store: tauri::State<'_, WorkbenchStore>,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let store = store.inner().clone();
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        match dispatch(&runtime, &store, &action, payload) {
            Ok(result) => result,
            Err(message) => response(400, json!({"error":message})),
        }
    })
    .await
    .map_err(|_| "云同步任务异常，本机数据已保留".into())
}

/// Large controller documents stay serialized until the blocking thread, keeping
/// the renderer's main thread free of whole-checkpoint parse/stringify work.
#[tauri::command]
// 接收序列化请求体后走相同原生边界，避免绕过成员和队列校验。
pub async fn cloud_native_json_request(
    action: String,
    payload_json: String,
    store: tauri::State<'_, WorkbenchStore>,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let store = store.inner().clone();
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let result = parse_payload(&payload_json)
            .and_then(|payload| dispatch(&runtime, &store, &action, payload));
        match result {
            Ok(result) => result,
            Err(message) => response(400, json!({"error":message})),
        }
    })
    .await
    .map_err(|_| "云同步任务异常，本机数据已保留".into())
}

fn parse_payload(raw: &str) -> Result<Value, String> {
    if raw.len() > 512 * 1024 * 1024 {
        return Err("云同步请求过大".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "云同步请求JSON格式无效")?;
    if !value.is_object() {
        return Err("云同步请求须为对象".into());
    }
    Ok(value)
}
