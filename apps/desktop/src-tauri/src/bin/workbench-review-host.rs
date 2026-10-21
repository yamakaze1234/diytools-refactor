//! 隔离存储验收入口，共用正式存储与缓存依赖。
fn main() -> Result<(), Box<dyn std::error::Error>> { desktop_lib::run_workbench_review_host() }
