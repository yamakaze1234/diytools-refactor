// 公司 SQL 同步的原生协调层：只接收可信辅助进程返回的查询结果，前端确认时只提交预览编号。
//! Native coordinator: credentials stay in the worker; only trusted query rows reach previews.
use crate::{erp_session::ErpSessionState, workbench_store::{self, ApiResponse, WorkbenchStore}};
use serde_json::{Value, json};

// 限制请求体大小和顶层对象类型，错误不回显可能包含密码的原文。
fn parse_body(body: Option<&str>) -> Result<Value, String> {
    let body = body.unwrap_or("{}");
    if body.len() > 64 * 1024 { return Err("SQL 请求超过允许大小".into()); }
    let value: Value = serde_json::from_str(body).map_err(|_| "SQL 请求格式无效")?;
    if !value.is_object() { return Err("SQL 请求必须是对象".into()); }
    Ok(value)
}

// 查询数据只能来自只读 worker；应用阶段只消费已持久化的预览编号。
async fn dispatch(store: WorkbenchStore, worker: &ErpSessionState, method: &str, path: &str, body: Option<&str>) -> Result<Value, String> {
    match (method, path) {
        ("GET", "/api/erp-sync/status") => tauri::async_runtime::spawn_blocking(move || workbench_store::sql_status(&store)).await.map_err(|_| "读取 ERP 同步状态失败")?,
        ("GET", "/api/sql-sync/credentials") => worker.sql_request(json!({"action":"sql_credentials_load"})).await,
        ("POST", "/api/sql-sync/credentials/clear") => worker.sql_request(json!({"action":"sql_credentials_clear"})).await,
        // 只返回用户选择的路径，不读取或修改 Excel；取消时保留原设置。
        ("POST", "/api/sql-sync/cost-file") => {
            tauri::async_runtime::spawn_blocking(|| {
                match rfd::FileDialog::new().set_title("选择含税成本 Excel 表格")
                    .add_filter("Excel 表格", &["xlsb", "xlsx"]).pick_file() {
                    Some(path) => Ok(json!({"path":path.to_string_lossy()})),
                    None => Ok(json!({"cancelled":true})),
                }
            }).await.map_err(|_| "打开文件选择窗口失败")?
        }
        ("POST", "/api/sql-sync/cost-preview") => {
            let started=std::time::Instant::now();
            let settings=workbench_store::cost_sync::settings(&store)?;
            if settings["mode"]!="nas" {return Err("请先选择并保存本地 NAS 成本来源".into());}
            let result=worker.sql_request(json!({"action":"sql_cost_file","settings":settings})).await?;
            let rows=result["rows"].clone();
            tauri::async_runtime::spawn_blocking(move || {let mut plan=workbench_store::cost_sync::preview(&store,rows,&settings)?;plan["invalidCount"]=result["invalidCount"].clone();plan["invalid"]=result["invalid"].clone();plan["sourceSha256"]=result["sourceSha256"].clone();plan["fileReadMs"]=result["fileReadMs"].clone();plan["fileCacheHit"]=result["cacheHit"].clone();plan["elapsedMs"]=(started.elapsed().as_millis() as u64).into();Ok(plan)}).await.map_err(|_|"成本预览失败")?
        }
        ("POST", "/api/sql-sync/preview") => {
            let input = parse_body(body)?;
            if input.as_object().unwrap().keys().any(|k| !["settings", "password", "remember", "operator"].contains(&k.as_str())) {
                return Err("SQL 预览请求包含不支持的字段".into());
            }
            let settings = input.get("settings").filter(|s| s.is_object()).cloned().ok_or("请填写数据库连接设置")?;
            let operator = input.get("operator").and_then(Value::as_str).unwrap_or("本机操作人").to_owned();
            if operator.chars().count() > 100 { return Err("操作人名称过长".into()); }
            let checked_store = store.clone();
            let checked_settings = settings.clone();
            tauri::async_runtime::spawn_blocking(move || workbench_store::sql_validate_source(&checked_store, &checked_settings)).await.map_err(|_| "核对数据库来源失败")??;
            let result = worker.sql_request(json!({"action":"sql_read","settings":settings,"password":input["password"],"remember":input["remember"]})).await?;
            let rows = result.get("rows").filter(|r| r.is_array()).cloned().ok_or("数据库返回格式无效，未应用任何结果")?;
            let normalized = result.get("settings").cloned().unwrap_or(settings);
            tauri::async_runtime::spawn_blocking(move || workbench_store::sql_preview(&store, rows, &normalized, &operator)).await.map_err(|_| "生成 ERP 差异预览失败")?
        }
        ("POST", "/api/sql-sync/apply") => {
            let input = parse_body(body)?;
            if input.as_object().unwrap().keys().any(|key| key != "id") { return Err("确认应用仅接受预览编号".into()); }
            let id = input["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 200).ok_or("预览编号无效")?.to_owned();
            tauri::async_runtime::spawn_blocking(move || workbench_store::sql_apply(&store, &id)).await.map_err(|_| "应用 ERP 差异失败")?
        }
        _ => Err("不支持此数据库操作".into()),
    }
}

#[tauri::command]
// 将原生 SQL 协调结果转换为页面兼容回执，阻塞数据库步骤由调度层移出界面线程。
pub async fn sql_sync_request(store: tauri::State<'_, WorkbenchStore>, worker: tauri::State<'_, ErpSessionState>, method: String, path: String, body: Option<String>) -> Result<ApiResponse, String> {
    let result = dispatch(store.inner().clone(), worker.inner(), &method, &path, body.as_deref()).await;
    Ok(match result {
        Ok(value) => ApiResponse { status: 200, body: value.to_string() },
        Err(error) => ApiResponse { status: 400, body: json!({"error":error}).to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_and_oversized_requests_are_rejected() {
        assert!(parse_body(Some("[]")).is_err());
        assert!(parse_body(Some("private-not-json")).unwrap_err().find("private").is_none());
        assert!(parse_body(Some(&" ".repeat(64 * 1024 + 1))).is_err());
    }
}
#[cfg(test)]
mod cost_file_acceptance {
    use super::*;
    // 手工验收需显式提供只读表格与已打包 worker；全部应用仅写隔离库。
    #[test]
    #[ignore = "requires COST_TEST_FILE and COST_TEST_WORKER; uses isolated data"]
    fn packaged_file_to_native_preview_and_apply() {
        let workbook=std::env::var("COST_TEST_FILE").expect("COST_TEST_FILE");
        let worker_path=std::env::var("COST_TEST_WORKER").expect("COST_TEST_WORKER");
        let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/cost-native-acceptance").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::copy(&worker_path,root.join("runtime/erp-worker.exe")).unwrap();
        let old_worker=std::fs::read(root.join("runtime/erp-worker.exe")).unwrap();
        let seed=root.join("initial.json");
        std::fs::write(&seed,json!({"revision":1,"configs":[],"costSource":[],"sourceCatalog":[],"templates":[],"caseGallery":[],"shopSettings":{}}).to_string()).unwrap();
        let store=workbench_store::initialize(&root.join("workbench.sqlite"),&seed,&root.join("assets")).unwrap();
        workbench_store::cost_sync::save_settings(&store,&json!({"mode":"nas","path":workbook,"sheet":"库存数据","goodsColumn":54,"taxColumn":67})).unwrap();
        let worker=ErpSessionState::default();worker.configure_vault(root.join("sql-vault.json")).unwrap();
        let started=std::time::Instant::now();
        let plan=tauri::async_runtime::block_on(dispatch(store.clone(),&worker,"POST","/api/sql-sync/cost-preview",Some("{}"))).unwrap();
        assert!(plan["total"].as_u64().unwrap()>10000);assert!(plan["sourceSha256"].as_str().unwrap().len()==64);
        let preview_ms=started.elapsed().as_millis() as u64;
        let repeat=tauri::async_runtime::block_on(dispatch(store.clone(),&worker,"POST","/api/sql-sync/cost-preview",Some("{}"))).unwrap();
        assert_eq!(repeat["fileCacheHit"],true);
        assert_eq!(std::fs::read(root.join("runtime/erp-worker.exe")).unwrap(),old_worker);
        let plan=repeat;
        let applied=workbench_store::cost_sync::apply(&store,plan["id"].as_str().unwrap()).unwrap();
        let applied_ms=started.elapsed().as_millis() as u64-preview_ms;
        assert_eq!(applied["ok"],true);assert_eq!(applied["total"],plan["total"]);
        let conn=rusqlite::Connection::open(&store.path).unwrap();
        let count:i64=conn.query_row("SELECT json_array_length(json_extract(document,'$.costSource')) FROM workbench_metadata WHERE id=1",[],|r|r.get(0)).unwrap();
        assert_eq!(count,plan["total"].as_i64().unwrap());
        let receipt=json!({"ok":true,"total":plan["total"],"invalidCount":plan["invalidCount"],"revision":applied["revision"],"previewMs":preview_ms,"applyMs":applied_ms,"elapsedMs":started.elapsed().as_millis() as u64,"scope":"packaged worker -> native preview -> confirmed SQLite apply in isolated database"});
        std::fs::write(root.join("result.json"),receipt.to_string()).unwrap();
        println!("cost_native_acceptance={receipt}");
        tauri::async_runtime::block_on(worker.shutdown());
    }
}
