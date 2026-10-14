// 真实 SQLite 和文件失败注入：仅使用 sandbox 副本，验证保存回滚、恢复文件保留与安全重试。
//! Real SQLite/filesystem failure injection; all fixtures stay under sandbox.
//! The runner may recycle the printed fixture directories after collecting evidence.
use super::*;

fn fixture(label: &str) -> (WorkbenchStore, PathBuf) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/windows-recovery-20261013/fixtures")
        .join(format!("{label}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.json");
    let seed = serde_json::from_str::<Value>(
        r#"{"revision":7,"updatedAt":"old","unknownGlobal":{"decimal":1.234567890123456789},"configs":[{"id":"a","shopId":"s","name":"Original A","price":8799,"actualParts":[],"unknown":{"keep":true}},{"id":"b","shopId":"s","name":"Original B","actualParts":[],"unknown":[null,true]}],"logs":[{"id":"archive","keep":true}]}"#,
    )
    .unwrap();
    fs::write(&source, seed.to_string()).unwrap();
    let store = initialize(&root.join("test.sqlite"), &source, &root.join("assets")).unwrap();
    println!("recovery fixture: {}", root.display());
    (store, root)
}

fn call(store: &WorkbenchStore, endpoint: &str, input: &Value) -> (u16, Value) {
    let result = request(store, "POST", endpoint, Some(&input.to_string())).unwrap();
    (result.status, serde_json::from_str(&result.body).unwrap())
}

// Capture row contents as well as counts. A rollback must leave existing history,
// archive, receipts and recovery rows byte-for-byte unchanged, not only the state.
fn database_snapshot(store: &WorkbenchStore) -> Vec<Vec<Vec<String>>> {
    let c = db(&store.path).unwrap();
    [
        "SELECT CAST(id AS TEXT),document FROM workbench_state ORDER BY id",
        "SELECT CAST(id AS TEXT),document FROM workbench_log_archive ORDER BY id",
        "SELECT CAST(sequence AS TEXT),document FROM workbench_activity ORDER BY sequence",
        "SELECT CAST(sequence AS TEXT),at,CAST(revision AS TEXT),document FROM workbench_history ORDER BY sequence",
        "SELECT operation,hash,document FROM workbench_receipts ORDER BY operation",
        "SELECT id,at,document FROM workbench_recovery ORDER BY id",
    ]
    .into_iter()
    .map(|sql| {
        let mut query = c.prepare(sql).unwrap();
        let width = query.column_count();
        query
            .query_map([], |row| {
                (0..width).map(|column| row.get::<_, String>(column)).collect()
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}

fn assert_integrity(store: &WorkbenchStore) {
    let c = db(&store.path).unwrap();
    let integrity: String = c
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}

fn batch(before: &Value) -> Value {
    let changes: Vec<Value> = before["configs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|base| {
            let mut after = base.clone();
            after["name"] = json!(format!("Edited {}", base["id"].as_str().unwrap()));
            json!({"id":base["id"],"base":base,"after":after})
        })
        .collect();
    json!({"operationId":"retry-identical-operation","mode":"ordinary","baseRevision":before["revision"],"changes":changes})
}

#[test]
fn batch_sql_failures_roll_back_every_stage_and_identical_operation_retries_once() {
    let stages = [
        ("state", "BEFORE UPDATE ON workbench_metadata", ""),
        ("history", "BEFORE INSERT ON workbench_history", ""),
        // The first activity insert has already succeeded when the second fails.
        (
            "second-activity",
            "BEFORE INSERT ON workbench_activity",
            "WHEN (SELECT COUNT(*) FROM workbench_activity) = 1",
        ),
        ("receipt", "BEFORE INSERT ON workbench_receipts", ""),
    ];
    for (stage, event, condition) in stages {
        let (store, _) = fixture(stage);
        let before = state(&db(&store.path).unwrap()).unwrap();
        let input = batch(&before);
        let pristine = database_snapshot(&store);
        db(&store.path).unwrap().execute_batch(&format!(
            "CREATE TRIGGER inject_failure {event} {condition} BEGIN SELECT RAISE(ABORT, 'injected-{stage}'); END;"
        )).unwrap();
        let failed = call(&store, "/api/configs/batch", &input);
        assert_eq!(failed.0, 400, "{stage}: must not acknowledge a failed save");
        assert!(
            failed.1["error"]
                .as_str()
                .unwrap()
                .contains(&format!("injected-{stage}"))
        );
        assert_eq!(
            database_snapshot(&store),
            pristine,
            "{stage}: partial write survived"
        );
        assert_integrity(&store);
        db(&store.path)
            .unwrap()
            .execute_batch("DROP TRIGGER inject_failure")
            .unwrap();

        // Re-open via the public initializer to exercise persisted recovery after
        // the failed connection/transaction has gone away. No source is required.
        let reopened =
            initialize(&store.path, Path::new("unused-source.json"), &store.assets).unwrap();
        let receipt = call(&reopened, "/api/configs/batch", &input);
        assert_eq!(receipt.0, 200);
        assert_eq!(receipt.1["revision"], 8);
        assert_eq!(receipt.1["activityDelta"].as_array().unwrap().len(), 2);
        let committed = database_snapshot(&reopened);
        assert_eq!(committed[2].len(), 2);
        assert_eq!(committed[3].len(), 2);
        assert_eq!(committed[4].len(), 1);
        assert_eq!(call(&reopened, "/api/configs/batch", &input), receipt);
        assert_eq!(
            database_snapshot(&reopened),
            committed,
            "{stage}: replay wrote twice"
        );
        let c = db(&reopened.path).unwrap();
        assert_eq!(reconstruct(&c, 1).unwrap(), before);
        let saved = state(&c).unwrap();
        for (index, change) in input["changes"].as_array().unwrap().iter().enumerate() {
            assert_eq!(saved["configs"][index], change["after"]);
        }
        assert_eq!(saved["unknownGlobal"], before["unknownGlobal"]);
        assert_integrity(&reopened);
    }
}

#[test]
fn full_state_history_failure_rolls_back_state_and_preserves_existing_receipt() {
    let (store, _) = fixture("full-state");
    let initial = state(&db(&store.path).unwrap()).unwrap();
    let previous_input = batch(&initial);
    let previous = call(&store, "/api/configs/batch", &previous_input);
    assert_eq!(previous.0, 200);
    let before = state(&db(&store.path).unwrap()).unwrap();
    let pristine = database_snapshot(&store);
    let mut desired = before.clone();
    desired["baseRevision"] = before["revision"].clone();
    desired["configs"][0]["name"] = json!("Global update");
    desired["unknownGlobal"]["additional"] = json!([1, null, "preserved"]);
    db(&store.path).unwrap().execute_batch(
        "CREATE TRIGGER inject_failure BEFORE INSERT ON workbench_history BEGIN SELECT RAISE(ABORT, 'injected-history'); END;"
    ).unwrap();
    let failed = call(&store, "/api/state", &desired);
    assert_eq!(failed.0, 400);
    assert!(
        failed.1["error"]
            .as_str()
            .unwrap()
            .contains("injected-history")
    );
    assert_eq!(database_snapshot(&store), pristine);
    assert_eq!(
        call(&store, "/api/configs/batch", &previous_input),
        previous
    );
    db(&store.path)
        .unwrap()
        .execute_batch("DROP TRIGGER inject_failure")
        .unwrap();
    assert_eq!(call(&store, "/api/state", &desired).0, 200);
    let c = db(&store.path).unwrap();
    assert_eq!(revision(&state(&c).unwrap()), 9);
    assert_eq!(reconstruct(&c, 2).unwrap(), before);
    assert_integrity(&store);
}

fn draft_input(store: &WorkbenchStore) -> Value {
    let before = full_state(&db(&store.path).unwrap()).unwrap();
    let mut desired = before.clone();
    desired["configs"][0]["name"] = json!("Unsaved draft");
    json!({"state":desired,"baseState":before,"clientMetadata":{"keep":true}})
}

fn failed_draft(store: &WorkbenchStore, input: &Value) -> String {
    // This branch rejects the native invocation on I/O/DB failure; local-bridge
    // converts that rejection to an error response, so callers cannot exit on it.
    request(
        store,
        "POST",
        "/api/recovery-draft",
        Some(&input.to_string()),
    )
    .expect_err("a failed draft must never acknowledge success")
}

#[test]
fn recovery_file_failure_does_not_acknowledge_or_write_database_and_can_retry() {
    let (store, root) = fixture("draft-file");
    let input = draft_input(&store);
    let pristine = database_snapshot(&store);
    let recovery = root.join("workbench-recovery");
    let sentinel = b"file blocking recovery directory";
    fs::write(&recovery, sentinel).unwrap();
    let failed = failed_draft(&store, &input);
    assert!(!failed.is_empty());
    assert_eq!(database_snapshot(&store), pristine);
    assert_eq!(fs::read(&recovery).unwrap(), sentinel);
    // Keep the obstruction as evidence; no deletion is needed to permit retry.
    fs::rename(&recovery, root.join("recovery-directory-obstruction.txt")).unwrap();
    let success = call(&store, "/api/recovery-draft", &input);
    assert_eq!(success.0, 200);
    assert_eq!(success.1["ok"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(success.1["file"].as_str().unwrap()).unwrap())
            .unwrap(),
        input["state"]
    );
    let snapshot = database_snapshot(&store);
    assert_eq!(&snapshot[..5], &pristine[..5]);
    assert_eq!(snapshot[5].len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&snapshot[5][0][2]).unwrap(),
        input
    );
    assert_integrity(&store);
}

#[test]
fn recovery_database_failure_preserves_complete_file_without_acknowledging_success() {
    let (store, root) = fixture("draft-db");
    let input = draft_input(&store);
    // Keep an earlier successful draft; a later failure must not overwrite it.
    let earlier = call(&store, "/api/recovery-draft", &input);
    assert_eq!(earlier.0, 200);
    let earlier_path = PathBuf::from(earlier.1["file"].as_str().unwrap());
    let earlier_bytes = fs::read(&earlier_path).unwrap();
    let pristine = database_snapshot(&store);
    db(&store.path).unwrap().execute_batch(
        "CREATE TRIGGER inject_failure BEFORE INSERT ON workbench_recovery BEGIN SELECT RAISE(ABORT, 'injected-recovery-db'); END;"
    ).unwrap();
    let failed = failed_draft(&store, &input);
    assert!(failed.contains("injected-recovery-db"));
    assert_eq!(database_snapshot(&store), pristine);
    assert_eq!(fs::read(&earlier_path).unwrap(), earlier_bytes);
    let files: Vec<_> = fs::read_dir(root.join("workbench-recovery"))
        .unwrap()
        .map(|item| item.unwrap().path())
        .collect();
    assert_eq!(files.len(), 2);
    let orphan = files.iter().find(|file| **file != earlier_path).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(orphan).unwrap()).unwrap(),
        input["state"]
    );
    db(&store.path)
        .unwrap()
        .execute_batch("DROP TRIGGER inject_failure")
        .unwrap();
    let retried = call(&store, "/api/recovery-draft", &input);
    assert_eq!(retried.0, 200);
    let snapshot = database_snapshot(&store);
    assert_eq!(&snapshot[..5], &pristine[..5]);
    assert_eq!(snapshot[5].len(), 2);
    assert_eq!(fs::read(&earlier_path).unwrap(), earlier_bytes);
    assert!(
        orphan.is_file(),
        "DB failure fallback must not be silently removed"
    );
    assert_integrity(&store);
}
