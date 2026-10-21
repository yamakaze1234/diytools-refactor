use super::*;

#[test]
fn integer_identities_preserve_raw_precision_and_string_leading_zeroes() {
    let (s, c) = fixture();
    // 超过 u64 的整数必须使用 JSON 原文，不能经 SQLite REAL 或浮点转回字符串。
    let raw = r#"{"id":"numeric","shopId":"intel","skuId":123456789012345678901234567890,"spu":123456789012345678901234567890,"parts":[{"goodsId":123456789012345678901234567890}]}"#;
    c.execute(
        "INSERT INTO workbench_configs VALUES('numeric',6,?1)",
        [raw],
    )
    .unwrap();
    for key in ["sku", "spu", "goodsId"] {
        let found = dispatch(
            &s,
            "configs.find",
            &json!({key:"123456789012345678901234567890"}),
        )
        .unwrap();
        assert_eq!(found["items"][0]["id"], "numeric");
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            dispatch(
                &s,
                "configs.find",
                &json!({key:"0123456789012345678901234567890"})
            )
            .unwrap()["items"],
            json!([])
        );
    }
    for value in [
        json!(123),
        json!(123.0),
        json!(true),
        json!([123]),
        json!({"id":123}),
    ] {
        let row = json!({"id":"types","skuId":value,"spu":value,"parts":[{"goodsId":value}]});
        c.execute(
            "INSERT OR REPLACE INTO workbench_configs VALUES('types',7,?1)",
            [row.to_string()],
        )
        .unwrap();
        for key in ["sku", "spu", "goodsId"] {
            let found = dispatch(&s, "configs.find", &json!({key:"123"})).unwrap();
            assert_eq!(
                found["items"].as_array().unwrap().len(),
                usize::from(value == json!(123) && value.is_i64())
            );
            assert_eq!(
                dispatch(&s, "configs.find", &json!({key:"00123"})).unwrap()["items"],
                json!([])
            );
        }
    }
}

#[test]
fn deletion_marker_false_values_are_active_and_true_values_are_hidden() {
    let (s, c) = fixture();
    for marker in [
        Value::Null,
        json!(""),
        json!(false),
        json!(0),
        json!(0.0),
        json!("deleted"),
        json!(true),
        json!(1),
        json!([]),
        json!({}),
    ] {
        let row = json!({"id":"marker","skuId":"marker-sku","deletedAt":marker,"parts":[]});
        c.execute(
            "INSERT OR REPLACE INTO workbench_configs VALUES('marker',6,?1)",
            [row.to_string()],
        )
        .unwrap();
        let active = marker.is_null()
            || marker == json!("")
            || marker == json!(false)
            || marker.as_f64() == Some(0.0);
        let found = dispatch(&s, "configs.find", &json!({"sku":"marker-sku"})).unwrap();
        assert_eq!(
            found["items"].as_array().unwrap().len(),
            usize::from(active),
            "marker {marker}"
        );
        let detail = dispatch(&s, "configs.get", &json!({"configId":"marker"}));
        assert_eq!(detail.is_ok(), active, "marker {marker}");
        if !active {
            assert_eq!(detail.unwrap_err().code, "NOT_FOUND");
        }
    }
}

#[test]
fn legacy_shop_defaults_and_real_cost_fields_are_projected() {
    let (s, c) = fixture();
    let legacy = json!({"id":"legacy","name":"旧配置","parts":[{"goodsId":"old","upgrade":"升级说明","erp":99,"tax":110,"specialComponent":false,"enabled":true,"taxOverride":{"goodsId":"old","value":110,"base":100,"token":"nested-secret"},"costCents":777}]});
    c.execute(
        "INSERT INTO workbench_configs VALUES('legacy',6,?1)",
        [legacy.to_string()],
    )
    .unwrap();
    let named = json!({"id":"legacy-name","shop":"乔思伯官方旗舰店","parts":[]});
    c.execute(
        "INSERT INTO workbench_configs VALUES('legacy-name',7,?1)",
        [named.to_string()],
    )
    .unwrap();
    let found = dispatch(
        &s,
        "configs.find",
        &json!({"shopId":"intel","goodsId":"old"}),
    )
    .unwrap();
    assert_eq!(found["items"][0]["id"], "legacy");
    assert_eq!(found["items"][0]["shopId"], "intel");
    assert_eq!(
        dispatch(
            &s,
            "configs.find",
            &json!({"shopId":"jonsbo","goodsId":"old"})
        )
        .unwrap()["items"],
        json!([])
    );
    let detail = dispatch(&s, "configs.get", &json!({"configId":"legacy"})).unwrap();
    assert_eq!(
        detail["shop"],
        json!({"id":"intel","name":"英特尔官方旗舰店"})
    );
    let part = &detail["config"]["parts"][0];
    assert_eq!(part["upgrade"], "升级说明");
    assert_eq!(part["erp"], 99);
    assert_eq!(part["tax"], 110);
    assert_eq!(part["specialComponent"], false);
    assert_eq!(part["enabled"], true);
    assert_eq!(
        part["taxOverride"],
        json!({"goodsId":"old","value":110,"base":100})
    );
    assert!(part.get("costCents").is_none());
    assert!(!detail.to_string().contains("secret"));
    let named_detail = dispatch(&s, "configs.get", &json!({"configId":"legacy-name"})).unwrap();
    assert_eq!(named_detail["shop"]["id"], "jonsbo");
    assert!(
        dispatch(&s, "configs.find", &json!({"shopId":"jonsbo"})).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "legacy-name")
    );
}

fn fixture() -> (WorkbenchStore, Connection) {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/agent-query-tests");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE workbench_metadata(id INTEGER PRIMARY KEY,document TEXT); CREATE TABLE workbench_configs(id TEXT PRIMARY KEY,position INTEGER,document TEXT); CREATE TABLE workbench_config_projection(id TEXT);").unwrap();
    c.execute(
        "INSERT INTO workbench_metadata VALUES(1,?1)",
        [json!({"revision":7,"updatedAt":"saved","cloudToken":"metadata-secret"}).to_string()],
    )
    .unwrap();
    let rows = [
        json!({"id":"01","shopId":"intel","skuId":"001","spu":"0001","productId":"link-1","product":"链接","productUrl":"https://example.test/p","parts":[{"goodsId":"DISPLAY","name":"展示","token":"part-secret"}],"actualParts":[{"goodsId":"0009","name":"实际","qty":2,"credentials":{"x":"secret"}}],"token":"config-secret"}),
        json!({"id":"02","shopId":"intel","parts":[{"goodsId":"0009"}]}),
        json!({"id":"03","shopId":"jonsbo","skuId":"001","parts":[{"goodsId":"0009"}],"actualParts":[]}),
        json!({"id":"04","shopId":"jonsbo","skuId":"001","parts":[{"goodsId":"0009"}],"actualParts":null}),
        json!({"id":"05","shopId":"intel","skuId":1,"parts":[{"goodsId":9}],"deletedAt":"deleted"}),
    ];
    for (position, row) in rows.iter().enumerate() {
        c.execute(
            "INSERT INTO workbench_configs VALUES(?1,?2,?3)",
            params![
                row["id"].as_str().unwrap(),
                position as i64,
                row.to_string()
            ],
        )
        .unwrap();
    }
    (WorkbenchStore { path, assets: root }, c)
}

#[test]
fn exact_ids_shop_isolation_and_actual_bom_semantics() {
    let (s, _c) = fixture();
    let found = dispatch(
        &s,
        "configs.find",
        &json!({"shopId":"intel","goodsId":"0009"}),
    )
    .unwrap();
    assert_eq!(
        found["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["01", "02"]
    );
    assert!(found["items"][1].get("skuId").is_none());
    let jonsbo = dispatch(
        &s,
        "configs.find",
        &json!({"shopId":"jonsbo","goodsId":"0009"}),
    )
    .unwrap();
    assert_eq!(jonsbo["items"].as_array().unwrap().len(), 1);
    assert_eq!(jonsbo["items"][0]["id"], "04");
    for filter in [
        json!({"goodsId":"DISPLAY"}),
        json!({"goodsId":"9"}),
        json!({"sku":"1"}),
        json!({"spu":"1"}),
    ] {
        assert_eq!(
            dispatch(&s, "configs.find", &filter).unwrap()["items"],
            json!([])
        );
    }
    assert_eq!(
        dispatch(
            &s,
            "configs.find",
            &json!({"shopId":"intel","sku":"001","spu":"0001"})
        )
        .unwrap()["items"][0]["id"],
        "01"
    );
}

#[test]
fn pagination_requires_saved_revision_and_rejects_changed_snapshot() {
    let (s, c) = fixture();
    let first = dispatch(&s, "configs.find", &json!({"limit":1})).unwrap();
    assert_eq!(first["nextOffset"], 1);
    let next = dispatch(
        &s,
        "configs.find",
        &json!({"limit":1,"offset":1,"revision":7}),
    )
    .unwrap();
    assert_eq!(next["items"][0]["id"], "02");
    assert_eq!(
        dispatch(&s, "configs.find", &json!({"offset":1}))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
    c.execute(
        "UPDATE workbench_metadata SET document=json_set(document,'$.revision',8)",
        [],
    )
    .unwrap();
    assert_eq!(
        dispatch(&s, "configs.find", &json!({"offset":1,"revision":7}))
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
}

#[test]
fn invalid_params_unknown_methods_and_missing_config_are_rejected() {
    let (s, _c) = fixture();
    for (method, p) in [
        ("status", json!({"sql":"SELECT 1"})),
        ("shops.list", json!(null)),
        ("configs.find", json!({"shopId":1})),
        ("configs.find", json!({"goodsId":""})),
        ("configs.find", json!({"sku":null})),
        ("configs.find", json!({"limit":0})),
        ("configs.find", json!({"limit":101})),
        ("configs.find", json!({"limit":1.5})),
        ("configs.find", json!({"offset":-1})),
        ("configs.find", json!({"revision":"7"})),
        ("configs.get", json!({})),
        ("configs.get", json!({"configId":1})),
        ("configs.get", json!({"configId":"01","sql":"SELECT 1"})),
    ] {
        assert_eq!(dispatch(&s, method, &p).unwrap_err().code, "INVALID_PARAMS");
    }
    assert_eq!(
        dispatch(&s, "configs.write", &json!({})).unwrap_err().code,
        "METHOD_NOT_FOUND"
    );
    for id in ["missing", "05"] {
        assert_eq!(
            dispatch(&s, "configs.get", &json!({"configId":id}))
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
    }
}

#[test]
fn reads_preserve_database_and_never_expose_unknown_secrets() {
    let (s, c) = fixture();
    let before = std::fs::read(&s.path).unwrap();
    for (method, p) in [
        ("status", json!({})),
        ("shops.list", json!({})),
        ("configs.find", json!({})),
        ("configs.get", json!({"configId":"01"})),
    ] {
        let value = dispatch(&s, method, &p).unwrap();
        let raw = value.to_string();
        for secret in ["secret", "credentials", "cloudToken", "token"] {
            assert!(!raw.contains(secret), "{method} exposed {secret}");
        }
    }
    let status = dispatch(&s, "status", &json!({})).unwrap();
    assert_eq!(status["savedRevision"], 7);
    assert_eq!(status["cloudSyncStatus"], "unknown");
    assert_eq!(status["cloudSyncChecked"], false);
    let detail = dispatch(&s, "configs.get", &json!({"configId":"01"})).unwrap();
    assert_eq!(detail["config"]["actualParts"][0]["goodsId"], "0009");
    assert_eq!(detail["config"]["parts"][0]["goodsId"], "DISPLAY");
    assert_eq!(detail["shop"]["name"], "英特尔官方旗舰店");
    assert_eq!(detail["link"]["id"], "link-1");
    assert_eq!(
        c.query_row::<i64, _, _>(
            "SELECT count(*) FROM workbench_config_projection",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(std::fs::read(&s.path).unwrap(), before);
}
