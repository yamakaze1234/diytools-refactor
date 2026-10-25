//! 本机店铺卸载：正文与同步基线一起移除，不创建云端删除记录。
use super::*;

const SHOPS: [&str; 3] = ["intel", "gigabyte", "jonsbo"];

fn selected(input: &Value) -> Result<Vec<String>> {
    let values = input["shopIds"].as_array().ok_or("请选择店铺")?;
    if values.is_empty() || values.len() > SHOPS.len() { return Err("请选择有效店铺".into()); }
    let mut ids = Vec::new();
    for value in values {
        let id = value.as_str().filter(|id| SHOPS.contains(id)).ok_or("店铺无效")?;
        if ids.iter().any(|v| v == id) { return Err("店铺重复".into()); }
        ids.push(id.to_string());
    }
    ids.sort();
    Ok(ids)
}

fn owns(row: &Value, ids: &[String]) -> bool {
    if let Some(kind) = row["type"].as_str() { if !["configuration","template","settings"].contains(&kind) { return false; } }
    let shop = if row["type"] == "settings" { row["id"].as_str() }
        else { row.get("draft").or_else(|| row.get("data")).unwrap_or(row)["shopId"].as_str() };
    shop.is_some_and(|id| ids.iter().any(|v| v == id))
}

fn plan(state: &Value, cloud: &Value, version: i64, ids: &[String]) -> Value {
    let rows: Vec<Value> = ids.iter().map(|id| {
        let count = |field: &str| state[field].as_array().map_or(0, |rows| rows.iter().filter(|r| r["shopId"] == *id).count());
        json!({"id":id,"configs":count("configs"),"templates":count("templates"),"settings":usize::from(state["shopSettings"].get(id).is_some())})
    }).collect();
    // 任何未确认请求都先核实，不能丢弃可能已发送的提交。
    let uncertain = cloud["outbox"].as_array().is_some_and(|a| !a.is_empty());
    json!({"shopIds":ids,"shops":rows,"baseRevision":state["revision"],"cloudVersion":version,"blocked":uncertain})
}

pub(in super::super) fn preview(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let ids = selected(input)?;
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (version, cloud) = stored(&tx)?;
    Ok(response(200, plan(&state(&tx)?, &cloud, version, &ids)))
}

pub(in super::super) fn clear(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let ids = selected(input)?;
    if input["confirmed"] != true { return Ok(failure(400, "请先预览并确认删除店铺本机数据")); }
    let mut c = db(&store.path)?;
    schema(&c)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let before = state(&tx)?;
    let (version, mut cloud) = stored(&tx)?;
    if input["baseRevision"] != before["revision"] || input["cloudVersion"].as_i64() != Some(version) {
        return Ok(failure(409, "数据或同步进度已变化，请重新预览"));
    }
    let summary = plan(&before, &cloud, version, &ids);
    if summary["blocked"] == true { return Ok(failure(409, "存在结果待确认的同步提交，请先完成同步再删除")); }
    // 跨店移动尚未对齐时，不能按旧归属删除基线而留下新归属正文。
    for field in ["records", "materializedProjection"] {
        for row in cloud[field].as_array().into_iter().flatten() {
            let collection = match row["type"].as_str() { Some("configuration") => "configs", Some("template") => "templates", _ => continue };
            let data = row.get("draft").or_else(|| row.get("data")).unwrap_or(row);
            if let Some(local) = before[collection].as_array().into_iter().flatten().find(|v| v["id"] == row["id"]) {
                if local["shopId"] != data["shopId"] && (owns(local,&ids) || owns(row,&ids)) {
                    return Ok(failure(409,"存在未同步的跨店移动，请先同步后重新预览"));
                }
            }
            if row["base"].is_object() && row["base"]["shopId"] != data["shopId"] && (owns(&row["base"],&ids) || owns(row,&ids)) {
                return Ok(failure(409,"存在未同步的跨店移动，请先同步后重新预览"));
            }
        }
    }
    // 数据库行无法放入系统回收站；先保留完整可恢复备份，写失败则不删除。
    let backup = store.path.parent().ok_or("数据目录无效")?.join("shop-cleanup-backups").join(format!("before-{}.json", unique()));
    write_new(&backup, json!({"format":1,"reason":"local-shop-cleanup","shopIds":ids,"state":before,"cloud":cloud,"cloudVersion":version}).to_string().as_bytes())?;
    let mut after = before.clone();
    // 固定剩余配置原顺序，避免删除前面的店铺后被误判为本机排序修改。
    if let Some(rows) = after["configs"].as_array_mut() {
        for (i, row) in rows.iter_mut().enumerate() { if !row["workspaceOrder"].is_number() { row["workspaceOrder"] = json!(i); } }
    }
    for field in ["configs", "templates"] {
        if let Some(rows) = after[field].as_array_mut() { rows.retain(|r| !owns(r, &ids)); }
    }
    if let Some(settings) = after["shopSettings"].as_object_mut() { for id in &ids { settings.remove(id); } }
    if !cloud.is_null() {
        for field in ["records", "materializedProjection"] {
            if let Some(rows) = cloud[field].as_array_mut() { rows.retain(|r| !owns(r, &ids)); }
        }
        // 旧全局/组合游标展开成独立店铺进度，所删店铺从零下载，其余进度不倒退。
        let global = cloud["cursor"].as_i64().unwrap_or(0);
        let mut cursors = serde_json::Map::new();
        for shop in SHOPS {
            let previous = cloud["shopCursors"].as_object().map(|o| o.iter().filter(|(k,_)| k.split('|').any(|s| s == shop)).filter_map(|(_,v)|v.as_i64()).max().unwrap_or(0)).unwrap_or(0).max(global);
            cursors.insert(shop.into(), json!(if ids.iter().any(|s| s == shop) {0} else {previous}));
        }
        cloud["cursor"] = json!(0);
        cloud["shopCursors"] = Value::Object(cursors);
    }
    let activity = persist(&tx, &before, &mut after, &json!({"message":"删除店铺本机数据（云端保留）"}))?;
    if !cloud.is_null() {
        // 不把其他店铺尚未同步的本机修改标为已同步。
        if cloud["localRevision"] == before["revision"] { cloud["localRevision"] = after["revision"].clone(); }
        validate_document(&cloud, &Value::Null)?;
        tx.execute("UPDATE workbench_cloud_state SET version=?1,document=?2 WHERE id=1", params![version.checked_add(1).ok_or("同步版本超限")?,cloud.to_string()]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(200,json!({"revision":after["revision"],"shops":summary["shops"],"backup":backup,"activityDelta":activity,"cloudDeleted":false})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> WorkbenchStore {
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/shop-cleanup-tests").join(unique());
        fs::create_dir_all(&root).unwrap();
        let state=json!({"revision":7,"configs":[{"id":"a","shopId":"intel","price":1,"parts":[]},{"id":"b","shopId":"jonsbo","price":2,"parts":[]}],"templates":[{"id":"t","shopId":"intel"},{"id":"shared"}],"shopSettings":{"intel":{"coupon":1},"jonsbo":{"coupon":2}},"costSource":[{"goodsId":"x","tax":3}],"caseGallery":[{"id":"g"}],"logs":[]});
        fs::write(root.join("seed.json"),state.to_string()).unwrap();
        let store=initialize(&root.join("workbench.sqlite"),&root.join("seed.json"),&root.join("assets")).unwrap();
        let c=db(&store.path).unwrap();schema(&c).unwrap();
        let records:Vec<Value>=state["configs"].as_array().unwrap().iter().map(|r|json!({"type":"configuration","id":r["id"],"version":1,"base":r,"draft":r,"conflict":null})).collect();
        let projection:Vec<Value>=records.iter().map(|r|json!({"type":r["type"],"id":r["id"],"data":r["draft"]})).collect();
        let cloud=json!({"format":1,"workspaceId":"w","uid":"u","deviceId":"d","cursor":50,"shopCursors":{"intel|jonsbo":70,"gigabyte":80},"localRevision":7,"records":records,"materializedProjection":projection,"outbox":[]});
        c.execute("INSERT INTO workbench_cloud_state VALUES(1,1,?1)",[cloud.to_string()]).unwrap();store
    }
    fn input(store:&WorkbenchStore)->Value {
        let mut value:Value=serde_json::from_str(&preview(store,&json!({"shopIds":["intel"]})).unwrap().body).unwrap();value["confirmed"]=json!(true);value
    }
    #[test]
    fn cleanup_is_local_backed_up_and_resets_only_selected_progress() {
        let s=fixture();let c=db(&s.path).unwrap();let before=state(&c).unwrap();let original=stored(&c).unwrap();
        let request=input(&s);assert_eq!(request["shops"][0]["configs"],1);assert_eq!(state(&c).unwrap(),before);
        let response=clear(&s,&request).unwrap();assert_eq!(response.status,200);let result:Value=serde_json::from_str(&response.body).unwrap();
        let backup:Value=serde_json::from_str(&fs::read_to_string(result["backup"].as_str().unwrap()).unwrap()).unwrap();assert_eq!(backup["state"],before);assert_eq!(backup["cloud"],original.1);
        let after=state(&c).unwrap();assert_eq!(after["configs"].as_array().unwrap().len(),1);assert_eq!(after["configs"][0]["id"],"b");assert_eq!(after["configs"][0]["workspaceOrder"],1);
        assert_eq!(after["templates"],json!([{"id":"shared"}]));assert!(after["shopSettings"].get("intel").is_none());assert_eq!(after["costSource"],before["costSource"]);assert_eq!(after["caseGallery"],before["caseGallery"]);
        let (v,cloud)=stored(&c).unwrap();assert_eq!(v,2);assert_eq!(cloud["cursor"],0);assert_eq!(cloud["shopCursors"],json!({"intel":0,"jonsbo":70,"gigabyte":80}));assert_eq!(cloud["records"].as_array().unwrap().len(),1);assert_eq!(cloud["outbox"],json!([]));assert_eq!(cloud["materializedProjection"][0]["id"],"b");
        assert_eq!(clear(&s,&request).unwrap().status,409);
    }
    #[test]
    fn cleanup_rejects_stale_uncertain_and_unconfirmed_requests() {
        let s=fixture();let c=db(&s.path).unwrap();let before=state(&c).unwrap();let mut req=input(&s);
        req["confirmed"]=json!(false);assert_eq!(clear(&s,&req).unwrap().status,400);req["confirmed"]=json!(true);
        req["baseRevision"]=json!(6);assert_eq!(clear(&s,&req).unwrap().status,409);
        let mut cloud=stored(&c).unwrap().1;cloud["outbox"]=json!([{"requestId":"uncertain"}]);c.execute("UPDATE workbench_cloud_state SET document=?1 WHERE id=1",[cloud.to_string()]).unwrap();
        req=input(&s);assert_eq!(req["blocked"],true);assert_eq!(clear(&s,&req).unwrap().status,409);assert_eq!(state(&c).unwrap(),before);
        assert!(preview(&s,&json!({"shopIds":["unknown"]})).is_err());assert!(preview(&s,&json!({"shopIds":[]})).is_err());
    }
    #[test]
    fn cleanup_rolls_back_when_checkpoint_write_fails() {
        let s=fixture();let c=db(&s.path).unwrap();let before=state(&c).unwrap();let cloud=stored(&c).unwrap();let req=input(&s);
        c.execute_batch("CREATE TRIGGER reject_cleanup BEFORE INSERT ON workbench_cloud_meta BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(clear(&s,&req).is_err());assert_eq!(state(&c).unwrap(),before);assert_eq!(stored(&c).unwrap(),cloud);
    }
    #[test]
    fn cleanup_rejects_cross_shop_moves() {
        let s=fixture();let c=db(&s.path).unwrap();let mut cloud=stored(&c).unwrap().1;cloud["records"][0]["draft"]["shopId"]=json!("jonsbo");
        c.execute("UPDATE workbench_cloud_state SET document=?1 WHERE id=1",[cloud.to_string()]).unwrap();assert_eq!(clear(&s,&input(&s)).unwrap().status,409);
    }
}
