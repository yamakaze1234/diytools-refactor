//! 本机历史按创建时间保留七天；命名快照独立恢复，文件回收失败可重试。
use super::*;

pub(super) const KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const CHECK_MS: i64 = 60 * 60 * 1000;

pub(super) fn schema(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS workbench_named_snapshots(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL,hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_history_retention(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_recovery_recycle(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL);")
        .map_err(|e| e.to_string())
}

fn digest(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

pub(super) fn save_snapshot(c: &Connection, id: &str, value: &Value) -> Result<()> {
    validate(value)?;
    let raw = value.to_string();
    c.execute(
        "INSERT INTO workbench_named_snapshots VALUES(?1,?2,?3,?4)",
        params![id, revision(value), raw, digest(&raw)],
    )
    .map_err(|e| e.to_string())?;
    // 从数据库重新读取并比较，校验通过才允许删除旧差异链。
    if snapshot(c, id)?.as_ref() != Some(value) {
        return Err("命名版本快照校验失败，未清理历史".into());
    }
    Ok(())
}

fn snapshot(c: &Connection, id: &str) -> Result<Option<Value>> {
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT document,hash FROM workbench_named_snapshots WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|(raw, hash)| {
        if digest(&raw) != hash {
            return Err("命名版本快照校验失败".into());
        }
        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        validate(&value)?;
        Ok(value)
    })
    .transpose()
}

pub(super) fn version(c: &Connection, id: &str) -> Result<Value> {
    let sequence = version_sequence(c, id)?;
    if id.starts_with("named-") {
        if let Some(value) = snapshot(c, id)? {
            return Ok(value);
        }
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workbench_history WHERE sequence=?1)",
            [sequence],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("命名版本所需历史缺失，无法建立快照".into());
    }
    reconstruct(c, sequence)
}

fn saved(c: &Connection) -> Result<Value> {
    let raw: Option<String> = c
        .query_row(
            "SELECT document FROM workbench_history_retention WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
        .unwrap_or(Ok(json!({})))
}

fn save_status(c: &Connection, value: &Value) -> Result<()> {
    c.execute("INSERT INTO workbench_history_retention VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", [value.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(super) fn status(store: &WorkbenchStore, c: &Connection) -> Result<Value> {
    let mut result = saved(c)?;
    // 状态面板只读计数和页信息，避免每次打开都扫描数 GiB 的历史正文。
    let count: i64 = c
        .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let named: i64 = c
        .query_row(
            "SELECT count(*) FROM workbench_named_versions WHERE deleted=0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let pending: i64 = c
        .query_row("SELECT count(*) FROM workbench_recovery_recycle", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let pages: i64 = c
        .pragma_query_value(None, "freelist_count", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: i64 = c
        .pragma_query_value(None, "page_size", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    result["count"] = json!(count);
    result["named"] = json!(named);
    result["liveBytes"] = Value::Null;
    result["bytes"] = json!(fs::metadata(&store.path).map(|m| m.len()).unwrap_or(0));
    result["walBytes"] = json!(
        fs::metadata(format!("{}-wal", store.path.display()))
            .map(|m| m.len())
            .unwrap_or(0)
    );
    result["reusableBytes"] = json!(pages * page_size);
    result["pendingFiles"] = json!(pending);
    result["pending"] = json!(pending > 0 || result["phase"] == "files-pending");
    result["retentionDays"] = json!(7);
    result["retentionMillis"] = json!(KEEP_MS);
    result["automaticCleanup"] = json!(true);
    result["cleanupAvailable"] = json!(false);
    result["scope"] = json!("all-local-shops");
    Ok(result)
}

fn millis(at: &str) -> Result<i64> {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|v| v.timestamp_millis())
        .map_err(|_| format!("记录创建时间无效：{at}；未清理历史"))
}

fn stamp(at: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or("维护时间无效".into())
}

// 只接受程序自身生成的文件名，拒绝目录跳转、链接及不明文件。
fn draft_path(store: &WorkbenchStore, name: &str) -> Result<PathBuf> {
    let id = name
        .strip_prefix("draft-")
        .and_then(|v| v.strip_suffix(".json"))
        .ok_or("恢复文件名无效")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("恢复文件名无效".into());
    }
    let root = store
        .path
        .parent()
        .ok_or("数据目录无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let directory = root.join("workbench-recovery");
    if directory.exists() && directory.canonicalize().map_err(|e| e.to_string())? != directory {
        return Err("恢复草稿目录不能为链接".into());
    }
    let path = directory.join(name);
    if path.exists()
        && (fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
            || path.canonicalize().map_err(|e| e.to_string())? != path)
    {
        return Err("恢复草稿不能为链接".into());
    }
    Ok(path)
}

fn backup(store: &WorkbenchStore) -> Result<PathBuf> {
    let root = store
        .path
        .parent()
        .ok_or("数据目录无效")?
        .join("history-retention-backups");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(format!("before-{}.sqlite", unique()));
    // 调用方已取得写锁。第二个只读连接备份已提交状态，包含 WAL，阻止并发写入。
    let source =
        Connection::open_with_flags(&store.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    source
        .backup("main", &path, None)
        .map_err(|e| format!("首次清理备份失败：{e}"))?;
    let verify = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let health: String = verify
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if health != "ok" {
        return Err("首次清理备份检查失败，未清理".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    write_new(&path.with_extension("json"),json!({"at":now(),"source":store.path,"backup":path,"quickCheck":health,"reason":"before-history-retention"}).to_string().as_bytes())?;
    Ok(path)
}

// 数据库删除和文件回收队列同事务提交；任何 SQL 错误都保留全部原记录/原文件。
fn clean(tx: &Transaction, store: &WorkbenchStore, at: i64) -> Result<Value> {
    let cutoff = at.checked_sub(KEEP_MS).ok_or("维护时间无效")?;
    let history: Vec<(i64, String)> = tx
        .prepare("SELECT sequence,at FROM workbench_history ORDER BY sequence")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut expired = Vec::new();
    let mut retained = false;
    for (seq, time) in history {
        if millis(&time)? < cutoff {
            // 系统时钟回退可能造成链中间过期。宁可报错保留，也不能破坏七天内恢复链。
            if retained {
                return Err("历史时间顺序异常，已暂停清理以保留恢复链".into());
            }
            expired.push(seq);
        } else {
            retained = true;
        }
    }
    let recoveries: Vec<(String, String)> = tx
        .prepare("SELECT id,at FROM workbench_recovery")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut registered = HashSet::new();
    let mut drafts = Vec::new();
    let mut files = HashMap::new();
    for (id, time) in recoveries {
        registered.insert(format!("draft-{id}.json"));
        if millis(&time)? < cutoff {
            let name = format!("draft-{id}.json");
            let path = draft_path(store, &name)?;
            if path.exists() {
                files.insert(name, fs::metadata(path).map_err(|e| e.to_string())?.len());
            }
            drafts.push(id);
        }
    }
    let directory = store.path.parent().unwrap().join("workbench-recovery");
    if directory.exists() {
        for item in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if registered.contains(&name) {
                continue;
            }
            // 登记失败时文件仍有 unique() 的创建纳秒时间；不以内容 updatedAt 或可变 mtime 判龄。
            let created = name
                .strip_prefix("draft-")
                .and_then(|v| v.strip_suffix(".json"))
                .and_then(|v| v.split_once('-'))
                .filter(|(pid, _)| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|(_, ns)| ns.parse::<u128>().ok())
                .and_then(|ns| i64::try_from(ns / 1_000_000).ok());
            if created.is_some_and(|time| time > 0 && time < cutoff) {
                let path = draft_path(store, &name)?;
                if !path.is_file() {
                    return Err("恢复目录存在同名非文件，未清理".into());
                }
                files.insert(name, fs::metadata(path).map_err(|e| e.to_string())?.len());
            }
        }
    }
    let mut result = saved(tx)?;
    if result["backup"].is_null() {
        result["backup"] = json!(backup(store)?);
    }
    let named:Vec<(String,i64)>=tx.prepare("SELECT n.id,n.sequence FROM workbench_named_versions n LEFT JOIN workbench_named_snapshots s ON s.id=n.id WHERE n.deleted=0 AND s.id IS NULL").map_err(|e|e.to_string())?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?.collect::<std::result::Result<_,_>>().map_err(|e|e.to_string())?;
    // 多个命名版本共用一次逆向遍历，不重复读取数 GiB 的历史链。
    if let Some(minimum) = named.iter().map(|(_, seq)| *seq).min() {
        let mut remaining: HashMap<i64, Vec<&str>> = HashMap::new();
        for (id, seq) in &named {
            remaining.entry(*seq).or_default().push(id);
        }
        let mut value = state(tx)?;
        let mut query=tx.prepare("SELECT sequence,document FROM workbench_history WHERE sequence>=?1 ORDER BY sequence DESC").map_err(|e|e.to_string())?;
        let mut rows = query.query([minimum]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let sequence: i64 = row.get(0).map_err(|e| e.to_string())?;
            if let Some(ids) = remaining.remove(&sequence) {
                for id in ids {
                    save_snapshot(tx, id, &value)?;
                }
            }
            if sequence > minimum {
                let raw: String = row.get(1).map_err(|e| e.to_string())?;
                let change: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                reverse_change(&mut value, &change)?;
            }
        }
        if !remaining.is_empty() {
            return Err("命名版本所需历史缺失，无法建立快照".into());
        }
    }
    // 已存在的快照也校验，损坏时不继续删除历史。
    let ids: Vec<String> = tx
        .prepare("SELECT id FROM workbench_named_versions WHERE deleted=0")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        snapshot(tx, &id)?.ok_or("命名快照缺失")?;
    }
    let removed = if let Some(max) = expired.last() {
        tx.execute("DELETE FROM workbench_history WHERE sequence<=?1", [max])
            .map_err(|e| e.to_string())?
    } else {
        0
    };
    for id in &drafts {
        tx.execute("DELETE FROM workbench_recovery WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    for (name, bytes) in &files {
        tx.execute(
            "INSERT OR IGNORE INTO workbench_recovery_recycle VALUES(?1,?2)",
            params![name, i64::try_from(*bytes).map_err(|_| "恢复文件过大")?],
        )
        .map_err(|e| e.to_string())?;
    }
    result["lastCheckedAt"] = json!(stamp(at)?);
    result["nextCheckAt"] = json!(stamp(at + CHECK_MS)?);
    result["error"] = Value::Null;
    result["phase"] = json!("files-pending");
    result["result"] = json!({"history":removed,"drafts":drafts.len(),"filesQueued":files.len(),"namedMigrated":named.len(),"cutoff":stamp(cutoff)?,"space":"sqlite-reusable"});
    save_status(tx, &result)?;
    Ok(result)
}

fn recycle(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 文件路径通过环境传入，不拼接脚本；只使用回收站，失败不降级永久删除。
        // Shell 回收站不接受 canonicalize 返回的扩展路径前缀；转换后仍指向已核验的同一文件。
        let raw = path.to_string_lossy();
        let shell_path = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()
        };
        let output=std::process::Command::new("pwsh.exe").args(["-NoProfile","-NonInteractive","-Command",
            "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic.Core; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DIYTOOLS_RECYCLE_FILE,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"])
            .env("DIYTOOLS_RECYCLE_FILE",shell_path).creation_flags(0x08000000).output().map_err(|e|format!("无法放入回收站，文件保留：{e}"))?;
        if !output.status.success() {
            return Err("恢复草稿未能移入回收站，待下次重试；没有永久删除".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("此平台尚未接入回收站，草稿文件保留".into())
    }
}

fn finish_files(
    c: &Connection,
    store: &WorkbenchStore,
    recycle_file: &impl Fn(&Path) -> Result<()>,
) -> Result<usize> {
    let names: Vec<String> = c
        .prepare("SELECT name FROM workbench_recovery_recycle ORDER BY name")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for name in &names {
        let path = draft_path(store, name)?;
        if path.exists() {
            recycle_file(&path)?;
            if path.exists() {
                return Err("文件回收未完成，保留待处理记录".into());
            }
        }
        c.execute(
            "DELETE FROM workbench_recovery_recycle WHERE name=?1",
            [name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(names.len())
}

pub(super) fn maintain(store: &WorkbenchStore) -> Result<ApiResponse> {
    maintain_at(store, chrono::Utc::now().timestamp_millis(), &recycle)
}

fn maintain_at(
    store: &WorkbenchStore,
    at: i64,
    recycle_file: &impl Fn(&Path) -> Result<()>,
) -> Result<ApiResponse> {
    static MAINTENANCE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = MAINTENANCE.try_lock() else {
        return Ok(response(200, json!({"skipped":true,"reason":"busy"})));
    };
    let mut c = db(&store.path)?;
    // 正在保存/同步/恢复时立即暂缓，不排队等待占用写锁。
    c.busy_timeout(Duration::ZERO).map_err(|e| e.to_string())?;
    let tx = match c.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(rusqlite::Error::SqliteFailure(e, _))
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            return Ok(response(200, json!({"skipped":true,"reason":"busy"})));
        }
        Err(e) => return Err(e.to_string()),
    };
    let old = saved(&tx)?;
    let pending: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workbench_recovery_recycle)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let unfinished = old["phase"] == "files-pending";
    if !pending
        && !unfinished
        && old["nextCheckAt"]
            .as_str()
            .and_then(|s| millis(s).ok())
            .is_some_and(|next| at < next)
    {
        return Ok(response(
            200,
            json!({"skipped":true,"reason":"not-due","nextCheckAt":old["nextCheckAt"]}),
        ));
    }
    let work = if pending || unfinished {
        Ok(old.clone())
    } else {
        clean(&tx, store, at)
    };
    match work {
        Ok(_) => {
            tx.commit().map_err(|e| e.to_string())?;
        }
        Err(error) => {
            tx.rollback().map_err(|e| e.to_string())?;
            let mut result = old;
            result["error"] = json!(error);
            result["lastCheckedAt"] = json!(stamp(at)?);
            result["nextCheckAt"] = json!(stamp(at + CHECK_MS)?);
            save_status(&c, &result)?;
            return Ok(response(500, json!({"error":error,"status":result})));
        }
    };
    // 文件阶段也持有数据库写锁，另一实例不能同时处理同一回收队列。
    c.busy_timeout(Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    let file_tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut result = saved(&file_tx)?;
    match finish_files(&file_tx, store, recycle_file) {
        Ok(count) => {
            result["phase"] = json!("complete");
            result["lastCleanup"] = json!(stamp(at)?);
            result["error"] = Value::Null;
            result["result"]["filesRecycled"] = json!(count);
        }
        Err(error) => {
            result["error"] = json!(error);
            save_status(&file_tx, &result)?;
            file_tx.commit().map_err(|e| e.to_string())?;
            return Ok(response(500, json!({"error":error,"status":result})));
        }
    }
    result["lastCheckedAt"] = json!(stamp(at)?);
    result["nextCheckAt"] = json!(stamp(at + CHECK_MS)?);
    save_status(&file_tx, &result)?;
    file_tx.commit().map_err(|e| e.to_string())?;
    result["skipped"] = json!(false);
    Ok(response(200, result))
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
