//! 只清理已成功更新的历史目录；最新回退材料、未知及失败状态均保留。
use super::{plain_path, read_bounded};
use std::{fs, path::Path};
static CLEANUP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn json(path: &Path) -> Option<serde_json::Value> {
    plain_path(path).ok()?;
    let bytes = read_bounded(fs::File::open(path).ok()?, 16384).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// 先检查整棵树，拒绝目录联接、符号链接及其他特殊文件。
fn check_tree(path: &Path) -> Result<(), String> {
    plain_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            check_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    } else if !metadata.is_file() {
        return Err("更新目录含特殊文件".into());
    }
    Ok(())
}

pub(super) fn run(root: &Path) {
    if let Err(error) = cleanup(root) {
        eprintln!("历史更新清理未完成，将在下次启动重试：{error}");
    }
}

fn candidates(root: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let updates = root.join(".updates");
    if !updates.exists() {
        return Ok(Vec::new());
    }
    plain_path(&updates)?;
    let updates = updates.canonicalize().map_err(|e| e.to_string())?;
    let mut installed = Vec::new();
    for entry in fs::read_dir(&updates).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .file_name()
            .to_str()
            .and_then(|n| uuid::Uuid::parse_str(n).ok())
            .is_none()
        {
            continue;
        }
        let path = entry.path();
        let Some(status) = json(&path.join("status.json")) else {
            continue;
        };
        if status["phase"] != "installed" {
            continue;
        }
        let Some(at) = status["at"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        else {
            continue;
        };
        installed.push((at, path));
    }
    installed.sort_by(|a, b| b.0.cmp(&a.0));
    let Some((latest_at, latest)) = installed.first() else {
        return Ok(Vec::new());
    };
    // 最新成功记录缺少完整回退材料时不删除任何旧备份。
    check_tree(latest)?;
    if !latest.join("backup.exe").is_file()
        || json(&latest.join("database-backup/manifest.json"))
            .is_none_or(|v| v["schema"] != 1 || v["complete"] != true || !v["files"].is_array())
    {
        return Err("最新更新的回退材料不完整".into());
    }
    let manifest = json(&latest.join("database-backup/manifest.json")).ok_or("回退清单不可读")?;
    for item in manifest["files"].as_array().ok_or("回退清单无效")? {
        let name = item[0].as_str().ok_or("回退文件名无效")?;
        if !matches!(
            name,
            "workbench.sqlite" | "refactor.sqlite" | "migration.sqlite"
        ) || !latest.join("database-backup").join(name).is_file()
        {
            return Err("最新更新的回退数据库缺失".into());
        }
    }
    Ok(installed
        .iter()
        .skip(1)
        .filter(|(at, _)| at < latest_at)
        .map(|(_, path)| path.clone())
        .collect())
}

fn tree_bytes(path: &Path) -> Result<u64, String> {
    check_tree(path)?;
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    let mut bytes = 0;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        bytes += tree_bytes(&entry.map_err(|e| e.to_string())?.path())?;
    }
    Ok(bytes)
}

fn cleanup(root: &Path) -> Result<(), String> {
    execute(root).map(|_| ())
}

fn execute(root: &Path) -> Result<serde_json::Value, String> {
    let _guard = CLEANUP_LOCK.lock().map_err(|e| e.to_string())?;
    let paths = candidates(root)?;
    let mut count = 0;
    let mut bytes = 0;
    let mut errors = Vec::new();
    for path in &paths {
        let result = (|| {
            let size = tree_bytes(path)?;
            let updates = root
                .join(".updates")
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let resolved = path.canonicalize().map_err(|e| e.to_string())?;
            if resolved.parent() != Some(updates.as_path()) {
                return Err("历史更新路径越界".into());
            }
            // 用户明确授权直接清理过期更新目录，不经过回收站。
            // 状态文件最后删除，文件占用造成部分清理时下次仍能识别并重试。
            for entry in fs::read_dir(&resolved).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_name() == "status.json" {
                    continue;
                }
                let path = entry.path();
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    fs::remove_dir_all(path).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            }
            fs::remove_file(resolved.join("status.json")).map_err(|e| e.to_string())?;
            fs::remove_dir(&resolved).map_err(|e| e.to_string())?;
            count += 1;
            bytes += size;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(serde_json::json!({"count":count,"bytes":bytes}))
    } else {
        Err(format!(
            "已清理 {count} 个历史更新目录（{bytes} 字节），其余未完成：{}",
            errors.join("; ")
        ))
    }
}

// 从当前业务库的标准便携布局定位更新目录，不接受前端提供任意路径。
pub(crate) fn cache_category(database: &Path, clear: bool) -> Result<serde_json::Value, String> {
    let mut result = serde_json::json!({"id":"update-backups","label":"历史更新备份","count":0,"bytes":0,
        "storageEffect":"disk-reclaimed","rebuildOnDemand":false});
    let Some(data) = database
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "data"))
    else {
        return Ok(result);
    };
    let Some(root) = data.parent() else {
        return Ok(result);
    };
    if super::portable_marker(root).is_err() {
        return Ok(result);
    }
    plain_path(data)?;
    if clear {
        let cleared = execute(root)?;
        result["count"] = cleared["count"].clone();
        result["bytes"] = cleared["bytes"].clone();
    } else {
        let _guard = CLEANUP_LOCK.lock().map_err(|e| e.to_string())?;
        let paths = candidates(root)?;
        let mut bytes = 0;
        for path in &paths {
            bytes += tree_bytes(path)?;
        }
        result["count"] = paths.len().into();
        result["bytes"] = bytes.into();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stage(root: &Path, phase: &str, day: u8) -> std::path::PathBuf {
        let dir = root.join(".updates").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(dir.join("database-backup")).unwrap();
        fs::write(dir.join("backup.exe"), b"rollback").unwrap();
        fs::write(
            dir.join("database-backup/manifest.json"),
            br#"{"schema":1,"complete":true,"files":[]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("status.json"),
            serde_json::to_vec(
                &serde_json::json!({"phase":phase,"at":format!("2026-10-{day:02}T00:00:00Z")}),
            )
            .unwrap(),
        )
        .unwrap();
        dir
    }
    #[test]
    fn retains_latest_and_unconfirmed_and_business_data() {
        let root = super::super::tests::fixture();
        let old = stage(&root, "installed", 10);
        let latest = stage(&root, "installed", 12);
        let failed = stage(&root, "failed", 13);
        let unknown = stage(&root, "started-unconfirmed", 14);
        fs::create_dir(root.join("data")).unwrap();
        fs::write(root.join("data/workbench.sqlite"), b"business").unwrap();
        cleanup(&root).unwrap();
        cleanup(&root).unwrap();
        assert!(!old.exists());
        for path in [latest, failed, unknown] {
            assert_eq!(fs::read(path.join("backup.exe")).unwrap(), b"rollback");
        }
        assert_eq!(
            fs::read(root.join("data/workbench.sqlite")).unwrap(),
            b"business"
        );
    }
    #[test]
    fn incomplete_latest_preserves_older_backup() {
        let root = super::super::tests::fixture();
        let old = stage(&root, "installed", 10);
        let latest = stage(&root, "installed", 12);
        fs::write(latest.join("database-backup/manifest.json"), b"{}").unwrap();
        assert!(cleanup(&root).is_err());
        assert!(old.join("backup.exe").exists());
    }
    #[test]
    fn missing_snapshot_preserves_older_backup() {
        let root = super::super::tests::fixture();
        let old = stage(&root, "installed", 10);
        let latest = stage(&root, "installed", 12);
        fs::write(
            latest.join("database-backup/manifest.json"),
            br#"{"schema":1,"complete":true,"files":[["workbench.sqlite","hash"]]}"#,
        )
        .unwrap();
        assert!(cleanup(&root).is_err());
        assert!(old.exists());
    }
    #[cfg(windows)]
    #[test]
    fn locked_backup_is_retried_without_losing_status() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = super::super::tests::fixture();
        let old = stage(&root, "installed", 10);
        let latest = stage(&root, "installed", 12);
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(old.join("backup.exe"))
            .unwrap();
        assert!(cleanup(&root).is_err());
        assert!(old.join("status.json").exists());
        assert!(latest.join("backup.exe").exists());
        drop(locked);
        cleanup(&root).unwrap();
        assert!(!old.exists());
    }
    #[cfg(windows)]
    #[test]
    fn junction_in_old_directory_preserves_external_files() {
        let root = super::super::tests::fixture();
        let old = stage(&root, "installed", 10);
        stage(&root, "installed", 12);
        let external = root.join("data");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("protected"), b"business").unwrap();
        let output = std::process::Command::new("pwsh.exe")
            .args([
                "-NoProfile",
                "-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:DIYTOOLS_TEST_LINK -Target $env:DIYTOOLS_TEST_TARGET | Out-Null",
            ])
            .env("DIYTOOLS_TEST_LINK", old.join("link"))
            .env("DIYTOOLS_TEST_TARGET", &external)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(cleanup(&root).is_err());
        assert!(old.join("backup.exe").exists());
        assert_eq!(fs::read(external.join("protected")).unwrap(), b"business");
    }
}
