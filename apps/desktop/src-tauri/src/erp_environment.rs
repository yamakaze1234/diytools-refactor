//! 固定辅助程序的离线环境检查，不读取或使用 ERP 凭据。
use crate::erp_runtime::{self, ProcessGuard};
use serde::{Deserialize, Serialize};
use std::{process::Stdio, time::Duration};

#[derive(Debug, Deserialize, Serialize)]
pub struct PackageCheck {
    pub status: String,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EnvironmentReport {
    pub service: String,
    pub python: String,
    pub executable: String,
    pub platform: String,
    pub erp_package: PackageCheck,
    pub erp_connected: bool,
}

#[tauri::command]
// 在超时限制下运行固定辅助程序的离线检查，只报告环境能力，不尝试成员登录。
pub async fn check_erp_environment(
    store: tauri::State<'_, crate::workbench_store::WorkbenchStore>,
) -> Result<EnvironmentReport, String> {
    let directory = store.path.parent().ok_or("本机数据目录无效")?;
    check_erp_environment_at(directory).await
}

// 环境检查使用同一个本机数据目录，缺运行时返回固定能力错误，不影响本地工作台。
pub async fn check_erp_environment_at(
    directory: &std::path::Path,
) -> Result<EnvironmentReport, String> {
    let mut command = erp_runtime::command(directory)?;
    command.stdin(Stdio::null());
    let child = command.spawn().map_err(|_| "无法启动 ERP 环境检查")?;
    let _guard = ProcessGuard::attach(&child)?;
    let output = tokio::time::timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| "ERP 环境检查超时，进程已终止。".to_string())?
        .map_err(|_| "ERP 环境检查未完成".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Python 检查进程异常退出（{}），请运行 pnpm check:python 查看详细错误。",
            output.status
        ));
    }
    let report: EnvironmentReport = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Python 返回格式不正确，请运行 pnpm check:python 检查输出。".to_string())?;
    if report.service != "diytools-erp-worker" || report.erp_connected {
        return Err("Python 返回了不符合环境检查约定的结果。".into());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    // 公开工程默认验证协议即可，不要求安装本机私有适配器或可选 Python 环境。
    #[test]
    fn missing_adapter_report_is_valid_offline_state() {
        let report: super::EnvironmentReport = serde_json::from_value(serde_json::json!({
            "service":"diytools-erp-worker", "python":"3.13.6", "executable":"example-python", "platform":"win32",
            "erp_package":{"status":"missing", "version":null, "message":"本机未配置适配器"}, "erp_connected":false
        })).unwrap();
        assert_eq!(report.erp_package.status, "missing");
        assert!(!report.erp_connected);
    }

    #[test]
    #[ignore = "requires locally installed optional ERP worker"]
    fn actual_worker_returns_environment_report() {
        tauri::async_runtime::block_on(async {
            let report =
                super::check_erp_environment_at(std::path::Path::new("unused-erp-test-data"))
                    .await
                    .expect("worker should run");
            assert_eq!(report.service, "diytools-erp-worker");
            assert!(report.python.starts_with("3.13."));
            assert!(!report.erp_connected);
            assert!(["ready", "missing", "error"].contains(&report.erp_package.status.as_str()));
        });
    }
}
