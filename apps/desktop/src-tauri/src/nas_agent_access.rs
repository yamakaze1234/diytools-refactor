//! 界面、管道入队、任务领取和提交前共用同一套实时授权计算。
use super::*;
use crate::agent_jobs::steps::{self, SourceScope};
use crate::agent_permissions::Flags;

pub(super) const METHODS: &[&str] = &[
    "status",
    "shops.list",
    "jobs.status",
    "configs.find",
    "configs.get",
    "sources.find",
    "sources.get",
    "inventory.check",
    "activity.list",
    "changes.preview",
    "changes.apply",
    "draft.preview",
    "draft.apply",
    "sources.preview",
    "sources.apply",
    "export.start",
    "sync.run",
];

pub(super) fn scope_key(endpoint: &str, actor: &Actor) -> String {
    format!("{:x}", Sha256::digest(json!([endpoint, actor]).to_string()))
}

pub(super) fn operating_shops(me: &Value) -> Vec<(&'static str, &Value)> {
    query::SHOPS
        .iter()
        .filter_map(|&(shop, _)| {
            let member = me["shops"]
                .as_array()?
                .iter()
                .any(|r| r["shop_id"] == shop && r["role"] == "operations");
            let cap = match me.get("shop_capabilities") {
                Some(list) => &list[shop],
                None if shop == "intel" => me,
                _ => return None,
            };
            (member && cap["data_source"] == format!("{shop}_live")).then_some((shop, cap))
        })
        .collect()
}
fn business_allows(cap: &Value, method: &str) -> bool {
    match method {
        "changes.preview" | "changes.apply" | "draft.preview" | "draft.apply" => can_write(cap),
        "sources.preview" | "sources.apply" => cap["catalog_writes"] == true,
        _ => true,
    }
}
fn source_flags(flags: &Flags, spec: Option<&SourceScope>, claimed: bool) -> Result<()> {
    if let Some(scope) = spec {
        if (scope.shared && !flags.write_sources_shared)
            || (scope.follow && !(flags.write_sources_follow_configs && flags.write_configs))
        {
            return Err(AgentError::new(
                if claimed {
                    "PERMISSION_REVOKED"
                } else {
                    "PERMISSION_DENIED"
                },
                "请在「AI 接口权限」开启对应的三店共用或配置联动权限",
            ));
        }
    }
    Ok(())
}
pub(super) fn source_gate(
    flags: &Flags,
    me: &Value,
    shop: Option<&str>,
    spec: Option<&SourceScope>,
    claimed: bool,
) -> Result<()> {
    source_flags(flags, spec, claimed)?;
    let Some(scope) = spec else { return Ok(()) };
    let shops = operating_shops(me);
    let all_catalog = shared_catalog(&shops);
    let has = |id: &str, key: &str| shops.iter().any(|(s, cap)| *s == id && cap[key] == true);
    let can_follow = |id: &str| {
        shops
            .iter()
            .any(|(s, cap)| *s == id && cap["catalog_writes"] == true && can_write(cap))
    };
    // 预览尚未遍历配置；保存时直接核对冻结计划所涉及的每一家配置店铺。
    let follow_allowed = if !scope.follow_shops.is_empty() {
        scope.follow_shops.iter().all(|id| can_follow(id))
    } else if scope.shared {
        shops.iter().any(|(id, _)| can_follow(id))
    } else {
        shop.is_some_and(can_follow)
    };
    if (scope.shared && !all_catalog)
        || !scope
            .shared_api_shops
            .iter()
            .all(|s| has(s, "shared_sources"))
        || !scope
            .workspace_shops
            .iter()
            .all(|s| has(s, "workspace_writes"))
        || (scope.follow && !follow_allowed)
    {
        return Err(AgentError::new(
            if claimed {
                "PERMISSION_REVOKED"
            } else {
                "FORBIDDEN"
            },
            "当前 NAS 运营权限不覆盖请求涉及的目录或关联配置",
        ));
    }
    Ok(())
}
fn shared_catalog(shops: &[(&str, &Value)]) -> bool {
    shops.len() == query::SHOPS.len()
        && shops
            .iter()
            .all(|(_, cap)| cap["catalog_writes"] == true && cap["shared_sources"] == true)
}
pub(super) fn local_gate(enabled: bool, flags: &Flags, method: &str, claimed: bool) -> Result<()> {
    let refused = |code: &str, message: &str| {
        AgentError::new(if claimed { "PERMISSION_REVOKED" } else { code }, message)
    };
    if !enabled {
        return Err(refused("AGENT_DISABLED", "工作台已关闭本机 AI 接口"));
    }
    if !flags.permits(method) {
        let name = match method {
            "configs.find" | "configs.get" => "配置查询",
            "sources.find" | "sources.get" => "输出源查询",
            "activity.list" | "inventory.check" => "库存与操作记录",
            "changes.preview" | "changes.apply" => "修改配置",
            "draft.preview" | "draft.apply" => "新建 NAS 草稿",
            "sources.preview" | "sources.apply" => "维护输出源",
            "export.start" => "图片与报表导出",
            "sync.run" => "刷新工作台",
            _ => "对应权限",
        };
        return Err(refused(
            "PERMISSION_DENIED",
            &format!("请在「更多 → AI 接口权限」开启「{name}」"),
        ));
    }
    Ok(())
}
pub(super) fn gate(
    enabled: bool,
    flags: &Flags,
    me: &Value,
    method: &str,
    shop: Option<&str>,
    recover: bool,
    claimed: bool,
) -> Result<()> {
    let receipt_only = (method == "changes.apply" || steps::stepped(method)) && recover;
    if !receipt_only {
        local_gate(enabled, flags, method, claimed)?;
    }
    if !operating_shops(me).iter().any(|(id, cap)| {
        shop.is_none_or(|s| s == *id) && (receipt_only || business_allows(cap, method))
    }) {
        return Err(AgentError::new(
            if claimed {
                "PERMISSION_REVOKED"
            } else {
                "FORBIDDEN"
            },
            "当前账号没有目标店铺的 NAS 操作权限",
        ));
    }
    Ok(())
}
fn effective(enabled: bool, flags: &Flags, me: &Value) -> (Vec<&'static str>, Value) {
    let mut by_shop = serde_json::Map::new();
    for (shop, cap) in operating_shops(me) {
        let methods: Vec<_> = METHODS
            .iter()
            .copied()
            .filter(|m| enabled && flags.permits(m) && business_allows(cap, m))
            .collect();
        by_shop.insert(shop.to_string(), json!(methods));
    }
    let all = METHODS
        .iter()
        .copied()
        .filter(|m| {
            by_shop
                .values()
                .any(|v| v.as_array().is_some_and(|rows| rows.iter().any(|s| s == m)))
        })
        .collect();
    (all, Value::Object(by_shop))
}
pub(super) fn visible_step_progress(result: &Value, me: &Value) -> Value {
    let shops = operating_shops(me);
    let mut value = json!({"partialSuccess":result["partialSuccess"]});
    for field in ["confirmedSteps", "remainingSteps"] {
        let rows = result[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| shops.iter().any(|(id, _)| v["shopId"] == *id));
        value[field]=json!(rows.map(|row|json!({"index":row["index"],"kind":row["kind"],"shopId":row["shopId"],"operationId":row["operationId"],"state":row["state"]})).collect::<Vec<_>>());
    }
    value
}
impl NasAgent {
    pub(super) fn policy_status(&self, scope: &str, actor: &Actor, me: &Value) -> Result<Value> {
        let (enabled, flags) = self.policy.get(scope)?;
        let (capabilities, by_shop) = effective(enabled, &flags, me);
        let shops = operating_shops(me);
        let shared =
            enabled && flags.write_sources && flags.write_sources_shared && shared_catalog(&shops);
        let scopes:serde_json::Map<String,Value>=shops.into_iter().map(|(id,c)|(id.to_owned(),json!({"shared":shared,
            "followConfigs":enabled && flags.write_sources && flags.write_configs && flags.write_sources_follow_configs && c["catalog_writes"]==true && can_write(c)}))).collect();
        Ok(
            json!({"account":{"workspaceId":actor.0,"uid":actor.1,"name":self.cloud.nas_agent_name(actor).unwrap_or_else(||actor.1.clone())},
            "shopCapabilities":by_shop,"shopSourceScopes":scopes,"readOnly":!capabilities.iter().any(|m|matches!(*m,"changes.apply"|"draft.apply"|"sources.apply"|"export.start"|"sync.run")),
            "capabilities":capabilities,"agentPermissionVersion":1}),
        )
    }
    pub fn permissions(&self, change: Option<(&str, &Value)>) -> Result<Value> {
        let (endpoint, actor) = self.scope()?;
        let key = scope_key(&endpoint, &actor);
        let me = self.cloud.nas_agent_read("/api/v1/me", &actor, None)?;
        let shops = operating_shops(&me);
        if shops.is_empty() {
            return Err(AgentError::new("FORBIDDEN", "当前账号没有运营店铺"));
        }
        let shared_allowed = shared_catalog(&shops);
        let follow_allowed = shops
            .iter()
            .any(|(_, cap)| cap["catalog_writes"] == true && can_write(cap));
        if let Some((expected, patch)) = change {
            if expected != key || self.scope()? != (endpoint.clone(), actor.clone()) {
                return Err(AgentError::new(
                    "MEMBER_CHANGED",
                    "账号已切换，请重新打开 AI 接口权限",
                ));
            }
            self.policy
                .update(&key, patch, shared_allowed, follow_allowed)?;
        }
        let (enabled, mut flags) = self.policy.get(&key)?;
        flags.write_sources_shared &= shared_allowed;
        flags.write_sources_follow_configs &= follow_allowed;
        let mut result = self.policy_status(&key, &actor, &me)?;
        let exe = std::env::current_exe().map_err(|_| bad_response())?;
        let directory = exe.parent().ok_or_else(bad_response)?;
        let path = directory.join("agent-connection.json");
        let connection: Value = fs::read(&path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .ok_or_else(|| {
                AgentError::new("CONNECTION_UNAVAILABLE", "无法读取本机 Agent 连接文件")
            })?;
        let instance = diytools_agent_core::instance_for_pid(std::process::id());
        let cli = connection["cli"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.is_absolute() && p.parent() == Some(directory));
        if connection["instance"] != instance || cli.is_none() {
            return Err(AgentError::new(
                "CONNECTION_UNAVAILABLE",
                "连接文件与当前工作台实例不一致",
            ));
        }
        result["available"] = json!(true);
        result["enabled"] = json!(enabled);
        result["scopeKey"] = json!(key);
        result["permissions"] = json!(flags);
        result["instance"] = json!(instance);
        result["cliPath"] = json!(cli);
        result["connectionPath"] = json!(path);
        result["shops"]=json!(shops.into_iter().map(|(id,c)|json!({"id":id,"name":query::shop(&json!(id))["name"],
            "catalogWrites":c["catalog_writes"]==true,"sharedSources":c["shared_sources"]==true,"configurationWrites":c["configuration_writes"]==true,"workspaceWrites":c["workspace_writes"]==true})).collect::<Vec<_>>());
        if self.scope()? != (endpoint, actor) {
            return Err(AgentError::new("MEMBER_CHANGED", "当前成员已变化"));
        }
        Ok(result)
    }
    // 大日志落盘期间可能撤权，preflight 返回到界面前再核对一次本机策略及当前成员。
    pub fn check_submission(
        &self,
        actor: &Value,
        method: &str,
        spec: Option<&SourceScope>,
    ) -> Result<()> {
        let (endpoint, current) = self.scope()?;
        if *actor != json!(current) {
            return Err(AgentError::new("MEMBER_CHANGED", "任务所属成员已变化"));
        }
        let (enabled, flags) = self.policy.get(&scope_key(&endpoint, &current))?;
        local_gate(enabled, &flags, method, true)?;
        source_flags(&flags, spec, true)
    }
    pub fn check_ui_job(
        &self,
        actor: &Value,
        method: &str,
        shop: Option<&str>,
        recover: bool,
        spec: Option<&SourceScope>,
    ) -> Result<()> {
        let (endpoint, current) = self.scope()?;
        if *actor != json!(current) {
            return Err(AgentError::new("MEMBER_CHANGED", "任务所属成员已变化"));
        }
        let key = scope_key(&endpoint, &current);
        let (enabled, flags) = self.policy.get(&key)?;
        if !recover && (!enabled || !flags.permits(method)) {
            return Err(AgentError::new(
                "PERMISSION_REVOKED",
                "任务权限已撤回，未继续执行",
            ));
        }
        let me = self.cloud.nas_agent_read("/api/v1/me", &current, None)?;
        if self.scope()? != (endpoint, current) {
            return Err(AgentError::new("MEMBER_CHANGED", "任务所属成员已变化"));
        }
        let (enabled, flags) = self.policy.get(&key)?;
        gate(enabled, &flags, &me, method, shop, recover, true)?;
        if !recover {
            source_gate(&flags, &me, shop, spec, true)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_shared_and_follow_permissions_match_each_target_at_all_three_gates() {
        let mut me = json!({"shops":[],"shop_capabilities":{}});
        for (shop, _) in query::SHOPS {
            me["shops"]
                .as_array_mut()
                .unwrap()
                .push(json!({"shop_id":shop,"role":"operations"}));
            me["shop_capabilities"][shop] = json!({"data_source":format!("{shop}_live"),"workspace_writes":true,"configuration_writes":true,"catalog_writes":true,"shared_sources":true});
        }
        let mut flags = Flags {
            write_sources: true,
            write_configs: true,
            write_sources_shared: true,
            write_sources_follow_configs: true,
            ..Flags::default()
        };
        let spec = SourceScope {
            shared: true,
            follow: true,
            follow_shops: vec!["gigabyte".into()],
            ..Default::default()
        };
        for claimed in [false, true] {
            source_gate(&flags, &me, Some("intel"), Some(&spec), claimed).unwrap();
            let mut single = me.clone();
            single["shops"] = json!([{"shop_id":"intel","role":"operations"}]);
            assert_eq!(
                source_gate(&flags, &single, Some("intel"), Some(&spec), claimed)
                    .unwrap_err()
                    .code,
                if claimed {
                    "PERMISSION_REVOKED"
                } else {
                    "FORBIDDEN"
                }
            );
            let mut blocked = me.clone();
            blocked["shop_capabilities"]["gigabyte"]["workspace_writes"] = json!(false);
            assert!(source_gate(&flags, &blocked, Some("intel"), Some(&spec), claimed).is_err());
        }
        flags.write_sources_follow_configs = false;
        assert_eq!(
            source_gate(&flags, &me, Some("intel"), Some(&spec), true)
                .unwrap_err()
                .code,
            "PERMISSION_REVOKED"
        );
        flags.write_sources_shared = false;
        let single = SourceScope::default();
        gate(
            true,
            &flags,
            &me,
            "sources.apply",
            Some("intel"),
            false,
            true,
        )
        .unwrap();
        source_gate(&flags, &me, Some("intel"), Some(&single), true).unwrap();
        assert!(gate(true, &flags, &me, "draft.apply", Some("intel"), false, true).is_err());
        gate(
            false,
            &Flags::default(),
            &me,
            "sources.apply",
            Some("intel"),
            true,
            true,
        )
        .unwrap();
        assert!(
            gate(
                false,
                &Flags::default(),
                &me,
                "sources.apply",
                Some("intel"),
                false,
                true
            )
            .is_err()
        );
        let (visible, _) = effective(true, &flags, &me);
        assert!(visible.contains(&"sources.apply") && !visible.contains(&"draft.apply"));
        assert_eq!(nas_config(&json!({}), false)["productDraft"], false);
        assert_eq!(
            nas_config(&json!({"productDraft":true}), true)["productDraft"],
            true
        );
    }
    #[test]
    fn accounts_deployments_and_workspaces_isolate_jobs_and_live_permissions() {
        let folder = tempfile::tempdir().unwrap();
        let primary = scope_key("nas-a", &("workspace-1".into(), "member-a".into()));
        let operations = |ids: &[&str]| {
            let mut me = json!({"shops":[],"shop_capabilities":{}});
            for id in ids {
                me["shops"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"shop_id":id,"role":"operations"}));
                me["shop_capabilities"][*id] = json!({"data_source":format!("{id}_live"),
                    "catalog_writes":true,"workspace_writes":true,"configuration_writes":true});
            }
            me
        };
        let shops = query::SHOPS.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        let all = operations(&shops);
        let single = operations(&["intel"]);
        let owner = Policy::open(folder.path()).unwrap();
        owner
            .update(
                &primary,
                &json!({"writeConfigs":true,"writeSources":true,"writeSourcesShared":true}),
                true,
                true,
            )
            .unwrap();
        let jobs = AgentJobs::open_nas(&folder.path().join(&primary)).unwrap();
        jobs.ready().unwrap();
        let op = uuid::Uuid::new_v4().to_string();
        let queued = jobs
            .dispatch_at(
                "inventory.check",
                &json!({"operationId":op,"shopId":"intel"}),
                Some("intel"),
            )
            .unwrap();
        let job_id = queued["jobId"].as_str().unwrap();
        jobs.claim().unwrap().unwrap();
        jobs.complete(
            job_id,
            Some(
                json!({"shopId":"intel","threshold":5,"total":1,"counts":{"out":1},
            "items":[{"goodsId":"仅原账号可读"}]}),
            ),
            None,
        )
        .unwrap();
        drop(owner);
        drop(jobs);
        let policy = Policy::open(folder.path()).unwrap();
        let (enabled, flags) = policy.get(&primary).unwrap();
        assert!(flags.write_sources_shared);
        for shop in &shops {
            gate(
                enabled,
                &flags,
                &all,
                "changes.apply",
                Some(shop),
                false,
                false,
            )
            .unwrap();
        }
        let page = json!({"jobId":job_id});
        let saved = AgentJobs::open_nas(&folder.path().join(&primary))
            .unwrap()
            .dispatch("inventory.check", &page)
            .unwrap();
        assert_eq!(saved["result"]["items"][0]["goodsId"], "仅原账号可读");
        // 同机的另一 UID、另一工作区及另一部署分别打开自己的目录，编号与操作号均不能跨域查询。
        for (endpoint, workspace, uid) in [
            ("nas-a", "workspace-1", "member-b"),
            ("nas-a", "workspace-2", "member-a"),
            ("nas-b", "workspace-1", "member-a"),
        ] {
            let key = scope_key(endpoint, &(workspace.into(), uid.into()));
            let (enabled, flags) = policy.get(&key).unwrap();
            assert_eq!(flags, Flags::default());
            gate(
                enabled,
                &flags,
                &single,
                "configs.find",
                Some("intel"),
                false,
                false,
            )
            .unwrap();
            assert_eq!(
                gate(
                    enabled,
                    &flags,
                    &single,
                    "changes.apply",
                    Some("intel"),
                    false,
                    false
                )
                .unwrap_err()
                .code,
                "PERMISSION_DENIED"
            );
            assert_eq!(
                gate(
                    enabled,
                    &flags,
                    &single,
                    "configs.find",
                    Some("gigabyte"),
                    false,
                    false
                )
                .unwrap_err()
                .code,
                "FORBIDDEN"
            );
            let other = AgentJobs::open_nas(&folder.path().join(key)).unwrap();
            assert_eq!(
                other
                    .dispatch("jobs.status", &json!({"operationId":op}))
                    .unwrap_err()
                    .code,
                "JOB_NOT_FOUND"
            );
            assert_eq!(
                other.dispatch("inventory.check", &page).unwrap_err().code,
                "JOB_NOT_FOUND"
            );
        }
    }
    #[test]
    fn queued_apply_revocation_stops_delivery_and_only_persisted_submission_can_recover() {
        let folder = tempfile::tempdir().unwrap();
        let policy = Policy::open(folder.path()).unwrap();
        let jobs = AgentJobs::open_nas(folder.path()).unwrap();
        let actor = ("workspace".into(), "member-a".into());
        let key = scope_key("nas-a", &actor);
        assert_ne!(key, scope_key("nas-b", &actor));
        assert_ne!(
            key,
            scope_key("nas-a", &("workspace".into(), "member-b".into()))
        );
        let me = json!({"shops":[{"shop_id":"intel","role":"operations"}],"shop_capabilities":{
            "intel":{"data_source":"intel_live","configuration_writes":true,"workspace_writes":true}}});
        let op = || uuid::Uuid::new_v4().to_string();
        let session = op();
        jobs.ready_in_shop(&session, true, Some("intel")).unwrap();
        let request = json!({"operationId":op(),"request":{"shopId":"intel","targets":[{"configId":"c","partIndex":0}],
            "action":{"type":"displayName","value":"测试"}}});
        let preview = jobs
            .dispatch_at("changes.preview", &request, Some("intel"))
            .unwrap();
        let claimed = jobs.claim_session(&session).unwrap().unwrap();
        jobs.complete_session(
            &session,
            claimed["id"].as_str().unwrap(),
            claimed["claimToken"].as_str().unwrap(),
            Some(json!({"plan":{"shop":"intel","changes":[]}})),
            None,
        )
        .unwrap();
        let params = json!({"planId":preview["jobId"],"operationId":op()});
        let (shop, recover) = jobs.nas_target("changes.apply", &params).unwrap();
        let check = |recover: bool, claimed: bool| {
            let (enabled, flags) = policy.get(&key)?;
            gate(
                enabled,
                &flags,
                &me,
                "changes.apply",
                shop.as_deref(),
                recover,
                claimed,
            )
        };
        policy
            .update(&key, &json!({"writeConfigs":true}), false, true)
            .unwrap();
        check(recover, false).unwrap();
        let apply = jobs
            .dispatch_at("changes.apply", &params, shop.as_deref())
            .unwrap();
        policy
            .update(&key, &json!({"writeConfigs":false}), false, true)
            .unwrap();
        // 即使计划与版本仍然有效，撤权队列也不再把正文交给可执行 NAS 写入的界面。
        assert!(
            jobs.claim_checked(&session, |_| check(false, true))
                .unwrap()
                .is_null()
        );
        let status = jobs
            .dispatch("jobs.status", &json!({"jobId":apply["jobId"]}))
            .unwrap();
        assert_eq!(status["status"], "failed");
        assert_eq!(status["error"]["code"], "PERMISSION_REVOKED");
        assert!(!jobs.nas_target("changes.apply", &params).unwrap().1);
        policy
            .update(&key, &json!({"writeConfigs":true}), false, true)
            .unwrap();
        jobs.dispatch_at("changes.apply", &params, shop.as_deref())
            .unwrap();
        let claim = jobs
            .claim_checked(&session, |_| check(false, true))
            .unwrap();
        check(false, true).unwrap();
        jobs.mark_nas_submission(
            &session,
            claim["id"].as_str().unwrap(),
            claim["claimToken"].as_str().unwrap(),
        )
        .unwrap();
        policy
            .update(&key, &json!({"writeConfigs":false}), false, true)
            .unwrap();
        let (_, recover) = jobs.nas_target("changes.apply", &params).unwrap();
        assert!(recover);
        check(recover, true).unwrap();
        assert_eq!(check(false, true).unwrap_err().code, "PERMISSION_REVOKED");
    }
}
