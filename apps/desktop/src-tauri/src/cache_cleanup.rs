// 手动清理只接收程序自己推导的路径：历史安装包进回收站，浏览器仅清纯缓存。
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub recycled_files: usize,
    pub recycled_bytes: u64,
    pub matching_files: usize,
    pub matching_bytes: u64,
    pub retained: usize,
    pub browser_cache_cleared: bool,
    pub warnings: Vec<String>,
}
fn plain(path: &Path) -> bool {
    path.ancestors().all(|p| {
        fs::symlink_metadata(p).is_ok_and(|m| {
            if m.file_type().is_symlink() {
                return false;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return false;
                }
            }
            true
        })
    })
}
fn json(path: &Path) -> Option<serde_json::Value> {
    if !plain(path) || fs::metadata(path).ok()?.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn version(dir: &Path, status: &serde_json::Value) -> Option<semver::Version> {
    let value = if let Some(value) = status["version"].as_str() {
        value.to_owned()
    } else {
        let plan = json(&dir.join("plan.json"))?;
        let payload = STANDARD
            .decode(plan["envelope"]["payload"].as_str()?)
            .ok()?;
        serde_json::from_slice::<serde_json::Value>(&payload).ok()?["version"]
            .as_str()?
            .to_owned()
    };
    semver::Version::parse(&value).ok()
}
// 不遍历 data/WebView2；保留当前版本、待安装、阶段未知及最新回滚目录的安装包。
pub fn recycle_old_packages(
    root: &Path,
    current: &str,
    pending: Option<&Path>,
    mut recycle: impl FnMut(&Path) -> Result<(), String>,
) -> Result<CleanupReport, String> {
    let mut report = CleanupReport::default();
    if !root.is_absolute() || !plain(root) {
        return Err("程序目录无效，未清理任何文件。".into());
    }
    let updates = root.join(".updates");
    if !updates.exists() {
        return Ok(report);
    }
    if !plain(&updates) {
        return Err("更新缓存目录含链接，未执行清理。".into());
    }
    let current = semver::Version::parse(current).map_err(|_| "当前程序版本无效")?;
    let dirs = fs::read_dir(&updates)
        .map_err(|_| "无法读取更新缓存目录")?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect::<Vec<PathBuf>>();
    let latest = dirs
        .iter()
        .filter(|p| {
            plain(p)
                && p.join("backup.exe").is_file()
                && json(&p.join("status.json")).is_some_and(|s| s["phase"] == "installed")
        })
        .max_by_key(|p| {
            fs::metadata(p.join("status.json"))
                .and_then(|m| m.modified())
                .ok()
        })
        .cloned();
    for dir in dirs {
        let package = dir.join("artifact.exe");
        if !package.exists() {
            continue;
        }
        let eligible = (|| {
            if !plain(&dir)
                || !plain(&package)
                || !fs::metadata(&package).ok()?.is_file()
                || pending == Some(dir.as_path())
                || latest.as_ref() == Some(&dir)
            {
                return None;
            }
            let status = json(&dir.join("status.json"))?;
            if !matches!(
                status["phase"].as_str(),
                Some("installed" | "download-failed")
            ) {
                return None;
            }
            if version(&dir, &status)? >= current {
                return None;
            }
            // 仅固定文件名，调用回收站前再次核对其父目录边界和文件类型。
            if package.parent()?.parent() != Some(updates.as_path()) {
                return None;
            }
            Some(fs::metadata(&package).ok()?.len())
        })();
        if let Some(bytes) = eligible {
            match recycle(&package) {
                Ok(()) => {
                    report.recycled_files += 1;
                    report.recycled_bytes += bytes;
                }
                Err(_) => report
                    .warnings
                    .push("有旧安装包无法移入回收站，已保留；请手动检查后再清理。".into()),
            }
        } else {
            report.retained += 1;
        }
    }
    Ok(report)
}

// 只读取固定回执目录的直接子文件；格式、阶段或写入结果不明时保留原件。
pub fn matching_receipts(data: &Path, report: &mut CleanupReport,
    mut recycle: impl FnMut(&Path) -> Result<(), String>) -> Result<(), String> {
    let dir = data.join("runtime/erp-matching");
    if !dir.exists() || !plain(&dir) { return Ok(()); }
    for entry in fs::read_dir(&dir).map_err(|_| "无法读取本机 ERP 回执目录")? {
        let entry = entry.map_err(|_| "无法检查本机 ERP 回执文件")?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {continue};
        if !name.starts_with("job-") || !name.ends_with(".json") || !plain(&path) {continue;}
        let meta = fs::symlink_metadata(&path).map_err(|_| "无法检查本机 ERP 回执")?;
        if !meta.is_file() || meta.len() > 32 * 1024 * 1024 {continue;}
        let Some(job) = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else {continue};
        if !matches!(job["phase"].as_str(), Some("done" | "failed" | "stopped" | "preview")) {continue;}
        if !job["items"].as_array().is_some_and(|items| items.iter().all(|item|
            item.is_object() && item["pendingStep"].is_null() && item["state"] != "needs_review")) {continue;}
        match recycle(&path) {
            Ok(()) => {
                report.matching_files += 1;
                report.matching_bytes += meta.len();
                report.recycled_files += 1;
                report.recycled_bytes += meta.len();
            },
            Err(_) => report.warnings.push("有 ERP 匹配回执无法移入回收站，已保留。".into())
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{System::Com::*, UI::Shell::*},
        core::PCWSTR,
    };
    // RECYCLEONDELETE 明确要求进入回收站；失败不退回永久删除。
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let outcome = (|| -> windows::core::Result<()> {
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            operation.SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD
                    | FOF_SILENT
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI,
            )?;
            let name = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_ABORT,
                ));
            }
            Ok(())
        })();
        if initialized {
            CoUninitialize();
        }
        outcome.map_err(|_| "无法移入回收站".to_owned())
    }
}

#[cfg(windows)]
pub fn clear_browser(window: tauri::WebviewWindow) -> Result<(), String> {
    use std::{sync::mpsc, time::Duration};
    use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::*};
    use windows::core::Interface;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let callback_tx = tx.clone();
            let start = (|| -> windows::core::Result<()> {
                unsafe {
                    let profile = wv
                        .controller()
                        .CoreWebView2()?
                        .cast::<ICoreWebView2_13>()?
                        .Profile()?
                        .cast::<ICoreWebView2Profile2>()?;
                    let handler =
                        ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                            let _ =
                                callback_tx.send(status.map_err(|_| {
                                    "浏览器缓存清理失败，登录与草稿仍保留。".to_owned()
                                }));
                            Ok(())
                        }));
                    profile.ClearBrowsingData(
                        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
                            | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
                        &handler,
                    )
                }
            })();
            if start.is_err() {
                let _ = tx.send(Err(
                    "当前 WebView2 不支持安全缓存清理，已保留浏览器数据。".into()
                ));
            }
        })
        .map_err(|_| "无法调度浏览器缓存清理")?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "浏览器缓存清理尚未确认完成，未清除登录与草稿。")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_finished_matching_receipts_without_pending_writes_are_recycled() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join("runtime/erp-matching");
        fs::create_dir_all(&dir).unwrap();
        let mut sizes = 0;
        for phase in ["done","failed","stopped","preview","previewing","running","recovering","stopping","needs_review","future"] {
            let bytes = serde_json::to_vec(&serde_json::json!({"phase":phase,"items":[{"state":"verified","pendingStep":null}]})).unwrap();
            fs::write(dir.join(format!("job-{phase}.json")),&bytes).unwrap();
            if matches!(phase,"done" | "failed" | "stopped" | "preview") {sizes += bytes.len() as u64;}
        }
        for (name,text) in [
            ("job-pending.json",r#"{"phase":"done","items":[{"pendingStep":{"operation":"bind"}}]}"#),
            ("job-corrupt.json","{"),
            ("job-unknown-items.json",r#"{"phase":"done"}"#),
            ("job-bad-item.json",r#"{"phase":"done","items":[null]}"#),
            ("job-review.json",r#"{"phase":"failed","items":[{"state":"needs_review"}]}"#),
            ("operation.lock","0"),("job-abc.tmp","{}")
        ] {fs::write(dir.join(name),text).unwrap();}
        let mut names=Vec::new();
        let mut report=CleanupReport::default();
        matching_receipts(data.path(),&mut report,|p|{names.push(p.file_name().unwrap().to_str().unwrap().to_owned());Ok(())}).unwrap();
        names.sort();
        assert_eq!(names,["job-done.json","job-failed.json","job-preview.json","job-stopped.json"]);
        assert_eq!((report.recycled_files,report.matching_files,report.matching_bytes,report.recycled_bytes),(4,4,sizes,sizes));
    }
    #[test]
    fn only_old_terminal_packages_are_recycled() {
        let root = std::env::temp_dir().join(format!("cache-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".updates")).unwrap();
        for (name, ver, phase) in [
            ("old", "0.2.50", "installed"),
            ("current", "0.2.53", "installed"),
            ("pending", "0.2.49", "installed"),
            ("unknown", "0.2.48", "installing"),
            ("failed", "0.2.51", "download-failed"),
        ] {
            let dir = root.join(".updates").join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("artifact.exe"), b"package").unwrap();
            fs::write(
                dir.join("status.json"),
                serde_json::to_vec(&serde_json::json!({"version":ver,"phase":phase})).unwrap(),
            )
            .unwrap();
        }
        for name in [
            "data/runtime/erp-adapter.py",
            "data/integrations.json",
            "data/sql-credentials.dpapi",
            "data/session",
            "WebView2/EBWebView/Default/Cookies",
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"protected").unwrap();
        }
        let mut calls = vec![];
        let pending = root.join(".updates/pending");
        let report = recycle_old_packages(&root, "0.2.53", Some(&pending), |p| {
            calls.push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(report.recycled_files, 2);
        assert_eq!(report.recycled_bytes, 14);
        assert_eq!(report.retained, 3);
        assert!(
            calls
                .iter()
                .all(|p| p.ends_with("old/artifact.exe") || p.ends_with("failed/artifact.exe"))
        );
        assert_eq!(
            fs::read(root.join("data/runtime/erp-adapter.py")).unwrap(),
            b"protected"
        );
        let failed = recycle_old_packages(&root, "0.2.53", Some(&pending), |_| {
            Err("no recycle bin".into())
        })
        .unwrap();
        assert_eq!(failed.recycled_files, 0);
        assert_eq!(failed.warnings.len(), 2);
        // 单测保留系统临时目录，由系统回收；不对真实安装路径执行删除。
    }
    #[test]
    fn signed_plan_version_and_latest_rollback_are_preserved() {
        let root = std::env::temp_dir().join(format!("cache-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".updates")).unwrap();
        for (name, version) in [
            ("historical", "0.2.49"),
            ("rollback", "0.2.50"),
            ("current", "0.2.53"),
            ("future", "0.2.54"),
        ] {
            let dir = root.join(".updates").join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("artifact.exe"), b"package").unwrap();
            fs::write(dir.join("status.json"), br#"{"phase":"installed"}"#).unwrap();
            let payload = STANDARD
                .encode(serde_json::to_vec(&serde_json::json!({"version":version})).unwrap());
            fs::write(
                dir.join("plan.json"),
                serde_json::to_vec(&serde_json::json!({"envelope":{"payload":payload}})).unwrap(),
            )
            .unwrap();
        }
        fs::write(root.join(".updates/rollback/backup.exe"), b"rollback").unwrap();
        let report = recycle_old_packages(&root, "0.2.53", None, |path| {
            assert!(path.ends_with("historical/artifact.exe"));
            Ok(())
        })
        .unwrap();
        assert_eq!(report.recycled_files, 1);
        assert_eq!(report.retained, 3);
        assert!(
            recycle_old_packages(Path::new("relative"), "0.2.53", None, |_| panic!(
                "不能触及相对路径"
            ))
            .is_err()
        );
    }
}
