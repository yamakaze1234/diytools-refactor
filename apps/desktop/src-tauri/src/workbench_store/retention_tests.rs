use super::*;

fn fixture() -> WorkbenchStore {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/history-retention-tests")
        .join(unique());
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("seed.json"),json!({"revision":1,"configs":[{"id":"a","shopId":"intel","name":"A","price":10,"actualParts":[]},{"id":"b","shopId":"jonsbo","name":"B","actualParts":[]}],"logs":[],"costSource":[],"unknown":{"precise":1234567890123456789u64}}).to_string()).unwrap();
    initialize(
        &root.join("workbench.sqlite"),
        &root.join("seed.json"),
        &root.join("assets"),
    )
    .unwrap()
}
fn clock() -> i64 {
    millis("2026-11-01T12:00:00.000Z").unwrap()
}
fn call(s: &WorkbenchStore, path: &str, input: Value) -> Value {
    let r = request(s, "POST", path, Some(&input.to_string())).unwrap();
    assert_eq!(r.status, 200, "{}", r.body);
    serde_json::from_str(&r.body).unwrap()
}
fn run(s: &WorkbenchStore, at: i64) -> Value {
    // 隔离样本执行真实删除，验证无需外部 PowerShell 的自动清理路径。
    let r = maintain_at(s, at, &delete_expired_draft).unwrap();
    assert_eq!(r.status, 200, "{}", r.body);
    serde_json::from_str(&r.body).unwrap()
}
fn edit(s: &WorkbenchStore, n: i64) {
    let mut c = db(&s.path).unwrap();
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let before = state(&tx).unwrap();
    let mut after = before.clone();
    after["configs"][0]["price"] = json!(n);
    after["configs"][1]["name"] = json!(format!("B {n}"));
    persist(
        &tx,
        &before,
        &mut after,
        &json!({"message":"retention-test"}),
    )
    .unwrap();
    tx.commit().unwrap();
}
fn age(s: &WorkbenchStore, seq: i64, at: i64) {
    db(&s.path)
        .unwrap()
        .execute(
            "UPDATE workbench_history SET at=?1 WHERE sequence=?2",
            params![stamp(at).unwrap(), seq],
        )
        .unwrap();
}

#[test]
fn boundary_named_migration_restore_restart_and_new_name_after_all_expire() {
    let s = fixture();
    let at = clock();
    let cutoff = at - KEEP_MS;
    let original = state(&db(&s.path).unwrap()).unwrap();
    // 模拟升级前仅含 sequence 的旧命名版本。
    db(&s.path)
        .unwrap()
        .execute(
            "INSERT INTO workbench_named_versions VALUES('named-old',1,'旧命名',?1,0)",
            [stamp(cutoff - 10).unwrap()],
        )
        .unwrap();
    edit(&s, 20);
    edit(&s, 30);
    edit(&s, 40);
    age(&s, 1, cutoff - 100);
    age(&s, 2, cutoff - 1);
    age(&s, 3, cutoff);
    age(&s, 4, cutoff + 1);
    let c = db(&s.path).unwrap();
    let retained = reconstruct(&c, 3).unwrap();
    let current = state(&c).unwrap();
    drop(c);
    let result = run(&s, at);
    assert_eq!(result["result"]["history"], 2);
    assert_eq!(result["result"]["namedMigrated"], 1);
    let c = db(&s.path).unwrap();
    assert_eq!(version(&c, "named-old").unwrap(), original);
    assert_eq!(reconstruct(&c, 3).unwrap(), retained);
    assert_eq!(state(&c).unwrap(), current);
    assert!(version(&c, "v-2").is_err());
    let back = Connection::open(result["backup"].as_str().unwrap()).unwrap();
    assert_eq!(
        back.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    drop(back);
    drop(c);
    let s = initialize(
        &s.path,
        &s.path.with_file_name("missing-seed.json"),
        &s.assets,
    )
    .unwrap();
    assert_eq!(run(&s, at + 1)["reason"], "not-due");
    let preview = call(&s, "/api/versions/preview", json!({"id":"named-old"}));
    call(
        &s,
        "/api/versions/restore",
        json!({"id":"named-old","hash":preview["hash"],"baseRevision":preview["baseRevision"]}),
    );
    let restored = state(&db(&s.path).unwrap()).unwrap();
    assert_eq!(restored["configs"], original["configs"]);
    assert_eq!(restored["unknown"], original["unknown"]);
    let all_past = chrono::Utc::now().timestamp_millis() + KEEP_MS + CHECK_MS;
    run(&s, all_past);
    assert_eq!(
        db(&s.path)
            .unwrap()
            .query_row("SELECT count(*) FROM workbench_history", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let named = call(&s, "/api/versions/name", json!({"name":"无普通历史时命名"}));
    assert_eq!(
        version(&db(&s.path).unwrap(), named["id"].as_str().unwrap()).unwrap(),
        restored
    );
    call(&s, "/api/versions/delete-named", json!({"id":"named-old"}));
    assert!(version(&db(&s.path).unwrap(), "named-old").is_err());
    assert_eq!(
        db(&s.path)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM workbench_named_snapshots WHERE id='named-old'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    edit(&s, 60);
    assert_eq!(
        state(&db(&s.path).unwrap()).unwrap()["configs"][0]["price"],
        60
    );
}

#[test]
fn sql_failure_rolls_back_history_named_migration_and_files_then_retry_succeeds() {
    let s = fixture();
    let at = clock();
    age(&s, 1, at - KEEP_MS - 1);
    let c = db(&s.path).unwrap();
    c.execute("INSERT INTO workbench_named_versions VALUES('named-old',1,'旧版本','2026-10-01T00:00:00Z',0)",[]).unwrap();
    let before = state(&c).unwrap();
    let draft = call(&s, "/api/recovery-draft", json!({"state":before}));
    c.execute(
        "UPDATE workbench_recovery SET at='2026-10-01T00:00:00Z'",
        [],
    )
    .unwrap();
    c.execute_batch("CREATE TRIGGER fail_cleanup BEFORE DELETE ON workbench_recovery BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let r = maintain_at(&s, at, &|_| panic!("SQL failed: must not touch files")).unwrap();
    assert_eq!(r.status, 500);
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_named_snapshots", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert!(Path::new(draft["file"].as_str().unwrap()).exists());
    assert_eq!(state(&c).unwrap(), before);
    assert!(saved(&c).unwrap()["lastCleanup"].is_null());
    assert!(
        saved(&c).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("injected")
    );
    c.execute_batch("DROP TRIGGER fail_cleanup").unwrap();
    drop(c);
    assert_eq!(run(&s, at + CHECK_MS)["result"]["drafts"], 1);
}

#[test]
fn registered_and_orphan_drafts_expire_by_creation_and_recycle_failure_survives_restart() {
    let s = fixture();
    let at = clock();
    let c = db(&s.path).unwrap();
    let state = state(&c).unwrap();
    let draft = call(&s, "/api/recovery-draft", json!({"state":state}));
    c.execute(
        "UPDATE workbench_recovery SET at=?1",
        [stamp(at - KEEP_MS - 1).unwrap()],
    )
    .unwrap();
    let root = s.path.parent().unwrap().join("workbench-recovery");
    let orphan = format!("draft-1-{}.json", (at - KEEP_MS - 1) as u128 * 1_000_000);
    let edge = format!("draft-1-{}.json", (at - KEEP_MS) as u128 * 1_000_000);
    fs::write(root.join(&orphan), "{}").unwrap();
    fs::write(root.join(&edge), "{}").unwrap();
    fs::write(root.join("unknown.json"), "keep").unwrap();
    let r = maintain_at(&s, at, &|_| Err("recycle unavailable".into())).unwrap();
    assert_eq!(r.status, 500);
    assert!(Path::new(draft["file"].as_str().unwrap()).exists());
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_recovery", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(status(&s, &c).unwrap()["pendingFiles"], 2);
    assert!(saved(&c).unwrap()["lastCleanup"].is_null());
    drop(c);
    let s = initialize(&s.path, &s.path.with_file_name("none"), &s.assets).unwrap();
    let result = run(&s, at + 1);
    assert_eq!(result["result"]["filesRecycled"], 2);
    assert!(root.join(edge).exists());
    assert!(root.join("unknown.json").exists());
    assert!(!root.join(orphan).exists());
    assert_eq!(
        status(&s, &db(&s.path).unwrap()).unwrap()["pendingFiles"],
        0
    );
}

#[test]
fn writer_lock_defers_cleanup_and_clock_disorder_or_corrupt_snapshot_never_deletes_history() {
    let s = fixture();
    let at = clock();
    let mut c = db(&s.path).unwrap();
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert_eq!(run(&s, at)["reason"], "busy");
    tx.commit().unwrap();
    edit(&s, 20);
    age(&s, 1, at);
    age(&s, 2, at - KEEP_MS - 1);
    let r = maintain_at(&s, at, &|_| Ok(())).unwrap();
    assert_eq!(r.status, 500);
    assert!(r.body.contains("时间顺序异常"));
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    age(&s, 1, at - KEEP_MS - 2);
    let named = call(&s, "/api/versions/name", json!({"name":"snapshot"}));
    c.execute("UPDATE workbench_named_snapshots SET hash='corrupt'", [])
        .unwrap();
    assert!(version(&c, named["id"].as_str().unwrap()).is_err());
    let r = maintain_at(&s, at + CHECK_MS, &|_| Ok(())).unwrap();
    assert_eq!(r.status, 500);
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn only_history_and_drafts_change_and_vacuum_reclaims_space_after_close() {
    let s = fixture();
    let at = chrono::Utc::now().timestamp_millis();
    let c = db(&s.path).unwrap();
    let current = state(&c).unwrap();
    let activity = logs(&c).unwrap();
    c.execute_batch("CREATE TABLE protected_cloud(document TEXT); INSERT INTO protected_cloud VALUES('cloud sentinel'); CREATE TABLE protected_prices(document TEXT); INSERT INTO protected_prices VALUES('price sentinel');").unwrap();
    // 大历史载荷只放在过期记录；无需构造或复制业务大库。
    c.execute(
        "UPDATE workbench_history SET document=?1,at=?2",
        params![
            "x".repeat(4 * 1024 * 1024),
            stamp(at - KEEP_MS - 1).unwrap()
        ],
    )
    .unwrap();
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let before = fs::metadata(&s.path).unwrap().len();
    drop(c);
    run(&s, at);
    let c = db(&s.path).unwrap();
    assert_eq!(state(&c).unwrap(), current);
    assert_eq!(logs(&c).unwrap(), activity);
    assert_eq!(
        c.query_row("SELECT document FROM protected_cloud", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "cloud sentinel"
    );
    assert_eq!(
        c.query_row("SELECT document FROM protected_prices", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "price sentinel"
    );
    assert!(status(&s, &c).unwrap()["reusableBytes"].as_i64().unwrap() > 3 * 1024 * 1024);
    drop(c);
    let compact = Connection::open(&s.path).unwrap();
    compact
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    assert_eq!(
        compact
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(compact);
    assert!(fs::metadata(&s.path).unwrap().len() < before / 2);
}

#[test]
fn named_snapshot_protects_image_reference_after_old_chain_is_removed() {
    let s = fixture();
    let at = chrono::Utc::now().timestamp_millis();
    let mut c = db(&s.path).unwrap();
    let tx = c.transaction().unwrap();
    let input = json!({"id":"a","layout":"long","theme":"light"});
    let old =
        image_cache::save(&tx, &s, &input, b"named-image", at / 1000 - 10 * 24 * 3600).unwrap();
    image_cache::save(&tx, &s, &input, b"current-image", at / 1000).unwrap();
    tx.execute(
        "UPDATE workbench_metadata SET document=json_set(document,'$.image',?1)",
        [&old],
    )
    .unwrap();
    tx.commit().unwrap();
    let named = call(&s, "/api/versions/name", json!({"name":"带原图的版本"}));
    c.execute(
        "UPDATE workbench_metadata SET document=json_remove(document,'$.image')",
        [],
    )
    .unwrap();
    age(&s, 1, at - KEEP_MS - 1);
    run(&s, at);
    let tx = c.transaction().unwrap();
    assert_eq!(
        image_cache::preview(&tx, &s, at / 1000).unwrap()["count"],
        0
    );
    tx.commit().unwrap();
    call(&s, "/api/versions/delete-named", json!({"id":named["id"]}));
    let tx = c.transaction().unwrap();
    assert_eq!(
        image_cache::preview(&tx, &s, at / 1000).unwrap()["count"],
        1
    );
}

#[test]
fn save_arriving_during_cleanup_waits_and_commits_without_losing_edits() {
    let s = fixture();
    let at = chrono::Utc::now().timestamp_millis();
    call(
        &s,
        "/api/recovery-draft",
        json!({"state":state(&db(&s.path).unwrap()).unwrap()}),
    );
    db(&s.path)
        .unwrap()
        .execute(
            "UPDATE workbench_recovery SET at=?1",
            [stamp(at - KEEP_MS - 1).unwrap()],
        )
        .unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let clean_store = s.clone();
    let cleaner = std::thread::spawn(move || {
        maintain_at(&clean_store, at, &|p| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            fs::rename(p, p.with_extension("recycled")).map_err(|e| e.to_string())
        })
        .unwrap()
    });
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let (saved_tx, saved_rx) = std::sync::mpsc::channel();
    let save_store = s.clone();
    let writer = std::thread::spawn(move || {
        edit(&save_store, 99);
        saved_tx.send(()).unwrap();
    });
    assert!(saved_rx.recv_timeout(Duration::from_millis(60)).is_err());
    release_tx.send(()).unwrap();
    assert_eq!(cleaner.join().unwrap().status, 200);
    writer.join().unwrap();
    assert_eq!(
        state(&db(&s.path).unwrap()).unwrap()["configs"][0]["price"],
        99
    );
}

#[test]
fn backup_failure_and_missing_named_dependency_preserve_rows_and_files() {
    let s = fixture();
    let at = clock();
    age(&s, 1, at - KEEP_MS - 1);
    let obstruction = s.path.parent().unwrap().join("history-retention-backups");
    fs::write(&obstruction, b"obstruction").unwrap();
    let r = maintain_at(&s, at, &|_| panic!()).unwrap();
    assert_eq!(r.status, 500);
    let c = db(&s.path).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    fs::rename(&obstruction, obstruction.with_extension("saved")).unwrap();
    c.execute("INSERT INTO workbench_named_versions VALUES('named-missing',900,'丢失依赖','2026-10-01T00:00:00Z',0)",[]).unwrap();
    let r = maintain_at(&s, at + CHECK_MS, &|_| panic!()).unwrap();
    assert_eq!(r.status, 500);
    assert!(r.body.contains("历史缺失"));
    assert_eq!(
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn crash_after_database_commit_finishes_previous_result_without_redeleting() {
    let s = fixture();
    let at = clock();
    age(&s, 1, at - KEEP_MS - 1);
    let mut c = db(&s.path).unwrap();
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let planned = clean(&tx, &s, at).unwrap();
    tx.commit().unwrap();
    assert_eq!(planned["phase"], "files-pending");
    assert_eq!(planned["result"]["history"], 1);
    let done = run(&s, at + 1);
    assert_eq!(done["phase"], "complete");
    assert_eq!(done["result"]["history"], 1);
    assert_eq!(done["backup"], planned["backup"]);
}

#[test]
fn empty_workspace_can_still_bind_after_initial_history_expires() {
    let s = fixture();
    let at = clock();
    let c = db(&s.path).unwrap();
    entities::replace_fixture(
        &c,
        &json!({"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{}}),
    );
    c.execute(
        "UPDATE workbench_history SET document=?1",
        [json!({"type":"import","configCount":0,"logCount":0}).to_string()],
    )
    .unwrap();
    age(&s, 1, at - KEEP_MS - 1);
    assert!(cloud_state::check_factory_empty(&c).is_ok());
    run(&s, at);
    assert!(cloud_state::check_factory_empty(&c).is_ok());
}

#[test]
fn one_pass_migrates_multiple_legacy_names_including_shared_sequence() {
    let s = fixture();
    let at = clock();
    let c = db(&s.path).unwrap();
    let mut expected = Vec::new();
    for seq in 1..=3 {
        if seq > 1 {
            edit(&s, seq * 10);
        }
        let id = format!("named-legacy-{seq}");
        c.execute(
            "INSERT INTO workbench_named_versions VALUES(?1,?2,?1,'2026-10-01T00:00:00Z',0)",
            params![id, seq],
        )
        .unwrap();
        expected.push((id, state(&c).unwrap()));
        age(&s, seq, at - KEEP_MS - 4 + seq);
    }
    c.execute("INSERT INTO workbench_named_versions VALUES('named-same',2,'same','2026-10-01T00:00:00Z',0)",[]).unwrap();
    expected.push(("named-same".into(), expected[1].1.clone()));
    edit(&s, 90);
    let result = run(&s, at);
    assert_eq!(result["result"]["namedMigrated"], 4);
    for (id, original) in expected {
        assert_eq!(version(&c, &id).unwrap(), original);
    }
}

// Windows 原生故障验证：真实句柄/ACL 阻止删除，不使用模拟错误回调。
#[cfg(windows)]
fn windows_delete_failure_probe(block: impl FnOnce(&Path) -> Box<dyn std::any::Any>, code: i32) {
    let s = fixture();
    let at = chrono::Utc::now().timestamp_millis();
    let c = db(&s.path).unwrap();
    let before = state(&c).unwrap();
    let draft = call(&s, "/api/recovery-draft", json!({"state":before}));
    let path = PathBuf::from(draft["file"].as_str().unwrap());
    let bytes = fs::read(&path).unwrap();
    c.execute(
        "UPDATE workbench_recovery SET at=?1",
        [stamp(at - KEEP_MS - 1).unwrap()],
    )
    .unwrap();
    drop(c);
    let guard = block(&path);
    // 先确认操作系统确实拒绝删除，再经过产品完整维护流程验证持久化行为。
    assert_eq!(
        fs::remove_file(&path).unwrap_err().raw_os_error(),
        Some(code)
    );
    let result = maintain_at(&s, at, &delete_expired_draft).unwrap();
    assert_eq!(result.status, 500);
    assert!(
        result.body.contains(&format!("os error {code}")),
        "{}",
        result.body
    );
    // 这里只拒绝删除权限，保留读权限，以验证真实文件删除失败后的持久化队列。
    let pending = 1;
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let c = db(&s.path).unwrap();
    assert_eq!(status(&s, &c).unwrap()["pendingFiles"], pending);
    let registered: i64 = c
        .query_row("SELECT count(*) FROM workbench_recovery", [], |r| r.get(0))
        .unwrap();
    assert_eq!(registered, 1 - pending);
    if pending == 1 {
        assert_eq!(saved(&c).unwrap()["phase"], "files-pending");
    }
    assert!(saved(&c).unwrap()["lastCleanup"].is_null());
    assert_eq!(state(&c).unwrap(), before);
    drop(c);
    // 清理失败后仍能保存编辑；重开数据库后待处理记录仍存在。
    edit(&s, 99);
    drop(guard);
    let s = initialize(&s.path, &s.path.with_file_name("none"), &s.assets).unwrap();
    assert_eq!(
        status(&s, &db(&s.path).unwrap()).unwrap()["pendingFiles"],
        pending
    );
    let result = run(&s, at + CHECK_MS);
    assert_eq!(result["phase"], "complete");
    assert!(result["error"].is_null());
    assert!(!path.exists());
    assert_eq!(
        status(&s, &db(&s.path).unwrap()).unwrap()["pendingFiles"],
        0
    );
    assert_eq!(
        state(&db(&s.path).unwrap()).unwrap()["configs"][0]["price"],
        99
    );
    println!(
        "Windows error {code}: file preserved, recovery registration or queue persisted, save succeeded, restart/retry deleted draft"
    );
}

#[cfg(windows)]
#[test]
fn windows_locked_draft_preserved_then_deleted_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    windows_delete_failure_probe(
        |path| {
            // 允许读写但不共享删除，真实触发 Windows ERROR_SHARING_VIOLATION (32)。
            Box::new(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .open(path)
                    .unwrap(),
            )
        },
        32,
    );
}

#[cfg(windows)]
#[test]
fn windows_acl_denied_draft_preserved_then_deleted_after_permission_restore() {
    struct DenyDelete(Vec<PathBuf>);
    fn acl(path: &Path, args: &[&str]) {
        let exe =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/icacls.exe");
        let output = std::process::Command::new(exe)
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "icacls failed: {:?}", output);
    }
    impl Drop for DenyDelete {
        fn drop(&mut self) {
            // 仅还原本测试目录及草稿的拒绝规则，确保失败断言也能恢复权限。
            for path in self.0.iter().rev() {
                acl(path, &["/remove:d", "*S-1-1-0"]);
            }
        }
    }
    windows_delete_failure_probe(
        |path| {
            let parent = path.parent().unwrap().to_path_buf();
            let mut guard = DenyDelete(vec![parent.clone()]);
            // 同时拒绝父目录 DeleteChild 和文件 Delete，排除父目录权限允许删除的旁路。
            acl(&parent, &["/deny", "*S-1-1-0:(DC)"]);
            guard.0.push(path.to_path_buf());
            acl(path, &["/deny", "*S-1-1-0:(DE)"]);
            Box::new(guard)
        },
        5,
    );
}
