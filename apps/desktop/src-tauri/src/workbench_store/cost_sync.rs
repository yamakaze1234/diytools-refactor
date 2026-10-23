//! 本机成本来源及两列成本预览；文件路径不进入云投影，完整读取后才可原子应用。
use super::*;
fn setup(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS workbench_cost_previews(id TEXT PRIMARY KEY,revision INTEGER,settings TEXT,rows TEXT,expires INTEGER,receipt TEXT);").map_err(|e|e.to_string())
}
pub fn settings(store: &WorkbenchStore) -> Result<Value> {
    let raw: Option<String> = db(&store.path)?
        .query_row(
            "SELECT json_extract(document,'$.costSync') FROM workbench_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let s = json!({"costSync":raw.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(|e|e.to_string())?});
    Ok(if s["costSync"].is_object() {
        s["costSync"].clone()
    } else {
        json!({"mode":"cloud","path":"","sheet":"库存数据","goodsColumn":54,"taxColumn":67})
    })
}
fn validate(v: &Value) -> Result<()> {
    if !matches!(v["mode"].as_str(), Some("nas" | "cloud")) {
        return Err("请选择本地 NAS 或云端成本".into());
    }
    if v["path"].as_str().is_none_or(|p| p.len() > 4096) {
        return Err("表格路径无效".into());
    }
    if v["sheet"].as_str().is_none_or(|p| p.len() > 100) {
        return Err("工作表名称无效".into());
    }
    for k in ["goodsColumn", "taxColumn"] {
        if v[k].as_u64().is_none_or(|n| n == 0 || n > 16384) {
            return Err("列号须为 1 到 16384".into());
        }
    }
    if v["goodsColumn"] == v["taxColumn"] {
        return Err("商品 ID 和成本不能选择同一列".into());
    }
    Ok(())
}
pub fn save_settings(store: &WorkbenchStore, v: &Value) -> Result<Value> {
    validate(v)?;
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // 设置只涉及根元数据，不能为切换路径重写所有配置。
    let raw:String=tx.query_row("SELECT document FROM workbench_metadata WHERE id=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let metadata:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workbench_cloud_state')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists {
        let has_header:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workbench_cloud_header')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        let sql=if has_header {"SELECT count(*) FROM workbench_cloud_header,json_each(outbox) q WHERE json_extract(q.value,'$.payload.entityType')='component'"} else {"SELECT count(*) FROM workbench_cloud_state,json_each(document,'$.outbox') q WHERE json_extract(q.value,'$.payload.entityType')='component'"};
        let pending:i64=tx.query_row(sql,[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if pending>0{return Err("有旧成本提交尚未确认，请先完成原云同步再切换来源".into());}
    }
    let keys=["mode","path","sheet","goodsColumn","taxColumn"];
    if metadata["costSync"].is_object()&&keys.iter().all(|k|metadata["costSync"][*k]==v[*k]) {
        tx.commit().map_err(|e|e.to_string())?;return Ok(metadata["costSync"].clone());
    }
    let mut before=json!({"configs":[]});
    for key in ["revision","updatedAt","costSync"] {if let Some(value)=metadata.get(key){before[key]=value.clone();}}
    let mut after=before.clone();after["revision"]=(revision(&metadata)+1).into();after["updatedAt"]=now().into();
    after["costSync"]=json!({"mode":v["mode"],"path":v["path"],"sheet":v["sheet"],"goodsColumn":v["goodsColumn"],"taxColumn":v["taxColumn"]});
    tx.execute("UPDATE workbench_metadata SET document=json_set(document,'$.costSync',json(?1),'$.revision',?2,'$.updatedAt',?3) WHERE id=1",params![after["costSync"].to_string(),revision(&after),after["updatedAt"].as_str()]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE workbench_config_projection_meta SET revision=?1 WHERE revision=?2",params![revision(&after),revision(&metadata)]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO workbench_history(at,revision,document) VALUES(?1,?2,?3)",params![after["updatedAt"].as_str(),revision(&after),delta(&before,&after).to_string()]).map_err(|e|e.to_string())?;
    let activity=json!({"id":unique(),"at":after["updatedAt"],"operator":"本机操作员","origin":"local","message":"设置本机成本来源","summary":"工作台内容已修改"});
    tx.execute("INSERT INTO workbench_activity(document) VALUES(?1)",[activity.to_string()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(after["costSync"].clone())
}

fn normalize(rows: &Value) -> Result<Vec<Value>> {
    let rows = rows
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 100000)
        .ok_or("成本数据为空或超过 10 万行")?;
    let mut seen = HashMap::new();
    for r in rows {
        let id = r["goods_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_digit()))
            .ok_or("goods_id 无效")?;
        let tax = &r["tax"];
        if !tax.is_null()
            && tax
                .as_f64()
                .is_none_or(|v| !v.is_finite() || v < 0.0 || v > 100000000.0)
        {
            return Err("含税成本无效".into());
        }
        if let Some(old) = seen.insert(id.to_owned(), tax.clone()) {
            if old != *tax {
                return Err(format!("goods_id {id} 存在不同成本，请先处理重复行"));
            }
        }
    }
    Ok(seen
        .into_iter()
        .map(|(id, tax)| json!({"goods_id":id,"tax":tax}))
        .collect())
}
fn plan(before: &Value, rows: &[Value]) -> Result<(Value, Value)> {
    let mut after = before.clone();
    let at = now();
    let prices: HashMap<_, _> = rows
        .iter()
        .map(|r| (r["goods_id"].as_str().unwrap(), r["tax"].clone()))
        .collect();
    let mut changed = 0usize;
    let mut matched = 0usize;
    let mut examples = Vec::new();
    let mut ids = Vec::new();
    let mut update = |r: &mut Value, config: bool| {
        let Some(id) = r["goodsId"].as_str().map(str::to_owned) else {
            return false;
        };
        let Some(price) = prices.get(id.as_str()) else {
            return false;
        };
        if r["specialComponent"].is_object() || r["specialComponent"] == true {
            return false;
        }
        matched += 1;
        let override_price = config
            && r["taxOverride"]["goodsId"] == r["goodsId"]
            && r["taxOverride"]["value"].as_f64().is_some_and(|x| x >= 0.0);
        let old = if override_price {
            r["taxOverride"]["base"].clone()
        } else {
            r["tax"].clone()
        };
        if old != *price {
            changed += 1;
            if examples.len() < 80 {
                examples.push(json!({"goodsId":id,"before":old,"after":price,"overridePreserved":override_price}));
            }
        }
        if override_price {
            r["taxOverride"]["base"] = price.clone();
            r["tax"] = r["taxOverride"]["value"].clone();
        } else {
            r.as_object_mut().unwrap().remove("taxOverride");
            r["tax"] = price.clone();
        }
        r["taxUpdatedAt"] = at.clone().into();
        true
    };
    for k in ["costSource", "sourceCatalog"] {
        if let Some(rs) = after[k].as_array_mut() {
            for r in rs {
                update(r, false);
            }
        }
    }
    if let Some(cs) = after["configs"].as_array_mut() {
        for c in cs {
            if c["deletedAt"].is_string() {
                continue;
            }
            let mut hit = false;
            for k in ["parts", "actualParts"] {
                if let Some(rs) = c[k].as_array_mut() {
                    for r in rs {
                        hit |= update(r, true);
                    }
                }
            }
            if hit {
                ids.push(c["id"].clone());
                c["taxUpdatedAt"] = at.clone().into();
            }
        }
    }
    // 缓存两列完整成本目录；未匹配 ID 保留，缺失旧 ID 不清空。
    if !after["costSource"].is_array() {
        after["costSource"] = json!([]);
    }
    let existing: HashSet<String> = after["costSource"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["goodsId"].as_str().map(str::to_owned))
        .collect();
    let mut added = 0usize;
    for r in rows {
        if !existing.contains(r["goods_id"].as_str().unwrap()) {
            added += 1;
            after["costSource"]
                .as_array_mut()
                .unwrap()
                .push(json!({"goodsId":r["goods_id"],"name":"","tax":r["tax"],"taxUpdatedAt":at}));
        }
    }
    after["costSync"]["updatedAt"] = at.into();
    Ok((
        after,
        json!({"total":rows.len(),"added":added,"matched":matched,"changed":changed,"examples":examples,"configIds":ids}),
    ))
}
// 逐套读取配置并只计算差异摘要；预览不构造完整修改后副本。
fn summarize(c:&Connection, metadata:&Value, rows:&[Value])->Result<Value> {
    let prices:HashMap<_,_>=rows.iter().map(|r|(r["goods_id"].as_str().unwrap(),r["tax"].clone())).collect();
    let mut matched=0usize;let mut changed=0usize;let mut examples=Vec::new();let mut ids=Vec::new();
    let mut inspect=|r:&Value,config:bool| {
        let Some(id)=r["goodsId"].as_str() else{return false;};
        let Some(price)=prices.get(id) else{return false;};
        if r["specialComponent"].is_object()||r["specialComponent"]==true{return false;}
        matched+=1;
        let override_price=config&&r["taxOverride"]["goodsId"]==r["goodsId"]&&r["taxOverride"]["value"].as_f64().is_some_and(|x|x>=0.0);
        let old=if override_price {&r["taxOverride"]["base"]}else{&r["tax"]};
        if old!=price {changed+=1;if examples.len()<80{examples.push(json!({"goodsId":id,"before":old,"after":price,"overridePreserved":override_price}));}}
        true
    };
    for key in ["costSource","sourceCatalog"] {if let Some(rs)=metadata[key].as_array(){for r in rs{inspect(r,false);}}}
    let mut query=c.prepare("SELECT document FROM workbench_configs ORDER BY position").map_err(|e|e.to_string())?;
    for raw in query.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())? {
        let config:Value=serde_json::from_str(&raw.map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        if config["deletedAt"].is_string(){continue;}
        let mut hit=false;for key in ["parts","actualParts"] {if let Some(rs)=config[key].as_array(){for r in rs{hit|=inspect(r,true);}}}
        if hit{ids.push(config["id"].clone());}
    }
    let existing:HashSet<_>=metadata["costSource"].as_array().into_iter().flatten().filter_map(|r|r["goodsId"].as_str()).collect();
    let added=rows.iter().filter(|r|!existing.contains(r["goods_id"].as_str().unwrap())).count();
    Ok(json!({"total":rows.len(),"added":added,"matched":matched,"changed":changed,"examples":examples,"configIds":ids}))
}
pub fn preview(store: &WorkbenchStore, rows: Value, expected: &Value) -> Result<Value> {
    validate(expected)?;
    let rows = normalize(&rows)?;
    let mut c = db(&store.path)?;
    setup(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let raw:String=tx.query_row("SELECT document FROM workbench_metadata WHERE id=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let before:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
    if before["costSync"] != *expected {
        return Err("成本来源已变化，请重新读取".into());
    }
    let mut result = summarize(&tx, &before, &rows)?;
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "DELETE FROM workbench_cost_previews WHERE receipt IS NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO workbench_cost_previews(id,revision,settings,rows,expires) VALUES(?1,?2,?3,?4,?5)",params![id,before["revision"].as_i64(),expected.to_string(),serde_json::to_string(&rows).unwrap(),chrono::Utc::now().timestamp_millis()+600000]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    result["id"] = id.into();
    Ok(result)
}
pub fn apply(store: &WorkbenchStore, id: &str) -> Result<Value> {
    let mut c = db(&store.path)?;
    setup(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (revision,settings,rows,expires,receipt):(i64,String,String,i64,Option<String>)=tx.query_row("SELECT revision,settings,rows,expires,receipt FROM workbench_cost_previews WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|"预览不存在，请重新读取")?;
    if let Some(r) = receipt {
        return serde_json::from_str(&r).map_err(|e| e.to_string());
    }
    let before = state(&tx)?;
    if before["revision"] != revision
        || before["costSync"].to_string() != settings
        || expires < chrono::Utc::now().timestamp_millis()
    {
        return Err("配置或成本来源已变化，或预览已过期，请重新读取".into());
    }
    let rows: Value = serde_json::from_str(&rows).map_err(|e| e.to_string())?;
    let (mut after, mut result) = plan(&before, &normalize(&rows)?)?;
    // 独立备份包含应用前的完整业务状态，成功写入后才修改数据库。
    let directory = store
        .path
        .parent()
        .ok_or("成本备份目录无效")?
        .join("cost-backups");
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建成本备份：{e}"))?;
    let backup = directory.join(format!("before-{id}.json"));
    if !backup.exists() {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, &before).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    } else {
        let saved: Value =
            serde_json::from_reader(fs::File::open(&backup).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if saved != before {
            return Err("成本备份与当前状态不符，请重新预览".into());
        }
    }
    persist(
        &tx,
        &before,
        &mut after,
        &json!({"message":"更新本机含税成本，保留 ERP 与独立改价"}),
    )?;
    result["backupPath"] = backup.to_string_lossy().into_owned().into();
    result["revision"] = after["revision"].clone();
    result["ok"] = true.into();
    tx.execute(
        "UPDATE workbench_cost_previews SET receipt=?1,rows='[]' WHERE id=?2",
        params![result.to_string(), id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "explicit isolated production-size benchmark"]
    fn cost_profile() {
        let input=PathBuf::from(std::env::var("COST_PROFILE_ROOT").unwrap());
        let run=input.join(std::env::var("COST_PROFILE_TAG").unwrap());fs::create_dir_all(&run).unwrap();
        let store=initialize(&run.join("workbench.sqlite"),&input.join("source.json"),&run.join("assets")).unwrap();
        let rows:Value=serde_json::from_slice(&fs::read(input.join("rows.json")).unwrap()).unwrap();
        let config=settings(&store).unwrap();let started=std::time::Instant::now();
        save_settings(&store,&config).unwrap();let settings_ms=started.elapsed().as_millis();
        let actual=settings(&store).unwrap();let next=std::time::Instant::now();let preview=preview(&store,rows,&actual).unwrap();
        let result=json!({"settingsMs":settings_ms,"previewMs":next.elapsed().as_millis(),"total":preview["total"],"matched":preview["matched"],"changed":preview["changed"],"added":preview["added"],"examples":preview["examples"],"configIds":preview["configIds"]});
        fs::write(run.join("result.json"),result.to_string()).unwrap();println!("settingsMs={settings_ms},previewMs={}",result["previewMs"]);
    }
    fn source() -> Value {
        json!({"revision":7,"configs":[{"id":"c1","shopId":"intel","price":8999,"parts":[{"goodsId":"1","tax":400,"erp":380,"stockAvailable":3}],"actualParts":[{"goodsId":"1","tax":350,"taxOverride":{"goodsId":"1","value":350,"base":400}},{"goodsId":"2","tax":600},{"goodsId":"1","specialComponent":true,"tax":0}]},{"id":"deleted","deletedAt":"old","parts":[{"goodsId":"1","tax":99}]}],"sourceCatalog":[{"sourceId":"s1","goodsId":"1","tax":400,"name":"CPU"}],"costSource":[{"goodsId":"1","tax":400,"erp":380}],"costSync":{"mode":"nas","path":"D:/cost.xlsx","sheet":"库存数据","goodsColumn":1,"taxColumn":2},"templates":[],"shopSettings":{},"caseGallery":[]})
    }
    fn fixture() -> WorkbenchStore {
        let root = PathBuf::from("D:/diytools/sandbox/cost-store-tests").join(unique());
        fs::create_dir_all(&root).unwrap();
        let seed = root.join("source.json");
        fs::write(&seed, source().to_string()).unwrap();
        initialize(&root.join("workbench.sqlite"), &seed, &root.join("assets")).unwrap()
    }
    fn prices() -> Value {
        json!([{"goods_id":"1","tax":450},{"goods_id":"3","tax":0}])
    }
    #[test]
    fn preserves_override_erp_unmatched_deleted_and_special() {
        let old = source();
        let (new, summary) = plan(&old, &normalize(&prices()).unwrap()).unwrap();
        assert_eq!(summary["total"], 2);
        assert_eq!(summary["added"], 1);
        assert_eq!(new["configs"][0]["parts"][0]["tax"], 450);
        assert_eq!(new["configs"][0]["parts"][0]["erp"], 380);
        assert_eq!(new["configs"][0]["parts"][0]["stockAvailable"], 3);
        assert_eq!(new["configs"][0]["actualParts"][0]["tax"], 350);
        assert_eq!(
            new["configs"][0]["actualParts"][0]["taxOverride"]["base"],
            450
        );
        assert_eq!(
            new["configs"][0]["actualParts"][1],
            old["configs"][0]["actualParts"][1]
        );
        assert_eq!(
            new["configs"][0]["actualParts"][2],
            old["configs"][0]["actualParts"][2]
        );
        assert_eq!(new["configs"][1], old["configs"][1]);
        assert_eq!(new["configs"][0]["price"], 8999);
        assert_eq!(new["costSource"].as_array().unwrap().len(), 2);
        assert_eq!(old, source());
    }
    #[test]
    fn streaming_preview_matches_full_plan_and_settings_never_rewrites_configs() {
        let store=fixture();let c=db(&store.path).unwrap();let original=state(&c).unwrap();
        let rows=normalize(&prices()).unwrap();assert_eq!(summarize(&c,&original,&rows).unwrap(),plan(&original,&rows).unwrap().1);
        let seq:i64=c.query_row("SELECT max(sequence) FROM workbench_history",[],|r|r.get(0)).unwrap();
        c.execute_batch("CREATE TRIGGER deny_config_update BEFORE UPDATE ON workbench_configs BEGIN SELECT RAISE(ABORT,'no config writes'); END; CREATE TRIGGER deny_config_delete BEFORE DELETE ON workbench_configs BEGIN SELECT RAISE(ABORT,'no config writes'); END; CREATE TRIGGER deny_config_insert BEFORE INSERT ON workbench_configs BEGIN SELECT RAISE(ABORT,'no config writes'); END;").unwrap();
        save_settings(&store,&original["costSync"]).unwrap();assert_eq!(state(&c).unwrap(),original);
        let mut next=original["costSync"].clone();next["sheet"]="new sheet".into();save_settings(&store,&next).unwrap();
        assert_eq!(state(&c).unwrap()["configs"],original["configs"]);assert_eq!(reconstruct(&c,seq).unwrap(),original);
        save_settings(&store,&next).unwrap();assert_eq!(state(&c).unwrap()["revision"],8);
    }
    #[test]
    fn rejects_conflicting_duplicates_bad_ids_and_prices() {
        for rows in [
            json!([]),
            json!([{"goods_id":"x","tax":3}]),
            json!([{"goods_id":"1","tax":-1}]),
            json!([{"goods_id":"1","tax":1},{"goods_id":"1","tax":2}]),
        ] {
            assert!(normalize(&rows).is_err());
        }
        assert_eq!(normalize(&json!([{"goods_id":"9007199254740993","tax":0},{"goods_id":"9007199254740993","tax":0}])).unwrap().len(),1);
    }
    #[test]
    fn preview_readonly_apply_backup_history_and_idempotency() {
        let store = fixture();
        let before = state(&db(&store.path).unwrap()).unwrap();
        let preview = preview(&store, prices(), &before["costSync"]).unwrap();
        assert_eq!(state(&db(&store.path).unwrap()).unwrap(), before);
        let result = apply(&store, preview["id"].as_str().unwrap()).unwrap();
        assert_eq!(result["revision"], 8);
        let backup: Value =
            serde_json::from_slice(&fs::read(result["backupPath"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(backup, before);
        assert_eq!(
            apply(&store, preview["id"].as_str().unwrap()).unwrap(),
            result
        );
        assert_eq!(state(&db(&store.path).unwrap()).unwrap()["revision"], 8);
        let count: i64 = db(&store.path)
            .unwrap()
            .query_row("SELECT count(*) FROM workbench_history", [], |r| r.get(0))
            .unwrap();
        assert!(count > 0);
    }
    #[test]
    fn changing_source_or_revision_invalidates_preview() {
        let store = fixture();
        let config = settings(&store).unwrap();
        let p = preview(&store, prices(), &config).unwrap();
        let mut changed = config.clone();
        changed["mode"] = "cloud".into();
        save_settings(&store, &changed).unwrap();
        assert!(apply(&store, p["id"].as_str().unwrap()).is_err());
        assert!(preview(&store, prices(), &config).is_err());
        assert_eq!(
            state(&db(&store.path).unwrap()).unwrap()["costSource"][0]["tax"],
            400
        );
    }
    #[test]
    fn expired_preview_cannot_apply() {
        let store = fixture();
        let p = preview(&store, prices(), &settings(&store).unwrap()).unwrap();
        db(&store.path)
            .unwrap()
            .execute("UPDATE workbench_cost_previews SET expires=0", [])
            .unwrap();
        assert!(apply(&store, p["id"].as_str().unwrap()).is_err());
    }
    #[test]
    fn pending_component_submission_blocks_switch() {
        let store = fixture();
        db(&store.path).unwrap().execute_batch("CREATE TABLE workbench_cloud_state(document TEXT); INSERT INTO workbench_cloud_state VALUES ('{\"outbox\":[{\"payload\":{\"entityType\":\"component\"}}]}');").unwrap();
        assert!(save_settings(&store, &settings(&store).unwrap())
            .unwrap_err()
            .contains("尚未确认"));
    }
}
