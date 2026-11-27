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
    /// 使用支持实时 AI 权限的新工作台裁决所有已实现工具
    #[arg(long)]
    follow_workbench: bool,
    /// 开放新建 NAS 草稿链接的预览和保存
    #[arg(long)]
    allow_draft_writes: bool,
    /// 开放 NAS 输出源维护的预览和保存
    #[arg(long)]
    allow_source_writes: bool,
}

fn invalid(message: &str) -> AgentError {
    AgentError::new("INVALID_ARGUMENT", message)
}

impl Options {
    fn needs_workbench_policy(&self, method: &str) -> bool {
        self.follow_workbench
            && match method {
                "changes.preview" | "changes.apply" => !self.allow_writes,
                "draft.preview" | "draft.apply" => !self.allow_draft_writes,
                "sources.preview" | "sources.apply" => !self.allow_source_writes,
                "export.start" => !self.allow_export,
                "sync.run" => !self.allow_sync,
                _ => false,
            }
    }
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
    let limit = json!({"type":"integer","minimum":1,"maximum":100});
    let query = json!({"type":"string","minLength":1,"maxLength":200});
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
                json!({"shopId":string,"query":query,"goodsId":string,"sku":string,"spu":string,"limit":{"type":"integer","minimum":1,"maximum":100,"default":20},"offset":integer,"revision":integer}),
                &[],
            ),
            true,
        ),
        (
            "workbench_configs_get",
            "configs.get",
            "按精确配置 ID 回读已保存配置。",
            schema(json!({"configId":string,"shopId":string}), &["configId"]),
            true,
        ),
        (
            "workbench_jobs_status",
            "jobs.status",
            "按 jobId 或 operationId 查询任务，必须且只能提供一个；queued/running 不是成功。",
            schema(json!({"jobId":string,"operationId":uuid}), &[]),
            true,
        ),
        (
            "workbench_sources_find",
            "sources.find",
            "分页筛选指定店铺输出源，后续页沿用 revision。",
            schema(
                json!({
                    "shopId":string,"query":query,"category":{"type":"string","enum":["全部配件","CPU","主板","显卡","内存","硬盘","散热","风扇","机箱","电源","其他配件","特殊配件"]},
                    "stockStatus":{"type":"string","enum":["in_stock","incoming","out","unknown"]},
                    "minPrice":{"type":"number","minimum":0},"maxPrice":{"type":"number","minimum":0},
                    "filter":{"type":"string","enum":["all","diff","upgrade","shortage","missing_tax","deleted"]},
                    "includeDeleted":{"type":"boolean"},"limit":limit,"offset":integer,"revision":integer
                }),
                &["shopId"],
            ),
            true,
        ),
        (
            "workbench_sources_get",
            "sources.get",
            "按 sourceId 或 goodsId 精确查询输出源，遇多别名时使用返回的 sourceId 重查。",
            schema(
                json!({
                    "shopId":string,"sourceId":string,"goodsId":string,"includeDeleted":{"type":"boolean"}
                }),
                &["shopId"],
            ),
            true,
        ),
        (
            "workbench_inventory_check",
            "inventory.check",
            "用 shopId 和 operationId 开始检查已保存的实际 BOM，或仅用 jobId、offset、limit 回读相同快照。",
            schema(
                json!({
            "shopId":string,"operationId":uuid,"jobId":string,"productId":string,
            "threshold":{"type":"integer","minimum":0,"maximum":100000000},"status":{"type":"string","enum":["out","low","unknown"]},
            "limit":limit,"offset":integer}),
                &[],
            ),
            true,
        ),
        (
            "workbench_activity_list",
            "activity.list",
            "按日期、操作人或对象类型读取本店服务端记录。",
            schema(
                json!({
            "shopId":string,"from":string,"to":string,"actor":string,"kind":{"type":"string","enum":["configurations","sources","shared-sources","costs","addons","gallery","templates","settings","quotations","assets"]},
            "page":integer,"pageSize":limit}),
                &["shopId"],
            ),
            true,
        ),
    ];
    if options.allow_writes || options.follow_workbench {
        entries.extend([
            ("workbench_changes_preview", "changes.preview", "预览变更并排队；request 使用原 changes.preview 业务结构（shopId、targets、action），查询终态取得 planId。", schema(json!({"request":{"type":"object","properties":{"shopId":string,"targets":{"type":"array","minItems":1,"items":{"type":"object"}},"action":{"type":"object"}},"required":["shopId","targets","action"]},"operationId":uuid}), &["request","operationId"]), false),
            ("workbench_changes_apply", "changes.apply", "应用成功预览的 planId；保存后查询任务终态并回读配置。保留原 operationId 重试。", schema(json!({"planId":string,"operationId":uuid}), &["planId","operationId"]), false),
        ]);
    }
    // 三类保存配有独立工具开关，共享协议 envelope；业务正文保持各自字段契约。
    let apply_schema = schema(
        json!({"planId":string,"operationId":uuid}),
        &["planId", "operationId"],
    );
    let preview_schema = |body: Value| {
        schema(
            json!({"request":body,"operationId":uuid}),
            &["request", "operationId"],
        )
    };
    if options.allow_draft_writes || options.follow_workbench {
        let part = schema(
            json!({"sourceId":{"type":"string","minLength":1,"maxLength":256},"slot":{"type":"string","minLength":1,"maxLength":256},"qty":{"type":"integer","minimum":1,"maximum":2147483647}}),
            &["sourceId", "slot"],
        );
        let parts = json!({"type":"array","minItems":1,"maxItems":500,"items":part});
        let config = schema(
            json!({"name":string,"parts":parts,"actualParts":parts,"price":{"type":"number","minimum":0}}),
            &["name", "parts"],
        );
        let draft = schema(
            json!({"mode":{"type":"string","enum":["new_draft_link"]},"shopId":string,"productName":string,
            "configs":{"type":"array","minItems":1,"maxItems":16,"items":config}}),
            &["mode", "shopId", "productName", "configs"],
        );
        entries.extend([
            (
                "workbench_draft_preview",
                "draft.preview",
                "预览新建 NAS 草稿链接，检查每套配置的来源及板型；成功后返回 planId。",
                preview_schema(draft),
                false,
            ),
            (
                "workbench_draft_apply",
                "draft.apply",
                "按预览计划保存到指定店铺草稿区，核对正式回执与新链接。",
                apply_schema.clone(),
                false,
            ),
        ]);
    }
    if options.allow_source_writes || options.follow_workbench {
        let nullable_number = json!({"type":["number","null"]});
        let nullable_text = json!({"type":["string","null"]});
        let fields = schema(
            json!({
                "name":string,"tax":nullable_number,"addon":{"type":"object"},
                "capacityOverrides.memoryGb":nullable_number,"capacityOverrides.vramGb":nullable_number,"capacityOverrides.storageGb":nullable_number,
                "hardwareOverrides.cpuName":nullable_text,"hardwareOverrides.gpuName":nullable_text,"hardwareOverrides.color":nullable_text,
                "hardwareOverrides.boardType":nullable_text,"hardwareOverrides.caseBoards":{"type":["array","null"],"items":string}
            }),
            &[],
        );
        let source = schema(
            json!({"shopId":string,"scope":{"type":"string","enum":["shop","shared"]},
            "action":{"type":"string","enum":["edit","adopt_erp","create_special","archive","restore"]},"sourceId":string,
            "goodsId":string,"fields":fields,"restoreFields":{"type":"array","items":string},"resumeTax":{"type":"boolean"},
            "followConfigs":{"type":"boolean","default":false}}),
            &["shopId", "scope", "action"],
        );
        entries.extend([
            (
                "workbench_sources_preview",
                "sources.preview",
                "预览指定店铺或三店共用来源的维护步骤，可显式请求关联配置跟随。",
                preview_schema(source),
                false,
            ),
            (
                "workbench_sources_apply",
                "sources.apply",
                "按冻结计划保存来源并回读各步回执，部分成功时沿用原 operationId 以继续。",
                apply_schema,
                false,
            ),
        ]);
    }
    if options.allow_export || options.follow_workbench {
        entries.push(("workbench_export_start", "export.start", "导出固定快照（configIds + revision 或 sourceOperationId）；outputDir 须为已有绝对目录，最终回执返回文件及 SHA256。", schema(json!({"configIds":{"type":"array","minItems":1,"items":string},"shopId":string,"revision":integer,"sourceOperationId":uuid,"images":{"type":"string","enum":["both","long","square"]},"report":{"type":"boolean"},"outputDir":string,"operationId":uuid}), &["outputDir","operationId","images","report"]), false));
    }
    if options.allow_sync || options.follow_workbench {
        entries.push((
            "workbench_sync_run",
            "sync.run",
            "按当前成员会话发起云同步；仅在授权范围内调用，查询任务终态。",
            schema(json!({"operationId":uuid}), &["operationId"]),
            false,
        ));
    }
    entries.into_iter().map(|(name, method, description, mut input, read)| {
        if super::wait::supported(method){
            input["properties"]["waitMs"]=json!({"type":"integer","minimum":0,"maximum":10000,"default":0});
        }
        json!({
        "name":name,"description":description,"inputSchema":input,
        "annotations":{"readOnlyHint":read,"destructiveHint":!read,"idempotentHint":true,"openWorldHint":method=="sync.run"},
        // 内部映射在 tools/list 时移除，不允许客户端自选协议方法。
        "agentMethod":method
    })}).collect()
}

fn validate(schema: &Value, value: &Value) -> Result<(), AgentError> {
    let has_type = |kind: &str| match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => value.as_u64().is_some(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    };
    // 明确清除覆盖值时保留 null，与省略字段保持区分。
    let valid = match &schema["type"] {
        Value::String(kind) => has_type(kind),
        Value::Array(types) => types.iter().filter_map(Value::as_str).any(has_type),
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
                    return Err(invalid("包含未声明的工具参数"));
                }
                _ => (),
            }
        }
    }
    if let Some(items) = value.as_array() {
        if schema["maxItems"]
            .as_u64()
            .is_some_and(|max| items.len() as u64 > max)
        {
            return Err(invalid("数组超出工具参数数量限制"));
        }
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
        if schema["maxLength"]
            .as_u64()
            .is_some_and(|max| text.chars().count() as u64 > max)
        {
            return Err(invalid("文字超出工具参数长度"));
        }
    }
    if schema["type"] == "number"
        && value
            .as_f64()
            .zip(schema["minimum"].as_f64())
            .is_some_and(|(n, min)| n < min)
    {
        return Err(invalid("数值低于工具参数下限"));
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

fn tool_request(entry: &Value, mut args: Value) -> Result<(Request, u64), AgentError> {
    validate(&entry["inputSchema"], &args)?;
    // 短等待属于适配层参数，不会进入管道或参与业务幂等校验。
    let wait_ms = args
        .as_object_mut()
        .unwrap()
        .remove("waitMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
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
    Ok((super::queries::checked(method, args)?, wait_ms))
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

// 工具目录描述 MCP 允许的上限。status 只列出本进程可实际使用的方法。
fn project_status(status: &mut Value, entries: &[Value], options: &Options) {
    let supports_policy = status["agentPermissionVersion"] == 1;
    let filter = |methods: &mut Vec<Value>| {
        methods.retain(|value| {
            value.as_str().is_some_and(|method| {
                entries.iter().any(|entry| entry["agentMethod"] == method)
                    && (supports_policy || !options.needs_workbench_policy(method))
            })
        })
    };
    if let Some(shops) = status
        .get_mut("shopCapabilities")
        .and_then(Value::as_object_mut)
    {
        for methods in shops.values_mut().filter_map(Value::as_array_mut) {
            filter(methods);
        }
    }
    // 子权限只在对应店铺具有 sources.apply 且 MCP 开放该工具时生效。
    let source_shops = status["shopCapabilities"].as_object().map(|shops| {
        shops
            .iter()
            .filter(|(_, methods)| {
                methods
                    .as_array()
                    .is_some_and(|list| list.contains(&json!("sources.apply")))
            })
            .map(|(shop, _)| shop.clone())
            .collect::<std::collections::HashSet<_>>()
    });
    if let Some(scopes) = status
        .get_mut("shopSourceScopes")
        .and_then(Value::as_object_mut)
    {
        for (shop, scope) in scopes {
            if !source_shops
                .as_ref()
                .is_some_and(|shops| shops.contains(shop))
            {
                *scope = json!({"shared":false,"followConfigs":false});
            }
        }
    }
    if let Some(methods) = status.get_mut("capabilities").and_then(Value::as_array_mut) {
        filter(methods);
        let read_only = !methods.iter().any(|method| {
            matches!(
                method.as_str(),
                Some(
                    "changes.apply" | "draft.apply" | "sources.apply" | "export.start" | "sync.run"
                )
            )
        });
        status["readOnly"] = json!(read_only);
    }
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
        call: &mut impl FnMut(Request, u64) -> Response,
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
                ));
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
                let mut response = match tool_request(entry, args) {
                    Ok((request, wait_ms)) => call(request, wait_ms),
                    // 工具输入校验失败也是工具结果，客户端可读取错误后修正参数。
                    Err(error) => Response::failure(
                        &super::request(entry["agentMethod"].as_str().unwrap(), json!({})),
                        error,
                    ),
                };
                if entry["agentMethod"] == "status" && response.ok {
                    if let Some(status) = response.data.as_mut() {
                        project_status(status, &entries, options);
                    }
                }
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
    mut call: impl FnMut(Request, u64) -> Response,
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
        |request, wait_ms| {
            let response = options.instance(explicit).and_then(|instance| {
                // 固定这次工具调用的实例。旧桌面不识别本机策略，不能因 follow 扩大写权限。
                if options.needs_workbench_policy(&request.method) {
                    let policy = transport::call(&instance, &super::request("status", json!({})))?;
                    if let Some(error) = policy.error {
                        return Err(error);
                    }
                    if !policy
                        .data
                        .is_some_and(|d| d["agentPermissionVersion"] == 1)
                    {
                        return Err(AgentError::new(
                            "WORKBENCH_POLICY_REQUIRED",
                            "此实例不支持工作台 AI 接口权限，请连接已升级的 NAS 工作台",
                        ));
                    }
                }
                super::wait::call(&instance, &request, wait_ms)
            });
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
        serve(
            io::Cursor::new(input),
            &mut output,
            options,
            |request, _| {
                let response = Response::success(
                    &request,
                    json!({"status":"queued","operationId":request.params["operationId"]}),
                );
                calls.push(request);
                response
            },
        )
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
        assert_eq!(tools.len(), 9);
        assert!(tools.iter().all(|t| t.get("agentMethod").is_none()));
        assert_eq!(responses[2]["error"]["code"], -32602);
        assert_eq!(responses[3]["error"]["code"], -32602);
        assert_eq!(responses[4]["error"]["code"], -32601);
        assert!(calls.is_empty());
    }

    #[test]
    fn write_switches_only_expose_their_own_preview_and_apply() {
        let id = "a1234567-1234-4234-8234-123456789abc";
        let draft = json!({"shopId":"intel","mode":"new_draft_link","productName":"测试","configs":[{"name":"A","parts":[{"sourceId":"s","slot":"CPU"}]}]});
        let sources = json!({"shopId":"intel","scope":"shop","action":"edit","sourceId":"s","fields":{"name":"改名"}});
        for (options, methods) in [
            (
                Options {
                    allow_writes: true,
                    ..Default::default()
                },
                vec!["changes.preview", "changes.apply"],
            ),
            (
                Options {
                    allow_draft_writes: true,
                    ..Default::default()
                },
                vec!["draft.preview", "draft.apply"],
            ),
            (
                Options {
                    allow_source_writes: true,
                    ..Default::default()
                },
                vec!["sources.preview", "sources.apply"],
            ),
            (
                Options {
                    follow_workbench: true,
                    ..Default::default()
                },
                vec![
                    "changes.preview",
                    "changes.apply",
                    "draft.preview",
                    "draft.apply",
                    "sources.preview",
                    "sources.apply",
                ],
            ),
        ] {
            let entries = catalog(&options);
            for family in ["changes", "draft", "sources"] {
                for action in ["preview", "apply"] {
                    let method = format!("{family}.{action}");
                    let entry = entries.iter().find(|entry| entry["agentMethod"] == method);
                    assert_eq!(entry.is_some(), methods.contains(&method.as_str()));
                    let Some(tool) = entry else { continue };
                    let body = match family {
                        "draft" => draft.clone(),
                        "sources" => sources.clone(),
                        _ => json!({"shopId":"intel","targets":[{}],"action":{}}),
                    };
                    let args = if action == "preview" {
                        json!({"operationId":id,"request":body,"waitMs":2000})
                    } else {
                        json!({"operationId":id,"planId":"plan","waitMs":2000})
                    };
                    let (request, wait) = tool_request(tool, args).unwrap();
                    assert_eq!(request.method, method);
                    assert_eq!(wait, 2000);
                    assert!(request.params.get("waitMs").is_none());
                }
            }
        }
    }

    #[test]
    fn source_scopes_are_projected_with_the_per_shop_write_method() {
        let status = json!({"agentPermissionVersion":1,"capabilities":["status","sources.apply"],
            "shopCapabilities":{"intel":["sources.apply"],"jonsbo":["sources.get"]},
            "shopSourceScopes":{"intel":{"shared":true,"followConfigs":true},"jonsbo":{"shared":true,"followConfigs":true}}});
        for allow_source_writes in [false, true] {
            let mut data = status.clone();
            let options = Options {
                allow_writes: true,
                allow_source_writes,
                ..Default::default()
            };
            project_status(&mut data, &catalog(&options), &options);
            assert_eq!(data["readOnly"], !allow_source_writes);
            for field in ["shared", "followConfigs"] {
                assert_eq!(
                    data["shopSourceScopes"]["intel"][field],
                    allow_source_writes
                );
                assert_eq!(data["shopSourceScopes"]["jonsbo"][field], false);
            }
        }
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
                json!({"request":{"shopId":"sample","targets":[{"configId":"sample","partIndex":0}],"action":{"type":"replace","sourceId":"src","displayName":"直播专属型号"}},"operationId":id}),
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
        assert_eq!(
            calls[5].params["request"]["action"]["displayName"],
            "直播专属型号"
        );
        assert_eq!(calls[6].params["operationId"], id.to_lowercase());
        assert_ne!(calls[5].request_id, calls[6].request_id);
        let envelope: Value = serde_json::from_str(
            responses[7]["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(envelope["data"]["status"], "queued");
        assert_eq!(catalog(&options).len(), 13);
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
                |_, _| panic!("must not call transport"),
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
                &mut |request, _| {
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
