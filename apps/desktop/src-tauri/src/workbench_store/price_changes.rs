//! 价格变化与业务写入共用事务；独立本机表不进入云同步正文。
use super::*;

fn schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS workbench_price_changes(revision INTEGER PRIMARY KEY, document TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS workbench_price_handled(revision INTEGER NOT NULL, config_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(revision,config_id));").map_err(|e|e.to_string())
}
fn rows(v: &Value) -> &[Value] { v.as_array().map(Vec::as_slice).unwrap_or(&[]) }
fn price(v: &Value) -> Option<i64> {
    let n = v.as_f64().or_else(||v.as_str()?.parse().ok())?;
    (n.is_finite() && n >= 0.0).then_some((n*100.0).round() as i64)
}
fn prices(p: &Value) -> Value {
    let tax=if p["taxOverride"]["goodsId"]==p["goodsId"] && p["goodsId"].is_string() {price(&p["taxOverride"]["value"]).or_else(||price(&p["tax"]))}else{price(&p["tax"])};
    json!({"tax":tax,"erp":if p["erpMissing"]==true || p["erpUnknown"]==true {None} else {price(&p["erp"])}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn daily_uses_yesterday_not_previous_batch_and_zero_net_disappears(){
        let mut a=fixture();a["updatedAt"]="2026-10-17T15:00:00.000Z".into();let mut b=a.clone();b["updatedAt"]="2026-10-18T01:00:00.000Z".into();b["costSource"][0]["tax"]=120.into();b["configs"][0]["actualParts"][0]["tax"]=120.into();let mut c=b.clone();c["updatedAt"]="2026-10-18T02:00:00.000Z".into();c["costSource"][0]["tax"]=140.into();c["configs"][0]["actualParts"][0]["tax"]=140.into();
        let v=combine_day(&[("a".into(),2,delta(&a,&b)),("b".into(),3,delta(&b,&c))],"2026-10-18","2026-10-17T16:00:00.000Z");assert_eq!(v["baselineKnown"],true);assert_eq!(v["items"][0]["before"]["tax"],11000);assert_eq!(v["items"][0]["after"]["tax"],14000);
        let v=combine_day(&[("a".into(),2,delta(&a,&b)),("b".into(),3,delta(&b,&a))],"2026-10-18","2026-10-17T16:00:00.000Z");assert!(rows(&v["items"]).is_empty());
        a["updatedAt"]="2026-10-18T00:00:00.000Z".into();let v=combine_day(&[("a".into(),2,delta(&a,&b))],"2026-10-18","2026-10-17T16:00:00.000Z");assert_eq!(v["baselineKnown"],false);assert!(rows(&v["items"]).is_empty());
    }
    #[test] fn upgrade_backfill_is_idempotent_and_keeps_business_document(){
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();db.execute_batch("CREATE TABLE workbench_history(sequence INTEGER PRIMARY KEY,at TEXT,revision INTEGER,document TEXT);").unwrap();let mut a=fixture();a["updatedAt"]="2020-01-01T00:00:00.000Z".into();let mut b=a.clone();b["costSource"][0]["tax"]=120.into();b["updatedAt"]=now().into();let raw=delta(&a,&b).to_string();db.execute("INSERT INTO workbench_history VALUES(1,?1,2,?2)",params![now(),raw]).unwrap();backfill_today(&mut db).unwrap();backfill_today(&mut db).unwrap();let count:i64=db.query_row("SELECT count(*) FROM workbench_price_changes",[],|r|r.get(0)).unwrap();assert_eq!(count,1);let after:String=db.query_row("SELECT document FROM workbench_history",[],|r|r.get(0)).unwrap();assert_eq!(after,raw);
    }
    fn fixture()->Value {json!({"revision":1,"configs":[{"id":"c1","shopId":"intel","productId":"p1","price":1000,"parts":[{"goodsId":"display","erp":90}],"actualParts":[{"slot":"内存","goodsId":"1","name":"内存","qty":2,"erp":100,"tax":110}]}],"costSource":[{"goodsId":"1","name":"内存","erp":100,"tax":110}]})}
    fn recorded(before:&Value,after:&Value)->Value {
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();let tx=db.transaction().unwrap();
        capture(&tx,after,&delta(before,after),&json!({"message":"测试"})).unwrap();tx.commit().unwrap();
        db.query_row("SELECT document FROM workbench_price_changes",[],|r|r.get::<_,String>(0)).ok().map(|s|serde_json::from_str(&s).unwrap()).unwrap_or(Value::Null)
    }
    #[test] fn deduplicates_actual_bom_and_keeps_before_after(){
        let b=fixture();let mut a=b.clone();a["revision"]=2.into();a["costSource"][0]["erp"]=120.into();a["configs"][0]["actualParts"][0]["erp"]=120.into();
        let v=recorded(&b,&a);assert_eq!(rows(&v["items"]).len(),1);assert_eq!(v["items"][0]["slots"],json!(["内存"]));assert_eq!(v["items"][0]["configIds"],json!(["c1"]));assert_eq!(v["configs"][0]["before"]["actualParts"][0]["erp"],100);
    }
    #[test] fn display_stock_quantity_and_replacement_are_not_price_changes(){
        let b=fixture();let mut a=b.clone();a["configs"][0]["parts"][0]["erp"]=120.into();a["configs"][0]["actualParts"][0]["qty"]=3.into();a["costSource"][0]["stockAvailable"]=20.into();assert!(recorded(&b,&a).is_null());
        a["configs"][0]["actualParts"][0]["goodsId"]="2".into();a["configs"][0]["actualParts"][0]["erp"]=200.into();assert!(recorded(&b,&a).is_null());
    }
    #[test] fn missing_is_not_zero_and_deleted_templates_are_excluded(){
        let b=fixture();let mut a=b.clone();a["configs"][0]["actualParts"][0]["erpUnknown"]=true.into();let v=recorded(&b,&a);assert!(v["items"][0]["after"]["erp"].is_null());assert_eq!(v["items"][0]["before"]["erp"],10000);
        a["configs"][0]["deletedAt"]="now".into();assert!(recorded(&b,&a).is_null());a["configs"][0]["deletedAt"]=Value::Null;a["configs"][0]["productCategory"]="主机模板".into();assert!(recorded(&b,&a).is_null());
    }
    #[test] fn independent_tax_override_does_not_link_common_cost_change(){
        let mut b=fixture();b["configs"][0]["actualParts"][0]["taxOverride"]=json!({"goodsId":"1","value":110,"base":110});let mut a=b.clone();a["costSource"][0]["tax"]=130.into();a["configs"][0]["actualParts"][0]["taxOverride"]["base"]=130.into();let v=recorded(&b,&a);assert_eq!(rows(&v["items"]).len(),1);assert!(rows(&v["configs"]).is_empty());
    }
    #[test] fn numeric_string_equivalence_and_transaction_rollback(){
        let b=fixture();let mut a=b.clone();a["costSource"][0]["erp"]="100.00".into();assert!(recorded(&b,&a).is_null());a["costSource"][0]["erp"]=130.into();
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();{let tx=db.transaction().unwrap();capture(&tx,&a,&delta(&b,&a),&json!({})).unwrap();}
        let n:i64=db.query_row("SELECT COUNT(*) FROM workbench_price_changes",[],|r|r.get(0)).unwrap();assert_eq!(n,0);
    }
    #[test] fn sql_apply_and_compact_save_persist_once_and_handled_survives_reopen(){
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/price-changes-20261018/store-test").join(unique());fs::create_dir_all(&root).unwrap();
        let mut initial=fixture();initial["sourceCatalog"]=json!([]);initial["logs"]=json!([]);initial["templates"]=json!([]);
        fs::write(root.join("seed.json"),initial.to_string()).unwrap();let store=initialize(&root.join("workbench.sqlite"),&root.join("seed.json"),&root.join("assets")).unwrap();
        let preview=sql_sync::sql_preview(&store,json!([{"goodsId":"1","name":"内存","erp":120,"stockAvailable":3}]),&json!({"server":"fixture","port":1433,"database":"fixture"}),"test").unwrap();
        let receipt=sql_sync::sql_apply(&store,preview["id"].as_str().unwrap()).unwrap();let rev=receipt["revision"].as_i64().unwrap();
        assert!(sql_sync::sql_apply(&store,preview["id"].as_str().unwrap()).is_err());
        let list:Value=serde_json::from_str(&request(&store,"list",&json!({})).unwrap().body).unwrap();assert_eq!(rows(&list["batches"]).len(),1);
        request(&store,"handle",&json!({"revision":rev,"configId":"c1","handled":true})).unwrap();request(&store,"seen",&json!({"revision":rev})).unwrap();
        let detail:Value=serde_json::from_str(&request(&store,"detail",&json!({"revision":rev})).unwrap().body).unwrap();assert_eq!(detail["handled"],json!(["c1"]));assert_eq!(detail["configs"][0]["after"]["actualParts"][0]["erp"],120);
        let before=state(&db(&store.path).unwrap()).unwrap();let base=&before["configs"][0];let mut after=base.clone();after["actualParts"][0]["tax"]=130.into();
        let body=json!({"mode":"ordinary","operationId":"price-compact-test","baseRevision":rev,"operator":"test","message":"单独成本更新","changes":[{"id":"c1","base":base,"after":after}]});
        let saved=super::super::request(&store,"POST","/api/configs/patch",Some(&body.to_string())).unwrap();assert_eq!(saved.status,200,"{}",saved.body);
        let replay=super::super::request(&store,"POST","/api/configs/patch",Some(&body.to_string())).unwrap();assert_eq!(replay.status,200);
        let list:Value=serde_json::from_str(&request(&store,"list",&json!({})).unwrap().body).unwrap();assert_eq!(rows(&list["batches"]).len(),2);
    }
}
fn parts(c: &Value) -> &[Value] { if c["actualParts"].is_array() {rows(&c["actualParts"])} else {rows(&c["parts"])} }
fn slim(c: &Value) -> Value {
    let mut result=json!({});
    for k in ["id","shopId","productId","product","productUrl","name","price","installment","productCategory"] {result[k]=c[k].clone();}
    result["actualParts"]=parts(c).iter().map(|p|{let mut r=json!({});for k in ["goodsId","name","slot","lineId","qty","tax","erp","erpMissing","erpUnknown","taxOverride","specialComponent"]{r[k]=p[k].clone();}r}).collect::<Vec<_>>().into();
    result
}
fn eligible(c:&Value)->bool {c.is_object() && c["deletedAt"].as_str().unwrap_or("").is_empty() && c["emptyLinkDraft"]!=true && c["productCategory"]!="主机模板"}
fn add(out:&mut Vec<Value>, old:&Value, new:&Value, slot:&str, config:Option<&Value>) {
    let id=new["goodsId"].as_str().unwrap_or("");
    if id.is_empty() || id=="0" || new["specialComponent"]==true {return;}
    let a=prices(old);let b=prices(new);if a==b {return;}
    let key=json!([id,a,b]);
    let index=out.iter().position(|r|r["key"]==key).unwrap_or_else(||{out.push(json!({"key":key,"goodsId":id,"name":new["name"],"before":a,"after":b,"slots":[],"configIds":[]}));out.len()-1});
    let row=&mut out[index];
    if !slot.is_empty() && !rows(&row["slots"]).contains(&json!(slot)){row["slots"].as_array_mut().unwrap().push(json!(slot));}
    if let Some(c)=config {if !rows(&row["configIds"]).contains(&c["id"]){row["configIds"].as_array_mut().unwrap().push(c["id"].clone());}}
}
fn document(after:&Value, changes:&Value, input:&Value)->Option<Value> {
    let mut items=Vec::new();let mut configs=Vec::new();
    // 同一 ERP ID 的共用成本去重；首次入库可单独显示，不把缺价当零。
    for key in ["costSource","sourceCatalog"] {
        let field=&changes["fields"][key];
        let old:HashMap<_,_>=rows(&field["before"]).iter().filter_map(|p|Some((p["goodsId"].as_str()?,p))).collect();
        for p in rows(&field["after"]) {if let Some(id)=p["goodsId"].as_str(){add(&mut items,old.get(id).copied().unwrap_or(&Value::Null),p,p["slot"].as_str().unwrap_or(""),None);}}
    }
    for change in rows(&changes["configs"]) {
        let (old,new)=(&change["before"],&change["after"]);
        if !eligible(old)||!eligible(new){continue;}
        let mut affected=false;
        for (index,p) in parts(new).iter().enumerate() {
            // 仅同一 BOM 行的同一商品比较，替换配件或重排不算价格涨跌。
            let old_part=parts(old).iter().find(|v|p["lineId"].as_str().is_some()&&v["lineId"]==p["lineId"])
                .or_else(||parts(old).iter().find(|v|p["slot"].as_str().is_some()&&v["slot"]==p["slot"]&&v["goodsId"]==p["goodsId"]))
                .or_else(||parts(old).get(index));
            if let Some(o)=old_part {if o["goodsId"]==p["goodsId"]&&prices(o)!=prices(p)&&p["specialComponent"]!=true {
                add(&mut items,o,p,p["slot"].as_str().unwrap_or(""),Some(new));affected=true;
            }}
        }
        if affected {configs.push(json!({"before":slim(old),"after":slim(new)}));}
    }
    if items.is_empty(){return None;}
    Some(json!({"revision":after["revision"],"at":after["updatedAt"],"message":input["message"],"items":items,"configs":configs}))
}
pub(super) fn capture(tx:&Transaction, after:&Value, changes:&Value, input:&Value)->Result<()> {
    let Some(document)=document(after,changes,input) else{return Ok(());};
    schema(tx)?;
    tx.execute("INSERT INTO workbench_price_changes(revision,document) VALUES(?1,?2)",params![revision(after),document.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn day_bounds() -> (String,String,String) {
    let local=chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(8*3600).unwrap());
    let day=local.date_naive();let start=day.and_hms_opt(0,0,0).unwrap().and_local_timezone(*local.offset()).unwrap().with_timezone(&chrono::Utc);
    (day.to_string(),start.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),(start+chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
}
// 升级时从原有真实逆向历史补录今日批次，不改业务状态；扫描游标与回填同事务。
fn backfill_today(db:&mut Connection)->Result<()> {
    let (_,start,end)=day_bounds();let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_price_scan(day TEXT PRIMARY KEY, sequence INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    let cursor:i64=tx.query_row("SELECT sequence FROM workbench_price_scan WHERE day=?1",[&start],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
    let records={let mut q=tx.prepare("SELECT sequence,at,revision,document FROM workbench_history WHERE at>=?1 AND at<?2 AND sequence>?3 ORDER BY sequence").map_err(|e|e.to_string())?;q.query_map(params![start,end,cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?};
    let mut last=cursor;
    for (seq,at,rev,raw) in records {last=seq;let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workbench_price_changes WHERE revision=?1)",[rev],|r|r.get(0)).map_err(|e|e.to_string())?;if exists{continue;}
        let changes:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        capture(&tx,&json!({"revision":rev,"updatedAt":at}),&changes,&json!({"message":"升级补录 · 今日已保存的价格更新"}))?;
    }
    tx.execute("INSERT INTO workbench_price_scan VALUES(?1,?2) ON CONFLICT(day) DO UPDATE SET sequence=excluded.sequence",params![start,last]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}
// 合并一天内的真实前后状态：保留第一次 before 和最后一次 after，不能把上一批当昨天。
fn combine_day(records:&[(String,i64,Value)],day:&str,start:&str)->Value {
    let mut configs:HashMap<String,Value>=HashMap::new();let mut fields=serde_json::Map::new();
    for (_,_,delta) in records {
        for c in rows(&delta["configs"]) {let Some(id)=c["id"].as_str() else{continue;};configs.entry(id.into()).and_modify(|v|v["after"]=c["after"].clone()).or_insert_with(||c.clone());}
        if let Some(map)=delta["fields"].as_object(){for(k,v)in map{fields.entry(k.clone()).and_modify(|f:&mut Value|{f["after"]=v["after"].clone();f["afterPresent"]=v["afterPresent"].clone();}).or_insert_with(||v.clone());}}
    }
    let known=fields.get("updatedAt").and_then(|v|v["before"].as_str()).is_some_and(|at|at<start);
    let (at,rev)=records.last().map(|(at,rev,_)|(at.clone(),*rev)).unwrap_or((start.into(),0));
    let delta=json!({"configs":configs.into_values().collect::<Vec<_>>(),"fields":fields});
    let mut result=if known {document(&json!({"revision":rev,"updatedAt":at}),&delta,&json!({"message":"今日累计 · 对比昨日最后保存价格"})).unwrap_or(json!({"revision":rev,"at":at,"items":[],"configs":[],"message":"今日相对昨日暂无净价格变化"}))}else{json!({"revision":rev,"at":at,"items":[],"configs":[],"message":"昨日基线不足，无法确认日间价格变化"})};
    result["daily"]=true.into();result["day"]=day.into();result["baselineKnown"]=known.into();result["handled"]=json!([]);result
}
fn day_comparison(db:&Connection)->Result<Value> {
    let(day,start,end)=day_bounds();let mut q=db.prepare("SELECT at,revision,document FROM workbench_history WHERE at>=?1 AND at<?2 ORDER BY sequence").map_err(|e|e.to_string())?;
    let raw=q.query_map(params![start,end],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
    let mut records=Vec::new();for r in raw{let(at,rev,doc)=r.map_err(|e|e.to_string())?;records.push((at,rev,serde_json::from_str(&doc).map_err(|e|e.to_string())?));}
    Ok(combine_day(&records,&day,&start))
}
pub(super) fn request(store:&WorkbenchStore, action:&str, input:&Value)->Result<ApiResponse>{
    let mut db=db(&store.path)?;schema(&db)?;
    if action=="list" {backfill_today(&mut db)?;}
    match action {
        "day"=>Ok(response(200,day_comparison(&db)?)),
        "list"=>{
            let offset=input["offset"].as_u64().unwrap_or(0).min(i64::MAX as u64) as i64;
            let mut stmt=db.prepare("SELECT revision,document,seen FROM workbench_price_changes ORDER BY revision DESC LIMIT 30 OFFSET ?1").map_err(|e|e.to_string())?;
            let result=stmt.query_map([offset],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?))).map_err(|e|e.to_string())?;
            let mut batches=Vec::new();for r in result {let (id,raw,seen)=r.map_err(|e|e.to_string())?;let v:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
                batches.push(json!({"revision":id,"at":v["at"],"message":v["message"],"count":rows(&v["items"]).len(),"seen":seen}));}
            Ok(response(200,json!({"batches":batches})))
        },
        "detail"=>{
            let id=input["revision"].as_i64().ok_or("缺少批次")?;
            let raw:String=db.query_row("SELECT document FROM workbench_price_changes WHERE revision=?1",[id],|r|r.get(0)).map_err(|_|"价格变化批次不存在")?;
            let mut v:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
            let mut stmt=db.prepare("SELECT config_id FROM workbench_price_handled WHERE revision=?1").map_err(|e|e.to_string())?;
            v["handled"]=stmt.query_map([id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?.into();
            Ok(response(200,v))
        },
        "seen"=>{db.execute("UPDATE workbench_price_changes SET seen=1 WHERE revision=?1",[input["revision"].as_i64().ok_or("缺少批次")?]).map_err(|e|e.to_string())?;Ok(response(200,json!({"ok":true})))},
        "handle"=>{
            let id=input["revision"].as_i64().ok_or("缺少批次")?;let config=input["configId"].as_str().ok_or("缺少配置")?;
            let raw:String=db.query_row("SELECT document FROM workbench_price_changes WHERE revision=?1",[id],|r|r.get(0)).map_err(|_|"价格变化批次不存在")?;
            let v:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
            if !rows(&v["configs"]).iter().any(|c|c["after"]["id"]==config){return Err("配置不属于此批次".into());}
            if input["handled"]==true {db.execute("INSERT INTO workbench_price_handled VALUES(?1,?2,?3) ON CONFLICT(revision,config_id) DO UPDATE SET at=excluded.at",params![id,config,now()])}else{db.execute("DELETE FROM workbench_price_handled WHERE revision=?1 AND config_id=?2",params![id,config])}.map_err(|e|e.to_string())?;
            Ok(response(200,json!({"ok":true})))
        },
        _=>Err("价格变化操作不存在".into())
    }
}
