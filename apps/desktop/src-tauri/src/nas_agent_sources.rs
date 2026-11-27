//! 输出源目录与已保存 BOM 的店铺级投影。
use super::*;
use regex::Regex;

static CATEGORY_RULES: LazyLock<(HashMap<String, String>, Vec<(String, Regex)>)> =
    LazyLock::new(|| {
        // 工作表、库存模型与原生接口使用同一份 ERP 别名和有序名称规则。
        let data = include_str!("../../public/workbench/component-category-rules.js")
            .trim()
            .strip_prefix("export default ")
            .unwrap()
            .strip_suffix(';')
            .unwrap();
        let rules: Value = serde_json::from_str(data).unwrap();
        let aliases = serde_json::from_value(rules["aliases"].clone()).unwrap();
        let patterns = list(&rules["patterns"])
            .iter()
            .map(|r| {
                let source = r[1].as_str().unwrap().replace(r"\b", r"(?-u:\b)");
                (
                    r[0].as_str().unwrap().to_owned(),
                    Regex::new(&source).unwrap(),
                )
            })
            .collect();
        (aliases, patterns)
    });
fn normalize(s: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(s)
        .trim()
        .to_lowercase()
}
fn name_category(name: &str) -> Option<&'static str> {
    let name = normalize(name);
    CATEGORY_RULES
        .1
        .iter()
        .find(|(_, pattern)| pattern.is_match(&name))
        .map(|(category, _)| category.as_str())
}
fn erp_category(doc: &Value, cost: &Value) -> Option<&'static str> {
    if doc["specialComponent"] == true {
        return Some("特殊配件");
    }
    for value in [cost.get("erpCategory"), doc.get("erpCategory")]
        .into_iter()
        .flatten()
    {
        if value.is_null() {
            break;
        }
        if let Some(s) = value.as_str() {
            if let Some(c) = CATEGORY_RULES.0.get(&normalize(s)) {
                return Some(c);
            }
            if let Some(c) = name_category(s) {
                return Some(c);
            }
        }
    }
    None
}
fn slot(s: &str) -> Option<&str> {
    CATEGORIES[1..10].contains(&s).then_some(s)
}
fn excluded(doc: &Value) -> bool {
    ["erpName", "name", "originalName"]
        .iter()
        .any(|key| strval(doc, key).contains(['*', '＊']))
}
fn id_valid(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit())
}
fn erp_name<'a>(doc: &'a Value, cost: &'a Value) -> &'a str {
    let name = strval(cost, "name");
    if cost["nasErpOverride"] == true && !name.is_empty() {
        return name;
    }
    [
        strval(cost, "erpName"),
        name,
        strval(doc, "erpName"),
        strval(doc, "originalName"),
        strval(doc, "name"),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or("")
}

const SHARED_KEYS: &[&str] = &[
    "name",
    "tax",
    "capacityOverrides.memoryGb",
    "capacityOverrides.vramGb",
    "capacityOverrides.storageGb",
    "hardwareOverrides.cpuName",
    "hardwareOverrides.gpuName",
    "hardwareOverrides.boardType",
    "hardwareOverrides.caseBoards",
    "hardwareOverrides.color",
];
fn string_array(v: &Value) -> Value {
    list(v).iter().filter(|s| s.is_string()).cloned().collect()
}
fn addons(doc: &Value) -> Value {
    let mut a = scalar_fields(
        doc,
        &[
            "addonMode",
            "addonText",
            "addonNote",
            "addonGoodsId",
            "addonPriceCents",
            "addonQty",
            "addonOriginalQty",
            "addonShowTogether",
        ],
    );
    // 历史加购、组合与多选逐层取业务字段，避免透出快照里的额外资料或库存。
    fn items(value: &Value) -> Value {
        list(value)
            .iter()
            .map(|row| scalar_fields(row, &["goodsId", "qty"]))
            .collect()
    }
    if doc["addonItems"].is_array() {
        a["addonItems"] = items(&doc["addonItems"]);
    }
    if doc["addonChoices"].is_array() {
        a["addonChoices"] = list(&doc["addonChoices"])
            .iter()
            .map(|c| {
                scalar_fields(
                    c,
                    &[
                        "id",
                        "label",
                        "enabled",
                        "goodsId",
                        "customText",
                        "priceCents",
                        "qty",
                        "originalQty",
                    ],
                )
            })
            .collect();
    }
    if doc["addonVariants"].is_array() {
        a["addonVariants"] = list(&doc["addonVariants"])
            .iter()
            .map(|c| {
                let mut row = scalar_fields(
                    c,
                    &[
                        "text",
                        "note",
                        "variantId",
                        "goodsId",
                        "priceCents",
                        "qty",
                        "originalQty",
                        "showTogether",
                    ],
                );
                if c["items"].is_array() {
                    row["items"] = items(&c["items"]);
                }
                row
            })
            .collect();
    }
    a
}
fn has_upgrade(doc: &Value) -> bool {
    if doc["addonChoices"].is_array() {
        return !list(&doc["addonChoices"]).is_empty();
    }
    ["addonText", "addonGoodsId", "upgrade"]
        .iter()
        .any(|k| !strval(doc, k).trim().is_empty())
        || ["addonItems", "addonVariants"]
            .iter()
            .any(|k| !list(&doc[k]).is_empty())
}
fn shared_fields(v: &Value) -> Value {
    let mut out = scalar_fields(v, SHARED_KEYS);
    if v["hardwareOverrides.caseBoards"].is_array() {
        out["hardwareOverrides.caseBoards"] = string_array(&v["hardwareOverrides.caseBoards"]);
    }
    if v["addon"].is_object() {
        out["addon"] = addons(&v["addon"]);
    }
    out
}
fn projected_stores(entry: &Value, shops: &[&str]) -> Value {
    let mut stores = json!({});
    for &id in shops {
        if let Some(aliases) = entry["stores"][id].as_array() {
            stores[id] = aliases
                .iter()
                .filter(|a| a["sourceId"].is_string())
                .map(|a| json!({"sourceId":a["sourceId"],"fields":shared_fields(&a["fields"])}))
                .collect();
        }
    }
    stores
}

struct Source<'a> {
    doc: &'a Value,
    cost: &'a Value,
    unique_cost: bool,
    shared: &'a Value,
    aliases: &'a [&'a str],
    version: &'a Value,
    cost_version: &'a Value,
}
impl Source<'_> {
    fn id(&self) -> &str {
        strval(self.doc, "sourceId")
    }
    fn goods(&self) -> &str {
        strval(self.doc, "goodsId")
    }
    fn stock(&self) -> (Option<f64>, Option<f64>, &'static str) {
        if !self.unique_cost || !id_valid(self.goods()) || self.cost["erpMissing"] == true {
            return (None, None, "unknown");
        }
        let available = self.cost["stockAvailable"].as_f64();
        let incoming = self.cost["stockIncomingAvailable"].as_f64();
        let status = match available {
            None => "unknown",
            Some(n) if n > 0. => "in_stock",
            _ if incoming.is_some_and(|n| n > 0.) => "incoming",
            _ => "out",
        };
        (available, incoming, status)
    }
    fn tax(&self) -> Option<f64> {
        if self.doc["specialComponent"] == true {
            return Some(0.);
        }
        // 已保存成本表中的本店手改或已导入核算价优先，普通目录沿用来源核算价。
        if self.cost["nasTaxOverride"] == true || self.cost["nasManualTax"] == true {
            return money(&self.cost["tax"]);
        }
        self.doc
            .get("tax")
            .map(money)
            .unwrap_or_else(|| money(&self.cost["tax"]))
    }
    fn diff(&self, shops: &[&str]) -> bool {
        shops.iter().any(|s| {
            list(&self.shared["document"]["stores"][*s])
                .iter()
                .any(|a| {
                    a["fields"].as_object().is_some_and(|f| {
                        f.keys()
                            .any(|k| SHARED_KEYS.contains(&k.as_str()) || k == "addon")
                    })
                })
        })
    }
    fn matches(&self, p: &SourceParams, shops: &[&str]) -> bool {
        let doc = self.doc;
        if p.source.is_some_and(|id| self.id() != id)
            || p.goods.is_some_and(|goods| self.goods() != goods)
        {
            return false;
        }
        let deleted = !doc["deletedAt"].is_null();
        if (deleted && !p.deleted) || (p.filter == "deleted" && !deleted) {
            return false;
        }
        let status = self.stock().2;
        if p.status.is_some_and(|s| s != status) {
            return false;
        }
        let tax = self.tax();
        if p.min.is_some_and(|min| tax.is_none_or(|v| v < min))
            || p.max.is_some_and(|max| tax.is_none_or(|v| v > max))
        {
            return false;
        }
        let match_filter = match p.filter {
            "diff" => self.diff(shops),
            "upgrade" => has_upgrade(doc),
            "missing_tax" => tax.is_none(),
            "shortage" => {
                matches!(status, "out" | "incoming")
                    || [doc, self.cost].into_iter().any(|v| {
                        v["discontinued"] == true
                            || v["saleStopped"] == true
                            || ["erpName", "erpStatus", "saleStatus", "status"]
                                .iter()
                                .any(|k| {
                                    ["缺货", "停售", "停产", "下架"]
                                        .iter()
                                        .any(|tag| strval(v, k).contains(tag))
                                })
                    })
            }
            _ => true,
        };
        if !match_filter {
            return false;
        }
        if p.category
            .zip(erp_category(doc, self.cost))
            .is_some_and(|(a, b)| a != b)
        {
            return false;
        }
        if let Some(q) = &p.phrase {
            let name = normalize(
                &[
                    self.id(),
                    self.goods(),
                    strval(doc, "name"),
                    strval(doc, "originalName"),
                    erp_name(doc, self.cost),
                    strval(doc, "erpSpec"),
                    strval(doc, "erpModel"),
                    strval(self.cost, "erpSpec"),
                    strval(self.cost, "erpModel"),
                    strval(doc, "addonText"),
                ]
                .join(" "),
            );
            if !normalize(q).split_whitespace().all(|s| name.contains(s)) {
                return false;
            }
        }
        true
    }
    fn project(
        &self,
        shop: &str,
        category: &str,
        count: usize,
        p: &SourceParams,
        shops: &[&str],
    ) -> Value {
        let doc = self.doc;
        let cost = self.cost;
        let erp = if doc["specialComponent"] == true {
            Some(0.)
        } else if cost["erpMissing"] == true
            || cost["erpUnknown"] == true
            || doc["erpMissing"] == true && cost.get("erpMissing").is_none()
            || doc["erpUnknown"] == true && cost.get("erpUnknown").is_none()
        {
            None
        } else {
            cost.get("erp").or_else(|| doc.get("erp")).and_then(money)
        };
        let (available, incoming, status) = self.stock();
        let mut out = json!({"shopId":shop,"sourceId":self.id(),"goodsId":self.goods(),"name":doc["name"].as_str(),"erpName":erp_name(doc,cost),"category":category,
            "tax":self.tax(),"erp":erp,"referenceCount":count,"hasUpgrade":has_upgrade(doc),"hasStoreDiff":self.diff(shops),"deletedAt":doc["deletedAt"].as_str(),
            "stockAvailable":available.filter(|_|p.stock),"stockIncomingAvailable":incoming.filter(|_|p.stock),"stockRedacted":!p.stock});
        if p.stock {
            out["stockStatus"] = json!(status);
            out["stockUpdatedAt"] =
                scalar_fields(cost, &["stockUpdatedAt"])["stockUpdatedAt"].take();
        }
        if p.get {
            let mut hardware = scalar_fields(
                &doc["hardwareOverrides"],
                &["cpuName", "gpuName", "boardType", "color"],
            );
            if doc["hardwareOverrides"]["caseBoards"].is_array() {
                hardware["caseBoards"] = string_array(&doc["hardwareOverrides"]["caseBoards"]);
            }
            out["hardwareOverrides"] = hardware;
            out["capacityOverrides"] = scalar_fields(
                &doc["capacityOverrides"],
                &["memoryGb", "vramGb", "storageGb"],
            );
            out["addons"] = addons(doc);
            out["upgrade"] = scalar_fields(doc, &["upgrade"])["upgrade"].take();
            out["manualTax"] = json!(self.tax().filter(|_| cost["nasManualTax"] == true));
            out["defaultTax"] = json!(self.tax().filter(|_| cost["nasManualTax"] != true));
            out["version"] = self.version.clone();
            out["costVersion"] = json!(self.cost_version.as_str());
            out["sharedVersion"] = json!(self.shared["version"].as_str());
            out["common"] = shared_fields(&self.shared["document"]["common"]);
            out["storeOverrides"] = projected_stores(&self.shared["document"], shops);
        }
        out
    }
}

// 以展示与实际 BOM 的配置 ID 并集计数。source-usage 也会命中加购，须复核仅来源命中的记录。
fn reference_info(
    api: &impl SavedReads,
    shop: &str,
    source: &Source,
    index: &Value,
) -> Result<(usize, String)> {
    let route = format!("/api/v1/operations/workspace/source-usage?shop_id={shop}");
    let goods = source.goods();
    let goods_keys = if goods.is_empty() {
        vec![]
    } else {
        vec![goods]
    };
    let usage = |sources: &[&str]| -> Result<HashSet<String>> {
        api.data(&route, Some(&json!({"sources":sources,"goods":goods_keys})))?
            .as_array()
            .ok_or_else(bad_response)?
            .iter()
            .map(|id| id.as_str().map(str::to_owned).ok_or_else(bad_response))
            .collect()
    };
    let union = usage(source.aliases)?;
    let explicit = erp_category(source.doc, source.cost);
    let referenced = rows(index)
        .iter()
        .filter(|row| union.contains(strval(row, "id")))
        .collect::<Vec<_>>();
    if referenced.len() != union.len() {
        return Err(stale());
    }
    let goods_matches = |part: &Value| !goods.is_empty() && part["goodsId"] == goods;
    let source_matches = |part: &Value| source.aliases.contains(&strval(part, "sourceId"));
    // 展示摘要已经证实的引用无需拉详情；索引不含实际配件，另查仅货号命中的集合。
    let need_goods = !goods.is_empty()
        && referenced
            .iter()
            .any(|r| !list(&r["parts"]).iter().any(goods_matches));
    let confirmed = if need_goods {
        usage(&[])?
    } else {
        HashSet::new()
    };
    let mut goods_slot = None;
    let mut source_slot = None;
    let mut count = 0;
    for row in referenced {
        let displayed = list(&row["parts"])
            .iter()
            .filter(|p| goods_matches(p))
            .collect::<Vec<_>>();
        let matched_goods = !displayed.is_empty() || confirmed.contains(strval(row, "id"));
        let display_slot = displayed.into_iter().find_map(|p| slot(strval(p, "slot")));
        if matched_goods && (explicit.is_some() || goods_slot.is_some() || display_slot.is_some()) {
            count += 1;
            if goods_slot.is_none() {
                goods_slot = display_slot.map(str::to_owned);
            }
            continue;
        }
        let detail = api.detail(row)?;
        let document = &detail["document"];
        let parts = list(&document["parts"])
            .iter()
            .chain(list(&document["actualParts"]));
        let mut hit = false;
        for part in parts {
            let by_goods = goods_matches(part);
            let by_source = source_matches(part);
            hit |= by_goods || by_source;
            if let Some(s) = slot(strval(part, "slot")) {
                if by_goods && goods_slot.is_none() {
                    goods_slot = Some(s.to_owned());
                }
                if by_source && source_slot.is_none() {
                    source_slot = Some(s.to_owned());
                }
            }
        }
        count += usize::from(hit);
    }
    let doc = source.doc;
    let name = [
        erp_name(doc, source.cost),
        strval(doc, "name"),
        strval(doc, "originalName"),
        strval(doc, "erpModel"),
    ]
    .join(" ");
    let category = explicit
        .or(goods_slot.as_deref())
        .or(source_slot.as_deref())
        .or_else(|| slot(strval(doc, "slot")))
        .or_else(|| name_category(&name))
        .unwrap_or("其他配件");
    Ok((count, category.to_owned()))
}

fn digest(values: &[&Value]) -> i64 {
    // 同时覆盖来源目录、成本/库存版本和配置索引。旧 NAS 缺少单行版本时使用实际内容。
    let mut hash = Sha256::new();
    for v in values {
        serde_json::to_writer(&mut hash, v).expect("JSON 快照可序列化");
        hash.update([0]);
    }
    let bytes = hash.finalize();
    (u64::from_be_bytes(bytes[..8].try_into().unwrap()) >> 12) as i64
}

pub(super) fn sources(
    api: &impl SavedReads,
    shop: &str,
    p: &SourceParams,
    shared_enabled: bool,
    shops: &[&str],
) -> Result<Value> {
    let get = |path: &str| api.data(&format!("/api/v1/operations/{path}?shop_id={shop}"), None);
    let (catalog, index, resources, shared) = std::thread::scope(|pool| -> Result<_> {
        let c = pool.spawn(|| get("workspace-catalog"));
        let i = pool.spawn(|| api.index());
        // 活跃目录本身没有行版本。用 catalog/sources 的正式版本锁住同值重写；
        // 旧库若缺归档引用函数，普通查询仍可按活跃目录内容锁页。
        let r = pool.spawn(|| match get("catalog/sources") {
            Err(e)
                if !p.deleted
                    && matches!(e.code.as_str(), "NAS_RETENTION_NOT_INSTALLED" | "NOT_FOUND") =>
            {
                Ok(Value::Null)
            }
            result => result,
        });
        let s = pool.spawn(|| {
            if shared_enabled {
                get("catalog/shared-sources")
            } else {
                Ok(json!([]))
            }
        });
        Ok((
            c.join().map_err(|_| bad_response())??,
            i.join().map_err(|_| bad_response())??,
            r.join().map_err(|_| bad_response())??,
            s.join().map_err(|_| bad_response())??,
        ))
    })?;
    let active = catalog["sourceCatalog"]
        .as_array()
        .ok_or_else(bad_response)?;
    let costs = catalog["costSource"].as_array().ok_or_else(bad_response)?;
    let has_versions = !resources.is_null();
    let resources = if has_versions {
        resources.as_array().ok_or_else(bad_response)?.as_slice()
    } else {
        &[]
    };
    let shared_rows = shared.as_array().ok_or_else(bad_response)?;
    let mut docs = BTreeMap::new();
    for doc in active {
        // workspace-catalog 的共享来源可能没有 shopId；有明确外店标签的来源不能混入。
        if doc["shopId"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != shop && id != "shared")
        {
            continue;
        }
        let id = doc["sourceId"].as_str().ok_or_else(bad_response)?;
        if docs.insert(id, (doc, &Value::Null)).is_some() {
            return Err(bad_response());
        }
    }
    let mut source_versions = BTreeMap::new();
    for wrapper in resources {
        let doc = &wrapper["document"];
        let id = wrapper["id"].as_str().ok_or_else(bad_response)?;
        if doc["sourceId"] != id
            || doc["shopId"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id != shop && id != "shared")
        {
            continue;
        }
        let allowed_owner = wrapper["owner_shop"] == shop
            || wrapper["owner_shop"] == "shared"
            || wrapper["shared"] == true;
        if !allowed_owner {
            continue;
        }
        if let Some((active, _)) = docs.get(id) {
            if *active != doc {
                return Err(stale());
            }
        } else if doc["deletedAt"].is_null() {
            return Err(stale());
        }
        if !doc["deletedAt"].is_null() && !p.deleted {
            continue;
        }
        if wrapper["version"].as_str().is_none() {
            return Err(bad_response());
        }
        docs.insert(id, (doc, &wrapper["version"]));
        source_versions.insert(id, &wrapper["version"]);
    }
    if has_versions && docs.values().any(|(_, v)| v.is_null()) {
        return Err(stale());
    }
    let mut cost_map = HashMap::<&str, Vec<&Value>>::new();
    for c in costs {
        if let Some(goods) = c["goodsId"].as_str() {
            cost_map.entry(goods).or_default().push(c);
        }
    }
    let mut shared_map = HashMap::new();
    for entry in shared_rows {
        for alias in list(&entry["document"]["stores"][shop]) {
            if let Some(id) = alias["sourceId"].as_str() {
                shared_map.insert(id, entry);
            }
        }
    }
    // 与工作表相同，正式共用条目、历史货号及特殊/归档来源按各自身份分组。
    let group_key = |id: &str, doc: &Value| {
        if !doc["deletedAt"].is_null() {
            format!("deleted:{id}")
        } else {
            shared_map
                .get(id)
                .and_then(|e| e["id"].as_str())
                .or(doc["sharedSourceId"].as_str())
                .or_else(|| doc["goodsId"].as_str().filter(|g| !g.is_empty()))
                .unwrap_or(id)
                .to_owned()
        }
    };
    let mut groups = HashMap::<String, Vec<&str>>::new();
    for (&id, (doc, _)) in &docs {
        groups.entry(group_key(id, doc)).or_default().push(id);
    }
    let rev = digest(&[
        &json!(shop),
        &catalog["sourceCatalog"],
        &json!(source_versions),
        &catalog["costSource"],
        &catalog["costVersions"],
        &index["revision"],
        &shared,
    ]);
    if p.revision.is_some_and(|r| r != rev) {
        return Err(stale());
    }
    let mut selected = Vec::new();
    for (id, (doc, version)) in &docs {
        let goods = strval(doc, "goodsId");
        let costs = cost_map.get(goods).map(Vec::as_slice).unwrap_or_default();
        if excluded(doc) || costs.iter().any(|c| excluded(c)) {
            continue;
        }
        let shared = if doc["deletedAt"].is_null() {
            shared_map.get(id).copied().unwrap_or(&Value::Null)
        } else {
            &Value::Null
        };
        let aliases = groups[&group_key(id, doc)].as_slice();
        let source = Source {
            doc,
            cost: costs.first().copied().unwrap_or(&Value::Null),
            unique_cost: costs.len() == 1,
            shared,
            aliases,
            version,
            cost_version: &catalog["costVersions"][goods],
        };
        if source.matches(p, shops) {
            selected.push(source);
        }
    }
    if p.get {
        if selected.is_empty() {
            return Err(AgentError::new("NOT_FOUND", "未找到该店铺的已保存来源"));
        }
        if selected.len() > 1 {
            let ids = selected.iter().map(Source::id).collect::<Vec<_>>();
            return Err(AgentError::new(
                "AMBIGUOUS_SOURCE",
                format!("同一货号存在多个来源，请指定 sourceId。候选 {}", json!(ids)),
            ));
        }
    }
    let mut items = Vec::new();
    let mut matched = 0;
    // 没有分类过滤时先按目录分页，只为当前页统计引用；分类缺失时须按真实引用部位筛选。
    let needs_category = p.category.is_some()
        && selected
            .iter()
            .any(|s| erp_category(s.doc, s.cost).is_none());
    let has_more = !needs_category && selected.len().saturating_sub(p.offset) > p.limit;
    let visible = if needs_category {
        &selected[..]
    } else {
        let start = selected.len().min(p.offset);
        &selected[start..selected.len().min(start.saturating_add(p.limit))]
    };
    for chunk in visible.chunks(6) {
        let refs = std::thread::scope(|pool| {
            chunk
                .iter()
                .map(|s| pool.spawn(|| reference_info(api, shop, s, &index)))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().map_err(|_| bad_response())?)
                .collect::<Result<Vec<_>>>()
        })?;
        for (source, (count, category)) in chunk.iter().zip(refs) {
            if p.category.is_some_and(|s| s != category) {
                continue;
            }
            matched += 1;
            if needs_category && matched <= p.offset {
                continue;
            }
            let mut row = source.project(shop, &category, count, p, shops);
            if p.get && source.version.is_null() {
                let mut url =
                    reqwest::Url::parse("https://localhost/api/v1/operations/catalog/sources")
                        .unwrap();
                if matches!(source.id(), "." | "..") {
                    return Err(bad_response());
                }
                url.path_segments_mut().unwrap().push(source.id());
                let wrapper = api.data(&format!("{}?shop_id={shop}", url.path()), None)?;
                if wrapper["id"] != source.id() || wrapper["version"].as_str().is_none() {
                    return Err(bad_response());
                }
                if &wrapper["document"] != source.doc {
                    return Err(stale());
                }
                row["version"] = wrapper["version"].clone();
            }
            items.push(row);
            if items.len() > p.limit {
                break;
            }
        }
        if items.len() > p.limit {
            break;
        }
    }
    if !visible.is_empty() && api.index()?["revision"] != index["revision"] {
        return Err(stale());
    }
    if p.get {
        return Ok(
            json!({"shopId":shop,"revision":rev,"source":items.pop().ok_or_else(bad_response)?}),
        );
    }
    let more = has_more || items.len() > p.limit;
    items.truncate(p.limit);
    Ok(
        json!({"shopId":shop,"revision":rev,"items":items,"limit":p.limit,"offset":p.offset,"hasMore":more,
        "nextOffset":if more{p.offset.checked_add(p.limit)}else{None}}),
    )
}
