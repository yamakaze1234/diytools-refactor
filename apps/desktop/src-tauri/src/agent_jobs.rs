//! 原生 Agent 只持久化排队回执；业务操作交给已连接的工作台界面。
use crate::workbench_store::WorkbenchStore;
use diytools_agent_core::AgentError;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_JOBS: usize = 1000;
// 批量配置计划包含完整前后快照及导图上下文，32MiB 无法容纳真实批次的完成回执。
// 仍保留有界容量和全部幂等回执，不以删除旧任务绕过限制。
const MAX_BYTES: usize = 256 * 1024 * 1024;
const UI_LEASE: Duration = Duration::from_secs(30);
const PLAN_TTL_MS: u64 = 30 * 60 * 1000;
type Result<T> = std::result::Result<T, AgentError>;
fn error(code: &str, message: impl Into<String>) -> AgentError {
    AgentError::new(code, message)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    operation_id: String,
    method: String,
    params: Value,
    status: String,
    created_at: u64,
    updated_at: u64,
    result: Option<Value>,
    error: Option<Value>,
    plan: Option<Value>,
    #[serde(default)]
    export_context: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    claim_token: Option<String>,
    #[serde(default)]
    completion_hash: Option<String>,
    // 逐张图进度只驻留内存，不为每张图重写任务日志。
    #[serde(skip)]
    progress: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    jobs: Vec<Job>,
}
struct Runtime {
    journal: Journal,
    ready: Option<Instant>,
    session_id: Option<String>,
    retired_sessions: std::collections::HashSet<String>,
}
pub struct AgentJobs {
    path: PathBuf,
    store: WorkbenchStore,
    runtime: Mutex<Runtime>,
}

impl AgentJobs {
    pub fn new(folder: PathBuf, store: WorkbenchStore) -> Result<Self> {
        let path = folder.join("agent").join("jobs.json");
        let mut journal = if path.exists() {
            let metadata = fs::metadata(&path).map_err(io_error)?;
            if metadata.len() > MAX_BYTES as u64 {
                return Err(error("JOBS_CAPACITY", "任务记录文件超过容量上限"));
            }
            let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(io_error)?)
                .map_err(|e| error("JOBS_CORRUPT", e.to_string()))?;
            if journal.version != 1 || journal.jobs.len() > MAX_JOBS {
                return Err(error("JOBS_CORRUPT", "任务记录版本或数量无效"));
            }
            let mut ids = std::collections::HashSet::new();
            let mut operations = std::collections::HashSet::new();
            for job in &journal.jobs {
                if !ids.insert(job.id.clone()) || !operations.insert(job.operation_id.clone()) {
                    return Err(error("JOBS_CORRUPT", "任务标识重复"));
                }
                if !["queued", "running", "succeeded", "failed", "interrupted"]
                    .contains(&job.status.as_str())
                {
                    return Err(error("JOBS_CORRUPT", "任务状态无效"));
                }
                validate(&job.method, &job.params)?;
            }
            journal
        } else {
            Journal {
                version: 1,
                jobs: vec![],
            }
        };
        let mut changed = false;
        for job in &mut journal.jobs {
            if job.status == "queued" || job.status == "running" {
                job.status = "interrupted".into();
                job.updated_at = now();
                job.error = Some(
                    json!({"code":"JOB_INTERRUPTED","message":"应用退出时任务未完成，可用原 operationId 重试"}),
                );
                changed = true;
            }
        }
        if changed {
            persist(&path, &journal)?;
        }
        Ok(Self {
            path,
            store,
            runtime: Mutex::new(Runtime {
                journal,
                ready: None,
                session_id: None,
                retired_sessions: std::collections::HashSet::new(),
            }),
        })
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Runtime>> {
        self.runtime
            .lock()
            .map_err(|_| error("JOBS_LOCK_FAILED", "任务状态锁不可用"))
    }
    fn commit(&self, runtime: &mut Runtime, journal: Journal) -> Result<()> {
        persist(&self.path, &journal)?;
        runtime.journal = journal;
        Ok(())
    }
    pub fn dispatch(&self, method: &str, params: &Value) -> Result<Value> {
        validate(method, params)?;
        let mut runtime = self.lock()?;
        if method == "jobs.status" {
            let job = runtime
                .journal
                .jobs
                .iter()
                .find(|j| {
                    params.get("jobId").and_then(Value::as_str) == Some(j.id.as_str())
                        || params
                            .get("operationId")
                            .and_then(Value::as_str)
                            .map(|s| canonical_uuid(s).ok())
                            .flatten()
                            .as_deref()
                            == Some(j.operation_id.as_str())
                })
                .ok_or_else(|| error("JOB_NOT_FOUND", "未找到任务"))?;
            return Ok(public(job));
        }
        let operation = canonical_uuid(params["operationId"].as_str().unwrap())?;
        let mut params = params.clone();
        params["operationId"] = json!(operation);
        let existing = runtime
            .journal
            .jobs
            .iter()
            .position(|j| j.operation_id == operation);
        let mut has_saved_receipt = false;
        if let Some(index) = existing {
            let job = &runtime.journal.jobs[index];
            if job.method != method || job.params != params {
                return Err(error("OPERATION_ID_CONFLICT", "operationId 已用于不同请求"));
            }
            if ["queued", "running", "succeeded"].contains(&job.status.as_str()) {
                return Ok(public(job));
            }
            // 只有 apply 可用本机保存回执恢复，导出和同步不能被本地保存误判成功。
            if method == "changes.apply" {
                if let Some(receipt) = self.receipt(&operation)? {
                    let same_live_session = job.status == "failed"
                        && runtime.session_id.is_some()
                        && job.session_id == runtime.session_id
                        && runtime.ready.is_some_and(|at| at.elapsed() < UI_LEASE);
                    if same_live_session {
                        // 原页面可能仍持有 batchPending；交给 UI 确认或只回传既有回执，不重复应用。
                        has_saved_receipt = true;
                    } else {
                        let mut journal = runtime.journal.clone();
                        let snapshot =
                            recovered_snapshot(&journal, &journal.jobs[index].params, &receipt);
                        let job = &mut journal.jobs[index];
                        job.status = "succeeded".into();
                        job.error = None;
                        job.updated_at = now();
                        job.result = Some(json!({"localSave":"saved","receipt":receipt}));
                        if let Some(result) = job.result.as_mut() {
                            result["revision"] = result["receipt"]["revision"].clone();
                            if let Some(snapshot) = snapshot {
                                result["snapshot"] = snapshot;
                            }
                        }
                        let result = public(job);
                        self.commit(&mut runtime, journal)?;
                        return Ok(result);
                    }
                }
            }
        }
        if !runtime.ready.is_some_and(|at| at.elapsed() < UI_LEASE) {
            return Err(error("UI_UNAVAILABLE", "工作台界面未连接或已停止响应"));
        }
        if method == "changes.apply" && !has_saved_receipt {
            find_plan(&runtime.journal, params["planId"].as_str().unwrap())?;
        }
        if method == "export.start" {
            export_snapshot(&runtime.journal, &params)?;
        }
        let mut journal = runtime.journal.clone();
        let index = if let Some(index) = existing {
            index
        } else {
            if journal.jobs.len() >= MAX_JOBS {
                return Err(error(
                    "JOBS_CAPACITY",
                    "任务记录已达 1000 条；未自动删除任何回执",
                ));
            }
            journal.jobs.push(Job {
                id: Uuid::new_v4().to_string(),
                operation_id: operation,
                method: method.into(),
                params,
                status: "queued".into(),
                created_at: now(),
                updated_at: now(),
                result: None,
                error: None,
                plan: None,
                export_context: None,
                session_id: None,
                claim_token: None,
                completion_hash: None,
                progress: None,
            });
            journal.jobs.len() - 1
        };
        let job = &mut journal.jobs[index];
        job.status = "queued".into();
        job.updated_at = now();
        job.error = None;
        job.result = None;
        job.plan = None;
        job.export_context = None;
        job.progress = None;
        job.session_id = None;
        job.claim_token = None;
        job.completion_hash = None;
        let result = public(job);
        self.commit(&mut runtime, journal)?;
        Ok(result)
    }
    pub fn ready(&self) -> Result<()> {
        self.lock()?.ready = Some(Instant::now());
        Ok(())
    }
    // 首次握手代表新的页面会话；旧任务只标记中断，绝不自动重新执行。
    pub fn ready_session(&self, session: &str, connect: bool) -> Result<()> {
        let session = canonical_uuid(session)?;
        let mut runtime = self.lock()?;
        if runtime.session_id.as_deref() != Some(session.as_str()) {
            if !connect || runtime.retired_sessions.contains(&session) {
                return Err(error(
                    "UI_SESSION_STALE",
                    "工作台页面会话已变化，请重新加载",
                ));
            }
            let mut journal = runtime.journal.clone();
            let mut changed = false;
            for job in &mut journal.jobs {
                if job.status == "running" {
                    job.status = "interrupted".into();
                    job.updated_at = now();
                    job.progress = None;
                    job.error = Some(
                        json!({"code":"UI_RELOADED","message":"工作台页面已重新加载；请用原 operationId 显式重试，不会自动重放操作"}),
                    );
                    changed = true;
                }
            }
            if changed {
                self.commit(&mut runtime, journal)?;
            }
            if let Some(old) = runtime.session_id.replace(session) {
                runtime.retired_sessions.insert(old);
            }
        }
        runtime.ready = Some(Instant::now());
        Ok(())
    }
    pub fn verify_claim(&self, session: &str, id: &str, token: &str) -> Result<()> {
        let runtime = self.lock()?;
        verify_claim(&runtime, session, id, token)
    }
    pub fn progress(&self, id: &str, value: Value) -> Result<()> {
        let p = fields(
            &value,
            &["phase", "completed", "total", "name"],
            &["phase", "completed", "total"],
        )?;
        let valid_text = |v: &Value, max: usize| {
            v.as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
            })
        };
        let completed = p["completed"].as_u64();
        let total = p["total"].as_u64();
        if !valid_text(&p["phase"], 64)
            || p.get("name").is_some_and(|v| !valid_text(v, 1024))
            || !matches!((completed,total), (Some(done),Some(total)) if done<=total && total<=100_000)
        {
            return Err(error("INVALID_PARAMS", "任务进度字段或范围无效"));
        }
        let mut runtime = self.lock()?;
        let job = runtime
            .journal
            .jobs
            .iter_mut()
            .find(|job| job.id == id)
            .ok_or_else(|| error("JOB_NOT_FOUND", "未找到任务"))?;
        if job.status != "running" {
            return Err(error("JOB_NOT_RUNNING", "任务尚未领取或已完成"));
        }
        job.progress = Some(value);
        job.updated_at = now();
        Ok(())
    }
    pub fn claim(&self) -> Result<Option<Value>> {
        self.claim_inner(None)
    }
    pub fn claim_session(&self, session: &str) -> Result<Option<Value>> {
        self.claim_inner(Some(session))
    }
    fn claim_inner(&self, session: Option<&str>) -> Result<Option<Value>> {
        let mut runtime = self.lock()?;
        if let Some(session) = session {
            if runtime.session_id.as_deref() != Some(session) {
                return Err(error("UI_SESSION_STALE", "工作台页面会话已变化"));
            }
        } else if runtime.session_id.is_some() {
            return Err(error("UI_SESSION_REQUIRED", "领取任务必须指定页面会话"));
        }
        runtime.ready = Some(Instant::now());
        let Some(index) = runtime
            .journal
            .jobs
            .iter()
            .position(|j| j.status == "queued")
        else {
            return Ok(None);
        };
        let mut journal = runtime.journal.clone();
        let mut params = journal.jobs[index].params.clone();
        if journal.jobs[index].method == "export.start" {
            if let Some(snapshot) = export_snapshot(&journal, &params)? {
                params["snapshot"] = snapshot;
            }
        }
        if journal.jobs[index].method == "changes.apply" {
            let receipt = self.receipt(&journal.jobs[index].operation_id)?;
            if let Some(receipt) = receipt {
                params["savedReceipt"] = receipt.clone();
                if let Some(snapshot) = recovered_snapshot(&journal, &params, &receipt) {
                    params["savedSnapshot"] = snapshot;
                }
                if let Some(plan) = journal
                    .jobs
                    .iter()
                    .find(|job| Some(job.id.as_str()) == params["planId"].as_str())
                    .and_then(|job| job.plan.clone())
                {
                    params["plan"] = plan;
                }
            } else {
                match find_plan(&journal, params["planId"].as_str().unwrap()) {
                    Ok(plan) => {
                        params["plan"] = plan;
                    }
                    Err(e) => {
                        let job = &mut journal.jobs[index];
                        job.status = "failed".into();
                        job.error = Some(json!({"code":e.code,"message":e.message}));
                        job.updated_at = now();
                        self.commit(&mut runtime, journal)?;
                        return Err(e);
                    }
                }
            }
        }
        let job = &mut journal.jobs[index];
        job.status = "running".into();
        job.updated_at = now();
        job.session_id = session.map(str::to_owned);
        job.claim_token = Some(Uuid::new_v4().to_string());
        let result =
            json!({"id":job.id,"method":job.method,"params":params,"claimToken":job.claim_token});
        self.commit(&mut runtime, journal)?;
        Ok(Some(result))
    }
    pub fn complete(&self, id: &str, result: Option<Value>, failure: Option<Value>) -> Result<()> {
        self.complete_inner(id, result, failure, None)
    }
    pub fn complete_session(
        &self,
        session: &str,
        id: &str,
        token: &str,
        result: Option<Value>,
        failure: Option<Value>,
    ) -> Result<()> {
        self.complete_inner(id, result, failure, Some((session, token)))
    }
    fn complete_inner(
        &self,
        id: &str,
        result: Option<Value>,
        failure: Option<Value>,
        auth: Option<(&str, &str)>,
    ) -> Result<()> {
        if result.is_some() == failure.is_some() {
            return Err(error(
                "INVALID_PARAMS",
                "result 与 error 必须且只能提供一个",
            ));
        }
        let mut runtime = self.lock()?;
        if let Some((session, token)) = auth {
            if runtime.session_id.as_deref() != Some(session) {
                return Err(error("UI_SESSION_STALE", "工作台页面会话已变化"));
            }
            let job = runtime
                .journal
                .jobs
                .iter()
                .find(|job| job.id == id)
                .ok_or_else(|| error("JOB_NOT_FOUND", "未找到任务"))?;
            if job.session_id.as_deref() != Some(session)
                || job.claim_token.as_deref() != Some(token)
                || token.is_empty()
            {
                return Err(error("JOB_CLAIM_STALE", "任务领取已失效"));
            }
            if job.status == "succeeded" || job.status == "failed" {
                return if job.completion_hash.as_deref()
                    == Some(completion_hash(&result, &failure).as_str())
                {
                    Ok(())
                } else {
                    Err(error(
                        "JOB_COMPLETION_CONFLICT",
                        "同一领取标识的完成回执内容不同",
                    ))
                };
            }
            verify_claim(&runtime, session, id, token)?;
        } else if runtime.session_id.is_some() {
            return Err(error(
                "UI_SESSION_REQUIRED",
                "完成任务必须指定页面会话与领取标识",
            ));
        }
        let index = runtime
            .journal
            .jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| error("JOB_NOT_FOUND", "未找到任务"))?;
        if runtime.journal.jobs[index].status != "running" {
            return Err(error("JOB_NOT_RUNNING", "任务尚未领取或已完成"));
        }
        let mut journal = runtime.journal.clone();
        let job = &mut journal.jobs[index];
        job.completion_hash = Some(completion_hash(&result, &failure));
        if let Some(value) = result {
            if !value.is_object() {
                return Err(error("INVALID_RESULT", "result 必须为对象"));
            }
            if job.method == "changes.apply"
                && !matches!(value["localSave"].as_str(), Some("saved" | "unchanged"))
            {
                return Err(error(
                    "INVALID_RESULT",
                    "apply 成功必须具有 localSave=saved 或 unchanged 保存回执",
                ));
            }
            if job.method == "changes.preview" {
                let plan = value
                    .get("plan")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| error("INVALID_RESULT", "预览必须返回 plan 对象"))?;
                job.plan = Some(plan.clone());
                if let Some(context) = value.get("exportContext") {
                    if !context["configs"].is_array() || context["revision"].as_u64().is_none() {
                        return Err(error("INVALID_RESULT", "预览导出上下文无效"));
                    }
                    job.export_context = Some(context.clone());
                }
                job.result = Some(
                    json!({"planId":job.id,"summary":value.get("summary").cloned().unwrap_or_else(|| json!({}))}),
                );
            } else {
                job.result = Some(value);
            }
            job.status = "succeeded".into();
            job.error = None;
        } else {
            let failure = failure.unwrap();
            if !failure.is_object() {
                return Err(error("INVALID_RESULT", "error 必须为对象"));
            }
            job.status = "failed".into();
            job.error = Some(failure);
            job.result = None;
        }
        job.updated_at = now();
        self.commit(&mut runtime, journal)
    }
    pub fn export_params(&self, id: &str) -> Result<Value> {
        let runtime = self.lock()?;
        let job = runtime
            .journal
            .jobs
            .iter()
            .find(|j| j.id == id && j.method == "export.start" && j.status == "running")
            .ok_or_else(|| error("JOB_NOT_RUNNING", "导出任务不存在、未领取或已结束"))?;
        Ok(json!({"outputDir":job.params["outputDir"],"operationId":job.operation_id}))
    }
    fn receipt(&self, operation: &str) -> Result<Option<Value>> {
        let connection = Connection::open_with_flags(
            &self.store.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| error("RECEIPT_READ_FAILED", e.to_string()))?;
        connection
            .busy_timeout(Duration::from_millis(500))
            .map_err(|e| error("RECEIPT_READ_FAILED", e.to_string()))?;
        let document: Option<String> = connection
            .query_row(
                "SELECT document FROM workbench_receipts WHERE operation=?1",
                [operation],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| error("RECEIPT_READ_FAILED", e.to_string()))?;
        document
            .map(|text| {
                serde_json::from_str(&text).map_err(|e| error("RECEIPT_READ_FAILED", e.to_string()))
            })
            .transpose()
    }
}
// SQL 已保存而 UI 回执尚未落盘时，从预览私有上下文恢复原链接的配置顺序。
fn recovered_snapshot(journal: &Journal, params: &Value, receipt: &Value) -> Option<Value> {
    let plan_id = params["planId"].as_str()?;
    let preview = journal.jobs.iter().find(|job| {
        job.id == plan_id && job.method == "changes.preview" && job.status == "succeeded"
    })?;
    let context = preview.export_context.as_ref()?;
    let baseline = context["configs"].as_array()?;
    let saved = receipt["configs"].as_array()?;
    let revision = receipt["revision"].as_u64()?;
    let mut replacements = std::collections::HashMap::new();
    let mut ids = Vec::new();
    for config in saved {
        let id = config["id"].as_str()?;
        if !baseline.iter().any(|row| row["id"].as_str() == Some(id))
            || replacements.insert(id, config).is_some()
        {
            return None;
        }
        ids.push(id);
    }
    let configs: Vec<Value> = baseline
        .iter()
        .map(|row| {
            replacements
                .get(row["id"].as_str().unwrap_or(""))
                .map_or_else(|| row.clone(), |saved| (*saved).clone())
        })
        .collect();
    Some(json!({"configs":configs,"revision":revision,"configIds":ids}))
}
fn verify_claim(runtime: &Runtime, session: &str, id: &str, token: &str) -> Result<()> {
    if runtime.session_id.as_deref() != Some(session) {
        return Err(error("UI_SESSION_STALE", "工作台页面会话已变化"));
    }
    let job = runtime
        .journal
        .jobs
        .iter()
        .find(|job| job.id == id)
        .ok_or_else(|| error("JOB_NOT_FOUND", "未找到任务"))?;
    if job.status != "running"
        || job.session_id.as_deref() != Some(session)
        || job.claim_token.as_deref() != Some(token)
        || token.is_empty()
    {
        return Err(error(
            "JOB_CLAIM_STALE",
            "任务领取已失效，旧页面不能完成或继续写入此任务",
        ));
    }
    Ok(())
}
// 完成回执仅保留摘要，避免把私有计划和快照重复存入日志；键顺序不影响幂等性。
fn completion_hash(result: &Option<Value>, failure: &Option<Value>) -> String {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), ordered(&fields[key])))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.iter().map(ordered).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(
            ordered(&json!({"result":result,"error":failure}))
                .to_string()
                .as_bytes()
        )
    )
}
fn export_snapshot(journal: &Journal, params: &Value) -> Result<Option<Value>> {
    let Some(operation) = params.get("sourceOperationId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let operation = canonical_uuid(operation)?;
    let job = journal
        .jobs
        .iter()
        .find(|j| {
            j.operation_id == operation && j.method == "changes.apply" && j.status == "succeeded"
        })
        .ok_or_else(|| error("SOURCE_NOT_SAVED", "来源操作尚未成功保存"))?;
    let result = job
        .result
        .as_ref()
        .ok_or_else(|| error("SOURCE_NOT_SAVED", "来源操作缺少保存回执"))?;
    if !matches!(result["localSave"].as_str(), Some("saved" | "unchanged")) {
        return Err(error("SOURCE_NOT_SAVED", "来源操作尚未保存"));
    }
    result
        .get("snapshot")
        .filter(|s| s["configs"].is_array() && s["revision"].as_u64().is_some())
        .cloned()
        .map(Some)
        .ok_or_else(|| {
            error(
                "SOURCE_SNAPSHOT_UNAVAILABLE",
                "来源已保存但缺少导出快照，请指定配置和版本重新导出",
            )
        })
}
fn find_plan(journal: &Journal, id: &str) -> Result<Value> {
    let job = journal
        .jobs
        .iter()
        .find(|j| j.id == id && j.method == "changes.preview" && j.status == "succeeded")
        .ok_or_else(|| error("PLAN_NOT_FOUND", "预览计划不存在或未成功"))?;
    if now().saturating_sub(job.updated_at) >= PLAN_TTL_MS {
        return Err(error("PLAN_EXPIRED", "预览计划已过期，请重新预览"));
    }
    job.plan
        .clone()
        .ok_or_else(|| error("PLAN_NOT_FOUND", "预览计划正文缺失"))
}
fn public(job: &Job) -> Value {
    let result = job.result.as_ref().map(|value| {
        if job.method == "changes.apply" {
            let mut result = serde_json::Map::new();
            for key in ["localSave", "revision"] {
                if let Some(value) = value.get(key) {
                    result.insert(key.into(), value.clone());
                }
            }
            if let Some(receipt) = value.get("receipt") {
                let mut metadata = serde_json::Map::new();
                for key in [
                    "operationId",
                    "revision",
                    "updatedAt",
                    "rebased",
                    "unchanged",
                ] {
                    if let Some(value) = receipt.get(key) {
                        metadata.insert(key.into(), value.clone());
                    }
                }
                result.insert("receipt".into(), Value::Object(metadata));
            }
            Value::Object(result)
        } else {
            value.clone()
        }
    });
    json!({"jobId":job.id,"operationId":job.operation_id,"method":job.method,"status":job.status,"createdAt":job.created_at,"updatedAt":job.updated_at,"result":result,"error":job.error,"progress":job.progress})
}
fn canonical_uuid(value: &str) -> Result<String> {
    if value.len() != 36 {
        return Err(error("INVALID_PARAMS", "operationId 必须为 UUID"));
    }
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| error("INVALID_PARAMS", "operationId 必须为 UUID"))
}
fn fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a serde_json::Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| error("INVALID_PARAMS", "参数必须为对象"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(error("INVALID_PARAMS", "存在未知参数或缺少必填参数"));
    }
    Ok(object)
}
fn text(value: &Value, key: &str) -> Result<()> {
    if !value[key]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 32768)
    {
        return Err(error("INVALID_PARAMS", format!("{key} 必须为非空字符串")));
    }
    Ok(())
}
fn validate(method: &str, params: &Value) -> Result<()> {
    match method {
        "jobs.status" => {
            let object = fields(params, &["jobId", "operationId"], &[])?;
            if object.len() != 1 {
                return Err(error(
                    "INVALID_PARAMS",
                    "jobId 与 operationId 必须且只能提供一个",
                ));
            }
            if object.contains_key("jobId") {
                text(params, "jobId")?;
            } else {
                text(params, "operationId")?;
                canonical_uuid(params["operationId"].as_str().unwrap())?;
            }
            return Ok(());
        }
        "changes.preview" => {
            fields(
                params,
                &["request", "operationId"],
                &["request", "operationId"],
            )?;
            let request = &params["request"];
            fields(
                request,
                &["shopId", "targets", "action"],
                &["shopId", "targets", "action"],
            )?;
            text(request, "shopId")?;
            let targets = request["targets"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 10000)
                .ok_or_else(|| error("INVALID_PARAMS", "targets 必须包含 1 至 10000 项"))?;
            for target in targets {
                fields(
                    target,
                    &[
                        "configId",
                        "partIndex",
                        "expectedGoodsId",
                        "expectedSourceId",
                    ],
                    &["configId", "partIndex"],
                )?;
                text(target, "configId")?;
                if !target["partIndex"].as_u64().is_some_and(|n| n <= 10000) {
                    return Err(error("INVALID_PARAMS", "partIndex 必须为非负整数"));
                }
                for key in ["expectedGoodsId", "expectedSourceId"] {
                    if target.get(key).is_some() {
                        text(target, key)?;
                    }
                }
            }
            let action = &request["action"];
            fields(
                action,
                &["type", "value", "sourceId", "quantity"],
                &["type"],
            )?;
            match action["type"].as_str() {
                Some("displayName" | "upgrade") => {
                    fields(action, &["type", "value"], &["type", "value"])?;
                    if !action["value"].as_str().is_some_and(|s| s.len() <= 4096) {
                        return Err(error(
                            "INVALID_PARAMS",
                            "value 必须为字符串且不超过 4096 字节",
                        ));
                    }
                }
                Some("replace") => {
                    fields(
                        action,
                        &["type", "sourceId", "quantity"],
                        &["type", "sourceId"],
                    )?;
                    text(action, "sourceId")?;
                    if action.get("quantity").is_some()
                        && !action["quantity"]
                            .as_u64()
                            .is_some_and(|n| n > 0 && n <= 10000)
                    {
                        return Err(error("INVALID_PARAMS", "quantity 必须为 1 至 10000 的整数"));
                    }
                }
                Some("quantity") => {
                    fields(action, &["type", "quantity"], &["type", "quantity"])?;
                    if !action["quantity"]
                        .as_u64()
                        .is_some_and(|n| n > 0 && n <= 10000)
                    {
                        return Err(error("INVALID_PARAMS", "quantity 必须为 1 至 10000 的整数"));
                    }
                }
                _ => return Err(error("INVALID_PARAMS", "未知变更类型")),
            }
        }
        "changes.apply" => {
            fields(
                params,
                &["planId", "operationId"],
                &["planId", "operationId"],
            )?;
            text(params, "planId")?;
        }
        "export.start" => {
            fields(
                params,
                &[
                    "operationId",
                    "sourceOperationId",
                    "configIds",
                    "revision",
                    "images",
                    "report",
                    "outputDir",
                ],
                &["operationId", "images", "report", "outputDir"],
            )?;
            if !matches!(params["images"].as_str(), Some("both" | "long" | "square"))
                || !params["report"].is_boolean()
            {
                return Err(error("INVALID_PARAMS", "images 或 report 无效"));
            }
            text(params, "outputDir")?;
            if !Path::new(params["outputDir"].as_str().unwrap()).is_absolute() {
                return Err(error("INVALID_PARAMS", "outputDir 必须为绝对路径"));
            }
            if let Some(ids) = params.get("configIds") {
                let ids = ids
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= 10000)
                    .ok_or_else(|| error("INVALID_PARAMS", "configIds 数量无效"))?;
                if ids
                    .iter()
                    .any(|v| !v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256))
                {
                    return Err(error("INVALID_PARAMS", "configIds 必须为字符串数组"));
                }
            }
            if params.get("revision").is_some() && params["revision"].as_u64().is_none() {
                return Err(error("INVALID_PARAMS", "revision 必须为非负整数"));
            }
            if let Some(value) = params.get("sourceOperationId") {
                canonical_uuid(
                    value
                        .as_str()
                        .ok_or_else(|| error("INVALID_PARAMS", "sourceOperationId 必须为 UUID"))?,
                )?;
            }
        }
        "sync.run" => {
            fields(params, &["operationId"], &["operationId"])?;
        }
        _ => return Err(error("METHOD_NOT_FOUND", "未知任务方法")),
    }
    text(params, "operationId")?;
    canonical_uuid(params["operationId"].as_str().unwrap())?;
    Ok(())
}
fn io_error(e: std::io::Error) -> AgentError {
    error("JOBS_PERSIST_FAILED", e.to_string())
}
fn persist(path: &Path, journal: &Journal) -> Result<()> {
    let bytes =
        serde_json::to_vec(journal).map_err(|e| error("JOBS_PERSIST_FAILED", e.to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Err(error("JOBS_CAPACITY", "任务记录超过 256MiB；未丢弃任何回执"));
    }
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(io_error)?;
    let temporary = parent.join(format!("jobs-{}.tmp", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    replace(&temporary, path).map_err(io_error)
}
#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // 同目录临时文件 + REPLACE_EXISTING/WRITE_THROUGH，不先删除旧任务记录。
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 1 | 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(test)]
#[path = "agent_jobs/tests.rs"]
mod tests;
