// SQL 同步回归：验证旧业务口径、人工价保护、预览过期、来源隔离和事务失败回滚。
use super::*;

const GOODS: &str = "9007199254740993";

fn fixture() -> WorkbenchStore {
    let root = PathBuf::from("D:/diytools/sandbox/sql-store-tests").join(unique());
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.json");
    fs::write(&source, initial().to_string()).unwrap();
    initialize(
        &root.join("workbench.sqlite"),
        &source,
        &root.join("assets"),
    )
    .unwrap()
}

fn initial() -> Value {
    json!({"revision":7,"updatedAt":"old","configs":[
        {"id":"active","parts":[{"goodsId":GOODS,"name":"展示名","tax":510,"taxOverride":{"price":510},"erp":500,"stockAvailable":6}],
        "actualParts":[{"goodsId":GOODS,"name":"实际名","tax":510,"erp":500,"stockAvailable":6},{"goodsId":"2","name":"缺失商品","tax":90,"erp":80,"stockAvailable":70},{"goodsId":"","specialComponent":true,"erp":0,"tax":0}]},
        {"id":"deleted","deletedAt":"old","parts":[{"goodsId":GOODS,"erp":500,"stockAvailable":100,"tax":510}]}],
        "sourceCatalog":[{"goodsId":GOODS,"name":"输出优化名","tax":510,"erp":500,"stockAvailable":6}],"costSource":[],"templates":[],"logs":[{"id":"archived"}],
        "erpSync":{"scope":"original-erp-scope","costUpdatedAt":"keep-cost-time"}})
}

fn rows() -> Value {
    json!([
        {"goodsId":GOODS,"name":"CPU","erp":345,"stockAvailable":3},
        {"goodsId":"3","name":"未知库存","erp":null,"stockAvailable":null},
        {"goodsId":"4","name":"停用*","erp":10,"stockAvailable":20}])
}

fn settings() -> Value {
    json!({"server":"SQLHost","port":1433,"database":"ERP"})
}

#[test]
fn plan_preserves_manual_cost_names_bom_missing_and_asterisk_policy() {
    let before = initial();
    let plan = stock_plan(&before, &rows(), "fixed-time").unwrap();
    assert_eq!(
        plan.summary,
        json!({"total":3,"matched":5,"unmatched":1,"unknown":1})
    );
    assert_eq!(plan.config_ids, ["active"]);
    assert_eq!(plan.changes.len(), 4); // new unknown row starts with the same null observations.
    assert_eq!(plan.next["costSource"].as_array().unwrap().len(), 2);
    assert_eq!(plan.next["costSource"][0]["tax"], 510);
    let part = &plan.next["configs"][0]["parts"][0];
    assert_eq!(part["tax"], 510);
    assert_eq!(
        part["taxOverride"],
        before["configs"][0]["parts"][0]["taxOverride"]
    );
    assert_eq!(part["name"], "展示名");
    assert_eq!(part["erp"], 345);
    assert_eq!(part["stockAvailable"], 3);
    assert_eq!(plan.next["configs"][0]["actualParts"][0]["name"], "实际名");
    assert_eq!(
        plan.next["configs"][0]["actualParts"][1]["erpMissing"],
        true
    );
    assert_eq!(
        plan.next["configs"][0]["actualParts"][1]["stockAvailable"],
        70
    );
    assert_eq!(plan.next["configs"][1], before["configs"][1]);
    assert_eq!(
        plan.next["configs"][0]["actualParts"][2],
        before["configs"][0]["actualParts"][2]
    );
    assert_eq!(plan.next["sharedCostScope"], "original-erp-scope");
    assert_eq!(before, initial());
}

#[test]
fn unknown_is_null_and_saved_starred_parts_still_refresh() {
    let mut before = initial();
    before["configs"][0]["parts"][0]["name"] = "旧件＊".into();
    let plan = stock_plan(
        &before,
        &json!([{"goodsId":GOODS,"name":"CPU*","erp":null,"stockAvailable":null}]),
        "fixed-time",
    )
    .unwrap();
    let part = &plan.next["configs"][0]["parts"][0];
    assert_eq!(part["erp"], Value::Null);
    assert_eq!(part["stockAvailable"], Value::Null);
    assert_eq!(part["erpUnknown"], true);
    assert_eq!(part["erpMissing"], false);
    assert_eq!(part["tax"], 510);
    assert_eq!(plan.next["costSource"], json!([]));
}

#[test]
fn preview_is_business_read_only_and_apply_persists_history_receipt_and_status() {
    let store = fixture();
    let before = full_state(&db(&store.path).unwrap()).unwrap();
    let preview = sql_preview(&store, rows(), &settings(), "测试操作员").unwrap();
    assert_eq!(before, full_state(&db(&store.path).unwrap()).unwrap());
    assert_eq!(preview["source"]["server"], "SQLHost");
    let result = sql_apply(&store, preview["id"].as_str().unwrap()).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["revision"], 8);
    assert_eq!(result["summary"]["warehouse"], "公司大库");
    let connection = db(&store.path).unwrap();
    let after = full_state(&connection).unwrap();
    assert_eq!(after["erpSync"]["scope"], "original-erp-scope");
    assert_eq!(after["erpSync"]["costUpdatedAt"], "keep-cost-time");
    assert_eq!(after["sqlSync"], result["summary"]);
    assert_eq!(after["logs"][0]["operator"], "测试操作员");
    let history: i64 = connection
        .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
        .unwrap();
    assert_eq!(history, 2);
    let receipt: String = connection
        .query_row(
            "SELECT document FROM workbench_receipts WHERE operation=?1",
            [format!("sql-sync:{}", preview["id"].as_str().unwrap())],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&receipt).unwrap(), result);
    assert_eq!(
        sql_status(&store).unwrap()["lastSuccess"]["stockUpdatedAt"],
        result["updatedAt"]
    );
    assert_eq!(sql_status(&store).unwrap()["sqlSync"], result["summary"]);
    let restored = reconstruct(&connection, 1).unwrap();
    assert_eq!(restored, state_from_initial());
    assert!(sql_apply(&store, preview["id"].as_str().unwrap()).is_err());
    assert_eq!(after, full_state(&db(&store.path).unwrap()).unwrap());
}

fn state_from_initial() -> Value {
    let mut value = initial();
    value.as_object_mut().unwrap().remove("logs");
    value
}

#[test]
fn stale_configuration_expired_preview_and_previous_read_are_rejected_atomically() {
    let store = fixture();
    let preview = sql_preview(&store, rows(), &settings(), "operator").unwrap();
    let mut changed = state(&db(&store.path).unwrap()).unwrap();
    changed["configs"][0]["name"] = "用户随后改名".into();
    entities::replace_fixture(&db(&store.path).unwrap(), &changed);
    assert!(
        sql_apply(&store, preview["id"].as_str().unwrap())
            .unwrap_err()
            .contains("变化")
    );
    assert_eq!(changed, state(&db(&store.path).unwrap()).unwrap());
    let first = sql_preview(&store, rows(), &settings(), "operator").unwrap();
    let second = sql_preview(&store, rows(), &settings(), "operator").unwrap();
    assert!(sql_apply(&store, first["id"].as_str().unwrap()).is_err());
    db(&store.path)
        .unwrap()
        .execute(
            "UPDATE workbench_sql_previews SET expires_at=0 WHERE id=?1",
            [second["id"].as_str().unwrap()],
        )
        .unwrap();
    assert!(sql_apply(&store, second["id"].as_str().unwrap()).is_err());
    assert_eq!(changed, state(&db(&store.path).unwrap()).unwrap());
    assert_eq!(
        db(&store.path)
            .unwrap()
            .query_row("SELECT count(*) FROM workbench_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn scope_matches_legacy_digest_case_and_port_string_but_refuses_changed_database() {
    let store = fixture();
    let preview = sql_preview(&store, rows(), &settings(), "operator").unwrap();
    let applied = sql_apply(&store, preview["id"].as_str().unwrap()).unwrap();
    // SHA256 of {"server":"sqlhost","port":1433,"database":"erp"} with exact legacy key order.
    let scope = format!(
        "{:x}",
        Sha256::digest(br#"{"server":"sqlhost","port":1433,"database":"erp"}"#)
    );
    assert_eq!(applied["scope"], scope);
    let mut other = settings();
    other["server"] = "sqlHOST".into();
    other["port"] = "1433".into();
    assert!(sql_validate_source(&store, &other).is_ok());
    other["database"] = "other".into();
    let before = state(&db(&store.path).unwrap()).unwrap();
    assert!(sql_validate_source(&store, &other).is_err());
    assert!(sql_preview(&store, rows(), &other, "operator").is_err());
    assert_eq!(before, state(&db(&store.path).unwrap()).unwrap());
}

#[test]
fn invalid_normalized_rows_and_conflicting_manual_prices_are_not_silently_coerced() {
    let store = fixture();
    for invalid in [
        json!([]),
        json!([{"goodsId":9007199254740993u64,"name":"CPU","erp":1,"stockAvailable":1}]),
        json!([{"goodsId":"1","name":"CPU","erp":-1,"stockAvailable":1}]),
        json!([{"goodsId":"1","name":"CPU","erp":1}]),
    ] {
        assert!(sql_preview(&store, invalid, &settings(), "operator").is_err());
    }
    assert_eq!(
        state(&db(&store.path).unwrap()).unwrap(),
        state_from_initial()
    );
    let mut before = initial();
    before["configs"][0]["actualParts"][0]["tax"] = 520.into();
    let plan = stock_plan(&before, &rows(), "fixed-time").unwrap();
    assert_eq!(plan.next["costSource"][0]["tax"], Value::Null);
    assert_eq!(plan.next["configs"][0]["actualParts"][0]["tax"], 520);
}

#[test]
fn plan_equals_captured_legacy_js_oracle() {
    // Captured by running the original prototype/sql-sync.mjs sqlStockPlan on
    // initial()/rows() at fixed-time. This guards the complete field contract.
    let oracle: Value = serde_json::from_str(r#"{"next":{"revision":7,"updatedAt":"old","configs":[{"id":"active","parts":[{"goodsId":"9007199254740993","name":"展示名","tax":510,"taxOverride":{"price":510},"erp":345,"stockAvailable":3,"stockUpdatedAt":"fixed-time","stockSource":"company-sql","erpMissing":false,"erpUnknown":false,"erpUpdatedAt":"fixed-time"}],"actualParts":[{"goodsId":"9007199254740993","name":"实际名","tax":510,"erp":345,"stockAvailable":3,"stockUpdatedAt":"fixed-time","stockSource":"company-sql","erpMissing":false,"erpUnknown":false,"erpUpdatedAt":"fixed-time"},{"goodsId":"2","name":"缺失商品","tax":90,"erp":80,"stockAvailable":70,"erpMissing":true},{"goodsId":"","specialComponent":true,"erp":0,"tax":0}]},{"id":"deleted","deletedAt":"old","parts":[{"goodsId":"9007199254740993","erp":500,"stockAvailable":100,"tax":510}]}],"sourceCatalog":[{"goodsId":"9007199254740993","name":"输出优化名","tax":510,"erp":345,"stockAvailable":3,"stockUpdatedAt":"fixed-time","stockSource":"company-sql","erpMissing":false,"erpUnknown":false,"erpUpdatedAt":"fixed-time"}],"costSource":[{"goodsId":"9007199254740993","name":"CPU","tax":510,"erp":345,"stockAvailable":3,"localInventoryOnly":true,"stockUpdatedAt":"fixed-time","stockSource":"company-sql","erpMissing":false,"erpUnknown":false,"erpUpdatedAt":"fixed-time"},{"goodsId":"3","name":"未知库存","tax":null,"erp":null,"stockAvailable":null,"localInventoryOnly":true,"stockUpdatedAt":"fixed-time","stockSource":"company-sql","erpMissing":false,"erpUnknown":true,"erpUpdatedAt":"fixed-time"}],"templates":[],"logs":[{"id":"archived"}],"erpSync":{"scope":"original-erp-scope","costUpdatedAt":"keep-cost-time"},"sharedCostScope":"original-erp-scope"},"changes":[{"erpBefore":500,"erpAfter":345,"area":"输出源","goodsId":"9007199254740993","name":"输出优化名","before":6,"after":3},{"erpBefore":null,"erpAfter":345,"area":"成本源","goodsId":"9007199254740993","name":"CPU","before":null,"after":3},{"erpBefore":500,"erpAfter":345,"area":"配置","configId":"active","goodsId":"9007199254740993","name":"展示名","before":6,"after":3},{"erpBefore":500,"erpAfter":345,"area":"配置","configId":"active","goodsId":"9007199254740993","name":"实际名","before":6,"after":3}],"matched":5,"unmatched":1,"configIds":["active"],"unknown":1,"total":3}"#).unwrap();
    let plan = stock_plan(&initial(), &rows(), "fixed-time").unwrap();
    let mut result = plan.summary;
    result["next"] = plan.next;
    result["changes"] = plan.changes.into();
    result["configIds"] = plan.config_ids.into();
    assert_eq!(result, oracle);
}

#[test]
fn integer_and_float_observations_follow_js_numeric_comparison() {
    let mut before = initial();
    before["configs"][0]["actualParts"][0]["tax"] = json!(510.0);
    let plan = stock_plan(
        &before,
        &json!([{"goodsId":GOODS,"name":"CPU","erp":500.0,"stockAvailable":6.0}]),
        "fixed-time",
    )
    .unwrap();
    assert_eq!(plan.changes.len(), 1); // Only the newly introduced cost-source row.
    assert_eq!(plan.next["costSource"][0]["tax"], 510);
}

#[test]
fn receipt_write_failure_rolls_back_state_history_and_consumption() {
    let store = fixture();
    let preview = sql_preview(&store, rows(), &settings(), "operator").unwrap();
    let id = preview["id"].as_str().unwrap();
    let connection = db(&store.path).unwrap();
    connection
        .execute(
            "INSERT INTO workbench_receipts(operation,hash,document) VALUES(?1,'collision','{}')",
            [format!("sql-sync:{id}")],
        )
        .unwrap();
    let before = full_state(&connection).unwrap();
    assert!(sql_apply(&store, id).is_err());
    assert_eq!(before, full_state(&connection).unwrap());
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM workbench_history", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        !connection
            .query_row(
                "SELECT applied FROM workbench_sql_previews WHERE id=?1",
                [id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    connection
        .execute(
            "DELETE FROM workbench_receipts WHERE operation=?1",
            [format!("sql-sync:{id}")],
        )
        .unwrap();
    assert!(sql_apply(&store, id).is_ok());
}

/// Explicit development-only evidence probe. The parent creates this SQLite
/// backup; this test never discovers or opens the user's running database.
#[test]
#[ignore = "requires private SQL observations and an explicitly prepared isolated SQLite backup"]
fn live_sql_observations_apply_to_isolated_backup() {
    let root = PathBuf::from("D:/diytools/sandbox/sql-live-20261012");
    let release_probe = std::env::var("DIYTOOLS_SQL_PROBE_RELEASE").as_deref() == Ok("1");
    let isolated_path = root.join(if release_probe {
        "isolated-release-workbench.sqlite"
    } else {
        "isolated-workbench.sqlite"
    });
    assert!(
        isolated_path.is_file(),
        "prepare the isolated backup before running this probe"
    );
    let observations: Value =
        serde_json::from_slice(&fs::read(root.join("observations.private.json")).unwrap()).unwrap();
    let store = WorkbenchStore {
        path: isolated_path,
        // SQL synchronization never accesses assets. An unused path prevents
        // accidental asset access from touching the existing release directory.
        assets: root.join("unused-assets"),
    };
    let before = state(&db(&store.path).unwrap()).unwrap();
    let revision_before = revision(&before);
    let timer = std::time::Instant::now();
    let preview = sql_preview(
        &store,
        observations["rows"].clone(),
        &observations["settings"],
        "SQL隔离验收",
    )
    .unwrap();
    let preview_ms = timer.elapsed().as_secs_f64() * 1000.0;
    assert!(
        before == state(&db(&store.path).unwrap()).unwrap(),
        "preview modified business state"
    );
    let timer = std::time::Instant::now();
    let applied = sql_apply(&store, preview["id"].as_str().unwrap()).unwrap();
    let apply_ms = timer.elapsed().as_secs_f64() * 1000.0;
    // Reopening the connection exercises persisted state instead of the plan.
    let after = state(&db(&store.path).unwrap()).unwrap();
    assert_eq!(revision(&after), revision_before + 1);
    assert!(applied["ok"] == true, "apply did not acknowledge success");
    assert!(
        after["erpSync"]["sqlSync"] == applied["summary"],
        "ERP manifest was not persisted"
    );
    assert!(
        after["sqlSync"] == applied["summary"],
        "SQL summary was not persisted"
    );
    assert!(
        after["erpSync"]["stockSource"] == "company-sql",
        "SQL source marker was not persisted"
    );
    assert!(
        after["erpSync"]["stockUpdatedAt"] == applied["updatedAt"],
        "SQL observation timestamp differs"
    );
    let local_fields = [
        "erp",
        "erpMissing",
        "erpUnknown",
        "erpUpdatedAt",
        "stockAvailable",
        "stockUpdatedAt",
        "stockSource",
    ];
    let scrub = |value: &Value| {
        fn remove_local(value: &mut Value, fields: &[&str]) {
            match value {
                Value::Object(object) => {
                    for key in fields {
                        object.remove(*key);
                    }
                    for child in object.values_mut() {
                        remove_local(child, fields);
                    }
                }
                Value::Array(array) => {
                    for child in array {
                        remove_local(child, fields);
                    }
                }
                _ => {}
            }
        }
        let mut result = value.clone();
        remove_local(&mut result, &local_fields);
        result
    };
    // Removing only the seven permitted local-observation fields leaves tax,
    // taxOverride, independent actualParts, identities, layouts and names intact.
    assert!(
        scrub(&before["configs"]) == scrub(&after["configs"]),
        "an unrelated configuration field or manual price changed"
    );
    assert!(
        scrub(&before["sourceCatalog"]) == scrub(&after["sourceCatalog"]),
        "an unrelated output-source field or manual price changed"
    );
    let old_costs = before["costSource"].as_array().unwrap();
    let new_costs = after["costSource"].as_array().unwrap();
    assert!(
        new_costs.len() >= old_costs.len(),
        "cost-source rows disappeared"
    );
    assert!(
        scrub(&Value::Array(old_costs.clone()))
            == scrub(&Value::Array(new_costs[..old_costs.len()].to_vec())),
        "an existing cost-source field or manual price changed"
    );
    for (key, value) in before.as_object().unwrap() {
        if ![
            "configs",
            "sourceCatalog",
            "costSource",
            "sharedCostScope",
            "erpSync",
            "sqlSync",
            "revision",
            "updatedAt",
        ]
        .contains(&key.as_str())
        {
            assert!(
                after.get(key) == Some(value),
                "an unrelated workspace field changed"
            );
        }
    }
    let report = json!({
        "revisionBefore":revision_before,
        "revisionAfter":revision(&after),
        "previewMs":preview_ms,
        "applyMs":apply_ms,
        "total":preview["total"],
        "matched":preview["matched"],
        "unmatched":preview["unmatched"],
        "unknown":preview["unknown"],
        "changes":preview["changes"].as_array().unwrap().len(),
        "affectedConfigs":preview["configIds"].as_array().unwrap().len(),
        "configs":after["configs"].as_array().unwrap().len(),
        "existingCostRows":old_costs.len(),
        "costRowsAfter":new_costs.len()
    });
    fs::write(
        root.join(if release_probe {
            "isolated-release-apply-report.json"
        } else {
            "isolated-apply-report.json"
        }),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
}
