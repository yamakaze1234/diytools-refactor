//! 短等待只读取原任务；排队和后续回读固定使用同一实例。
use diytools_agent_core::{transport, AgentError, Request, Response};
use serde_json::json;
use std::{
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub fn supported(method: &str) -> bool {
    matches!(
        method,
        "inventory.check"
            | "changes.preview"
            | "changes.apply"
            | "draft.preview"
            | "draft.apply"
            | "sources.preview"
            | "sources.apply"
            | "export.start"
            | "sync.run"
    )
}

// 旧管道的单次调用上限为 5 秒。等待窗口较短时，按剩余时间返回，
// 已经发出的一次状态查询可自行结束，后台线程不会重发业务操作。
fn read_before(
    instance: &str,
    query: Request,
    deadline: Instant,
) -> Result<Option<Response>, AgentError> {
    if Instant::now() >= deadline {
        return Ok(None);
    }
    let (sender, receiver) = mpsc::channel();
    let instance = instance.to_owned();
    thread::Builder::new()
        .name("agent-status-read".into())
        .spawn(move || {
            let _ = sender.send(transport::call(&instance, &query));
        })
        .map_err(|e| AgentError::new("POLL_FAILED", e.to_string()))?;
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(response) => response.map(Some),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AgentError::new("POLL_FAILED", "读取任务状态时连接已断开"))
        }
    }
}

pub fn call(instance: &str, req: &Request, wait_ms: u64) -> Result<Response, AgentError> {
    let mut response = transport::call(instance, req)?;
    if !response.ok || wait_ms == 0 {
        return Ok(response);
    }
    let Some(job_id) = response
        .data
        .as_ref()
        .and_then(|d| d["jobId"].as_str())
        .map(str::to_owned)
    else {
        return Ok(response);
    };
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let operation = response
        .data
        .as_ref()
        .and_then(|d| d["operationId"].as_str())
        .map(str::to_owned);
    while Instant::now() < deadline {
        let data = response.data.as_ref().expect("successful job has data");
        let query = match data["status"].as_str() {
            Some("queued" | "running") => {
                let left = deadline.saturating_duration_since(Instant::now());
                thread::sleep(left.min(Duration::from_millis(150)));
                super::request("jobs.status", json!({"jobId":job_id}))
            }
            Some("succeeded")
                if req.method == "inventory.check" && data["result"].get("items").is_none() =>
            {
                let mut page = json!({"jobId":job_id});
                for key in ["offset", "limit"] {
                    if let Some(value) = req.params.get(key) {
                        page[key] = value.clone();
                    }
                }
                super::request("inventory.check", page)
            }
            _ => break,
        };
        let page = query.method == "inventory.check";
        let read = read_before(instance, query, deadline).map_err(|e| {
            AgentError::new(
                e.code,
                format!("{}；请用 jobId {} 回读原任务", e.message, job_id),
            )
        })?;
        let Some(mut next) = read else { break };
        if !next.ok {
            if let Some(error) = &mut next.error {
                error.message.push_str(&format!("；原任务 jobId {job_id}"));
            }
            next.request_id = req.request_id.clone();
            return Ok(next);
        }
        let current = next.data.as_ref();
        if current.and_then(|d| d["jobId"].as_str()) != Some(job_id.as_str())
            || operation
                .as_deref()
                .is_some_and(|op| current.and_then(|d| d["operationId"].as_str()) != Some(op))
        {
            return Err(AgentError::new(
                "INVALID_JOB_RECEIPT",
                format!("回执与原任务 {job_id} 不匹配"),
            ));
        }
        // 保留最初业务调用的 envelope 身份，只更新经过核对的任务数据。
        response.data = next.data;
        if page {
            break;
        }
    }
    Ok(response)
}
