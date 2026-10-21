//! Agent 入口：查询保存快照，交互任务交给当前实例界面，禁止选择任意数据库。
use crate::{agent_queries, workbench_store::WorkbenchStore};
use diytools_agent_core::{AgentError, PROTOCOL_VERSION, Request, Response, transport};
use serde_json::json;
use std::sync::{Arc, Mutex};

// Mutex 使退出流程可以先关闭管道，再释放工作台其他状态。
pub struct AgentEntry(Mutex<Option<transport::ServerHandle>>);

impl AgentEntry {
    pub fn start(
        store: WorkbenchStore,
        jobs: Option<Arc<crate::agent_jobs::AgentJobs>>,
    ) -> Result<Self, AgentError> {
        let instance = diytools_agent_core::instance_for_pid(std::process::id());
        let handler_instance = instance.clone();
        let server = transport::serve(
            &instance,
            Arc::new(move |request| handle(&store, &handler_instance, jobs.as_deref(), request)),
        )?;
        Ok(Self(Mutex::new(Some(server))))
    }

    pub fn stop(&self) {
        if let Ok(mut server) = self.0.lock() {
            // Drop 关闭管道与待处理请求；已开始的 SQL 由查询层的独立时限约束。
            server.take();
        }
    }
}

fn handle(
    store: &WorkbenchStore,
    instance: &str,
    jobs: Option<&crate::agent_jobs::AgentJobs>,
    request: Request,
) -> Response {
    if request.protocol_version != PROTOCOL_VERSION {
        return Response::failure(
            &request,
            AgentError::new("PROTOCOL_VERSION_MISMATCH", "Agent 协议版本不匹配"),
        );
    }
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Response::failure(
            &request,
            AgentError::new("INVALID_REQUEST", "requestId 长度必须为 1 至 128"),
        );
    }
    let result = if matches!(
        request.method.as_str(),
        "changes.preview" | "changes.apply" | "export.start" | "jobs.status" | "sync.run"
    ) {
        jobs.ok_or_else(|| AgentError::new("UI_UNAVAILABLE", "当前宿主没有启用交互任务入口"))
            .and_then(|jobs| jobs.dispatch(&request.method, &request.params))
    } else {
        agent_queries::dispatch(store, &request.method, &request.params)
    };
    match result {
        Ok(mut data) => {
            if request.method == "status" {
                data["instance"] = json!(instance);
                data["appVersion"] = json!(env!("CARGO_PKG_VERSION"));
                data["readOnly"] = json!(jobs.is_none());
                if jobs.is_some() {
                    data["capabilities"].as_array_mut().unwrap().extend(
                        [
                            "changes.preview",
                            "changes.apply",
                            "export.start",
                            "jobs.status",
                            "sync.run",
                        ]
                        .map(|v| json!(v)),
                    );
                }
                // 当前入口仅查询保存快照，不能把磁盘版本推断成界面编辑状态。
                data["unsavedChanges"] = json!("unknown");
                data["authentication"] = json!("windowsCurrentUser");
            }
            Response::success(&request, data)
        }
        Err(error) => Response::failure(&request, error),
    }
}
