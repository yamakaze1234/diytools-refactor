use clap::{error::ErrorKind, Args, Parser, Subcommand};
use diytools_agent_core::{
    transport, AgentError, Request, Response, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use serde_json::{json, Map, Value};
use std::{fs::File, io::Read, path::PathBuf, process::ExitCode};

#[derive(Debug, Parser)]
#[command(
    name = "diytools-agent",
    version,
    about = "DIY 配置工作台本机只读 Agent CLI"
)]
struct Cli {
    /// 输出稳定 JSON envelope，适合脚本调用
    #[arg(long, global = true)]
    json: bool,
    /// 桌面实例标识，例如 desktop-12345；必须显式指定
    #[arg(long, global = true)]
    instance: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 查询实例与已保存快照状态
    Status,
    /// 通过 status 检查连接并说明当前能力边界
    Doctor,
    Shops {
        #[command(subcommand)]
        command: ShopsCommand,
    },
    Configs {
        #[command(subcommand)]
        command: ConfigsCommand,
    },
    Changes {
        #[command(subcommand)]
        command: ChangesCommand,
    },
    Export {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_parser = operation_id)]
        operation_id: String,
    },
    Jobs {
        #[command(subcommand)]
        command: JobsCommand,
    },
    Sync {
        #[command(subcommand)]
        command: SyncCommand,
    },
    /// 发起只读协议请求，input 必须是 JSON 对象文件
    Request {
        #[arg(long, value_parser = ["status", "shops.list", "configs.find", "configs.get", "jobs.status"])]
        method: String,
        #[arg(long)]
        input: Option<PathBuf>,
    },
}

fn operation_id(value: &str) -> Result<String, String> {
    if value.len() != 36 {
        return Err("operationId 必须为 UUID".into());
    }
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| "operationId 必须为 UUID".into())
}

#[derive(Debug, Subcommand)]
enum ChangesCommand {
    Preview {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_parser = operation_id)]
        operation_id: Option<String>,
    },
    Apply {
        #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
        plan_id: String,
        #[arg(long, value_parser = operation_id)]
        operation_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum JobsCommand {
    Status {
        #[arg(long, conflicts_with = "operation_id", required_unless_present = "operation_id", value_parser = clap::builder::NonEmptyStringValueParser::new())]
        job_id: Option<String>,
        #[arg(long, conflicts_with = "job_id", required_unless_present = "job_id", value_parser = operation_id)]
        operation_id: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum SyncCommand {
    Run {
        #[arg(long, value_parser = operation_id)]
        operation_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum ShopsCommand {
    List,
}

#[derive(Debug, Subcommand)]
enum ConfigsCommand {
    Find(FindArgs),
    Get {
        #[arg(long)]
        config_id: String,
    },
}

#[derive(Debug, Args)]
struct FindArgs {
    #[arg(long)]
    shop_id: Option<String>,
    #[arg(long)]
    goods_id: Option<String>,
    #[arg(long)]
    sku: Option<String>,
    #[arg(long)]
    spu: Option<String>,
    #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
    limit: u32,
    #[arg(long, default_value_t = 0)]
    offset: u64,
    #[arg(long)]
    revision: Option<u64>,
}

fn request(method: &str, params: Value) -> Request {
    Request {
        protocol_version: PROTOCOL_VERSION,
        request_id: uuid::Uuid::new_v4().to_string(),
        method: method.to_owned(),
        params,
    }
}

fn input_object(path: &PathBuf) -> Result<Value, AgentError> {
    let file = File::open(path)
        .map_err(|e| AgentError::new("INPUT_READ_FAILED", format!("无法读取 input 文件：{e}")))?;
    let mut bytes = Vec::new();
    // 有界读取同样约束预览与导出输入，不依赖可能在读取时变化的 metadata。
    file.take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| AgentError::new("INPUT_READ_FAILED", format!("无法读取 input 文件：{e}")))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AgentError::new(
            "INPUT_TOO_LARGE",
            "input 文件不能超过 1 MiB",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AgentError::new("INVALID_JSON", format!("input 不是有效 JSON：{e}")))?;
    if !value.is_object() {
        return Err(AgentError::new("INVALID_INPUT", "input 必须是 JSON 对象"));
    }
    Ok(value)
}

fn command_request(command: &Command) -> Result<Request, AgentError> {
    match command {
        Command::Changes {
            command:
                ChangesCommand::Preview {
                    input,
                    operation_id,
                },
        } => Ok(request(
            "changes.preview",
            json!({"request":input_object(input)?,"operationId":operation_id.clone().unwrap_or_else(||uuid::Uuid::new_v4().to_string())}),
        )),
        Command::Changes {
            command:
                ChangesCommand::Apply {
                    plan_id,
                    operation_id,
                },
        } => Ok(request(
            "changes.apply",
            json!({"planId":plan_id,"operationId":operation_id}),
        )),
        Command::Export {
            input,
            operation_id: operation,
        } => {
            let mut params = input_object(input)?;
            if params.get("operationId").is_some() {
                return Err(AgentError::new(
                    "INVALID_INPUT",
                    "operationId 只通过 --operation-id 提供",
                ));
            }
            if let Some(source) = params.get("sourceOperationId") {
                let source = source.as_str().ok_or_else(|| {
                    AgentError::new("INVALID_INPUT", "sourceOperationId 必须为 UUID")
                })?;
                params["sourceOperationId"] =
                    json!(operation_id(source).map_err(|e| AgentError::new("INVALID_INPUT", e))?);
            }
            params["operationId"] = json!(operation);
            Ok(request("export.start", params))
        }
        Command::Jobs {
            command:
                JobsCommand::Status {
                    job_id,
                    operation_id,
                },
        } => Ok(request(
            "jobs.status",
            match job_id {
                Some(id) => json!({"jobId":id}),
                None => json!({"operationId":operation_id}),
            },
        )),
        Command::Sync {
            command: SyncCommand::Run { operation_id },
        } => Ok(request("sync.run", json!({"operationId":operation_id}))),
        Command::Status | Command::Doctor => Ok(request("status", json!({}))),
        Command::Shops { .. } => Ok(request("shops.list", json!({}))),
        Command::Configs {
            command: ConfigsCommand::Get { config_id },
        } => Ok(request("configs.get", json!({"configId": config_id}))),
        Command::Configs {
            command: ConfigsCommand::Find(args),
        } => {
            if args.offset > 0 && args.revision.is_none() {
                return Err(AgentError::new(
                    "INVALID_ARGUMENT",
                    "offset 大于 0 时必须提供 --revision，确保分页来自同一已保存快照",
                ));
            }
            let mut params = Map::new();
            for (key, value) in [
                ("shopId", &args.shop_id),
                ("goodsId", &args.goods_id),
                ("sku", &args.sku),
                ("spu", &args.spu),
            ] {
                if let Some(value) = value {
                    params.insert(key.into(), json!(value));
                }
            }
            params.insert("limit".into(), json!(args.limit));
            params.insert("offset".into(), json!(args.offset));
            if let Some(revision) = args.revision {
                params.insert("revision".into(), json!(revision));
            }
            Ok(request("configs.find", Value::Object(params)))
        }
        Command::Request { method, input } => {
            let params = match input {
                Some(path) => input_object(path)?,
                None => json!({}),
            };
            Ok(request(method, params))
        }
    }
}

fn print_response(response: &Response, json_mode: bool, doctor: bool) {
    // 错误始终使用同一种 envelope；stdout 不混入日志或帮助提示。
    if json_mode || !response.ok {
        println!(
            "{}",
            serde_json::to_string(response).expect("response is serializable")
        );
        return;
    }
    if doctor {
        println!("本机实例连接正常。授权范围：当前 Windows 用户。\n读取范围：桌面程序已保存的 snapshot。可用操作以实例返回的 capabilities 为准。\n长任务排队后请通过 jobs status 查询；本机保存、导出和云同步分别记账。");
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&response.data).expect("data is serializable")
    );
}

fn fail(request: &Request, error: AgentError) -> ExitCode {
    print_response(&Response::failure(request, error), true, false);
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            return fail(
                &request("cli", json!({})),
                AgentError::new("INVALID_ARGUMENT", error.to_string()),
            )
        }
    };
    let diagnostic_request = request("cli", json!({}));
    let instance = match cli
        .instance
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(instance) => instance,
        None => {
            return fail(
                &diagnostic_request,
                AgentError::new(
                    "INSTANCE_REQUIRED",
                    "必须通过 --instance desktop-PID 指定已启用 Agent 入口的桌面实例",
                ),
            )
        }
    };
    let request = match command_request(&cli.command) {
        Ok(request) => request,
        Err(error) => return fail(&diagnostic_request, error),
    };
    let doctor = matches!(cli.command, Command::Doctor);
    let mut response = match transport::call(instance, &request) {
        Ok(response) => response,
        Err(error) => return fail(&request, error),
    };
    if doctor && response.ok {
        let capabilities = response
            .data
            .as_ref()
            .and_then(|status| status.get("capabilities"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let supports = |method: &str| {
            capabilities
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(method)))
        };
        response.data = Some(json!({
            "status": response.data,
            "authorization": "currentWindowsUser",
            "dataScope": "savedSnapshotOnly",
            "writesSupported": supports("changes.apply"),
            "syncSupported": supports("sync.run"),
            "capabilities": capabilities
        }));
    }
    let success = response.ok;
    print_response(&response, cli.json, doctor);
    if success {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
