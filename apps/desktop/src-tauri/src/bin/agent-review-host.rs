//! 无界面隔离验收入口，共用桌面库的 Agent 调度与查询实现。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    desktop_lib::run_agent_review_host()
}
