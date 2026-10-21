use serde_json::Value;
use std::process::{Command, Output};

fn fixture_path() -> std::path::PathBuf {
    let directory =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sandbox/agent-cli-tests");
    std::fs::create_dir_all(&directory).unwrap();
    directory.join(format!("{}.json", uuid::Uuid::new_v4()))
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_diytools-agent"))
        .args(args)
        .output()
        .expect("run CLI")
}

fn error_code(output: &Output) -> String {
    assert!(!output.status.success());
    assert!(
        output.stderr.is_empty(),
        "stderr must not mix logs into JSON output"
    );
    let envelope: Value =
        serde_json::from_slice(&output.stdout).expect("exactly one JSON envelope");
    assert_eq!(envelope["protocolVersion"], 1);
    assert_eq!(envelope["ok"], false);
    assert!(uuid::Uuid::parse_str(envelope["requestId"].as_str().unwrap()).is_ok());
    envelope["error"]["code"].as_str().unwrap().to_owned()
}

#[test]
fn missing_instance_is_actionable_for_doctor_and_queries() {
    for command in ["doctor", "status"] {
        let output = run(&["--json", command]);
        assert_eq!(error_code(&output), "INSTANCE_REQUIRED");
        assert!(String::from_utf8_lossy(&output.stdout).contains("--instance"));
    }
}

#[test]
fn invalid_arguments_and_writes_are_rejected_as_json() {
    for args in [
        vec!["--json", "apply"],
        vec!["--json", "request", "--method", "sync"],
        vec!["--json", "configs", "get"],
        vec!["--json", "configs", "find", "--limit", "0"],
        vec!["--json", "configs", "find", "--limit", "101"],
        vec!["--json", "configs", "find", "--offset", "-1"],
        vec!["--json", "configs", "find", "--revision", "abc"],
    ] {
        assert_eq!(error_code(&run(&args)), "INVALID_ARGUMENT");
    }
}

#[test]
fn missing_input_has_nonzero_structured_error() {
    let path = std::env::temp_dir().join(format!(
        "diytools-agent-missing-{}.json",
        uuid::Uuid::new_v4()
    ));
    let output = run(&[
        "--json",
        "--instance",
        "desktop-123",
        "request",
        "--method",
        "status",
        "--input",
        path.to_str().unwrap(),
    ]);
    assert_eq!(error_code(&output), "INPUT_READ_FAILED");
}

#[test]
fn pagination_requires_snapshot_revision_before_connecting() {
    let output = run(&[
        "--json",
        "--instance",
        "desktop-123",
        "configs",
        "find",
        "--offset",
        "20",
    ]);
    assert_eq!(error_code(&output), "INVALID_ARGUMENT");
    assert!(String::from_utf8_lossy(&output.stdout).contains("--revision"));
}

#[test]
fn malformed_and_nonobject_inputs_never_connect() {
    for (content, expected) in [
        ("{", "INVALID_JSON"),
        ("[]", "INVALID_INPUT"),
        ("null", "INVALID_INPUT"),
    ] {
        let path = fixture_path();
        std::fs::write(&path, content).unwrap();
        let output = run(&[
            "--json",
            "--instance",
            "desktop-123",
            "request",
            "--method",
            "status",
            "--input",
            path.to_str().unwrap(),
        ]);
        // 夹具留在隔离 sandbox，验证收尾统一移入回收站。
        assert_eq!(error_code(&output), expected);
    }
}

#[test]
fn help_remains_readable_and_successful() {
    let output = run(&["--json", "--help"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Usage:"));
}

#[test]
fn jobs_require_exactly_one_identifier_and_write_commands_require_valid_uuid() {
    let id = "a1234567-1234-4234-8234-123456789abc";
    for args in [
        vec!["jobs", "status"],
        vec!["jobs", "status", "--job-id", "job", "--operation-id", id],
        vec!["jobs", "status", "--operation-id", "bad"],
        vec![
            "changes",
            "preview",
            "--input",
            "x.json",
            "--operation-id",
            "bad",
        ],
        vec!["changes", "apply", "--plan-id", "plan"],
        vec![
            "changes",
            "apply",
            "--plan-id",
            "plan",
            "--operation-id",
            "bad",
        ],
        vec!["export", "--input", "x.json"],
        vec!["sync", "run"],
        vec!["sync", "run", "--operation-id", "bad"],
        vec!["request", "--method", "changes.apply"],
        vec!["request", "--method", "export.start"],
        vec!["request", "--method", "sync.run"],
    ] {
        assert_eq!(error_code(&run(&args)), "INVALID_ARGUMENT");
    }
}

#[cfg(windows)]
#[test]
fn real_pipe_accepts_jobs_without_waiting_and_preserves_operation_identity() {
    use diytools_agent_core::{transport, Response};
    use serde_json::json;
    use std::sync::Arc;
    let instance = format!("cli-jobs-{}", std::process::id());
    let server=transport::serve(&instance,Arc::new(|request|Response::success(&request,json!({"jobId":"job-1","status":"queued","method":request.method,"received":request.params})))).unwrap();
    let operation = "A1234567-1234-4234-8234-123456789ABC";
    let canonical = operation.to_lowercase();
    for (args, method) in [
        (
            vec![
                "changes",
                "apply",
                "--plan-id",
                "saved-plan",
                "--operation-id",
                operation,
            ],
            "changes.apply",
        ),
        (vec!["sync", "run", "--operation-id", operation], "sync.run"),
        (
            vec!["jobs", "status", "--operation-id", operation],
            "jobs.status",
        ),
    ] {
        let start = std::time::Instant::now();
        let mut all = vec!["--json", "--instance", &instance];
        all.extend(args);
        let output = run(&all);
        assert!(output.status.success());
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["data"]["method"], method);
        assert_eq!(envelope["data"]["status"], "queued");
        assert_eq!(envelope["data"]["received"]["operationId"], canonical);
    }
    drop(server);
}

#[cfg(windows)]
#[test]
fn file_requests_wrap_preview_and_merge_export_without_raw_write_escape() {
    use diytools_agent_core::{transport, Response};
    use serde_json::json;
    use std::sync::Arc;
    let instance = format!("cli-input-{}", std::process::id());
    let server = transport::serve(
        &instance,
        Arc::new(|request| {
            Response::success(
                &request,
                json!({"method":request.method,"received":request.params}),
            )
        }),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!("cli-job-input-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(
        &path,
        r#"{"shopId":"intel","targets":[],"action":{"type":"quantity","quantity":2}}"#,
    )
    .unwrap();
    let output = run(&[
        "--json",
        "--instance",
        &instance,
        "changes",
        "preview",
        "--input",
        path.to_str().unwrap(),
    ]);
    assert!(output.status.success());
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["data"]["method"], "changes.preview");
    assert_eq!(envelope["data"]["received"]["request"]["shopId"], "intel");
    assert!(uuid::Uuid::parse_str(
        envelope["data"]["received"]["operationId"]
            .as_str()
            .unwrap()
    )
    .is_ok());
    let operation = "a1234567-1234-4234-8234-123456789abc";
    std::fs::write(
        &path,
        r#"{"configIds":["a"],"revision":42,"images":"both","report":true,"outputDir":"C:\\out"}"#,
    )
    .unwrap();
    let args = [
        "--json",
        "--instance",
        &instance,
        "export",
        "--input",
        path.to_str().unwrap(),
        "--operation-id",
        operation,
    ];
    let output = run(&args);
    assert!(output.status.success());
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["data"]["method"], "export.start");
    assert_eq!(envelope["data"]["received"]["operationId"], operation);
    std::fs::write(&path, r#"{"operationId":"hidden"}"#).unwrap();
    assert_eq!(error_code(&run(&args)), "INVALID_INPUT");
    std::fs::remove_file(path).unwrap();
    drop(server);
}

#[test]
fn oversized_input_is_rejected_before_json_parsing_or_connecting() {
    let path = fixture_path();
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(diytools_agent_core::MAX_FRAME_BYTES as u64 + 1)
        .unwrap();
    drop(file);
    let output = run(&[
        "--json",
        "--instance",
        "desktop-123",
        "request",
        "--method",
        "status",
        "--input",
        path.to_str().unwrap(),
    ]);
    assert_eq!(error_code(&output), "INPUT_TOO_LARGE");
}

#[cfg(windows)]
#[test]
fn doctor_reports_only_advertised_capabilities() {
    use diytools_agent_core::{transport, Response};
    use serde_json::json;
    use std::sync::Arc;
    for (suffix, capabilities, writes, sync) in [
        ("read", json!(["status", "jobs.status"]), false, false),
        (
            "write",
            json!(["status", "changes.apply", "sync.run"]),
            true,
            true,
        ),
    ] {
        let instance = format!("cli-doctor-{}-{suffix}", std::process::id());
        let server = transport::serve(
            &instance,
            Arc::new(move |request| {
                Response::success(&request, json!({"capabilities":capabilities}))
            }),
        )
        .unwrap();
        let output = run(&["--json", "--instance", &instance, "doctor"]);
        assert!(output.status.success());
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["data"]["writesSupported"], writes);
        assert_eq!(envelope["data"]["syncSupported"], sync);
        drop(server);
    }
}
