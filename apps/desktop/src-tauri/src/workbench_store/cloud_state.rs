// 云同步本机检查点：状态和队列以同一事务提交，同时检查工作台版本与队列版本。
//! Atomic local checkpoint for the cloud controller. No network or credentials.
//! A local edit and a sync acknowledgement compete on both state and queue versions.
use super::*;

// 云检查点很大；把状态栏和授权需要的少量字段随正文原子投影，避免每次查询解析整库。
fn schema(c: &Connection) -> Result<()> {
    let ready: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_cloud_header')",
        [], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if ready { return Ok(()); }
    // 迁移与初始回填同成同败；正常查询不会执行空写入，也不争抢正在保存的写锁。
    let result = c.execute_batch("SAVEPOINT cloud_header_migration;
        CREATE TABLE IF NOT EXISTS workbench_cloud_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_cloud_header(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,metadata TEXT NOT NULL,outbox TEXT,conflicts INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS workbench_cloud_header_insert AFTER INSERT ON workbench_cloud_state BEGIN
          INSERT OR REPLACE INTO workbench_cloud_header SELECT NEW.id,NEW.version,
            json_extract(NEW.document,'$.uid','$.workspaceId','$.cursor','$.localRevision'),
            json_extract(NEW.document,'$.outbox'),
            (SELECT count(*) FROM json_each(NEW.document,'$.records') r WHERE json_type(r.value,'$.conflict')='object'); END;
        CREATE TRIGGER IF NOT EXISTS workbench_cloud_header_update AFTER UPDATE OF version,document ON workbench_cloud_state BEGIN
          INSERT OR REPLACE INTO workbench_cloud_header SELECT NEW.id,NEW.version,
            json_extract(NEW.document,'$.uid','$.workspaceId','$.cursor','$.localRevision'),
            json_extract(NEW.document,'$.outbox'),
            (SELECT count(*) FROM json_each(NEW.document,'$.records') r WHERE json_type(r.value,'$.conflict')='object'); END;
        CREATE TRIGGER IF NOT EXISTS workbench_cloud_header_delete AFTER DELETE ON workbench_cloud_state BEGIN
          DELETE FROM workbench_cloud_header WHERE id=OLD.id; END;
        INSERT OR IGNORE INTO workbench_cloud_header SELECT id,version,
          json_extract(document,'$.uid','$.workspaceId','$.cursor','$.localRevision'),
          json_extract(document,'$.outbox'),
          (SELECT count(*) FROM json_each(document,'$.records') r WHERE json_type(r.value,'$.conflict')='object')
          FROM workbench_cloud_state;
        RELEASE cloud_header_migration;");
    if let Err(error) = result {
        // 初次回填遇到损坏正文时撤销表和触发器，后续修复后仍可完整重试迁移。
        let _ = c.execute_batch("ROLLBACK TO cloud_header_migration; RELEASE cloud_header_migration;");
        return Err(error.to_string());
    }
    Ok(())
}

fn stored(c: &Connection) -> Result<(i64, Value)> {
    let item: Option<(i64, String)> = c
        .query_row(
            "SELECT version,document FROM workbench_cloud_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match item {
        Some((version, raw)) => Ok((
            version,
            serde_json::from_str(&raw).map_err(|e| e.to_string())?,
        )),
        None => Ok((0, Value::Null)),
    }
}

// 在同一读取事务中取得工作台与云队列版本，避免前端拿到错配的基线。
pub(super) fn load(store: &WorkbenchStore) -> Result<ApiResponse> {
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let state = state(&tx)?;
    let (version, document) = stored(&tx)?;
    Ok(response(
        200,
        json!({"state":state,"cloudVersion":version,"document":document}),
    ))
}

fn identity(value: &Value, field: &str) -> Result<String> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| format!("云同步身份字段无效：{field}"))
}

pub(super) fn status(store: &WorkbenchStore) -> Result<Value> {
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    status_connection(&tx)
}

// 与程序首次启动写入的默认正文严格比较；未知字段也不能被当成空工作区忽略。
fn check_factory_empty(c: &Connection) -> Result<()> {
    let expected = json!({"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{}});
    let reject = "本机同步准备信息缺失，且本机已有数据；已保留全部内容，不能自动绑定空工作区。";
    // 未来存储迁移须显式适配空库契约，不能按旧表结构误判更高版本的数据库。
    if c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? != 0 { return Err("本机数据库版本不支持自动空库接入，请更新程序后重试。".into()); }
    if state(c)? != expected { return Err(reject.into()); }
    let archive: String = c.query_row("SELECT document FROM workbench_log_archive WHERE id=1", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if serde_json::from_str::<Value>(&archive).map_err(|e| e.to_string())? != json!([]) { return Err(reject.into()); }
    let histories: Vec<String> = {
        let mut q = c.prepare("SELECT document FROM workbench_history").map_err(|e| e.to_string())?;
        q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.collect::<std::result::Result<_,_>>().map_err(|e| e.to_string())?
    };
    if histories.len() != 1 { return Err(reject.into()); }
    let imported: Value = serde_json::from_str(&histories[0]).map_err(|e| e.to_string())?;
    if imported["type"] != "import" || imported["configCount"] != 0 || imported["logCount"] != 0 { return Err(reject.into()); }
    // 检查所有其他持久表，包含恢复草稿、历史版本、ERP预览和未来新增的业务表。
    // 只放行明确的投影/缓存维护元数据，不能仅凭 configs=[] 认定新库。
    let tables: Vec<String> = {
        let mut q = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map_err(|e| e.to_string())?;
        q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.collect::<std::result::Result<_,_>>().map_err(|e| e.to_string())?
    };
    for table in tables {
        if ["workbench_state","workbench_log_archive","workbench_history","workbench_state_header","workbench_config_projection_meta","workbench_cache_maintenance"].contains(&table.as_str()) { continue; }
        let sql = format!("SELECT EXISTS(SELECT 1 FROM \"{}\")", table.replace('"', "\"\""));
        if c.query_row(&sql, [], |r| r.get::<_, bool>(0)).map_err(|e| e.to_string())? { return Err(reject.into()); }
    }
    Ok(())
}

pub(super) fn bind_empty(store: &WorkbenchStore, member: &Value, check_session: impl Fn() -> Result<()>) -> Result<Value> {
    let uid = identity(member, "uid")?;
    let workspace = identity(member, "workspaceId")?;
    let mut c = db(&store.path)?;
    schema(&c)?;
    check_session()?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let (_, existing) = stored(&tx)?;
    if !existing.is_null() {
        if existing["uid"] != uid || existing["workspaceId"] != workspace { return Err("请使用当前数据所属的成员账号登录".into()); }
        check_session()?;
        return status_connection(&tx);
    }
    check_factory_empty(&tx)?;
    // 首次队列和共享基线均为空，不创建任何上传请求，后续引擎从 cursor=0 拉取。
    let document = json!({"format":1,"uid":uid,"workspaceId":workspace,"deviceId":uuid::Uuid::new_v4().to_string(),"cursor":0,"localRevision":0,"records":[],"outbox":[],"materializedProjection":[],"origin":"empty-workspace"});
    validate_document(&document, &Value::Null)?;
    check_session()?;
    tx.execute("INSERT INTO workbench_cloud_state VALUES(1,1,?1)", [document.to_string()]).map_err(|e| e.to_string())?;
    check_session()?;
    let status = status_connection(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(status)
}

// 直接查询状态标量和冲突数量，状态栏不需要反序列化完整业务正文。
fn status_connection(c: &Connection) -> Result<Value> {
    let row = c.query_row(
        "SELECT version,json_extract(metadata,'$[0]'),json_extract(metadata,'$[1]'),json_extract(metadata,'$[2]'),json_extract(metadata,'$[3]'),json_array_length(outbox),conflicts FROM workbench_cloud_header WHERE id=1",
        [], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<i64>>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?)),
    ).optional().map_err(|e|e.to_string())?;
    let revision: i64 = c
        .query_row(
            "SELECT json_extract(revision,'$') FROM workbench_state_header WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(json!({"initialized":false,"workspaceRevision":revision})),
        Some((version, uid, workspace, cursor, local_revision, uncertain, conflicts)) => {
            Ok(
                json!({"initialized":true,"cloudVersion":version,"uid":uid,"workspaceId":workspace,"cursor":cursor,"workspaceRevision":revision,"localChangesPending":Some(revision)!=local_revision,"uncertain":uncertain,"conflicts":conflicts}),
            )
        }
    }
}

// 先核对本机绑定成员；上传请求必须与已落盘 outbox 原文一致且提交身份唯一。
pub(super) fn authorize(
    store: &WorkbenchStore,
    member: &Value,
    request: Option<&Value>,
) -> Result<()> {
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let header: Option<(String,String)> = tx.query_row(
        "SELECT json_extract(metadata,'$[0]'),json_extract(metadata,'$[1]') FROM workbench_cloud_header WHERE id=1",
        [], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(|e|e.to_string())?;
    let (uid, workspace) = header.ok_or("请先完成云同步接入预检与迁移")?;
    if Some(uid.as_str()) != member["uid"].as_str()
        || Some(workspace.as_str()) != member["workspaceId"].as_str()
    {
        return Err("请使用当前数据所属的成员账号登录".into());
    }
    if let Some(request) = request {
        let pushes: Vec<&Value> = match request["action"].as_str() {
            Some("sync.push") => vec![request],
            Some("sync.pushBatch") => {
                let batch = request["payload"]["requests"]
                    .as_array()
                    .ok_or("云同步批次格式无效")?;
                if batch.is_empty() || batch.len() > 50 {
                    return Err("云同步批次须包含1至50条持久请求".into());
                }
                batch.iter().collect()
            }
            _ => Vec::new(),
        };
        let mut saved_requests = HashMap::new();
        if !pushes.is_empty() {
            let raw:String = tx.query_row("SELECT outbox FROM workbench_cloud_header WHERE id=1",[],|row|row.get(0)).map_err(|e|e.to_string())?;
            let saved: Value = serde_json::from_str(&raw).map_err(|_| "持久队列格式无效")?;
            for item in saved.as_array().ok_or("持久队列格式无效")? {
                let mutation = identity(&item["payload"], "mutationId")?;
                if saved_requests.insert(mutation, item.clone()).is_some() {
                    return Err("持久队列包含重复提交身份".into());
                }
            }
        }
        let mut mutations = HashSet::new();
        for push in pushes {
            let mutation = identity(&push["payload"], "mutationId")?;
            if push["action"] != "sync.push"
                || push["protocolVersion"] != 2
                || !mutations.insert(mutation.clone())
            {
                return Err("云同步批次请求动作或提交身份无效".into());
            }
            let saved = saved_requests
                .get(&mutation)
                .ok_or("云端提交尚未持久保存，已阻止发送")?;
            if saved != push {
                return Err("待发送内容与本机持久请求不一致".into());
            }
        }
    }
    Ok(())
}

// 接入方案只适用于预检时的原始数据摘要、版本和成员，已有绑定不可再次导入。
fn check_plan(c: &Connection, plan: &Value, member: &Value) -> Result<Value> {
    if plan["format"] != 1 || plan["ready"] != true || plan["origin"] != "cutover-preflight" {
        return Err("接入计划尚未完成预检或冲突处理".into());
    }
    if !stored(c)?.1.is_null() {
        return Err("此目录已经接入同步，不能重复导入迁移计划".into());
    }
    for field in ["uid", "workspaceId"] {
        if plan["member"][field] != member[field] || identity(member, field).is_err() {
            return Err("接入计划与当前登录成员不一致".into());
        }
    }
    let raw: String = c
        .query_row("SELECT document FROM workbench_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let before: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if plan["nativeTargetStateSha256"] != hash || plan["nativeBaseRevision"] != before["revision"] {
        return Err("此接入计划对应的数据已变化，请重新生成合并预检，未覆盖当前修改".into());
    }
    validate(&plan["state"])?;
    Ok(before)
}

fn plan_document(plan: &Value) -> Value {
    json!({"format":1,"workspaceId":plan["member"]["workspaceId"],"uid":plan["member"]["uid"],
        "deviceId":plan["member"]["deviceId"],"cursor":plan["cursor"],"records":plan["records"],
        "outbox":plan["outbox"],"materializedProjection":plan["materializedProjection"],
        "origin":"cutover-preflight","sourceSnapshotSha256":plan["oldSourceSnapshotSha256"],
        "resolutionPolicy":plan["resolutionPolicy"]})
}

// 验证本机接入方案并返回变化统计，不提交正文、不触发云上传。
pub(super) fn preview_plan(store: &WorkbenchStore, plan: &Value, member: &Value) -> Result<Value> {
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let before = check_plan(&tx, plan, member)?;
    let document = plan_document(plan);
    validate_document(&document, &Value::Null)?;
    Ok(
        json!({"beforeConfigs":before["configs"].as_array().unwrap().len(),"afterConfigs":plan["state"]["configs"].as_array().unwrap().len(),
        "records":document["records"].as_array().unwrap().len(),"uncertain":document["outbox"].as_array().unwrap().len(),
        "cursor":document["cursor"],"resolutionPolicy":plan["resolutionPolicy"],"workspaceId":member["workspaceId"],
        "message":"导入仅合并本机数据与同步基线，不上传；确认后请先执行只下载检查。"}),
    )
}

// 写入独立恢复文件后，在单一事务中保存合并正文、历史和初始同步队列。
pub(super) fn apply_plan(
    store: &WorkbenchStore,
    plan: &Value,
    member: &Value,
    raw_plan_hash: &str,
) -> Result<ApiResponse> {
    if raw_plan_hash.len() != 64
        || !raw_plan_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("接入计划原文摘要无效".into());
    }
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let before = check_plan(&tx, plan, member)?;
    let mut document = plan_document(plan);
    validate_document(&document, &Value::Null)?;
    let backup = store
        .path
        .parent()
        .ok_or("数据目录无效")?
        .join("cloud-cutover-backups")
        .join(format!("before-cloud-{}.json", unique()));
    write_new(&backup,json!({"format":1,"state":before,"cloud":null,"planHash":raw_plan_hash,"nativeTargetStateSha256":plan["nativeTargetStateSha256"],"nativeBaseRevision":plan["nativeBaseRevision"]}).to_string().as_bytes())?;
    let mut after = plan["state"].clone();
    after.as_object_mut().unwrap().remove("logs");
    let activity = persist(
        &tx,
        &before,
        &mut after,
        &json!({"operator":member["name"],"message":"确认云同步接入合并方案（尚未上传）"}),
    )?;
    document["localRevision"] = after["revision"].clone();
    tx.execute(
        "INSERT INTO workbench_cloud_state VALUES(1,1,?1)",
        [document.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(
        200,
        json!({"revision":after["revision"],"cloudVersion":1,"activityDelta":activity,"backup":backup,"uploaded":false}),
    ))
}

// 核对同步身份、游标和持久请求不可变字段，禁止篡改已发送提交的业务身份。
fn validate_document(document: &Value, previous: &Value) -> Result<()> {
    if document["format"] != 1 {
        return Err("云同步本机格式不受支持".into());
    }
    for field in ["workspaceId", "uid", "deviceId"] {
        let value = identity(document, field)?;
        if !previous.is_null() && previous[field].as_str() != Some(&value) {
            return Err("同步记录已绑定其他成员、工作区或设备".into());
        }
    }
    let cursor = document["cursor"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or("云同步游标无效")?;
    if !previous.is_null() && cursor < previous["cursor"].as_i64().unwrap_or(0) {
        return Err("云同步游标不能回退".into());
    }
    let records = document["records"].as_array().ok_or("云同步记录须为数组")?;
    let mut ids = HashSet::new();
    for record in records {
        let kind = record["type"].as_str().ok_or("云同步记录类型无效")?;
        if ![
            "configuration",
            "component",
            "source",
            "template",
            "settings",
            "gallery",
            "workspace_meta",
        ]
        .contains(&kind)
        {
            return Err("云同步记录含不支持的类型".into());
        }
        let id = identity(record, "id")?;
        if !ids.insert((kind, id)) {
            return Err("云同步记录身份重复".into());
        }
        if record["version"].as_i64().is_none_or(|n| n < 0)
            || !(record["base"].is_null() || record["base"].is_object())
            || !record["draft"].is_object()
            || !(record["conflict"].is_null() || record["conflict"].is_object())
        {
            return Err("云同步记录格式无效".into());
        }
    }
    let requests = document["outbox"]
        .as_array()
        .ok_or("云同步待确认队列须为数组")?;
    let mut mutations = HashSet::new();
    for request in requests {
        let payload = &request["payload"];
        let id = identity(payload, "mutationId")?;
        if !mutations.insert(id.clone()) {
            return Err("待确认提交身份重复".into());
        }
        identity(request, "requestId")?;
        if request["protocolVersion"] != 2
            || request["action"] != "sync.push"
            || identity(payload, "deviceId").is_err()
            || payload["baseVersion"].as_i64().is_none_or(|n| n < 0)
            || !payload["after"].is_object()
            || !ids.contains(&(
                payload["entityType"].as_str().unwrap_or(""),
                payload["entityId"].as_str().unwrap_or("").to_string(),
            ))
        {
            return Err("待确认提交格式无效".into());
        }
        if let Some(old) = previous["outbox"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["payload"]["mutationId"] == id))
            && old != request
        {
            return Err("不能修改待确认提交的原始请求".into());
        }
    }
    if !document["materializedProjection"].is_array() {
        return Err("缺少本机共享字段基线".into());
    }
    // Authentication belongs to the native transport, never to exported SQLite state.
    for field in [
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "password",
    ] {
        if document.get(field).is_some() || requests.iter().any(|r| r.get(field).is_some()) {
            return Err("同步队列不能保存登录凭据".into());
        }
    }
    Ok(())
}

// 把允许的元数据及按键记录变化应用到旧检查点，未提交字段保持原样。
fn patch_document(mut document: Value, patch: &Value) -> Result<Value> {
    let object = patch.as_object().ok_or("云同步增量格式无效")?;
    if object
        .keys()
        .any(|key| !["set", "records"].contains(&key.as_str()))
    {
        return Err("云同步增量包含未知字段或暂不支持的记录删除".into());
    }
    if let Some(set) = object.get("set") {
        let set = set.as_object().ok_or("云同步增量set须为对象")?;
        for (key, value) in set {
            if ![
                "format",
                "workspaceId",
                "uid",
                "deviceId",
                "cursor",
                "outbox",
                "materializedProjection",
                "lastSyncedAt",
            ]
            .contains(&key.as_str())
            {
                return Err("云同步增量set包含不允许修改的字段".into());
            }
            if key == "lastSyncedAt"
                && !value.is_null()
                && value.as_str().is_none_or(|text| text.len() > 128)
            {
                return Err("云同步时间字段无效".into());
            }
            document[key] = value.clone();
        }
    }
    if let Some(changed) = object.get("records") {
        let changed = changed.as_array().ok_or("云同步增量records须为数组")?;
        let records = document["records"]
            .as_array_mut()
            .ok_or("云同步持久记录格式无效")?;
        let mut positions = HashMap::new();
        for (position, row) in records.iter().enumerate() {
            let key = (identity(row, "type")?, identity(row, "id")?);
            if positions.insert(key, position).is_some() {
                return Err("云同步持久记录身份重复".into());
            }
        }
        let mut changed_keys = HashSet::new();
        for row in changed {
            let key = (identity(row, "type")?, identity(row, "id")?);
            if !changed_keys.insert(key.clone()) {
                return Err("云同步增量记录身份重复".into());
            }
            if let Some(position) = positions.get(&key) {
                records[*position] = row.clone();
            } else {
                positions.insert(key, records.len());
                records.push(row.clone());
            }
        }
    }
    Ok(document)
}

// Only these old fields participate in transition validation. Retain the original
// immutable outbox before moving the large document into the patch result.
// 提取同步变更校验所需字段，供补丁提交复核不可变队列约束。
fn transition_guard(previous: &Value) -> Value {
    json!({"workspaceId":previous["workspaceId"],"uid":previous["uid"],"deviceId":previous["deviceId"],"cursor":previous["cursor"],"outbox":previous["outbox"]})
}

// 同时检查本机正文和云检查点版本；正文变化、历史及队列确认必须同成同败。
pub(super) fn commit(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (local_revision,local_updated): (i64,Option<String>) = tx.query_row(
        "SELECT json_extract(revision,'$'),json_extract(updated_at,'$') FROM workbench_state_header WHERE id=1",[],
        |row|Ok((row.get(0)?,row.get(1)?)),
    ).map_err(|e|e.to_string())?;
    let version: i64 = tx
        .query_row(
            "SELECT version FROM workbench_cloud_state WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    // 正文版本或队列版本任一变化都需重新合并，不能用旧同步回执覆盖较新的编辑。
    if input["baseRevision"].as_i64() != Some(local_revision)
        || input["cloudVersion"].as_i64() != Some(version)
    {
        return Ok(failure(409, "本机数据或同步队列已更新，请重新合并后重试"));
    }
    if version == 0 {
        return Ok(failure(
            409,
            "当前目录尚未完成云同步迁移预检，请先导入已核验的接入计划",
        ));
    }
    let (_, previous) = stored(&tx)?;
    let guard = transition_guard(&previous);
    let mut document = match input.get("documentPatch") {
        Some(patch) => {
            if input.get("document").is_some() {
                return Err("不能同时提交完整云资料与增量".into());
            }
            patch_document(previous, patch)?
        }
        None => {
            drop(previous);
            input.get("document").cloned().ok_or("缺少云同步资料")?
        }
    };
    validate_document(&document, &guard)?;
    let mut activity = Vec::new();
    let mut committed_revision = json!(local_revision);
    let mut committed_updated = local_updated.map(Value::String);
    // 只有明确提交正文才读取并保存整库；单纯队列确认保持原业务正文及历史不变。
    if let Some(state_input) = input.get("state") {
        let before = state(&tx)?;
        let mut after = state_input.clone();
        validate(&after)?;
        let object = after.as_object_mut().ok_or("工作台状态格式无效")?;
        object.remove("logs");
        // Revisions/timestamps are allocated by the store, never the controller.
        for field in ["revision", "updatedAt"] {
            match before.get(field) {
                Some(value) => {
                    object.insert(field.into(), value.clone());
                }
                None => {
                    object.remove(field);
                }
            }
        }
        if after != before {
            activity = persist(
                &tx,
                &before,
                &mut after,
                &json!({"operator":document["uid"],"message":"接收云端更新并合并本机修改"}),
            )?;
        }
        committed_revision = after["revision"].clone();
        committed_updated = after.get("updatedAt").cloned();
    }
    document["localRevision"] = committed_revision.clone();
    let next_version = version.checked_add(1).ok_or("云同步本机版本超出上限")?;
    tx.execute(
        "UPDATE workbench_cloud_state SET version=?1,document=?2 WHERE id=1",
        params![next_version, document.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut receipt =
        json!({"revision":committed_revision,"cloudVersion":next_version,"activityDelta":activity});
    if let Some(updated) = committed_updated {
        receipt["updatedAt"] = updated;
    }
    Ok(response(200, receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> WorkbenchStore {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/windows-acceptance-20261013/cloud-state-review-tests")
            .join(unique());
        fs::create_dir_all(&root).unwrap();
        let seed = root.join("seed.json");
        fs::write(
            &seed,
            json!({"revision":7,"configs":[{"id":"a","name":"old","parts":[]}],"logs":[]})
                .to_string(),
        )
        .unwrap();
        let store =
            initialize(&root.join("workbench.sqlite"), &seed, &root.join("assets")).unwrap();
        let c = db(&store.path).unwrap();
        schema(&c).unwrap();
        c.execute(
            "INSERT INTO workbench_cloud_state VALUES(1,1,?1)",
            [document().to_string()],
        )
        .unwrap();
        store
    }
    fn document() -> Value {
        json!({"format":1,"workspaceId":"w","uid":"u","deviceId":"d","cursor":5,"records":[{"type":"configuration","id":"a","version":2,"base":{"id":"a"},"draft":{"id":"a"},"conflict":null}],"outbox":[],"materializedProjection":[]})
    }
    fn request_body(store: &WorkbenchStore) -> Value {
        let mut data: Value = serde_json::from_str(&load(store).unwrap().body).unwrap();
        data["baseRevision"] = data["state"]["revision"].clone();
        data["state"]["configs"][0]["name"] = json!("cloud");
        data
    }
    #[test]
    fn cloud_and_local_state_commit_atomically_and_stale_editor_wins() {
        let store = fixture();
        let input = request_body(&store);
        let c = db(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_queue BEFORE UPDATE ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fail'); END;").unwrap();
        assert!(commit(&store, &input).is_err());
        assert_eq!(state(&c).unwrap()["revision"], 7);
        assert_eq!(state(&c).unwrap()["configs"][0]["name"], "old");
        assert_eq!(stored(&c).unwrap().0, 1);
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
                .unwrap(),
            1
        );
        c.execute_batch("DROP TRIGGER reject_queue").unwrap();
        assert_eq!(commit(&store, &input).unwrap().status, 200);
        assert_eq!(state(&c).unwrap()["revision"], 8);
        assert_eq!(stored(&c).unwrap().0, 2);
        assert_eq!(commit(&store, &input).unwrap().status, 409);
        let new_input = request_body(&store);
        let mut edited = state(&c).unwrap();
        edited["configs"][0]["name"] = json!("local");
        assert_eq!(
            save_state(
                &store,
                &json!({"baseRevision":8,"configs":edited["configs"]})
            )
            .unwrap()
            .status,
            200
        );
        assert_eq!(commit(&store, &new_input).unwrap().status, 409);
        assert_eq!(state(&c).unwrap()["configs"][0]["name"], "local");
    }
    #[test]
    fn immutable_outbox_identity_and_cursor_are_enforced() {
        let mut old = document();
        old["outbox"] = json!([{"protocolVersion":2,"action":"sync.push","requestId":"r","payload":{"mutationId":"m","deviceId":"d","entityType":"configuration","entityId":"a","baseVersion":2,"after":{"id":"a"}}}]);
        assert!(validate_document(&old, &old).is_ok());
        let mut altered = old.clone();
        altered["outbox"][0]["payload"]["after"]["name"] = json!("changed");
        assert!(validate_document(&altered, &old).is_err());
        for field in ["uid", "workspaceId", "deviceId"] {
            let mut altered = old.clone();
            altered[field] = json!("other");
            assert!(validate_document(&altered, &old).is_err());
        }
        let mut altered = old.clone();
        altered["cursor"] = json!(4);
        assert!(validate_document(&altered, &old).is_err());
        let mut altered = old.clone();
        altered["accessToken"] = json!("secret");
        assert!(validate_document(&altered, &old).is_err());
    }

    fn push() -> Value {
        json!({"protocolVersion":2,"action":"sync.push","requestId":"original-request","payload":{"mutationId":"original-mutation","deviceId":"original-device","entityType":"configuration","entityId":"a","baseVersion":2,"after":{"id":"a","name":"draft"}}})
    }
    fn owner() -> Value {
        json!({"uid":"u","workspaceId":"w","name":"测试成员"})
    }
    fn fresh_plan(store: &WorkbenchStore) -> Value {
        let c = db(&store.path).unwrap();
        c.execute("DELETE FROM workbench_cloud_state", []).unwrap();
        let raw: String = c
            .query_row("SELECT document FROM workbench_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let mut after: Value = serde_json::from_str(&raw).unwrap();
        after["configs"][0]["name"] = json!("merged-plan");
        after["revision"] = json!(999);
        let doc = document();
        json!({"format":1,"ready":true,"origin":"cutover-preflight","member":{"uid":"u","workspaceId":"w","deviceId":"d"},"cursor":5,
            "nativeTargetStateSha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"nativeBaseRevision":7,"state":after,
            "records":doc["records"],"outbox":[],"materializedProjection":[],"oldSourceSnapshotSha256":"fixture-old-only","resolutionPolicy":{}})
    }
    fn raw_hash(plan: &Value) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec_pretty(plan).unwrap())
        )
    }

    // 旧库一次性迁移不能改变正文；后续直接写入与删除仍要原子更新派生头。
    #[test]
    fn cloud_header_migrates_existing_checkpoint_and_tracks_all_writers() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let original: String = c.query_row("SELECT document FROM workbench_cloud_state", [], |r| r.get(0)).unwrap();
        c.execute_batch("DROP TRIGGER workbench_cloud_header_insert; DROP TRIGGER workbench_cloud_header_update; DROP TRIGGER workbench_cloud_header_delete; DROP TABLE workbench_cloud_header;").unwrap();
        schema(&c).unwrap();
        assert_eq!(c.query_row::<String,_,_>("SELECT document FROM workbench_cloud_state", [], |r| r.get(0)).unwrap(), original);
        assert_eq!(status(&store).unwrap()["cloudVersion"], 1);
        c.execute("UPDATE workbench_cloud_state SET version=2", []).unwrap();
        assert_eq!(status(&store).unwrap()["cloudVersion"], 2);
        c.execute("DELETE FROM workbench_cloud_state", []).unwrap();
        assert_eq!(status(&store).unwrap()["initialized"], false);
        assert!(authorize(&store, &owner(), None).is_err());
        c.execute("INSERT INTO workbench_cloud_state VALUES(1,3,?1)", [original]).unwrap();
        assert_eq!(status(&store).unwrap()["cloudVersion"], 3);
    }

    // 迁移中途失败不能留下会被快路径误认为已经完成的半张派生表。
    #[test]
    fn failed_cloud_header_migration_rolls_back_schema_and_can_retry() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE workbench_cloud_state(id INTEGER PRIMARY KEY,version INTEGER,document TEXT); INSERT INTO workbench_cloud_state VALUES(1,1,'invalid json');").unwrap();
        assert!(schema(&c).is_err());
        assert_eq!(c.query_row::<i64,_,_>("SELECT count(*) FROM sqlite_master WHERE name LIKE 'workbench_cloud_header%'", [], |r| r.get(0)).unwrap(), 0);
        c.execute("UPDATE workbench_cloud_state SET document=?1", [document().to_string()]).unwrap();
        schema(&c).unwrap();
        assert_eq!(c.query_row::<i64,_,_>("SELECT version FROM workbench_cloud_header", [], |r| r.get(0)).unwrap(), 1);
    }

    // WAL 下读取已提交状态不等待另一个写事务；失败或回滚也不能提前改变授权基线。
    #[test]
    fn cloud_header_reads_committed_owner_during_writer_and_rolls_back_together() {
        let store = fixture();
        let mut c = db(&store.path).unwrap();
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        let mut changed = document();
        changed["uid"] = json!("other");
        tx.execute("UPDATE workbench_cloud_state SET version=2,document=?1", [changed.to_string()]).unwrap();
        assert_eq!(status(&store).unwrap()["cloudVersion"], 1);
        assert!(authorize(&store, &owner(), None).is_ok());
        tx.rollback().unwrap();
        assert_eq!(status(&store).unwrap()["uid"], "u");
        c.execute_batch("CREATE TRIGGER reject_header BEFORE UPDATE ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;").unwrap();
        assert!(commit(&store, &patch_input(&store, json!({"set":{"cursor":6}}))).is_err());
        assert_eq!(status(&store).unwrap()["cloudVersion"], 1);
        assert_eq!(status(&store).unwrap()["cursor"], 5);
    }

    // 大型私人样本只允许显式选择隔离目录；记录本机耗时，不访问桌面或云网络。
    #[test]
    #[ignore = "Requires an explicitly selected isolated SQLite snapshot"]
    fn isolated_sync_checkpoint_timing_probe() {
        let root = PathBuf::from(std::env::var_os("DIYTOOLS_SYNC_PROBE_DIR").expect("isolated probe directory"));
        let store = initialize(&root.join("workbench.sqlite"), &root.join("unused-seed.json"), &root.join("assets")).unwrap();
        let c = db(&store.path).unwrap();
        let before: String = c.query_row("SELECT document FROM workbench_state", [], |r| r.get(0)).unwrap();
        let hash = format!("{:x}", Sha256::digest(before.as_bytes()));
        drop(before);
        let mut status_ms = Vec::new();
        let mut authorization_ms = Vec::new();
        for _ in 0..8 {
            let start = std::time::Instant::now();
            let current = status(&store).unwrap();
            status_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            let member = json!({"uid":current["uid"],"workspaceId":current["workspaceId"]});
            let start = std::time::Instant::now();
            authorize(&store, &member, None).unwrap();
            authorization_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let start = std::time::Instant::now();
        let snapshot = load(&store).unwrap();
        let load_ms = start.elapsed().as_secs_f64() * 1000.0;
        let load_bytes = snapshot.body.len();
        drop(snapshot);
        let mut commit_ms = Vec::new();
        for n in 0..3 {
            let current = status(&store).unwrap();
            let input = json!({"baseRevision":current["workspaceRevision"],"cloudVersion":current["cloudVersion"],"documentPatch":{"set":{"lastSyncedAt":format!("isolated-benchmark-{n}")}}});
            let start = std::time::Instant::now();
            assert_eq!(commit(&store, &input).unwrap().status, 200);
            commit_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let after: String = c.query_row("SELECT document FROM workbench_state", [], |r| r.get(0)).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(after.as_bytes())), hash);
        let report = json!({"measurement":"actual Rust debug functions on isolated copy, excludes network and UI", "statusMs":status_ms,"authorizationMs":authorization_ms,"loadMs":load_ms,"loadResponseBytes":load_bytes,"metadataCommitMs":commit_ms,"canonicalSha256Unchanged":hash});
        fs::write(root.join("rust-benchmark.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("{}", report);
    }

    #[test]
    fn status_sql_tracks_pending_conflicts_and_revision_without_materializing_state() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let mut doc = document();
        doc["localRevision"] = json!(7);
        doc["outbox"] = json!([push()]);
        doc["records"][0]["conflict"] = json!({"remote":{"id":"a"}});
        c.execute(
            "UPDATE workbench_cloud_state SET document=?1",
            [doc.to_string()],
        )
        .unwrap();
        let before = status(&store).unwrap();
        assert_eq!(before["uncertain"], 1);
        assert_eq!(before["conflicts"], 1);
        assert_eq!(before["localChangesPending"], false);
        assert!(before.get("records").is_none());
        save_state(
            &store,
            &json!({"baseRevision":7,"configs":[{"id":"a","name":"local-edit","parts":[]}]}),
        )
        .unwrap();
        assert_eq!(status(&store).unwrap()["localChangesPending"], true);
    }

    #[test]
    fn sends_only_saved_identical_outbox_and_rejects_invalid_batches() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let mut doc = document();
        doc["outbox"] = json!([push()]);
        c.execute(
            "UPDATE workbench_cloud_state SET document=?1",
            [doc.to_string()],
        )
        .unwrap();
        assert!(authorize(&store, &owner(), Some(&push())).is_ok());
        let batch =
            json!({"protocolVersion":2,"action":"sync.pushBatch","payload":{"requests":[push()]}});
        assert!(authorize(&store, &owner(), Some(&batch)).is_ok());
        let mut changed = push();
        changed["payload"]["after"]["name"] = json!("changed-in-flight");
        assert!(authorize(&store, &owner(), Some(&changed)).is_err());
        assert!(
            authorize(
                &store,
                &json!({"uid":"other","workspaceId":"w"}),
                Some(&push())
            )
            .is_err()
        );
        for rows in [json!([]), json!([push(), push()]), json!(vec![push(); 51])] {
            assert!(
                authorize(
                    &store,
                    &owner(),
                    Some(&json!({"action":"sync.pushBatch","payload":{"requests":rows}}))
                )
                .is_err()
            );
        }
    }

    #[test]
    fn plan_preview_apply_backup_and_original_sha_are_atomic() {
        let store = fixture();
        let plan = fresh_plan(&store);
        let hash = raw_hash(&plan);
        assert_ne!(
            hash,
            format!("{:x}", Sha256::digest(plan.to_string().as_bytes()))
        );
        assert_eq!(
            preview_plan(&store, &plan, &owner()).unwrap()["afterConfigs"],
            1
        );
        let c = db(&store.path).unwrap();
        assert_eq!(state(&c).unwrap()["revision"], 7);
        assert!(stored(&c).unwrap().1.is_null());
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
        let result: Value =
            serde_json::from_str(&apply_plan(&store, &plan, &owner(), &hash).unwrap().body)
                .unwrap();
        assert_eq!(result["revision"], 8);
        assert_eq!(result["uploaded"], false);
        assert_eq!(state(&c).unwrap()["configs"][0]["name"], "merged-plan");
        assert_eq!(stored(&c).unwrap().1["localRevision"], 8);
        let backup: Value =
            serde_json::from_slice(&fs::read(result["backup"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(backup["state"]["configs"][0]["name"], "old");
        assert_eq!(backup["state"]["revision"], 7);
        assert_eq!(backup["planHash"], hash);
        assert!(apply_plan(&store, &plan, &owner(), &hash).is_err());
    }

    #[test]
    fn stale_plan_or_wrong_member_never_changes_native_state() {
        let store = fixture();
        let plan = fresh_plan(&store);
        let hash = raw_hash(&plan);
        assert!(preview_plan(&store, &plan, &json!({"uid":"other","workspaceId":"w"})).is_err());
        let mut wrong_hash = plan.clone();
        wrong_hash["nativeTargetStateSha256"] = json!("0".repeat(64));
        assert!(apply_plan(&store, &wrong_hash, &owner(), &hash).is_err());
        save_state(
            &store,
            &json!({"baseRevision":7,"configs":[{"id":"a","name":"new-input","parts":[]}]}),
        )
        .unwrap();
        assert!(apply_plan(&store, &plan, &owner(), &hash).is_err());
        let c = db(&store.path).unwrap();
        assert_eq!(state(&c).unwrap()["configs"][0]["name"], "new-input");
        assert!(stored(&c).unwrap().1.is_null());
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
    }

    #[test]
    fn failed_plan_cloud_insert_rolls_back_state_history_and_activity() {
        let store = fixture();
        let plan = fresh_plan(&store);
        let hash = raw_hash(&plan);
        let c = db(&store.path).unwrap();
        let history: i64 = c
            .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
            .unwrap();
        let activity: i64 = c
            .query_row("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
            .unwrap();
        c.execute_batch("CREATE TRIGGER reject_plan BEFORE INSERT ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(apply_plan(&store, &plan, &owner(), &hash).is_err());
        assert_eq!(state(&c).unwrap()["revision"], 7);
        assert_eq!(state(&c).unwrap()["configs"][0]["name"], "old");
        assert!(stored(&c).unwrap().1.is_null());
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
                .unwrap(),
            history
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
                .unwrap(),
            activity
        );
        assert!(
            store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
    }

    fn patch_input(store: &WorkbenchStore, patch: Value) -> Value {
        let c = db(&store.path).unwrap();
        json!({"baseRevision":state(&c).unwrap()["revision"],"cloudVersion":stored(&c).unwrap().0,"documentPatch":patch})
    }
    #[test]
    fn metadata_patch_omitting_state_preserves_raw_state_and_all_local_history() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let raw_before: String = c
            .query_row("SELECT document FROM workbench_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let history: i64 = c
            .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
            .unwrap();
        let activity: i64 = c
            .query_row("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
            .unwrap();
        // Deliberately contains invalid business JSON to prove that metadata-only
        // commits do not parse/validate/normalize or rewrite the workbench state.
        let raw_header_only =
            "{\"revision\":7,\"updatedAt\":\"original-time\",\"configs\":\"untouched-fixture\"}";
        c.execute("UPDATE workbench_state SET document=?1", [raw_header_only])
            .unwrap();
        let input = json!({"baseRevision":7,"cloudVersion":1,"documentPatch":{"set":{"lastSyncedAt":"new-time"},"records":[]}});
        let result: Value = serde_json::from_str(&commit(&store, &input).unwrap().body).unwrap();
        assert_eq!(result["revision"], 7);
        assert_eq!(result["updatedAt"], "original-time");
        assert_eq!(result["cloudVersion"], 2);
        assert_eq!(
            c.query_row::<String, _, _>(
                "SELECT document FROM workbench_state WHERE id=1",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            raw_header_only
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
                .unwrap(),
            history
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_activity", [], |r| r.get(0))
                .unwrap(),
            activity
        );
        let (_, saved) = stored(&c).unwrap();
        assert_eq!(saved["lastSyncedAt"], "new-time");
        assert_eq!(saved["localRevision"], 7);
        assert_eq!(saved["records"], document()["records"]);
        assert_eq!(
            saved["materializedProjection"],
            document()["materializedProjection"]
        );
        c.execute("UPDATE workbench_state SET document=?1", [raw_before])
            .unwrap();
        let input = patch_input(&store, json!({"set":{"cursor":6}}));
        assert_eq!(commit(&store, &input).unwrap().status, 200);
        assert_eq!(commit(&store, &input).unwrap().status, 409);
    }
    #[test]
    fn record_patch_replaces_adds_by_key_and_does_not_modify_untouched_records() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let mut changed = document()["records"][0].clone();
        changed["draft"]["name"] = json!("new-draft");
        let added = json!({"type":"configuration","id":"b","version":0,"base":null,"draft":{"id":"b","name":"new"},"conflict":null});
        let input = patch_input(
            &store,
            json!({"set":{},"records":[changed.clone(),added.clone()]}),
        );
        assert_eq!(commit(&store, &input).unwrap().status, 200);
        let (_, saved) = stored(&c).unwrap();
        assert_eq!(saved["records"], json!([changed, added]));
        let update = patch_input(&store, json!({"set":{"lastSyncedAt":"later"}}));
        commit(&store, &update).unwrap();
        assert_eq!(stored(&c).unwrap().1["records"], saved["records"]);
    }
    #[test]
    fn patch_rejects_identity_changes_unknown_fields_duplicates_and_immutable_outbox_changes() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let mut old = document();
        old["outbox"] = json!([push()]);
        c.execute(
            "UPDATE workbench_cloud_state SET document=?1",
            [old.to_string()],
        )
        .unwrap();
        for key in ["uid", "workspaceId", "deviceId"] {
            let mut set = json!({});
            set[key] = json!("other");
            assert!(commit(&store, &patch_input(&store, json!({"set":set}))).is_err());
        }
        for key in [
            "records",
            "__proto__",
            "constructor",
            "prototype",
            "localRevision",
            "accessToken",
            "sourceSnapshotSha256",
        ] {
            let mut set = json!({});
            set[key] = json!({});
            assert!(commit(&store, &patch_input(&store, json!({"set":set}))).is_err());
        }
        assert!(commit(&store, &patch_input(&store, json!({"set":{"cursor":4}}))).is_err());
        assert!(
            commit(
                &store,
                &patch_input(
                    &store,
                    json!({"removeRecords":[{"type":"configuration","id":"a"}]})
                )
            )
            .is_err()
        );
        assert!(
            commit(
                &store,
                &patch_input(
                    &store,
                    json!({"records":[old["records"][0],old["records"][0]]})
                )
            )
            .is_err()
        );
        let mut changed = push();
        changed["payload"]["after"]["name"] = json!("illegal-change");
        assert!(
            commit(
                &store,
                &patch_input(&store, json!({"set":{"outbox":[changed]}}))
            )
            .is_err()
        );
        assert_eq!(stored(&c).unwrap().0, 1);
        assert_eq!(stored(&c).unwrap().1, old);
        let mut both = patch_input(&store, json!({}));
        both["document"] = old;
        assert!(commit(&store, &both).is_err());
    }
    #[test]
    fn patch_with_full_state_remains_atomic_and_queue_failure_rolls_everything_back() {
        let store = fixture();
        let c = db(&store.path).unwrap();
        let before = state(&c).unwrap();
        let mut input = patch_input(&store, json!({"set":{"cursor":6}}));
        let mut after = before.clone();
        after["configs"][0]["name"] = json!("cloud-arrival");
        input["state"] = after;
        c.execute_batch("CREATE TRIGGER reject_patch BEFORE UPDATE ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(commit(&store, &input).is_err());
        assert_eq!(state(&c).unwrap(), before);
        assert_eq!(stored(&c).unwrap().0, 1);
        c.execute_batch("DROP TRIGGER reject_patch").unwrap();
        assert_eq!(commit(&store, &input).unwrap().status, 200);
        assert_eq!(state(&c).unwrap()["revision"], 8);
        assert_eq!(stored(&c).unwrap().1["localRevision"], 8);
        assert_eq!(stored(&c).unwrap().1["cursor"], 6);
    }

    #[test]
    #[ignore = "Requires an explicitly selected frozen private plan; writes an isolated copy only"]
    fn real_frozen_plan_import_reopen_probe() {
        let run = PathBuf::from(
            std::env::var_os("DIYTOOLS_CLOUD_PREFLIGHT_DIR").expect("select frozen plan directory"),
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(run.join("input-manifest.json")).unwrap()).unwrap();
        let source = PathBuf::from(manifest["newSnapshot"]["snapshot"].as_str().unwrap());
        let input_hash = format!("{:x}", Sha256::digest(fs::read(&source).unwrap()));
        assert_eq!(input_hash, manifest["newSnapshot"]["snapshotSha256"]);
        let bytes = fs::read(run.join("bootstrap-plan.json")).unwrap();
        let plan_hash = format!("{:x}", Sha256::digest(&bytes));
        let expected_plan_hash = std::env::var("DIYTOOLS_CLOUD_PREFLIGHT_SHA256")
            .unwrap_or_else(|_| "3670265f59aa8e1d16d8865835caf430a8e906967d72df42688ec0939ad13ca5".into());
        assert_eq!(plan_hash, expected_plan_hash);
        let plan: Value = serde_json::from_slice(&bytes).unwrap();
        drop(bytes);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/windows-acceptance-20261013/cloud-plan-native-probe")
            .join(unique());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("workbench.sqlite");
        fs::copy(&source, &path).unwrap();
        let store = WorkbenchStore {
            path: path.clone(),
            assets: root.join("assets"),
        };
        let summary = preview_plan(&store, &plan, &plan["member"]).unwrap();
        let result: Value = serde_json::from_str(
            &apply_plan(&store, &plan, &plan["member"], &plan_hash)
                .unwrap()
                .body,
        )
        .unwrap();
        assert_eq!(result["uploaded"], false);
        let c = db(&path).unwrap();
        assert_eq!(
            c.query_row::<String, _, _>("PRAGMA quick_check", [], |r| r.get(0))
                .unwrap(),
            "ok"
        );
        let actual = state(&c).unwrap();
        for (key, value) in plan["state"].as_object().unwrap() {
            if !["revision", "updatedAt", "logs"].contains(&key.as_str()) {
                assert_eq!(actual.get(key), Some(value), "field {key}");
            }
        }
        assert_eq!(
            actual["revision"].as_i64(),
            Some(plan["nativeBaseRevision"].as_i64().unwrap() + 1)
        );
        let (version, doc) = stored(&c).unwrap();
        assert_eq!(version, 1);
        assert_eq!(doc["records"], plan["records"]);
        assert_eq!(doc["outbox"], plan["outbox"]);
        assert_eq!(doc["cursor"], plan["cursor"]);
        drop(doc);
        drop(actual);
        drop(c);
        let reopened = status(&store).unwrap();
        assert_eq!(reopened["localChangesPending"], false);
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(&source).unwrap())),
            input_hash
        );
        let evidence = json!({"status":"verified-isolated-only","planSha256":plan_hash,"sourceSha256Unchanged":input_hash,"preview":summary,
            "revision":result["revision"],"cloudVersion":reopened["cloudVersion"],"cursor":reopened["cursor"],"backup":result["backup"],"uploaded":false,"realAuthenticationVerified":false});
        write_new(
            &root.join("verification.json"),
            evidence.to_string().as_bytes(),
        )
        .unwrap();
        println!(
            "isolated cloud plan probe evidence: {}",
            root.join("verification.json").display()
        );
    }
}
