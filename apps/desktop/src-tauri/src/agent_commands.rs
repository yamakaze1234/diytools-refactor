//! 界面任务桥：只允许固定动作，普通构建明确返回未启用。
// 权限维护只注册为宿主命令，不在管道与 Agent 的业务方法中分发。
#[tauri::command]
pub async fn agent_permissions_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    permission_view(app, None).await
}
#[tauri::command]
pub async fn agent_permissions_set(
    app: tauri::AppHandle,
    scope_key: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    permission_view(app, Some((scope_key, patch))).await
}
async fn permission_view(
    app: tauri::AppHandle,
    change: Option<(String, serde_json::Value)>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "agent-tools")]
    {
        use tauri::Manager;
        if let Some(agent) = app.try_state::<std::sync::Arc<crate::nas_agent::NasAgent>>() {
            let agent = agent.inner().clone();
            return tauri::async_runtime::spawn_blocking(move || {
                agent
                    .permissions(
                        change
                            .as_ref()
                            .map(|(scope, patch)| (scope.as_str(), patch)),
                    )
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    let _ = (app, change);
    Ok(serde_json::json!({"available":false}))
}
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
        let local = app
            .try_state::<Arc<crate::agent_jobs::AgentJobs>>()
            .map(|state| state.inner().clone());
        let nas = app
            .try_state::<Arc<crate::nas_agent::NasAgent>>()
            .map(|state| state.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            let jobs = if let Some(nas) = &nas {
                nas.ui_jobs(&payload["actor"])
                    .map_err(|error| error.to_string())?
            } else {
                local.ok_or("Agent 入口未启用")?
            };
            let session = payload["sessionId"].as_str().unwrap_or("");
            let token = payload["claimToken"].as_str().unwrap_or("");
            let id = payload["id"].as_str().unwrap_or("");
            let job_id = payload["jobId"].as_str().unwrap_or("");
            let step_index = || {
                payload["stepIndex"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| {
                        diytools_agent_core::AgentError::new(
                            "INVALID_PARAMS",
                            "需要冻结计划的 stepIndex",
                        )
                    })
            };
            let checked = |id: &str, expected: Option<&str>| {
                let (method, params) = jobs.claim_context(session, id, token)?;
                let spec = jobs.source_scope(&method, &params)?;
                if expected.is_some_and(|m| m != method) {
                    return Err(diytools_agent_core::AgentError::new(
                        "INVALID_ACTION",
                        "领取的任务与本次动作不匹配",
                    ));
                }
                if let Some(agent) = &nas {
                    let (target, _) = jobs.nas_target(&method, &params)?;
                    let proposed = payload["shopId"].as_str();
                    let stepped = crate::agent_jobs::steps::stepped(&method);
                    if !stepped && target.as_deref().zip(proposed).is_some_and(|(a, b)| a != b) {
                        return Err(diytools_agent_core::AgentError::new(
                            "MEMBER_CHANGED",
                            "任务店铺与保存目标不匹配",
                        ));
                    }
                    agent.check_ui_job(
                        &payload["actor"],
                        &method,
                        if stepped {
                            proposed
                        } else {
                            target
                                .as_deref()
                                .or(proposed)
                                .or(payload["activeShopId"].as_str())
                        },
                        false,
                        spec.as_ref(),
                    )?;
                }
                Ok((method, spec))
            };
            match action.as_str() {
                "ready" => jobs
                    .ready_in_shop(
                        session,
                        payload["connect"].as_bool() == Some(true),
                        payload["activeShopId"].as_str(),
                    )
                    .map(|_| serde_json::Value::Null),
                "claim" => jobs.claim_checked(session, |job| {
                    if let Some(agent) = &nas {
                        let method = job["method"].as_str().unwrap_or("");
                        let (shop, recover) = jobs.nas_target(method, &job["params"])?;
                        let spec = jobs.source_scope(method, &job["params"])?;
                        agent.check_ui_job(
                            &payload["actor"],
                            method,
                            shop.as_deref().or(payload["activeShopId"].as_str()),
                            recover,
                            spec.as_ref(),
                        )?;
                    }
                    Ok(())
                }),
                "preflight" => checked(id, None).and_then(|(method, spec)| {
                    if !matches!(
                        method.as_str(),
                        "changes.apply" | "draft.apply" | "sources.apply" | "sync.run"
                    ) {
                        return Err(diytools_agent_core::AgentError::new(
                            "INVALID_ACTION",
                            "只有领取的提交或刷新任务可申请提交前检查",
                        ));
                    }
                    if method == "changes.apply" {
                        jobs.mark_nas_submission(session, id, token)?;
                    } else if crate::agent_jobs::steps::stepped(&method) {
                        jobs.record_step(
                            session,
                            id,
                            token,
                            step_index()?,
                            payload["shopId"].as_str(),
                            None,
                        )?;
                    }
                    if let Some(agent) = &nas {
                        agent.check_submission(&payload["actor"], &method, spec.as_ref())?;
                    }
                    Ok(serde_json::Value::Null)
                }),
                "step.confirm" => step_index().and_then(|index| {
                    jobs.record_step(session, id, token, index, None, Some(&payload["receipt"]))?;
                    Ok(serde_json::Value::Null)
                }),
                "progress" => jobs
                    .verify_claim(session, id, token)
                    .and_then(|_| {
                        let mut value = payload.clone();
                        if let Some(object) = value.as_object_mut() {
                            for key in ["id", "sessionId", "claimToken", "actor", "activeShopId"] {
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
                "export.write" => checked(job_id, Some("export.start")).and_then(|_| {
                    crate::agent_files::write(
                        &jobs,
                        job_id,
                        payload["name"].as_str().unwrap_or(""),
                        payload["base64"].as_str().unwrap_or(""),
                    )
                    .map_err(|e| diytools_agent_core::AgentError::new("EXPORT_FAILED", e))
                }),
                "export.finish" => checked(job_id, Some("export.start")).and_then(|_| {
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
