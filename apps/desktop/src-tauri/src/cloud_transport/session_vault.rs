// 登录续期信息只存当前 Windows 用户的凭据管理器，不进入业务库、便携包或页面。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedSession {
    pub version: u8,
    pub environment: String,
    pub refresh: String,
    pub subject: String,
    pub workspace_id: String,
    pub device_id: String,
}
impl SavedSession {
    pub fn valid(&self, environment: &str) -> bool {
        self.version == 1 && self.environment == environment
            && [&self.refresh, &self.subject, &self.workspace_id].iter().all(|s| !s.is_empty() && !s.chars().any(char::is_control))
            && self.refresh.len() <= 128 && self.subject.len() <= 256 && self.workspace_id.len() <= 256
            && uuid::Uuid::parse_str(&self.device_id).is_ok()
    }
}
impl Drop for SavedSession {
    fn drop(&mut self) {
        for byte in unsafe { self.refresh.as_mut_vec() } {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}
pub(super) struct SessionVault { target: String }
impl SessionVault {
    pub fn new(data_dir: &Path, environment: &str) -> Self {
        let path = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
        let scope = format!("{}\n{}", path.to_string_lossy().to_lowercase(), environment);
        Self { target: format!("DIYTools.Refactor.CloudSession.{:x}", Sha256::digest(scope.as_bytes())) }
    }
    #[cfg(windows)]
    pub fn load(&self) -> Result<Option<SavedSession>, String> {
        use windows_sys::Win32::{Foundation::{ERROR_NOT_FOUND, GetLastError}, Security::Credentials::*};
        let target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        let mut raw: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND { Ok(None) } else { Err("无法读取已保留的登录信息".into()) };
        }
        struct Owned(*mut CREDENTIALW);
        impl Drop for Owned {
            fn drop(&mut self) {
                let value = unsafe { &*self.0 };
                if !value.CredentialBlob.is_null() {
                    for i in 0..value.CredentialBlobSize as usize {
                        unsafe { std::ptr::write_volatile(value.CredentialBlob.add(i), 0) };
                    }
                }
                unsafe { CredFree(self.0.cast()) };
            }
        }
        let owned = Owned(raw);
        let value = unsafe { &*owned.0 };
        if value.CredentialBlobSize == 0 || value.CredentialBlobSize > 2560 || value.CredentialBlob.is_null() {
            return Err("已保留的登录信息无效，请重新登录".into());
        }
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize) })
            .map(Some).map_err(|_| "已保留的登录信息无效，请重新登录".into())
    }
    #[cfg(windows)]
    pub fn save(&self, value: &SavedSession) -> Result<(), String> {
        use windows_sys::Win32::Security::Credentials::*;
        let mut bytes = serde_json::to_vec(value).map_err(|_| "无法保留登录信息")?;
        let mut target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        let credential = CREDENTIALW { Type: CRED_TYPE_GENERIC, TargetName: target.as_mut_ptr(), CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(), Persist: CRED_PERSIST_LOCAL_MACHINE, ..unsafe { std::mem::zeroed() } };
        let ok = bytes.len() <= 2560 && unsafe { CredWriteW(&credential, 0) } != 0;
        for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
        if ok { Ok(()) } else { Err("无法保留登录信息，请取消勾选后重试".into()) }
    }
    #[cfg(windows)]
    pub fn clear(&self) -> Result<(), String> {
        use windows_sys::Win32::{Foundation::{ERROR_NOT_FOUND, GetLastError}, Security::Credentials::*};
        let target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 && unsafe { GetLastError() } != ERROR_NOT_FOUND {
            return Err("无法清除已保留的登录信息，请重试退出登录".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    pub fn load(&self) -> Result<Option<SavedSession>, String> { let _ = &self.target; Ok(None) }
    #[cfg(not(windows))]
    pub fn save(&self, _: &SavedSession) -> Result<(), String> { Err("此平台暂不支持保留登录信息".into()) }
    #[cfg(not(windows))]
    pub fn clear(&self) -> Result<(), String> { Ok(()) }
}
