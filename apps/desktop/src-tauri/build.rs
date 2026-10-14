// 构建入口委托 Tauri 生成平台资源和配置；业务数据迁移不在编译阶段执行。
fn main() {
    tauri_build::build()
}
