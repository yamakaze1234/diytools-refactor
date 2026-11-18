// 桌面可执行文件入口；辅助命令先行处理，普通启动才创建 Tauri 工作台。
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(debug_assertions))]
const _: () = assert!(!tauri::is_dev(), "Release desktop must embed frontend assets: use pnpm build:desktop --no-bundle or --features custom-protocol");

// 先执行资源探针和辅助命令，未命中时才进入工作台主生命周期。
fn main() {
    // 普通双击入口在任何运行时/线程创建前读取旁置配置；辅助探针保留原有参数语义。
    #[cfg(feature = "formal-nas-client")]
    if std::env::args_os().len()==1 {
        // 安全：这是 main 首个执行步骤，尚未调用任何会创建后台线程的组件。
        if let Err(message)=unsafe { desktop_lib::prepare_formal_launch() } {
            rfd::MessageDialog::new().set_title("DIY 配置工作台无法启动")
                .set_description(&message).set_level(rfd::MessageLevel::Error).show();
            std::process::exit(1);
        }
    }
    if let Some(code) = desktop_lib::run_embedded_asset_probe() {
        std::process::exit(code);
    }
    if let Some(code) = desktop_lib::run_nas_tls_probe() {
        std::process::exit(code);
    }
    if let Some(code) = desktop_lib::run_update_helper() {
        std::process::exit(code);
    }
    desktop_lib::run()
}
