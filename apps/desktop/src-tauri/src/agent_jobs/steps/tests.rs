use super::*;

fn uuid() -> String {
    Uuid::new_v4().to_string()
}
fn source_request() -> Value {
    json!({"shopId":"intel","scope":"shared","action":"edit","sourceId":"source-a","fields":{"name":"测试"},"followConfigs":true})
}
fn source_plan(request: &Value) -> Value {
    json!({"shop":"intel","request":request,"steps":[
    {"kind":"catalog","catalogKind":"shared-sources","resourceId":"row","shopId":"intel","action":"replace","body":{"document":{"edits":{"shared":{"values":{"name":"测试"}}}}},"privateBody":"冻结原文"},
    {"kind":"configurations","shopId":"gigabyte","privateBody":"保留人工作品"}]})
}
fn draft_request() -> Value {
    json!({"shopId":"intel","mode":"new_draft_link","productName":"合成草稿",
    "configs":[{"name":"配置1","parts":[{"slot":"CPU","sourceId":"source-cpu"}]}]})
}
fn draft_plan(request: &Value) -> Value {
    let id = uuid();
    json!({"shop":"intel","request":request,"steps":[{"kind":"configurations","shopId":"intel","changes":[{
        "id":id,"action":"create","document":{"id":id,"shopId":"intel","productId":uuid(),"productDraft":true,"skuId":"","spu":""}}]}]})
}
fn preview_plan(
    jobs: &AgentJobs,
    session: &str,
    method: &str,
    request: &Value,
    plan: &Value,
) -> Result<String> {
    jobs.dispatch_at(
        method,
        &json!({"operationId":uuid(),"request":request}),
        Some("intel"),
    )?;
    let claim = jobs.claim_session(session)?.unwrap();
    let id = claim["id"].as_str().unwrap();
    jobs.complete_session(
        session,
        id,
        claim["claimToken"].as_str().unwrap(),
        Some(json!({"plan":plan,"summary":{"count":1}})),
        None,
    )?;
    let public = jobs.dispatch("jobs.status", &json!({"jobId":id}))?;
    if public["status"] == "failed" {
        return Err(serde_json::from_value(public["error"].clone()).unwrap());
    }
    assert_eq!(public["result"]["planId"], id);
    assert!(public["result"].get("plan").is_none());
    Ok(id.to_owned())
}

#[test]
fn source_steps_partial_failure_and_restarted_retry_verify_original_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let session = uuid();
    let jobs = AgentJobs::open_nas(dir.path()).unwrap();
    jobs.ready_in_shop(&session, true, Some("intel")).unwrap();
    let request = source_request();
    let plan = source_plan(&request);
    let plan_id = preview_plan(&jobs, &session, "sources.preview", &request, &plan).unwrap();
    let op = uuid();
    let params = json!({"planId":plan_id,"operationId":op});
    let status = jobs
        .dispatch_at("sources.apply", &params, Some("intel"))
        .unwrap();
    let id = status["jobId"].as_str().unwrap();
    let claimed = jobs.claim_session(&session).unwrap().unwrap();
    let token = claimed["claimToken"].as_str().unwrap();
    let states = &claimed["params"]["stepStates"];
    assert_eq!(claimed["params"]["plan"], plan);
    assert_ne!(states[0]["operationId"], states[1]["operationId"]);
    assert_eq!(
        Uuid::parse_str(states[0]["operationId"].as_str().unwrap())
            .unwrap()
            .get_version_num(),
        8
    );
    assert!(
        jobs.record_step(&session, id, token, 1, Some("gigabyte"), None)
            .is_err()
    );
    assert!(
        jobs.record_step(&session, id, token, 0, Some("gigabyte"), None)
            .is_err()
    );
    jobs.record_step(&session, id, token, 0, Some("intel"), None)
        .unwrap();
    assert_eq!(
        jobs.record_step(&session, id, token, 0, Some("intel"), None)
            .unwrap_err()
            .code,
        "STEP_ALREADY_SUBMITTED"
    );
    let receipt = json!({"operation_id":states[0]["operationId"],"shop_id":"intel","kind":"shared-sources","resource_id":"row","version":"2"});
    jobs.record_step(&session, id, token, 0, None, Some(&receipt))
        .unwrap();
    jobs.record_step(&session, id, token, 0, None, Some(&receipt))
        .unwrap();
    assert!(
        jobs.record_step(&session, id, token, 0, Some("intel"), None)
            .is_err()
    );
    jobs.record_step(&session, id, token, 1, Some("gigabyte"), None)
        .unwrap();
    jobs.complete_session(
        &session,
        id,
        token,
        None,
        Some(json!({"code":"VERSION_CONFLICT","message":"该店配置版本已变化"})),
    )
    .unwrap();
    let partial = jobs
        .dispatch("jobs.status", &json!({"operationId":op}))
        .unwrap();
    assert_eq!(partial["status"], "failed");
    assert_eq!(partial["result"]["partialSuccess"], true);
    assert_eq!(
        partial["result"]["confirmedSteps"][0]["receipt"]["version"],
        "2"
    );
    assert_eq!(
        partial["result"]["remainingSteps"][0]["reason"]["code"],
        "VERSION_CONFLICT"
    );
    assert!(!partial.to_string().contains("privateBody"));
    drop(jobs);
    let jobs = AgentJobs::open_nas(dir.path()).unwrap();
    let next = uuid();
    jobs.ready_in_shop(&next, true, Some("intel")).unwrap();
    assert_eq!(
        jobs.nas_target("sources.apply", &params).unwrap(),
        (Some("intel".into()), true)
    );
    assert_eq!(
        jobs.dispatch("sources.apply", &params).unwrap()["jobId"],
        id
    );
    let claimed = jobs.claim_session(&next).unwrap().unwrap();
    let token = claimed["claimToken"].as_str().unwrap();
    let resumed = &claimed["params"]["stepStates"];
    assert_eq!(resumed[0]["receipt"], receipt);
    assert_eq!(resumed[0]["state"], "confirmed");
    assert_eq!(resumed[1]["state"], "submitted");
    assert_eq!(resumed[1]["operationId"], states[1]["operationId"]);
    let found = json!({"operation_id":resumed[1]["operationId"],"shop_id":"gigabyte","kind":"configurations","changes":[]});
    // 已随原请求写入但响应丢失时，只需确认 NAS 回查结果；此处没有再次走提交许可。
    jobs.record_step(&next, id, token, 1, None, Some(&found))
        .unwrap();
    jobs.complete_session(&next, id, token, Some(json!({"nasSave":"saved"})), None)
        .unwrap();
    assert_eq!(
        jobs.dispatch("sources.apply", &params).unwrap()["status"],
        "succeeded"
    );
    assert!(jobs.claim_session(&next).unwrap().is_none());
}

#[test]
fn draft_only_creates_new_draft_links_and_cannot_apply_a_source_plan() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = AgentJobs::open_nas(dir.path()).unwrap();
    let session = uuid();
    jobs.ready_in_shop(&session, true, Some("intel")).unwrap();
    let r = draft_request();
    let plan = draft_plan(&r);
    let mut bad = plan.clone();
    bad["steps"][0]["changes"][0]["document"]["spu"] = json!("上线编号");
    assert_eq!(
        preview_plan(&jobs, &session, "draft.preview", &r, &bad)
            .unwrap_err()
            .code,
        "INVALID_PLAN"
    );
    let id = preview_plan(&jobs, &session, "draft.preview", &r, &plan).unwrap();
    let op = uuid();
    let params = json!({"operationId":op,"planId":id});
    assert_eq!(
        jobs.dispatch("sources.apply", &params).unwrap_err().code,
        "PLAN_NOT_FOUND"
    );
    let mut injected = params.clone();
    injected["steps"] = plan["steps"].clone();
    assert_eq!(
        jobs.dispatch("draft.apply", &injected).unwrap_err().code,
        "INVALID_PARAMS"
    );
    jobs.dispatch("draft.apply", &params).unwrap();
    let claim = jobs.claim_session(&session).unwrap().unwrap();
    assert_eq!(claim["params"]["stepStates"][0]["operationId"], op);
}

#[test]
fn input_scope_is_frozen_before_claiming_or_filling_in_steps() {
    let op = uuid();
    let r = source_request();
    for (scope, action, key, value) in [
        ("shop", "create_special", "fields", json!({"name":"特别件"})),
        ("shop", "edit", "restoreFields", json!(["name"])),
        ("shared", "archive", "sourceId", json!("source")),
        ("shared", "edit", "stepStates", json!([])),
    ] {
        let mut request = r.clone();
        request["scope"] = json!(scope);
        request["action"] = json!(action);
        request[key] = value;
        assert!(
            validate_request(
                "sources.preview",
                &json!({"operationId":op,"request":request})
            )
            .is_err()
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let jobs = AgentJobs::open_nas(dir.path()).unwrap();
    let session = uuid();
    jobs.ready_session(&session, true).unwrap();
    let mut single = r;
    single["scope"] = json!("shop");
    let mismatched = source_plan(&single);
    assert_eq!(
        preview_plan(&jobs, &session, "sources.preview", &single, &mismatched)
            .unwrap_err()
            .code,
        "INVALID_PLAN"
    );
    let mut no_follow = single.clone();
    no_follow["followConfigs"] = json!(false);
    let mut plan = source_plan(&no_follow);
    plan["steps"][0]["body"]["document"]["edits"] = json!({"intel":{"values":{"name":"本店覆盖"}}});
    plan["steps"][1]["shopId"] = json!("intel");
    assert_eq!(
        preview_plan(&jobs, &session, "sources.preview", &no_follow, &plan)
            .unwrap_err()
            .code,
        "INVALID_PLAN"
    );
}

#[test]
fn sqlite_rejects_all_nas_writes_without_creating_a_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("unused.sqlite");
    let store = WorkbenchStore {
        path: path.clone(),
        assets: directory.path().join("assets"),
    };
    let jobs = AgentJobs::new(directory.path().to_owned(), store).unwrap();
    for method in [
        "draft.preview",
        "draft.apply",
        "sources.preview",
        "sources.apply",
    ] {
        assert_eq!(
            jobs.dispatch(method, &json!({})).unwrap_err().code,
            "NAS_MODE_REQUIRED"
        );
    }
    assert!(!path.exists());
}
