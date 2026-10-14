// 本机缓存维护：每三天按计划清理可重建索引和已登记旧生成图，保留业务、历史、草稿及原图。
//! Maintain rebuildable configuration indexes and explicitly tracked generated images.
//! Business state, recovery/history, sync queues, ERP data and original images are preserved.
use super::*;

const CLEANUP_INTERVAL_SECONDS: i64 = 3 * 24 * 60 * 60;

fn schedule(c: &Connection) -> Result<Option<(i64, Option<i64>)>> {
    if !has_table(c, "workbench_cache_maintenance")? { return Ok(None); }
    c.query_row("SELECT started_at,last_cleared_at FROM workbench_cache_maintenance WHERE id=1", [],
        |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())
}

fn timestamp(seconds: i64) -> Result<String> {
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .ok_or_else(|| "缓存维护时间无效".to_string())
}

// 以首次维护时间或最近清理时间推算下次到期时间，不把未执行清理记为成功。
fn schedule_fields(c: &Connection, result: &mut Value) -> Result<()> {
    result["intervalSeconds"] = json!(CLEANUP_INTERVAL_SECONDS);
    result["lastClearedAt"] = Value::Null;
    result["nextCleanupAt"] = Value::Null;
    if let Some((started, last)) = schedule(c)? {
        if let Some(at) = last { result["lastClearedAt"] = json!(timestamp(at)?); }
        result["nextCleanupAt"] = json!(timestamp(last.unwrap_or(started).checked_add(CLEANUP_INTERVAL_SECONDS).ok_or("缓存维护时间无效")?)?);
    }
    Ok(())
}

fn has_table(c: &Connection, name: &str) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    ).map_err(|e| e.to_string())
}

// 统计索引实际 UTF-8 载荷字节；该值不是 SQLite 文件可立即释放的磁盘空间。
fn index_measurements(c: &Connection) -> Result<Value> {
    let (count, bytes): (i64, i64) = if has_table(c, "workbench_config_projection")? {
        // Payload bytes, not database page size or expected disk space reclaimed.
        // BLOB casts count UTF-8 bytes rather than Unicode code points.
        c.query_row(
            "SELECT COUNT(*),COALESCE(SUM(length(CAST(id AS BLOB))+length(CAST(document AS BLOB))+length(CAST(summary AS BLOB))),0) FROM workbench_config_projection",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| e.to_string())?
    } else { (0, 0) };
    Ok(json!({"id":"configuration-index","label":"配置索引缓存","count":count,"bytes":bytes,
        "byteMeasure":"utf8-payload","storageEffect":"sqlite-reusable","rebuildOnDemand":true}))
}

fn measurements(tx: &Transaction, store: &WorkbenchStore, at: i64) -> Result<Value> {
    let index = index_measurements(tx)?;
    let images = image_cache::preview(tx,store,at)?;
    let mut result = json!({
        "count":index["count"].as_i64().unwrap_or(0)+images["count"].as_i64().unwrap_or(0),
        "bytes":index["bytes"].as_i64().unwrap_or(0)+images["bytes"].as_i64().unwrap_or(0),
        "categories":[index,images],"byteMeasure":"cache-payload-and-files",
        "storageEffect":"sqlite-reusable-and-generated-files","rebuildOnDemand":true
    });
    schedule_fields(tx,&mut result)?;
    Ok(result)
}

// 只统计可清理对象和计划时间，不为预览额外构建索引。
pub(super) fn preview(store: &WorkbenchStore) -> Result<ApiResponse> {
    let mut c = db(&store.path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let result = measurements(&tx,store,chrono::Utc::now().timestamp())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(200, result))
}

// 用户主动清理无需等到周期到期，但仍遵守同一缓存范围和文件校验。
pub(super) fn clear(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    maintain_at(store, input, chrono::Utc::now().timestamp(), false)
}

// 自动维护入口按三天周期判断，不因每次启动或检查重复清理。
pub(super) fn maintain(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    maintain_at(store, input, chrono::Utc::now().timestamp(), true)
}

// 将计划、索引清理和结果统一管理；文件删除不可由 SQLite 回滚，错误须保留真实完成量。
fn maintain_at(store: &WorkbenchStore, input: &Value, at: i64, automatic: bool) -> Result<ApiResponse> {
    // No client-supplied paths, table names, categories or deletion policy.
    if !input.as_object().is_some_and(|v| v.is_empty()) {
        return Ok(failure(400, "缓存清理不接受自定义范围或参数"));
    }
    let mut c = db(&store.path)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workbench_cache_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL,last_cleared_at INTEGER);")
        .map_err(|e| e.to_string())?;
    let previous = schedule(&tx)?;
    if automatic && previous.is_none_or(|(started,last)| at.saturating_sub(last.unwrap_or(started)) < CLEANUP_INTERVAL_SECONDS) {
        if previous.is_none() {
            tx.execute("INSERT INTO workbench_cache_maintenance VALUES(1,?1,NULL)",[at])
                .map_err(|e| e.to_string())?;
        }
        // Hourly due checks must not scan the projection or image references.
        // Full counts are available from preview and after an actual cleanup.
        let mut result = json!({});
        schedule_fields(&tx, &mut result)?;
        result["skipped"] = json!(true);
        result["reason"] = json!(if previous.is_none() { "initialized" } else { "not-due" });
        result["cleared"] = json!({"count":0,"bytes":0});
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(response(200,result));
    }
    let before = index_measurements(&tx)?;
    if has_table(&tx, "workbench_config_projection")? {
        tx.execute("DELETE FROM workbench_config_projection", [])
            .map_err(|e| e.to_string())?;
    }
    if has_table(&tx, "workbench_config_projection_meta")? {
        tx.execute("DELETE FROM workbench_config_projection_meta", [])
            .map_err(|e| e.to_string())?;
    }
    // A file cleanup error returns before the scheduling timestamp is changed;
    // any files already removed are reported by the image module's error text.
    let images = image_cache::clear(&tx,store,at)?;
    let cleanup_error = |error: String| format!("缓存清理未全部完成：{error}；已清除 {} 张生成图，维护时间未确认更新，请重试",images["count"].as_i64().unwrap_or(0));
    tx.execute("INSERT INTO workbench_cache_maintenance VALUES(1,?1,?1) ON CONFLICT(id) DO UPDATE SET last_cleared_at=excluded.last_cleared_at",[at])
        .map_err(|e| cleanup_error(e.to_string()))?;
    let mut result = measurements(&tx,store,at).map_err(&cleanup_error)?;
    result["cleared"] = json!({
        "count":before["count"].as_i64().unwrap_or(0)+images["count"].as_i64().unwrap_or(0),
        "bytes":before["bytes"].as_i64().unwrap_or(0)+images["bytes"].as_i64().unwrap_or(0),
        "index":{"count":before["count"],"bytes":before["bytes"]},"images":images
    });
    result["skipped"] = json!(false);
    result["reason"] = json!(if automatic {"due"} else {"manual"});
    tx.commit().map_err(|e| cleanup_error(e.to_string()))?;
    Ok(response(200, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> WorkbenchStore {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/cache-store-tests").join(unique());
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        fs::write(&source, json!({"revision":7,"updatedAt":"old","configs":[
            {"id":"a","name":"中文配置","shopId":"intel","productId":"p","parts":[],"actualParts":[],"price":10,"unknown":{"retained":true}}
        ],"logs":[{"id":"archived","message":"保留"}],"templates":[]}).to_string()).unwrap();
        let s = initialize(&root.join("workbench.sqlite"), &source, &root.join("assets")).unwrap();
        let c = db(&s.path).unwrap();
        c.execute_batch("INSERT INTO workbench_recovery VALUES('draft','old','{\"unsaved\":true}');
            INSERT INTO workbench_receipts VALUES('receipt','hash','{}');
            INSERT INTO workbench_activity(document) VALUES('{\"activity\":true}');
            CREATE TABLE protected_cloud(document TEXT); INSERT INTO protected_cloud VALUES('cloud and outbox');
            CREATE TABLE protected_erp(document TEXT); INSERT INTO protected_erp VALUES('erp');").unwrap();
        fs::write(root.join("assets/original.png"), b"original bytes").unwrap();
        fs::write(root.join("assets/generated.png"), b"possibly unsaved image").unwrap();
        s
    }
    fn decoded(r: ApiResponse) -> Value {
        assert_eq!(r.status, 200, "{}", r.body);
        serde_json::from_str(&r.body).unwrap()
    }
    fn call(s: &WorkbenchStore, method: &str, endpoint: &str, body: Option<&str>) -> Value {
        decoded(request(s, method, endpoint, body).unwrap())
    }
    fn protected_rows(c: &Connection) -> Vec<Vec<String>> {
        // Exact stored text and table contents, including recovery and receipts.
        ["SELECT document FROM workbench_state", "SELECT document FROM workbench_log_archive",
            "SELECT document FROM workbench_history", "SELECT document FROM workbench_activity",
            "SELECT id||at||document FROM workbench_recovery", "SELECT operation||hash||document FROM workbench_receipts",
            "SELECT document FROM protected_cloud", "SELECT document FROM protected_erp"]
            .into_iter().map(|sql| {
                c.prepare(sql).unwrap().query_map([], |r| r.get::<_,String>(0)).unwrap()
                    .map(|r| r.unwrap()).collect()
            }).collect()
    }

    #[test]
    fn missing_and_empty_projection_are_successful_zero_without_building_cache() {
        let s = fixture(); let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        // 初始化现已自动建立投影；本用例显式模拟旧安装缺少缓存表的状态。
        c.execute_batch("DROP TABLE workbench_config_projection; DROP TABLE workbench_config_projection_meta;").unwrap();
        let preview = call(&s,"GET","/api/cache/preview",None);
        assert_eq!(preview["count"],0); assert_eq!(preview["bytes"],0);
        let cleared = call(&s,"POST","/api/cache/clear",None);
        assert_eq!(cleared["cleared"]["count"],0); assert_eq!(cleared["cleared"]["bytes"],0);
        assert!(!has_table(&c,"workbench_config_projection").unwrap());
        assert_eq!(protected_rows(&c),before);
    }

    #[test]
    fn clears_only_cache_and_rebuilds_with_exact_state_and_utf8_measurements() {
        let s = fixture(); let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let index = call(&s,"GET","/api/workspace/index",None);
        let expected: i64 = c.query_row("SELECT id,document,summary FROM workbench_config_projection",[],|r| {
            Ok((r.get::<_,String>(0)?.len()+r.get::<_,String>(1)?.len()+r.get::<_,String>(2)?.len()) as i64)
        }).unwrap();
        let preview = call(&s,"GET","/api/cache/preview",None);
        assert_eq!(preview["bytes"],expected); assert_eq!(preview["count"],1);
        let cleared = call(&s,"POST","/api/cache/clear",Some("{}"));
        assert_eq!(cleared["cleared"]["index"],json!({"count":1,"bytes":expected}));
        assert_eq!(cleared["cleared"]["count"],1); assert_eq!(cleared["cleared"]["bytes"],expected);
        assert_eq!(cleared["count"],0); assert_eq!(cleared["categories"][0]["storageEffect"],"sqlite-reusable");
        assert_eq!(c.query_row::<i64,_,_>("SELECT COUNT(*) FROM workbench_config_projection_meta",[],|r|r.get(0)).unwrap(),0);
        assert_eq!(protected_rows(&c),before);
        let root = s.path.parent().unwrap();
        assert_eq!(fs::read(root.join("assets/original.png")).unwrap(),b"original bytes");
        assert_eq!(fs::read(root.join("assets/generated.png")).unwrap(),b"possibly unsaved image");
        let rebuilt = call(&s,"POST","/api/configs/load",Some("{\"ids\":[\"a\"],\"revision\":7}"));
        assert_eq!(rebuilt["configs"][0],state(&c).unwrap()["configs"][0]);
        assert_eq!(call(&s,"GET","/api/workspace/index",None),index);
        assert_eq!(protected_rows(&c),before);
        assert_eq!(c.query_row::<String,_,_>("PRAGMA quick_check",[],|r|r.get(0)).unwrap(),"ok");
        call(&s,"POST","/api/cache/clear",Some("{}"));
        assert_eq!(call(&s,"POST","/api/cache/clear",Some("{}"))["cleared"]["count"],0);
    }

    #[test]
    fn clear_failure_rolls_back_both_projection_tables() {
        let s = fixture(); call(&s,"GET","/api/workspace/index",None);
        let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let preview = call(&s,"GET","/api/cache/preview",None);
        c.execute_batch("CREATE TRIGGER deny_cache_meta BEFORE DELETE ON workbench_config_projection_meta BEGIN SELECT RAISE(ABORT,'test cache failure'); END;").unwrap();
        assert!(clear(&s,&json!({})).is_err());
        assert_eq!(call(&s,"GET","/api/cache/preview",None),preview);
        assert_eq!(c.query_row::<i64,_,_>("SELECT revision FROM workbench_config_projection_meta",[],|r|r.get(0)).unwrap(),7);
        assert_eq!(protected_rows(&c),before);
    }

    #[test]
    fn request_cannot_expand_cache_scope() {
        let s = fixture(); call(&s,"GET","/api/workspace/index",None);
        let before = call(&s,"GET","/api/cache/preview",None);
        for body in [json!({"path":".."}),json!({"tables":["workbench_state"]}),json!({"force":true}),json!(null),json!([])] {
            assert_eq!(request(&s,"POST","/api/cache/clear",Some(&body.to_string())).unwrap().status,400);
            assert_eq!(request(&s,"POST","/api/cache/maintain",Some(&body.to_string())).unwrap().status,400);
        }
        assert_eq!(call(&s,"GET","/api/cache/preview",None),before);
    }

    #[test]
    fn automatic_cleanup_starts_later_runs_at_72_hours_and_survives_reopen() {
        let s = fixture(); call(&s,"GET","/api/workspace/index",None);
        let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let start = 1_800_000_000;
        let initial = decoded(maintain_at(&s,&json!({}),start,true).unwrap());
        assert_eq!(initial["reason"],"initialized"); assert!(initial.get("categories").is_none());
        assert_eq!(call(&s,"GET","/api/cache/preview",None)["count"],1);
        assert_eq!(initial["intervalSeconds"],259200); assert!(initial["lastClearedAt"].is_null());
        assert_eq!(initial["nextCleanupAt"],timestamp(start+CLEANUP_INTERVAL_SECONDS).unwrap());
        // Reopen the store through the same public initialization used at startup.
        let reopened = initialize(&s.path,&s.path.with_file_name("source.json"),&s.assets).unwrap();
        let early = decoded(maintain_at(&reopened,&json!({}),start+CLEANUP_INTERVAL_SECONDS-1,true).unwrap());
        assert_eq!(early["reason"],"not-due"); assert!(early.get("categories").is_none());
        assert_eq!(call(&s,"GET","/api/cache/preview",None)["count"],1);
        assert_eq!(schedule(&c).unwrap(),Some((start,None)));
        let due = decoded(maintain_at(&reopened,&json!({}),start+CLEANUP_INTERVAL_SECONDS,true).unwrap());
        assert_eq!(due["skipped"],false); assert_eq!(due["cleared"]["count"],1);
        assert_eq!(due["count"],0); assert_eq!(due["lastClearedAt"],timestamp(start+CLEANUP_INTERVAL_SECONDS).unwrap());
        assert_eq!(due["nextCleanupAt"],timestamp(start+2*CLEANUP_INTERVAL_SECONDS).unwrap());
        assert_eq!(protected_rows(&c),before);
        call(&s,"GET","/api/workspace/index",None);
        let overdue = decoded(maintain_at(&reopened,&json!({}),start+5*CLEANUP_INTERVAL_SECONDS,true).unwrap());
        assert_eq!(overdue["cleared"]["count"],1);
        assert_eq!(overdue["nextCleanupAt"],timestamp(start+6*CLEANUP_INTERVAL_SECONDS).unwrap());
    }

    #[test]
    fn manual_clear_resets_automatic_deadline_without_touching_business_data() {
        let s = fixture(); let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let start = 1_800_000_000;
        decoded(maintain_at(&s,&json!({}),start,true).unwrap());
        let manual = decoded(maintain_at(&s,&json!({}),start+60,false).unwrap());
        assert_eq!(manual["reason"],"manual"); assert_eq!(manual["lastClearedAt"],timestamp(start+60).unwrap());
        call(&s,"GET","/api/workspace/index",None);
        assert_eq!(decoded(maintain_at(&s,&json!({}),start+CLEANUP_INTERVAL_SECONDS,true).unwrap())["reason"],"not-due");
        assert_eq!(schedule(&c).unwrap(),Some((start,Some(start+60))));
        let due = decoded(maintain_at(&s,&json!({}),start+60+CLEANUP_INTERVAL_SECONDS,true).unwrap());
        assert_eq!(due["cleared"]["count"],1);
        assert_eq!(protected_rows(&c),before);
        // A manual clear also enables the schedule before any automatic tick.
        let fresh = fixture();
        decoded(maintain_at(&fresh,&json!({}),start,false).unwrap());
        assert_eq!(schedule(&db(&fresh.path).unwrap()).unwrap(),Some((start,Some(start))));
    }

    #[test]
    fn failed_cleanup_or_timestamp_update_rolls_back_cache_and_deadline() {
        let s = fixture(); let c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let start = 1_800_000_000;
        decoded(maintain_at(&s,&json!({}),start,true).unwrap());
        call(&s,"GET","/api/workspace/index",None);
        let preview = call(&s,"GET","/api/cache/preview",None);
        c.execute_batch("CREATE TRIGGER deny_schedule BEFORE UPDATE ON workbench_cache_maintenance BEGIN SELECT RAISE(ABORT,'test maintenance failure'); END;").unwrap();
        assert!(maintain_at(&s,&json!({}),start+CLEANUP_INTERVAL_SECONDS,true).is_err());
        assert_eq!(call(&s,"GET","/api/cache/preview",None),preview);
        assert_eq!(schedule(&c).unwrap(),Some((start,None)));
        c.execute_batch("DROP TRIGGER deny_schedule; CREATE TRIGGER deny_projection BEFORE DELETE ON workbench_config_projection BEGIN SELECT RAISE(ABORT,'test projection failure'); END;").unwrap();
        assert!(maintain_at(&s,&json!({}),start+CLEANUP_INTERVAL_SECONDS,true).is_err());
        assert_eq!(call(&s,"GET","/api/cache/preview",None),preview);
        assert_eq!(schedule(&c).unwrap(),Some((start,None)));
        assert_eq!(protected_rows(&c),before);
    }

    #[test]
    fn image_cleanup_error_does_not_advance_schedule_or_clear_index() {
        let s = fixture(); let mut c = db(&s.path).unwrap(); let before = protected_rows(&c);
        let start = 1_800_000_000;
        decoded(maintain_at(&s,&json!({}),start,true).unwrap());
        call(&s,"GET","/api/workspace/index",None);
        let tx = c.transaction().unwrap();
        let input = json!({"id":"a","layout":"square","theme":"light"});
        let old = image_cache::save(&tx,&s,&input,b"old generated image",start).unwrap();
        image_cache::save(&tx,&s,&input,b"latest generated image",start+1).unwrap();
        // Malformed cache metadata must fail closed before any file is touched.
        tx.execute("UPDATE workbench_generated_images SET path='/saved/../original.png' WHERE path=?1",[old]).unwrap();
        tx.commit().unwrap();
        assert!(maintain_at(&s,&json!({}),start+CLEANUP_INTERVAL_SECONDS,true).is_err());
        assert_eq!(schedule(&c).unwrap(),Some((start,None)));
        assert_eq!(index_measurements(&c).unwrap()["count"],1);
        assert_eq!(protected_rows(&c),before);
        assert_eq!(fs::read(s.assets.join("original.png")).unwrap(),b"original bytes");
    }
}
