//! 有界 stdio MCP 适配层；只转发固定 Agent 方法，不访问数据库或执行外部程序。
use clap::Args;
use diytools_agent_core::{
    transport, validate_instance, AgentError, Request, Response, MAX_FRAME_BYTES,
};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    process::ExitCode,
};

const VERSION: &str = "2025-11-25";
const INSTRUCTIONS: &str = "先调用 workbench_status 核对实例与 capabilities。只读取已保存快照；翻页沿用 revision。写操作必须得到用户授权，每项操作使用固定 operationId，未知结果先查 workbench_jobs_status，不换 ID 重做。queued/running 不代表完成，须查询到终态并检查 result/error；本机保存、导出、云同步分别确认。";

#[derive(Debug, Args, Default)]
pub struct Options {
    /// 每次调用重新读取此绝对路径中的 instance；不执行连接文件中的 cli
    #[arg(long, conflicts_with = "instance")]
    connection: Option<PathBuf>,
    /// 开放预览和本机保存工具；桌面自动同步仍遵循用户原有设置
    #[arg(long)]
    allow_writes: bool,
    /// 开放文件导出工具
    #[arg(long)]
    allow_export: bool,
    /// 开放显式云同步工具
    #[arg(long)]
    allow_sync: bool,
}

fn invalid(message: &str) -> AgentError {
    AgentError::new("INVALID_ARGUMENT", message)
}

impl Options {
    fn instance(&self, explicit: Option<&str>) -> Result<String, AgentError> {
        let value = match &self.connection {
            Some(path) => {
                if !path.is_absolute() {
                    return Err(invalid("connection 必须为绝对路径"));
                }
                let connection = super::input_object(path)?;
                connection["instance"]
                    .as_str()
                    .ok_or_else(|| invalid("连接文件缺少 instance"))?
                    .to_owned()
            }
            None => explicit
                .ok_or_else(|| invalid("必须提供 --instance 或 --connection"))?
                .to_owned(),
        };
        validate_instance(&value)?;
        Ok(value)
    }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object", "properties":properties, "required":required, "additionalProperties":false})
}

// Schema 仅描述接口参数；目标、计划有效性和业务权限仍由原桌面服务验证。
fn catalog(options: &Options) -> Vec<Value> {
    let string = json!({"type":"string","minLength":1});
    let uuid = json!({"type":"string","format":"uuid"});
    let integer = json!({"type":"integer","minimum":0});
    let mut entries = vec![
        (
            "workbench_status",
            "status",
            "检查实例、已保存版本和实际 capabilities。",
            schema(json!({}), &[]),
            true,
        ),
        (
            "workbench_shops_list",
            "shops.list",
            "列出已保存的店铺 ID。",
            schema(json!({}), &[]),
            true,
        ),
        (
            "workbench_configs_find",
            "configs.find",
            "分页查询配置；SKU/SPU 是字符串，offset > 0 必须携带同一 revision。",
            schema(
                json!({"shopId":string,"goodsId":string,"sku":string,"spu":string,"limit":{"type":"integer","minimum":1,"maximum":100,"default":20},"offset":integer,"revision":integer}),
                &[],
            ),
            true,
        ),
        (
            "workbench_configs_get",
            "configs.get",
            "按精确配置 ID 回读已保存配置。",
            schema(json!({"configId":string}), &["configId"]),
            true,
        ),
        (
            "workbench_jobs_status",
            "jobs.status",
            "按 jobId 或 operationId 查询任务，必须且只能提供一个；queued/running 不是成功。",
            schema(json!({"jobId":string,"operationId":uuid}), &[]),
            true,
        ),
    ];
    if options.allow_writes {
        entries.extend([
            ("workbench_changes_preview", "changes.preview", "预览变更并排队；request 使用原 changes.preview 业务结构（shopId、targets、action），查询终态取得 planId。", schema(json!({"request":{"type":"object","properties":{"shopId":string,"targets":{"type":"array","minItems":1,"items":{"type":"object"}},"action":{"type":"object"}},"required":["shopId","targets","action"]},"operationId":uuid}), &["request","operationId"]), false),
            ("workbench_changes_apply", "changes.apply", "应用成功预览的 planId；保存后查询任务终态并回读配置。保留原 operationId 重试。", schema(json!({"planId":string,"operationId":uuid}), &["planId","operationId"]), false),
        ]);
    }
    if options.allow_export {
        entries.push(("workbench_export_start", "export.start", "导出固定快照（configIds + revision 或 sourceOperationId）；outputDir 须为已有绝对目录，最终回执返回文件及 SHA256。", schema(json!({"configIds":{"type":"array","minItems":1,"items":string},"revision":integer,"sourceOperationId":uuid,"images":{"type":"string","enum":["both","long","square"]},"report":{"type":"boolean"},"outputDir":string,"operationId":uuid}), &["outputDir","operationId","images","report"]), false));
    }
    if options.allow_sync {
        entries.push((
            "workbench_sync_run",
            "sync.run",
            "按当前成员会话发起云同步；仅在授权范围内调用，查询任务终态。",
            schema(json!({"operationId":uuid}), &["operationId"]),
            false,
        ));
    }
    entries.into_iter().map(|(name, method, description, input, read)| json!({
        "name":name,"description":description,"inputSchema":input,
        "annotations":{"readOnlyHint":read,"destructiveHint":!read,"idempotentHint":true,"openWorldHint":method=="sync.run"},
        // 内部映射在 tools/list 时移除，不允许客户端自选协议方法。
        "agentMethod":method
    })).collect()
}

fn validate(schema: &Value, value: &Value) -> Result<(), AgentError> {
    let valid = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("integer") => value.as_u64().is_some(),
        Some("boolean") => value.is_boolean(),
        _ => true,
    };
    if !valid {
        return Err(invalid("工具参数类型不符"));
    }
    if let Some(required) = schema["required"].as_array() {
        for key in required {
            if value.get(key.as_str().unwrap()).is_none() {
                return Err(invalid("缺少必需工具参数"));
            }
        }
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            match schema["properties"].get(key) {
                Some(child_schema) => validate(child_schema, child)?,
                None if schema["additionalProperties"] == false => {
                    return Err(invalid("包含未声明的工具参数"))
                }
                _ => (),
            }
        }
    }
    if let Some(items) = value.as_array() {
        if schema["minItems"]
            .as_u64()
            .is_some_and(|min| items.len() < min as usize)
        {
            return Err(invalid("数组不能为空"));
        }
        for item in items {
            validate(&schema["items"], item)?;
        }
    }
    if let Some(text) = value.as_str() {
        if schema["minLength"] == 1 && text.is_empty() {
            return Err(invalid("标识不能为空"));
        }
        if schema["format"] == "uuid" {
            super::operation_id(text).map_err(|e| invalid(&e))?;
        }
    }
    if let Some(number) = value.as_u64() {
        if schema["minimum"].as_u64().is_some_and(|min| number < min)
            || schema["maximum"].as_u64().is_some_and(|max| number > max)
        {
            return Err(invalid("数值超出工具参数范围"));
        }
    }
    if schema["enum"]
        .as_array()
        .is_some_and(|items| !items.contains(value))
    {
        return Err(invalid("参数值不在允许列表"));
    }
    Ok(())
}

fn tool_request(entry: &Value, mut args: Value) -> Result<Request, AgentError> {
    validate(&entry["inputSchema"], &args)?;
    let method = entry["agentMethod"].as_str().unwrap();
    if method == "configs.find" {
        if args["offset"].as_u64().unwrap_or(0) > 0 && args.get("revision").is_none() {
            return Err(invalid("翻页必须提供 revision"));
        }
        let object = args.as_object_mut().unwrap();
        object.entry("limit").or_insert(json!(20));
        object.entry("offset").or_insert(json!(0));
    }
    if method == "jobs.status" && args.get("jobId").is_some() == args.get("operationId").is_some() {
        return Err(invalid("jobId 和 operationId 必须且只能提供一个"));
    }
    // 和 CLI 一样规范化 UUID；不同传输请求始终保留同一业务操作 ID。
    for key in ["operationId", "sourceOperationId"] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            args[key] = json!(super::operation_id(value).map_err(|e| invalid(&e))?);
        }
    }
    Ok(super::request(method, args))
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

struct Session {
    initialized: bool,
    ready: bool,
}
impl Session {
    fn handle(
        &mut self,
        message: Value,
        options: &Options,
        call: &mut impl FnMut(Request) -> Response,
    ) -> Option<Value> {
        let id = message.get("id").cloned();
        if !message.is_object()
            || message["jsonrpc"] != "2.0"
            || !message["method"].is_string()
            || id
                .as_ref()
                .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        {
            return Some(rpc_error(Value::Null, -32600, "无效 JSON-RPC 请求"));
        }
        let method = message["method"].as_str().unwrap();
        // 通知不回包；取消仅代表客户端停止等待，不取消已经排队的业务任务。
        let Some(id) = id else {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return Some(rpc_error(id, -32602, "params 必须为对象"));
        }
        let result = match method {
            "initialize" if !self.initialized => {
                if !params["protocolVersion"].is_string()
                    || !params["capabilities"].is_object()
                    || !params["clientInfo"]["name"].is_string()
                    || !params["clientInfo"]["version"].is_string()
                {
                    return Some(rpc_error(id, -32602, "initialize 参数不完整"));
                }
                self.initialized = true;
                let requested = params["protocolVersion"].as_str().unwrap();
                let version = if ["2025-06-18", VERSION].contains(&requested) {
                    requested
                } else {
                    VERSION
                };
                json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"diytools-workbench","version":env!("CARGO_PKG_VERSION")},"instructions":INSTRUCTIONS})
            }
            "ping" => json!({}),
            _ if !self.ready => {
                return Some(rpc_error(
                    id,
                    -32000,
                    "请先完成 initialize 和 notifications/initialized",
                ))
            }
            "tools/list" => {
                if params.get("cursor").is_some() {
                    return Some(rpc_error(id, -32602, "工具列表无后续分页"));
                }
                let mut tools = catalog(options);
                for tool in &mut tools {
                    tool.as_object_mut().unwrap().remove("agentMethod");
                }
                json!({"tools":tools})
            }
            "tools/call" => {
                let entries = catalog(options);
                let Some(entry) = entries.iter().find(|entry| entry["name"] == params["name"])
                else {
                    return Some(rpc_error(id, -32602, "未知或未开放的工具"));
                };
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let response = match tool_request(entry, args) {
                    Ok(request) => call(request),
                    // 工具输入校验失败也是工具结果，客户端可读取错误后修正参数。
                    Err(error) => Response::failure(
                        &super::request(entry["agentMethod"].as_str().unwrap(), json!({})),
                        error,
                    ),
                };
                // 原 envelope 保留 requestId、错误码和 queued 状态，文本兼容旧 MCP 客户端。
                json!({"content":[{"type":"text","text":serde_json::to_string(&response).unwrap()}],"isError":!response.ok})
            }
            _ => return Some(rpc_error(id, -32601, "不支持的 MCP 方法")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
}

fn serve(
    input: impl BufRead,
    mut output: impl Write,
    options: &Options,
    mut call: impl FnMut(Request) -> Response,
) -> io::Result<()> {
    let mut input = input;
    let mut session = Session {
        initialized: false,
        ready: false,
    };
    loop {
        let mut line = Vec::new();
        // 有界读取避免无换行输入无限占用内存。超限后关闭会话，不尝试重放。
        let size = std::io::Read::take(&mut input, (MAX_FRAME_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)?;
        if size == 0 {
            return Ok(());
        }
        let oversized = size > MAX_FRAME_BYTES + 1;
        let response = if oversized {
            Some(rpc_error(Value::Null, -32600, "MCP 消息超过 1 MiB"))
        } else {
            match serde_json::from_slice(&line) {
                Ok(message) => session.handle(message, options, &mut call),
                Err(_) => Some(rpc_error(Value::Null, -32700, "无效 JSON")),
            }
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
        if oversized {
            return Ok(());
        }
    }
}

pub fn run(options: &Options, explicit: Option<&str>) -> ExitCode {
    if (options.connection.is_none() && explicit.is_none())
        || options
            .connection
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
    {
        eprintln!("MCP 需要 --instance 或绝对路径 --connection");
        return ExitCode::from(2);
    }
    let result = serve(
        io::stdin().lock(),
        io::stdout().lock(),
        options,
        |request| {
            let response = options
                .instance(explicit)
                .and_then(|instance| transport::call(&instance, &request));
            response.unwrap_or_else(|error| Response::failure(&request, error))
        },
    );
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("MCP 输入输出失败：{error}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialize() -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":VERSION,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}})
    }
    fn invoke(name: &str, args: Value) -> Value {
        json!({"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":name,"arguments":args}})
    }
    fn execute(messages: Vec<Value>, options: &Options) -> (Vec<Value>, Vec<Request>) {
        let input = messages
            .iter()
            .map(|m| format!("{m}\n"))
            .collect::<String>();
        let mut output = Vec::new();
        let mut calls = Vec::new();
        serve(io::Cursor::new(input), &mut output, options, |request| {
            let response = Response::success(
                &request,
                json!({"status":"queued","operationId":request.params["operationId"]}),
            );
            calls.push(request);
            response
        })
        .unwrap();
        (
            String::from_utf8(output)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect(),
            calls,
        )
    }
    fn ready() -> Vec<Value> {
        vec![
            initialize(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        ]
    }

    #[test]
    fn lifecycle_notifications_and_version_negotiation() {
        let mut messages = vec![invoke("workbench_status", json!({}))];
        let mut init = initialize();
        init["params"]["protocolVersion"] = json!("future");
        messages.push(init);
        messages.push(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        messages.push(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":99}}),
        );
        messages.push(json!({"jsonrpc":"2.0","id":7,"method":"ping"}));
        let (responses, calls) = execute(messages, &Options::default());
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[0]["error"]["code"], -32000);
        assert_eq!(responses[1]["result"]["protocolVersion"], VERSION);
        assert_eq!(responses[2]["result"], json!({}));
        assert!(calls.is_empty());
    }

    #[test]
    fn default_catalog_has_no_write_escape_and_unknown_methods_fail() {
        let mut messages = ready();
        messages.extend([
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            invoke("workbench_changes_apply", json!({})),
            invoke("request", json!({"method":"sync.run"})),
            json!({"jsonrpc":"2.0","id":2,"method":"resources/list"}),
        ]);
        let (responses, calls) = execute(messages, &Options::default());
        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        assert!(tools.iter().all(|t| t.get("agentMethod").is_none()));
        assert_eq!(responses[2]["error"]["code"], -32602);
        assert_eq!(responses[3]["error"]["code"], -32602);
        assert_eq!(responses[4]["error"]["code"], -32601);
        assert!(calls.is_empty());
    }

    #[test]
    fn rejects_bad_parameters_before_transport() {
        let mut messages = ready();
        for (tool, args) in [
            ("workbench_status", json!({"sql":"select 1"})),
            ("workbench_configs_get", json!({"configId":1})),
            ("workbench_configs_find", json!({"sku":123456789})),
            ("workbench_configs_find", json!({"limit":101})),
            ("workbench_configs_find", json!({"offset":20})),
            ("workbench_configs_find", json!({"revision":-1})),
            ("workbench_jobs_status", json!({})),
            (
                "workbench_jobs_status",
                json!({"jobId":"a","operationId":"bad"}),
            ),
            (
                "workbench_changes_apply",
                json!({"planId":"a","operationId":"bad"}),
            ),
            (
                "workbench_changes_preview",
                json!({"operationId":"a1234567-1234-4234-8234-123456789abc","request":{}}),
            ),
        ] {
            messages.push(invoke(tool, args));
        }
        let (responses, calls) = execute(
            messages,
            &Options {
                allow_writes: true,
                ..Default::default()
            },
        );
        assert!(responses
            .iter()
            .skip(1)
            .all(|r| r["result"]["isError"] == true));
        assert!(calls.is_empty());
    }

    #[test]
    fn maps_all_tools_and_preserves_operation_identity_and_identifiers() {
        let options = Options {
            allow_writes: true,
            allow_export: true,
            allow_sync: true,
            ..Default::default()
        };
        let id = "A1234567-1234-4234-8234-123456789ABC";
        let mut messages = ready();
        for (tool, args) in [
            ("workbench_status", json!({})),
            ("workbench_shops_list", json!({})),
            (
                "workbench_configs_find",
                json!({"sku":"00012345678901234567890","offset":20,"revision":42}),
            ),
            ("workbench_configs_get", json!({"configId":"id"})),
            ("workbench_jobs_status", json!({"operationId":id})),
            (
                "workbench_changes_preview",
                json!({"request":{"shopId":"sample","targets":[{"configId":"sample"}],"action":{"type":"quantity","quantity":2}},"operationId":id}),
            ),
            (
                "workbench_changes_apply",
                json!({"planId":"plan","operationId":id}),
            ),
            (
                "workbench_export_start",
                json!({"sourceOperationId":id,"outputDir":"D:\\sample","operationId":id,"images":"both","report":true}),
            ),
            ("workbench_sync_run", json!({"operationId":id})),
        ] {
            messages.push(invoke(tool, args));
        }
        let (responses, calls) = execute(messages, &options);
        assert_eq!(
            calls.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(),
            [
                "status",
                "shops.list",
                "configs.find",
                "configs.get",
                "jobs.status",
                "changes.preview",
                "changes.apply",
                "export.start",
                "sync.run"
            ]
        );
        assert_eq!(calls[2].params["sku"], "00012345678901234567890");
        assert_eq!(calls[2].params["limit"], 20);
        assert_eq!(calls[6].params["operationId"], id.to_lowercase());
        assert_ne!(calls[5].request_id, calls[6].request_id);
        let envelope: Value = serde_json::from_str(
            responses[7]["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(envelope["data"]["status"], "queued");
        assert_eq!(catalog(&options).len(), 9);
    }

    #[test]
    fn protocol_parse_errors_and_size_limit_are_bounded() {
        for (input, code) in [
            (b"{\n".to_vec(), -32700),
            (b"[]\n".to_vec(), -32600),
            (vec![b'x'; MAX_FRAME_BYTES + 3], -32600),
        ] {
            let mut output = Vec::new();
            serve(
                io::Cursor::new(input),
                &mut output,
                &Options::default(),
                |_| panic!("must not call transport"),
            )
            .unwrap();
            let response: Value = serde_json::from_slice(&output).unwrap();
            assert_eq!(response["error"]["code"], code);
        }
    }

    #[test]
    fn agent_errors_become_tool_errors_without_losing_code() {
        let mut session = Session {
            initialized: true,
            ready: true,
        };
        let result = session
            .handle(
                invoke("workbench_status", json!({})),
                &Options::default(),
                &mut |request| {
                    Response::failure(&request, AgentError::new("UI_UNAVAILABLE", "测试界面离线"))
                },
            )
            .unwrap();
        assert_eq!(result["result"]["isError"], true);
        let response: Value =
            serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(response["error"]["code"], "UI_UNAVAILABLE");
    }
}
