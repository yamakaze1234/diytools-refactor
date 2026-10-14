// 批量预计算差异回归：验证增量历史与全量差异等价、冲突回滚和未知字段保留。
use super::*;

fn normalized(mut value: Value) -> Value {
    value["configs"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(|row| row["id"].as_str().unwrap().to_string());
    value
}
fn seed() -> Value {
    serde_json::from_str(r#"{"revision":7,"updatedAt":"old","unknownGlobal":{"decimal":1.234567890123456789,"keep":true},"configs":[{"id":"a","shopId":"s","productId":"p","name":"A","actualParts":[],"unknown":{"decimal":0.10000000000000000001}},{"id":"b","shopId":"s","productId":"p","name":"B","actualParts":[],"unknown":[1,null,true]}],"logs":[{"id":"archived"}]}"#).unwrap()
}
#[test]
fn prepared_batch_delta_matches_full_delta_with_metadata_presence_and_multirow() {
    for revision_case in [None, Some(Value::Null), Some(json!(7))] {
        for timestamp_case in [
            None,
            Some(Value::Null),
            Some(json!("same")),
            Some(json!("old")),
        ] {
            for changed_ids in [vec!["a"], vec!["a", "b"]] {
                let mut before = seed();
                before.as_object_mut().unwrap().remove("logs");
                before.as_object_mut().unwrap().remove("revision");
                before.as_object_mut().unwrap().remove("updatedAt");
                if let Some(value) = &revision_case {
                    before["revision"] = value.clone();
                }
                if let Some(value) = &timestamp_case {
                    before["updatedAt"] = value.clone();
                }
                let mut after = before.clone();
                let order = before["configs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c["id"].clone())
                    .collect();
                let mut changes = Vec::new();
                for id in changed_ids {
                    let index = before["configs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .position(|c| c["id"] == id)
                        .unwrap();
                    after["configs"][index]["name"] = json!(format!("{id}-new"));
                    changes.push(json!({"id":id,"before":before["configs"][index],"after":after["configs"][index]}));
                }
                let prepared = batch_delta(
                    before.get("revision").cloned(),
                    before.get("updatedAt").cloned(),
                    &mut after,
                    changes,
                    order,
                    "same".into(),
                );
                assert_eq!(normalized(prepared), normalized(delta(&before, &after)));
                assert_eq!(after["unknownGlobal"], before["unknownGlobal"]);
                if timestamp_case == Some(json!("same")) {
                    assert!(delta(&before, &after)["fields"].get("updatedAt").is_none());
                }
            }
        }
    }
}
fn fixture() -> WorkbenchStore {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/save-profile-20261012/contract-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.json");
    fs::write(&source, seed().to_string()).unwrap();
    initialize(&root.join("test.sqlite"), &source, &root.join("assets")).unwrap()
}
fn call(store: &WorkbenchStore, endpoint: &str, input: Value) -> (u16, Value) {
    let result = request(store, "POST", endpoint, Some(&input.to_string())).unwrap();
    (result.status, serde_json::from_str(&result.body).unwrap())
}
fn counts(store: &WorkbenchStore) -> (i64, i64, i64) {
    let c = db(&store.path).unwrap();
    (
        c.query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
            .unwrap(),
        c.query_row("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
            .unwrap(),
        c.query_row("SELECT count(*) FROM workbench_receipts", [], |r| r.get(0))
            .unwrap(),
    )
}
fn body(id: &str, before: &Value, desired: &Value) -> Value {
    json!({"operationId":id,"mode":"ordinary","baseRevision":before["revision"],"changes":[{"id":desired["id"],"base":before["configs"][0],"after":desired}]})
}
#[test]
fn prepared_batch_noop_and_second_target_validation_failure_are_atomic() {
    let store = fixture();
    let before = state(&db(&store.path).unwrap()).unwrap();
    let noop = body("noop", &before, &before["configs"][0]);
    let first = call(&store, "/api/configs/batch", noop.clone());
    assert_eq!(first.0, 200);
    assert_eq!(first.1["unchanged"], true);
    assert_eq!(first.1["activityDelta"], json!([]));
    assert_eq!(call(&store, "/api/configs/batch", noop), first);
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(), before);
    assert_eq!(counts(&store), (1, 0, 1));
    let mut a = before["configs"][0].clone();
    a["name"] = json!("new A");
    let mut b = before["configs"][1].clone();
    b["actualParts"] = json!({"invalid":true});
    let invalid = json!({"operationId":"invalid-second","mode":"ordinary","baseRevision":7,"changes":[{"id":"a","base":before["configs"][0],"after":a},{"id":"b","base":before["configs"][1],"after":b}]});
    assert_eq!(call(&store, "/api/configs/batch", invalid).0, 400);
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(), before);
    assert_eq!(counts(&store), (1, 0, 1));
}
#[test]
fn prepared_batch_multirow_history_reconstructs_complete_state_and_replays() {
    let store = fixture();
    let before = state(&db(&store.path).unwrap()).unwrap();
    let mut a = before["configs"][0].clone();
    a["name"] = json!("new A");
    let mut b = before["configs"][1].clone();
    b["price"] = json!(8799);
    let input = json!({"operationId":"multi","mode":"ordinary","baseRevision":7,"changes":[{"id":"b","base":before["configs"][1],"after":b},{"id":"a","base":before["configs"][0],"after":a}]});
    let result = call(&store, "/api/configs/batch", input.clone());
    assert_eq!(result.0, 200);
    assert_eq!(result.1["activityDelta"].as_array().unwrap().len(), 2);
    assert_eq!(result.1["configs"][0]["id"], "b");
    assert_eq!(call(&store, "/api/configs/batch", input), result);
    assert_eq!(counts(&store), (2, 2, 1));
    let c = db(&store.path).unwrap();
    let saved = state(&c).unwrap();
    assert_eq!(reconstruct(&c, 1).unwrap(), before);
    let actual: Value = serde_json::from_str(
        &c.query_row::<String, _, _>(
            "SELECT document FROM workbench_history WHERE sequence=2",
            [],
            |r| r.get(0),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(normalized(actual), normalized(delta(&before, &saved)));
    assert_eq!(
        saved["configs"][0]["unknown"],
        before["configs"][0]["unknown"]
    );
    assert_eq!(saved["unknownGlobal"], before["unknownGlobal"]);
    let preview = call(&store, "/api/versions/preview", json!({"id":"v-1"}));
    assert_eq!(preview.0, 200);
    let restored = call(&store, "/api/versions/restore", preview.1);
    assert_eq!(restored.0, 200);
    let restored = state(&db(&store.path).unwrap()).unwrap();
    let mut expected = before;
    expected["revision"] = restored["revision"].clone();
    expected["updatedAt"] = restored["updatedAt"].clone();
    assert_eq!(restored, expected);
    assert_eq!(
        logs(&db(&store.path).unwrap())
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["id"] == "archived")
            .count(),
        1
    );
}
#[test]
fn prepared_batch_rebase_preserves_remote_unknowns_and_conflict_receipts() {
    let store = fixture();
    let before = state(&db(&store.path).unwrap()).unwrap();
    let mut remote = before["configs"].clone();
    remote[0]["price"] = json!(5000);
    remote[0]["newUnknown"] = json!({"keep":true});
    assert_eq!(
        call(
            &store,
            "/api/state",
            json!({"baseRevision":7,"configs":remote})
        )
        .0,
        200
    );
    let mut desired = before["configs"][0].clone();
    desired["name"] = json!("local A");
    let input = body("rebased", &before, &desired);
    let first = call(&store, "/api/configs/batch", input.clone());
    assert_eq!(first.0, 200);
    assert_eq!(first.1["rebased"], true);
    assert_eq!(first.1["configs"][0]["price"], 5000);
    assert_eq!(first.1["configs"][0]["newUnknown"], json!({"keep":true}));
    assert_eq!(call(&store, "/api/configs/batch", input.clone()), first);
    let snapshot = state(&db(&store.path).unwrap()).unwrap();
    let original_counts = counts(&store);
    let mut bad = input.clone();
    bad["changes"][0]["after"]["name"] = json!("same-id-other-content");
    assert_eq!(call(&store, "/api/configs/batch", bad).0, 409);
    let mut conflict = input;
    conflict["operationId"] = json!("conflict");
    conflict["changes"][0]["after"]["price"] = json!(6000);
    assert_eq!(call(&store, "/api/configs/batch", conflict).0, 409);
    assert_eq!(counts(&store), original_counts);
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(), snapshot);
}
