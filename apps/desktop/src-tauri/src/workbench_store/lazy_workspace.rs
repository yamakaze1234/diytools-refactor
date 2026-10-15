// 按需加载存储：配置实体是权威数据；列表投影可清理，单套编辑只写目标实体与根版本。
//! Configuration entities remain authoritative; summaries are rebuildable caches.
use super::*;

const SUMMARY_FIELDS: &[&str] = &[
    "id", "shopId", "shop", "productId", "product", "productUrl", "spu",
    "productCategory", "productCardColor", "name", "version", "shortName",
    "skuId", "installment", "deletedAt", "workspaceOrder", "emptyLinkDraft",
    "price", "updatedAt", "isTemplate", "templateId",
];
// 只投影列表展示和筛选需要的字段，未包含字段仍保留在完整配置正文中。
fn summary(row: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in SUMMARY_FIELDS {
        if let Some(value) = row.get(*key) { result.insert((*key).into(), value.clone()); }
    }
    let parts: Vec<Value> = row["parts"].as_array().into_iter().flatten().map(|part| {
        let mut projected = serde_json::Map::new();
        for key in ["slot", "name", "qty", "goodsId"] {
            if let Some(value) = part.get(key) { projected.insert(key.into(), value.clone()); }
        }
        Value::Object(projected)
    }).collect();
    result.insert("parts".into(), json!(parts));
    if let Some(line) = row.get("wpsImport").and_then(|v| v.get("lineStart")) {
        result.insert("wpsImport".into(), json!({"lineStart":line}));
    }
    Value::Object(result)
}
// 读取根元数据时排除 configs/logs，列表启动不构造整库配置和日志对象。
fn metadata(c: &Connection) -> Result<Value> {
    let raw: String = c.query_row("SELECT json_remove(document,'$.configs','$.logs') FROM workbench_metadata WHERE id=1", [], |r|r.get(0)).map_err(|e|e.to_string())?;
    serde_json::from_str(&raw).map_err(|e|e.to_string())
}
// 用数据库触发器让小型版本头与正文同事务更新，单套加载无需解析整份主 JSON。
pub(super) fn initialize_projection(tx: &Transaction) -> Result<()> {
    // All writers (including full saves and cloud commits) update this tiny
    // header in the same SQLite transaction as the authoritative document.
    // Storing JSON text preserves missing vs null and exact numeric values.
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_state_header(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT,updated_at TEXT);
        CREATE TRIGGER IF NOT EXISTS workbench_state_header_insert AFTER INSERT ON workbench_metadata BEGIN
          INSERT OR REPLACE INTO workbench_state_header VALUES(NEW.id,NEW.document -> '$.revision',NEW.document -> '$.updatedAt'); END;
        CREATE TRIGGER IF NOT EXISTS workbench_state_header_update AFTER UPDATE OF document ON workbench_metadata BEGIN
          INSERT OR REPLACE INTO workbench_state_header VALUES(NEW.id,NEW.document -> '$.revision',NEW.document -> '$.updatedAt'); END;
        CREATE TRIGGER IF NOT EXISTS workbench_state_header_delete AFTER DELETE ON workbench_metadata BEGIN
          DELETE FROM workbench_state_header WHERE id=OLD.id; END;
        CREATE TABLE IF NOT EXISTS workbench_config_projection(id TEXT PRIMARY KEY,position INTEGER NOT NULL UNIQUE,document TEXT NOT NULL,summary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workbench_config_projection_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO workbench_state_header SELECT id,document -> '$.revision',document -> '$.updatedAt' FROM workbench_metadata WHERE id=1 AND NOT EXISTS(SELECT 1 FROM workbench_state_header WHERE id=1);").map_err(|e|e.to_string())?;
    Ok(())
}
// JSON 文本形式保留字段缺失、显式 null 和数字原文，兼容逆向历史的精确恢复。
fn header(c: &Connection) -> Result<Value> {
    // -> preserves JSON types/number text and distinguishes an absent key
    // (SQL NULL) from an explicit JSON null, as required by inverse history.
    let (revision, updated): (Option<String>, Option<String>) = c.query_row(
        "SELECT revision,updated_at FROM workbench_state_header WHERE id=1", [], |r|Ok((r.get(0)?,r.get(1)?))
    ).map_err(|e|e.to_string())?;
    let mut result=serde_json::Map::new();
    for (key,raw) in [("revision",revision),("updatedAt",updated)] {
        if let Some(raw)=raw {result.insert(key.into(),serde_json::from_str(&raw).map_err(|e|e.to_string())?);}
    }
    Ok(Value::Object(result))
}
// 仅版本不匹配时逐套重建投影，避免为展示列表在 Rust 内存展开整库。
fn ensure_projection(tx: &Transaction, revision: i64) -> Result<()> {
    let cached: Option<i64> = tx.query_row("SELECT revision FROM workbench_config_projection_meta WHERE id=1", [], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if cached == Some(revision) { return Ok(()); }
    tx.execute("DELETE FROM workbench_config_projection", []).map_err(|e|e.to_string())?;
    // json_each returns one serialized object at a time. Never create an owned
    // serde tree for the whole workspace merely to show a list.
    let mut source = tx.prepare("SELECT position,document FROM workbench_configs ORDER BY position").map_err(|e|e.to_string())?;
    let mut insert = tx.prepare("INSERT INTO workbench_config_projection VALUES(?1,?2,?3,?4)").map_err(|e|e.to_string())?;
    let rows = source.query_map([], |r|Ok((r.get::<_, i64>(0)?,r.get::<_, String>(1)?))).map_err(|e|e.to_string())?;
    for item in rows {
        let (position, raw) = item.map_err(|e|e.to_string())?;
        let row: Value = serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let id = row["id"].as_str().filter(|id|!id.is_empty()).ok_or("配置 ID 无效")?;
        insert.execute(params![id,position,raw,summary(&row).to_string()]).map_err(|e|e.to_string())?;
    }
    tx.execute("INSERT OR REPLACE INTO workbench_config_projection_meta VALUES(1,?1)", [revision]).map_err(|e|e.to_string())?;
    Ok(())
}
// 在同一事务返回根元数据和按原顺序排列的摘要，保证前端加载基线一致。
pub(super) fn index(store: &WorkbenchStore) -> Result<ApiResponse> {
    let mut c = db(&store.path)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let meta = metadata(&tx)?;
    ensure_projection(&tx,revision(&meta))?;
    let summaries = {
        let mut q = tx.prepare("SELECT summary FROM workbench_config_projection ORDER BY position").map_err(|e|e.to_string())?;
        q.query_map([], |r|r.get::<_,String>(0)).map_err(|e|e.to_string())?
            .map(|r|serde_json::from_str::<Value>(&r.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<_>>>()?
    };
    let result = json!({"revision":meta["revision"],"updatedAt":meta["updatedAt"],"metadata":meta,"summaries":summaries});
    tx.commit().map_err(|e|e.to_string())?;
    Ok(response(200,result))
}
// 按点击传入的 1 至 64 个 ID 读取详情，版本不一致返回冲突，避免混用旧摘要与新正文。
pub(super) fn load(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let ids = input["ids"].as_array().filter(|v|!v.is_empty() && v.len()<=64).ok_or("每次加载 1 至 64 套配置")?;
    let requested = input["revision"].as_i64().ok_or("加载基线版本无效")?;
    let mut unique = HashSet::new();
    for id in ids { if !id.is_string() || id.as_str()==Some("") || !unique.insert(id.as_str()) {return Ok(failure(400,"配置 ID 无效或重复"));} }
    let mut c = db(&store.path)?;
    // 普通详情读取只建立一致性快照，不预占写锁，因此后台保存不会被单套浏览阻塞。
    let tx = c.transaction_with_behavior(TransactionBehavior::Deferred).map_err(|e|e.to_string())?;
    let meta = header(&tx)?;
    if requested!=revision(&meta) {return Ok(failure(409,"配置列表已更新，请重新加载列表后重试"));}
    // 详情直接读取权威实体；清理列表缓存不会让单套打开退化为全库重建。
    let mut configs=Vec::new();
    for id in ids {
        let raw: Option<String> = tx.query_row("SELECT document FROM workbench_configs WHERE id=?1", [id.as_str().unwrap()], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let Some(raw)=raw else {return Ok(failure(404,"配置不存在，请刷新列表"));};
        configs.push(serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string())?);
    }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(response(200,json!({"revision":requested,"configs":configs})))
}

// 单套编辑带完整基线和结果；无重叠修改可三方合并，冲突时整个批次不落盘。
pub(super) fn save_patch(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    if input["mode"]!="ordinary" {return Ok(failure(400,"配置增量模式无效"));}
    let operation=input["operationId"].as_str().filter(|v|!v.is_empty()&&v.len()<=200).ok_or("操作 ID 无效")?;
    let rows=input["changes"].as_array().filter(|v|!v.is_empty()&&v.len()<=64).ok_or("每次保存 1 至 64 套配置")?;
    let base_revision=input["baseRevision"].as_i64().filter(|v|*v>=0).ok_or("保存基线版本无效")?;
    let hash=format!("{:x}",Sha256::digest(input.to_string().as_bytes()));
    let mut c=db(&store.path)?;
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let before=header(&tx)?;
    let replay:Option<(String,String)>=tx.query_row("SELECT hash,document FROM workbench_receipts WHERE operation=?1",[operation],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    // 重试先查持久回执；同一操作 ID 若换了内容必须拒绝，不能再次执行或错认成功。
    if let Some((old,raw))=replay {
        if old!=hash{return Ok(failure(409,"操作 ID 已用于其他内容"));}
        let mut receipt:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        if receipt["revision"]!=before["revision"] {receipt["rebased"]=json!(true);}
        return Ok(response(200,receipt));
    }
    if base_revision>revision(&before){return Ok(failure(409,"保存基线版本无效"));}
    let cached: Option<i64> = tx.query_row("SELECT revision FROM workbench_config_projection_meta WHERE id=1", [], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let rebased=base_revision!=revision(&before);
    let mut seen=HashSet::new();let mut saved=Vec::new();let mut changes=Vec::new();let mut patches=Vec::new();
    for change in rows {
        let id=change["id"].as_str().filter(|v|!v.is_empty()).ok_or("配置 ID 无效")?;
        if !seen.insert(id){return Ok(failure(400,"配置 ID 重复"));}
        let record:Option<(i64,String)>=tx.query_row("SELECT position,document FROM workbench_configs WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let Some((position,raw))=record else{return Ok(failure(409,"目标配置已删除或不存在"));};
        let current:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        if current.get("deletedAt").is_some_and(|v|!v.is_null()&&v!=""){return Ok(failure(409,"目标配置已删除或不存在"));}
        let base=&change["base"];let desired=&change["after"];
        if !base.is_object()||!desired.is_object()||base["id"]!=id||desired["id"]!=id||base["__workbenchSummary"]==true||desired["__workbenchSummary"]==true {return Ok(failure(400,"保存需要完整配置基线和结果"));}
        // This endpoint is a complete single-configuration edit, including
        // normalization and future/unknown fields. Identity/move/delete stay
        // separate from edits, and every field still passes the same merge.
        if !rebased&&!same_json(base,&current){return Ok(failure(409,"配置基线与当前版本不一致"));}
        if base["shopId"]!=desired["shopId"]||base["productId"]!=desired["productId"]||base["shopId"]!=current["shopId"]||base["productId"]!=current["productId"]||desired.get("deletedAt").is_some_and(|v|!v.is_null()&&v!=""){return Ok(failure(409,"增量操作不可删除或移动配置"));}
        // 只有不重叠字段可以自动合并；同字段双方变化返回 409，整批事务随之回滚。
        let merged=match merge_configuration(Some(base),Some(desired),Some(&current)){Ok(Some(v))=>v,_=>return Ok(failure(409,"同一字段已被修改，请重新预览"))};
        if merged.get("actualParts").is_some_and(|v|!v.is_null()&&!v.is_array()){return Ok(failure(400,"实际配置格式无效"));}
        if merged!=current {changes.push(json!({"id":id,"before":current,"after":merged}));patches.push((position,id.to_owned(),merged.to_string(),summary(&merged).to_string()));}
        saved.push(merged);
    }
    let unchanged=changes.is_empty();let mut after=before.clone();let mut activity=Vec::new();
    if !unchanged {
        let order={let mut q=tx.prepare("SELECT id FROM workbench_configs ORDER BY position").map_err(|e|e.to_string())?;
            q.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.map(|r|r.map(Value::String).map_err(|e|e.to_string())).collect::<Result<Vec<_>>>()?};
        let delta=batch_delta(before.get("revision").cloned(),before.get("updatedAt").cloned(),&mut after,changes,order,now());
        // 只更新变化的配置行；根元数据不再携带 configs，写放大与配置总数无关。
        for (_,id,raw,summary) in &patches {
            tx.execute("UPDATE workbench_configs SET document=?1 WHERE id=?2",params![raw,id]).map_err(|e|e.to_string())?;
            if cached == Some(revision(&before)) {
                tx.execute("UPDATE workbench_config_projection SET document=?1,summary=?2 WHERE id=?3",params![raw,summary,id]).map_err(|e|e.to_string())?;
            }
        }
        tx.execute("UPDATE workbench_metadata SET document=json_set(document,'$.revision',?1,'$.updatedAt',?2) WHERE id=1",params![revision(&after),after["updatedAt"].as_str()]).map_err(|e|e.to_string())?;
        if cached == Some(revision(&before)) {
            tx.execute("UPDATE workbench_config_projection_meta SET revision=?1 WHERE id=1",[revision(&after)]).map_err(|e|e.to_string())?;
        }
        tx.execute("INSERT INTO workbench_history(at,revision,document) VALUES(?1,?2,?3)",params![after["updatedAt"].as_str(),revision(&after),delta.to_string()]).map_err(|e|e.to_string())?;
        for change in delta["configs"].as_array().unwrap() {
            let record=&change["after"];
            let entry=json!({"id":unique(),"at":after["updatedAt"],"operator":input["operator"].as_str().unwrap_or("本机操作员"),"origin":"local","message":input["message"].as_str().unwrap_or("保存配置"),"summary":record["name"],"target":{"type":"configuration","id":change["id"],"shopId":record["shopId"]}});
            tx.execute("INSERT INTO workbench_activity(document) VALUES(?1)",[entry.to_string()]).map_err(|e|e.to_string())?;activity.push(entry);
        }
        activity.reverse();
    }
    let receipt=json!({"operationId":operation,"revision":after["revision"],"updatedAt":after["updatedAt"],"configs":saved,"activityDelta":activity,"rebased":rebased,"unchanged":unchanged});
    tx.execute("INSERT INTO workbench_receipts VALUES(?1,?2,?3)",params![operation,hash,receipt.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(response(200,receipt))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->WorkbenchStore {
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/lazy-store-tests").join(unique());fs::create_dir_all(&root).unwrap();
        let source=root.join("source.json");
        fs::write(&source,json!({"revision":7,"updatedAt":"old","mystery":{"hugeId":"1234567890123456789"},"configs":[{"id":"a","shopId":"intel","productId":"p","product":"P","name":"配置2","price":10,"parts":[{"slot":"CPU","name":"cpu","tax":7}],"actualParts":[],"unknown":{"precision":1.23456789},"modules":[]},{"id":"b","shopId":"intel","productId":"p","name":"配置1","parts":[],"actualParts":[],"modules":[]}],"templates":[],"logs":[{"id":"archive","at":"2026-10-13T00:00:00Z","private":"unchanged"}]}).to_string()).unwrap();
        initialize(&root.join("workbench.sqlite"),&source,&root.join("assets")).unwrap()
    }
    fn decode(r:ApiResponse)->Value{assert_eq!(r.status,200,"{}",r.body);serde_json::from_str(&r.body).unwrap()}
    fn patch(_s:&WorkbenchStore,base:Value,field:&str,value:Value,operation:&str,rev:i64)->Value {
        let mut desired=base.clone();desired[field]=value;
        json!({"mode":"ordinary","operationId":operation,"baseRevision":rev,"changes":[{"id":base["id"],"base":base,"after":desired}]})
    }
    #[test]
    fn projection_is_bounded_and_revision_coherent(){
        let s=fixture();let initial=state(&db(&s.path).unwrap()).unwrap();let index=decode(index(&s).unwrap());
        assert!(index["metadata"].get("configs").is_none());assert!(index["metadata"].get("logs").is_none());
        assert!(index["summaries"][0]["parts"][0].get("tax").is_none());assert!(index["summaries"][0].get("actualParts").is_none());
        assert_eq!(decode(load(&s,&json!({"ids":["a"],"revision":7})).unwrap())["configs"][0],initial["configs"][0]);
        assert_eq!(load(&s,&json!({"ids":["a"],"revision":6})).unwrap().status,409);
        assert_eq!(state(&db(&s.path).unwrap()).unwrap(),initial);
    }
    #[test]
    fn patch_preserves_other_rows_unknowns_history_and_replays(){
        let s=fixture();let before=state(&db(&s.path).unwrap()).unwrap();
        let payload=patch(&s,before["configs"][0].clone(),"price",json!(20),"one",7);
        let receipt=decode(save_patch(&s,&payload).unwrap());assert_eq!(receipt["revision"],8);
        let c=db(&s.path).unwrap();let after=state(&c).unwrap();assert_eq!(after["configs"][1],before["configs"][1]);assert_eq!(after["mystery"],before["mystery"]);assert_eq!(after["configs"][0]["unknown"],before["configs"][0]["unknown"]);
        let delta_raw:String=c.query_row("SELECT document FROM workbench_history ORDER BY sequence DESC LIMIT 1",[],|r|r.get(0)).unwrap();let delta:Value=serde_json::from_str(&delta_raw).unwrap();assert_eq!(delta["configs"][0]["before"],before["configs"][0]);assert_eq!(delta["orderBefore"],json!(["a","b"]));
        assert_eq!(decode(save_patch(&s,&payload).unwrap()),receipt);assert_eq!(state(&c).unwrap(),after);
        assert_eq!(decode(index(&s).unwrap())["summaries"][0]["price"],20);
    }
    #[test]
    fn stale_nonoverlap_merges_but_same_field_conflicts_atomically(){
        let s=fixture();let before=state(&db(&s.path).unwrap()).unwrap();let base=before["configs"][0].clone();
        decode(save_patch(&s,&patch(&s,base.clone(),"price",json!(20),"first",7)).unwrap());
        let nonoverlap=decode(save_patch(&s,&patch(&s,base.clone(),"name",json!("changed"),"second",7)).unwrap());assert_eq!(nonoverlap["configs"][0]["price"],20);assert_eq!(nonoverlap["rebased"],true);
        let current=state(&db(&s.path).unwrap()).unwrap();
        assert_eq!(save_patch(&s,&patch(&s,base,"price",json!(30),"conflict",7)).unwrap().status,409);assert_eq!(state(&db(&s.path).unwrap()).unwrap(),current);
    }
    #[test]
    fn foreign_full_save_invalidates_projection_and_partial_payload_is_rejected(){
        let s=fixture();decode(index(&s).unwrap());let mut before=state(&db(&s.path).unwrap()).unwrap();before["configs"][0]["name"]=json!("remote");before["revision"]=json!(8);
        entities::replace_fixture(&db(&s.path).unwrap(), &before);
        assert_eq!(decode(index(&s).unwrap())["summaries"][0]["name"],"remote");
        let mut partial=before["configs"][0].clone();partial["__workbenchSummary"]=json!(true);
        assert_eq!(save_patch(&s,&patch(&s,partial,"price",json!(50),"bad",8)).unwrap().status,400);
    }
    #[test]
    fn failed_second_change_rolls_back_every_target(){
        let s=fixture();let before=state(&db(&s.path).unwrap()).unwrap();let mut payload=patch(&s,before["configs"][0].clone(),"price",json!(20),"atomic",7);
        payload["changes"].as_array_mut().unwrap().push(json!({"id":"missing","base":{"id":"missing"},"after":{"id":"missing"}}));
        assert_eq!(save_patch(&s,&payload).unwrap().status,409);assert_eq!(state(&db(&s.path).unwrap()).unwrap(),before);
    }
    #[test]
    fn inverse_history_preserves_missing_and_null_root_metadata(){
        for explicit_null in [false,true] {
            let s=fixture();let c=db(&s.path).unwrap();let mut before=state(&c).unwrap();
            for key in ["revision","updatedAt"] {if explicit_null {before[key]=Value::Null;}else{before.as_object_mut().unwrap().remove(key);}}
            entities::replace_fixture(&c, &before);
            let initial:i64=c.query_row("SELECT MAX(sequence) FROM workbench_history",[],|r|r.get(0)).unwrap();
            decode(save_patch(&s,&patch(&s,before["configs"][0].clone(),"price",json!(20),"presence",0)).unwrap());
            assert_eq!(reconstruct(&c,initial).unwrap(),before);
        }
    }
    #[test]
    fn sqlite_failure_rolls_back_state_projection_receipt_and_history(){
        let s=fixture();decode(index(&s).unwrap());let c=db(&s.path).unwrap();let before=state(&c).unwrap();
        c.execute_batch("CREATE TRIGGER deny_history BEFORE INSERT ON workbench_history BEGIN SELECT RAISE(ABORT,'test history failure'); END;").unwrap();
        assert!(save_patch(&s,&patch(&s,before["configs"][0].clone(),"price",json!(30),"rollback",7)).is_err());
        assert_eq!(state(&c).unwrap(),before);assert_eq!(decode(index(&s).unwrap())["summaries"][0]["price"],10);
        assert_eq!(c.query_row::<i64,_,_>("SELECT COUNT(*) FROM workbench_receipts",[],|r|r.get(0)).unwrap(),0);
    }
    #[test]
    fn detail_read_uses_committed_snapshot_without_waiting_for_writer(){
        let s=fixture();decode(index(&s).unwrap());let mut writer=db(&s.path).unwrap();
        let tx=writer.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
        // 未提交的实体和版本头须保持在同一事务中。
        tx.execute("UPDATE workbench_metadata SET document=json_set(document,'$.revision',8) WHERE id=1",[]).unwrap();
        tx.execute("UPDATE workbench_configs SET document=json_set(document,'$.name','uncommitted') WHERE id='a'",[]).unwrap();
        let started=std::time::Instant::now();
        let loaded=decode(load(&s,&json!({"ids":["a"],"revision":7})).unwrap());
        assert_eq!(loaded["configs"][0]["name"],"配置2");
        assert!(started.elapsed()<Duration::from_secs(2),"detail read waited for the writer");
        tx.commit().unwrap();
        assert_eq!(load(&s,&json!({"ids":["a"],"revision":7})).unwrap().status,409);
        // No index refresh in between: detail load rebuilds a stale projection
        // under its own write transaction and returns the new complete object.
        assert_eq!(decode(load(&s,&json!({"ids":["a"],"revision":8})).unwrap())["configs"][0]["name"],"uncommitted");
    }
    #[test]
    fn header_migration_and_all_writes_preserve_exact_presence_atomically(){
        let s=fixture();let mut c=db(&s.path).unwrap();
        c.execute_batch("DROP TRIGGER workbench_state_header_insert;DROP TRIGGER workbench_state_header_update;DROP TRIGGER workbench_state_header_delete;DROP TABLE workbench_state_header;").unwrap();
        let before=state(&c).unwrap();
        let tx=c.transaction().unwrap();initialize_projection(&tx).unwrap();tx.commit().unwrap();
        assert_eq!(header(&c).unwrap(),json!({"revision":7,"updatedAt":"old"}));
        assert_eq!(state(&c).unwrap(),before);
        let tx=c.transaction().unwrap();
        tx.execute("UPDATE workbench_metadata SET document=?1",[r#"{"revision":1234567890123456789,"updatedAt":null}"#]).unwrap();
        assert_eq!(header(&tx).unwrap(),serde_json::from_str::<Value>(r#"{"revision":1234567890123456789,"updatedAt":null}"#).unwrap());
        tx.rollback().unwrap();
        assert_eq!(header(&c).unwrap(),json!({"revision":7,"updatedAt":"old"}));
        c.execute("DELETE FROM workbench_metadata",[]).unwrap();
        assert!(header(&c).is_err());
        c.execute("INSERT INTO workbench_metadata VALUES(1,'{}')",[]).unwrap();
        assert_eq!(header(&c).unwrap(),json!({}));
    }
}
