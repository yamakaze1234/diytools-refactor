// 利润口径回归：覆盖整数分舍入、实际 BOM、未知成本、店铺隔离、幂等检测和基线恢复。
use super::*;

fn config(id: &str, shop: &str, tax: Value) -> Value {
    json!({"id":id,"shopId":shop,"productId":format!("link-{id}"),"product":"链接","name":"配置",
        "price":1000,"installment":0,"updatedAt":"initial","parts":[{"name":"展示","tax":1,"qty":1}],
        "actualParts":[{"lineId":"cpu","name":"实际CPU","slot":"CPU","goodsId":"123","qty":1,"tax":tax}]})
}

// Deliberately isolated from current-user data. The parent validation run moves
// sandbox/profit-tests to the Windows Recycle Bin after inspecting the evidence.
fn fixture(configs: Value) -> WorkbenchStore {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/profit-tests")
        .join(unique());
    fs::create_dir_all(&root).unwrap();
    let store = WorkbenchStore {
        path: root.join("test.sqlite"),
        assets: root.join("assets"),
    };
    let c = db(&store.path).unwrap();
    c.execute(
        "CREATE TABLE workbench_state(id INTEGER PRIMARY KEY,document TEXT NOT NULL)",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO workbench_state VALUES(1,?1)",
        [json!({"revision":1,"configs":configs}).to_string()],
    )
    .unwrap();
    store
}

fn start(store: &WorkbenchStore, request: &str, ids: &[&str]) -> Value {
    let response = profit_start(
        store,
        &json!({"requestId":request,"shopId":"intel","configIds":ids}),
    )
    .unwrap();
    assert_eq!(response.status, 200, "{}", response.body);
    serde_json::from_str(&response.body).unwrap()
}

fn report(store: &WorkbenchStore, run: &Value) -> Value {
    let response = profit_status(store, &json!({"shopId":"intel","runId":run["runId"]})).unwrap();
    assert_eq!(response.status, 200);
    serde_json::from_str(&response.body).unwrap()
}

fn result<'a>(report: &'a Value, metric: &str) -> &'a Value {
    report["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["metric"] == metric)
        .unwrap()
}

fn edit(store: &WorkbenchStore, change: impl FnOnce(&mut Value)) {
    let c = db(&store.path).unwrap();
    let mut v = state(&c).unwrap();
    change(&mut v);
    c.execute(
        "UPDATE workbench_state SET document=?1 WHERE id=1",
        [v.to_string()],
    )
    .unwrap();
}

#[test]
fn decimal_rounding_and_raw_installment_match_python_v2() {
    for (raw, cents) in [
        (json!("1.005"), 101),
        (json!("2.675"), 268),
        (json!("5e-3"), 1),
        (json!("0.0049"), 0),
        (json!(" 1.2 "), 120),
    ] {
        assert_eq!(money(&raw), Some(cents));
    }
    for raw in [
        Value::Null,
        json!(true),
        json!(-1),
        json!("NaN"),
        json!("1e999"),
        json!("9223372036854775808"),
    ] {
        assert_eq!(money(&raw), None);
    }
    let mut c = config("a", "intel", json!(0));
    c["price"] = json!("0.0834");
    c["installment"] = json!(12);
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(s["priceCents"], 8);
    assert_eq!(s["feeCents"], 1);
}

#[test]
fn actual_bom_quantity_hidden_and_independent_price_are_preserved() {
    let mut c = config("a", "intel", json!(500));
    c["actualParts"][0]["qty"] = json!(2);
    c["actualParts"][0]["hidden"] = json!(true);
    c["actualParts"][0]["taxOverride"] = json!({"goodsId":"123","value":200,"base":500});
    c["actualParts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"不含显卡","specialComponent":true,"qty":null,"tax":null}));
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(s["parts"].as_array().unwrap().len(), 1);
    assert_eq!(accounting(&s), (Some(46000), Some(40000), String::new()));
    c["actualParts"] = json!([]);
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(accounting(&s).0, None);
    c.as_object_mut().unwrap().remove("actualParts");
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(accounting(&s).1, Some(100));
    c["actualParts"] = Value::Null;
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(accounting(&s).1, Some(100));
}

#[test]
fn numeric_identities_match_legacy_without_losing_string_leading_zeroes() {
    let mut c = config("a", "intel", json!(500));
    c["productId"] = json!(123);
    c["installment"] = json!(12);
    c["actualParts"][0]["goodsId"] = json!(456);
    c["actualParts"][0]["taxOverride"] = json!({"goodsId":"456","value":200});
    let mut peer = config("b", "intel", json!(100));
    peer["productId"] = json!(789);
    let s = snapshot(&c, &[c.clone(), peer.clone()]).unwrap();
    assert_eq!(s["productId"], "123");
    assert_eq!(s["parts"][0]["goodsId"], "456");
    assert_eq!(accounting(&s).0, Some(60000));
    peer["productId"] = json!("123");
    assert_eq!(
        snapshot(&c, &[c.clone(), peer.clone()]).unwrap()["feeCents"],
        Value::Null
    );
    c["productId"] = json!("00123");
    c["actualParts"][0]["goodsId"] = json!("00456");
    c["actualParts"][0]["taxOverride"]["goodsId"] = json!("00456");
    let s = snapshot(&c, &[c.clone(), peer.clone()]).unwrap();
    assert_eq!(s["productId"], "00123");
    assert_eq!(s["parts"][0]["goodsId"], "00456");
    assert_eq!(s["feeCents"], 6000);
    assert_eq!(s["parts"][0]["taxCents"], 20000);
    c["actualParts"][0]["taxOverride"]["goodsId"] = json!("456");
    assert_eq!(
        snapshot(&c, &[c.clone(), peer]).unwrap()["parts"][0]["taxCents"],
        50000
    );
}

#[test]
fn missing_and_invalid_costs_are_unknown_instead_of_zero() {
    let mut c = config("a", "intel", Value::Null);
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert_eq!(accounting(&s).2, "CPU含税价缺失");
    for qty in [
        json!(0),
        json!(1001),
        json!(1.5),
        json!(true),
        json!("1.0"),
        Value::Null,
    ] {
        c["actualParts"][0]["qty"] = qty;
        let s = snapshot(&c, &[c.clone()]).unwrap();
        assert_eq!(accounting(&s).2, "CPU数量无效");
    }
    c["actualParts"][0]["qty"] = json!("2");
    c["actualParts"][0]["tax"] = json!(0);
    let s = snapshot(&c, &[c.clone()]).unwrap();
    assert!(accounting(&s).0.is_some());
}

#[test]
fn link_installment_disagreement_invalidates_selected_config() {
    let c = config("a", "intel", json!(100));
    let mut peer = config("b", "intel", json!(100));
    peer["productId"] = c["productId"].clone();
    peer["installment"] = json!(12);
    let s = snapshot(&c, &[c.clone(), peer.clone()]).unwrap();
    assert_eq!(s["feeCents"], Value::Null);
    peer["deletedAt"] = json!("deleted");
    let s = snapshot(&c, &[c.clone(), peer]).unwrap();
    assert_eq!(s["feeCents"], 0);
}

#[test]
fn deletion_marker_truthiness_matches_legacy_scope_and_link_terms() {
    let c = config("a", "intel", json!(100));
    let mut peer = config("b", "intel", json!(100));
    peer["productId"] = c["productId"].clone();
    peer["installment"] = json!(12);
    for marker in [Value::Null, json!(""), json!(false), json!(0)] {
        peer["deletedAt"] = marker;
        assert!(eligible(&peer, "intel"));
        assert_eq!(
            snapshot(&c, &[c.clone(), peer.clone()]).unwrap()["feeCents"],
            Value::Null
        );
    }
    for marker in [json!("2026-10-13"), json!(true), json!(1)] {
        peer["deletedAt"] = marker;
        assert!(!eligible(&peer, "intel"));
        assert_eq!(
            snapshot(&c, &[c.clone(), peer.clone()]).unwrap()["feeCents"],
            0
        );
    }
}

#[test]
fn strict_thresholds_and_invalid_observation_do_not_advance_baseline() {
    let store = fixture(json!([config("a", "intel", json!(700))]));
    let first = report(&store, &start(&store, "threshold-1", &["a"]));
    let anchor = result(&first, "accounting")["id"].clone();
    assert_eq!(result(&first, "accounting")["profit_cents"], 16000);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = json!(600)
    });
    let exact = report(&store, &start(&store, "threshold-2", &["a"]));
    assert_eq!(result(&exact, "accounting")["anchor_delta_cents"], 10000);
    assert_eq!(result(&exact, "accounting")["changed"], false);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = Value::Null
    });
    let invalid = report(&store, &start(&store, "threshold-3", &["a"]));
    assert_eq!(result(&invalid, "accounting")["valid"], false);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = json!("599.99")
    });
    let changed = report(&store, &start(&store, "threshold-4", &["a"]));
    let row = result(&changed, "accounting");
    assert_eq!(row["anchor_id"], anchor);
    assert_eq!(row["previous_delta_cents"], 1);
    assert_eq!(row["anchor_delta_cents"], 10001);
    assert_eq!(row["changed"], true);
    let c = db(&store.path).unwrap();
    let (new_anchor,count):(String,i64)=c.query_row("SELECT anchor_id,(SELECT count(*) FROM local_profit_baselines) FROM local_profit_baselines WHERE metric='accounting'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(new_anchor, row["id"].as_str().unwrap());
    assert_eq!(count, 1);
    for (index, (tax, loss)) in [(1160.0, false), (1160.01, true), (1100.0, false)]
        .into_iter()
        .enumerate()
    {
        edit(&store, |v| {
            v["configs"][0]["actualParts"][0]["tax"] = json!(tax)
        });
        let r = report(
            &store,
            &start(&store, &format!("loss-boundary-{index}"), &["a"]),
        );
        assert_eq!(result(&r, "accounting")["loss"], loss);
        if tax == 1100.0 {
            assert_eq!(result(&r, "accounting")["recovered"], true);
        }
    }
}

#[test]
fn offline_erp_cache_is_never_promoted_and_business_state_is_unchanged() {
    let mut cfg = config("a", "intel", json!(100));
    cfg["actualParts"][0]["erp"] = json!(1);
    cfg["actualParts"][0]["erpUpdatedAt"] = json!("2026-10-13");
    let store = fixture(json!([cfg]));
    let before = state(&db(&store.path).unwrap()).unwrap();
    let r = report(&store, &start(&store, "offline-erp", &["a"]));
    let erp = result(&r, "erp");
    assert_eq!(erp["valid"], false);
    assert_eq!(erp["profit_cents"], Value::Null);
    assert_eq!(erp["details"]["costAt"], Value::Null);
    assert_eq!(erp["details"]["parts"][0]["unitCostCents"], Value::Null);
    assert_eq!(state(&db(&store.path).unwrap()).unwrap(), before);
}

#[test]
fn request_retry_is_idempotent_and_reuse_for_another_scope_is_rejected() {
    let store = fixture(json!([
        config("a", "intel", json!(100)),
        config("b", "intel", json!(100))
    ]));
    let first = start(&store, "idempotent-1", &["a"]);
    edit(&store, |v| v["configs"][0]["price"] = json!(2000));
    let retry = start(&store, "idempotent-1", &["a"]);
    assert_eq!(retry["runId"], first["runId"]);
    assert_eq!(retry["repeated"], true);
    let bad = profit_start(
        &store,
        &json!({"shopId":"intel","requestId":"idempotent-1","configIds":["b"]}),
    )
    .unwrap();
    assert_eq!(bad.status, 409);
    let c = db(&store.path).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM local_profit_results", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn request_retry_reordered_selection_keeps_the_same_committed_run() {
    let store = fixture(json!([
        config("a", "intel", json!(100)),
        config("b", "intel", json!(100))
    ]));
    let first = start(&store, "reordered-idem", &["b", "a"]);
    edit(&store, |v| v["configs"][0]["price"] = json!(2000));
    let retry = start(&store, "reordered-idem", &["a", "b"]);
    assert_eq!(retry["runId"], first["runId"]);
    assert_eq!(retry["repeated"], true);
    let c = db(&store.path).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM local_profit_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn successful_reset_retry_cannot_move_a_newer_anchor() {
    let store = fixture(json!([config("a", "intel", json!(700))]));
    let first = report(&store, &start(&store, "reset-replay-first", &["a"]));
    let input = json!({"shopId":"intel","configId":"a","metric":"accounting",
        "resultId":result(&first,"accounting")["id"],"requestId":"reset-replay"});
    assert_eq!(profit_reset(&store, &input).unwrap().status, 200);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = json!(500)
    });
    let next = report(&store, &start(&store, "reset-replay-next", &["a"]));
    assert_eq!(result(&next, "accounting")["changed"], true);
    assert_eq!(profit_reset(&store, &input).unwrap().status, 200);
    let c = db(&store.path).unwrap();
    let anchor: String = c
        .query_row(
            "SELECT anchor_id FROM local_profit_baselines WHERE metric='accounting'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(anchor, result(&next, "accounting")["id"].as_str().unwrap());
    let mut different = input;
    different["resultId"] = result(&next, "accounting")["id"].clone();
    assert_eq!(profit_reset(&store, &different).unwrap().status, 409);
}

#[test]
fn shop_selection_and_history_are_isolated() {
    let mut deleted = config("deleted", "intel", json!(100));
    deleted["deletedAt"] = json!("2026");
    let mut template = config("template", "intel", json!(100));
    template["productCategory"] = json!("主机模板");
    let store = fixture(json!([
        config("a", "intel", json!(100)),
        config("other", "jonsbo", json!(100)),
        deleted,
        template
    ]));
    for ids in [
        json!([]),
        json!(["a", "a"]),
        json!(["other"]),
        json!(["deleted"]),
        json!(["template"]),
    ] {
        let bad = profit_start(
            &store,
            &json!({"requestId":"bad-scope","shopId":"intel","configIds":ids}),
        );
        assert!(bad.is_err() || bad.unwrap().status >= 400);
    }
    let started = start(&store, "scope-test", &["a"]);
    assert_eq!(
        profit_status(&store, &json!({"shopId":"jonsbo","runId":started["runId"]}))
            .unwrap()
            .status,
        404
    );
    let history: Value = serde_json::from_str(
        &profit_history(&store, &json!({"shopId":"jonsbo"}))
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(history["runs"], json!([]));
}

#[test]
fn reset_rejects_stale_invalid_and_changed_config_but_retries_safely() {
    let store = fixture(json!([config("a", "intel", json!(700))]));
    let first = report(&store, &start(&store, "reset-first", &["a"]));
    let id = result(&first, "accounting")["id"].clone();
    let input = json!({"shopId":"intel","configId":"a","metric":"accounting","resultId":id,"requestId":"reset-idem"});
    assert_eq!(profit_reset(&store, &input).unwrap().status, 200);
    assert_eq!(profit_reset(&store, &input).unwrap().status, 200);
    let mut bad = input.clone();
    bad["requestId"] = json!("reset-new");
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = json!(600)
    });
    assert_eq!(profit_reset(&store, &bad).unwrap().status, 409);
    let second = report(&store, &start(&store, "reset-second", &["a"]));
    assert_eq!(result(&second, "accounting")["configUpdated"], false);
    assert_eq!(profit_reset(&store, &bad).unwrap().status, 409);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = Value::Null
    });
    start(&store, "reset-invalid", &["a"]);
    bad["resultId"] = result(&second, "accounting")["id"].clone();
    assert_eq!(profit_reset(&store, &bad).unwrap().status, 409);
    bad["metric"] = json!("erp");
    bad["resultId"] = result(&second, "erp")["id"].clone();
    assert_eq!(profit_reset(&store, &bad).unwrap().status, 409);
}

#[test]
fn failed_result_write_rolls_back_entire_run_and_baselines() {
    let store = fixture(json!([config("a", "intel", json!(100))]));
    let c = db(&store.path).unwrap();
    schema(&c).unwrap();
    c.execute_batch("CREATE TRIGGER fail_accounting BEFORE INSERT ON local_profit_results WHEN NEW.metric='accounting' BEGIN SELECT RAISE(ABORT,'injected disk/write failure'); END;").unwrap();
    assert!(
        profit_start(
            &store,
            &json!({"shopId":"intel","requestId":"rollback-test","configIds":["a"]})
        )
        .is_err()
    );
    for table in [
        "local_profit_runs",
        "local_profit_results",
        "local_profit_baselines",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn current_content_hash_and_cost_change_causes_are_reported() {
    let store = fixture(json!([config("a", "intel", json!(700))]));
    let run = start(&store, "causes-first", &["a"]);
    edit(&store, |v| {
        v["configs"][0]["actualParts"][0]["tax"] = json!(600);
        v["configs"][0]["price"] = json!(1100);
    });
    assert_eq!(
        result(&report(&store, &run), "accounting")["configUpdated"],
        true
    );
    let next = report(&store, &start(&store, "causes-second", &["a"]));
    let row = result(&next, "accounting");
    assert_eq!(row["previous_delta_cents"], 19600);
    assert_eq!(row["details"]["priceImpactCents"], 9600);
    assert_eq!(row["details"]["causes"][0]["profitImpactCents"], 10000);
}

#[test]
fn selected_thousand_configurations_persist_two_independent_results_each() {
    let configs: Vec<_> = (0..1000)
        .map(|i| config(&format!("cfg-{i}"), "intel", json!(700)))
        .collect();
    let store = fixture(json!(configs));
    let ids: Vec<_> = configs.iter().map(|c| c["id"].as_str().unwrap()).collect();
    let timer = std::time::Instant::now();
    let run = start(&store, "thousand-selection", &ids);
    eprintln!(
        "1000 configurations offline profit transaction: {:.1} ms",
        timer.elapsed().as_secs_f64() * 1000.0
    );
    let report = report(&store, &run);
    assert_eq!(report["results"].as_array().unwrap().len(), 2000);
    let c = db(&store.path).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM local_profit_baselines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1000
    );
}
