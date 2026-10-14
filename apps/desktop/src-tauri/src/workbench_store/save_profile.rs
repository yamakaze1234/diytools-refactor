// 显式启用的保存性能探针：源数据只读，测量在隔离副本执行；默认测试和程序启动均不运行。
//! Reproducible, ignored, read-only-source save measurements. Never runs at startup.
use super::*;
use std::{cell::RefCell, collections::BTreeMap, time::Instant};

thread_local! {
    static PROFILE: RefCell<Option<BTreeMap<&'static str, f64>>> = const { RefCell::new(None) };
}
pub(super) fn record(name: &'static str, duration: Duration) {
    PROFILE.with(|cell| {
        if let Some(values) = cell.borrow_mut().as_mut() {
            *values.entry(name).or_default() += duration.as_secs_f64() * 1000.0;
        }
    });
}
fn begin() {
    PROFILE.with(|cell| *cell.borrow_mut() = Some(BTreeMap::new()));
}
fn finish() -> BTreeMap<&'static str, f64> {
    PROFILE.with(|cell| cell.borrow_mut().take().unwrap())
}
fn digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn archive_digest(c: &Connection) -> String {
    let bytes: String = c
        .query_row(
            "SELECT document FROM workbench_log_archive WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    format!("{:x}", Sha256::digest(bytes.as_bytes()))
}
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

#[test]
#[ignore = "Uses only existing dedicated save-profile databases to detail stages and time actual replay"]
fn existing_ordinary_detail_and_replay_profile() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let folder = project.join("sandbox/save-profile-20261012");
    let mut reports: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .map(|r| r.unwrap().path().join("report.json"))
        .filter(|p| p.is_file())
        .collect();
    reports.sort_by_key(|path| fs::metadata(path).unwrap().modified().unwrap());
    let report_path = reports.last().unwrap();
    let root = report_path.parent().unwrap();
    let source = project.join("sandbox/migration-review/20261011/source-state.json");
    let source_before = digest(&source);
    let frozen_before = digest(&root.join("frozen.sqlite"));
    let mut samples = Vec::new();
    for iteration in 1..=3 {
        let store = WorkbenchStore {
            path: root.join(format!("ordinary_batch-{iteration}.sqlite")),
            assets: root.join("assets"),
        };
        let connection = db(&store.path).unwrap();
        let current = state(&connection).unwrap();
        let history: Value = serde_json::from_str(
            &connection
                .query_row::<String, _, _>(
                    "SELECT document FROM workbench_history ORDER BY sequence DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap(),
        )
        .unwrap();
        let base = &history["configs"][0]["before"];
        let after = &history["configs"][0]["after"];
        let original = json!({"operationId":format!("save-profile-{iteration}"),"mode":"ordinary","baseRevision":revision(&current)-1,"changes":[{"id":after["id"],"base":base,"after":after}]});
        let original_body = original.to_string();
        let (stored_hash, stored_receipt): (String, String) = connection
            .query_row(
                "SELECT hash,document FROM workbench_receipts WHERE operation=?1",
                [format!("save-profile-{iteration}")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            stored_hash,
            format!("{:x}", Sha256::digest(original_body.as_bytes()))
        );
        if iteration == 1 {
            begin();
            let started = Instant::now();
            let replay =
                request(&store, "POST", "/api/configs/batch", Some(&original_body)).unwrap();
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            let stages = finish();
            assert_eq!(replay.status, 200);
            assert_eq!(
                serde_json::from_str::<Value>(&replay.body).unwrap(),
                serde_json::from_str::<Value>(&stored_receipt).unwrap()
            );
            assert_eq!(state(&connection).unwrap(), current);
            assert_eq!(
                connection
                    .query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r
                        .get(0))
                    .unwrap(),
                2
            );
            samples.push(json!({"mode":"original_operation_replay","iteration":iteration,"requestMs":elapsed,"stagesMs":stages,"receiptEqualsStored":true,"revisionUnchanged":true,"historyUnchanged":true}));
        }
        let id = after["id"].as_str().unwrap();
        let index = current["configs"]
            .as_array()
            .unwrap()
            .iter()
            .position(|c| c["id"] == id)
            .unwrap();
        let mut desired = current["configs"][index].clone();
        desired["name"] = json!(format!("E06 detail save {iteration}"));
        let input = json!({"operationId":format!("save-profile-detail-{iteration}"),"mode":"ordinary","baseRevision":revision(&current),"changes":[{"id":id,"base":current["configs"][index],"after":desired}]});
        let body = input.to_string();
        begin();
        let started = Instant::now();
        let result = request(&store, "POST", "/api/configs/batch", Some(&body)).unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let mut stages = finish();
        assert_eq!(result.status, 200);
        let receipt: Value = serde_json::from_str(&result.body).unwrap();
        let saved = state(&connection).unwrap();
        let mut expected = current;
        expected["configs"][index] = desired;
        expected["revision"] = json!(revision(&expected) + 1);
        expected["updatedAt"] = receipt["updatedAt"].clone();
        assert_eq!(saved, expected);
        let history_count = connection
            .query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(history_count, 3);
        let archive_before = archive_digest(&connection);
        stages.insert(
            "state_sql_update_excluding_serialize",
            stages["state_serialize_and_sql_update"] - stages["state_json_serialize"],
        );
        stages.insert(
            "merge_validate_compare_excluding_clone",
            stages["clone_merge_validate_compare"] - stages["state_json_clone"],
        );
        stages.insert(
            "request_cleanup_and_dispatch_remainder",
            elapsed - stages["save_batch_total_before_drop"] - stages["request_json_parse"],
        );
        samples.push(json!({"mode":"ordinary_detailed_second_save","iteration":iteration,"requestMs":elapsed,"stagesMs":stages,"stateEqualsExpected":true,"historyCount":history_count}));
        begin();
        let started = Instant::now();
        let replay = request(&store, "POST", "/api/configs/batch", Some(&body)).unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let stages = finish();
        assert_eq!(replay.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&replay.body).unwrap(),
            receipt
        );
        assert_eq!(state(&connection).unwrap(), saved);
        assert_eq!(archive_digest(&connection), archive_before);
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
                .unwrap(),
            history_count
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
                .unwrap(),
            2
        );
        samples.push(json!({"mode":"detail_operation_replay","iteration":iteration,"requestMs":elapsed,"stagesMs":stages,"receiptEqualsOriginal":true,"stateUnchanged":true,"historyUnchanged":true,"activityUnchanged":true,"archiveUnchanged":true}));
    }
    assert_eq!(digest(&source), source_before);
    assert_eq!(digest(&root.join("frozen.sqlite")), frozen_before);
    let mut summary = serde_json::Map::new();
    for mode in ["ordinary_detailed_second_save", "detail_operation_replay"] {
        let selected: Vec<_> = samples
            .iter()
            .filter(|sample| sample["mode"] == mode)
            .collect();
        let stages = selected[0]["stagesMs"]
            .as_object()
            .unwrap()
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    json!(median(
                        selected
                            .iter()
                            .map(|sample| sample["stagesMs"][name].as_f64().unwrap())
                            .collect()
                    )),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        summary.insert(mode.into(),json!({"requestMedianMs":median(selected.iter().map(|sample|sample["requestMs"].as_f64().unwrap()).collect()),"stagesMedianMs":stages}));
    }
    let output = root.join("detail-replay-report.json");
    fs::write(&output,serde_json::to_vec_pretty(&json!({"schema":1,"buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},"sourceHashUnchanged":true,"frozenDatabaseHashUnchanged":true,"samples":samples,"summary":summary})).unwrap()).unwrap();
    println!("SAVE_DETAIL_REPLAY_REPORT={}", output.display());
    println!("{}", serde_json::to_string_pretty(&summary).unwrap());
}

#[test]
#[ignore = "Resets only the five owned ordinary profile databases from frozen.sqlite and measures optimized save/replay"]
fn optimized_ordinary_save_profile() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let folder = project.join("sandbox/save-profile-20261012");
    let mut reports: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .map(|r| r.unwrap().path().join("report.json"))
        .filter(|p| p.is_file())
        .collect();
    reports.sort_by_key(|path| fs::metadata(path).unwrap().modified().unwrap());
    let root = reports.last().unwrap().parent().unwrap();
    let frozen = root.join("frozen.sqlite");
    let frozen_hash = digest(&frozen);
    let source = project.join("sandbox/migration-review/20261011/source-state.json");
    let source_hash = digest(&source);
    let c = db(&frozen).unwrap();
    let before = state(&c).unwrap();
    let archived_hash = archive_digest(&c);
    drop(c);
    let index = before["configs"]
        .as_array()
        .unwrap()
        .iter()
        .position(|c| c.get("deletedAt").is_none_or(|v| v.is_null() || v == ""))
        .unwrap();
    let mut samples = Vec::new();
    for iteration in 1..=5 {
        let database = root.join(format!("ordinary_batch-{iteration}.sqlite"));
        assert!(!PathBuf::from(format!("{}-wal", database.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", database.display())).exists());
        fs::copy(&frozen, &database).unwrap();
        let store = WorkbenchStore {
            path: database,
            assets: root.join("assets"),
        };
        let mut desired = before["configs"][index].clone();
        desired["name"] = json!(format!(
            "E06 isolated save probe ordinary_batch {iteration}"
        ));
        let input = json!({"operationId":format!("save-profile-{iteration}"),"mode":"ordinary","baseRevision":revision(&before),"changes":[{"id":desired["id"],"base":before["configs"][index],"after":desired}]});
        let body = input.to_string();
        begin();
        let started = Instant::now();
        let response = request(&store, "POST", "/api/configs/batch", Some(&body)).unwrap();
        let request_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut stages = finish();
        assert_eq!(response.status, 200);
        let receipt: Value = serde_json::from_str(&response.body).unwrap();
        let c = db(&store.path).unwrap();
        let actual = state(&c).unwrap();
        let mut expected = before.clone();
        expected["configs"][index] = desired;
        expected["revision"] = json!(revision(&before) + 1);
        expected["updatedAt"] = receipt["updatedAt"].clone();
        assert_eq!(actual, expected);
        assert_eq!(archive_digest(&c), archived_hash);
        assert_eq!(reconstruct(&c, 1).unwrap(), before);
        let counts_before: (i64,i64,i64) = c.query_row("SELECT (SELECT count(*) FROM workbench_history),(SELECT count(*) FROM workbench_activity),(SELECT count(*) FROM workbench_receipts)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(counts_before, (2, 1, 1));
        stages.insert(
            "state_sql_update_excluding_serialize",
            stages["state_serialize_and_sql_update"] - stages["state_json_serialize"],
        );
        stages.insert(
            "request_cleanup_and_dispatch_remainder",
            request_ms - stages["save_batch_total_before_drop"] - stages["request_json_parse"],
        );
        samples.push(json!({"mode":"ordinary_optimized","iteration":iteration,"requestMs":request_ms,"stagesMs":stages,"stateEqualsExpected":true,"reconstructEqualsOriginal":true,"archiveUnchanged":true,"requestBytes":body.len(),"responseBytes":response.body.len()}));
        begin();
        let started = Instant::now();
        let replay = request(&store, "POST", "/api/configs/batch", Some(&body)).unwrap();
        let replay_ms = started.elapsed().as_secs_f64() * 1000.0;
        let stages = finish();
        assert_eq!(replay.status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&replay.body).unwrap(),
            receipt
        );
        assert_eq!(state(&c).unwrap(), actual);
        assert_eq!(c.query_row::<(i64,i64,i64),_,_>("SELECT (SELECT count(*) FROM workbench_history),(SELECT count(*) FROM workbench_activity),(SELECT count(*) FROM workbench_receipts)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap(),counts_before);
        assert_eq!(archive_digest(&c), archived_hash);
        samples.push(json!({"mode":"optimized_replay","iteration":iteration,"requestMs":replay_ms,"stagesMs":stages,"receiptEqualsOriginal":true,"stateUnchanged":true,"historyActivityReceiptCountsUnchanged":true,"archiveUnchanged":true}));
    }
    assert_eq!(digest(&source), source_hash);
    assert_eq!(digest(&frozen), frozen_hash);
    let mut summary = serde_json::Map::new();
    for mode in ["ordinary_optimized", "optimized_replay"] {
        let selected: Vec<_> = samples
            .iter()
            .filter(|sample| sample["mode"] == mode)
            .collect();
        let stages = selected[0]["stagesMs"]
            .as_object()
            .unwrap()
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    json!(median(
                        selected
                            .iter()
                            .map(|sample| sample["stagesMs"][name].as_f64().unwrap())
                            .collect()
                    )),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        summary.insert(mode.into(),json!({"sampleCount":selected.len(),"requestMedianMs":median(selected.iter().map(|sample|sample["requestMs"].as_f64().unwrap()).collect()),"stagesMedianMs":stages}));
    }
    let output = root.join("optimized-report.json");
    fs::write(&output,serde_json::to_vec_pretty(&json!({"schema":1,"buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},"sourceSha256Before":source_hash,"sourceSha256After":digest(&source),"frozenDatabaseHashUnchanged":true,"samples":samples,"summary":summary})).unwrap()).unwrap();
    println!("SAVE_OPTIMIZED_REPORT={}", output.display());
    println!("{}", serde_json::to_string_pretty(&summary).unwrap());
}

#[test]
#[ignore = "Explicit D-drive frozen full-state save profile; creates only sandbox/save-profile-20261012"]
fn frozen_full_state_save_profile() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let source = project.join("sandbox/migration-review/20261011/source-state.json");
    let source_hash = digest(&source);
    assert_eq!(
        source_hash,
        "4396660ffb81a973e5595c27dfead01c46af40ee1aa5db1b4c783a9c59af908a"
    );
    let root = project.join("sandbox/save-profile-20261012").join(unique());
    fs::create_dir_all(&root).unwrap();
    let seed = initialize(&root.join("frozen.sqlite"), &source, &root.join("assets")).unwrap();
    let seed_connection = db(&seed.path).unwrap();
    seed_connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let frozen_archive_hash = archive_digest(&seed_connection);
    let expected = state(&seed_connection).unwrap();
    assert_eq!(expected["configs"].as_array().unwrap().len(), 2282);
    {
        let original: Value = serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
        assert_eq!(original["logs"].as_array().unwrap().len(), 105586);
        assert!(full_state(&seed_connection).unwrap() == original);
    }
    let document_bytes: i64 = seed_connection
        .query_row(
            "SELECT length(CAST(document AS BLOB)) FROM workbench_state",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(seed_connection);
    let frozen_db_hash = digest(&seed.path);
    let index = expected["configs"]
        .as_array()
        .unwrap()
        .iter()
        .position(|c| c.get("deletedAt").is_none_or(|v| v.is_null() || v == ""))
        .unwrap();
    let mut samples = Vec::new();
    for (mode, repetitions) in [("ordinary_batch", 5), ("full_state", 3)] {
        for iteration in 1..=repetitions {
            let database = root.join(format!("{mode}-{iteration}.sqlite"));
            fs::copy(&seed.path, &database).unwrap();
            let store = WorkbenchStore {
                path: database,
                assets: seed.assets.clone(),
            };
            let mut desired = expected["configs"][index].clone();
            desired["name"] = json!(format!("E06 isolated save probe {mode} {iteration}"));
            let (endpoint, input) = if mode == "ordinary_batch" {
                (
                    "/api/configs/batch",
                    json!({"operationId":format!("save-profile-{iteration}"),"mode":"ordinary","baseRevision":revision(&expected),"changes":[{"id":desired["id"],"base":expected["configs"][index],"after":desired}]}),
                )
            } else {
                let mut configs = expected["configs"].clone();
                configs[index] = desired.clone();
                (
                    "/api/state",
                    json!({"baseRevision":revision(&expected),"configs":configs}),
                )
            };
            let body = input.to_string();
            begin();
            let started = Instant::now();
            let result = request(&store, "POST", endpoint, Some(&body)).unwrap();
            let request_ms = started.elapsed().as_secs_f64() * 1000.0;
            let stages = finish();
            assert_eq!(result.status, 200);
            let receipt: Value = serde_json::from_str(&result.body).unwrap();
            let connection = db(&store.path).unwrap();
            let saved = state(&connection).unwrap();
            let mut expected_saved = expected.clone();
            expected_saved["configs"][index] = desired;
            expected_saved["revision"] = json!(revision(&expected) + 1);
            expected_saved["updatedAt"] = receipt["updatedAt"].clone();
            assert!(
                saved == expected_saved,
                "All unknown fields, unrelated configurations and order must remain equal"
            );
            assert_eq!(archive_digest(&connection), frozen_archive_hash);
            let activity_count: i64 = connection
                .query_row("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
                .unwrap();
            let history_count: i64 = connection
                .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
                .unwrap();
            assert_eq!(activity_count, 1);
            assert_eq!(history_count, 2);
            let history: Value = serde_json::from_str(
                &connection
                    .query_row::<String, _, _>(
                        "SELECT document FROM workbench_history ORDER BY sequence DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(history["configs"].as_array().unwrap().len(), 1);
            assert_eq!(history["configs"][0]["before"], expected["configs"][index]);
            assert_eq!(
                history["configs"][0]["after"],
                expected_saved["configs"][index]
            );
            if mode == "ordinary_batch" {
                let (stored_hash, stored_receipt): (String, String) = connection
                    .query_row("SELECT hash,document FROM workbench_receipts", [], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .unwrap();
                assert_eq!(
                    stored_hash,
                    format!("{:x}", Sha256::digest(body.as_bytes()))
                );
                assert_eq!(
                    serde_json::from_str::<Value>(&stored_receipt).unwrap(),
                    receipt
                );
            } else {
                let mut receipt_state = receipt["state"].clone();
                receipt_state.as_object_mut().unwrap().remove("logs");
                assert_eq!(receipt_state, saved);
                assert_eq!(receipt["logs"].as_array().unwrap().len(), 105587);
            }
            samples.push(json!({"mode":mode,"iteration":iteration,"requestMs":request_ms,"stagesMs":stages,"requestBytes":body.len(),"responseBytes":result.body.len(),"stateEqualsExpected":true,"archiveHashUnchanged":true,"historyChanges":1,"activityCount":activity_count}));
        }
    }
    assert_eq!(digest(&source), source_hash);
    assert_eq!(digest(&seed.path), frozen_db_hash);
    let mut summaries = serde_json::Map::new();
    for mode in ["ordinary_batch", "full_state"] {
        let selected: Vec<_> = samples
            .iter()
            .filter(|sample| sample["mode"] == mode)
            .collect();
        let stages = selected[0]["stagesMs"]
            .as_object()
            .unwrap()
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    json!(median(
                        selected
                            .iter()
                            .map(|sample| sample["stagesMs"][name].as_f64().unwrap())
                            .collect()
                    )),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        summaries.insert(mode.into(), json!({"sampleCount":selected.len(),"requestMedianMs":median(selected.iter().map(|sample|sample["requestMs"].as_f64().unwrap()).collect()),"stagesMedianMs":stages}));
    }
    let report = json!({"schema":1,"buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},"instrumentation":"cfg(test) only; expression clocks plus nonoverlapping scopes; inclusive scopes labelled serialize_and_sql; totals before local Value drop; request includes parse and destruction","sourceSha256Before":source_hash,"sourceSha256After":digest(&source),"sourceBytes":fs::metadata(&source).unwrap().len(),"frozenDatabaseHashUnchanged":true,"configCount":2282,"archivedLogCount":105586,"stateDocumentBytes":document_bytes,"directory":root,"samples":samples,"summary":summaries});
    let report_path = root.join("report.json");
    fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("SAVE_PROFILE_REPORT={}", report_path.display());
    println!(
        "{}",
        serde_json::to_string_pretty(&report["summary"]).unwrap()
    );
}
