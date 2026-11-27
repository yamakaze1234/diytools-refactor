use super::*;

pub(super) fn validate_params(params: &Value) -> Result<()> {
    if params.get("jobId").is_some() {
        fields(params, &["jobId", "offset", "limit"], &["jobId"])?;
        text(params, "jobId")?;
    } else {
        fields(
            params,
            &[
                "operationId",
                "shopId",
                "threshold",
                "productId",
                "status",
                "offset",
                "limit",
            ],
            &["operationId", "shopId"],
        )?;
        canonical_uuid(params["operationId"].as_str().unwrap_or(""))?;
        if !matches!(
            params["shopId"].as_str(),
            Some("intel" | "gigabyte" | "jonsbo")
        ) {
            return Err(error("INVALID_PARAMS", "请指定有效店铺"));
        }
        if params.get("productId").is_some() {
            text(params, "productId")?;
        }
        if params.get("status").is_some()
            && !matches!(params["status"].as_str(), Some("out" | "low" | "unknown"))
        {
            return Err(error("INVALID_PARAMS", "库存状态无效"));
        }
        if params
            .get("threshold")
            .is_some_and(|v| v.as_u64().is_none_or(|n| n > 100_000_000))
        {
            return Err(error("INVALID_PARAMS", "库存阈值超出范围"));
        }
    }
    if params
        .get("limit")
        .is_some_and(|v| v.as_u64().is_none_or(|n| !(1..=100).contains(&n)))
        || params
            .get("offset")
            .is_some_and(|v| v.as_u64().is_none_or(|n| n > u32::MAX as u64))
    {
        return Err(error("INVALID_PARAMS", "库存分页范围无效"));
    }
    Ok(())
}

// 状态查询和同编号重试仅返回摘要。读取缓存明细始终经有库存权限的 inventory.check。
pub(super) fn summary(value: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "shopId",
        "threshold",
        "checkedAt",
        "linkCount",
        "configCount",
        "counts",
        "total",
    ] {
        result[key] = value[key].clone();
    }
    result
}

fn find<'a>(journal: &'a Journal, id: &str) -> Result<&'a Job> {
    journal
        .jobs
        .iter()
        .find(|job| job.id == id && job.method == "inventory.check")
        .ok_or_else(|| error("JOB_NOT_FOUND", "未找到此账号的库存巡检任务"))
}

impl AgentJobs {
    pub fn inventory_shop(&self, id: &str) -> Result<String> {
        Ok(find(&self.lock()?.journal, id)?.params["shopId"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }
    pub(super) fn inventory_page(&self, id: &str, params: &Value) -> Result<Value> {
        let runtime = self.lock()?;
        let job = find(&runtime.journal, id)?;
        let mut response = public(job);
        if job.status != "succeeded" {
            return Ok(response);
        }
        let items = job
            .result
            .as_ref()
            .and_then(|v| v["items"].as_array())
            .ok_or_else(|| error("INVALID_RESULT", "巡检回执缺少库存明细"))?;
        let offset = params["offset"]
            .as_u64()
            .or(job.params["offset"].as_u64())
            .unwrap_or(0) as usize;
        let limit = params["limit"]
            .as_u64()
            .or(job.params["limit"].as_u64())
            .unwrap_or(20) as usize;
        let mut page = Vec::new();
        let mut bytes = 0;
        // 管道帧还包含回执元数据；长链接名称时缩短本页，给出真实的下一页位置。
        for item in items.iter().skip(offset).take(limit) {
            let size = item.to_string().len() + 1;
            if bytes + size > 900_000 {
                if page.is_empty() {
                    return Err(error("RESULT_TOO_LARGE", "单条库存明细超出管道上限"));
                }
                break;
            }
            page.push(item);
            bytes += size;
        }
        let next = offset + page.len();
        let result = &mut response["result"];
        result["offset"] = json!(offset);
        result["limit"] = json!(limit);
        result["nextOffset"] = json!((next < items.len()).then_some(next));
        result["items"] = json!(page);
        Ok(response)
    }
}
