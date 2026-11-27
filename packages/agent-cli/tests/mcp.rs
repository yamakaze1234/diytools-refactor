//! 实际 CLI 子进程与当前用户 Windows 管道测试，所有数据均为内存合成样本。
#![cfg(windows)]
use diytools_agent_core::{transport, AgentError, Response};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
};

struct Client {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Client {
    fn start(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_diytools-agent"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut client = Self { child, output };
        let initialized = client.request(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"pipe-test","version":"1"}}}));
        assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");
        client.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        client
    }
    fn send(&mut self, value: Value) {
        writeln!(self.child.stdin.as_mut().unwrap(), "{value}").unwrap();
    }
    fn request(&mut self, value: Value) -> Value {
        self.send(value);
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    fn tool(&mut self, name: &str, args: Value) -> Value {
        let result=self.request(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":args}}));
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        // EOF 正常关闭 MCP，不结束桌面宿主或取消已排队操作。
        self.child.stdin.take();
        assert!(self.child.wait().unwrap().success());
    }
}

#[test]
fn subprocess_uses_real_pipe_and_preserves_receipts_and_errors() {
    let instance = format!("mcp-receipts-{}", std::process::id());
    let _server = transport::serve(
        &instance,
        Arc::new(|request| {
            if request.method == "configs.get" {
                Response::failure(
                    &request,
                    AgentError::new("CONFIG_NOT_FOUND", "合成配置不存在"),
                )
            } else {
                Response::success(
                    &request,
                    json!({"status":"queued","method":request.method,"params":request.params}),
                )
            }
        }),
    )
    .unwrap();
    let mut client = Client::start(&["--instance", &instance, "mcp", "--allow-writes"]);
    let operation = "a1234567-1234-4234-8234-123456789abc";
    let first = client.tool(
        "workbench_changes_apply",
        json!({"planId":"isolated-plan","operationId":operation}),
    );
    let second = client.tool(
        "workbench_changes_apply",
        json!({"planId":"isolated-plan","operationId":operation}),
    );
    assert_eq!(first["data"], second["data"]);
    assert_ne!(first["requestId"], second["requestId"]);
    assert_eq!(first["data"]["status"], "queued");
    assert_eq!(first["data"]["params"]["operationId"], operation);
    let failure = client.tool("workbench_configs_get", json!({"configId":"missing"}));
    assert_eq!(failure["error"]["code"], "CONFIG_NOT_FOUND");
    let denied=client.request(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workbench_sync_run","arguments":{"operationId":operation}}}));
    assert_eq!(denied["error"]["code"], -32602);
}

#[test]
fn connection_is_reread_after_restart_and_never_executes_cli_field() {
    let directory =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sandbox/agent-cli-tests");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("mcp-{}.json", uuid::Uuid::new_v4()));
    let instance = format!("mcp-restart-{}", std::process::id());
    let _server = transport::serve(
        &instance,
        Arc::new(|request| Response::success(&request, json!({"sample":true}))),
    )
    .unwrap();
    std::fs::write(
        &path,
        json!({"instance":instance,"cli":"must-not-execute.exe"}).to_string(),
    )
    .unwrap();
    let mut client = Client::start(&["mcp", "--connection", path.to_str().unwrap()]);
    assert_eq!(
        client.tool("workbench_status", json!({}))["data"]["sample"],
        true
    );
    std::fs::write(&path, "{\"instance\":\"../invalid\"}").unwrap();
    assert_eq!(
        client.tool("workbench_status", json!({}))["error"]["code"],
        "INVALID_INSTANCE"
    );
    std::fs::write(&path, json!({"instance":instance}).to_string()).unwrap();
    assert_eq!(client.tool("workbench_status", json!({}))["ok"], true);
    // 夹具留在 sandbox，任务结束统一移到回收站。
}

#[test]
fn missing_mcp_target_exits_without_polluting_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_diytools-agent"))
        .arg("mcp")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
}

#[test]
fn follow_workbench_preserves_catalog_and_projects_live_capabilities() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let instance = format!("mcp-policy-{}", std::process::id());
    let policy = Arc::new(AtomicBool::new(true));
    let writes = Arc::new(AtomicUsize::new(0));
    let supports_policy = policy.clone();
    let forwarded = writes.clone();
    let _server = transport::serve(&instance, Arc::new(move |request| {
        if request.method == "status" {
            let methods = json!(["status", "sources.find", "changes.apply", "export.start", "sync.run", "future.method"]);
            let mut status = json!({"readOnly":false,"capabilities":methods,"shopCapabilities":{"intel":methods,"jonsbo":["sources.find"]}});
            if supports_policy.load(Ordering::SeqCst) { status["agentPermissionVersion"] = json!(1); }
            Response::success(&request, status)
        } else {
            forwarded.fetch_add(1, Ordering::SeqCst);
            Response::success(&request, json!({"status":"queued"}))
        }
    })).unwrap();
    let mut read = Client::start(&[
        "--instance",
        &instance,
        "mcp",
        "--allow-draft-writes",
        "--allow-source-writes",
    ]);
    let read_status = read.tool("workbench_status", json!({}));
    assert_eq!(read_status["data"]["readOnly"], true);
    assert_eq!(
        read_status["data"]["capabilities"],
        json!(["status", "sources.find"])
    );
    assert_eq!(
        read_status["data"]["shopCapabilities"]["intel"],
        json!(["status", "sources.find"])
    );
    let list = json!({"jsonrpc":"2.0","id":3,"method":"tools/list"});
    let mut follow = Client::start(&["--instance", &instance, "mcp", "--follow-workbench"]);
    let original = follow.request(list.clone());
    assert_eq!(original["result"]["tools"].as_array().unwrap().len(), 17);
    let live = follow.tool("workbench_status", json!({}));
    assert_eq!(live["data"]["readOnly"], false);
    assert_eq!(
        live["data"]["shopCapabilities"]["jonsbo"],
        json!(["sources.find"])
    );
    assert!(!live["data"]["capabilities"]
        .to_string()
        .contains("future.method"));
    let args = json!({"planId":"demo","operationId":"a1234567-1234-4234-8234-123456789abc"});
    assert_eq!(
        follow.tool("workbench_changes_apply", args.clone())["ok"],
        true
    );
    // 同一个 MCP 进程转到旧策略版本后，工具目录稳定，已有授权上限实时收窄。
    policy.store(false, Ordering::SeqCst);
    assert_eq!(follow.request(list), original);
    assert_eq!(
        follow.tool("workbench_status", json!({}))["data"]["readOnly"],
        true
    );
    assert_eq!(
        follow.tool("workbench_changes_apply", args.clone())["error"]["code"],
        "WORKBENCH_POLICY_REQUIRED"
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    let mut legacy = Client::start(&["--instance", &instance, "mcp", "--allow-writes"]);
    assert_eq!(legacy.tool("workbench_changes_apply", args)["ok"], true);
    assert_eq!(writes.load(Ordering::SeqCst), 2);
}

#[test]
fn inventory_wait_returns_same_snapshot_and_preserves_nas_query_errors() {
    use std::sync::Mutex;
    let trace = Arc::new(Mutex::new(Vec::new()));
    let recorded = trace.clone();
    let instance = format!("mcp-inventory-{}", std::process::id());
    let operation = "a1234567-1234-4234-8234-123456789abc";
    let _server = transport::serve(&instance, Arc::new(move |request| {
        recorded.lock().unwrap().push((request.request_id.clone(),request.method.clone(),request.params.clone()));
        // 宿主只在回读库存页时返回明细，状态轮询始终只给摘要。
        let mut job = json!({"jobId":"snapshot","operationId":operation,"status":"succeeded","result":{"total":6}});
        match request.method.as_str() {
            "inventory.check" if request.params.get("jobId").is_some() => job["result"]["items"]=json!([{"goodsId":"0001"}]),
            "inventory.check" => {job["status"]=json!("queued");job["result"]=Value::Null;},
            "jobs.status"=>{},
            "sources.get"=>return Response::failure(&request,AgentError::new("AMBIGUOUS_SOURCE",r#"["source-a","source-b"]"#)),
            "activity.list"=>return Response::failure(&request,AgentError::new("UNSUPPORTED_FILTER","当前服务版本不支持按操作人或对象类型筛选")),
            _=>panic!("unexpected method"),
        }
        Response::success(&request,job)
    })).unwrap();
    let mut client = Client::start(&["--instance", &instance, "mcp"]);
    let start = json!({"operationId":operation,"shopId":"intel","productId":"link","offset":4,"limit":2,"waitMs":2400});
    let response = client.tool("workbench_inventory_check", start);
    assert_eq!(response["data"]["result"]["items"][0]["goodsId"], "0001");
    {
        let calls = trace.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(response["requestId"], calls[0].0);
        assert_eq!(
            calls[0].2,
            json!({"operationId":operation,"shopId":"intel","productId":"link","offset":4,"limit":2})
        );
        assert_eq!(
            (&calls[1].1, &calls[1].2),
            (&"jobs.status".to_owned(), &json!({"jobId":"snapshot"}))
        );
        assert_eq!(calls[2].2, json!({"jobId":"snapshot","offset":4,"limit":2}));
    }
    let ambiguous = client.tool(
        "workbench_sources_get",
        json!({"shopId":"intel","goodsId":"0001"}),
    );
    assert_eq!(ambiguous["error"]["code"], "AMBIGUOUS_SOURCE");
    assert!(ambiguous["error"]["message"]
        .as_str()
        .unwrap()
        .contains("source-b"));
    assert_eq!(
        client.tool(
            "workbench_activity_list",
            json!({"shopId":"intel","actor":"操作人"})
        )["error"]["code"],
        "UNSUPPORTED_FILTER"
    );
    assert_eq!(
        client.tool(
            "workbench_inventory_check",
            json!({"shopId":"intel","jobId":"mixed"})
        )["error"]["code"],
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        client.tool(
            "workbench_inventory_check",
            json!({"shopId":"intel","operationId":operation,"waitMs":10001})
        )["error"]["code"],
        "INVALID_ARGUMENT"
    );
}
