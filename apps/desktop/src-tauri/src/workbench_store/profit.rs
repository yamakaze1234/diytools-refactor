// 本机利润观察：按已保存税价计算核算利润；离线 ERP 成本保持未知，不冒充实时观测。
//! Offline manual observations. Only dedicated tables are written; business state
//! and cached ERP values are never changed or treated as a live cost observation.
use super::*;

const FORMULA: &str = "profit/v2";
const SOURCE: &str = "offline-manual";
const ERP_UNKNOWN: &str = "ERP 未实时采集；本轮仅检测已保存的本地核算利润";

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

// Parse decimal text exactly (including scientific notation). Do not pass money
// through f64: Python's Decimal ROUND_HALF_UP is the compatibility contract.
// 把十进制输入转换为整数比例，后续金额运算避免浮点舍入漂移。
fn decimal(value: &Value) -> Option<(i128, i128)> {
    let raw = match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_owned(),
        _ => return None,
    };
    let raw = raw.strip_prefix('+').unwrap_or(&raw);
    let mut exponent = raw.split(['e', 'E']);
    let mantissa = exponent.next()?;
    let power = exponent
        .next()
        .map(str::parse::<i32>)
        .transpose()
        .ok()?
        .unwrap_or(0);
    if exponent.next().is_some() || power.unsigned_abs() > 30 {
        return None;
    }
    let mut pieces = mantissa.split('.');
    let whole = pieces.next()?;
    let fraction = pieces.next().unwrap_or("");
    if pieces.next().is_some() || (whole.is_empty() && fraction.is_empty()) {
        return None;
    }
    let digits = format!("{whole}{fraction}");
    if digits.len() > 30 || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut numerator = digits.parse::<i128>().ok()?;
    let scale = i32::try_from(fraction.len()).ok()? - power;
    let denominator = if scale >= 0 {
        10_i128.checked_pow(scale as u32)?
    } else {
        numerator = numerator.checked_mul(10_i128.checked_pow((-scale) as u32)?)?;
        1
    };
    Some((numerator, denominator))
}

// 按既有利润口径把非负金额比例四舍五入为整数分，避免浮点计算误差。
fn round_ratio(numerator: i128, denominator: i128) -> Option<i64> {
    let whole = numerator.checked_div(denominator)?;
    let remainder = numerator.checked_rem(denominator)?;
    i64::try_from(whole.checked_add(i128::from(remainder.checked_mul(2)? >= denominator))?).ok()
}

fn money(value: &Value) -> Option<i64> {
    let (n, d) = decimal(value)?;
    round_ratio(n.checked_mul(100)?, d)
}

fn term(config: &Value) -> Option<i64> {
    let raw = config.get("installment").unwrap_or(&Value::Null);
    if raw.is_null() && config.get("installment").is_none() {
        return Some(0);
    }
    match raw {
        Value::String(s) => s
            .parse::<i64>()
            .ok()
            .filter(|_| ["0", "12", "24"].contains(&s.as_str())),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
    .filter(|t| [0, 12, 24].contains(t))
}

fn quantity(value: &Value) -> Option<i64> {
    let qty = match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse().ok()
        }
        _ => None,
    }?;
    (1..=1000).contains(&qty).then_some(qty)
}

// Legacy captures can contain numeric IDs. Keep string IDs byte-for-byte,
// including leading zeroes; never collapse distinct numeric links to "".
fn identity(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) if value.as_f64() != Some(0.0) => value.to_string(),
        _ => String::new(),
    }
}

fn eligible(config: &Value, shop: &str) -> bool {
    config["shopId"].as_str() == Some(shop)
        && !truthy(&config["deletedAt"])
        && !truthy(&config["emptyLinkDraft"])
        && config["productCategory"] != "主机模板"
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

// 冻结实际 BOM、数量、价格及分期条件，后续比较依据该次内容而非可变当前值。
fn snapshot(config: &Value, configs: &[Value]) -> Result<Value> {
    // Match actualParts() for the nullable captured field. An explicit [] is
    // an empty actual BOM and must never fall back to display parts.
    let raw_parts = config
        .get("actualParts")
        .filter(|parts| !parts.is_null())
        .unwrap_or(&config["parts"]);
    let parts = raw_parts.as_array().ok_or("实际成本配件须为数组")?;
    let mut rows = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if !part.is_object() {
            return Err("实际成本配件格式无效".into());
        }
        let name = part["name"].as_str().unwrap_or("");
        let goods = identity(&part["goodsId"]);
        if (name.is_empty() && goods.is_empty()) || part["specialComponent"] == true {
            continue;
        }
        // Existing editors save the override into tax as well. Honor a valid
        // matching override if a captured legacy row has not materialized it.
        let override_value = &part["taxOverride"]["value"];
        let tax = if part["taxOverride"]["goodsId"].as_str() == Some(goods.as_str())
            && override_value.is_number()
            && money(override_value).is_some()
        {
            override_value
        } else {
            &part["tax"]
        };
        let slot = part["slot"].as_str().unwrap_or("");
        let line = part["lineId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{index}:{slot}"));
        rows.push(json!({"lineId":line,"slot":slot,"name":name,"goodsId":goods,
            "qty":quantity(&part["qty"]),"taxCents":money(tax),"taxUpdatedAt":config["taxUpdatedAt"]}));
    }
    let price = money(&config["price"]);
    let installment = term(config);
    let consistent = configs
        .iter()
        .filter(|c| {
            c["shopId"] == config["shopId"]
                && identity(&c["productId"]) == identity(&config["productId"])
                && !truthy(&c["deletedAt"])
        })
        .all(|c| term(c).is_some() && term(c) == installment);
    let fee = if price.is_some() && consistent {
        installment.and_then(|t| {
            let (n, d) = decimal(&config["price"])?;
            round_ratio(
                n.checked_mul(match t {
                    12 => 6,
                    24 => 10,
                    _ => 0,
                })?,
                d,
            )
        })
    } else {
        None
    };
    Ok(
        json!({"shopId":config["shopId"],"productId":identity(&config["productId"]),
        "product":config["product"].as_str().unwrap_or(""),"configId":config["id"],
        "name":config["name"].as_str().unwrap_or(""),"revision":config["updatedAt"],
        "priceCents":price,"installment":config.get("installment").cloned().unwrap_or(json!(0)),
        "feeCents":fee,"parts":rows}),
    )
}

// 按已保存税价计算核算利润，成本不完整时返回未知而不是把缺价按零处理。
fn accounting(snapshot: &Value) -> (Option<i64>, Option<i64>, String) {
    let (Some(price), Some(fee)) = (
        snapshot["priceCents"].as_i64(),
        snapshot["feeCents"].as_i64(),
    ) else {
        return (None, None, "到手价或分期无效".into());
    };
    let parts = snapshot["parts"].as_array().unwrap();
    if parts.is_empty() {
        return (None, None, "没有实际成本配件".into());
    }
    let mut total = 0_i64;
    let mut issues = Vec::new();
    for part in parts {
        let slot = part["slot"].as_str().unwrap_or("");
        let Some(qty) = part["qty"].as_i64() else {
            issues.push(format!("{slot}数量无效"));
            continue;
        };
        let Some(unit) = part["taxCents"].as_i64() else {
            issues.push(format!("{slot}含税价缺失"));
            continue;
        };
        let Some(sum) = unit.checked_mul(qty).and_then(|sum| total.checked_add(sum)) else {
            return (None, None, "成本金额超过核算范围".into());
        };
        total = sum;
    }
    if !issues.is_empty() {
        return (None, None, issues.join("；"));
    }
    let commission = round_ratio(i128::from(price) * 4, 100).unwrap();
    match price
        .checked_sub(total)
        .and_then(|v| v.checked_sub(commission))
        .and_then(|v| v.checked_sub(10000))
        .and_then(|v| v.checked_sub(fee))
    {
        Some(profit) => (Some(profit), Some(total), String::new()),
        None => (None, None, "利润金额超过核算范围".into()),
    }
}

fn schema(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS local_profit_runs(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,request_id TEXT UNIQUE NOT NULL,
        request_hash TEXT NOT NULL,shop_id TEXT NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_profit_results(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,config_id TEXT NOT NULL,metric TEXT NOT NULL,source TEXT NOT NULL,
        formula TEXT NOT NULL,content_hash TEXT NOT NULL,document TEXT NOT NULL,
        UNIQUE(run_id,shop_id,config_id,metric));
        CREATE INDEX IF NOT EXISTS local_profit_result_scope ON local_profit_results(shop_id,config_id,metric,sequence);
        CREATE TABLE IF NOT EXISTS local_profit_baselines(
        shop_id TEXT NOT NULL,config_id TEXT NOT NULL,metric TEXT NOT NULL,source TEXT NOT NULL,formula TEXT NOT NULL,
        latest_id TEXT NOT NULL,anchor_id TEXT NOT NULL,anchor_cents INTEGER NOT NULL,was_loss INTEGER NOT NULL,
        PRIMARY KEY(shop_id,config_id,metric,source,formula));
        CREATE TABLE IF NOT EXISTS local_profit_receipts(
        request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,document TEXT NOT NULL);")
        .map_err(|e|e.to_string())
}

fn shop(input: &Value) -> Result<&str> {
    input["shopId"]
        .as_str()
        .filter(|s| ["intel", "gigabyte", "jonsbo"].contains(s))
        .ok_or_else(|| "店铺无效".into())
}

fn request_id(input: &Value) -> Result<&str> {
    input["requestId"]
        .as_str()
        .filter(|s| {
            (8..=100).contains(&s.len())
                && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
        .ok_or_else(|| "检测请求 ID 无效".into())
}

fn rows(c: &Connection, run: &str, shop: &str) -> Result<Vec<Value>> {
    let mut query = c.prepare("SELECT document FROM local_profit_results WHERE run_id=?1 AND shop_id=?2 ORDER BY sequence")
        .map_err(|e|e.to_string())?;
    query
        .query_map(params![run, shop], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|raw| {
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
}

// 明确选择配置后创建幂等观察批次，结果与基线同事务写入，不修改业务配置。
pub fn profit_start(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let shop = shop(input)?;
    let request = request_id(input)?;
    let ids = input["configIds"]
        .as_array()
        .ok_or("请明确勾选要检测的配置")?;
    if ids.is_empty() || ids.len() > 1000 {
        return Ok(failure(400, "请勾选 1–1000 套配置"));
    }
    let mut selected = HashSet::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("配置范围无效")?;
        if !selected.insert(id) {
            return Err("配置范围重复".into());
        }
    }
    let mut scope_ids: Vec<_> = selected.iter().copied().collect();
    scope_ids.sort_unstable();
    let scope_hash = hash(&json!({"shopId":shop,"configIds":scope_ids}));
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    schema(&tx)?;
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT id,request_hash FROM local_profit_runs WHERE request_id=?1",
            [request],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, saved_hash)) = existing {
        if saved_hash != scope_hash {
            return Ok(failure(409, "同一检测请求不能用于不同范围"));
        }
        return Ok(response(
            200,
            json!({"runId":id,"phase":"completed","repeated":true,"offline":true}),
        ));
    }
    let current = state(&tx)?;
    let configs = current["configs"].as_array().ok_or("配置数据无效")?;
    let selected_configs: HashMap<_, _> = configs
        .iter()
        .filter(|c| eligible(c, shop))
        .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
        .collect();
    let mut snapshots = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(config) = selected_configs.get(id.as_str().unwrap()) else {
            return Ok(failure(409, "所选配置已变化或不属于本店，请重新选择"));
        };
        snapshots.push(snapshot(config, configs)?);
    }
    let run_id = unique();
    let at = now();
    let run = json!({"id":run_id,"request_id":request,"workspace":"local-workbench", "shop_id":shop,
        "revision":revision(&current),"source":SOURCE,"formula":FORMULA,"status":"completed",
        "started_at":at,"finished_at":at,"covered":snapshots.len(),"error":null,
        "erpCollected":false,"accountingSource":"saved-tax","offline":true});
    tx.execute("INSERT INTO local_profit_runs(id,request_id,request_hash,shop_id,document) VALUES(?1,?2,?3,?4,?5)",
        params![run_id,request,scope_hash,shop,run.to_string()]).map_err(|e|e.to_string())?;
    for snapshot in snapshots {
        let config = snapshot["configId"].as_str().unwrap();
        let content_hash = hash(&snapshot);
        for metric in ["erp", "accounting"] {
            let (profit, cost, reason) = if metric == "accounting" {
                accounting(&snapshot)
            } else {
                (None, None, ERP_UNKNOWN.into())
            };
            let baseline: Option<(String,String,i64,bool)> = tx.query_row("SELECT latest_id,anchor_id,anchor_cents,was_loss FROM local_profit_baselines WHERE shop_id=?1 AND config_id=?2 AND metric=?3 AND source=?4 AND formula=?5",
                params![shop,config,metric,SOURCE,FORMULA],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
            let previous: Option<Value> = if let Some(base) = &baseline {
                let raw: String = tx
                    .query_row(
                        "SELECT document FROM local_profit_results WHERE id=?1",
                        [&base.0],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                Some(serde_json::from_str(&raw).map_err(|e| e.to_string())?)
            } else {
                None
            };
            let previous_delta = profit.and_then(|p| {
                previous
                    .as_ref()?
                    .get("profit_cents")?
                    .as_i64()
                    .map(|old| i128::from(p) - i128::from(old))
            });
            let anchor_delta =
                profit.and_then(|p| baseline.as_ref().map(|b| i128::from(p) - i128::from(b.2)));
            let changed = anchor_delta.is_some_and(|d| d.abs() > 10000);
            let loss = profit.is_some_and(|p| p < -30000);
            let recovered = profit.is_some() && baseline.as_ref().is_some_and(|b| b.3) && !loss;
            let id = unique();
            let mut details = json!({"source":if metric=="erp" {"unavailable-offline"} else {"saved-tax"},
                "costAt":if metric=="erp" {Value::Null} else {snapshot["parts"].as_array().unwrap().iter().filter_map(|p|p["taxUpdatedAt"].as_str()).max().map(|s|json!(s)).unwrap_or(Value::Null)},
                "erpCollected":false,"formulaVersion":FORMULA,
                "parts":snapshot["parts"].as_array().unwrap().iter().map(|part|{let mut row=part.clone();row["unitCostCents"]=if metric=="accounting" {part["taxCents"].clone()} else {Value::Null};row}).collect::<Vec<_>>()});
            if profit.is_some()
                && let Some(old) = &previous
            {
                causes(&mut details, &snapshot, old);
            }
            let row = json!({"id":id,"run_id":run_id,"workspace":"local-workbench","shop_id":shop,
                "config_id":config,"metric":metric,"valid":profit.is_some(),"profit_cents":profit,"cost_cents":cost,
                "previous_id":baseline.as_ref().map(|b|&b.0),"anchor_id":baseline.as_ref().map(|b|&b.1),
                "previous_delta_cents":previous_delta,"anchor_delta_cents":anchor_delta,
                "loss":loss,"changed":changed,"recovered":recovered,"reason":reason,"details":details,
                "created_at":at,"snapshot":snapshot,"content_hash":content_hash,"configUpdated":false});
            tx.execute("INSERT INTO local_profit_results(id,run_id,shop_id,config_id,metric,source,formula,content_hash,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![id,run_id,shop,config,metric,SOURCE,FORMULA,content_hash,row.to_string()]).map_err(|e|e.to_string())?;
            // 只有有效成本产生的利润才能推进比较基线，未知结果保留旧基线。
            if let Some(profit) = profit {
                let (anchor_id, anchor) = baseline
                    .as_ref()
                    .filter(|_| !changed)
                    .map(|b| (b.1.clone(), b.2))
                    .unwrap_or((id.clone(), profit));
                tx.execute("INSERT INTO local_profit_baselines VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(shop_id,config_id,metric,source,formula) DO UPDATE SET latest_id=excluded.latest_id,anchor_id=excluded.anchor_id,anchor_cents=excluded.anchor_cents,was_loss=excluded.was_loss",
                    params![shop,config,metric,SOURCE,FORMULA,id,anchor_id,anchor,loss]).map_err(|e|e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(
        200,
        json!({"runId":run_id,"phase":"completed","repeated":false,"offline":true}),
    ))
}

// 比较前后快照中的配件和成本，解释利润变化来源。
fn causes(details: &mut Value, snapshot: &Value, old: &Value) {
    let old_parts: HashMap<_, _> = old["details"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["lineId"].as_str().unwrap_or(""), p))
        .collect();
    let new_parts: HashMap<_, _> = details["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["lineId"].as_str().unwrap_or(""), p))
        .collect();
    let mut changes = Vec::new();
    let mut keys: Vec<_> = old_parts.keys().chain(new_parts.keys()).copied().collect();
    keys.sort_unstable();
    keys.dedup();
    for key in keys {
        let before = old_parts.get(key).copied();
        let after = new_parts.get(key).copied();
        let sum = |part: Option<&Value>| {
            part.map(|p| {
                i128::from(p["unitCostCents"].as_i64().unwrap_or(0))
                    * i128::from(p["qty"].as_i64().unwrap_or(0))
            })
            .unwrap_or(0)
        };
        let a = sum(before);
        let b = sum(after);
        if a != b
            || before.is_some_and(|p| {
                after.is_some_and(|q| p["goodsId"] != q["goodsId"] || p["name"] != q["name"])
            })
        {
            changes.push(json!({"lineId":key,"name":after.or(before).unwrap()["name"],"beforeCents":a,"afterCents":b,
                "beforeQty":before.map(|p|&p["qty"]),"afterQty":after.map(|p|&p["qty"]),
                "beforeUnitCostCents":before.map(|p|&p["unitCostCents"]),"afterUnitCostCents":after.map(|p|&p["unitCostCents"]),"profitImpactCents":a-b}));
        }
    }
    let old_price = old["snapshot"]["priceCents"].as_i64().unwrap();
    let price = snapshot["priceCents"].as_i64().unwrap();
    let price_impact = i128::from(price)
        - i128::from(old_price)
        - i128::from(
            round_ratio(i128::from(price) * 4, 100).unwrap()
                - round_ratio(i128::from(old_price) * 4, 100).unwrap(),
        );
    let fee_impact = i128::from(old["snapshot"]["feeCents"].as_i64().unwrap())
        - i128::from(snapshot["feeCents"].as_i64().unwrap());
    let cost_impact: i128 = changes
        .iter()
        .map(|c| c["profitImpactCents"].as_i64().map(i128::from).unwrap_or(0))
        .sum();
    let profit = accounting(snapshot).0.unwrap();
    let residual = i128::from(profit)
        - i128::from(old["profit_cents"].as_i64().unwrap())
        - price_impact
        - fee_impact
        - cost_impact;
    details["causes"] = json!(changes);
    details["priceImpactCents"] = json!(price_impact);
    details["feeImpactCents"] = json!(fee_impact);
    details["roundingAndBasisImpactCents"] = json!(residual);
}

// 读取已保存观察结果并核对当前内容变化，不能把旧结果冒充最新计算。
pub fn profit_status(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let shop = shop(input)?;
    let run_id = input["runId"].as_str().ok_or("检测任务无效")?;
    let c = db(&store.path)?;
    schema(&c)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT document FROM local_profit_runs WHERE id=?1 AND shop_id=?2",
            params![run_id, shop],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        return Ok(failure(404, "本店检测任务不存在"));
    };
    let run: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let current = state(&c)?;
    let configs = current["configs"].as_array().ok_or("配置数据无效")?;
    let by_id: HashMap<_, _> = configs
        .iter()
        .filter(|c| eligible(c, shop))
        .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
        .collect();
    let mut results = rows(&c, run_id, shop)?;
    for row in &mut results {
        row["configUpdated"] = json!(
            by_id
                .get(row["config_id"].as_str().unwrap())
                .and_then(|c| snapshot(c, configs).ok())
                .is_none_or(|s| hash(&s) != row["content_hash"].as_str().unwrap())
        );
    }
    Ok(response(
        200,
        json!({"run":run,"results":results,"phase":"completed","offline":true}),
    ))
}

// 按店铺及配置范围读取历史观察，避免混入其他业务范围的结果。
pub fn profit_history(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let shop = shop(input)?;
    let c = db(&store.path)?;
    schema(&c)?;
    let mut query = c.prepare("SELECT document FROM local_profit_runs WHERE shop_id=?1 ORDER BY sequence DESC LIMIT 50").map_err(|e|e.to_string())?;
    let runs: Vec<Value> = query
        .query_map([shop], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|raw| {
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<_>>()?;
    Ok(response(
        200,
        json!({"runs":runs,"offline":true,"retention":"no-auto-prune-v1"}),
    ))
}

// 校验目标结果和当前配置后重设比较基线，过期或无效观察不能推进基线。
pub fn profit_reset(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let shop = shop(input)?;
    let request = request_id(input)?;
    let config = input["configId"].as_str().ok_or("配置身份无效")?;
    let metric = input["metric"]
        .as_str()
        .filter(|m| ["erp", "accounting"].contains(m))
        .ok_or("利润口径无效")?;
    let result = input["resultId"].as_str().ok_or("检测结果无效")?;
    let request_hash =
        hash(&json!({"shopId":shop,"configId":config,"metric":metric,"resultId":result}));
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    schema(&tx)?;
    let receipt: Option<(String, String)> = tx
        .query_row(
            "SELECT request_hash,document FROM local_profit_receipts WHERE request_id=?1",
            [request],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((saved, raw)) = receipt {
        return if saved == request_hash {
            Ok(response(
                200,
                serde_json::from_str(&raw).map_err(|e| e.to_string())?,
            ))
        } else {
            Ok(failure(409, "同一重设请求不能用于不同结果"))
        };
    }
    let latest: Option<(String,String,String)> = tx.query_row("SELECT id,content_hash,document FROM local_profit_results WHERE shop_id=?1 AND config_id=?2 AND metric=?3 AND source=?4 AND formula=?5 ORDER BY sequence DESC LIMIT 1",
        params![shop,config,metric,SOURCE,FORMULA],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let Some((id, content_hash, raw)) = latest else {
        return Ok(failure(409, "请先检测后重设基准"));
    };
    let row: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let current = state(&tx)?;
    let configs = current["configs"].as_array().ok_or("配置数据无效")?;
    let live = configs
        .iter()
        .find(|c| c["id"].as_str() == Some(config) && eligible(c, shop));
    if id != result
        || row["valid"] != true
        || live
            .and_then(|c| snapshot(c, configs).ok())
            .is_none_or(|s| hash(&s) != content_hash)
    {
        return Ok(failure(
            409,
            "这不是当前配置的最新有效结果，请重新检测后重设基准",
        ));
    }
    let updated = tx.execute("UPDATE local_profit_baselines SET anchor_id=latest_id,anchor_cents=?1 WHERE shop_id=?2 AND config_id=?3 AND metric=?4 AND source=?5 AND formula=?6 AND latest_id=?7",
        params![row["profit_cents"].as_i64(),shop,config,metric,SOURCE,FORMULA,result]).map_err(|e|e.to_string())?;
    if updated != 1 {
        return Ok(failure(409, "基准已变化，请重新检测"));
    }
    let receipt = json!({"ok":true,"resultId":result,"metric":metric});
    tx.execute(
        "INSERT INTO local_profit_receipts VALUES(?1,?2,?3)",
        params![request, request_hash, receipt.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(200, receipt))
}

#[cfg(test)]
#[path = "profit_tests.rs"]
mod tests;
