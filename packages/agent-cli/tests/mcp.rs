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
