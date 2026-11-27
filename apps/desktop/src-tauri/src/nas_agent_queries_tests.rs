//! 店内目录、实际 BOM、权限联动和 033/034 兼容性均用合成数据核验。
use super::*;

struct Fixture {
    catalog: Value,
    shared: Value,
    docs: Vec<Value>,
    index: Value,
    source_version: String,
}
impl Fixture {
    fn new() -> Self {
        let catalog = json!({"sourceCatalog":[
            {"shopId":"intel","sourceId":"src-a","goodsId":"70","name":"线材 A","tax":0},
            {"shopId":"intel","sourceId":"src-b","goodsId":"70","name":"线材 B","tax":8},
            {"shopId":"gigabyte","sourceId":"foreign","goodsId":"70","name":"外店资料"},
            {"shopId":"intel","sourceId":"src-slot","goodsId":"71","name":"X 240"},
            {"shopId":"intel","sourceId":"src-name","goodsId":"72","name":"ＲＴＸ 4060"},
            {"shopId":"intel","sourceId":"src-special","goodsId":"","specialComponent":true,"name":"特殊件"}],
            "costSource":[{"goodsId":"70","erpCategory":"线材/扩展","erp":3,"stockAvailable":0,"stockIncomingAvailable":6}],"costVersions":{"70":"9"}});
        let shared = json!([{"id":"70","version":"2","document":{"common":{"name":"线材","tax":2},
            "stores":{"intel":[{"sourceId":"src-a","fields":{"name":"本店"}}],"gigabyte":[{"sourceId":"x","fields":{"name":"未授权名"}}]}}}]);
        let docs = vec![
            json!({"id":"1","parts":[{"goodsId":"70","sourceId":"src-a","slot":"配件1"}],"actualParts":[{"goodsId":"70","sourceId":"src-a"}],"addons":[]}),
            json!({"id":"2","parts":[],"actualParts":[{"goodsId":"70"},{"goodsId":"71","slot":"散热"}],"addons":[]}),
            json!({"id":"3","parts":[],"actualParts":[],"addons":[{"sourceId":"src-a"}]}),
            json!({"id":"4","parts":[],"actualParts":[{"goodsId":"14","sourceId":"src-a"}],"addons":[]}),
        ];
        let index = json!({"revision":"baseline","summaries":docs.iter().map(|d|json!({"id":d["id"],"parts":d["parts"]})).collect::<Vec<_>>()});
        Self {
            catalog,
            shared,
            docs,
            index,
            source_version: "1".into(),
        }
    }
    fn request(&self, method: &str, input: Value, stock: bool) -> Result<Value> {
        let p = SourceParams::parse(method, input.as_object().unwrap(), stock)?;
        sources(self, "intel", &p, true, &["intel"])
    }
}
impl SavedReads for Fixture {
    fn data(&self, route: &str, body: Option<&Value>) -> Result<Value> {
        assert!(route.ends_with("?shop_id=intel"));
        let path = route
            .split('?')
            .next()
            .unwrap()
            .strip_prefix("/api/v1/operations/")
            .unwrap();
        let wrapper = |doc: &Value| json!({"id":doc["sourceId"],"document":doc,"version":self.source_version,"owner_shop":"intel"});
        Ok(match path {
            "workspace-catalog" => self.catalog.clone(),
            "catalog/shared-sources" => self.shared.clone(),
            "catalog/sources" => {
                let mut rows = list(&self.catalog["sourceCatalog"])
                    .iter()
                    .map(wrapper)
                    .collect::<Vec<_>>();
                rows.push(wrapper(&json!({"shopId":"intel","sourceId":"archived","goodsId":"17","name":"已删","deletedAt":"2026-11-20"})));
                json!(rows)
            }
            "workspace/source-usage" => {
                let b = body.unwrap();
                let ids = list(&b["sources"]);
                let goods = list(&b["goods"]);
                self.docs
                    .iter()
                    .filter(|doc| {
                        list(&doc["parts"])
                            .iter()
                            .chain(list(&doc["actualParts"]))
                            .any(|p| ids.contains(&p["sourceId"]) || goods.contains(&p["goodsId"]))
                            || list(&doc["addons"])
                                .iter()
                                .any(|p| ids.contains(&p["sourceId"]))
                    })
                    .map(|doc| doc["id"].clone())
                    .collect()
            }
            path if path.starts_with("catalog/sources/") => wrapper(
                list(&self.catalog["sourceCatalog"])
                    .iter()
                    .find(|s| s["sourceId"] == path.trim_start_matches("catalog/sources/"))
                    .unwrap(),
            ),
            _ => panic!("意外查询 {path}"),
        })
    }
    fn index(&self) -> Result<Value> {
        Ok(self.index.clone())
    }
    fn detail(&self, row: &Value) -> Result<Value> {
        Ok(json!({"document":self.docs.iter().find(|d|d["id"]==row["id"]).unwrap()}))
    }
}
#[test]
fn sources_scope_alias_reference_and_categories() {
    let api = Fixture::new();
    let err = api
        .request("sources.get", json!({"goodsId":"70"}), true)
        .unwrap_err();
    assert_eq!(err.code, "AMBIGUOUS_SOURCE");
    assert!(err.message.contains(r#"["src-a","src-b"]"#));
    assert!(!err.message.contains("foreign"));
    let detail = api
        .request("sources.get", json!({"sourceId":"src-a"}), true)
        .unwrap()["source"]
        .take();
    assert_eq!(detail["category"], "其他配件");
    assert_eq!(detail["referenceCount"], 3);
    assert_eq!(detail["tax"], 0.);
    assert_eq!(detail["stockStatus"], "incoming");
    assert_eq!(detail["hasStoreDiff"], true);
    assert_eq!(detail["version"], "1");
    assert_eq!(detail["costVersion"], "9");
    assert!(!detail.to_string().contains("未授权名"));
    assert!(detail["storeOverrides"].get("gigabyte").is_none());
    for (category, id) in [
        ("散热", "src-slot"),
        ("显卡", "src-name"),
        ("特殊配件", "src-special"),
    ] {
        let page = api
            .request("sources.find", json!({"category":category}), true)
            .unwrap();
        assert_eq!(page["items"][0]["sourceId"], id);
    }
    let deleted = api
        .request("sources.find", json!({"filter":"deleted"}), true)
        .unwrap();
    assert_eq!(deleted["items"].as_array().unwrap().len(), 1);
    assert_eq!(deleted["items"][0]["sourceId"], "archived");
}
#[test]
fn sources_stock_gate_and_revision() {
    let mut api = Fixture::new();
    for q in [
        json!({"stockStatus":"incoming"}),
        json!({"filter":"shortage"}),
    ] {
        assert_eq!(
            api.request("sources.find", q, false).unwrap_err().code,
            "PERMISSION_DENIED"
        );
    }
    let result = api
        .request("sources.get", json!({"sourceId":"src-a"}), false)
        .unwrap();
    let row = &result["source"];
    assert!(row["stockAvailable"].is_null() && row["stockIncomingAvailable"].is_null());
    assert_eq!(row["stockRedacted"], true);
    assert!(row.get("stockStatus").is_none());
    let first = api
        .request("sources.find", json!({"limit":1}), true)
        .unwrap();
    assert_eq!(first["nextOffset"], 1);
    let next = json!({"limit":1,"offset":1,"revision":first["revision"]});
    assert_eq!(
        api.request("sources.find", next.clone(), true).unwrap()["items"][0]["sourceId"],
        "src-b"
    );
    let baseline = api.catalog.clone();
    api.source_version = "2".into();
    assert_eq!(
        api.request("sources.find", next.clone(), true)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    api.source_version = "1".into();
    api.catalog["costSource"][0]["stockAvailable"] = json!(15);
    assert_eq!(
        api.request("sources.find", next.clone(), true)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    api.catalog = baseline.clone();
    api.catalog["sourceCatalog"][0]["name"] = json!("改名");
    assert_eq!(
        api.request("sources.find", next.clone(), true)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    api.catalog = baseline;
    api.index["revision"] = json!("新索引");
    assert_eq!(
        api.request("sources.find", next, true).unwrap_err().code,
        "REVISION_CONFLICT"
    );
}
#[test]
fn activity_keeps_legacy_dates_and_rejects_unsupported_filters() {
    let query = |input: Value, reply: Result<Value>| {
        activity(input.as_object().unwrap(), "intel", |r| {
            let url = reqwest::Url::parse(&format!("https://localhost{r}")).unwrap();
            assert_eq!(url.path(), "/api/v1/operations/workspace/activity");
            let pairs = url.query_pairs().collect::<HashMap<_, _>>();
            assert_eq!(pairs["shop_id"], "intel");
            if let Some(actor) = input["actor"].as_str() {
                assert_eq!(pairs["actor"], actor);
            }
            reply
        })
    };
    let old = json!({"total":0,"page":0,"pageSize":30,"rows":[]});
    assert!(
        query(
            json!({"from":"2026-11-01","to":"2026-11-27"}),
            Ok(old.clone())
        )
        .is_ok()
    );
    for reply in [
        Ok(old),
        Err(AgentError::new("NAS_ACTIVITY_NOT_INSTALLED", "")),
        Err(AgentError::new("INVALID_REQUEST", "")),
    ] {
        assert_eq!(
            query(json!({"actor":"员工&A"}), reply).unwrap_err().code,
            "UNSUPPORTED_FILTER"
        );
    }
    let new = json!({"total":1,"page":0,"pageSize":30,"operators":[],"rows":[{"actor_uid":"员工&A","kind":"sources","detail":"额外字段"}]});
    let filtered = query(json!({"actor":"员工&A","kind":"sources"}), Ok(new)).unwrap();
    assert_eq!(filtered["rows"][0]["actor_uid"], "员工&A");
    assert!(filtered["rows"][0].get("detail").is_none());
    assert_eq!(
        query(json!({"from":"2026-02-29"}), Ok(Value::Null))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
}
