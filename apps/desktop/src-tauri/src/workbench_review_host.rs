// 开发验证用标准输入输出宿主，调用真实 Rust 存储逻辑；不创建 WebView 或操作用户窗口。
//! Development-only stdio adapter for exercising the real Rust store from browser tests.
use crate::workbench_store;
use std::io::{BufRead, Write};

// 逐行处理测试请求并输出对应回执，用于隔离验证真实存储而无需桌面操作。
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox");
    let initialize_workbench = std::env::args().nth(1).as_deref() == Some("--initialize-workbench");
    let review = if initialize_workbench {
        root.clone()
    } else if let Some(directory) = std::env::var_os("DIYTOOLS_REVIEW_DIRECTORY") {
        let directory = std::path::PathBuf::from(directory).canonicalize()?;
        let sandbox = root.canonicalize()?;
        if directory == sandbox || !directory.starts_with(&sandbox) || !directory.is_dir() {
            return Err(
                "Review directory must be an existing isolated directory inside sandbox".into(),
            );
        }
        directory
    } else {
        root.join("validation/workbench-ui")
    };
    let assets = if review.join("workbench-assets").is_dir() {
        review.join("workbench-assets")
    } else {
        root.join("workbench-assets")
    };
    let store = workbench_store::initialize(
        &review.join("workbench.sqlite"),
        &root.join("migration-review/20261011/source-state.json"),
        &assets,
    )
    .map_err(std::io::Error::other)?;
    if initialize_workbench {
        return Ok(());
    }
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout());
    for line in stdin.lock().lines() {
        let line = line?;
        let input: serde_json::Value = serde_json::from_str(&line)?;
        // Development-only local checkpoint probe; no transport, member login or
        // network. The directory gate above prevents using a production store.
        let result = match input["probe"].as_str() {
            Some("cloud-load") => workbench_store::cloud_checkpoint_load(&store),
            Some("cloud-commit") => workbench_store::cloud_checkpoint_commit(&store, &input["payload"]),
            Some("cloud-status") => workbench_store::cloud_checkpoint_status(&store).map(|value| workbench_store::ApiResponse { status: 200, body: value.to_string() }),
            Some(_) => Err("Unknown isolated probe".to_string()),
            None => workbench_store::request(
                &store,
                input["method"].as_str().unwrap_or("GET"),
                input["path"].as_str().unwrap_or("/"),
                input["body"].as_str(),
            ),
        };
        let output = match result {
            Ok(value) => serde_json::to_value(value)?,
            Err(error) => {
                serde_json::json!({"status":500,"body":serde_json::json!({"error":error}).to_string()})
            }
        };
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
