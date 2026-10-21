//! Agent 查询仅访问本机已保存实体；不初始化数据库，也不更新任何派生缓存。
use crate::workbench_store::WorkbenchStore;
use diytools_agent_core::AgentError;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::time::Duration;

type Result<T> = std::result::Result<T, AgentError>;
// 与 JS 的 !deletedAt 一致：缺失、null、false、数值零和空字符串均为活动配置。
const ACTIVE_CONFIG: &str = r#"
    json_type(document,'$.deletedAt') IS NULL
    OR json_type(document,'$.deletedAt') IN ('null','false')
    OR (json_type(document,'$.deletedAt') IN ('integer','real')
        AND json_extract(document,'$.deletedAt')=0)
    OR (json_type(document,'$.deletedAt')='text'
        AND json_extract(document,'$.deletedAt')='')
"#;
const METHODS: &[&str] = &["status", "shops.list", "configs.find", "configs.get"];
const SHOPS: &[(&str, &str)] = &[
    ("intel", "英特尔官方旗舰店"),
    ("gigabyte", "技嘉旗舰店"),
    ("jonsbo", "乔思伯官方旗舰店"),
];
fn invalid(message: &str) -> AgentError {
    AgentError::new("INVALID_PARAMS", message)
}
// 数据库错误不外传路径、正文或底层诊断，避免带出私有资料。
fn database(error: rusqlite::Error) -> AgentError {
    if matches!(error, rusqlite::Error::SqliteFailure(ref failure, _) if failure.code == rusqlite::ErrorCode::OperationInterrupted)
    {
        return AgentError::new("QUERY_TIMEOUT", "查询超过执行时限，请缩小筛选范围");
    }
    AgentError::new("DATABASE_UNAVAILABLE", "本机已保存快照不可读取")
}
fn parse(raw: &str) -> Result<Value> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new("INTERNAL_ERROR", "已保存业务数据格式无效"))
}
fn string<'a>(params: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>> {
    params
        .get(key)
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .ok_or_else(|| invalid("查询标识必须为非空字符串"))
        })
        .transpose()
}
fn number(params: &Map<String, Value>, key: &str, default: i64) -> Result<i64> {
    params
        .get(key)
        .map(|v| {
            v.as_i64()
                .filter(|n| *n >= 0)
                .ok_or_else(|| invalid("分页和版本参数必须为非负整数"))
        })
        .unwrap_or(Ok(default))
}
// 只复制明确的业务标量；未知对象与身份、连接、凭据字段永不透传。
fn fields(value: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(v) = value.get(*key).filter(|v| !v.is_object() && !v.is_array()) {
            out.insert((*key).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn business(value: &Value, detail: bool) -> Value {
    let mut out = fields(
        value,
        &[
            "id",
            "shopId",
            "productId",
            "product",
            "productUrl",
            "spu",
            "productCategory",
            "name",
            "version",
            "shortName",
            "skuId",
            "price",
            "installment",
            "updatedAt",
            "isTemplate",
        ],
    );
    // 与 shops.js 的载入兼容规则一致；不把归一化结果写回已保存快照。
    out["shopId"] = json!(effective_shop(value));
    if detail {
        for key in ["parts", "actualParts"] {
            if let Some(parts) = value.get(key) {
                if let Some(rows) = parts.as_array() {
                    out[key] = Value::Array(
                        rows.iter()
                            .map(|row| {
                                let mut projected = fields(
                                    row,
                                    &[
                                        "slot",
                                        "name",
                                        "displayName",
                                        "goodsId",
                                        "sourceId",
                                        "qty",
                                        "upgrade",
                                        "erp",
                                        "tax",
                                        "erpMissing",
                                        "erpUnknown",
                                        "specialComponent",
                                        "enabled",
                                        "posterVisible",
                                    ],
                                );
                                if row.get("taxOverride").is_some_and(Value::is_object) {
                                    projected["taxOverride"] =
                                        fields(&row["taxOverride"], &["goodsId", "value", "base"]);
                                }
                                projected
                            })
                            .collect(),
                    );
                } else if parts.is_null() {
                    out[key] = Value::Null;
                }
            }
        }
    }
    out
}
fn effective_shop(row: &Value) -> &'static str {
    if let Some(id) = row["shopId"].as_str().filter(|id| !id.is_empty()) {
        return SHOPS
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(key, _)| *key)
            .unwrap_or("intel");
    }
    SHOPS
        .iter()
        .find(|(_, name)| Some(*name) == row["shop"].as_str())
        .map(|(key, _)| *key)
        .unwrap_or("intel")
}
fn shop(id: &Value) -> Value {
    json!({"id":id,"name":id.as_str().and_then(|id|SHOPS.iter().find(|(key,_)|*key==id).map(|(_,name)|*name))})
}

pub fn dispatch(store: &WorkbenchStore, method: &str, input: &Value) -> Result<Value> {
    let allowed: &[&str] = match method {
        "status" | "shops.list" => &[],
        "configs.find" => &[
            "shopId", "goodsId", "sku", "spu", "limit", "offset", "revision",
        ],
        "configs.get" => &["configId"],
        _ => return Err(AgentError::new("METHOD_NOT_FOUND", "不支持此只读方法")),
    };
    let p = input
        .as_object()
        .ok_or_else(|| invalid("params 必须为对象"))?;
    if p.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("包含未知查询参数"));
    }
    let shop_id = string(p, "shopId")?;
    let goods_id = string(p, "goodsId")?;
    let sku = string(p, "sku")?;
    let spu = string(p, "spu")?;
    let config_id = string(p, "configId")?;
    let limit = number(p, "limit", 20)?;
    let offset = number(p, "offset", 0)?;
    let requested_revision = p
        .get("revision")
        .map(|_| number(p, "revision", 0))
        .transpose()?;
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit 必须在 1 至 100 之间"));
    }
    if method == "configs.get" && config_id.is_none() {
        return Err(invalid("configId 为必填参数"));
    }
    if offset > 0 && requested_revision.is_none() {
        return Err(invalid("后续分页必须提供 revision"));
    }
    let mut c = Connection::open_with_flags(&store.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(database)?;
    c.busy_timeout(Duration::from_millis(500))
        .map_err(database)?;
    // busy_timeout 只限制锁等待；进度回调另外限制大 JSON/全表扫描的执行时间。
    let started = std::time::Instant::now();
    c.progress_handler(
        1000,
        Some(move || started.elapsed() > Duration::from_secs(4)),
    )
    .map_err(database)?;
    let tx = c.transaction().map_err(database)?;
    // 第一次 SELECT 固定本次事务快照，版本与实体读取属于同一保存状态。
    let (revision, updated): (i64, Option<String>) = tx.query_row(
        "SELECT json_extract(document,'$.revision'), json_extract(document,'$.updatedAt') FROM workbench_metadata WHERE id=1", [], |r|Ok((r.get(0)?,r.get(1)?))).map_err(database)?;
    if requested_revision.is_some_and(|v| v != revision) {
        return Err(AgentError::new(
            "REVISION_CONFLICT",
            "已保存快照版本变化，请从第一页重新查询",
        ));
    }
    let result = match method {
        "status" => {
            json!({"revision":revision,"savedRevision":revision,"updatedAt":updated,"snapshot":"localSaved","snapshotDescription":"本机最后成功保存的快照，不包含尚未保存的界面改动；本机保存不代表云同步完成。","cloudSyncStatus":"unknown","cloudSyncChecked":false,"capabilities":METHODS})
        }
        "shops.list" => {
            json!({"revision":revision,"shops":SHOPS.iter().map(|(id,name)|json!({"id":id,"name":name})).collect::<Vec<_>>()})
        }
        "configs.get" => {
            let sql =
                format!("SELECT document FROM workbench_configs WHERE id=?1 AND ({ACTIVE_CONFIG})");
            let raw: Option<String> = tx
                .query_row(&sql, [config_id.unwrap()], |r| r.get(0))
                .optional()
                .map_err(database)?;
            let row =
                parse(&raw.ok_or_else(|| AgentError::new("NOT_FOUND", "配置不存在或已删除"))?)?;
            json!({"revision":revision,"config":business(&row,true),"shop":shop(&json!(effective_shop(&row))),"link":fields(&json!({"id":row["productId"],"name":row["product"],"url":row["productUrl"],"spu":row["spu"]}), &["id","name","url","spu"])})
        }
        "configs.find" => {
            // 参数全部绑定；整数 ID 用原始 JSON 文本比较，保留超大整数精度和字符串前导零。
            // 显式空 actualParts 是空 BOM；只有非数组旧值回退展示配件。
            let sql = format!(
                r#"
                SELECT document FROM workbench_configs c
                WHERE ({ACTIVE_CONFIG})
                AND (?1 IS NULL OR (CASE
                    WHEN json_type(document,'$.shopId')='text'
                        AND json_extract(document,'$.shopId') IN ('intel','gigabyte','jonsbo')
                        THEN json_extract(document,'$.shopId')
                    WHEN COALESCE(json_extract(document,'$.shopId'),'')=''
                        AND json_extract(document,'$.shop')='技嘉旗舰店' THEN 'gigabyte'
                    WHEN COALESCE(json_extract(document,'$.shopId'),'')=''
                        AND json_extract(document,'$.shop')='乔思伯官方旗舰店' THEN 'jonsbo'
                    ELSE 'intel' END=?1))
                AND (?2 IS NULL OR (CASE json_type(document,'$.skuId')
                    WHEN 'text' THEN json_extract(document,'$.skuId')
                    WHEN 'integer' THEN document -> '$.skuId' END=?2))
                AND (?3 IS NULL OR (CASE json_type(document,'$.spu')
                    WHEN 'text' THEN json_extract(document,'$.spu')
                    WHEN 'integer' THEN document -> '$.spu' END=?3))
                AND (?4 IS NULL OR EXISTS (
                    SELECT 1 FROM json_each(CASE
                        WHEN json_type(c.document,'$.actualParts')='array'
                            THEN json_extract(c.document,'$.actualParts')
                        WHEN json_type(c.document,'$.parts')='array'
                            THEN json_extract(c.document,'$.parts') ELSE '[]' END) part
                    WHERE CASE json_type(part.value,'$.goodsId')
                        WHEN 'text' THEN json_extract(part.value,'$.goodsId')
                        WHEN 'integer' THEN part.value -> '$.goodsId' END=?4))
                ORDER BY position,id LIMIT ?5 OFFSET ?6
            "#
            );
            let mut q = tx.prepare(&sql).map_err(database)?;
            let rows = q
                .query_map(
                    params![shop_id, sku, spu, goods_id, limit + 1, offset],
                    |r| r.get::<_, String>(0),
                )
                .map_err(database)?;
            let mut items = Vec::new();
            for raw in rows {
                items.push(business(&parse(&raw.map_err(database)?)?, false));
            }
            let more = items.len() > limit as usize;
            items.truncate(limit as usize);
            json!({"revision":revision,"items":items,"limit":limit,"offset":offset,"hasMore":more,"nextOffset":if more {offset.checked_add(limit)}else{None}})
        }
        _ => unreachable!(),
    };
    tx.commit().map_err(database)?;
    Ok(result)
}

#[cfg(test)]
#[path = "agent_queries/tests.rs"]
mod tests;
