//! Agent 的店内目录与活动只读投影；业务字段在离开宿主前统一裁剪。
use super::*;
use serde_json::Map;
use std::collections::BTreeMap;
use std::sync::LazyLock;

type Args = Map<String, Value>;
#[path = "nas_agent_sources.rs"]
mod catalog;
use catalog::sources;
const CATEGORIES: &[&str] = &[
    "全部配件",
    "CPU",
    "主板",
    "显卡",
    "内存",
    "硬盘",
    "散热",
    "风扇",
    "机箱",
    "电源",
    "其他配件",
    "特殊配件",
];
const KINDS: &[&str] = &[
    "configurations",
    "sources",
    "shared-sources",
    "costs",
    "addons",
    "gallery",
    "templates",
    "settings",
    "quotations",
    "assets",
];

pub(super) fn phrase(args: &Args) -> Result<Option<String>> {
    let value = query::string(args, "query")?;
    if value.is_some_and(|s| s.trim().is_empty() || s.chars().count() > 200) {
        return Err(query::invalid("query 须为 1 至 200 个字符"));
    }
    Ok(value.map(|s| s.trim().to_lowercase()))
}

fn only(args: &Args, keys: &[&str]) -> Result<()> {
    if args.keys().all(|k| keys.contains(&k.as_str())) {
        Ok(())
    } else {
        Err(query::invalid("包含未知查询参数"))
    }
}

fn choice<'a>(args: &'a Args, key: &str, choices: &[&str]) -> Result<Option<&'a str>> {
    let value = query::string(args, key)?;
    if value.is_some_and(|s| !choices.contains(&s)) {
        return Err(query::invalid("无效的筛选选项"));
    }
    Ok(value)
}

fn scalar_fields(value: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(v) = value.get(key).filter(|v| !v.is_array() && !v.is_object()) {
            out.insert((*key).into(), v.clone());
        }
    }
    out.into()
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn strval<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn money(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|v| v.is_finite() && *v >= 0.)
}

impl NasAgent {
    pub(super) fn extended_query(
        &self,
        actor: &Actor,
        method: &str,
        input: &Value,
        me: &Value,
        inventory_visible: bool,
    ) -> Result<Value> {
        let args = input
            .as_object()
            .ok_or_else(|| query::invalid("params 必须为对象"))?;
        let shop = query::string(args, "shopId")?.ok_or_else(|| query::invalid("请指定 shopId"))?;
        let authorized = operating_shops(me);
        let capability = authorized
            .iter()
            .find(|(id, _)| *id == shop)
            .ok_or_else(|| AgentError::new("FORBIDDEN", "当前账号没有该店铺运营权限"))?
            .1;
        let api = NasReads {
            agent: self,
            actor,
            shop,
            deadline: Instant::now() + Duration::from_millis(3900),
        };
        if method == "activity.list" {
            return activity(args, shop, |route| api.data(route, None));
        }
        let params = SourceParams::parse(method, args, inventory_visible)?;
        let shared = capability["shared_sources"] == true;
        let shops = authorized.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        sources(&api, shop, &params, shared, &shops)
    }
}

// 数据提供器只含三个只读入口，合成验收使用与正式流程一致的查询与投影。
trait SavedReads: Sync {
    fn data(&self, route: &str, body: Option<&Value>) -> Result<Value>;
    fn index(&self) -> Result<Value>;
    fn detail(&self, row: &Value) -> Result<Value>;
}
struct NasReads<'a> {
    agent: &'a NasAgent,
    actor: &'a Actor,
    shop: &'a str,
    deadline: Instant,
}
impl NasReads<'_> {
    fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(AgentError::new(
                "QUERY_TIMEOUT",
                "NAS 查询超时，请缩小范围或页大小",
            ))
        } else {
            Ok(())
        }
    }
}
impl SavedReads for NasReads<'_> {
    fn data(&self, route: &str, body: Option<&Value>) -> Result<Value> {
        self.check()?;
        let mut response = self.agent.cloud.nas_agent_read(route, self.actor, body)?;
        response
            .get_mut("data")
            .map(Value::take)
            .ok_or_else(bad_response)
    }
    fn index(&self) -> Result<Value> {
        self.check()?;
        self.agent.index(self.actor, self.shop)
    }
    fn detail(&self, row: &Value) -> Result<Value> {
        self.check()?;
        self.agent.detail(self.actor, self.shop, row)
    }
}

fn activity(args: &Args, shop: &str, read: impl FnOnce(&str) -> Result<Value>) -> Result<Value> {
    only(
        args,
        &["shopId", "from", "to", "page", "pageSize", "kind", "actor"],
    )?;
    let page = query::number(args, "page", 0)?;
    let size = query::number(args, "pageSize", 30)?;
    let from = query::string(args, "from")?;
    let to = query::string(args, "to")?;
    let actor = query::string(args, "actor")?;
    let kind = choice(args, "kind", KINDS)?;
    let valid_date = |s: &str| {
        s.len() == 10
            && !s.starts_with('0')
            && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .is_ok_and(|date| date.to_string() == s)
    };
    if page > 9_999_999
        || !(1..=100).contains(&size)
        || [from, to].into_iter().flatten().any(|s| !valid_date(s))
        || from.zip(to).is_some_and(|(a, b)| a > b)
        || actor.is_some_and(|s| {
            s.trim() != s
                || s.encode_utf16().count() > 256
                || s.chars().any(|c| c.is_ascii_control())
        })
    {
        return Err(query::invalid("活动日期、操作人或分页条件无效"));
    }
    let mut url =
        reqwest::Url::parse("https://localhost/api/v1/operations/workspace/activity").unwrap();
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("shop_id", shop)
            .append_pair("page", &page.to_string())
            .append_pair("page_size", &size.to_string());
        for (key, value) in [("from", from), ("to", to), ("actor", actor), ("kind", kind)] {
            if let Some(v) = value {
                pairs.append_pair(key, v);
            }
        }
    }
    let filtered = actor.is_some() || kind.is_some();
    let unsupported = || {
        AgentError::new(
            "UNSUPPORTED_FILTER",
            "当前服务版本不支持按操作人或对象类型筛选",
        )
    };
    let result = read(&format!("{}?{}", url.path(), url.query().unwrap())).map_err(|e| {
        if filtered
            && matches!(
                e.code.as_str(),
                "NAS_ACTIVITY_NOT_INSTALLED" | "INVALID_REQUEST"
            )
        {
            unsupported()
        } else {
            e
        }
    })?;
    // 033 响应没有操作人目录；即使旧 HTTP 服务忽略了筛选也不能当作成功。
    if filtered && !result["operators"].is_array() {
        return Err(unsupported());
    }
    let raw = result["rows"].as_array().ok_or_else(bad_response)?;
    if raw.len() > size as usize
        || !["page", "pageSize", "total"]
            .iter()
            .all(|k| result[*k].as_u64().is_some())
    {
        return Err(bad_response());
    }
    let mut rows = Vec::new();
    for row in raw {
        if filtered
            && (actor.is_some_and(|s| row["actor_uid"] != s)
                || kind.is_some_and(|s| {
                    row["kind"] != s && !(s == "sources" && row["kind"] == "shared-sources")
                }))
        {
            return Err(unsupported());
        }
        let mut item = scalar_fields(
            row,
            &[
                "kind",
                "resource_id",
                "action",
                "next_version",
                "created_at",
                "actor_uid",
                "operator",
                "product_name",
                "resource_name",
                "object_exists",
                "batch",
                "item_count",
                "skipped_count",
                "updated_count",
            ],
        );
        if row["samples"].is_array() {
            item["samples"] = list(&row["samples"])
                .iter()
                .map(|s| scalar_fields(s, &["id", "name"]))
                .collect();
        }
        rows.push(item);
    }
    let operators = list(&result["operators"])
        .iter()
        .map(|s| scalar_fields(s, &["uid", "name", "own"]))
        .collect::<Vec<_>>();
    Ok(
        json!({"shopId":shop,"page":result["page"],"pageSize":result["pageSize"],"total":result["total"],"rows":rows,"operators":operators}),
    )
}

struct SourceParams<'a> {
    get: bool,
    source: Option<&'a str>,
    goods: Option<&'a str>,
    phrase: Option<String>,
    category: Option<&'a str>,
    status: Option<&'a str>,
    min: Option<f64>,
    max: Option<f64>,
    filter: &'a str,
    deleted: bool,
    stock: bool,
    offset: usize,
    limit: usize,
    revision: Option<i64>,
}
impl<'a> SourceParams<'a> {
    fn parse(method: &str, args: &'a Args, stock: bool) -> Result<Self> {
        let get = method == "sources.get";
        only(
            args,
            if get {
                &["shopId", "sourceId", "goodsId", "includeDeleted"]
            } else {
                &[
                    "shopId",
                    "query",
                    "category",
                    "stockStatus",
                    "minPrice",
                    "maxPrice",
                    "filter",
                    "includeDeleted",
                    "offset",
                    "limit",
                    "revision",
                ]
            },
        )?;
        let source = query::string(args, "sourceId")?;
        let goods = query::string(args, "goodsId")?;
        if get && source.is_some() == goods.is_some() {
            return Err(query::invalid("sourceId 和 goodsId 须指定其中一个"));
        }
        let filter = choice(
            args,
            "filter",
            &[
                "all",
                "diff",
                "upgrade",
                "shortage",
                "missing_tax",
                "deleted",
            ],
        )?
        .unwrap_or("all");
        let status = choice(
            args,
            "stockStatus",
            &["in_stock", "incoming", "out", "unknown"],
        )?;
        if !stock && (status.is_some() || filter == "shortage") {
            return Err(AgentError::new(
                "PERMISSION_DENIED",
                "请先允许读取库存与操作记录，才能按库存筛选",
            ));
        }
        let deleted = args
            .get("includeDeleted")
            .map(|v| {
                v.as_bool()
                    .ok_or_else(|| query::invalid("includeDeleted 必须为布尔值"))
            })
            .transpose()?
            .unwrap_or(false)
            || filter == "deleted";
        let price = |key: &str| {
            args.get(key)
                .map(|v| {
                    v.as_f64()
                        .filter(|v| v.is_finite() && *v >= 0.)
                        .ok_or_else(|| query::invalid("价格须为非负数"))
                })
                .transpose()
        };
        let min = price("minPrice")?;
        let max = price("maxPrice")?;
        let limit = query::number(args, "limit", 20)? as usize;
        let offset = query::number(args, "offset", 0)? as usize;
        let revision = args
            .get("revision")
            .map(|_| query::number(args, "revision", 0))
            .transpose()?;
        if !(1..=100).contains(&limit)
            || (offset > 0 && revision.is_none())
            || revision.is_some_and(|n| n > 9_007_199_254_740_991)
            || min.zip(max).is_some_and(|(a, b)| a > b)
        {
            return Err(query::invalid(
                "价格区间或分页无效，后续分页须提供 revision",
            ));
        }
        Ok(Self {
            get,
            source,
            goods,
            phrase: phrase(args)?,
            category: choice(args, "category", CATEGORIES)?.filter(|s| *s != "全部配件"),
            status,
            min,
            max,
            filter,
            deleted,
            stock,
            offset,
            limit,
            revision,
        })
    }
}

#[cfg(test)]
#[path = "nas_agent_queries_tests.rs"]
mod tests;
