use super::*;

#[test]
fn completion_ack_can_be_retried_after_persist_without_blocking_next_task() {
    let (folder, _, jobs) = fixture();
    let session = operation();
    jobs.ready_session(&session, true).unwrap();
    jobs.dispatch("changes.preview", &preview(&operation()))
        .unwrap();
    let claimed = jobs.claim_session(&session).unwrap().unwrap();
    let id = claimed["id"].as_str().unwrap();
    let token = claimed["claimToken"].as_str().unwrap();
    let result = json!({"plan":{"changes":[]},"summary":{"a":1,"b":2},"localSave":"unchanged"});
    // 第一次 complete 已经落盘，但将 IPC 响应视为丢失；两次重传仅确认原回执。
    jobs.complete_session(&session, id, token, Some(result.clone()), None)
        .unwrap();
    let before = fs::read(folder.join("agent/jobs.json")).unwrap();
    for _ in 0..2 {
        jobs.complete_session(&session, id, token, Some(result.clone()), None)
            .unwrap();
    }
    assert_eq!(fs::read(folder.join("agent/jobs.json")).unwrap(), before);
    let reordered: Value = serde_json::from_str(
        r#"{"localSave":"unchanged","summary":{"b":2,"a":1},"plan":{"changes":[]}}"#,
    )
    .unwrap();
    jobs.complete_session(&session, id, token, Some(reordered), None)
        .unwrap();
    assert_eq!(
        jobs.complete_session(
            &session,
            id,
            token,
            Some(json!({"plan":{},"summary":{}})),
            None
        )
        .unwrap_err()
        .code,
        "JOB_COMPLETION_CONFLICT"
    );
    jobs.dispatch("sync.run", &json!({"operationId":operation()}))
        .unwrap();
    let next = jobs.claim_session(&session).unwrap().unwrap();
    let next_id = next["id"].as_str().unwrap();
    let next_token = next["claimToken"].as_str().unwrap();
    let failure = json!({"code":"SYNC_INCOMPLETE","message":"pending"});
    jobs.complete_session(&session, next_id, next_token, None, Some(failure.clone()))
        .unwrap();
    jobs.complete_session(&session, next_id, next_token, None, Some(failure))
        .unwrap();
    assert!(jobs.claim_session(&session).unwrap().is_none());
    jobs.ready_session(&operation(), true).unwrap();
    assert_eq!(
        jobs.complete_session(&session, id, token, Some(result), None)
            .unwrap_err()
            .code,
        "UI_SESSION_STALE"
    );
}

#[test]
fn failed_apply_with_saved_receipt_reconciles_original_live_ui_but_new_session_recovers_directly() {
    for new_session in [false, true] {
        let (_, store, jobs) = fixture();
        let plan = successful_preview(&jobs);
        let session = operation();
        jobs.ready_session(&session, true).unwrap();
        let op = operation();
        let params = json!({"operationId":op,"planId":plan});
        let submitted = jobs.dispatch("changes.apply", &params).unwrap();
        let claimed = jobs.claim_session(&session).unwrap().unwrap();
        let id = claimed["id"].as_str().unwrap();
        let token = claimed["claimToken"].as_str().unwrap();
        let receipt =
            json!({"operationId":op,"revision":9,"configs":[{"id":"config","name":"SQL已保存"}]});
        let c = Connection::open(&store.path).unwrap();
        c.execute(
            "INSERT INTO workbench_receipts VALUES(?1,'synthetic',?2)",
            rusqlite::params![op, receipt.to_string()],
        )
        .unwrap();
        jobs.complete_session(
            &session,
            id,
            token,
            None,
            Some(json!({"code":"HTTP_503","message":"保存响应丢失"})),
        )
        .unwrap();
        // 已保存操作的恢复不应因原预览 TTL 到期而被阻止。
        jobs.lock()
            .unwrap()
            .journal
            .jobs
            .iter_mut()
            .find(|job| job.id == plan)
            .unwrap()
            .updated_at = now() - PLAN_TTL_MS - 1;
        let active = if new_session {
            let next = operation();
            jobs.ready_session(&next, true).unwrap();
            next
        } else {
            session.clone()
        };
        let retry = jobs.dispatch("changes.apply", &params).unwrap();
        assert_eq!(retry["jobId"], submitted["jobId"]);
        if new_session {
            assert_eq!(retry["status"], "succeeded");
            assert!(jobs.claim_session(&active).unwrap().is_none());
        } else {
            assert_eq!(retry["status"], "queued");
            let reconciled = jobs.claim_session(&active).unwrap().unwrap();
            assert_eq!(reconciled["params"]["savedReceipt"], receipt);
            assert!(reconciled["params"]["plan"].is_object());
            assert_eq!(
                jobs.complete_session(&active, id, token, Some(json!({"localSave":"saved"})), None)
                    .unwrap_err()
                    .code,
                "JOB_CLAIM_STALE"
            );
            jobs.complete_session(
                &active,
                id,
                reconciled["claimToken"].as_str().unwrap(),
                Some(json!({"localSave":"saved","revision":9,"receipt":receipt})),
                None,
            )
            .unwrap();
        }
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_receipts", [], |r| r.get(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn new_ui_session_interrupts_without_replaying_and_stale_completions_cannot_win() {
    let (_, _, jobs) = fixture();
    let plan = successful_preview(&jobs);
    let first = operation();
    let second = operation();
    jobs.ready_session(&first, true).unwrap();
    let params = json!({"operationId":operation(),"planId":plan});
    let submitted = jobs.dispatch("changes.apply", &params).unwrap();
    let id = submitted["jobId"].as_str().unwrap();
    let old = jobs.claim_session(&first).unwrap().unwrap();
    let old_token = old["claimToken"].as_str().unwrap();
    jobs.ready_session(&second, true).unwrap();
    assert_eq!(
        jobs.dispatch("jobs.status", &json!({"jobId":id})).unwrap()["status"],
        "interrupted"
    );
    assert!(jobs.claim_session(&second).unwrap().is_none());
    assert_eq!(
        jobs.ready_session(&first, false).unwrap_err().code,
        "UI_SESSION_STALE"
    );
    assert_eq!(
        jobs.ready_session(&first, true).unwrap_err().code,
        "UI_SESSION_STALE"
    );
    assert_eq!(
        jobs.claim_session(&first).unwrap_err().code,
        "UI_SESSION_STALE"
    );
    assert_eq!(
        jobs.complete_session(
            &first,
            id,
            old_token,
            Some(json!({"localSave":"saved"})),
            None
        )
        .unwrap_err()
        .code,
        "UI_SESSION_STALE"
    );
    // 只有显式重试同 operationId 才排队，且新领取标识永不复用旧标识。
    let retry = jobs.dispatch("changes.apply", &params).unwrap();
    assert_eq!(retry["jobId"], id);
    let current = jobs.claim_session(&second).unwrap().unwrap();
    let token = current["claimToken"].as_str().unwrap();
    assert_ne!(token, old_token);
    assert_eq!(
        jobs.complete_session(
            &second,
            id,
            old_token,
            Some(json!({"localSave":"saved"})),
            None
        )
        .unwrap_err()
        .code,
        "JOB_CLAIM_STALE"
    );
    assert_eq!(
        jobs.complete(id, Some(json!({"localSave":"saved"})), None)
            .unwrap_err()
            .code,
        "UI_SESSION_REQUIRED"
    );
    assert_eq!(jobs.claim().unwrap_err().code, "UI_SESSION_REQUIRED");
    jobs.verify_claim(&second, id, token).unwrap();
    jobs.complete_session(
        &second,
        id,
        token,
        Some(json!({"localSave":"saved","revision":8})),
        None,
    )
    .unwrap();
    assert_eq!(
        jobs.verify_claim(&second, id, token).unwrap_err().code,
        "JOB_CLAIM_STALE"
    );
}

#[test]
fn explicit_retry_after_ui_reload_recovers_sql_receipt_without_new_claim_or_write() {
    let (_, store, jobs) = fixture();
    let plan = successful_preview(&jobs);
    let session = operation();
    jobs.ready_session(&session, true).unwrap();
    let op = operation();
    let params = json!({"operationId":op,"planId":plan});
    jobs.dispatch("changes.apply", &params).unwrap();
    jobs.claim_session(&session).unwrap();
    let c = Connection::open(&store.path).unwrap();
    c.execute(
        "INSERT INTO workbench_receipts VALUES(?1,'synthetic',?2)",
        rusqlite::params![
            op,
            json!({"operationId":op,"revision":9,"configs":[{"id":"config"}]}).to_string()
        ],
    )
    .unwrap();
    let next = operation();
    jobs.ready_session(&next, true).unwrap();
    assert!(jobs.claim_session(&next).unwrap().is_none());
    let recovered = jobs.dispatch("changes.apply", &params).unwrap();
    assert_eq!(recovered["status"], "succeeded");
    assert_eq!(recovered["result"]["localSave"], "saved");
    assert!(jobs.claim_session(&next).unwrap().is_none());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_receipts", [], |r| r.get(0))
            .unwrap(),
        1
    );
}

#[test]
fn recovered_apply_retains_private_preview_link_order_and_overlays_saved_targets() {
    let (folder, store, jobs) = fixture();
    jobs.ready().unwrap();
    let submitted = jobs
        .dispatch("changes.preview", &preview(&operation()))
        .unwrap();
    let plan = submitted["jobId"].as_str().unwrap().to_owned();
    jobs.claim().unwrap();
    let context = json!({"revision":7,"configIds":["config"],"configs":[{"id":"first","name":"原链接第一套","private":"context-only"},{"id":"config","name":"原第二套"},{"id":"last","name":"原链接第三套"}]});
    jobs.complete(&plan,Some(json!({"plan":{"changes":[{"id":"config"}]},"exportContext":context,"summary":{"count":1}})),None).unwrap();
    let visible = jobs
        .dispatch("jobs.status", &json!({"jobId":plan}))
        .unwrap();
    assert!(!visible.to_string().contains("context-only"));
    assert!(!visible.to_string().contains("exportContext"));
    let op = operation();
    let params = json!({"planId":plan,"operationId":op});
    jobs.dispatch("changes.apply", &params).unwrap();
    jobs.claim().unwrap();
    drop(jobs);
    let c = Connection::open(&store.path).unwrap();
    c.execute("INSERT INTO workbench_receipts VALUES(?1,'synthetic',?2)",rusqlite::params![op,json!({"operationId":op,"revision":8,"configs":[{"id":"config","name":"已保存第二套"}]}).to_string()]).unwrap();
    let jobs = AgentJobs::new(folder, store).unwrap();
    let result = jobs.dispatch("changes.apply", &params).unwrap();
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["result"]["revision"], 8);
    assert!(result["result"].get("snapshot").is_none());
    jobs.ready().unwrap();
    jobs.dispatch("export.start",&json!({"operationId":operation(),"sourceOperationId":op,"images":"both","report":true,"outputDir":std::env::temp_dir()})).unwrap();
    let claim = jobs.claim().unwrap().unwrap();
    let snapshot = &claim["params"]["snapshot"];
    assert_eq!(
        snapshot["configs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first", "config", "last"]
    );
    assert_eq!(snapshot["configs"][1]["name"], "已保存第二套");
    assert_eq!(snapshot["configIds"], json!(["config"]));
    assert_eq!(snapshot["revision"], 8);
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_receipts", [], |r| r.get(0))
            .unwrap(),
        1
    );
}

#[test]
fn progress_is_bounded_running_only_public_and_never_writes_journal() {
    let (folder, _, jobs) = fixture();
    jobs.ready().unwrap();
    let submitted = jobs
        .dispatch("sync.run", &json!({"operationId":operation()}))
        .unwrap();
    let id = submitted["jobId"].as_str().unwrap();
    let valid = json!({"phase":"rendering","completed":1,"total":2,"name":"主机/2_配置.png"});
    assert_eq!(
        jobs.progress(id, valid.clone()).unwrap_err().code,
        "JOB_NOT_RUNNING"
    );
    jobs.claim().unwrap();
    let before = fs::read(folder.join("agent/jobs.json")).unwrap();
    jobs.progress(id, valid.clone()).unwrap();
    assert_eq!(
        jobs.dispatch("jobs.status", &json!({"jobId":id})).unwrap()["progress"],
        valid
    );
    assert_eq!(fs::read(folder.join("agent/jobs.json")).unwrap(), before);
    for bad in [
        json!({}),
        json!({"phase":"x","completed":1,"total":2,"sql":"x"}),
        json!({"phase":true,"completed":1,"total":2}),
        json!({"phase":"x","completed":-1,"total":2}),
        json!({"phase":"x","completed":3,"total":2}),
        json!({"phase":"x","completed":1.5,"total":2}),
        json!({"phase":"x","completed":1,"total":100001}),
        json!({"phase":"x","completed":1,"total":2,"name":"x".repeat(1025)}),
        json!({"phase":"x\n","completed":1,"total":2}),
    ] {
        assert_eq!(jobs.progress(id, bad).unwrap_err().code, "INVALID_PARAMS");
    }
    assert_eq!(
        jobs.progress("missing", valid.clone()).unwrap_err().code,
        "JOB_NOT_FOUND"
    );
    jobs.complete(id, Some(json!({"cloudSync":"completed"})), None)
        .unwrap();
    assert_eq!(
        jobs.progress(id, valid).unwrap_err().code,
        "JOB_NOT_RUNNING"
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(folder.join("agent/jobs.json")).unwrap()).unwrap();
    assert!(persisted["jobs"][0].get("progress").is_none());
}

#[test]
fn old_journal_without_export_context_still_loads_and_running_ui_lease_does_not_reclaim() {
    let (folder, store, jobs) = fixture();
    jobs.ready().unwrap();
    let submitted = jobs
        .dispatch("sync.run", &json!({"operationId":operation()}))
        .unwrap();
    jobs.claim().unwrap();
    {
        jobs.lock().unwrap().ready = Some(Instant::now() - UI_LEASE - Duration::from_secs(1));
    }
    assert!(jobs.claim().unwrap().is_none());
    assert_eq!(
        jobs.dispatch("jobs.status", &json!({"jobId":submitted["jobId"]}))
            .unwrap()["status"],
        "running"
    );
    drop(jobs);
    let path = folder.join("agent/jobs.json");
    let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    raw["jobs"][0]
        .as_object_mut()
        .unwrap()
        .remove("exportContext");
    fs::write(&path, raw.to_string()).unwrap();
    let jobs = AgentJobs::new(folder, store).unwrap();
    assert_eq!(
        jobs.dispatch("jobs.status", &json!({"jobId":submitted["jobId"]}))
            .unwrap()["status"],
        "interrupted"
    );
}
fn fixture() -> (PathBuf, WorkbenchStore, AgentJobs) {
    let folder = std::env::temp_dir().join(format!("diy-agent-jobs-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&folder).unwrap();
    let store = WorkbenchStore {
        path: folder.join("synthetic.sqlite"),
        assets: folder.join("assets"),
    };
    let connection = Connection::open(&store.path).unwrap();
    connection.execute_batch("CREATE TABLE workbench_receipts(operation TEXT PRIMARY KEY,hash TEXT NOT NULL,document TEXT NOT NULL)").unwrap();
    let jobs = AgentJobs::new(folder.clone(), store.clone()).unwrap();
    (folder, store, jobs)
}
fn operation() -> String {
    Uuid::new_v4().to_string()
}
fn preview(op: &str) -> Value {
    json!({"operationId":op,"request":{"shopId":"shop","targets":[{"configId":"config","partIndex":0}],"action":{"type":"displayName","value":"test"}}})
}
fn successful_preview(jobs: &AgentJobs) -> String {
    jobs.ready().unwrap();
    let submitted = jobs
        .dispatch("changes.preview", &preview(&operation()))
        .unwrap();
    let claim = jobs.claim().unwrap().unwrap();
    jobs.complete(
        claim["id"].as_str().unwrap(),
        Some(json!({"plan":{"secret":"internal","configs":[{}]},"summary":{"count":1}})),
        None,
    )
    .unwrap();
    submitted["jobId"].as_str().unwrap().into()
}
#[test]
fn strict_params_ui_and_idempotency() {
    let (_, _, jobs) = fixture();
    let op = operation();
    let params = preview(&op);
    assert_eq!(
        jobs.dispatch("changes.preview", &params).unwrap_err().code,
        "UI_UNAVAILABLE"
    );
    jobs.ready().unwrap();
    let first = jobs.dispatch("changes.preview", &params).unwrap();
    assert_eq!(
        jobs.dispatch("changes.preview", &params).unwrap()["jobId"],
        first["jobId"]
    );
    let mut changed = params.clone();
    changed["request"]["action"]["value"] = json!("other");
    assert_eq!(
        jobs.dispatch("changes.preview", &changed).unwrap_err().code,
        "OPERATION_ID_CONFLICT"
    );
    let mut extra = params.clone();
    extra["sql"] = json!("DROP TABLE");
    assert_eq!(
        jobs.dispatch("changes.preview", &extra).unwrap_err().code,
        "INVALID_PARAMS"
    );
    assert!(
        jobs.dispatch(
            "jobs.status",
            &json!({"jobId":first["jobId"],"operationId":op})
        )
        .is_err()
    );
    assert!(
        jobs.dispatch("sync.run", &json!({"operationId":"bad"}))
            .is_err()
    );
    assert!(
        jobs.complete(first["jobId"].as_str().unwrap(), Some(json!({})), None)
            .is_err()
    );
}
#[test]
fn preview_plan_is_private_apply_claim_injects_and_export_snapshot_is_private() {
    let (_, _, jobs) = fixture();
    let plan = successful_preview(&jobs);
    let status = jobs
        .dispatch("jobs.status", &json!({"jobId":plan}))
        .unwrap();
    assert_eq!(status["result"]["summary"]["count"], 1);
    assert!(!status.to_string().contains("secret"));
    let apply_op = operation();
    let apply = jobs
        .dispatch(
            "changes.apply",
            &json!({"planId":plan,"operationId":apply_op}),
        )
        .unwrap();
    let claim = jobs.claim().unwrap().unwrap();
    assert_eq!(claim["params"]["plan"]["secret"], "internal");
    jobs.complete(apply["jobId"].as_str().unwrap(),Some(json!({"localSave":"saved","revision":7,"receipt":{"operationId":apply_op,"configs":[{"secret":"config"}]},"snapshot":{"configs":[{"id":"config"}],"revision":7}})),None).unwrap();
    let status = jobs
        .dispatch("jobs.status", &json!({"operationId":apply_op}))
        .unwrap();
    assert!(status["result"].get("snapshot").is_none());
    assert!(status["result"]["receipt"].get("configs").is_none());
    let export=jobs.dispatch("export.start",&json!({"operationId":operation(),"sourceOperationId":apply_op,"images":"both","report":true,"outputDir":std::env::temp_dir()})).unwrap();
    assert!(
        jobs.export_params(export["jobId"].as_str().unwrap())
            .is_err()
    );
    let claim = jobs.claim().unwrap().unwrap();
    assert_eq!(claim["params"]["snapshot"]["revision"], 7);
    assert_eq!(
        jobs.export_params(export["jobId"].as_str().unwrap())
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn restart_interrupted_apply_recovers_receipt_without_ui_or_second_save() {
    let (folder, store, jobs) = fixture();
    let plan = successful_preview(&jobs);
    let op = operation();
    let params = json!({"planId":plan,"operationId":op});
    let job = jobs.dispatch("changes.apply", &params).unwrap();
    jobs.claim().unwrap();
    drop(jobs);
    let connection = Connection::open(&store.path).unwrap();
    connection
        .execute(
            "INSERT INTO workbench_receipts VALUES(?1,'synthetic',?2)",
            rusqlite::params![
                op,
                json!({"operationId":op,"revision":9,"configs":[{"id":"config"}]}).to_string()
            ],
        )
        .unwrap();
    let jobs = AgentJobs::new(folder, store).unwrap();
    assert_eq!(
        jobs.dispatch("jobs.status", &json!({"jobId":job["jobId"]}))
            .unwrap()["status"],
        "interrupted"
    );
    let recovered = jobs.dispatch("changes.apply", &params).unwrap();
    assert_eq!(recovered["status"], "succeeded");
    assert_eq!(recovered["result"]["localSave"], "saved");
    assert_eq!(
        connection
            .query_row::<i64, _, _>("SELECT count(*) FROM workbench_receipts", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
#[test]
fn restart_sync_does_not_use_save_receipt_and_retries_same_job() {
    let (folder, store, jobs) = fixture();
    jobs.ready().unwrap();
    let op = operation();
    let params = json!({"operationId":op});
    let first = jobs.dispatch("sync.run", &params).unwrap();
    jobs.claim().unwrap();
    drop(jobs);
    let connection = Connection::open(&store.path).unwrap();
    connection
        .execute("INSERT INTO workbench_receipts VALUES(?1,'x','{}')", [&op])
        .unwrap();
    let jobs = AgentJobs::new(folder, store).unwrap();
    assert_eq!(
        jobs.dispatch("sync.run", &params).unwrap_err().code,
        "UI_UNAVAILABLE"
    );
    jobs.ready().unwrap();
    let retried = jobs.dispatch("sync.run", &params).unwrap();
    assert_eq!(retried["jobId"], first["jobId"]);
    assert_eq!(retried["status"], "queued");
}
#[test]
fn capacity_expiry_and_persist_failure_preserve_receipts() {
    let (_, _, jobs) = fixture();
    let plan = successful_preview(&jobs);
    {
        let mut runtime = jobs.lock().unwrap();
        let job = runtime
            .journal
            .jobs
            .iter_mut()
            .find(|j| j.id == plan)
            .unwrap();
        job.updated_at = now() - PLAN_TTL_MS - 1;
    }
    assert_eq!(
        jobs.dispatch(
            "changes.apply",
            &json!({"planId":plan,"operationId":operation()})
        )
        .unwrap_err()
        .code,
        "PLAN_EXPIRED"
    );
    {
        let mut runtime = jobs.lock().unwrap();
        let template = runtime.journal.jobs[0].clone();
        while runtime.journal.jobs.len() < MAX_JOBS {
            let mut next = template.clone();
            next.id = operation();
            next.operation_id = operation();
            runtime.journal.jobs.push(next);
        }
    }
    assert_eq!(
        jobs.dispatch("sync.run", &json!({"operationId":operation()}))
            .unwrap_err()
            .code,
        "JOBS_CAPACITY"
    );
    assert_eq!(jobs.lock().unwrap().journal.jobs.len(), MAX_JOBS);
    let (_, store, _) = fixture();
    let folder = std::env::temp_dir().join(format!("diy-agent-jobs-test-blocked-{}", operation()));
    fs::write(&folder, "file prevents directory creation").unwrap();
    let jobs = AgentJobs::new(folder, store).unwrap();
    jobs.ready().unwrap();
    assert_eq!(
        jobs.dispatch("sync.run", &json!({"operationId":operation()}))
            .unwrap_err()
            .code,
        "JOBS_PERSIST_FAILED"
    );
    assert!(jobs.lock().unwrap().journal.jobs.is_empty());
}
#[test]
fn action_contract_allows_blank_upgrade_and_optional_replace_quantity() {
    let mut params = preview(&operation());
    params["request"]["action"] = json!({"type":"upgrade","value":""});
    assert!(validate("changes.preview", &params).is_ok());
    params["request"]["action"] = json!({"type":"upgrade","sourceId":"wrong"});
    assert!(validate("changes.preview", &params).is_err());
    params["request"]["action"] = json!({"type":"replace","sourceId":"source","quantity":2});
    assert!(validate("changes.preview", &params).is_ok());
    params["request"]["action"]["quantity"] = json!(0);
    assert!(validate("changes.preview", &params).is_err());
}
#[test]
fn concurrent_duplicate_submit_and_claim_only_execute_one_job() {
    let (_, _, jobs) = fixture();
    let jobs = std::sync::Arc::new(jobs);
    jobs.ready().unwrap();
    let params = preview(&operation());
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let jobs = jobs.clone();
            let params = params.clone();
            std::thread::spawn(move || {
                jobs.dispatch("changes.preview", &params).unwrap()["jobId"].clone()
            })
        })
        .collect();
    let ids: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert!(ids.iter().all(|id| *id == ids[0]));
    assert_eq!(jobs.lock().unwrap().journal.jobs.len(), 1);
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let jobs = jobs.clone();
            std::thread::spawn(move || jobs.claim().unwrap().is_some())
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| w.join().unwrap() as usize)
            .sum::<usize>(),
        1
    );
}
#[test]
fn no_change_apply_can_export_and_completion_cannot_overwrite_success() {
    let (_, _, jobs) = fixture();
    let plan = successful_preview(&jobs);
    let op = operation();
    let apply = jobs
        .dispatch("changes.apply", &json!({"operationId":op,"planId":plan}))
        .unwrap();
    jobs.claim().unwrap();
    jobs.complete(
        apply["jobId"].as_str().unwrap(),
        Some(json!({"localSave":"unchanged","snapshot":{"configs":[],"revision":11}})),
        None,
    )
    .unwrap();
    assert_eq!(
        jobs.complete(
            apply["jobId"].as_str().unwrap(),
            None,
            Some(json!({"code":"late"}))
        )
        .unwrap_err()
        .code,
        "JOB_NOT_RUNNING"
    );
    assert!(jobs.dispatch("export.start",&json!({"operationId":operation(),"sourceOperationId":op,"images":"long","report":false,"outputDir":std::env::temp_dir()})).is_ok());
}
