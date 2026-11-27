//! NAS Agent 复用当前登录会话和正式 HTTPS 查询，任务记录以部署、账号隔离。
#[path = "nas_agent_access.rs"]
mod access;
use crate::agent_permissions::Policy;
use access::{gate, operating_shops, scope_key};
#[path = "nas_agent_queries.rs"]
mod extended;
use crate::{agent_jobs::AgentJobs, agent_queries as query, cloud_native::CloudRuntime};
use diytools_agent_core::{AgentError, Request, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, AgentError>;
type Actor = (String, String);
type JobScopes = HashMap<String, Arc<AgentJobs>>;

pub struct NasAgent {
    cloud: Arc<CloudRuntime>,
    folder: PathBuf,
    policy: Policy,
    query_slots: Arc<tokio::sync::Semaphore>,
    jobs: Mutex<JobScopes>,
    _lock: File,
}

impl NasAgent {
    pub fn new(cloud: Arc<CloudRuntime>, data_dir: &Path) -> io::Result<Self> {
        let folder = data_dir.join("nas-agent");
        fs::create_dir_all(&folder)?;
        // 同一安装的两份进程不能共享可写任务日志。
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(folder.join("instance.lock"))?;
        lock.try_lock().map_err(io::Error::other)?;
        Ok(Self {
            cloud,
            policy: Policy::open(&folder)?,
            query_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            folder,
            jobs: Mutex::new(HashMap::new()),
            _lock: lock,
        })
    }

    fn scope(&self) -> Result<(String, Actor)> {
        self.cloud
            .nas_agent_scope()
            .ok_or_else(|| AgentError::new("UNAUTHENTICATED", "请先登录三店 NAS 工作台"))
    }

    fn jobs(&self, endpoint: &str, actor: &Actor) -> Result<Arc<AgentJobs>> {
        let key = scope_key(endpoint, actor);
        let mut scopes = self
            .jobs
            .lock()
            .map_err(|_| AgentError::new("JOBS_LOCK_FAILED", "任务状态锁不可用"))?;
        if let Some(jobs) = scopes.get(&key) {
            return Ok(jobs.clone());
        }
        let jobs = Arc::new(AgentJobs::open_nas(&self.folder.join(&key))?);
        scopes.insert(key, jobs.clone());
        Ok(jobs)
    }

    pub fn ui_jobs(&self, expected: &Value) -> Result<Arc<AgentJobs>> {
        let (endpoint, actor) = self.scope()?;
        if *expected != json!(actor) {
            return Err(AgentError::new(
                "MEMBER_CHANGED",
                "工作台页面与当前成员不匹配",
            ));
        }
        self.jobs(&endpoint, &actor)
    }

    pub fn dispatch(self: &Arc<Self>, instance: &str, request: Request) -> Response {
        // 超慢的 NAS 只读请求不得占满管道的 5 秒时限；最多保留两个尚在退出的请求。
        if matches!(
            request.method.as_str(),
            "sources.find"
                | "sources.get"
                | "activity.list"
                | "configs.find"
                | "configs.get"
                | "status"
                | "shops.list"
                | "jobs.status"
                | "inventory.check"
        ) {
            let Ok(slot) = self.query_slots.clone().try_acquire_owned() else {
                return Response::failure(
                    &request,
                    AgentError::new("QUERY_BUSY", "先前的 NAS 请求仍在收尾，请稍后重试"),
                );
            };
            let (send, recv) = std::sync::mpsc::sync_channel(1);
            let agent = self.clone();
            let name = instance.to_owned();
            let copy = request.clone();
            let work = std::thread::Builder::new()
                .name("workbench-nas-query".into())
                .spawn(move || {
                    let _slot = slot;
                    let _ = send.send(agent.dispatch_inner(&name, copy));
                });
            if work.is_err() {
                return Response::failure(&request, bad_response());
            }
            return recv
                .recv_timeout(Duration::from_millis(4200))
                .unwrap_or_else(|_| {
                    Response::failure(
                        &request,
                        AgentError::new("QUERY_TIMEOUT", "NAS 查询超过时限，请缩小范围或稍后重试"),
                    )
                });
        }
        self.dispatch_inner(instance, request)
    }
    fn dispatch_inner(&self, instance: &str, request: Request) -> Response {
        let started = Instant::now();
        let result = request.validate().and_then(|_| {
            let (endpoint, actor) = self.scope()?;
            let key = scope_key(&endpoint, &actor);
            let method = request.method.as_str();
            let input = &request.params;
            if !access::METHODS.contains(&method) {
                return Err(AgentError::new("METHOD_NOT_FOUND", "不支持此 Agent 方法"));
            }
            let (enabled, flags) = self.policy.get(&key)?;
            let local = access::local_gate(enabled, &flags, method, false);
            if method != "changes.apply" && !crate::agent_jobs::steps::stepped(method) {
                local.clone()?;
            }
            let task = matches!(
                method,
                "jobs.status"
                    | "draft.preview"
                    | "draft.apply"
                    | "sources.preview"
                    | "sources.apply"
                    | "changes.preview"
                    | "changes.apply"
                    | "export.start"
                    | "sync.run"
                    | "inventory.check"
            );
            let jobs = if task {
                Some(self.jobs(&endpoint, &actor)?)
            } else {
                None
            };
            let (target, recover) = if let Some(queue) = &jobs {
                if method == "inventory.check" && input["jobId"].is_string() {
                    (
                        Some(queue.inventory_shop(input["jobId"].as_str().unwrap())?),
                        false,
                    )
                } else {
                    queue
                        .nas_target(method, input)
                        .map_err(|error| local.clone().err().unwrap_or(error))?
                }
            } else {
                (input["shopId"].as_str().map(str::to_owned), false)
            };
            if !recover {
                local?;
            }
            let me = self.cloud.nas_agent_read("/api/v1/me", &actor, None)?;
            let (enabled, flags) = self.policy.get(&key)?;
            gate(
                enabled,
                &flags,
                &me,
                method,
                target.as_deref(),
                recover,
                false,
            )?;
            if !recover && let Some(queue) = &jobs {
                access::source_gate(
                    &flags,
                    &me,
                    target.as_deref(),
                    queue.source_scope(method, input)?.as_ref(),
                    false,
                )?;
            }
            let mut data = if let Some(queue) = jobs {
                if method != "jobs.status" && started.elapsed() >= Duration::from_secs(4) {
                    return Err(AgentError::new("QUERY_TIMEOUT", "权限核对超时，任务未入队"));
                }
                let mut result = queue.dispatch_at(method, input, target.as_deref())?;
                if method == "jobs.status"
                    || (method == "sources.preview" && result["status"] == "succeeded")
                    || (recover && crate::agent_jobs::steps::stepped(method))
                {
                    let job_method = result["method"].as_str().unwrap_or_default();
                    let original_shop =
                        queue.nas_status_shop(result["jobId"].as_str().unwrap_or(""))?;
                    let spec = queue.status_source_scope(result["jobId"].as_str().unwrap_or(""))?;
                    let shop_visible = original_shop
                        .as_deref()
                        .is_some_and(|shop| operating_shops(&me).iter().any(|(id, _)| *id == shop));
                    if !shop_visible
                        || access::source_gate(
                            &flags,
                            &me,
                            original_shop.as_deref(),
                            spec.as_ref(),
                            false,
                        )
                        .is_err()
                        || gate(
                            enabled,
                            &flags,
                            &me,
                            job_method,
                            original_shop.as_deref(),
                            false,
                            false,
                        )
                        .is_err()
                    {
                        // apply 的公开结果已经裁成正式回执元数据，原店仍可见时允许核对已发出的单据。
                        if shop_visible && crate::agent_jobs::steps::stepped(job_method) {
                            // 撤权后仅返回原步骤的编号与状态，不公开预览正文、业务内容或已失去运营权限的店铺。
                            result["result"] =
                                access::visible_step_progress(&result["result"], &me);
                        } else if !(shop_visible && job_method == "changes.apply") {
                            result["result"] = Value::Null;
                        }
                        result["progress"] = Value::Null;
                        if let Some(code) = result["error"]["code"].as_str() {
                            result["error"] = json!({"code":code});
                        }
                    }
                }
                result
            } else if matches!(method, "sources.get" | "sources.find" | "activity.list") {
                self.extended_query(&actor, method, input, &me, flags.read_inventory_activity)?
            } else {
                self.query(instance, &actor, method, input, &me, &key)?
            };
            // 查询飞行期间撤权，不能把按原权限计算的库存或其他结果交还调用方。
            let (now_enabled, now_flags) = self.policy.get(&key)?;
            let permission_changed = enabled != now_enabled || flags != now_flags;
            if (!task || (method == "inventory.check" && input["jobId"].is_string()))
                && permission_changed
            {
                return Err(AgentError::new(
                    "PERMISSION_REVOKED",
                    "读取期间权限已变更，请重新查询",
                ));
            }
            if task && permission_changed {
                data["result"] = Value::Null;
                data["progress"] = Value::Null;
                data["error"] = Value::Null;
            }
            if self.scope()? != (endpoint, actor) {
                return Err(AgentError::new("MEMBER_CHANGED", "工作台成员已变化"));
            }
            Ok(data)
        });
        match result {
            Ok(data) => Response::success(&request, data),
            Err(error) => Response::failure(&request, error),
        }
    }

    fn query(&self, instance: &str, actor: &Actor, method: &str, input: &Value, me:&Value, scope_key:&str) -> Result<Value> {
        let allowed: &[&str] = match method {
            "configs.find" => &[
                "shopId", "goodsId", "sku", "spu", "query", "limit", "offset", "revision",
            ],
            "configs.get" => &["shopId", "configId"],
            _ => &[],
        };
        let args = input
            .as_object()
            .ok_or_else(|| query::invalid("params 必须为对象"))?;
        if args.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(query::invalid("包含未知查询参数"));
        }
        let requested_shop = query::string(args, "shopId")?;
        let id = query::string(args, "configId")?;
        if method == "configs.get" && id.is_none() {
            return Err(query::invalid("configId 为必填参数"));
        }
        let phrase = extended::phrase(args)?;
        let filter = Find {
            goods: query::string(args, "goodsId")?,
            sku: query::string(args, "sku")?,
            spu: query::string(args, "spu")?,
            limit: query::number(args, "limit", 20)? as usize,
            offset: query::number(args, "offset", 0)? as usize,
            revision: args
                .get("revision")
                .map(|_| query::number(args, "revision", 0))
                .transpose()?,
        };
        if !(1..=100).contains(&filter.limit) || (filter.offset > 0 && filter.revision.is_none()) {
            return Err(query::invalid(
                "limit 须为 1 至 100，后续分页须提供 revision",
            ));
        }
        let deadline = Instant::now() + Duration::from_millis(4200);
        let capabilities = operating_shops(me);
        let shops = capabilities.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        if shops.is_empty() || requested_shop.is_some_and(|shop| !shops.contains(&shop)) {
            return Err(AgentError::new(
                "FORBIDDEN",
                "当前账号没有该店铺的 NAS 运营权限",
            ));
        }
        if method == "shops.list" {
            return Ok(
                json!({"shops":shops.iter().map(|id| query::shop(&json!(id))).collect::<Vec<_>>() }),
            );
        }
        if method == "status" {
            let mut data=self.policy_status(scope_key,actor,me)?;
            data["instance"]=json!(instance);data["appVersion"]=json!(env!("CARGO_PKG_VERSION"));
            data["snapshot"]=json!("nasSaved");data["snapshotDescription"]=json!("NAS 正式工作区的已保存配置，不包含本机草稿");
            data["savedOn"]=json!("nas");data["authorization"]=json!("nasOperations");
            data["authentication"]=json!("windowsCurrentUserAndWorkbenchLogin");data["unsavedChanges"]=json!("excluded");
            return Ok(data);
        }
        let scope = requested_shop.map_or(shops, |shop| vec![shop]);
        // 各店目录彼此独立，并发读取，保持固定店铺顺序以稳定计算分页版本。
        let indexes = std::thread::scope(|workers| {
            scope
                .iter()
                .map(|shop| workers.spawn(move || self.index(actor, shop)))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|work| work.join().map_err(|_| bad_response())?)
                .collect::<Result<Vec<_>>>()
        })?;
        let revision = revision_for(
            scope
                .iter()
                .zip(&indexes)
                .map(|(shop, index)| (*shop, index["revision"].as_str().unwrap())),
        );
        if filter.revision.is_some_and(|value| value != revision) {
            return Err(stale());
        }
        if let Some(id) = id {
            let matches = scope
                .iter()
                .zip(&indexes)
                .filter_map(|(shop, index)| {
                    rows(index)
                        .iter()
                        .find(|row| row["id"] == id)
                        .map(|row| (*shop, index, row))
                })
                .collect::<Vec<_>>();
            let (shop, index, row) = match matches.as_slice() {
                [] => return Err(AgentError::new("NOT_FOUND", "未找到已保存配置")),
                [one] => *one,
                _ => {
                    return Err(AgentError::new(
                        "AMBIGUOUS_CONFIG",
                        "多店存在同一配置 ID，请指定 shopId",
                    ));
                }
            };
            let detail = self.detail(actor, shop, row)?;
            let config = &detail["document"];
            let mut projected = nas_config(config, true);
            projected["nasVersion"] = detail["version"].clone();
            return Ok(
                json!({"revision":revision_for([(shop,index["revision"].as_str().unwrap())]),
                "config":projected,"shop":query::shop(&json!(shop)),
                "link":{"id":config["productId"],"name":config["product"],"url":config["productUrl"],"spu":config["spu"]}}),
            );
        }

        let mut count = 0;
        let mut items = Vec::new();
        for (shop, index) in scope.iter().zip(&indexes) {
            let candidates = rows(index)
                .iter()
                .filter(|row| {
                    // 模糊词仅匹配已保存索引中的商品、配置或短名，其他条件仍取交集。
                    phrase.as_ref().is_none_or(|q| ["product", "name", "shortName"].iter().any(|key|
                        row[*key].as_str().is_some_and(|name| name.to_lowercase().contains(q))))
                    && filter
                        .sku
                        .is_none_or(|sku| row["skuId"].as_str() == Some(sku))
                        && filter
                            .spu
                            .is_none_or(|spu| row["spu"].as_str() == Some(spu))
                })
                .collect::<Vec<_>>();
            let usage = if let Some(goods) = filter.goods.filter(|_| !candidates.is_empty()) {
                let data = self.cloud.nas_agent_read(
                    &format!("/api/v1/operations/workspace/source-usage?shop_id={shop}"),
                    actor,
                    Some(&json!({"sources":[],"goods":[goods]})),
                )?;
                Some(
                    data["data"]
                        .as_array()
                        .ok_or_else(bad_response)?
                        .iter()
                        .map(|id| id.as_str().map(str::to_owned).ok_or_else(bad_response))
                        .collect::<Result<HashSet<_>>>()?,
                )
            } else {
                None
            };
            let candidates = candidates
                .into_iter()
                .filter(|row| {
                    usage
                        .as_ref()
                        .is_none_or(|ids| row["id"].as_str().is_some_and(|id| ids.contains(id)))
                })
                .collect::<Vec<_>>();
            for group in candidates.chunks(8) {
                if Instant::now() >= deadline {
                    return Err(AgentError::new(
                        "QUERY_TIMEOUT",
                        "NAS 查询超时，请指定单店或缩小查询范围",
                    ));
                }
                let matches = if let Some(goods) = filter.goods {
                    std::thread::scope(|workers| {
                        group
                            .iter()
                            .map(|row| {
                                workers.spawn(move || -> Result<bool> {
                                    // 通用来源查询涵盖展示和实际配件。展示也命中时以原始实际 BOM 判定。
                                    if !row["parts"].as_array().is_some_and(|parts| {
                                        parts.iter().any(|part| part["goodsId"] == goods)
                                    }) {
                                        return Ok(true);
                                    }
                                    let detail = self.detail(actor, shop, row)?;
                                    Ok(has_goods(&detail["document"], goods))
                                })
                            })
                            .collect::<Vec<_>>()
                            .into_iter()
                            .map(|work| work.join().map_err(|_| bad_response())?)
                            .collect::<Result<Vec<_>>>()
                    })?
                } else {
                    vec![true; group.len()]
                };
                for (row, matched) in group.iter().zip(matches) {
                    if matched {
                        if count >= filter.offset {
                            let mut item = nas_config(row, false);
                            if let Some(version) = row.get("nasVersion") {
                                item["nasVersion"] = version.clone();
                            }
                            items.push(item);
                        }
                        count += 1;
                    }
                }
                if items.len() > filter.limit {
                    break;
                }
            }
            if usage.is_some() && self.index(actor, shop)?["revision"] != index["revision"] {
                return Err(stale());
            }
            if items.len() > filter.limit {
                break;
            }
        }
        let more = items.len() > filter.limit;
        items.truncate(filter.limit);
        Ok(
            json!({"revision":revision,"items":items,"limit":filter.limit,"offset":filter.offset,
            "hasMore":more,"nextOffset":if more { filter.offset.checked_add(filter.limit) } else { None }}),
        )
    }

    fn index(&self, actor: &Actor, shop: &str) -> Result<Value> {
        let mut response = self.cloud.nas_agent_read(
            &format!("/api/v1/operations/workspace-index?shop_id={shop}"),
            actor,
            None,
        )?;
        let index = response["data"].take();
        if !index["revision"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            || index["summaries"].as_array().is_none_or(|rows| {
                rows.iter().any(|r| {
                    r["shopId"] != shop || r["id"].as_str().is_none() || !r["parts"].is_array()
                })
            })
        {
            return Err(bad_response());
        }
        Ok(index)
    }

    fn detail(&self, actor: &Actor, shop: &str, row: &Value) -> Result<Value> {
        let id = row["id"].as_str().ok_or_else(bad_response)?;
        // 使用 URL 段编码，配置 ID 无法更改请求路由或店铺参数。
        if matches!(id, "." | "..") {
            return Err(bad_response());
        }
        let mut url =
            reqwest::Url::parse("https://localhost/api/v1/operations/configurations").unwrap();
        url.path_segments_mut().unwrap().push(id);
        let route = format!("{}?shop_id={shop}", url.path());
        let detail = self.cloud.nas_agent_read(&route, actor, None)?["data"].take();
        if detail["document"]["id"] != id
            || detail["document"]["shopId"] != shop
            || detail["version"].as_str().is_none()
        {
            return Err(bad_response());
        }
        if row
            .get("nasVersion")
            .is_some_and(|version| *version != detail["version"])
        {
            return Err(stale());
        }
        Ok(detail)
    }
}

struct Find<'a> {
    goods: Option<&'a str>,
    sku: Option<&'a str>,
    spu: Option<&'a str>,
    limit: usize,
    offset: usize,
    revision: Option<i64>,
}
fn can_write(capability: &Value) -> bool {
    capability["configuration_writes"] == true && capability["workspace_writes"] == true
}
// 目录与详情使用相同的草稿标识，历史配置缺少这些字段时仍按普通配置展示。
fn nas_config(config: &Value, detail: bool) -> Value {
    let mut value = query::business(config, detail);
    for field in ["productDraft", "emptyLinkDraft"] {
        value[field] = json!(config[field] == true);
    }
    value
}
fn bad_response() -> AgentError {
    AgentError::new("INVALID_API_RESPONSE", "NAS 查询响应不完整")
}
fn stale() -> AgentError {
    AgentError::new(
        "REVISION_CONFLICT",
        "NAS 已保存版本变化，请从第一页重新查询",
    )
}
fn rows(value: &Value) -> &[Value] {
    value["summaries"].as_array().unwrap()
}
fn has_goods(document: &Value, goods: &str) -> bool {
    document["actualParts"]
        .as_array()
        .or_else(|| document["parts"].as_array())
        .is_some_and(|parts| parts.iter().any(|part| part["goodsId"] == goods))
}
fn revision_for<'a>(versions: impl IntoIterator<Item = (&'a str, &'a str)>) -> i64 {
    // 与界面导出共用可精确表示的整数协议。截取 52 位，同时纳入店铺，避免重名配置串店。
    let bytes = Sha256::digest(json!(versions.into_iter().collect::<Vec<_>>()).to_string());
    (u64::from_be_bytes(bytes[..8].try_into().unwrap()) >> 12) as i64
}
