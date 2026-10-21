//! 隔离真实云验收入口，共用正式传输层。
fn main() -> Result<(), Box<dyn std::error::Error>> { desktop_lib::run_cloud_review_host() }
