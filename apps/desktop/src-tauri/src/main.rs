// 桌面可执行文件入口；辅助命令先行处理，普通启动才创建 Tauri 工作台。
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(debug_assertions))]
const _: () = assert!(!tauri::is_dev(), "Release desktop must embed frontend assets: use pnpm build:desktop --no-bundle or --features custom-protocol");

// 先执行资源探针和辅助命令，未命中时才进入工作台主生命周期。
fn main() {
    if let Some(code) = desktop_lib::run_embedded_asset_probe() {
        std::process::exit(code);
    }
    if let Some(code) = desktop_lib::run_update_helper() {
        std::process::exit(code);
    }
    desktop_lib::run()
}
