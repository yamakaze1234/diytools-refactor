//! 界面任务桥：只允许固定动作，普通构建明确返回未启用。
#[tauri::command]
pub async fn agent_ui(
    app: tauri::AppHandle,
    action: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "agent-tools")]
    {
        use std::sync::Arc;
        use tauri::Manager;
        let jobs = app
            .try_state::<Arc<crate::agent_jobs::AgentJobs>>()
            .ok_or("Agent 入口未启用")?
            .inner()
            .clone();
        tauri::async_runtime::spawn_blocking(move || {
            let session = payload["sessionId"].as_str().unwrap_or("");
            let token = payload["claimToken"].as_str().unwrap_or("");
            let id = payload["id"].as_str().unwrap_or("");
            let job_id = payload["jobId"].as_str().unwrap_or("");
            match action.as_str() {
                "ready" => jobs
                    .ready_session(session, payload["connect"].as_bool() == Some(true))
                    .map(|_| serde_json::Value::Null),
                "claim" => jobs
                    .claim_session(session)
                    .map(|v| v.unwrap_or(serde_json::Value::Null)),
                "progress" => jobs
                    .verify_claim(session, id, token)
                    .and_then(|_| {
                        let mut value = payload.clone();
                        if let Some(object) = value.as_object_mut() {
                            for key in ["id", "sessionId", "claimToken"] {
                                object.remove(key);
                            }
                        }
                        jobs.progress(id, value)
                    })
                    .map(|_| serde_json::Value::Null),
                "complete" => jobs
                    .complete_session(
                        session,
                        id,
                        token,
                        payload.get("result").cloned().filter(|v| !v.is_null()),
                        payload.get("error").cloned().filter(|v| !v.is_null()),
                    )
                    .map(|_| serde_json::Value::Null),
                "export.write" => jobs.verify_claim(session, job_id, token).and_then(|_| {
                    crate::agent_files::write(
                        &jobs,
                        job_id,
                        payload["name"].as_str().unwrap_or(""),
                        payload["base64"].as_str().unwrap_or(""),
                    )
                    .map_err(|e| diytools_agent_core::AgentError::new("EXPORT_FAILED", e))
                }),
                "export.finish" => jobs.verify_claim(session, job_id, token).and_then(|_| {
                    crate::agent_files::finish(
                        &jobs,
                        job_id,
                        payload["reportHtml"].as_str(),
                        &payload["manifest"],
                    )
                    .map_err(|e| diytools_agent_core::AgentError::new("EXPORT_FAILED", e))
                }),
                _ => Err(diytools_agent_core::AgentError::new(
                    "INVALID_ACTION",
                    "不支持的 Agent 界面动作",
                )),
            }
            .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "agent-tools"))]
    {
        let _ = (app, action, payload);
        Err("Agent 入口未启用".into())
    }
}
