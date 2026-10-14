// 桌面宿主装配入口：选择本机数据目录，注册存储、ERP、云同步和导出命令，并管理退出收尾。
mod asset_protocol;
mod cloud_transport;
mod cloud_native;
mod erp_environment;
mod erp_runtime;
mod erp_session;
mod sql_sync;
mod local_store;
mod migration_store;
mod workbench_store;
mod updater;
mod embedded_assets;
use tauri::Manager;

pub use embedded_assets::run_embedded_asset_probe;

// 优先处理离线 ERP 检查与更新助手命令，命中时不启动普通业务窗口。
pub fn run_update_helper() -> Option<i32> {
    if std::env::args().nth(1).as_deref() == Some("--check-erp") {
        let result = tauri::async_runtime::block_on(async {
            // 无窗口探针复用便携/开发数据目录，只查离线环境，不初始化业务库。
            let executable = std::env::current_exe().map_err(|_| "程序目录不可用")?;
            let directory = executable.parent().ok_or("程序目录不可用")?;
            let folder = if directory.join("diytools-portable.json").is_file() {
                directory.join("data")
            } else if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox")
            } else {
                std::path::PathBuf::from(std::env::var_os("APPDATA").ok_or("本机数据目录不可用")?).join("io.diytools.refactor")
            };
            let environment = erp_environment::check_erp_environment_at(&folder).await?;
            let state = erp_session::ErpSessionState::default();
            state.configure_vault(folder.join("sql-credentials.dpapi.json"))?;
            let session = state.offline_probe().await?;
            Ok::<_, String>(serde_json::json!({"environment":environment,"session":session}))
        });
        return Some(match result {
            Ok(report) => { println!("{report}"); 0 }
            Err(error) => { println!("{}", serde_json::json!({"error":error})); 1 }
        });
    }
    updater::helper_entry()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// 按便携标记或应用目录初始化独立本机库，再装配 IPC 和资源协议。
pub fn run() {
    tauri::Builder::default()
        .manage(updater::UpdaterState::default())
        .manage(erp_session::ErpSessionState::default())
        .setup(|app| {
            let executable_dir = std::env::current_exe()?.parent().map(std::path::Path::to_path_buf)
                .ok_or_else(|| std::io::Error::other("程序目录不可用"))?;
            let portable = executable_dir.join("diytools-portable.json");
            // 便携数据跟随当前程序目录；开发模式使用 sandbox，避免误用正式安装目录。
            let folder = if portable.is_file() {
                let marker: serde_json::Value = serde_json::from_slice(&std::fs::read(portable)?)?;
                if marker["mode"] != "portable" { return Err(std::io::Error::other("便携版标记格式无效").into()); }
                executable_dir.join("data")
            } else if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox")
            } else {
                app.path().app_data_dir()?
            };
            let path = folder.join("refactor.sqlite");
            app.state::<erp_session::ErpSessionState>().configure_vault(folder.join("sql-credentials.dpapi.json"))
                .map_err(std::io::Error::other)?;
            local_store::initialize(&path).map_err(std::io::Error::other)?;
            app.manage(local_store::LocalStore(path));
            let migration_path = folder.join("migration.sqlite");
            migration_store::initialize(&migration_path).map_err(std::io::Error::other)?;
            app.manage(migration_store::ImportedStore(migration_path));
            let captured = folder.join("migration-review/20261011/source-state.json");
            // 只有主库和迁移源都不存在时才生成空种子，已有保存数据不能被初始化覆盖。
            let seed = if !cfg!(debug_assertions) && !folder.join("workbench.sqlite").exists() && !captured.exists() {
                let initial = folder.join("initial-state.json");
                if !initial.exists() {
                    use std::io::Write;
                    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&initial)?;
                    file.write_all(br#"{"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{},"logs":[]}"#)?;
                    file.sync_all()?;
                }
                initial
            } else { captured };
            let workbench = workbench_store::initialize(
                &folder.join("workbench.sqlite"),
                &seed,
                &folder.join("workbench-assets"),
            )
            .map_err(std::io::Error::other)?;
            app.manage(workbench);
            app.manage(std::sync::Arc::new(cloud_native::CloudRuntime::new(&folder).map_err(std::io::Error::other)?));
            app.manage(asset_protocol::AssetRoot(folder.join("workbench-assets")));
            // 初始化和数据库迁移成功才确认更新，助手不能将进程存活误判为就绪。
            updater::acknowledge_startup().map_err(std::io::Error::other)?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("workbench-asset", |context, request| {
            asset_protocol::serve(
                &context.app_handle().state::<asset_protocol::AssetRoot>().0,
                request,
            )
        })
        .invoke_handler(tauri::generate_handler![
            updater::updater_check,
            updater::updater_download,
            updater::updater_install,
            updater::updater_recovery_status,
            updater::access::updater_access_status,
            updater::access::updater_access_save,
            updater::access::updater_access_clear,
            erp_environment::check_erp_environment,
            erp_session::erp_session_request,
            sql_sync::sql_sync_request,
            cloud_native::cloud_native_request,
            cloud_native::cloud_native_json_request,
            local_store::list_configs,
            local_store::get_config,
            local_store::save_config,
            local_store::undo_config,
            migration_store::preview_legacy_import,
            migration_store::apply_legacy_import,
            migration_store::list_imported_workspaces,
            migration_store::get_imported_workspace,
            migration_store::rename_imported_config,
            migration_store::undo_imported_workspace,
            workbench_store::workbench_request,
            workbench_store::workbench_read_asset,
            workbench_store::workbench_export_folder
        ])
        .build(embedded_assets::context())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(6),
                        app.state::<erp_session::ErpSessionState>().shutdown()).await;
                });
            }
        });
}
