//! 草稿和来源写只使用宿主冻结的预览。每个提交的编号、送出状态和已验证回执与任务一起原子落盘。
use super::*;
#[cfg(test)]
mod tests;

pub(crate) fn stepped(method: &str) -> bool {
    matches!(method, "draft.apply" | "sources.apply")
}
pub(crate) fn preview(method: &str) -> bool {
    matches!(method, "draft.preview" | "sources.preview")
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum StepState {
    Pending,
    Submitted,
    Confirmed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Step {
    pub index: usize,
    pub operation_id: String,
    pub shop_id: String,
    pub kind: String,
    pub state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<Value>,
    // 当前领取已发送过的步骤须由显式重试重新领取，IPC 重复调用不能再获一次发送许可。
    #[serde(skip)]
    submitted_by: Option<String>,
}
#[derive(Default)]
pub(crate) struct SourceScope {
    pub shared: bool,
    pub follow: bool,
    pub follow_shops: Vec<String>,
    pub shared_api_shops: std::collections::BTreeSet<String>,
    pub workspace_shops: std::collections::BTreeSet<String>,
}
fn shop(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| crate::agent_queries::SHOPS.iter().any(|(id, _)| *id == s))
}
fn invalid() -> AgentError {
    error(
        "INVALID_PARAMS",
        "请求中的动作、目标店铺或字段与允许范围不符",
    )
}
// WebView 会把 100.00 序列化为 100；数字按可安全表示的 JS 数值比较，其余数据严格逐项一致。
fn same_request(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a
            .as_f64()
            .zip(b.as_f64())
            .is_some_and(|(x, y)| x == y && x.abs() <= 9_007_199_254_740_991.0),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| same_request(v, other)))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_request(x, y))
        }
        _ => false,
    }
}
pub(super) fn validate_request(method: &str, params: &Value) -> Result<()> {
    fields(
        params,
        &["operationId", "request"],
        &["operationId", "request"],
    )?;
    let r = &params["request"];
    if !shop(&r["shopId"]) {
        return Err(invalid());
    }
    if method == "draft.preview" {
        fields(
            r,
            &["shopId", "mode", "productName", "configs"],
            &["shopId", "mode", "productName", "configs"],
        )?;
        text(r, "productName")?;
        if r["mode"] != "new_draft_link" {
            return Err(invalid());
        }
        let rows = r["configs"]
            .as_array()
            .filter(|v| (1..=16).contains(&v.len()))
            .ok_or_else(invalid)?;
        for row in rows {
            fields(
                row,
                &["name", "parts", "actualParts", "price"],
                &["name", "parts"],
            )?;
            text(row, "name")?;
            for parts in [row.get("parts"), row.get("actualParts")]
                .into_iter()
                .flatten()
            {
                for part in parts.as_array().ok_or_else(invalid)? {
                    fields(part, &["slot", "sourceId", "qty"], &["slot", "sourceId"])?;
                    text(part, "slot")?;
                    text(part, "sourceId")?;
                }
            }
        }
    } else {
        fields(
            r,
            &[
                "shopId",
                "scope",
                "action",
                "sourceId",
                "goodsId",
                "fields",
                "restoreFields",
                "resumeTax",
                "followConfigs",
            ],
            &["shopId", "scope", "action"],
        )?;
        let shared = match r["scope"].as_str() {
            Some("shop") => false,
            Some("shared") => true,
            _ => return Err(invalid()),
        };
        let action = r["action"].as_str().ok_or_else(invalid)?;
        let optional_flag = |key| r.get(key).is_none_or(Value::is_boolean);
        if !optional_flag("followConfigs")
            || !optional_flag("resumeTax")
            || (r.get("restoreFields").is_some() && !(shared && action == "edit"))
            || (r.get("resumeTax").is_some() && (shared || action != "edit"))
        {
            return Err(invalid());
        }
        match action {
            "edit" | "archive" | "restore" if action == "edit" || !shared => {
                text(r, "sourceId")?;
                if r.get("goodsId").is_some() {
                    return Err(invalid());
                }
            }
            "adopt_erp" => {
                text(r, "goodsId")?;
                if r.get("sourceId").is_some() {
                    return Err(invalid());
                }
            }
            "create_special"
                if shared && r.get("sourceId").is_none() && r.get("goodsId").is_none() => {}
            _ => return Err(invalid()),
        }
    }
    canonical_uuid(params["operationId"].as_str().ok_or_else(invalid)?)?;
    Ok(())
}

pub(super) fn frozen<'a>(
    journal: &'a Journal,
    method: &str,
    params: &Value,
    allow_expired: bool,
) -> Result<&'a Value> {
    let expected = match method {
        "sources.apply" => "sources.preview",
        "draft.apply" => "draft.preview",
        _ => return Err(invalid()),
    };
    let record = journal
        .jobs
        .iter()
        .find(|j| {
            Some(j.id.as_str()) == params["planId"].as_str()
                && j.method == expected
                && j.status == "succeeded"
        })
        .ok_or_else(|| error("PLAN_NOT_FOUND", "未找到对应类型的成功预览"))?;
    if !allow_expired && now().saturating_sub(record.updated_at) >= PLAN_TTL_MS {
        return Err(error("PLAN_EXPIRED", "预览已过期，请重新预览"));
    }
    record
        .plan
        .as_ref()
        .ok_or_else(|| error("PLAN_NOT_FOUND", "预览正文缺失"))
}
fn catalog_scope_matches(request: &Value, step: &Value) -> bool {
    let action = step["action"].as_str().unwrap_or("");
    let doc = &step["body"]["document"];
    if step["shopId"] != request["shopId"] {
        return false;
    }
    match (step["catalogKind"].as_str(), action) {
        (Some("sources"), "replace" | "restore" | "archive") => {
            request["scope"] == "shop"
                && step["resourceId"] == request["sourceId"]
                && (action == "replace" || request["action"] == action)
        }
        (Some("shared-sources"), "create") => {
            if request["scope"] == "shop" {
                request["action"] == "adopt_erp"
                    && doc["erpAdoption"].is_object()
                    && doc.get("edits").is_none()
                    && step["resourceId"] == request["goodsId"]
            } else {
                matches!(
                    request["action"].as_str(),
                    Some("adopt_erp" | "create_special")
                ) && doc.get("erpAdoption").is_none()
            }
        }
        (Some("shared-sources"), "replace") if request["action"] == "edit" => {
            let own = request["shopId"].as_str().unwrap_or("");
            // 共用 API 也负责单店覆盖，通过正文的实际 edits 键阻止单店许可变成三店写入。
            doc["edits"].as_object().is_some_and(|edits| {
                !edits.is_empty()
                    && edits
                        .keys()
                        .all(|k| k == own || (k == "shared" && request["scope"] == "shared"))
            })
        }
        _ => false,
    }
}
pub(super) fn validate_plan(job: &Job, plan: &Value) -> Result<()> {
    let r = &job.params["request"];
    if plan["shop"] != r["shopId"] || !same_request(&plan["request"], r) {
        return Err(error("INVALID_PLAN", "计划与原请求或店铺不一致"));
    }
    let steps = plan["steps"]
        .as_array()
        .ok_or_else(|| error("INVALID_PLAN", "缺少冻结的步骤列表"))?;
    if job.method == "draft.preview" {
        if steps.len() != 1 {
            return Err(error("INVALID_PLAN", "草稿必须单步保存"));
        }
        let changes = steps[0]["changes"]
            .as_array()
            .ok_or_else(|| error("INVALID_PLAN", "缺少草稿新建清单"))?;
        let product = changes
            .first()
            .and_then(|c| c["document"]["productId"].as_str())
            .filter(|s| Uuid::parse_str(s).is_ok());
        let mut ids = std::collections::HashSet::new();
        let empty = |v: &Value| v.is_null() || v == "";
        if product.is_none()
            || changes.len() != r["configs"].as_array().map_or(0, Vec::len)
            || changes.iter().any(|change| {
                let doc = &change["document"];
                change["action"] != "create"
                    || doc["id"] != change["id"]
                    || !doc["id"]
                        .as_str()
                        .is_some_and(|id| Uuid::parse_str(id).is_ok() && ids.insert(id))
                    || doc["productDraft"] != true
                    || doc["shopId"] != plan["shop"]
                    || doc["productId"].as_str() != product
                    || !empty(&doc["spu"])
                    || !empty(&doc["skuId"])
            })
        {
            return Err(error(
                "INVALID_PLAN",
                "草稿计划只能在同一全新草稿链接中创建配置，禁止带入正式商品标识",
            ));
        }
    }
    for step in steps {
        let own = step["shopId"] == r["shopId"];
        let valid = match (job.method.as_str(), step["kind"].as_str()) {
            ("draft.preview", Some("configurations")) => own,
            ("sources.preview", Some("catalog")) => catalog_scope_matches(r, step),
            ("sources.preview", Some("costs")) => own || r["scope"] == "shared",
            ("sources.preview", Some("configurations")) => {
                r["followConfigs"] == true && (own || r["scope"] == "shared")
            }
            _ => false,
        };
        if !valid || !shop(&step["shopId"]) {
            return Err(error("INVALID_PLAN", "步骤超出预览请求的操作类型或店铺"));
        }
    }
    Ok(())
}
pub(super) fn initial(method: &str, operation: &str, plan: &Value) -> Vec<Step> {
    plan["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, step)| {
            // 将主编号和步骤序号编码为稳定的 RFC 9562 自定义 UUID，重放不会换号。
            let operation_id = if method == "draft.apply" {
                operation.to_owned()
            } else {
                let digest =
                    Sha256::digest(format!("diytools/sources-step/v1/{operation}/{index}"));
                let mut bytes: [u8; 16] = digest[..16].try_into().unwrap();
                bytes[6] = (bytes[6] & 0x0f) | 0x80;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                Uuid::from_bytes(bytes).to_string()
            };
            Step {
                index,
                operation_id,
                shop_id: step["shopId"].as_str().unwrap_or_default().to_owned(),
                kind: step["kind"].as_str().unwrap_or_default().to_owned(),
                state: StepState::Pending,
                receipt: None,
                submitted_by: None,
            }
        })
        .collect()
}
pub(super) fn started(steps: &[Step]) -> bool {
    steps.iter().any(|s| s.state != StepState::Pending)
}
pub(super) fn confirmed(steps: &[Step]) -> bool {
    steps.iter().all(|s| s.state == StepState::Confirmed)
}
pub(super) fn check_journal(journal: &Journal) -> Result<()> {
    for job in &journal.jobs {
        if preview(&job.method) && job.status == "succeeded" {
            validate_plan(
                job,
                job.plan
                    .as_ref()
                    .ok_or_else(|| error("JOBS_CORRUPT", "缺少已冻结的步骤计划"))?,
            )?;
        }
        if !stepped(&job.method) {
            continue;
        }
        let plan = frozen(journal, &job.method, &job.params, true)?;
        let expected = initial(&job.method, &job.operation_id, plan);
        let mut pending = false;
        let mut submitted = false;
        if job.steps.len() != expected.len()
            || job.steps.iter().zip(expected).any(|(s, want)| {
                let order_invalid = match s.state {
                    StepState::Pending => {
                        pending = true;
                        s.receipt.is_some()
                    }
                    StepState::Submitted => {
                        let bad = pending || submitted || s.receipt.is_some();
                        submitted = true;
                        bad
                    }
                    StepState::Confirmed => {
                        pending
                            || submitted
                            || s.receipt.as_ref().is_none_or(|r| {
                                r["operation_id"] != s.operation_id || r["shop_id"] != s.shop_id
                            })
                    }
                };
                order_invalid
                    || s.index != want.index
                    || s.operation_id != want.operation_id
                    || s.shop_id != want.shop_id
                    || s.kind != want.kind
            })
            || (job.status == "succeeded" && !confirmed(&job.steps))
        {
            return Err(error("JOBS_CORRUPT", "已保存步骤与原计划或回执不一致"));
        }
    }
    Ok(())
}
pub(super) fn progress(job: &Job) -> Value {
    let summary = |s: &Step| {
        let mut value = json!({"index":s.index,"kind":s.kind,"shopId":s.shop_id,"operationId":s.operation_id,"state":s.state});
        if let Some(receipt) = &s.receipt {
            let mut brief = serde_json::Map::new();
            for key in ["kind", "resource_id", "sourceId", "version", "archived"] {
                if let Some(field) = receipt.get(key) {
                    brief.insert(key.to_owned(), field.clone());
                }
            }
            if let Some(rows) = receipt["changes"].as_array() {
                brief.insert("affectedCount".into(), json!(rows.len()));
            }
            value["receipt"] = Value::Object(brief);
        }
        value
    };
    let (saved, remaining): (Vec<_>, Vec<_>) = job
        .steps
        .iter()
        .partition(|s| s.state == StepState::Confirmed);
    json!({"partialSuccess":!saved.is_empty()&&!remaining.is_empty(),"confirmedSteps":saved.into_iter().map(summary).collect::<Vec<_>>(),
        "remainingSteps":remaining.into_iter().enumerate().map(|(n,step)|{
            let mut row=summary(step);
            if let Some(reason)=&job.error {
                row["reason"]=if n==0{json!({"code":reason["code"],"message":reason["message"]})}else{json!({"code":"PREVIOUS_STEP_INCOMPLETE","message":"等待前一步完成"})};
            }
            row
        }).collect::<Vec<_>>()})
}
fn metadata(value: &Value, keys: &[&str]) -> Value {
    let mut object = serde_json::Map::new();
    for key in keys {
        if let Some(v) = value.get(key).filter(|v| !v.is_object() && !v.is_array()) {
            object.insert((*key).to_owned(), v.clone());
        }
    }
    Value::Object(object)
}
pub(super) fn public_result(job: &Job, value: &Value) -> Value {
    let mut result = metadata(
        value,
        &["shopId", "localSave", "nasSave", "uiRefreshed", "productId"],
    );
    if let Some(ids) = value["configIds"].as_array() {
        result["configIds"] = json!(ids.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    }
    let receipts = job
        .steps
        .iter()
        .filter_map(|s| s.receipt.as_ref())
        .map(|receipt| {
            let mut row = metadata(
                receipt,
                &[
                    "operation_id",
                    "shop_id",
                    "kind",
                    "resource_id",
                    "version",
                    "archived",
                    "sourceId",
                ],
            );
            if let Some(changes) = receipt["changes"].as_array() {
                row["changes"] = json!(
                    changes
                        .iter()
                        .map(|c| metadata(
                            c,
                            &[
                                "configuration_id",
                                "id",
                                "version",
                                "archived",
                                "shop_id",
                                "operation_id"
                            ]
                        ))
                        .collect::<Vec<_>>()
                );
            }
            row
        })
        .collect::<Vec<_>>();
    if job.method == "draft.apply" {
        result["receipt"] = receipts.into_iter().next().unwrap_or(Value::Null);
    } else {
        result["receipts"] = json!(receipts);
    }
    result
}
fn source_requirements(r: &Value, steps: Option<&Vec<Value>>) -> SourceScope {
    let mut spec = SourceScope {
        shared: r["scope"] == "shared",
        follow: r["followConfigs"] == true,
        ..Default::default()
    };
    if r["action"] == "adopt_erp"
        && let Some(shop) = r["shopId"].as_str()
    {
        spec.shared_api_shops.insert(shop.to_owned());
        if !spec.shared {
            spec.workspace_shops.insert(shop.to_owned());
        }
    }
    for step in steps.into_iter().flatten() {
        let Some(shop) = step["shopId"].as_str() else {
            continue;
        };
        if step["kind"] == "configurations" && !spec.follow_shops.iter().any(|s| s == shop) {
            spec.follow_shops.push(shop.to_owned());
        }
        if step["kind"] == "costs" {
            spec.workspace_shops.insert(shop.to_owned());
        }
        if step["catalogKind"] == "shared-sources" {
            spec.shared_api_shops.insert(shop.to_owned());
        }
    }
    spec
}
fn inspect_scope(
    journal: &Journal,
    method: &str,
    params: &Value,
    preview_plan: Option<&Value>,
) -> Result<Option<SourceScope>> {
    let plan = match method {
        "sources.apply" => Some(frozen(journal, method, params, true)?),
        "sources.preview" => preview_plan,
        _ => return Ok(None),
    };
    let spec = match plan {
        Some(plan) => source_requirements(&plan["request"], plan["steps"].as_array()),
        None => source_requirements(&params["request"], None),
    };
    Ok(Some(spec))
}
impl AgentJobs {
    pub(crate) fn source_scope(&self, method: &str, params: &Value) -> Result<Option<SourceScope>> {
        if !matches!(method, "sources.preview" | "sources.apply") {
            return Ok(None);
        }
        inspect_scope(&self.lock()?.journal, method, params, None)
    }
    pub(crate) fn status_source_scope(&self, id: &str) -> Result<Option<SourceScope>> {
        let runtime = self.lock()?;
        let job = runtime
            .journal
            .jobs
            .iter()
            .find(|j| j.id == id)
            .ok_or_else(|| error("JOB_NOT_FOUND", "任务不存在"))?;
        inspect_scope(
            &runtime.journal,
            &job.method,
            &job.params,
            job.plan.as_ref(),
        )
    }
    /// 只接受正被领取的原任务。提交及确认都按顺序前进，重复确认必须是同一份 NAS 回执。
    pub(crate) fn record_step(
        &self,
        session: &str,
        id: &str,
        token: &str,
        index: usize,
        shop: Option<&str>,
        receipt: Option<&Value>,
    ) -> Result<()> {
        let mut runtime = self.lock()?;
        verify_claim(&runtime, session, id, token)?;
        let mut journal = runtime.journal.clone();
        let pos = journal
            .jobs
            .iter()
            .position(|j| j.id == id && stepped(&j.method))
            .ok_or_else(invalid)?;
        if let Some(receipt) = receipt {
            let job = &journal.jobs[pos];
            let plan = frozen(&journal, &job.method, &job.params, true)?;
            let expected = &plan["steps"][index];
            let kind = expected["catalogKind"]
                .as_str()
                .or(expected["kind"].as_str());
            if kind.is_none()
                || receipt["kind"].as_str() != kind
                || (expected["kind"] == "catalog"
                    && receipt["resource_id"] != expected["resourceId"])
            {
                return Err(error("SAVE_UNCONFIRMED", "回执类型或资源与冻结步骤不符"));
            }
        }
        let job = &mut journal.jobs[pos];
        if index >= job.steps.len() || !confirmed(&job.steps[..index]) {
            return Err(error("STEP_OUT_OF_ORDER", "步骤不存在或前一步尚未确认"));
        }
        let step = &mut job.steps[index];
        if let Some(receipt) = receipt {
            if !receipt.is_object()
                || receipt["operation_id"] != step.operation_id
                || receipt["shop_id"] != step.shop_id
            {
                return Err(error(
                    "SAVE_UNCONFIRMED",
                    "回执编号或目标店铺与冻结步骤不符",
                ));
            }
            if step.state == StepState::Confirmed {
                return if step.receipt.as_ref() == Some(receipt) {
                    Ok(())
                } else {
                    Err(error("STEP_RECEIPT_CONFLICT", "同一步骤不能确认不同回执"))
                };
            }
            if step.state != StepState::Submitted {
                return Err(error("STEP_NOT_SUBMITTED", "此步骤尚未获准提交"));
            }
            step.state = StepState::Confirmed;
            step.receipt = Some(receipt.clone());
        } else {
            if shop != Some(&step.shop_id) {
                return Err(error("INVALID_PLAN", "提交店铺与冻结步骤不符"));
            }
            if step.state == StepState::Confirmed {
                return Err(error("STEP_CONFIRMED", "已确认的步骤禁止重发"));
            }
            if step.submitted_by.as_deref() == Some(token) {
                return Err(error(
                    "STEP_ALREADY_SUBMITTED",
                    "本次领取已获提交许可，请先按原编号核对回执",
                ));
            }
            step.state = StepState::Submitted;
            step.submitted_by = Some(token.to_owned());
        }
        job.updated_at = now();
        self.commit(&mut runtime, journal)
    }
}
