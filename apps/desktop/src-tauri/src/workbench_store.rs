// 完整工作台本机存储：保留旧 JSON 的未知业务字段，统一保存、版本冲突、历史、草稿和文件导出。
//! Offline compatibility store. The captured JSON is imported without domain normalization.
//! This module has no production-source paths, credentials, or network clients.
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;
#[path = "workbench_store/export_session.rs"]
mod export_session;
#[path = "workbench_store/sql_sync.rs"]
mod sql_sync;
#[path = "workbench_store/legacy_history.rs"]
mod legacy_history;
#[path = "workbench_store/profit.rs"]
mod profit;
#[path = "workbench_store/price_changes.rs"]
mod price_changes;
#[path = "workbench_store/cloud_state.rs"]
mod cloud_state;
#[path = "workbench_store/legacy_migration.rs"]
mod legacy_migration;
#[path = "workbench_store/activity.rs"]
mod activity;
#[path = "workbench_store/lazy_workspace.rs"]
mod lazy_workspace;
#[path = "workbench_store/entities.rs"]
mod entities;
#[cfg(test)]
pub(crate) use entities::replace_fixture;
#[path = "workbench_store/cache.rs"]
mod cache;
#[path = "workbench_store/image_cache.rs"]
mod image_cache;
#[path = "workbench_store/upload_assets.rs"]
mod upload_assets;
#[cfg(test)]
#[path = "workbench_store/log_access_tests.rs"]
mod log_access_tests;
#[cfg(test)]
#[path = "workbench_store/edit_sync_tests.rs"]
mod edit_sync_tests;

// Used by the native cloud command; the ordinary local /api routes do not expose it.
// 云检查点仅供专用原生命令使用，普通本机 API 不暴露同步持久队列。
pub fn cloud_checkpoint_load(store: &WorkbenchStore) -> Result<ApiResponse> {
    cloud_state::load(store)
}
// 仅在云身份授权后修复本机旧原图引用；云检查点和待发队列仍由同步引擎管理。
pub fn normalize_upload_references(store: &WorkbenchStore) -> Result<Value> {
    upload_assets::normalize(store)
}
// 委托统一云检查点事务，避免同步队列和工作台正文分开提交。
pub fn cloud_checkpoint_commit(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    cloud_state::commit(store, input)
}
pub fn cloud_checkpoint_status(store: &WorkbenchStore) -> Result<Value> {
    cloud_state::status(store)
}
pub fn cloud_first_use_status(store: &WorkbenchStore) -> Result<Value> {
    cloud_state::first_use_status(store)
}
pub use legacy_migration::PreparedLegacyMigration;
pub fn cloud_prepare_legacy(store: &WorkbenchStore, source: &Path, member: &Value, check_session: impl Fn() -> Result<()>) -> Result<PreparedLegacyMigration> {
    legacy_migration::prepare(store, source, member, check_session)
}
pub fn cloud_apply_legacy(store: &WorkbenchStore, prepared: &PreparedLegacyMigration, payload: &Value, member: &Value, check_session: impl Fn() -> Result<()>) -> Result<Value> {
    legacy_migration::apply(store, prepared, payload, member, check_session)
}
// 新同事只允许把出厂空工作区绑定到已认证成员，已有业务数据须使用明确的接入方案。
pub fn cloud_checkpoint_bind_empty(store: &WorkbenchStore, member: &Value, check_session: impl Fn() -> Result<()>) -> Result<Value> {
    cloud_state::bind_empty(store, member, check_session)
}
pub fn cloud_checkpoint_authorize(store: &WorkbenchStore, member: &Value, request: Option<&Value>) -> Result<()> {
    cloud_state::authorize(store, member, request)
}
pub fn cloud_checkpoint_preview_plan(store: &WorkbenchStore, plan: &Value, member: &Value) -> Result<Value> {
    cloud_state::preview_plan(store, plan, member)
}
pub fn cloud_checkpoint_apply_plan(store: &WorkbenchStore, plan: &Value, member: &Value, raw_plan_hash: &str) -> Result<ApiResponse> {
    cloud_state::apply_plan(store, plan, member, raw_plan_hash)
}
#[allow(unused_imports)] // The independent review host does not register SQL IPC.
pub use sql_sync::{sql_apply, sql_preview, sql_status, sql_validate_source};
// Profiling probes compile away completely outside unit-test builds.
#[cfg(test)]
#[path = "workbench_store/save_profile.rs"]
mod save_profile;
#[cfg(test)]
#[path = "workbench_store/prepared_batch_tests.rs"]
mod prepared_batch_tests;
#[cfg(test)]
#[path = "workbench_store/recovery_tests.rs"]
mod recovery_tests;
macro_rules! profile_start {
    ($timer:ident) => { #[cfg(test)] let $timer = std::time::Instant::now(); };
}
macro_rules! profile_finish {
    ($timer:ident, $name:literal) => { #[cfg(test)] save_profile::record($name, $timer.elapsed()); };
}
macro_rules! profile_expr {
    ($name:literal, $expression:expr) => {{
        #[cfg(test)] let timer = std::time::Instant::now();
        let result = $expression;
        #[cfg(test)] save_profile::record($name, timer.elapsed());
        result
    }};
}
pub const MAX_GENERATED_IMAGE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_UPLOAD_BYTES: usize = 24 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;
fn encoded_size(encoded: &str) -> usize {
    (encoded.len() / 4).saturating_mul(3).saturating_sub(
        encoded
            .as_bytes()
            .iter()
            .rev()
            .take_while(|b| **b == b'=')
            .count(),
    )
}
// 解码前先估算体积，解码后再次检查上限，避免过大 Base64 造成额外内存分配。
fn decode_limited(encoded: &str, maximum: usize) -> Result<Vec<u8>> {
    if encoded.len() > maximum.div_ceil(3).saturating_mul(4) || encoded_size(encoded) > maximum {
        return Err("文件大小超过允许上限".into());
    }
    let raw = STANDARD.decode(encoded).map_err(|_| "文件编码无效")?;
    if raw.len() > maximum {
        return Err("文件大小超过允许上限".into());
    }
    Ok(raw)
}
#[derive(Clone)]
pub struct WorkbenchStore {
    pub path: PathBuf,
    pub assets: PathBuf,
}
#[derive(Serialize, Debug)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}
#[derive(Serialize)]
pub struct AssetResponse {
    pub mime: String,
    pub base64: String,
}
fn response(status: u16, value: Value) -> ApiResponse {
    ApiResponse {
        status,
        body: value.to_string(),
    }
}
fn failure(status: u16, message: &str) -> ApiResponse {
    response(status, json!({"error":message}))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
// 统一打开本机 SQLite 并设置等待策略，所有业务入口使用同一连接约束。
fn db(path: &Path) -> Result<Connection> {
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    Ok(c)
}
// 读取权威工作台 JSON；已归档日志通过独立入口读取。
fn state(c: &Connection) -> Result<Value> {
    profile_start!(read_timer);
    let text: String = c
        .query_row("SELECT document FROM workbench_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    profile_finish!(read_timer, "state_sql_read");
    profile_expr!("state_json_parse", serde_json::from_str(&text).map_err(|e| e.to_string()))
}
fn revision(v: &Value) -> i64 {
    v["revision"].as_i64().unwrap_or(0)
}
// 组合当前活动记录和旧日志归档，仅明确需要完整日志的兼容接口调用。
fn logs(c: &Connection) -> Result<Value> {
    let mut out = Vec::new();
    let mut q = c
        .prepare("SELECT document FROM workbench_activity ORDER BY sequence DESC")
        .map_err(|e| e.to_string())?;
    for item in q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        out.push(
            serde_json::from_str(&item.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        );
    }
    let archived: String = c
        .query_row(
            "SELECT document FROM workbench_log_archive WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let old: Vec<Value> = serde_json::from_str(&archived).map_err(|e| e.to_string())?;
    out.extend(old);
    Ok(Value::Array(out))
}
fn full_state(c: &Connection) -> Result<Value> {
    let mut v = state(c)?;
    v["logs"] = logs(c)?;
    Ok(v)
}
// 返回业务状态时省去大日志集合，避免普通保存和启动重复搬运归档。
fn state_without_logs(c: &Connection) -> Result<Value> {
    let mut value = state(c)?;
    value["logs"] = json!([]);
    Ok(value)
}
// 严格解析日志读取开关，不接受含糊参数导致大归档被意外加载。
fn state_logs_requested(path: &str) -> Result<bool> {
    let url = reqwest::Url::parse(&format!("http://workbench.local{path}"))
        .map_err(|_| "状态查询参数无效")?;
    let mut logs = None;
    for (key, value) in url.query_pairs() {
        if key == "logs" {
            if logs.is_some() {
                return Err("状态日志参数不可重复".into());
            }
            logs = Some(match value.as_ref() {
                "none" => false,
                "all" => true,
                _ => return Err("状态日志参数无效".into()),
            });
        }
    }
    Ok(logs.unwrap_or(true))
}
// 检查状态和配置身份的基础约束，同时不归一化或删除旧业务未知字段。
fn validate(v: &Value) -> Result<()> {
    let configs = v["configs"].as_array().ok_or("配置数据须为数组")?;
    let mut seen = HashSet::new();
    for row in configs {
        let id = row["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("配置 ID 须为非空字符串")?;
        if !seen.insert(id) {
            return Err("配置 ID 重复".into());
        }
        if row
            .get("actualParts")
            .is_some_and(|p| !p.is_array() && !p.is_null())
        {
            return Err("实际配置格式无效".into());
        }
    }
    Ok(())
}
// 仅首次创建时导入源快照并拆出归档；已有主库保持权威，初始化不会覆盖现有配置。
pub fn initialize(path: &Path, source: &Path, assets: &Path) -> Result<WorkbenchStore> {
    fs::create_dir_all(path.parent().ok_or("数据库目录无效")?).map_err(|e| e.to_string())?;
    fs::create_dir_all(assets).map_err(|e| e.to_string())?;
    let mut c = db(path)?;
    entities::check_version(&c)?;
    c.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // 锁定旧库写入后再创建一致性备份，保证备份和本次迁移使用同一已提交版本。
    entities::backup_before_migration(&tx, path)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_state(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_log_archive(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_receipts(operation TEXT PRIMARY KEY,hash TEXT NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_recovery(id TEXT PRIMARY KEY,at TEXT NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_named_versions(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,name TEXT NOT NULL,at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);").map_err(|e|e.to_string())?;
    let populated: bool = tx
        .query_row("SELECT EXISTS(SELECT 1 FROM workbench_state)", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if !populated {
        let raw =
            fs::read_to_string(source).map_err(|e| format!("首次导入需要已捕获的离线快照：{e}"))?;
        let mut imported: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        validate(&imported)?;
        let archive = imported
            .as_object_mut()
            .ok_or("快照须为对象")?
            .remove("logs")
            .unwrap_or(json!([]));
        if !archive.is_array() {
            return Err("历史记录须为数组".into());
        }
        tx.execute(
            "INSERT INTO workbench_log_archive VALUES(1,?1)",
            [archive.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO workbench_state VALUES(1,?1)",
            [imported.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO workbench_history(at,revision,document) VALUES(?1,?2,?3)",params![now(),revision(&imported),json!({"type":"import","sourceHash":format!("{:x}",Sha256::digest(raw.as_bytes())),"configCount":imported["configs"].as_array().unwrap().len(),"logCount":archive.as_array().unwrap().len()}).to_string()]).map_err(|e|e.to_string())?;
    }
    entities::initialize(&tx)?;
    lazy_workspace::initialize_projection(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(WorkbenchStore {
        path: path.into(),
        assets: assets.into(),
    })
}

// JavaScript 会把 227.0 序列化为 227；安全整数范围内两种 JSON 数字表示等价。
// 字符串、缺失/null、数组顺序以及超过 JS 精确范围的大整数仍保持严格比较。
fn same_json(a: &Value, b: &Value) -> bool {
    if a == b { return true; }
    match (a,b) {
        (Value::Number(x),Value::Number(y)) if x.is_f64()!=y.is_f64() => {
            match (x.as_f64(),y.as_f64()) {
                (Some(x),Some(y)) => x==y && x.fract()==0.0 && x.abs()<=9_007_199_254_740_991.0,
                _ => false,
            }
        }
        (Value::Array(x),Value::Array(y)) => x.len()==y.len() && x.iter().zip(y).all(|(x,y)|same_json(x,y)),
        (Value::Object(x),Value::Object(y)) => x.len()==y.len() && x.iter().all(|(k,v)|y.get(k).is_some_and(|other|same_json(v,other))),
        _ => false,
    }
}
fn same_optional_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a,b) {(Some(a),Some(b))=>same_json(a,b),(None,None)=>true,_=>false}
}
// An omitted field outside the submitted baseline belongs to the current document.
// Objects merge by field; arrays are atomic to prevent silently lost ordered business rows.
// 对象按字段三方比较；数组整体处理，缺失字段与显式 null 保持不同语义。
fn merge(
    base: Option<&Value>,
    desired: Option<&Value>,
    current: Option<&Value>,
) -> Result<Option<Value>> {
    if same_optional_json(desired, base) {
        return Ok(current.cloned());
    }
    if same_optional_json(current, base) || same_optional_json(current, desired) {
        return Ok(desired.cloned());
    }
    if let (Some(Value::Object(b)), Some(Value::Object(d)), Some(Value::Object(c))) =
        (base, desired, current)
    {
        let keys: HashSet<_> = b.keys().chain(d.keys()).chain(c.keys()).collect();
        let mut out = serde_json::Map::new();
        for k in keys {
            if let Some(v) = merge(b.get(k), d.get(k), c.get(k))? {
                out.insert(k.clone(), v);
            }
        }
        return Ok(Some(Value::Object(out)));
    }
    Err("同一字段已被修改，当前草稿已保留，请比较后选择保存版本".into())
}
// 旧编辑器用 null 表示跟随共享成本，云物化会省略同一字段。
// 只在配置直系配件行对齐这两个等价表示；数组仍整体比较，真实改价/替换仍冲突。
fn merge_configuration(base: Option<&Value>, desired: Option<&Value>, current: Option<&Value>) -> Result<Option<Value>> {
    if let Ok(value) = merge(base, desired, current) { return Ok(value); }
    let normalize = |value: Option<&Value>| value.map(|value| {
        let mut value = value.clone();
        for field in ["parts", "actualParts"] {
            if let Some(rows) = value.get_mut(field).and_then(Value::as_array_mut) {
                for row in rows {
                    if let Some(row) = row.as_object_mut() {
                        if row.get("taxOverride") == Some(&Value::Null) { row.remove("taxOverride"); }
                    }
                }
            }
        }
        value
    });
    let (b,d,c) = (normalize(base), normalize(desired), normalize(current));
    let merged = merge(b.as_ref(), d.as_ref(), c.as_ref())?;
    if merged == c { Ok(current.cloned()) } else { Ok(merged) }
}
// 配置集合按 ID 三方合并，处理新增、删除和内容冲突时保留并发保存的其他配置。
fn merge_configs(base: &Value, desired: &Value, current: &Value) -> Result<Value> {
    let b = base.as_array().ok_or("基线配置格式无效")?;
    let d = desired.as_array().ok_or("配置格式无效")?;
    let c = current.as_array().ok_or("当前配置格式无效")?;
    fn by_id(rows: &[Value]) -> HashMap<&str, &Value> {
        rows.iter()
            .filter_map(|r| r["id"].as_str().map(|id| (id, r)))
            .collect()
    }
    let bm = by_id(b);
    let cm = by_id(c);
    let dm = by_id(d);
    let mut out = Vec::new();
    for row in d {
        let id = row["id"].as_str().ok_or("配置 ID 无效")?;
        if let Some(v) = merge_configuration(bm.get(id).copied(), Some(row), cm.get(id).copied())? {
            out.push(v);
        }
    }
    // A config absent only from a stale baseline was created elsewhere and must survive.
    for row in c {
        let id = row["id"].as_str().ok_or("配置 ID 无效")?;
        if !dm.contains_key(id)
            && let Some(v) = merge_configuration(bm.get(id).copied(), None, Some(row))?
        {
            out.push(v);
        }
    }
    Ok(Value::Array(out))
}
// 保存足以逆向恢复的差异，记录字段存在性，不能把缺失值误当作 null。
fn delta(before: &Value, after: &Value) -> Value {
    let cfg = config_delta(&before["configs"], &after["configs"]);
    let mut fields = serde_json::Map::new();
    for k in before
        .as_object()
        .unwrap()
        .keys()
        .chain(after.as_object().unwrap().keys())
        .collect::<HashSet<_>>()
    {
        if k != "configs" && before.get(k) != after.get(k) {
            fields.insert(
                k.clone(),
                json!({"before":before.get(k),"beforePresent":before.get(k).is_some(),"after":after.get(k),"afterPresent":after.get(k).is_some()}),
            );
        }
    }
    json!({"configs":cfg,"fields":fields,"orderBefore":before["configs"].as_array().unwrap().iter().map(|c|c["id"].clone()).collect::<Vec<_>>()})
}
// 按配置身份提取前后变化，为逆向历史保存完整变化行。
fn config_delta(before: &Value, after: &Value) -> Vec<Value> {
    let old: HashMap<_, _> = before
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c))
        .collect();
    let new: HashMap<_, _> = after
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c))
        .collect();
    let mut cfg = Vec::new();
    for id in old.keys().chain(new.keys()).collect::<HashSet<_>>() {
        if old.get(id) != new.get(id) {
            cfg.push(json!({"id":id,"before":old.get(id),"after":new.get(id)}));
        }
    }
    cfg
}
// 由完整前后状态生成历史差异后进入共享持久化路径。
fn persist(
    tx: &Transaction,
    before: &Value,
    after: &mut Value,
    input: &Value,
) -> Result<Vec<Value>> {
    profile_start!(history_timer);
    after["revision"] = json!(revision(before) + 1);
    after["updatedAt"] = json!(now());
    let changes = profile_expr!("history_delta", delta(before, after));
    profile_finish!(history_timer, "history_build");
    persist_prepared(tx, after, changes, input)
}
// All save paths share the same history/activity/SQLite write contract. Ordinary
// batches prepare equivalent changes from their validated targets only.
// 同一事务写业务正文、逆向历史和活动记录；上层负责提交，任一失败整体回滚。
fn persist_prepared(
    tx: &Transaction,
    after: &Value,
    changes: Value,
    input: &Value,
) -> Result<Vec<Value>> {
    price_changes::capture(tx, after, &changes, input)?;
    profile_start!(history_timer);
    let mut activity = Vec::new();
    for change in changes["configs"].as_array().unwrap() {
        let record = if change["after"].is_object() {
            &change["after"]
        } else {
            &change["before"]
        };
        activity.push(json!({"id":unique(),"at":after["updatedAt"],"operator":input["operator"].as_str().unwrap_or("本机操作员"),"origin":"local","message":input["message"].as_str().unwrap_or("保存配置"),"summary":record["name"],"target":{"type":"configuration","id":change["id"],"shopId":record["shopId"]}}));
    }
    if activity.is_empty() {
        activity.push(json!({"id":unique(),"at":after["updatedAt"],"operator":input["operator"].as_str().unwrap_or("本机操作员"),"origin":"local","message":input["message"].as_str().unwrap_or("保存工作台"),"summary":"工作台内容已修改"}));
    }
    profile_finish!(history_timer, "history_build");
    profile_start!(state_write_timer);
    entities::replace(&tx, after)?;
    profile_finish!(state_write_timer, "state_serialize_and_sql_update");
    profile_start!(history_write_timer);
    tx.execute(
        "INSERT INTO workbench_history(at,revision,document) VALUES(?1,?2,?3)",
        params![
            after["updatedAt"].as_str(),
            revision(after),
            profile_expr!("history_json_serialize", changes.to_string())
        ],
    )
    .map_err(|e| e.to_string())?;
    for item in &activity {
        tx.execute(
            "INSERT INTO workbench_activity(document) VALUES(?1)",
            [profile_expr!("activity_json_serialize", item.to_string())],
        )
        .map_err(|e| e.to_string())?;
    }
    activity.reverse();
    profile_finish!(history_write_timer, "history_serialize_and_sql_insert");
    Ok(activity)
}
// 批量保存仅携带已核验目标的变化，仍保存原配置顺序及根版本字段的存在性。
fn batch_delta(
    before_revision: Option<Value>,
    before_updated_at: Option<Value>,
    after: &mut Value,
    config_changes: Vec<Value>,
    order_before: Vec<Value>,
    timestamp: String,
) -> Value {
    after["revision"] = json!(before_revision.as_ref().and_then(Value::as_i64).unwrap_or(0) + 1);
    after["updatedAt"] = json!(timestamp);
    let mut fields = serde_json::Map::new();
    for (key, before) in [("revision", before_revision), ("updatedAt", before_updated_at)] {
        if before.as_ref() != after.get(key) {
            fields.insert(key.into(), json!({"before":before,"beforePresent":before.is_some(),"after":after.get(key),"afterPresent":after.get(key).is_some()}));
        }
    }
    json!({"configs":config_changes,"fields":fields,"orderBefore":order_before})
}
struct StateWithLogs<'a> {
    state: &'a Value,
    logs: &'a Value,
}
impl Serialize for StateWithLogs<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let fields = self.state.as_object().ok_or_else(|| {
            <S::Error as serde::ser::Error>::custom("工作台状态须为对象")
        })?;
        let mut map = serializer.serialize_map(Some(
            fields.len() + usize::from(!fields.contains_key("logs")),
        ))?;
        for (key, value) in fields {
            if key != "logs" {
                map.serialize_entry(key, value)?;
            }
        }
        map.serialize_entry("logs", self.logs)?;
        map.end()
    }
}
#[derive(Serialize)]
struct FullSaveReceipt<'a> {
    revision: &'a Value,
    #[serde(rename = "updatedAt")]
    updated_at: &'a Value,
    logs: &'a Value,
    state: StateWithLogs<'a>,
}
// 全量保存要求完整配置和匹配基线；摘要不能写回，以免未加载详情被静默丢弃。
fn save_state(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    profile_start!(total_timer);
    let source = input.as_object().ok_or("保存内容须为对象")?;
    let omit_logs = match input.get("omitLogs") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Ok(failure(400, "omitLogs 须为布尔值")),
    };
    // 按需加载列表不是完整业务状态；必须拒绝用部分配置覆盖整库。
    if input["partialWorkspace"] == true
        || [input.get("configs"), input.get("baseState").and_then(|v| v.get("configs"))]
            .into_iter()
            .flatten()
            .filter_map(Value::as_array)
            .flatten()
            .any(|config| config["__workbenchSummary"] == true)
    {
        return Ok(failure(400, "配置摘要不能通过全量保存接口写入，请先加载完整配置"));
    }
    profile_start!(open_timer);
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    profile_finish!(open_timer, "db_open_transaction");
    let mut after = state(&tx)?;
    if input["baseRevision"].as_i64() != Some(revision(&after)) {
        return Ok(failure(409, "其他页面已经保存更新，请比较最新版本后重试"));
    }
    profile_start!(merge_timer);
    let before_revision = after.get("revision").cloned();
    let before_updated_at = after.get("updatedAt").cloned();
    let order_before = after["configs"].as_array().ok_or("当前配置格式无效")?
        .iter().map(|config| config["id"].clone()).collect();
    let mut config_changes = Vec::new();
    let mut fields = serde_json::Map::new();
    let mut changed = false;
    for (k, v) in source {
        if [
            "baseRevision",
            "baseState",
            "operator",
            "message",
            "logs",
            "omitLogs",
            "partialWorkspace",
            "revision",
            "updatedAt",
        ]
        .contains(&k.as_str())
        {
            continue;
        }
        let current = after.get(k);
        if current == Some(v) {
            continue;
        }
        let merged = if k == "configs" {
            match input.get("baseState").and_then(|b| b.get(k)) {
                Some(base) => merge_configs(base, v, &after[k])?,
                None => merge_configs(&after[k], v, &after[k])?,
            }
        } else {
            merge(
                input
                    .get("baseState")
                    .and_then(|b| b.get(k))
                    .or(current),
                Some(v),
                current,
            )?
            .unwrap_or(Value::Null)
        };
        if current != Some(&merged) {
            if k == "configs" {
                config_changes = config_delta(&after[k], &merged);
            } else {
                fields.insert(k.clone(), json!({"before":current,"beforePresent":current.is_some(),"after":merged,"afterPresent":true}));
            }
            after[k] = merged;
            changed = true;
        }
    }
    profile_expr!("state_validate", validate(&after))?;
    profile_finish!(merge_timer, "clone_merge_validate_compare");
    if changed {
        profile_start!(history_timer);
        let mut changes = profile_expr!("history_delta", batch_delta(before_revision, before_updated_at, &mut after, config_changes, order_before, now()));
        changes["fields"].as_object_mut().unwrap().extend(fields);
        profile_finish!(history_timer, "history_build");
        persist_prepared(&tx, &after, changes, input)?;
    }
    let receipt_logs = if omit_logs { json!([]) } else {
        profile_expr!("full_logs_read_parse_build", logs(&tx))?
    };
    profile_start!(receipt_timer);
    let receipt = FullSaveReceipt {
        revision: &after["revision"],
        updated_at: &after["updatedAt"],
        logs: &receipt_logs,
        state: StateWithLogs { state: &after, logs: &receipt_logs },
    };
    profile_finish!(receipt_timer, "full_receipt_build");
    let body = profile_expr!("response_json_serialize_and_value_drop", serde_json::to_string(&receipt).map_err(|e| e.to_string()))?;
    profile_start!(commit_timer);
    tx.commit().map_err(|e| e.to_string())?;
    profile_finish!(commit_timer, "sqlite_commit");
    let result = ApiResponse { status: 200, body };
    profile_finish!(total_timer, "save_state_total_before_drop");
    Ok(result)
}
// Keep this explicit presentation contract in sync with batch-save.js. Changes
// contain full base/after rows, so unchanged legacy/unknown fields are permitted
// and preserved by the three-way merge; unknown changes must still be rejected.
const ORDINARY_PRESENTATION_FIELDS: &[&str] = &[
    "shop",
    "layout",
    "skuMode",
    "posterDesignVersion",
    "previousSquareLayout",
    "autoWidth",
    "theme",
    "productTheme",
    "palette",
    "themePalettes",
    "fontFamily",
    "modules",
    "textStyles",
    "skuTextStyles",
    "textTransforms",
    "moduleTransforms",
    "freeCanvasLayouts",
    "caseImage",
    "caseVisible",
    "caseTransforms",
    "posterImages",
    "showUpgrades",
    "showWarranty",
    "upgradeColor",
    "upgradeSize",
    "upgradeWeight",
    "posterFields",
    "posterSubtitle",
    "footer",
];
// 验证批量目标与操作身份，再执行三方合并；同一请求重试返回已有回执。
fn save_batch(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    profile_start!(total_timer);
    profile_start!(input_timer);
    let operation = input["operationId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .ok_or("批量操作 ID 无效")?;
    let hash = format!("{:x}", Sha256::digest(input.to_string().as_bytes()));
    profile_finish!(input_timer, "input_hash");
    profile_start!(open_timer);
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    profile_finish!(open_timer, "db_open_transaction");
    let before = state(&tx)?;
    profile_start!(merge_timer);
    let replay: Option<(String, String)> = tx
        .query_row(
            "SELECT hash,document FROM workbench_receipts WHERE operation=?1",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((old, raw)) = replay {
        if old != hash {
            return Ok(failure(409, "批量操作 ID 已用于其他内容"));
        }
        let mut receipt: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if receipt["revision"] != before["revision"] {
            receipt["rebased"] = json!(true);
        }
        return Ok(response(200, receipt));
    }
    let rows = input["changes"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 1000)
        .ok_or("批量配置数量无效，最多 1000 套")?;
    let ordinary = match input.get("mode").and_then(Value::as_str) {
        None => false,
        Some("ordinary") => true,
        _ => return Ok(failure(400, "配置增量模式无效")),
    };
    let mut allowed: HashSet<&str> = [
        "parts",
        "actualParts",
        "addons",
        "shortName",
        "emptyLinkDraft",
    ]
    .into_iter()
    .collect();
    if ordinary {
        allowed.extend([
            "name",
            "version",
            "price",
            "installment",
            "nameFormat",
            "shortNameAuto",
        ]);
        allowed.extend(ORDINARY_PRESENTATION_FIELDS.iter().copied());
    }
    let base_revision = input["baseRevision"]
        .as_i64()
        .filter(|r| *r >= 0)
        .ok_or("批量基线版本无效")?;
    if base_revision > revision(&before) {
        return Ok(failure(409, "批量基线版本无效"));
    }
    let rebased = base_revision != revision(&before);
    let before_revision = before.get("revision").cloned();
    let before_updated_at = before.get("updatedAt").cloned();
    let order_before = before["configs"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect();
    let mut after = before;
    let configs = after["configs"].as_array_mut().unwrap();
    let mut seen = HashSet::new();
    let mut saved = Vec::new();
    let mut config_changes = Vec::new();
    for change in rows {
        let id = change["id"].as_str().ok_or("批量配置 ID 无效")?;
        if !seen.insert(id) {
            return Ok(failure(400, "批量配置 ID 重复"));
        }
        let Some(current) = configs.iter_mut().find(|c| {
            c["id"].as_str() == Some(id)
                && c.get("deletedAt").is_none_or(|v| v.is_null() || v == "")
        }) else {
            return Ok(failure(409, "目标配置已删除或不存在"));
        };
        let base = &change["base"];
        let desired = &change["after"];
        if !base.is_object() || !desired.is_object() || base["id"] != id || desired["id"] != id {
            return Ok(failure(400, "批量配置基线或结果无效"));
        }
        if base
            .as_object()
            .unwrap()
            .keys()
            .chain(desired.as_object().unwrap().keys())
            .any(|k| !allowed.contains(k.as_str()) && base.get(k) != desired.get(k))
        {
            return Ok(failure(400, "配置增量接口包含超出允许范围的修改"));
        }
        if !rebased && !same_json(base, current) {
            return Ok(failure(409, "配置基线与当前版本不一致"));
        }
        if base["shopId"] != desired["shopId"]
            || base["productId"] != desired["productId"]
            || base["shopId"] != current["shopId"]
            || base["productId"] != current["productId"]
            || desired
                .get("deletedAt")
                .is_some_and(|v| !v.is_null() && v != "")
        {
            return Ok(failure(409, "批量操作不可删除或移动配置"));
        }
        match merge_configuration(Some(base), Some(desired), Some(current)) {
            Ok(Some(merged)) => {
                if profile_expr!("target_equality_compare", &merged != current) {
                    config_changes.push(json!({"id":id,"before":current,"after":merged}));
                }
                *current = merged;
                saved.push(current.clone());
            }
            _ => return Ok(failure(409, "同一字段已被修改，请重新预览")),
        }
    }
    profile_expr!("state_validate", validate(&after))?;
    let unchanged = config_changes.is_empty();
    profile_finish!(merge_timer, "clone_merge_validate_compare");
    let activity = if unchanged {
        Vec::new()
    } else {
        profile_start!(history_timer);
        let changes = profile_expr!("history_delta", batch_delta(before_revision, before_updated_at, &mut after, config_changes, order_before, now()));
        profile_finish!(history_timer, "history_build");
        persist_prepared(&tx, &after, changes, input)?
    };
    profile_start!(receipt_timer);
    let receipt = json!({"operationId":operation,"revision":after["revision"],"updatedAt":after["updatedAt"],"configs":saved,"activityDelta":activity,"rebased":rebased,"unchanged":unchanged});
    tx.execute(
        "INSERT INTO workbench_receipts VALUES(?1,?2,?3)",
        params![operation, hash, profile_expr!("receipt_json_serialize", receipt.to_string())],
    )
    .map_err(|e| e.to_string())?;
    profile_finish!(receipt_timer, "receipt_build_serialize_sql_insert");
    profile_start!(commit_timer);
    tx.commit().map_err(|e| e.to_string())?;
    profile_finish!(commit_timer, "sqlite_commit");
    let result = profile_expr!("response_json_serialize_and_value_drop", response(200, receipt));
    profile_finish!(total_timer, "save_batch_total_before_drop");
    Ok(result)
}
// 仅新建文件并同步写入，拒绝覆盖现有文件，供草稿、原图和导出共用。
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}
// 区分原图上传与生成图登记，验证格式、大小及版本后再写入受限素材目录。
fn save_image(store: &WorkbenchStore, endpoint: &str, input: &Value) -> Result<ApiResponse> {
    let raw = decode_limited(
        input[if endpoint == "/api/image" {
            "png"
        } else {
            "base64"
        }]
        .as_str()
        .ok_or("图片编码无效")?,
        if endpoint == "/api/image" {
            MAX_GENERATED_IMAGE_BYTES
        } else {
            MAX_UPLOAD_BYTES
        },
    )?;
    let png = raw.starts_with(b"\x89PNG\r\n\x1a\n");
    let jpeg = raw.starts_with(b"\xff\xd8\xff");
    if !png && !jpeg {
        return Ok(failure(400, "请选择 PNG 或 JPG 图片"));
    }
    let mut receipt = json!({});
    // Keep the read transaction alive until the image is fully written, so a concurrent save
    // cannot validate one revision and then publish a different revision's image.
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if endpoint == "/api/image" {
        let valid: bool = tx.query_row("SELECT json_extract(document,'$.revision')=?1 AND EXISTS(SELECT 1 FROM workbench_configs WHERE id=?2) FROM workbench_metadata WHERE id=1",
            params![input["revision"].as_i64(), input["id"].as_str()], |r| r.get::<_, Option<bool>>(0))
            .map_err(|e| e.to_string())?.unwrap_or(false);
        if !valid {
            return Ok(failure(409, "配置版本已变化，请重新生成图片"));
        }
        if !png
            || raw.len() < 24
            || !matches!(input["layout"].as_str(), Some("long" | "square"))
            || !matches!(input["theme"].as_str(), Some("light" | "dark"))
        {
            return Ok(failure(400, "图片或版式无效"));
        }
        receipt["revision"] = input["revision"].clone();
        receipt["width"] = json!(u32::from_be_bytes(raw[16..20].try_into().unwrap()));
        receipt["height"] = json!(u32::from_be_bytes(raw[20..24].try_into().unwrap()));
        receipt["url"] = json!(image_cache::save(&tx, store, input, &raw, chrono::Utc::now().timestamp())?);
    } else {
        receipt["url"] = json!(upload_assets::save(store, &raw)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(200, receipt))
}
fn version_sequence(c: &Connection, id: &str) -> Result<i64> {
    if let Some(raw) = id.strip_prefix("v-") {
        let seq = raw.parse::<i64>().map_err(|_| "历史版本 ID 无效")?;
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workbench_history WHERE sequence=?1)",
                [seq],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            return Ok(seq);
        }
    }
    c.query_row(
        "SELECT sequence FROM workbench_named_versions WHERE id=?1 AND deleted=0",
        [id],
        |r| r.get(0),
    )
    .map_err(|_| "历史版本不存在".into())
}
// 从当前状态沿逆向历史重建目标版本，不把历史内容直接覆盖回主库。
fn reconstruct(c: &Connection, sequence: i64) -> Result<Value> {
    let mut snapshot = state(c)?;
    let mut query = c
        .prepare("SELECT document FROM workbench_history WHERE sequence>?1 ORDER BY sequence DESC")
        .map_err(|e| e.to_string())?;
    for record in query
        .query_map([sequence], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let change: Value =
            serde_json::from_str(&record.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        for row in change["configs"].as_array().ok_or("历史配置差异无效")? {
            let configs = snapshot["configs"].as_array_mut().unwrap();
            let position = configs.iter().position(|c| c["id"] == row["id"]);
            if row["before"].is_null() {
                if let Some(i) = position {
                    configs.remove(i);
                }
            } else if let Some(i) = position {
                configs[i] = row["before"].clone();
            } else {
                configs.push(row["before"].clone());
            }
        }
        if let Some(order) = change["orderBefore"].as_array() {
            let positions: HashMap<_, _> = order
                .iter()
                .enumerate()
                .filter_map(|(i, id)| id.as_str().map(|id| (id, i)))
                .collect();
            snapshot["configs"]
                .as_array_mut()
                .unwrap()
                .sort_by_key(|c| {
                    positions
                        .get(c["id"].as_str().unwrap())
                        .copied()
                        .unwrap_or(usize::MAX)
                });
        }
        for (key, field) in change["fields"].as_object().ok_or("历史字段差异无效")? {
            if field["beforePresent"] == false {
                snapshot.as_object_mut().unwrap().remove(key);
            } else {
                snapshot[key] = field["before"].clone();
            }
        }
    }
    validate(&snapshot)?;
    Ok(snapshot)
}
// 计算目标历史内容及差异供确认，真正恢复时仍需再次检查当前版本。
fn version_preview(c: &Connection, input: &Value) -> Result<Value> {
    let id = input["id"].as_str().ok_or("历史版本 ID 无效")?;
    let target = reconstruct(c, version_sequence(c, id)?)?;
    let current = state(c)?;
    let raw = target.to_string();
    let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let differences = delta(&current, &target);
    let mut changes = Vec::new();
    for change in differences["configs"].as_array().unwrap() {
        let record = if change["after"].is_object() {
            &change["after"]
        } else {
            &change["before"]
        };
        changes.push(json!({"type":"配置","name":record["name"].as_str().unwrap_or("未命名"),"id":change["id"],"before":change["before"],"after":change["after"]}));
    }
    for (key, field) in differences["fields"].as_object().unwrap() {
        if key != "revision" && key != "updatedAt" {
            changes.push(json!({"type":"工作台设置","name":key,"before":field["before"],"after":field["after"]}));
        }
    }
    Ok(
        json!({"id":id,"revision":target["revision"],"baseRevision":current["revision"],"hash":hash,"changes":changes}),
    )
}
// 处理历史列表、标记、预览和还原；还原须以当前基线执行新的保存事务。
fn versions(
    store: &WorkbenchStore,
    method: &str,
    path: &str,
    input: &Value,
) -> Result<ApiResponse> {
    let mut c = db(&store.path)?;
    match (method, path) {
        ("GET", "/api/versions") => {
            let mut query = c
                .prepare(
                    "SELECT sequence,at,revision FROM workbench_history ORDER BY sequence DESC",
                )
                .map_err(|e| e.to_string())?;
            let mut items = Vec::new();
            for item in query
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?
            {
                let (seq, at, rev) = item.map_err(|e| e.to_string())?;
                items.push(json!({"id":format!("v-{seq}"),"at":at,"revision":rev,"reason":if seq==1{"首次导入离线快照"}else{"本机事务保存"},"pinned":false}));
            }
            let mut query=c.prepare("SELECT n.id,n.name,n.at,h.revision FROM workbench_named_versions n JOIN workbench_history h ON h.sequence=n.sequence WHERE n.deleted=0 ORDER BY n.at DESC").map_err(|e|e.to_string())?;
            for item in query
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
            {
                let (id, name, at, rev) = item.map_err(|e| e.to_string())?;
                items.insert(0,json!({"id":id,"name":name,"at":at,"revision":rev,"reason":"命名恢复点","pinned":true}));
            }
            Ok(response(200, json!({"versions":items})))
        }
        ("GET", "/api/versions/status") => {
            let count: i64 = c
                .query_row("SELECT COUNT(*) FROM workbench_history", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let named: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM workbench_named_versions WHERE deleted=0",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let live: i64 = c
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(document)),0) FROM workbench_history",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let bytes = fs::metadata(&store.path).map(|m| m.len()).unwrap_or(0);
            let wal = fs::metadata(format!("{}-wal", store.path.display()))
                .map(|m| m.len())
                .unwrap_or(0);
            Ok(response(
                200,
                json!({"count":count,"named":named,"bytes":bytes,"liveBytes":live,"walBytes":wal,"reusableBytes":0,"limit":null,"lastCleanup":null,"pending":false,"error":null,"automaticCleanup":false,"cleanupAvailable":false}),
            ))
        }
        ("POST", "/api/versions/name") => {
            let name = input["name"]
                .as_str()
                .filter(|n| !n.trim().is_empty() && n.chars().count() <= 80)
                .ok_or("请填写 1 至 80 字的版本名称")?;
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let seq: i64 = tx
                .query_row("SELECT MAX(sequence) FROM workbench_history", [], |r| {
                    r.get(0)
                })
                .map_err(|e| e.to_string())?;
            let id = format!("named-{}", unique());
            tx.execute(
                "INSERT INTO workbench_named_versions(id,sequence,name,at) VALUES(?1,?2,?3,?4)",
                params![id, seq, name, now()],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(response(200, json!({"id":id})))
        }
        ("POST", "/api/versions/delete-named") => {
            let id = input["id"].as_str().ok_or("命名版本 ID 无效")?;
            let changed = c
                .execute(
                    "UPDATE workbench_named_versions SET deleted=1 WHERE id=?1 AND deleted=0",
                    [id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Ok(failure(404, "命名版本不存在"));
            }
            Ok(response(200, json!({"ok":true,"retainedHistory":true})))
        }
        ("POST", "/api/versions/preview") => Ok(response(200, version_preview(&c, input)?)),
        ("POST", "/api/versions/restore") => {
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let preview = version_preview(&tx, input)?;
            if input["baseRevision"] != preview["baseRevision"] || input["hash"] != preview["hash"]
            {
                return Ok(failure(409, "当前数据或历史版本已变化，请重新预览"));
            }
            let id = input["id"].as_str().unwrap();
            let mut target = reconstruct(&tx, version_sequence(&tx, id)?)?;
            let before = state(&tx)?;
            persist(
                &tx,
                &before,
                &mut target,
                &json!({"operator":"本机操作员","message":"还原历史版本"}),
            )?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(response(200, json!({"revision":target["revision"]})))
        }
        _ => Ok(failure(503, "历史清理尚未实现；现有恢复记录完整保留")),
    }
}
// 真实配件税价目录只来自当前安装的数据目录，不能编入可公开的程序资源。
fn local_catalog(store: &WorkbenchStore) -> Result<ApiResponse> {
    use std::io::Read;
    let root = store.path.parent().ok_or("本机数据目录不可用")?;
    let path = root.join("catalog.json");
    if !path.exists() { return Ok(response(200, json!([]))); }
    let base = root.canonicalize().map_err(|_| "本机目录不可用")?;
    let resolved = path.canonicalize().map_err(|_| "配件目录不可读")?;
    if !resolved.starts_with(&base) { return Err("配件目录不能指向数据目录以外".into()); }
    let mut bytes = Vec::new();
    fs::File::open(resolved).map_err(|_| "配件目录不可读")?.take(10 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes).map_err(|_| "配件目录读取失败")?;
    if bytes.len() > 10 * 1024 * 1024 { return Err("配件目录超过大小限制".into()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "配件目录格式无效")?;
    if !value.is_array() { return Err("配件目录必须为列表".into()); }
    Ok(response(200, value))
}

// 集中映射兼容 API 并返回明确状态码；未接入接口直接拒绝，不隐式执行在线动作。
pub fn request(
    store: &WorkbenchStore,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<ApiResponse> {
    profile_start!(parse_timer);
    let input: Value = match body {
        Some(s) => match serde_json::from_str(s) {
            Ok(v) => v,
            Err(_) => return Ok(failure(400, "JSON 格式无效")),
        },
        None => json!({}),
    };
    profile_finish!(parse_timer, "request_json_parse");
    let endpoint = path.split('?').next().unwrap_or(path);
    if method == "POST" && endpoint.starts_with("/api/price-changes/") {
        return price_changes::request(store, endpoint.trim_start_matches("/api/price-changes/"), &input).or_else(|error| Ok(failure(400, &error)));
    }
    if endpoint.starts_with("/api/legacy-history/") {
        return legacy_history::request(store, method, endpoint, &input)
            .or_else(|error| Ok(failure(400, &error)));
    }
    if endpoint == "/api/versions" || endpoint.starts_with("/api/versions/") {
        return versions(store, method, endpoint, &input).or_else(|error| Ok(failure(400, &error)));
    }
    let result = match (method, endpoint) {
        ("GET", "/api/catalog") => local_catalog(store),
        ("POST", "/api/profit/start") => profit::profit_start(store, &input),
        ("POST", "/api/profit/status") => profit::profit_status(store, &input),
        ("POST", "/api/profit/history") => profit::profit_history(store, &input),
        ("POST", "/api/profit/reset") => profit::profit_reset(store, &input),
        ("GET", "/api/state") => state_logs_requested(path).and_then(|include_logs| {
            let c = db(&store.path)?;
            Ok(response(200, if include_logs { full_state(&c)? } else { state_without_logs(&c)? }))
        }),
        ("GET", "/api/activity") => activity::request(store, path),
        ("GET", "/api/cache/preview") => cache::preview(store),
        ("POST", "/api/cache/clear") => cache::clear(store, &input),
        ("POST", "/api/cache/maintain") => cache::maintain(store, &input),
        ("GET", "/api/workspace/index") => lazy_workspace::index(store),
        ("POST", "/api/configs/load") => lazy_workspace::load(store, &input),
        ("POST", "/api/configs/patch") => lazy_workspace::save_patch(store, &input),
        ("POST", "/api/state") => save_state(store, &input),
        ("POST", "/api/configs/batch") => save_batch(store, &input),
        ("GET", "/api/session") => Ok(response(
            200,
            json!({"id":"offline-local","defaultOperator":"本机操作员","mode":"offline"}),
        )),
        ("GET", "/api/derived/status") => {
            let c = db(&store.path)?;
            let raw: Option<String> = c.query_row("SELECT revision FROM workbench_state_header WHERE id=1", [], |row| row.get(0)).map_err(|e|e.to_string())?;
            let current: Value = serde_json::from_str(raw.as_deref().unwrap_or("null")).map_err(|e|e.to_string())?;
            Ok(response(
                200,
                json!({"phase":"ready","requestedRevision":current,"completedRevision":current,"offline":true,"scope":"local-state","productFiles":false,"error":null}),
            ))
        }
        ("POST", "/api/image" | "/api/asset") => save_image(store, endpoint, &input),
        ("POST", "/api/recovery-draft") => {
            if !input["state"].is_object() {
                return Ok(failure(400, "恢复草稿格式无效"));
            }
            validate(&input["state"])?;
            let id = unique();
            let file = store
                .path
                .parent()
                .unwrap()
                .join("workbench-recovery")
                .join(format!("draft-{id}.json"));
            let raw = input.to_string();
            // 先持久写出可独立找回的草稿文件，再登记数据库；登记失败也保留恢复文件。
            write_new(&file, input["state"].to_string().as_bytes())?;
            let c = db(&store.path)?;
            c.execute(
                "INSERT INTO workbench_recovery VALUES(?1,?2,?3)",
                params![id, now(), raw],
            )
            .map_err(|e| e.to_string())?;
            Ok(response(200, json!({"ok":true,"file":file,"id":id})))
        }
        _ => Ok(failure(
            503,
            "此离线重构版尚未实现该接口；未执行在线或生产操作",
        )),
    };
    match result {
        Ok(r) => Ok(r),
        Err(e) => Ok(failure(
            if e.starts_with("同一字段已被修改") {
                409
            } else {
                400
            },
            &e,
        )),
    }
}
#[tauri::command]
// 将 SQLite 和文件操作放入阻塞任务，避免长保存直接占用异步界面调度。
pub async fn workbench_request(
    method: String,
    path: String,
    body: Option<String>,
    store: tauri::State<'_, WorkbenchStore>,
) -> Result<ApiResponse> {
    let local = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request(&local, &method, &path, body.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
// 规范化后验证文件仍位于允许根目录，并按 MIME 与体积限制返回图片字节。
pub fn read_asset(store: &WorkbenchStore, path: &str) -> Result<AssetResponse> {
    let relative = Path::new(path.trim_start_matches('/'));
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("图片路径不可访问".into());
    }
    let root = if path.trim_start_matches('/').starts_with("assets/") {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/workbench")
    } else {
        store.assets.clone()
    };
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let file = base
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !file.starts_with(&base) {
        return Err("图片路径越界".into());
    }
    let mime = match file
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        _ => return Err("文件类型不可访问".into()),
    };
    let maximum = if path.trim_start_matches('/').starts_with("uploads/") {
        MAX_UPLOAD_BYTES
    } else {
        MAX_GENERATED_IMAGE_BYTES
    };
    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > maximum as u64 {
        return Err("文件大小超过允许上限".into());
    }
    let raw = fs::read(file).map_err(|e| e.to_string())?;
    if raw.len() > maximum {
        return Err("文件大小超过允许上限".into());
    }
    Ok(AssetResponse {
        mime: mime.into(),
        base64: STANDARD.encode(raw),
    })
}
#[tauri::command]
pub async fn workbench_read_asset(
    path: String,
    store: tauri::State<'_, WorkbenchStore>,
) -> Result<AssetResponse> {
    let local = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || read_asset(&local, &path))
        .await
        .map_err(|e| e.to_string())?
}
// 先校验全部文件名和总体积，再新建独立导出目录，避免覆盖用户已有文件。
// 只接受 Windows 普通文件名，禁止设备名、尾随点空格和路径穿越。
fn export_segment_valid(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty()
        && name.encode_utf16().count() <= 160
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

// 独占创建建议文件夹，遇同名只加序号，保留用户以前导出的所有图片。
fn create_export_folder(directory: &Path, name: &str) -> Result<PathBuf> {
    for index in 1..=1000 {
        let candidate = directory.join(if index == 1 {
            name.to_owned()
        } else {
            format!("{name}_{index}")
        });
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("同名导出目录过多，请选择其他目录".into())
}

fn export_files(payload: &Value, directory: &Path) -> Result<Value> {
    let rows = payload["files"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 3000)
        .ok_or("导出文件列表无效")?;
    let mut files = Vec::new();
    let mut names = HashSet::new();
    let mut estimated = 0usize;
    for row in rows {
        let encoded = row["base64"].as_str().ok_or("导出文件编码无效")?;
        if encoded.len() > MAX_GENERATED_IMAGE_BYTES.div_ceil(3) * 4
            || encoded_size(encoded) > MAX_GENERATED_IMAGE_BYTES
        {
            return Err("单个导出文件超过 128 MiB".into());
        }
        estimated = estimated
            .checked_add(encoded_size(encoded))
            .ok_or("导出文件总大小无效")?;
        if estimated > MAX_EXPORT_BYTES {
            return Err("导出文件总大小超过 512 MiB".into());
        }
    }
    let mut total = 0usize;
    for row in rows {
        let name = row["name"].as_str().ok_or("导出文件名无效")?;
        // 前端可传普通文件或“链接名称_图种/文件”，不接受更多层级或绝对路径。
        let segments = name.split('/').collect::<Vec<_>>();
        if segments.len() > 2
            || !segments.iter().all(|segment| export_segment_valid(segment))
            || !names.insert(name.to_lowercase())
        {
            return Err("导出文件名重复或包含路径".into());
        }
        let raw = decode_limited(
            row["base64"].as_str().ok_or("导出文件编码无效")?,
            MAX_GENERATED_IMAGE_BYTES,
        )?;
        total = total.checked_add(raw.len()).ok_or("导出文件总大小无效")?;
        if total > MAX_EXPORT_BYTES {
            return Err("导出文件总大小超过 512 MiB".into());
        }
        files.push((name.to_owned(), raw));
    }
    // 写入前检查文件与目录同名，避免写了一半才发现结构冲突。
    for (name, _) in &files {
        if let Some((parent, _)) = name.split_once('/')
            && names.contains(&parent.to_lowercase())
        {
            return Err("导出目录与文件同名".into());
        }
    }
    let fallback = format!("DIY配置导出-{}", unique());
    let suggested = payload["name"].as_str().unwrap_or(&fallback);
    if !export_segment_valid(suggested) {
        return Err("导出文件夹名称无效".into());
    }
    let folder = create_export_folder(directory, suggested)?;
    write_export_files(&folder, &files, write_new)
}

// 文件夹导出可能部分成功；返回确切落盘清单，让任务中心只重试未完成文件。
fn write_export_files(folder: &Path, files: &[(String, Vec<u8>)], mut write: impl FnMut(&Path, &[u8]) -> Result<()>) -> Result<Value> {
    let mut created = HashSet::new();
    let mut saved = Vec::new();
    for (index, (name, raw)) in files.iter().enumerate() {
        let result = (|| {
            if let Some((parent, _)) = name.split_once('/')
                && created.insert(parent.to_lowercase())
            {
                // 父目录来自本次独占创建的空目录，拒绝接管已经存在的链接或目录。
                fs::create_dir(folder.join(parent)).map_err(|e| e.to_string())?;
            }
            write(&folder.join(name), raw)
        })();
        if let Err(error) = result {
            return Ok(json!({"ok":false,"cancelled":false,"directory":folder,"files":saved,"failedFiles":files[index..].iter().map(|(name,_)|name).collect::<Vec<_>>(),"error":error}));
        }
        saved.push(name);
    }
    Ok(
        json!({"ok":true,"cancelled":false,"directory":folder,"count":files.iter().filter(|(name,_)|matches!(Path::new(name).extension().and_then(|s|s.to_str()).map(str::to_lowercase).as_deref(),Some("png"|"jpg"|"jpeg"|"webp"|"gif"|"bmp"|"svg"|"tiff"))).count(),"files":files.iter().map(|(name,_)|name).collect::<Vec<_>>()}),
    )
}
#[tauri::command]
// 等待用户选定导出父目录；取消时不写文件，确定后后台生成独立文件夹。
pub async fn workbench_export_folder(payload: Value) -> Result<Value> {
    if let Some(phase) = payload["phase"].as_str() {
        if phase != "begin" {
            return tauri::async_runtime::spawn_blocking(move || export_session::dispatch(&payload))
                .await.map_err(|e| e.to_string())?;
        }
    }
    let chosen = rfd::AsyncFileDialog::new()
        .set_title("选择导出目录（将在其中新建独立文件夹）")
        .pick_folder()
        .await;
    let Some(chosen) = chosen else {
        return Ok(json!({"ok":false,"cancelled":true}));
    };
    let directory = chosen.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        if payload["phase"] == "begin" { export_session::begin(&payload, &directory) }
        else { export_files(&payload, &directory) }
    })
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_export_reports_only_confirmed_files() {
        // 合成写入故障验证实际交付边界，不需要操作用户目录或打开文件对话框。
        let files=vec![("first.png".into(),vec![1]),("second.png".into(),vec![2]),("third.png".into(),vec![3])];
        let mut attempts=0;
        let result=write_export_files(Path::new("isolated-export"),&files,|_,_|{attempts+=1;if attempts==2{Err("模拟磁盘故障".into())}else{Ok(())}}).unwrap();
        assert_eq!(result["ok"],false);
        assert_eq!(result["files"],json!(["first.png"]));
        assert_eq!(result["failedFiles"],json!(["second.png","third.png"]));
        assert_eq!(attempts,2);
    }
    #[test]
    fn publication_catalog_stays_local_and_missing_catalog_is_empty() {
        // 合成目录保留在隔离测试区供统一回收，不接触任何安装数据。
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/github-release-20261014/catalog-tests").join(unique());
        fs::create_dir_all(&root).unwrap();
        let store = WorkbenchStore { path: root.join("workbench.sqlite"), assets: root.join("assets") };
        assert_eq!(local_catalog(&store).unwrap().body, "[]");
        fs::write(root.join("catalog.json"), r#"[{"goodsId":"fixture","tax":10}]"#).unwrap();
        let read: Value = serde_json::from_str(&local_catalog(&store).unwrap().body).unwrap();
        assert_eq!(read[0]["goodsId"], "fixture");
        fs::write(root.join("catalog.json"), "{}").unwrap();
        assert!(local_catalog(&store).is_err());
    }
    fn fixture() -> (WorkbenchStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("diy-workbench-test-{}", unique()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.json");
        fs::write(&source,json!({"revision":7,"updatedAt":"old","mystery":{"keep":true},"configs":[{"id":"001234567890123456789","shopId":"intel","productId":"p","name":"原名称","price":8799,"actualParts":[],"parts":[{"taxCents":12345}],"addons":[],"unknown":{"raw":1.2345}}],"templates":[],"logs":[{"id":"archived","mystery":true}]}).to_string()).unwrap();
        let store = initialize(
            &root.join("workbench.sqlite"),
            &source,
            &root.join("assets"),
        )
        .unwrap();
        (store, root)
    }
    fn call(s: &WorkbenchStore, m: &str, p: &str, v: Value) -> (u16, Value) {
        let r = request(s, m, p, Some(&v.to_string())).unwrap();
        (r.status, serde_json::from_str(&r.body).unwrap())
    }
    #[test]
    fn crud_restart_preserves_unknown_empty_and_money() {
        let (s, r) = fixture();
        let initial = full_state(&db(&s.path).unwrap()).unwrap();
        assert_eq!(initial["configs"][0]["actualParts"], json!([]));
        let mut changes = initial["configs"].clone();
        changes[0]["name"] = json!("新名称");
        changes
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new","name":"新增","actualParts":[]}));
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":changes})
            )
            .0,
            200
        );
        let again = initialize(&s.path, &r.join("missing-source.json"), &s.assets).unwrap();
        let saved = full_state(&db(&again.path).unwrap()).unwrap();
        assert_eq!(saved["configs"][0]["price"], 8799);
        assert_eq!(
            saved["configs"][0]["unknown"],
            initial["configs"][0]["unknown"]
        );
        assert_eq!(saved["mystery"], initial["mystery"]);
        assert!(
            saved["logs"]
                .as_array()
                .unwrap()
                .contains(&initial["logs"][0])
        );
        let mut rows = saved["configs"].clone();
        rows[0]["deletedAt"] = json!("2026-10-11");
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":8,"configs":rows})
            )
            .0,
            200
        );
        assert!(state(&db(&s.path).unwrap()).unwrap()["configs"][0]["deletedAt"].is_string());
    }
    #[test]
    fn conflict_and_batch_replay_are_atomic() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut after = old["configs"][0].clone();
        after["name"] = json!("A");
        let body = json!({"operationId":"stable-op","mode":"ordinary","baseRevision":7,"changes":[{"id":after["id"],"base":old["configs"][0],"after":after}]});
        let (_, receipt) = call(&s, "POST", "/api/configs/batch", body.clone());
        assert_eq!(receipt["revision"], 8);
        assert_eq!(
            call(&s, "POST", "/api/configs/batch", body.clone()).1,
            receipt
        );
        let mut wrong = body.clone();
        wrong["changes"][0]["after"]["name"] = json!("B");
        assert_eq!(call(&s, "POST", "/api/configs/batch", wrong).0, 409);
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":[]})
            )
            .0,
            409
        );
        let mut conflicted = body.clone();
        conflicted["operationId"] = json!("different");
        conflicted["changes"][0]["after"]["name"] = json!("C");
        assert_eq!(call(&s, "POST", "/api/configs/batch", conflicted).0, 409);
        assert_eq!(
            state(&db(&s.path).unwrap()).unwrap()["configs"][0]["name"],
            "A"
        );
        let c = db(&s.path).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM workbench_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn ordinary_presentation_fields_preserve_unknown_and_replay() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut desired = old["configs"][0].clone();
        let presentation = json!({
            "shop":"图片店铺标题", "layout":"long", "skuMode":"dedicated",
            "posterDesignVersion":1, "previousSquareLayout":{"textTransforms":{"header":{"x":12}}},
            "autoWidth":false, "theme":"light", "productTheme":"light", "palette":{"text":"#123456"},
            "themePalettes":{"dark":{"bg":"#000000"}}, "fontFamily":"阿里巴巴普惠体",
            "modules":[{"id":"header","type":"header","visible":true,"size":22,"text":"新图片文字"}],
            "textStyles":{"header.title":{"size":24,"text":"图片专用文字"}},
            "skuTextStyles":{"header.title":{"color":"#123456"}},
            "textTransforms":{"long":{"header.title":{"x":123,"y":456,"scaleX":1,"scaleY":1}}},
            "moduleTransforms":{"long":{"header":{"x":16,"y":20,"width":600,"height":150}}},
            "freeCanvasLayouts":{"long":{"base":700,"height":1200,"autoWidth":false}},
            "caseImage":"/uploads/new.png", "caseVisible":true,
            "caseTransforms":{"long":{"x":300,"y":20,"width":250,"height":250}},
            "posterImages":[{"id":"image","url":"/uploads/added.png","naturalWidth":1000,"naturalHeight":1000,"transforms":{"long":{"x":10,"y":400,"width":120,"height":120}}}],
            "showUpgrades":true, "showWarranty":false, "upgradeColor":"#654321",
            "upgradeSize":14, "upgradeWeight":500, "posterFields":{"subtitle":false},
            "posterSubtitle":"图片摘要", "footer":"页脚文字"
        });
        assert_eq!(
            presentation.as_object().unwrap().len(),
            ORDINARY_PRESENTATION_FIELDS.len()
        );
        for field in ORDINARY_PRESENTATION_FIELDS {
            desired[*field] = presentation[*field].clone();
        }
        let body = json!({"operationId":"presentation","mode":"ordinary","baseRevision":7,
            "changes":[{"id":desired["id"],"base":old["configs"][0],"after":desired}]});
        let result = call(&s, "POST", "/api/configs/batch", body.clone());
        assert_eq!(result.0, 200);
        assert_eq!(result.1["configs"][0], desired);
        assert_eq!(
            result.1["configs"][0]["unknown"],
            old["configs"][0]["unknown"]
        );
        let persisted = state(&db(&s.path).unwrap()).unwrap();
        assert_eq!(persisted["configs"][0], desired);
        assert_eq!(persisted["mystery"], old["mystery"]);
        assert_eq!(
            call(&s, "POST", "/api/configs/batch", body.clone()).1,
            result.1
        );
        let mut reused = body;
        reused["changes"][0]["after"]["layout"] = json!("square");
        assert_eq!(call(&s, "POST", "/api/configs/batch", reused).0, 409);
        let c = db(&s.path).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM workbench_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM workbench_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn ordinary_presentation_cannot_modify_identity_link_delete_order_or_unknown() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        for field in [
            "id",
            "shopId",
            "productId",
            "product",
            "productUrl",
            "productCategory",
            "productCardColor",
            "spu",
            "skuId",
            "deletedAt",
            "deletionSessionId",
            "order",
            "configOrder",
            "unknown",
        ] {
            let mut desired = old["configs"][0].clone();
            desired["layout"] = json!("square");
            desired[field] = json!("changed");
            let body = json!({"operationId":field,"mode":"ordinary","baseRevision":7,
                "changes":[{"id":old["configs"][0]["id"],"base":old["configs"][0],"after":desired}]});
            assert_eq!(
                call(&s, "POST", "/api/configs/batch", body).0,
                400,
                "{field}"
            );
            assert_eq!(state(&db(&s.path).unwrap()).unwrap(), old, "{field}");
        }
        let mut desired = old["configs"][0].clone();
        desired["caseTransforms"] = json!({"long":{"x":25}});
        let body = json!({"operationId":"parts-mode","baseRevision":7,
            "changes":[{"id":desired["id"],"base":old["configs"][0],"after":desired}]});
        assert_eq!(call(&s, "POST", "/api/configs/batch", body).0, 400);
        let c = db(&s.path).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM workbench_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn ordinary_presentation_envelope_does_not_write_global_collections() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut desired = old["configs"][0].clone();
        desired["caseImage"] = json!("/uploads/new.png");
        let body = json!({"operationId":"global-envelope","mode":"ordinary","baseRevision":7,
            "configs":[],"templates":[{"id":"new"}],"shopSettings":{"intel":{"coupon":999}},
            "sourceCatalog":[{"sourceId":"new"}],"costSource":[{"goodsId":"new"}],"caseGallery":[{"id":"new"}],
            "changes":[{"id":desired["id"],"base":old["configs"][0],"after":desired}]});
        assert_eq!(call(&s, "POST", "/api/configs/batch", body).0, 200);
        let saved = state(&db(&s.path).unwrap()).unwrap();
        for field in [
            "templates",
            "shopSettings",
            "sourceCatalog",
            "costSource",
            "caseGallery",
        ] {
            assert_eq!(saved.get(field), old.get(field), "{field}");
        }
        assert_eq!(saved["configs"].as_array().unwrap().len(), 1);
        assert_eq!(saved["configs"][0], desired);
    }
    #[test]
    fn ordinary_presentation_stale_full_row_keeps_new_remote_unknown_fields() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut remote = old["configs"].clone();
        remote[0]["unknown"] = json!({"raw":"remote-new-value","extra":true});
        remote[0]["futureField"] = json!({"preserve":123});
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":remote})
            )
            .0,
            200
        );
        let mut local = old["configs"][0].clone();
        local["caseTransforms"] = json!({"long":{"x":123,"y":456}});
        let body = json!({"operationId":"stale-full-row","mode":"ordinary","baseRevision":7,
            "changes":[{"id":local["id"],"base":old["configs"][0],"after":local}]});
        let result = call(&s, "POST", "/api/configs/batch", body);
        assert_eq!(result.0, 200);
        assert_eq!(result.1["rebased"], true);
        assert_eq!(result.1["configs"][0]["unknown"], remote[0]["unknown"]);
        assert_eq!(
            result.1["configs"][0]["futureField"],
            remote[0]["futureField"]
        );
        assert_eq!(
            result.1["configs"][0]["caseTransforms"],
            local["caseTransforms"]
        );
    }
    #[test]
    fn ordinary_presentation_rebases_coordinates_replays_and_restores_auto_layout() {
        let (s, _) = fixture();
        let initial = state(&db(&s.path).unwrap()).unwrap();
        let mut seed = initial["configs"].clone();
        seed[0]["textTransforms"] = json!({"long":{"header.title":{"x":10,"y":20}}});
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":seed})
            )
            .0,
            200
        );
        let old = state(&db(&s.path).unwrap()).unwrap();
        let body = |operation: &str, desired: &Value| {
            json!({"operationId":operation,"mode":"ordinary","baseRevision":8,
            "changes":[{"id":desired["id"],"base":old["configs"][0],"after":desired}]})
        };
        let mut x = old["configs"][0].clone();
        x["textTransforms"]["long"]["header.title"]["x"] = json!(30);
        let x_body = body("x", &x);
        let x_receipt = call(&s, "POST", "/api/configs/batch", x_body.clone());
        assert_eq!(x_receipt.0, 200);
        let mut y = old["configs"][0].clone();
        y["textTransforms"]["long"]["header.title"]["y"] = json!(40);
        let saved = call(&s, "POST", "/api/configs/batch", body("y", &y));
        assert_eq!(saved.0, 200);
        assert_eq!(saved.1["rebased"], true);
        assert_eq!(
            saved.1["configs"][0]["textTransforms"]["long"]["header.title"],
            json!({"x":30,"y":40})
        );
        let replay = call(&s, "POST", "/api/configs/batch", x_body);
        let mut expected = x_receipt.1;
        expected["rebased"] = json!(true);
        assert_eq!(replay.1, expected);
        assert_eq!(
            state(&db(&s.path).unwrap()).unwrap()["configs"][0],
            saved.1["configs"][0]
        );
        let mut conflict = x;
        conflict["textTransforms"]["long"]["header.title"]["x"] = json!(50);
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/configs/batch",
                body("conflict", &conflict)
            )
            .0,
            409
        );
        let mut reset = saved.1["configs"][0].clone();
        reset.as_object_mut().unwrap().remove("textTransforms");
        let reset_body = json!({"operationId":"reset","mode":"ordinary","baseRevision":10,
            "changes":[{"id":reset["id"],"base":saved.1["configs"][0],"after":reset}]});
        assert_eq!(call(&s, "POST", "/api/configs/batch", reset_body).0, 200);
        assert!(
            state(&db(&s.path).unwrap()).unwrap()["configs"][0]
                .get("textTransforms")
                .is_none()
        );
    }
    #[test]
    fn ordinary_presentation_conflict_rolls_back_whole_batch() {
        let (s, _) = fixture();
        let initial = state(&db(&s.path).unwrap()).unwrap();
        let mut seed = initial["configs"].clone();
        seed[0]["layout"] = json!("long");
        let mut second = seed[0].clone();
        second["id"] = json!("second");
        seed.as_array_mut().unwrap().push(second);
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":seed})
            )
            .0,
            200
        );
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut remote = old["configs"][0].clone();
        remote["layout"] = json!("square");
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/configs/batch",
                json!({"operationId":"remote","mode":"ordinary","baseRevision":8,
            "changes":[{"id":remote["id"],"base":old["configs"][0],"after":remote}]})
            )
            .0,
            200
        );
        let before_conflict = state(&db(&s.path).unwrap()).unwrap();
        let mut local = old["configs"][0].clone();
        local["layout"] = json!("other");
        let mut second = old["configs"][1].clone();
        second["caseImage"] = json!("/uploads/new.png");
        let result = call(
            &s,
            "POST",
            "/api/configs/batch",
            json!({"operationId":"atomic-conflict","mode":"ordinary","baseRevision":8,
            "changes":[{"id":second["id"],"base":old["configs"][1],"after":second},
                       {"id":local["id"],"base":old["configs"][0],"after":local}]}),
        );
        assert_eq!(result.0, 409);
        assert_eq!(state(&db(&s.path).unwrap()).unwrap(), before_conflict);
        let c = db(&s.path).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM workbench_receipts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn rebased_independent_fields_and_recovery() {
        let (s, _) = fixture();
        let old = state(&db(&s.path).unwrap()).unwrap();
        let mut a = old["configs"][0].clone();
        a["name"] = json!("A");
        let body = |id: &str, a: Value| json!({"operationId":id,"mode":"ordinary","baseRevision":7,"changes":[{"id":a["id"],"base":old["configs"][0],"after":a}]});
        assert_eq!(call(&s, "POST", "/api/configs/batch", body("a", a)).0, 200);
        let mut b = old["configs"][0].clone();
        b["price"] = json!(8899);
        let result = call(&s, "POST", "/api/configs/batch", body("b", b));
        assert_eq!(result.0, 200);
        assert_eq!(result.1["configs"][0]["name"], "A");
        assert_eq!(result.1["configs"][0]["price"], 8899);
        let draft = json!({"state":old,"baseState":old});
        let result = call(&s, "POST", "/api/recovery-draft", draft.clone());
        assert_eq!(result.0, 200);
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(result.1["file"].as_str().unwrap()).unwrap()
            )
            .unwrap(),
            draft["state"]
        );
        let raw: String = db(&s.path)
            .unwrap()
            .query_row(
                "SELECT document FROM workbench_recovery WHERE id=?1",
                [result.1["id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), draft);
    }
    #[test]
    fn historical_restore_is_previewed_atomic_and_keeps_archive() {
        let (s, _) = fixture();
        let original = state(&db(&s.path).unwrap()).unwrap();
        let (_, named) = call(&s, "POST", "/api/versions/name", json!({"name":"原版"}));
        let mut configs = original["configs"].clone();
        configs[0]["name"] = json!("后续名称");
        configs
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"added","name":"新增"}));
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/state",
                json!({"baseRevision":7,"configs":configs,"newUnknown":{"raw":true}})
            )
            .0,
            200
        );
        let (_, preview) = call(
            &s,
            "POST",
            "/api/versions/preview",
            json!({"id":named["id"]}),
        );
        assert_eq!(preview["revision"], 7);
        assert_eq!(preview["baseRevision"], 8);
        assert!(preview["changes"].as_array().unwrap().len() >= 2);
        let (mut status, _) = call(
            &s,
            "POST",
            "/api/versions/restore",
            json!({"id":named["id"],"hash":"wrong","baseRevision":8}),
        );
        assert_eq!(status, 409);
        assert_eq!(state(&db(&s.path).unwrap()).unwrap()["revision"], 8);
        (status, _) = call(
            &s,
            "POST",
            "/api/versions/restore",
            json!({"id":named["id"],"hash":preview["hash"],"baseRevision":8}),
        );
        assert_eq!(status, 200);
        let restored = full_state(&db(&s.path).unwrap()).unwrap();
        assert_eq!(restored["revision"], 9);
        assert_eq!(restored["configs"], original["configs"]);
        assert!(restored.get("newUnknown").is_none());
        let (_, again) = call(&s, "POST", "/api/versions/preview", json!({"id":"v-2"}));
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/versions/restore",
                json!({"id":"v-2","baseRevision":9,"hash":again["hash"]})
            )
            .0,
            200
        );
        let re_restored = state(&db(&s.path).unwrap()).unwrap();
        assert_eq!(re_restored["revision"], 10);
        assert_eq!(re_restored["newUnknown"], json!({"raw":true}));
        assert_eq!(re_restored["configs"], configs);
        assert!(
            restored["logs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l["id"] == "archived")
        );
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/versions/delete-named",
                json!({"id":named["id"]})
            )
            .0,
            200
        );
        assert_eq!(
            call(&s, "POST", "/api/versions/cleanup", json!({"mode":"all"})).0,
            503
        );
    }
    #[test]
    #[ignore = "Reads the captured 81 MB offline JSON; run once for full migration verification"]
    fn captured_snapshot_is_losslessly_imported() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/migration-review/20261011/source-state.json");
        let raw = fs::read_to_string(&source).unwrap();
        let expected: Value = serde_json::from_str(&raw).unwrap();
        let root = std::env::temp_dir().join(format!("diy-workbench-test-full-{}", unique()));
        let store = initialize(
            &root.join("workbench.sqlite"),
            &source,
            &root.join("assets"),
        )
        .unwrap();
        let actual = full_state(&db(&store.path).unwrap()).unwrap();
        assert_eq!(actual["configs"].as_array().unwrap().len(), 2282);
        assert_eq!(actual["logs"].as_array().unwrap().len(), 105586);
        assert!(
            actual == expected,
            "Entire document must equal the captured source, including unknown fields and number representations"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(source).unwrap())),
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
    }
    #[test]
    fn named_export_folders_preserve_previous_files_and_reject_unsafe_paths() {
        let (_, root) = fixture();
        let payload = json!({"name":"示例链接_配置图","files":[{"name":"1.png","base64":STANDARD.encode(b"png")} ]});
        let first = export_files(&payload, &root).unwrap();
        let second = export_files(&payload, &root).unwrap();
        assert_eq!(
            Path::new(first["directory"].as_str().unwrap())
                .file_name()
                .unwrap(),
            "示例链接_配置图"
        );
        assert_eq!(
            Path::new(second["directory"].as_str().unwrap())
                .file_name()
                .unwrap(),
            "示例链接_配置图_2"
        );
        assert_eq!(
            fs::read(root.join("示例链接_配置图/1.png")).unwrap(),
            b"png"
        );
        let nested = export_files(
            &json!({"name":"两种图片","files":[
            {"name":"示例链接_配置图/1.png","base64":STANDARD.encode(b"long")},
            {"name":"示例链接_sku图/1.png","base64":STANDARD.encode(b"sku")}]}),
            &root,
        )
        .unwrap();
        assert_eq!(nested["count"], 2);
        assert_eq!(
            fs::read(root.join("两种图片/示例链接_sku图/1.png")).unwrap(),
            b"sku"
        );
        for name in [
            "../bad.png",
            "a/../b",
            "/a.png",
            "C:\\a.png",
            "a/NUL.png",
            "a./b.png",
            "a/b/c.png",
        ] {
            assert!(
                export_files(&json!({"files":[{"name":name,"base64":""}]}), &root).is_err(),
                "{name}"
            );
        }
        assert!(
            export_files(
                &json!({"name":"../outside","files":[{"name":"a.png","base64":""}]}),
                &root
            )
            .is_err()
        );
        assert!(
            export_files(
                &json!({"files":[{"name":"a","base64":""},{"name":"A/b.png","base64":""}]}),
                &root
            )
            .is_err()
        );
    }
    #[test]
    fn asset_scope_and_export_never_overwrite() {
        let (s, r) = fixture();
        fs::create_dir_all(s.assets.join("uploads")).unwrap();
        fs::write(s.assets.join("uploads/image.png"), b"test").unwrap();
        assert!(read_asset(&s, "/uploads/image.png").is_ok());
        assert!(read_asset(&s, "../source.json").is_err());
        assert!(read_asset(&s, "uploads/../../source.json").is_err());
        let payload = json!({"files":[{"name":"配置.json","base64":STANDARD.encode(b"{}")} ]});
        let first = export_files(&payload, &r).unwrap();
        let second = export_files(&payload, &r).unwrap();
        assert_ne!(first["directory"], second["directory"]);
        assert_eq!(first["count"], 0);
        let result=export_files(&json!({"files":[{"name":"image.png","base64":STANDARD.encode(b"png")},{"name":"manifest.json","base64":STANDARD.encode(b"{}")}]}),&r).unwrap();
        assert_eq!(result["count"], 1);
        assert!(export_files(&json!({"files":[{"name":"../bad","base64":""}]}), &r).is_err());
    }
    #[test]
    fn oversized_asset_is_refused_and_derived_status_is_truthful() {
        let (s, _) = fixture();
        fs::create_dir_all(s.assets.join("uploads")).unwrap();
        let file = fs::File::create(s.assets.join("uploads/oversized.png")).unwrap();
        file.set_len((MAX_UPLOAD_BYTES + 1) as u64).unwrap();
        drop(file);
        assert_eq!(
            read_asset(&s, "/uploads/oversized.png").err().unwrap(),
            "文件大小超过允许上限"
        );
        assert!(decode_limited(&STANDARD.encode(b"1234567"), 6).is_err());
        assert_eq!(
            decode_limited(&STANDARD.encode(b"123456"), 6).unwrap(),
            b"123456"
        );
        let (_, status) = call(&s, "GET", "/api/derived/status", json!({}));
        assert_eq!(status["productFiles"], false);
        assert_eq!(status["scope"], "local-state");
    }
}
// 诊断 JSON 复用原生导出契约：不以图片计数判断是否写盘。
#[cfg(test)]
mod diagnostic_export_tests {
    use super::*;
    #[test]
    fn diagnostics_json_export_writes_exact_text_and_acknowledges_file() {
        use base64::Engine;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/diagnostic-export-20261014").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let text = br#"{"schema":1,"privacy":"metadata-only","events":[]}"#;
        let payload = json!({"name":"diagnostics-test","files":[{"name":"diagnostics.json","base64":base64::engine::general_purpose::STANDARD.encode(text)}]});
        let result = export_files(&payload, &root).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["count"], 0);
        assert_eq!(result["files"][0], "diagnostics.json");
        assert_eq!(fs::read(PathBuf::from(result["directory"].as_str().unwrap()).join("diagnostics.json")).unwrap(), text);
    }
}
