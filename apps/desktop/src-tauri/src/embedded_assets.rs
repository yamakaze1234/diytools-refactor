// 正式包资源入口与无窗口校验探针；资源检查不初始化数据库，也不启动业务窗口。
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;

// 集中生成资源上下文，正式启动和资源探针使用同一份内置资源。
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Read only embedded resources, before Builder/setup/database/window creation.
// 检查正式资源模式、必要页面和文件摘要；只写新报告，不创建窗口或打开业务库。
pub fn run_embedded_asset_probe() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--verify-embedded-assets")) {
        return None;
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let output = args.next().ok_or("missing report path")?;
        if args.next().is_some() { return Err("unexpected probe argument".into()); }
        let context = context();
        let required = ["index.html", "workbench/index.html", "workbench/app.js",
            "workbench/cloud-worker.js", "workbench/cloud-engine.js", "workbench/workspace-sync-ui.js"];
        let mut files = Vec::new();
        for (path, _) in context.assets().iter() {
            let data = context.assets().get(&path.as_ref().into()).ok_or("embedded resource unreadable")?;
            files.push(json!({"path":path, "bytes":data.len(), "sha256":format!("{:x}", Sha256::digest(&data))}));
        }
        files.sort_by(|a,b| a["path"].as_str().cmp(&b["path"].as_str()));
        let required_present = required.iter().all(|path| context.assets().get(&(*path).into()).is_some_and(|data| !data.is_empty()));
        let app_urls = !context.config().app.windows.is_empty() && context.config().app.windows.iter()
            .all(|window| matches!(window.url, tauri::WebviewUrl::App(_)));
        let valid = !tauri::is_dev() && required_present && app_urls;
        let report = json!({"probe":"DIYTOOLS_EMBEDDED_ASSET_PROBE_V1", "status":if valid {"verified"} else {"failed"},
            "developmentMode":tauri::is_dev(), "appWindowUrls":app_urls, "requiredAssetsPresent":required_present,
            "windowCreated":false, "databaseOpened":false, "files":files});
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(output)?;
        file.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
        file.sync_all()?;
        if !valid { return Err("desktop assets are not a standalone production build".into()); }
        Ok(())
    })();
    Some(if result.is_ok() { 0 } else { 1 })
}
