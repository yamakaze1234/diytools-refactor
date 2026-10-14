// 日志读取回归：验证省略日志时不解析归档、分页查询边界，以及保存和回执不丢历史。
use super::*;

fn fixture(logs: Value) -> WorkbenchStore {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/windows-acceptance-20261013/log-access-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.json");
    fs::write(&source, json!({"revision":7,"updatedAt":"old","unknown":{"keep":true},"configs":[{"id":"a","name":"A","actualParts":[],"unknown":{"keep":true}},{"id":"b","name":"B","actualParts":[]}],"logs":logs}).to_string()).unwrap();
    initialize(&root.join("test.sqlite"), &source, &root.join("assets")).unwrap()
}
fn call(store: &WorkbenchStore, method: &str, path: &str, input: Value) -> (u16, Value) {
    let reply = request(store, method, path, Some(&input.to_string())).unwrap();
    (reply.status, serde_json::from_str(&reply.body).unwrap())
}
fn counts(store: &WorkbenchStore) -> (i64, i64) {
    let c = db(&store.path).unwrap();
    (c.query_row("SELECT COUNT(*) FROM workbench_history", [], |r|r.get(0)).unwrap(),
     c.query_row("SELECT COUNT(*) FROM workbench_activity", [], |r|r.get(0)).unwrap())
}
#[test]
fn log_access_omit_reads_and_receipts_preserve_archive_and_legacy_behavior() {
    let store = fixture(json!([{"id":"archive","at":"2026-10-13T00:00:00Z"}]));
    assert_eq!(call(&store,"GET","/api/state?logs=none",json!({})).1["logs"],json!([]));
    let (_, saved) = call(&store,"POST","/api/state",json!({"baseRevision":7,"omitLogs":true,"partialWorkspace":false,"unknown":{"keep":true,"new":1}}));
    assert_eq!(saved["logs"],json!([]));
    assert_eq!(saved["state"]["logs"],json!([]));
    let c=db(&store.path).unwrap();
    assert!(state(&c).unwrap().get("omitLogs").is_none());
    assert!(state(&c).unwrap().get("partialWorkspace").is_none());
    assert_eq!(logs(&c).unwrap().as_array().unwrap().len(),2);
    let (_, legacy) = call(&store,"POST","/api/state",json!({"baseRevision":8}));
    assert_eq!(legacy["logs"],legacy["state"]["logs"]);
    assert_eq!(legacy["logs"].as_array().unwrap().len(),2);
    assert_eq!(counts(&store),(2,1)); // initial import + one actual save
}
#[test]
fn log_access_omit_never_parses_archive_even_if_legacy_archive_is_unreadable() {
    let store=fixture(json!([]));
    db(&store.path).unwrap().execute("UPDATE workbench_log_archive SET document='not-json'",[]).unwrap();
    assert_eq!(call(&store,"GET","/api/state?logs=none",json!({})).0,200);
    assert_eq!(call(&store,"POST","/api/state",json!({"baseRevision":7,"omitLogs":true,"newField":true})).0,200);
    // A legacy receipt failure must also roll back an otherwise valid save.
    let before=state(&db(&store.path).unwrap()).unwrap();
    assert_eq!(call(&store,"POST","/api/state",json!({"baseRevision":8,"newField":false})).0,400);
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(),before);
    assert_eq!(counts(&store),(2,1)); // failed legacy receipt adds no history
}
#[test]
fn log_access_rejects_summaries_and_invalid_controls_without_writes() {
    let store=fixture(json!([]));
    let before=state(&db(&store.path).unwrap()).unwrap();
    for payload in [json!({"partialWorkspace":true}),json!({"configs":[{"id":"a","__workbenchSummary":true}]}),json!({"baseState":{"configs":[{"id":"a","__workbenchSummary":true}]}}),json!({"omitLogs":"true"})] {
        let mut input=payload;
        input["baseRevision"]=json!(7);
        assert_eq!(call(&store,"POST","/api/state",input).0,400);
    }
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(),before);
    assert_eq!(counts(&store),(1,0)); // retain the initializer's import record
    for path in ["/api/state?logs=invalid","/api/state?logs=none&logs=all"] {
        assert_eq!(call(&store,"GET",path,json!({})).0,400);
    }
}
#[test]
fn log_access_optimized_save_preserves_merge_unknown_fields_and_exact_inverse_history() {
    let store=fixture(json!([]));
    let c=db(&store.path).unwrap();
    let before=state(&c).unwrap();
    let initial_sequence:i64=c.query_row("SELECT MAX(sequence) FROM workbench_history",[],|r|r.get(0)).unwrap();
    let mut baseline=before.clone();
    baseline["configs"][0]["unknown"]["keep"]=json!(false);
    let mut desired=baseline.clone();
    desired["configs"][0]["name"]=json!("renamed");
    desired["configs"].as_array_mut().unwrap().reverse();
    desired["unknown"]["new"]=Value::Null;
    desired["introduced"]=serde_json::from_str("1.234567890123456789").unwrap();
    desired["baseState"]=baseline;
    desired["baseRevision"]=json!(7);
    desired["omitLogs"]=json!(true);
    assert_eq!(call(&store,"POST","/api/state",desired).0,200);
    let after=state(&c).unwrap();
    assert_eq!(after["configs"][1]["unknown"]["keep"],true);
    assert_eq!(after["configs"][1]["name"],"renamed");
    assert_eq!(after["introduced"].to_string(),"1.234567890123456789");
    let actual:String=c.query_row("SELECT document FROM workbench_history WHERE sequence>?1",[initial_sequence],|r|r.get(0)).unwrap();
    let mut actual:Value=serde_json::from_str(&actual).unwrap();
    let mut expected=delta(&before,&after);
    for value in [&mut actual,&mut expected] { value["configs"].as_array_mut().unwrap().sort_by_key(|row|row["id"].to_string()); }
    assert_eq!(actual,expected);
    assert_eq!(reconstruct(&c,initial_sequence).unwrap(),before);
    let mut conflict=after.clone();
    conflict["configs"][1]["name"]=json!("third");
    conflict["unknown"]["mustRollback"]=json!(true);
    conflict["baseState"]=before.clone();
    conflict["baseRevision"]=json!(8);
    conflict["omitLogs"]=json!(true);
    conflict["aaaEarlierField"]=json!("must-rollback");
    assert_eq!(call(&store,"POST","/api/state",conflict).0,409);
    assert_eq!(state(&c).unwrap(),after);
    assert_eq!(counts(&store),(2,1));
}
fn at(store:&WorkbenchStore,path:&str)->Value {
    let now=chrono::DateTime::parse_from_rfc3339("2026-10-13T12:00:00Z").unwrap().timestamp_millis();
    serde_json::from_str(&activity::query_at(store,path,now).unwrap().body).unwrap()
}
#[test]
fn log_access_activity_matches_age_identity_stable_order_and_shanghai_dates() {
    let store=fixture(json!([
        {"id":"duplicate","at":"2026-10-13T11:59:00Z","message":"archive suppressed"},
        {"id":"tie","at":"2026-10-13T10:00:00Z"},
        {"id":"midnight-before","at":"2026-10-12T15:59:59.999Z"},
        {"id":"midnight","at":"2026-10-12T16:00:00Z"},
        {"id":"naive","at":"2026-10-13T00:00:00"},
        {"id":"date-only","at":"2026-10-13"},
        {"id":"week-edge","at":"2026-10-06T12:00:00Z"},
        {"id":"too-old","at":"2026-10-06T11:59:59.999Z"},
        {"id":"future-edge","at":"2026-10-13T12:01:00Z"},
        {"id":"too-new","at":"2026-10-13T12:01:00.001Z"},
        {"id":"invalid","at":"invalid"},
        {"at":"2026-10-13T09:00:00Z","message":"no-id"},
        {"at":"2026-10-13T09:00:00Z","message":"no-id"}
    ]));
    let c=db(&store.path).unwrap();
    for row in [json!({"id":"duplicate","at":"2026-10-12T01:00:00Z"}),json!({"id":"local-tie","at":"2026-10-13T10:00:00Z"})] {
        c.execute("INSERT INTO workbench_activity(document) VALUES(?1)",[row.to_string()]).unwrap();
    }
    let all=at(&store,"/api/activity");
    assert_eq!(all["total"],10);
    assert_eq!(all["rows"][0]["id"],"future-edge");
    assert_eq!(all["rows"][1]["id"],"local-tie");
    assert_eq!(all["rows"][2]["id"],"tie");
    let day=at(&store,"/api/activity?from=2026-10-13&to=2026-10-13");
    assert_eq!(day["total"],7);
    let ids=day["rows"].as_array().unwrap().iter().map(|r|r["id"].as_str().unwrap_or("")).collect::<Vec<_>>();
    assert!(!ids.contains(&"duplicate")); // date filter cannot resurrect discarded archive duplicate
    assert!(!ids.contains(&"midnight-before"));
    assert!(ids.contains(&"midnight") && ids.contains(&"naive") && ids.contains(&"date-only"));
    let last=at(&store,"/api/activity?page=999999&pageSize=3");
    assert_eq!(last["page"],3);
    assert_eq!(last["rows"].as_array().unwrap().len(),1);
}
#[test]
fn log_access_activity_validates_all_query_parameters_and_empty_pages() {
    let store=fixture(json!([]));
    for path in ["/api/activity?page=-1","/api/activity?page=1.5","/api/activity?page=9223372036854775808","/api/activity?pageSize=0","/api/activity?pageSize=101","/api/activity?page=0&page=1","/api/activity?unknown=1","/api/activity?from=2026-02-30","/api/activity?from=2026-1-01","/api/activity?from=2026-10-14&to=2026-10-13"] {
        assert_eq!(call(&store,"GET",path,json!({})).0,400,"{path}");
    }
    assert_eq!(at(&store,"/api/activity?page=100&from=&to="),json!({"rows":[],"total":0,"page":0,"pageSize":30}));
}
#[test]
fn log_access_activity_pages_large_archive_and_derived_status_reads_scalar() {
    let store=fixture(Value::Array((0..10_000).map(|i|json!({"id":format!("row-{i}"),"at":"2026-10-13T00:00:00Z","large":{"keep":[1,2,3]}})).collect()));
    let page=at(&store,"/api/activity?page=100&pageSize=30");
    assert_eq!(page["total"],10_000);
    assert_eq!(page["rows"].as_array().unwrap().len(),30);
    assert_eq!(page["rows"][0]["id"],"row-3000");
    let (_, status)=call(&store,"GET","/api/derived/status",json!({}));
    assert_eq!(status["requestedRevision"],7);
    assert_eq!(status["completedRevision"],7);
}
