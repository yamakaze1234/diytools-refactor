// 可信公司 SQL 结果的本机应用：先生成带摘要和有效期的预览，再原子更新成本、库存及操作记录。
//! Company SQL observations enter here only after the read-only Python worker has
//! validated the complete result. Credentials and SQL connections never enter this store.
use super::*;

const PREVIEW_TTL_MS: i64 = 600_000;

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

// 归一化连接来源并生成范围摘要，保留旧系统来源匹配口径且不保存密码。
fn scope_and_source(settings: &Value) -> Result<(String, Value)> {
    let field = |key: &str| -> Result<String> {
        settings[key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().count() <= 200)
            .map(str::to_owned)
            .ok_or_else(|| "请填写服务器和数据库".into())
    };
    let server = field("server")?;
    let database = field("database")?;
    let port = match settings.get("port") {
        None | Some(Value::Null) => 1433,
        Some(Value::String(value)) if value.trim().is_empty() => 1433,
        Some(Value::String(value)) => value.trim().parse::<u64>().map_err(|_| "数据库端口无效")?,
        Some(value) => value.as_u64().ok_or("数据库端口无效")?,
    };
    if !(1..=65535).contains(&port) {
        return Err("数据库端口无效".into());
    }
    // Field order matches Python common.dumps and the legacy JS scope digest.
    let identity =
        json!({"server":server.to_lowercase(),"port":port,"database":database.to_lowercase()});
    Ok((
        digest(&identity),
        json!({"server":server,"port":port,"database":database}),
    ))
}

// 既有 ERP 数据须与本次公司数据库范围一致，防止把不同来源库存混用。
fn check_scope(state: &Value, scope: &str) -> Result<()> {
    let bound = state["erpSync"]["sqlSync"]["scope"]
        .as_str()
        .or_else(|| state["sqlSync"]["scope"].as_str());
    if bound.is_some_and(|bound| !bound.is_empty() && bound != scope) {
        return Err("SQL 数据库与上次同步不同，请连接原服务器和数据库".into());
    }
    Ok(())
}

// 验证整批查询结果，遇重复或非法业务字段拒绝整批应用，不静默截断或置零。
fn normalized_rows(rows: Value) -> Result<Value> {
    let rows = rows.as_array().ok_or("SQL 目录格式无效")?;
    if rows.is_empty() || rows.len() > 100_000 {
        return Err("数据库目录为空、不完整或超过 100000 行，已保留原数据".into());
    }
    let mut ids = HashSet::new();
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row["goodsId"]
            .as_str()
            .ok_or("数据库 goods_id 缺失或不精确")?;
        if id.is_empty()
            || id.len() > 20
            || id.starts_with('0')
            || !id.bytes().all(|b| b.is_ascii_digit())
            || !ids.insert(id)
        {
            return Err("数据库 goods_id 缺失、不精确或重复".into());
        }
        let name = row["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("数据库商品身份不完整")?;
        for key in ["stockAvailable", "erp"] {
            let number = row.get(key).ok_or("数据库缺少库存或成本字段")?;
            if !number.is_null()
                && !number
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (key != "erp" || n >= 0.0))
            {
                return Err("数据库库存或单件成本数值无效，已保留原数据".into());
            }
        }
        // Retain only the normalized business fields, never worker/debug/settings data.
        result.push(json!({"goodsId":id,"name":name,"stockAvailable":row["stockAvailable"],"erp":row["erp"]}));
    }
    Ok(Value::Array(result))
}

fn excluded(row: &Value) -> bool {
    ["name", "originalName", "erpName"]
        .iter()
        .any(|key| row[*key].as_str().is_some_and(|s| s.contains(['*', '＊'])))
}

// JS parses Python's 345.0 as the same numeric value as 345. Preserve that
// comparison for change counts and the unique manual-price inheritance rule.
fn same_value(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}

fn same_optional(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_value(left, right),
        (None, None) => true,
        _ => false,
    }
}

fn records<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(rows)) if rows.iter().all(Value::is_object) => Ok(rows),
        _ => Err(format!("{key} 清单格式无效，已保留原数据")),
    }
}

struct Plan {
    next: Value,
    summary: Value,
    changes: Vec<Value>,
    config_ids: Vec<String>,
}

// 按旧业务规则生成成本和库存变化，保留人工价、已有名称及缺失 BOM 的处理口径。
fn stock_plan(state: &Value, rows: &Value, at: &str) -> Result<Plan> {
    validate(state)?;
    let rows = rows.as_array().ok_or("SQL 目录格式无效")?;
    let map: HashMap<_, _> = rows
        .iter()
        .map(|row| (row["goodsId"].as_str().unwrap(), row))
        .collect();
    let mut next = state.clone();
    next["sharedCostScope"] = state["sharedCostScope"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| state["erpSync"]["scope"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("unbound")
        .into();
    let mut manual: HashMap<String, Vec<Value>> = HashMap::new();
    let mut collect = |row: &'_ Value| {
        if let Some(id) = row["goodsId"].as_str().filter(|s| !s.is_empty())
            && let Some(tax) = row.get("tax").filter(|v| !v.is_null())
        {
            let values = manual.entry(id.to_owned()).or_default();
            if !values.iter().any(|value| same_value(value, tax)) {
                values.push(tax.clone());
            }
        }
    };
    for row in records(state, "sourceCatalog")? {
        collect(row);
    }
    for config in records(state, "configs")? {
        for key in ["parts", "actualParts"] {
            for row in records(config, key)? {
                collect(row);
            }
        }
    }
    let costs: HashSet<_> = records(state, "costSource")?
        .iter()
        .filter_map(|r| r["goodsId"].as_str())
        .collect();
    if next["costSource"].is_null() {
        next["costSource"] = json!([]);
    }
    for row in rows {
        let id = row["goodsId"].as_str().unwrap();
        if !costs.contains(id) && !excluded(row) {
            let tax = manual
                .get(id)
                .filter(|v| v.len() == 1)
                .map(|v| v[0].clone())
                .unwrap_or(Value::Null);
            next["costSource"].as_array_mut().unwrap().push(json!({"goodsId":id,"name":row["name"],"tax":tax,"erp":null,"stockAvailable":null,"localInventoryOnly":true}));
        }
    }
    let mut matched = 0;
    let mut unmatched = 0;
    let mut changes = Vec::new();
    let mut config_ids = Vec::new();
    let mut update = |record: &mut Value, area: &str, config_id: Option<&str>| {
        let Some(id) = record["goodsId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        else {
            return;
        };
        let Some(row) = map.get(id.as_str()) else {
            unmatched += 1;
            record["erpMissing"] = true.into();
            return;
        };
        matched += 1;
        if !same_optional(record.get("stockAvailable"), row.get("stockAvailable"))
            || !same_optional(record.get("erp"), row.get("erp"))
        {
            let name = record["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(Value::from)
                .unwrap_or_else(|| row["name"].clone());
            let mut change = json!({"erpBefore":record["erp"],"erpAfter":row["erp"],"area":area,"goodsId":id,"name":name,"before":record["stockAvailable"],"after":row["stockAvailable"]});
            if let Some(id) = config_id {
                change["configId"] = id.into();
            }
            changes.push(change);
        }
        record["stockAvailable"] = row["stockAvailable"].clone();
        record["stockUpdatedAt"] = at.into();
        record["stockSource"] = "company-sql".into();
        record["erp"] = row["erp"].clone();
        record["erpMissing"] = false.into();
        record["erpUnknown"] = row["erp"].is_null().into();
        record["erpUpdatedAt"] = at.into();
        if let Some(id) = config_id
            && !config_ids.iter().any(|existing| existing == id)
        {
            config_ids.push(id.to_owned());
        }
    };
    for (key, area) in [("sourceCatalog", "输出源"), ("costSource", "成本源")] {
        records(&next, key)?;
        if let Some(items) = next[key].as_array_mut() {
            for record in items {
                update(record, area, None);
            }
        }
    }
    for config in next["configs"].as_array_mut().unwrap() {
        if config["deletedAt"].as_str().is_some_and(|s| !s.is_empty()) {
            continue;
        }
        let id = config["id"].as_str().unwrap().to_owned();
        for key in ["parts", "actualParts"] {
            if let Some(items) = config[key].as_array_mut() {
                for record in items {
                    update(record, "配置", Some(&id));
                }
            }
        }
    }
    let unknown = rows
        .iter()
        .filter(|row| row["stockAvailable"].is_null())
        .count();
    Ok(Plan {
        next,
        summary: json!({"total":rows.len(),"matched":matched,"unmatched":unmatched,"unknown":unknown}),
        changes,
        config_ids,
    })
}

fn create_previews(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_sql_previews(id TEXT PRIMARY KEY, rows TEXT NOT NULL, base_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, scope TEXT NOT NULL, operator TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);")
        .map_err(|e| e.to_string())
}

// 持久化可信查询结果、当前状态摘要和有效期；新读取使先前未应用预览失效。
pub fn sql_preview(
    store: &WorkbenchStore,
    rows: Value,
    settings: &Value,
    operator: &str,
) -> Result<Value> {
    let rows = normalized_rows(rows)?;
    let (scope, source) = scope_and_source(settings)?;
    let mut connection = db(&store.path)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let before = state(&tx)?;
    check_scope(&before, &scope)?;
    let plan = stock_plan(&before, &rows, &now())?;
    create_previews(&tx)?;
    // A new read invalidates earlier pending previews in this local workspace.
    tx.execute(
        "DELETE FROM workbench_sql_previews WHERE applied=0 OR expires_at<=?1",
        [chrono::Utc::now().timestamp_millis()],
    )
    .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now().timestamp_millis() + PREVIEW_TTL_MS;
    let operator: String = operator.chars().take(60).collect();
    tx.execute("INSERT INTO workbench_sql_previews(id,rows,base_hash,expires_at,scope,operator) VALUES(?1,?2,?3,?4,?5,?6)", params![id,rows.to_string(),digest(&before),expires_at,scope,operator]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut result = plan.summary;
    result["id"] = id.into();
    result["expiresAt"] = expires_at.into();
    result["source"] = source;
    result["changes"] = plan.changes.into();
    result["configIds"] = plan.config_ids.into();
    Ok(result)
}

// 重新核对预览有效期、来源和正文摘要，正文、历史、回执及已应用标记同事务落盘。
pub fn sql_apply(store: &WorkbenchStore, id: &str) -> Result<Value> {
    let mut connection = db(&store.path)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let table: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_sql_previews')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !table {
        return Err("预览已失效，请重新读取".into());
    }
    let pending = tx.query_row("SELECT rows,base_hash,expires_at,scope,operator,applied FROM workbench_sql_previews WHERE id=?1", [id], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, i64>(2)?,r.get::<_, String>(3)?,r.get::<_, String>(4)?,r.get::<_, bool>(5)?))).optional().map_err(|e| e.to_string())?.ok_or("预览已失效，请重新读取")?;
    let (rows, base_hash, expires_at, scope, operator, applied) = pending;
    if applied || expires_at <= chrono::Utc::now().timestamp_millis() {
        return Err("预览已失效，请重新读取".into());
    }
    let before = state(&tx)?;
    if digest(&before) != base_hash {
        return Err("配置数据已变化，请重新预览".into());
    }
    check_scope(&before, &scope)?;
    let rows = normalized_rows(serde_json::from_str(&rows).map_err(|e| e.to_string())?)?;
    let at = now();
    let mut plan = stock_plan(&before, &rows, &at)?;
    let mut summary = plan.summary;
    summary["updatedAt"] = at.clone().into();
    summary["scope"] = scope.clone().into();
    summary["warehouse"] = "公司大库".into();
    summary["stockField"] = "分库可销数".into();
    summary["costField"] = "库存成本".into();
    let mut erp_sync = before["erpSync"].as_object().cloned().unwrap_or_default();
    let shared_scope = before["erpSync"]["scope"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("sql:{scope}"));
    for (key, value) in [
        ("scope", json!(shared_scope)),
        ("stockSource", json!("company-sql")),
        ("stockUpdatedAt", json!(at)),
        ("updatedAt", json!(at)),
        ("costField", json!("库存成本")),
        ("sqlSync", summary.clone()),
    ] {
        erp_sync.insert(key.into(), value);
    }
    plan.next["erpSync"] = Value::Object(erp_sync);
    plan.next["sqlSync"] = summary.clone();
    let input = json!({"operator":operator,"message":format!("同步 SQL 公司大库：{} 件商品，本机更新 ERP 成本与可销数，保留人工价",summary["total"])});
    if expires_at <= chrono::Utc::now().timestamp_millis() {
        return Err("预览已失效，请重新读取".into());
    }
    persist(&tx, &before, &mut plan.next, &input)?;
    let mut result = summary.clone();
    result["summary"] = summary;
    result["ok"] = true.into();
    result["revision"] = plan.next["revision"].clone();
    result["configIds"] = plan.config_ids.into();
    tx.execute(
        "UPDATE workbench_sql_previews SET applied=1 WHERE id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO workbench_receipts(operation,hash,document) VALUES(?1,?2,?3)",
        params![format!("sql-sync:{id}"), digest(&rows), result.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

// 在联网读取前检查数据来源绑定，避免无效来源产生不可用预览。
pub fn sql_validate_source(store: &WorkbenchStore, settings: &Value) -> Result<()> {
    let (scope, _) = scope_and_source(settings)?;
    check_scope(&state(&db(&store.path)?)?, &scope)
}

// 返回本机保存的最近同步信息，不主动访问公司 SQL。
pub fn sql_status(store: &WorkbenchStore) -> Result<Value> {
    let document = state(&db(&store.path)?)?;
    let last = document["erpSync"]["sqlSync"]
        .as_object()
        .map(|_| document["erpSync"]["sqlSync"].clone())
        .unwrap_or_else(|| document["sqlSync"].clone());
    let manifest = if document["erpSync"].is_object() {
        document["erpSync"].clone()
    } else {
        last.clone()
    };
    Ok(json!({"lastSuccess":manifest,"sqlSync":last}))
}

#[cfg(test)]
#[path = "sql_sync_tests.rs"]
mod tests;
