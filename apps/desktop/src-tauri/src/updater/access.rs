// GitHub 更新凭据只留在本机 Windows 凭据管理器；IPC 只返回配置来源，不返回密钥。
use serde::Serialize;
use std::sync::Mutex;

const TARGET: &str = "DIYTools.Refactor.GitHub.yamakaze1234.diytools-refactor";
static LAST_SOURCE: Mutex<&str> = Mutex::new("none");
static ACCESS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct AccessStatus {
    configured: bool,
    source: &'static str,
}

// 不实现 Debug/Serialize，避免密钥进入日志或前端响应；离开作用域时清空内存缓冲。
pub(super) struct Token(String);
impl Token {
    pub(super) fn value(&self) -> &str {
        &self.0
    }
}
impl Drop for Token {
    fn drop(&mut self) {
        // 全零仍是有效 UTF-8，且独占 String；volatile 防止清理写入被优化掉。
        for byte in unsafe { self.0.as_mut_vec() } {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}
fn token(value: String) -> Result<Token, String> {
    let value = Token(value);
    if value.value().is_empty()
        || value.value().len() > 2048
        || !value
            .value()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("GitHub token 格式无效；请粘贴完整 token，不要带空格或换行".into());
    }
    Ok(value)
}
fn remember(source: &'static str) {
    if let Ok(mut last) = LAST_SOURCE.lock() {
        *last = source;
    }
}
fn report(source: &'static str) -> AccessStatus {
    AccessStatus {
        configured: source != "none",
        source,
    }
}

// 状态查询不启动 gh；只有真正检查更新时才尝试复用已登录的 CLI 凭据。
pub(super) fn status() -> Result<AccessStatus, String> {
    let _guard = ACCESS_LOCK.lock().map_err(|_| "更新授权状态不可用")?;
    if read()?.is_some() {
        return Ok(report("credential"));
    }
    let last = *LAST_SOURCE.lock().map_err(|_| "更新授权状态不可用")?;
    Ok(report(if last == "gh" { "gh" } else { "none" }))
}
pub(super) fn resolve() -> Result<Option<Token>, String> {
    let _guard = ACCESS_LOCK.lock().map_err(|_| "更新授权状态不可用")?;
    if let Some(saved) = read()? {
        remember("credential");
        return Ok(Some(saved));
    }
    let child = super::hidden_command(std::path::Path::new("gh"))
        .args(["auth", "token", "--hostname", "github.com"])
        // 只复用 gh 已保存的 github.com 授权，避免环境变量意外改变账号或主机。
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .env_remove("GITHUB_ENTERPRISE_TOKEN")
        .env_remove("GH_DEBUG")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        remember("none");
        return Ok(None);
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                remember("none");
                return Ok(None);
            }
        }
    }
    let Ok(mut output) = child.wait_with_output() else {
        remember("none");
        return Ok(None);
    };
    let parsed = if output.status.success() {
        // 原始文本也由 Token 管理，修剪时产生的两个缓冲都会清空。
        String::from_utf8(std::mem::take(&mut output.stdout))
            .ok()
            .map(Token)
            .and_then(|value| token(value.value().trim().to_owned()).ok())
    } else {
        None
    };
    // gh 的标准输出和错误输出都不打印；解析后尽快清空原始缓冲。
    output.stdout.fill(0);
    output.stderr.fill(0);
    remember(if parsed.is_some() { "gh" } else { "none" });
    Ok(parsed)
}

#[cfg(windows)]
fn read() -> Result<Option<Token>, String> {
    read_at(TARGET)
}
#[cfg(windows)]
fn read_at(target_name: &str) -> Result<Option<Token>, String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_NOT_FOUND, GetLastError},
        Security::Credentials::*,
    };
    let target: Vec<u16> = target_name.encode_utf16().chain(Some(0)).collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
            Ok(None)
        } else {
            Err("读取 Windows 更新凭据失败".into())
        };
    }
    // CredRead 返回的缓冲必须交还 CredFree，失败分支也不能泄漏。
    struct Owned(*mut CREDENTIALW);
    impl Drop for Owned {
        fn drop(&mut self) {
            // 清空 Windows 返回的密钥副本后释放，避免留下可复用明文缓冲。
            let credential = unsafe { &*self.0 };
            if !credential.CredentialBlob.is_null() {
                for index in 0..credential.CredentialBlobSize as usize {
                    unsafe { std::ptr::write_volatile(credential.CredentialBlob.add(index), 0) };
                }
            }
            unsafe { CredFree(self.0.cast()) };
        }
    }
    let owned = Owned(credential);
    let value = unsafe { &*owned.0 };
    if value.CredentialBlobSize == 0
        || value.CredentialBlobSize > 2048
        || value.CredentialBlob.is_null()
    {
        return Err("已保存的更新凭据无效，请重新保存".into());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize)
    };
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| "已保存的更新凭据无效")?;
    token(text).map(Some)
}
#[cfg(not(windows))]
fn read() -> Result<Option<Token>, String> {
    Ok(None)
}

#[cfg(windows)]
fn save(value: &Token) -> Result<(), String> {
    save_at(TARGET, value)
}
#[cfg(windows)]
fn save_at(target_name: &str, value: &Token) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::*;
    let mut target: Vec<u16> = target_name.encode_utf16().chain(Some(0)).collect();
    let mut username: Vec<u16> = "GitHub".encode_utf16().chain(Some(0)).collect();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: value.value().len() as u32,
        CredentialBlob: value.value().as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err("保存 Windows 更新凭据失败".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn save(_: &Token) -> Result<(), String> {
    Err("此平台不支持 Windows 更新凭据管理器".into())
}
#[cfg(windows)]
fn clear() -> Result<(), String> {
    clear_at(TARGET)
}
#[cfg(windows)]
fn clear_at(target_name: &str) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_NOT_FOUND, GetLastError},
        Security::Credentials::*,
    };
    let target: Vec<u16> = target_name.encode_utf16().chain(Some(0)).collect();
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
        && unsafe { GetLastError() } != ERROR_NOT_FOUND
    {
        return Err("清除 Windows 更新凭据失败".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn clear() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn updater_access_status() -> Result<AccessStatus, String> {
    status()
}
#[tauri::command]
pub async fn updater_access_save(token: String) -> Result<AccessStatus, String> {
    let _guard = ACCESS_LOCK.lock().map_err(|_| "更新授权状态不可用")?;
    let value = self::token(token)?;
    save(&value)?;
    remember("credential");
    Ok(report("credential"))
}
#[tauri::command]
pub async fn updater_access_clear() -> Result<AccessStatus, String> {
    let _guard = ACCESS_LOCK.lock().map_err(|_| "更新授权状态不可用")?;
    clear()?;
    remember("none");
    Ok(report("none"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn windows_credential_round_trip_uses_isolated_synthetic_token() {
        // 真实调用系统 API，但目标唯一且 token 虚构，不接触本应用或 gh 的已有凭据。
        let target = format!("DIYTools.Refactor.Test.{}", uuid::Uuid::new_v4());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = clear_at(&self.0);
            }
        }
        let _cleanup = Cleanup(target.clone());
        assert!(read_at(&target).unwrap().is_none());
        let value = token("ghp_synthetic_test_only_123".into()).unwrap();
        save_at(&target, &value).unwrap();
        let restored = read_at(&target).unwrap().unwrap();
        assert_eq!(restored.value(), value.value());
        clear_at(&target).unwrap();
        assert!(read_at(&target).unwrap().is_none());
        clear_at(&target).unwrap();
    }
    #[test]
    fn token_validation_errors_never_echo_input() {
        for value in [
            "ghp_secret\nInjected",
            "Bearer ghp_secret",
            "",
            "https://signed.example?secret=abc",
        ] {
            let error = token(value.into()).err().unwrap();
            assert!(!error.contains("secret") && !error.contains("signed.example"));
        }
        assert!(token("github_pat_valid_123".into()).is_ok());
    }
    #[test]
    fn status_serializes_only_presence_and_source() {
        assert_eq!(
            serde_json::to_value(report("credential")).unwrap(),
            serde_json::json!({"configured":true,"source":"credential"})
        );
        assert_eq!(
            serde_json::to_value(report("none")).unwrap(),
            serde_json::json!({"configured":false,"source":"none"})
        );
    }
}
