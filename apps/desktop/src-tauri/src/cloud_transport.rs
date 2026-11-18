// 腾讯云阻塞传输层：凭据不跨IPC；可选将续期信息保留在本机系统凭据管理器。
//! Native CloudBase transport. Credentials never cross IPC.
//! All network methods are blocking; callers must use `spawn_blocking`.
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
mod session_vault;
use session_vault::{SavedSession, SessionVault};

pub const CLOUD_NOT_CONFIGURED: &str = "CLOUD_NOT_CONFIGURED: 本机尚未配置云服务";
const MAX_RESPONSE: usize = 32 * 1024 * 1024;
const MAX_REQUEST: usize = 600_000;
const MAX_ASSET: usize = 24 * 1024 * 1024;
const LOGIN_REQUIRED: &str = "请先登录成员账号";
const SESSION_EXPIRED: &str = "登录已过期，请重新登录";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTransportConfig {
    pub env_id: String,
    pub endpoint: String,
}

struct Tokens {
    access: String,
    refresh: String,
    subject: String,
    expires: Instant,
}

struct Session {
    tokens: Tokens,
    member: Value,
}

#[derive(Default)]
struct State {
    epoch: u64,
    session: Option<Session>,
    saved: Option<SavedSession>,
    remember: bool,
    restore_error: Option<String>,
}

/// Optional OS credential storage; no background task, custom URL or admin authentication.
pub struct CloudTransport {
    client: Client,
    nas_client: Option<Client>,
    nas_deployment: Option<String>,
    nas_local_auth: bool,
    base: String,
    environment: String,
    device_id: String,
    state: Mutex<State>,
    // Serialize sign-in and refresh rotation, but let logout invalidate immediately.
    auth_gate: Mutex<()>,
    max_response: usize,
    vault: Option<SessionVault>,
}

enum HttpError {
    Unauthorized,
    Safe(String),
}

// 只返回固定认证阶段，不把 URL、代理地址、请求正文或底层错误带到界面。
fn auth_stage(path: &str, body: &Value) -> Option<&'static str> {
    match path {
        "/auth/v1/signin" => Some("云端账号认证"),
        "/auth/v1/token" => Some("云端登录续期"),
        "/v1/functions/workbenchApi" if body["action"] == "session.get" => Some("云端成员权限核验"),
        _ => None,
    }
}

fn auth_transport_message(stage: Option<&str>, operation: &'static str, reason: &'static str) -> String {
    match stage {
        Some(stage) if stage.starts_with("NAS") => format!("{stage}：{operation}{reason}，请检查内网连接后重试"),
        Some(stage) => format!("{stage}：{operation}{reason}，请检查网络或系统代理后重试"),
        None if operation == "响应读取" => "云端响应读取超时或中断".into(),
        None => "云端连接超时或不可用，请检查网络后重试".into(),
    }
}

pub(crate) fn nas_tls_client(pem:&[u8])->Result<Client,String>{
    if pem.is_empty()||pem.len()>16*1024{return Err("NAS 局域网根证书无效".into());}
    let ca=reqwest::Certificate::from_pem(pem).map_err(|_|"NAS 局域网根证书无效")?;
    Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy()
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(15))
        .tls_built_in_root_certs(false).add_root_certificate(ca)
        .build().map_err(|_|"无法初始化 NAS 局域网 HTTPS 信任".into())
}

// 未选择自定义 CA 时仍使用 HTTPS 标准信任，不放宽主机名或证书验证。
pub(crate) fn nas_system_tls_client()->Result<Client,String>{
    Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy()
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(15))
        .build().map_err(|_|"无法初始化 HTTPS 信任".into())
}

impl CloudTransport {
    // 服务地址仅从本机配置读取；强制 HTTPS、无凭据、无查询参数和根路径，禁止页面注入。
    pub fn new(config: CloudTransportConfig) -> Result<Self, String> {
        if config.env_id.is_empty()
            || config.env_id.len() > 128
            || !config
                .env_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("CLOUD_CONFIG_INVALID: 本机云服务环境配置无效".into());
        }
        let endpoint = reqwest::Url::parse(&config.endpoint)
            .map_err(|_| "CLOUD_CONFIG_INVALID: 本机云服务地址无效")?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err("CLOUD_CONFIG_INVALID: 本机云服务必须使用 HTTPS 根地址".into());
        }
        let mut transport = Self::build(
            endpoint.as_str().trim_end_matches('/').into(),
            Duration::from_secs(60),
            MAX_RESPONSE,
        )?;
        // 缓存身份包含环境与地址，避免同名环境切换到另一服务后沿用上传确认。
        transport.environment = format!("{}@{}", config.env_id, transport.base);
        Ok(transport)
    }

    // 未配置时仍构造本地会话状态；空地址在任何认证和传输前被拒绝，启动不会联网。
    pub fn unconfigured() -> Result<Self, String> {
        Self::build(String::new(), Duration::from_secs(60), MAX_RESPONSE)
    }

    #[cfg(feature="nas-acceptance")]
    pub(crate) fn acceptance(url:&str,secret:&str)->Result<Self,String>{
        let transport=Self::build(url.to_owned(),Duration::from_secs(15),MAX_RESPONSE)?;
        transport.state()?.session=Some(Session{
            tokens:Tokens{access:secret.into(),refresh:uuid::Uuid::new_v4().to_string(),
                subject:"fixture_existing01".into(),expires:Instant::now()+Duration::from_secs(86400)},
            member:json!({"uid":"fixture_existing01","workspaceId":"workbench-main","name":"验收账号"}),
        });
        Ok(transport)
    }

    pub fn environment(&self) -> &str {
        &self.environment
    }

    fn require_configured(&self) -> Result<(), String> {
        if self.base.is_empty() {
            Err(CLOUD_NOT_CONFIGURED.into())
        } else {
            Ok(())
        }
    }

    // 构造有限超时的 HTTP 客户端和空会话；测试可注入本地服务地址。
    fn build(base: String, timeout: Duration, max_response: usize) -> Result<Self, String> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .build()
            .map_err(|_| "无法初始化云端连接".to_string())?;
        Ok(Self {
            client,
            nas_client: None,
            nas_deployment: None,
            nas_local_auth: false,
            environment: base.clone(),
            base,
            device_id: uuid::Uuid::new_v4().to_string(),
            state: Mutex::new(State::default()),
            auth_gate: Mutex::new(()),
            max_response,
            vault: None,
        })
    }

    // 专用 NAS 根证书仅给 NAS 请求，不进入原账号认证，也不改 Windows 根信任。
    pub fn with_nas_ca(mut self, pem: &[u8]) -> Result<Self,String> {
        self.nas_client=Some(nas_tls_client(pem)?);
        Ok(self)
    }

    pub fn with_nas_system_ca(mut self)->Result<Self,String>{
        self.nas_client=Some(nas_system_tls_client()?);Ok(self)
    }

    pub fn with_nas_deployment(mut self, deployment: String) -> Result<Self,String> {
        if self.nas_client.is_none(){return Err("正式 NAS 工作区要求独立局域网 CA".into());}
        self.nas_deployment=Some(deployment);
        Ok(self)
    }

    // 先匿名核对目标环境，再发带凭据的请求；试验服务器不能收到正式账号的请求正文。
    pub(crate) fn with_local_nas_auth(mut self, url: &reqwest::Url) -> Result<Self,String> {
        let deployment=self.nas_deployment.as_ref().ok_or("正式 NAS 认证需要部署标识")?;
        self.base=url.as_str().trim_end_matches('/').to_owned();
        // 不从旧认证凭据恢复，配置草稿仍沿用这个部署和成员 UID。
        self.environment=format!("nas-local:{deployment}@{}",self.base);
        self.nas_local_auth=true;
        Ok(self)
    }

    pub(crate) fn check_nas_deployment(&self, endpoint: &reqwest::Url) -> Result<(), (u16,&'static str)> {
        let Some(expected)=&self.nas_deployment else{return Ok(());};
        let bad=(409,"NAS_DEPLOYMENT_MISMATCH");
        let endpoint=endpoint.join("/healthz").map_err(|_|bad)?;
        let client=self.nas_client.as_ref().ok_or(bad)?;
        let response=client.get(endpoint).timeout(Duration::from_secs(4)).send()
            .map_err(|_|(503,"NETWORK_OR_RESPONSE_ERROR"))?;
        if response.status().as_u16()!=200||response.headers().get("x-workbench-deployment").and_then(|value|value.to_str().ok())!=Some(expected.as_str()){
            return Err(bad);
        }
        let mut bytes=Vec::new();
        response.take(4097).read_to_end(&mut bytes).map_err(|_|(503,"NETWORK_OR_RESPONSE_ERROR"))?;
        if bytes.len()>4096||!serde_json::from_slice::<Value>(&bytes).is_ok_and(|health|
            health["deployment_id"]==expected.as_str()&&health["ok"]==true&&
                (!self.nas_local_auth||matches!(health["auth_mode"].as_str(),Some("local"|"migration")))){
            return Err(bad);
        }
        Ok(())
    }

    pub fn with_persistence(mut self, data_dir: &std::path::Path) -> Result<Self, String> {
        if self.base.is_empty() { return Ok(self); }
        let vault = SessionVault::new(data_dir, &self.environment);
        match vault.load() {
            Ok(Some(saved)) if saved.valid(&self.environment) => {
                self.device_id = saved.device_id.clone();
                self.state()?.saved = Some(saved);
            }
            Ok(None) => {}
            _ => { self.state()?.restore_error = vault.clear().err(); }
        }
        self.vault = Some(vault);
        Ok(self)
    }

    fn save_session(&self, tokens: &Tokens, member: &Value, remember: bool) -> Result<(), String> {
        if !remember { return self.vault.as_ref().map_or(Ok(()), SessionVault::clear); }
        let vault = self.vault.as_ref().ok_or("此环境暂不支持保留登录信息")?;
        vault.save(&SavedSession { version: 1, environment: self.environment.clone(), refresh: tokens.refresh.clone(),
            subject: tokens.subject.clone(), workspace_id: member["workspaceId"].as_str().unwrap_or_default().into(), device_id: self.device_id.clone() })
    }
    fn forget_saved(&self, state: &mut State) -> Result<(), String> {
        state.saved = None;
        state.remember = false;
        state.restore_error = None;
        self.vault.as_ref().map_or(Ok(()), SessionVault::clear)
    }

    fn state(&self) -> Result<MutexGuard<'_, State>, String> {
        self.state.lock().map_err(|_| "云端会话状态不可用".into())
    }

    fn gate(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.auth_gate
            .lock()
            .map_err(|_| "云端登录状态不可用".into())
    }

    /// Authenticate with the official username/password endpoint, then validate membership.
    /// The password is used for this request only and is never retained in State.
    // 账号认证后再核验正式成员资格；密码只用于当前请求，不写入会话状态。
    #[cfg(test)]
    pub fn login(&self, username: &str, password: &str) -> Result<Value, String> {
        self.login_with_remember(username, password, false)
    }
    pub fn login_with_remember(&self, username: &str, password: &str, remember: bool) -> Result<Value, String> {
        self.require_configured()?;
        if username.is_empty()
            || username.len() > 192
            || password.is_empty()
            || password.len() > 4096
        {
            return Err("请输入有效的成员用户名和密码".into());
        }
        let epoch = self.state()?.epoch;
        let _gate = self.gate()?;
        self.check_epoch(epoch)?;
        let response = self
            .post(
                "/auth/v1/signin",
                &json!({"username":username,"password":password}),
                None,
            )
            .map_err(|e| match e {
                HttpError::Unauthorized => "用户名或密码错误，或登录方式不可用".into(),
                HttpError::Safe(message) => message,
            })?;
        let tokens = parse_tokens(&response)?;
        let member = self.verify_member(&tokens)?;
        let mut state = self.state()?;
        if state.epoch != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        if state.session.as_ref().is_some_and(|old| {
            old.member["uid"] != member["uid"] || old.member["workspaceId"] != member["workspaceId"]
        }) {
            return Err("请先退出当前成员，再切换账号".into());
        }
        // Invalidate any in-flight request made with the previous credentials.
        self.save_session(&tokens, &member, remember)?;
        state.epoch = state.epoch.wrapping_add(1);
        state.saved = None;
        state.restore_error = None;
        state.remember = remember;
        state.session = Some(Session {
            tokens,
            member: member.clone(),
        });
        Ok(status(Some(member)))
    }

    /// Revalidate memory session, or refresh and verify an explicitly remembered session.
    pub fn resume(&self) -> Result<Value, String> {
        let epoch = {
            let state = self.state()?;
            if state.session.is_none() {
                if let Some(error) = &state.restore_error { return Err(error.clone()); }
                let saved = state.saved.clone();
                let epoch = state.epoch;
                drop(state);
                if let Some(saved) = saved { return self.restore(saved, epoch); }
                return self.status();
            }
            state.epoch
        };
        let result = self.call(json!({"protocolVersion":2,"action":"session.get","payload":{}}))?;
        let mut state = self.state()?;
        if state.epoch != epoch {
            return Err("云端请求已取消，请重新登录".into());
        }
        let session = state.session.as_mut().ok_or(LOGIN_REQUIRED)?;
        let member = match parse_member(&result, &session.tokens.subject) {
            Ok(member) => member,
            Err(error) => {
                state.epoch = state.epoch.wrapping_add(1);
                state.session = None;
                self.forget_saved(&mut state)?;
                return Err(error);
            }
        };
        if member["uid"] != session.member["uid"]
            || member["workspaceId"] != session.member["workspaceId"]
        {
            state.epoch = state.epoch.wrapping_add(1);
            state.session = None;
            self.forget_saved(&mut state)?;
            return Err("成员身份已变化，请重新登录".into());
        }
        session.member = member.clone();
        Ok(status(Some(member)))
    }

    // 只使用续期令牌重建会话；网络异常保留重试机会，身份失效和主体变化立即清除。
    fn restore(&self, saved: SavedSession, epoch: u64) -> Result<Value, String> {
        let _gate = self.gate()?;
        self.check_epoch(epoch)?;
        if self.state()?.session.is_some() { return self.status(); }
        let raw = match self.post("/auth/v1/token", &json!({"grant_type":"refresh_token","refresh_token":saved.refresh}), None) {
            Ok(raw) => raw,
            Err(HttpError::Unauthorized) => { self.invalidate(epoch)?; return Err(SESSION_EXPIRED.into()); }
            Err(error) => return Err(safe_http_error(error)),
        };
        let tokens = match parse_tokens(&raw) {
            Ok(tokens) if tokens.subject == saved.subject => tokens,
            _ => { self.invalidate(epoch)?; return Err("已保留的登录身份已变化，请重新登录".into()); }
        };
        // 刷新令牌会轮换；先在同代次下保存新的续期信息，再进行可能离线的成员核验。
        {
            let mut state = self.state()?;
            if state.epoch != epoch { return Err("登录已取消，请重新登录".into()); }
            let mut rotated = saved.clone();
            rotated.refresh = tokens.refresh.clone();
            self.vault.as_ref().ok_or("无法读取本机登录存储")?.save(&rotated)?;
            state.saved = Some(rotated);
        }
        let request = json!({"protocolVersion":2,"action":"session.get","requestId":uuid::Uuid::new_v4().to_string(),"payload":{}});
        let raw = match self.business(&request, &tokens.access) {
            Ok(raw) => raw,
            Err(HttpError::Unauthorized) => { self.invalidate(epoch)?; return Err(SESSION_EXPIRED.into()); }
            Err(error) => return Err(safe_http_error(error)),
        };
        let mut member = match parse_member(&raw, &tokens.subject) {
            Ok(member) if member["workspaceId"] == saved.workspace_id => member,
            _ => { self.invalidate(epoch)?; return Err("成员身份已变化，请重新登录".into()); }
        };
        scrub_value(&mut member, &[&tokens.access, &tokens.refresh]);
        let mut state = self.state()?;
        if state.epoch != epoch { return Err("登录已取消，请重新登录".into()); }
        self.save_session(&tokens, &member, true)?;
        state.saved = None;
        state.remember = true;
        state.session = Some(Session { tokens, member });
        drop(state);
        self.status()
    }

    /// Immediate local logout. Epoch cancellation prevents late network results restoring login.
    // 清空本机会话并推进代次，使迟到的登录或业务响应不能恢复已退出状态。
    pub fn logout(&self) -> Result<Value, String> {
        let mut state = self.state()?;
        let refresh = if self.nas_local_auth {
            state.session.as_ref().map(|session|session.tokens.refresh.clone())
                .or_else(||state.saved.as_ref().map(|saved|saved.refresh.clone()))
        } else { None };
        state.epoch = state.epoch.wrapping_add(1);
        state.session = None;
        self.forget_saved(&mut state)?;
        // 先清本机并释放写锁，迟到的认证结果不能恢复当前会话。
        drop(state);
        let mut result=self.status()?;
        if let Some(refresh)=refresh {
            // NAS 离线时仍退出本机，界面单独显示远端撤销状态。
            result["nas_session_revoked"]=json!(self.post("/api/v1/auth/logout",&json!({"refresh_token":refresh}),None).is_ok());
        }
        Ok(result)
    }

    /// Current validated member for local binding checks; performs no network work.
    // 返回已验证成员的副本供本机绑定核对，不触发网络请求或暴露令牌。
    pub fn current_member(&self) -> Result<Option<Value>, String> {
        Ok(self
            .state()?
            .session
            .as_ref()
            .map(|session| session.member.clone()))
    }

    pub fn status(&self) -> Result<Value, String> {
        let state = self.state()?;
        let mut result = status(state.session.as_ref().map(|s| s.member.clone()));
        result["remembered"] = json!(state.remember || state.saved.is_some() || state.restore_error.is_some());
        result["configured"] = json!(!self.base.is_empty());
        if self.base.is_empty() {
            result["code"] = json!("CLOUD_NOT_CONFIGURED");
        }
        Ok(result)
    }

    /// Fetch only a hash-named image in the current formal member's private workspace.
    // 只下载当前成员私有工作区中的摘要命名原图，并核验返回内容。
    pub fn storage_get(&self, name: &str) -> Result<Vec<u8>, String> {
        self.storage_get_at(name, None)
    }

    fn storage_get_at(&self, name: &str, expected_epoch: Option<u64>) -> Result<Vec<u8>, String> {
        validate_asset_name(name)?;
        let (epoch, access) = self.access()?;
        if expected_epoch.is_some_and(|expected| expected != epoch) {
            return Err("云端请求已取消，请重新登录".into());
        }
        let access = self.ensure_fresh(epoch, &access, false)?;
        let path = self.storage_path(epoch, name)?;
        let bytes = match self.storage_request(&path, &access, None, None) {
            Ok(bytes) => bytes,
            Err(HttpError::Unauthorized) => {
                let access = self.ensure_fresh(epoch, &access, true)?;
                self.storage_request(&path, &access, None, None)
                    .map_err(|error| {
                        if matches!(error, HttpError::Unauthorized) {
                            let _ = self.invalidate(epoch);
                        }
                        safe_http_error(error)
                    })?
            }
            Err(error) => return Err(safe_http_error(error)),
        };
        self.check_epoch(epoch)?;
        verify_asset_hash(name, &bytes)?;
        Ok(bytes)
    }

    /// Immutable upload with exact MIME/hash. Uncertain/conflicting acceptance is read back.
    // 按不可变文件名上传；结果不确定时通过下载和摘要确认，避免重复覆盖提交。
    pub fn storage_upload(&self, name: &str, bytes: &[u8], mime: &str) -> Result<Value, String> {
        validate_asset_name(name)?;
        if (name.ends_with(".png") && mime != "image/png")
            || (name.ends_with(".jpg") && mime != "image/jpeg")
        {
            return Err("原图类型与文件名不一致".into());
        }
        verify_asset_hash(name, bytes)?;
        let (epoch, access) = self.access()?;
        let access = self.ensure_fresh(epoch, &access, false)?;
        let path = self.storage_path(epoch, name)?;
        let response = match self.storage_request(&path, &access, Some(bytes), Some(mime)) {
            Err(HttpError::Unauthorized) => {
                // Same immutable object, same bytes, x-upsert:false. A 401 has not accepted it.
                let access = self.ensure_fresh(epoch, &access, true)?;
                self.storage_request(&path, &access, Some(bytes), Some(mime))
            }
            other => other,
        };
        if let Err(error) = response {
            if matches!(error, HttpError::Unauthorized) {
                self.invalidate(epoch)?;
                return Err(SESSION_EXPIRED.into());
            }
            let message = safe_http_error(error);
            // A dropped response may hide success; GET+hash proves acceptance without another POST.
            let confirmed = self
                .storage_get_at(name, Some(epoch))
                .is_ok_and(|remote| remote == bytes);
            if !confirmed {
                return Err(message);
            }
        }
        self.check_epoch(epoch)?;
        Ok(json!({"ok":true,"name":name}))
    }

    // 从已验证会话生成工作区路径并编码标识，拒绝点目录逃逸。
    fn storage_path(&self, epoch: u64, name: &str) -> Result<String, String> {
        let state = self.state()?;
        if state.epoch != epoch {
            return Err("云端请求已取消，请重新登录".into());
        }
        let session = state.session.as_ref().ok_or(LOGIN_REQUIRED)?;
        let workspace = session.member["workspaceId"]
            .as_str()
            .ok_or("成员身份校验失败")?;
        let mut escaped = String::new();
        for byte in workspace.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                escaped.push(char::from(byte));
            } else {
                escaped.push_str(&format!("%{byte:02X}"));
            }
        }
        // A workspace made solely of dot segments must never be URL-normalized out of the bucket.
        if matches!(escaped.as_str(), "." | "..") {
            return Err("工作空间标识无效".into());
        }
        Ok(format!(
            "/v1/storages/object/workbench-assets/{escaped}/{name}"
        ))
    }

    fn storage_request(
        &self,
        path: &str,
        access: &str,
        bytes: Option<&[u8]>,
        mime: Option<&str>,
    ) -> Result<Vec<u8>, HttpError> {
        let url = format!("{}{}", self.base, path);
        let mut request = if let Some(bytes) = bytes {
            self.client
                .post(url)
                .body(bytes.to_owned())
                .header("Content-Type", mime.unwrap_or("application/octet-stream"))
                .header("x-upsert", "false")
        } else {
            self.client.get(url)
        };
        let mut header = HeaderValue::from_str(&format!("Bearer {access}"))
            .map_err(|_| HttpError::Safe("登录凭据格式无效".into()))?;
        header.set_sensitive(true);
        request = request.header(AUTHORIZATION, header);
        let response = request
            .send()
            .map_err(|_| HttpError::Safe("云端原图连接超时或不可用".into()))?;
        if response.status().as_u16() == 401 {
            return Err(HttpError::Unauthorized);
        }
        if response.status().as_u16() == 404 {
            return Err(HttpError::Safe("STORAGE_NOT_FOUND: 云端原图不存在".into()));
        }
        if !response.status().is_success() {
            return Err(HttpError::Safe(format!(
                "云端原图请求失败（{}）",
                response.status().as_u16()
            )));
        }
        let limit = if bytes.is_some() {
            64 * 1024
        } else {
            MAX_ASSET
        };
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(HttpError::Safe("云端原图响应超过大小限制".into()));
        }
        let mut output = Vec::new();
        response
            .take(limit as u64 + 1)
            .read_to_end(&mut output)
            .map_err(|_| HttpError::Safe("云端原图响应读取超时或中断".into()))?;
        if output.len() > limit {
            return Err(HttpError::Safe("云端原图响应超过大小限制".into()));
        }
        Ok(output)
    }

    // 先校验动作和协议，再处理令牌刷新；仅对明确可安全重放的请求重试。
    pub fn call(&self, request: Value) -> Result<Value, String> {
        let request = validate_request(request)?;
        let (epoch, mut access) = self.access()?;
        // Near-expiry refresh is single-flight and rechecks the credential after waiting.
        access = self.ensure_fresh(epoch, &access, false)?;
        let first = self.business(&request, &access);
        let mut result = match first {
            Ok(result) => result,
            Err(HttpError::Unauthorized) => {
                let renewed = self.ensure_fresh(epoch, &access, true)?;
                // 刷新登录并不证明上次变更可重放；不满足幂等契约时交由原提交 ID 显式重试。
                if !safe_to_replay(&request) {
                    return Err("登录已刷新；本次请求未自动重发，请使用原提交 ID 重试".into());
                }
                self.business(&request, &renewed).map_err(|error| {
                    if matches!(error, HttpError::Unauthorized) {
                        let _ = self.invalidate(epoch);
                    }
                    safe_http_error(error)
                })?
            }
            Err(error) => return Err(safe_http_error(error)),
        };
        // Logout/account switch wins over a late successful response as well as refresh.
        let state = self.state()?;
        if state.epoch != epoch {
            return Err("云端请求已取消，请重新登录".into());
        }
        let session = state.session.as_ref().ok_or(LOGIN_REQUIRED)?;
        scrub_value(
            &mut result,
            &[&access, &session.tokens.access, &session.tokens.refresh],
        );
        Ok(result)
    }

    fn access(&self) -> Result<(u64, String), String> {
        self.require_configured()?;
        let state = self.state()?;
        let session = state.session.as_ref().ok_or(LOGIN_REQUIRED)?;
        Ok((state.epoch, session.tokens.access.clone()))
    }

    // NAS 素材本身公开，不附带原账号令牌，避免与认证 JSON 请求混用。
    pub(crate) fn nas_image(&self, url: reqwest::Url, mime: &str) -> Result<Vec<u8>, u16> {
        const LIMIT: usize = 32 * 1024 * 1024;
        let reply=self.nas_client.as_ref().unwrap_or(&self.client).get(url).timeout(Duration::from_secs(12)).send().map_err(|_|502u16)?;
        if reply.status()!=reqwest::StatusCode::OK {return Err(if reply.status().as_u16()==404 {404} else {502});}
        if reply.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())!=Some(mime) {return Err(502);}
        if reply.content_length().is_some_and(|n| n>LIMIT as u64){return Err(413);}
        let mut bytes=Vec::new();
        reply.take((LIMIT+1) as u64).read_to_end(&mut bytes).map_err(|_|502u16)?;
        if bytes.len()>LIMIT {return Err(413);}
        Ok(bytes)
    }

    #[cfg(feature = "agent-tools")]
    pub(crate) fn nas_actor(&self) -> Option<(String, String)> {
        let state = self.state().ok()?;
        let member = &state.session.as_ref()?.member;
        Some((member["workspaceId"].as_str()?.into(), member["uid"].as_str()?.into()))
    }

    // 原账号令牌始终留在进程内。目标 URL 由原生 NAS 边界从本机固定配置解析。
    pub(crate) fn nas_request(
        &self,
        endpoint: reqwest::Url,
        method: reqwest::Method,
        body: Option<(String, Vec<u8>)>,
        expected: Option<(String, String)>,
    ) -> Result<(u16, Value), (u16, &'static str)> {
        self.require_configured().map_err(|_| (401, "UNAUTHENTICATED"))?;
        self.check_nas_deployment(&endpoint)?;
        let (epoch, old_access) = {
            let state = self.state().map_err(|_| (401, "UNAUTHENTICATED"))?;
            let session = state.session.as_ref().ok_or((401, "UNAUTHENTICATED"))?;
            if let Some((workspace, uid)) = expected.as_ref() {
                if session.member["workspaceId"].as_str() != Some(workspace.as_str()) ||
                    session.member["uid"].as_str() != Some(uid.as_str()) {
                    return Err((403, "MEMBER_CHANGED"));
                }
            }
            (state.epoch, session.tokens.access.clone())
        };
        let access = self.ensure_fresh(epoch, &old_access, false).map_err(|_| (401, "UNAUTHENTICATED"))?;
        self.check_epoch(epoch).map_err(|_| (401, "UNAUTHENTICATED"))?;
        let mut request = self.nas_client.as_ref().unwrap_or(&self.client).request(method, endpoint)
            .header(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {access}"))
                .map_err(|_| (401, "UNAUTHENTICATED"))?)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(14));
        if let Some(deployment)=&self.nas_deployment { request=request.header("x-workbench-deployment",deployment); }
        if let Some((mime, body)) = body {
            request = request.header(reqwest::header::CONTENT_TYPE, mime).body(body);
        }
        // 不跟随重定向、不自动重新发送任何业务写请求。
        let reply = request.send().map_err(|_| (503, "NETWORK_OR_RESPONSE_ERROR"))?;
        if let Some(deployment)=&self.nas_deployment{
            if reply.headers().get("x-workbench-deployment").and_then(|value|value.to_str().ok())!=Some(deployment.as_str()){
                return Err((409,"NAS_DEPLOYMENT_MISMATCH"));
            }
        }
        let status = reply.status();
        if status.is_redirection() { return Err((503, "NETWORK_OR_RESPONSE_ERROR")); }
        let mut bytes = Vec::new();
        const LIMIT: usize = 4 * 1024 * 1024;
        reply.take((LIMIT + 1) as u64).read_to_end(&mut bytes)
            .map_err(|_| (503, "NETWORK_OR_RESPONSE_ERROR"))?;
        if bytes.len() > LIMIT { return Err((503, "INVALID_API_RESPONSE")); }
        let mut output: Value = serde_json::from_slice(&bytes).map_err(|_| (503, "INVALID_API_RESPONSE"))?;
        let state = self.state().map_err(|_| (503, "NETWORK_OR_RESPONSE_ERROR"))?;
        if state.epoch != epoch {
            return Err((503, "NETWORK_OR_RESPONSE_ERROR"));
        }
        let session = state.session.as_ref().ok_or((503, "NETWORK_OR_RESPONSE_ERROR"))?;
        scrub_value(&mut output, &[&access, &session.tokens.access, &session.tokens.refresh]);
        Ok((status.as_u16(), output))
    }

    // 拒绝退出或切换身份前启动的请求结果，避免旧会话响应混入新成员。
    fn check_epoch(&self, epoch: u64) -> Result<(), String> {
        if self.state()?.epoch != epoch {
            return Err("云端请求已取消，请重新登录".into());
        }
        Ok(())
    }

    // 只清除仍属于指定代次的会话，旧请求失败不能注销后来的登录。
    fn invalidate(&self, epoch: u64) -> Result<(), String> {
        let mut state = self.state()?;
        if state.epoch == epoch {
            state.epoch = state.epoch.wrapping_add(1);
            state.session = None;
            self.forget_saved(&mut state)?;
        }
        Ok(())
    }

    // 刷新门让并发请求复用一次令牌刷新；等待后再次检查代次和其他请求的刷新结果。
    fn ensure_fresh(&self, epoch: u64, old_access: &str, force: bool) -> Result<String, String> {
        let _gate = self.gate()?;
        let refresh = {
            let state = self.state()?;
            if state.epoch != epoch {
                return Err("云端请求已取消，请重新登录".into());
            }
            let session = state.session.as_ref().ok_or(LOGIN_REQUIRED)?;
            if session.tokens.access != old_access
                || (!force && session.tokens.expires > Instant::now() + Duration::from_secs(30))
            {
                return Ok(session.tokens.access.clone());
            }
            session.tokens.refresh.clone()
        };
        let refreshed = self.post(
            "/auth/v1/token",
            &json!({"grant_type":"refresh_token","refresh_token":refresh}),
            None,
        );
        let tokens = match refreshed {
            Ok(response) => parse_tokens(&response),
            Err(HttpError::Unauthorized) => Err(SESSION_EXPIRED.into()),
            Err(HttpError::Safe(message)) => return Err(message),
        };
        let tokens = match tokens {
            Ok(tokens) => tokens,
            Err(error) => {
                self.invalidate(epoch)?;
                return Err(error);
            }
        };
        // Every rotated credential is checked against the same formal member before use.
        let member = match self.verify_member(&tokens) {
            Ok(member) => member,
            Err(error) => {
                self.invalidate(epoch)?;
                return Err(error);
            }
        };
        let mut state = self.state()?;
        if state.epoch != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        let session = state.session.as_mut().ok_or(LOGIN_REQUIRED)?;
        if member["uid"] != session.member["uid"]
            || member["workspaceId"] != session.member["workspaceId"]
        {
            state.epoch = state.epoch.wrapping_add(1);
            state.session = None;
            self.forget_saved(&mut state)?;
            return Err("成员身份已变化，请重新登录".into());
        }
        let access = tokens.access.clone();
        let remember = state.remember;
        self.save_session(&tokens, &member, remember)?;
        let session = state.session.as_mut().ok_or(LOGIN_REQUIRED)?;
        session.tokens = tokens;
        session.member = member;
        Ok(access)
    }

    fn verify_member(&self, tokens: &Tokens) -> Result<Value, String> {
        let request = json!({"protocolVersion":2,"action":"session.get","requestId":uuid::Uuid::new_v4().to_string(),"payload":{}});
        let result = self
            .business(&request, &tokens.access)
            .map_err(safe_http_error)?;
        let mut member = parse_member(&result, &tokens.subject)?;
        scrub_value(&mut member, &[&tokens.access, &tokens.refresh]);
        Ok(member)
    }

    fn business(&self, request: &Value, access: &str) -> Result<Value, HttpError> {
        if self.nas_local_auth {
            return if request["action"]=="session.get" {
                self.post("/api/v1/auth/session",&json!({}),Some(access))
            } else {
                Err(HttpError::Safe("正式 NAS 工作区仅支持 NAS 业务接口".into()))
            };
        }
        if request["action"] == "costs.page" {
            self.post("/v1/rdb/rest/rpc/wa_cost_prices", &json!({"request":request}), Some(access))
        } else if request["action"] == "records.commits" {
            self.post(
                "/v1/rdb/rest/rpc/wa_commit_history",
                &json!({"request":request}),
                Some(access),
            )
        } else {
            let mut body = request.clone();
            body["accessToken"] = Value::String(access.to_owned());
            self.post("/v1/functions/workbenchApi", &body, Some(access))
        }
    }

    fn post(&self, path: &str, body: &Value, access: Option<&str>) -> Result<Value, HttpError> {
        self.require_configured().map_err(HttpError::Safe)?;
        let (mut request,stage) = if self.nas_local_auth {
            let (route,stage)=match path {
                "/auth/v1/signin"=>("/api/v1/auth/login","NAS 账号认证"),
                "/auth/v1/token"=>("/api/v1/auth/refresh","NAS 登录续期"),
                "/api/v1/auth/session"=>(path,"NAS 成员核验"),
                "/api/v1/auth/logout"=>(path,"NAS 退出登录"),
                _=>return Err(HttpError::Safe("正式 NAS 工作区仅支持 NAS 账号认证".into())),
            };
            let base=reqwest::Url::parse(&self.base).map_err(|_|HttpError::Safe("NAS 地址无效".into()))?;
            self.check_nas_deployment(&base).map_err(|(_,code)|HttpError::Safe(
                if code=="NAS_DEPLOYMENT_MISMATCH" {"当前 NAS 未启用本地认证或部署标识已变化".into()}
                else {"暂时无法建立到 NAS 的可信 HTTPS 连接".into()}))?;
            let deployment=self.nas_deployment.as_ref().ok_or(HttpError::Unauthorized)?;
            let client=self.nas_client.as_ref().ok_or(HttpError::Unauthorized)?;
            (client.post(format!("{}{route}",self.base)).header("x-workbench-deployment",deployment),Some(stage))
        } else {
            (self.client.post(format!("{}{}",self.base,path)).header("x-device-id",&self.device_id),auth_stage(path,body))
        };
        request=request.json(body);
        if let Some(access) = access {
            let mut header = HeaderValue::from_str(&format!("Bearer {access}"))
                .map_err(|_| HttpError::Safe("登录凭据格式无效".into()))?;
            header.set_sensitive(true);
            request = request.header(AUTHORIZATION, header);
        }
        let response = request.send().map_err(|error| HttpError::Safe(auth_transport_message(
            stage, "连接", if error.is_timeout() { "超时" } else { "中断或不可用" },
        )))?;
        let status = response.status();
        if self.nas_local_auth {
            if response.headers().get("x-workbench-deployment").and_then(|value|value.to_str().ok())!=self.nas_deployment.as_deref() {
                return Err(HttpError::Safe("NAS 认证响应的部署标识已变化".into()));
            }
            if status.as_u16()==429 {
                return Err(HttpError::Safe("NAS 登录请求过多，请稍后再试".into()));
            }
        }
        if status.as_u16() == 401
            || (path.starts_with("/auth/") && matches!(status.as_u16(), 400 | 403))
        {
            return Err(HttpError::Unauthorized);
        }
        if !status.is_success() {
            return Err(HttpError::Safe(format!(
                "{}请求失败（{}）",
                stage.unwrap_or("云端"), status.as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|size| size > self.max_response as u64)
        {
            return Err(HttpError::Safe("云端响应超过大小限制".into()));
        }
        let mut bytes = Vec::new();
        response
            .take(self.max_response as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| HttpError::Safe(auth_transport_message(stage, "响应读取", "超时或中断")))?;
        if bytes.len() > self.max_response {
            return Err(HttpError::Safe("云端响应超过大小限制".into()));
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| HttpError::Safe("云端返回无效数据".into()))?;
        if !result.is_object() {
            return Err(HttpError::Safe("云端返回无效数据".into()));
        }
        if result["code"] == "UNAUTHENTICATED"
            || result["error"] == "invalid_grant"
            || result["error"] == "invalid_username_or_password"
        {
            return Err(HttpError::Unauthorized);
        }
        Ok(result)
    }
}

fn safe_http_error(error: HttpError) -> String {
    match error {
        HttpError::Unauthorized => SESSION_EXPIRED.into(),
        HttpError::Safe(message) => message,
    }
}

fn status(member: Option<Value>) -> Value {
    match member {
        Some(member) => json!({"configured":true,"authenticated":true,"member":member}),
        None => json!({"configured":true,"authenticated":false,"member":null}),
    }
}

// 严格读取访问令牌、刷新令牌与主体字段，拒绝不完整或匿名身份。
fn parse_tokens(response: &Value) -> Result<Tokens, String> {
    let field = |name, max| {
        response[name]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
            .map(str::to_owned)
    };
    let access = field("access_token", 4096).ok_or("登录服务返回无效凭据")?;
    let refresh = field("refresh_token", 128).ok_or("登录服务返回无效凭据")?;
    let subject = field("sub", 256).ok_or("登录服务返回无效成员")?;
    let seconds = response["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 31 * 24 * 3600)
        .ok_or("登录服务返回无效有效期")?;
    if response["token_type"].as_str() != Some("Bearer") {
        return Err("登录服务返回无效凭据".into());
    }
    if response["scope"]
        .as_str()
        .is_some_and(|scope| scope.split_whitespace().any(|item| item == "anonymous"))
        || response["user"]["is_anonymous"] == true
        || anonymous_claim(&access)
    {
        return Err("匿名账号不能登录工作空间".into());
    }
    Ok(Tokens {
        access,
        refresh,
        subject,
        expires: Instant::now() + Duration::from_secs(seconds),
    })
}

// 成员主体必须与认证令牌一致，同时要求有效工作区，不能只凭返回名称建立登录。
fn parse_member(response: &Value, subject: &str) -> Result<Value, String> {
    let text = |key| {
        response[key].as_str().filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
    };
    let uid = text("uid").ok_or("成员身份校验失败")?;
    let workspace = text("workspaceId").ok_or("成员身份校验失败")?;
    if response["ok"] != true
        || uid != subject
        || response["isAnonymous"] == true
        || response["is_anonymous"] == true
        || response["anonymous"] == true
    {
        return Err("当前账号不是正式工作空间成员".into());
    }
    let mut member = json!({"uid":uid,"workspaceId":workspace});
    for key in ["memberId", "name"] {
        if let Some(value) = text(key) {
            member[key] = json!(value);
        }
    }
    for key in ["protocolVersion", "ready"] {
        if let Some(value) = response.get(key) {
            if (key == "ready" && !value.is_boolean())
                || (key == "protocolVersion" && value.as_u64() != Some(2))
            {
                return Err("成员身份返回协议无效".into());
            }
            member[key] = value.clone();
        }
    }
    Ok(member)
}

// This is an additional anonymous check, not JWT signature verification. Authority
// comes from TLS AuthOpenAPI plus the server's authenticated session.get membership gate.
fn anonymous_claim(access: &str) -> bool {
    use base64::Engine;
    access
        .split('.')
        .nth(1)
        .and_then(|part| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(part)
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|claims| {
            claims["is_anonymous"] == true
                || claims["is_anonymous"] == "true"
                || claims["user"]["is_anonymous"] == true
        })
}

// 限制协议和业务动作，拒绝客户端注入 URL、令牌及不支持的调用参数。
fn validate_request(request: Value) -> Result<Value, String> {
    if !request.is_object()
        || request
            .get("protocolVersion")
            .is_some_and(|v| v.as_u64() != Some(2))
    {
        return Err("云端请求协议无效".into());
    }
    let action = request["action"].as_str().ok_or("云端请求动作无效")?;
    if !matches!(
        action,
        "session.get"
            | "sync.bootstrap"
            | "sync.pull"
            | "sync.push"
            | "sync.pushBatch"
            | "sync.snapshot"
            | "sync.receipt"
            | "records.history"
            | "records.commits" | "costs.page"
    ) {
        return Err("不允许此云端请求动作".into());
    }
    if ["url", "baseUrl", "accessToken", "refreshToken", "headers"]
        .iter()
        .any(|key| request.get(key).is_some())
    {
        return Err("云端请求包含不允许的传输字段".into());
    }
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    if !payload.is_object() {
        return Err("云端请求内容无效".into());
    }
    let request_id = match request.get("requestId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(value) => value
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 100 && !s.chars().any(char::is_control))
            .ok_or("云端请求 ID 无效")?
            .to_owned(),
    };
    let result =
        json!({"protocolVersion":2,"action":action,"requestId":request_id,"payload":payload});
    if serde_json::to_vec(&result)
        .map_err(|_| "云端请求内容无效")?
        .len()
        > MAX_REQUEST
    {
        return Err("单条云端请求过大".into());
    }
    Ok(result)
}

// 仅允许具有明确重放契约的请求自动重试，避免网络不确定时重复执行变更。
fn safe_to_replay(request: &Value) -> bool {
    let has_id = |payload: &Value| {
        payload["mutationId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    };
    match request["action"].as_str().unwrap_or_default() {
        "session.get" | "sync.bootstrap" | "sync.pull" | "sync.snapshot" | "sync.receipt"
        | "records.history" | "records.commits" | "costs.page" => true,
        "sync.push" => has_id(&request["payload"]),
        "sync.pushBatch" => request["payload"]["requests"]
            .as_array()
            .is_some_and(|batch| {
                !batch.is_empty() && batch.iter().all(|item| has_id(&item["payload"]))
            }),
        _ => false,
    }
}

// 递归移除敏感字段后再把业务响应交给页面，原生令牌不跨 IPC。
fn scrub_value(value: &mut Value, secrets: &[&str]) {
    match value {
        Value::Object(fields) => {
            fields.retain(|key, _| {
                !matches!(
                    key.as_str(),
                    "accessToken"
                        | "access_token"
                        | "refreshToken"
                        | "refresh_token"
                        | "authorization"
                        | "Authorization"
                )
            });
            for item in fields.values_mut() {
                scrub_value(item, secrets);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_value(item, secrets);
            }
        }
        Value::String(text) => {
            for secret in secrets {
                if !secret.is_empty() {
                    *text = text.replace(secret, "[已隐藏]");
                }
            }
        }
        _ => (),
    }
}

fn validate_asset_name(name: &str) -> Result<(), String> {
    let Some((hash, extension)) = name.rsplit_once('.') else {
        return Err("原图文件名无效".into());
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !matches!(extension, "png" | "jpg")
    {
        return Err("原图文件名无效".into());
    }
    Ok(())
}

fn verify_asset_hash(name: &str, bytes: &[u8]) -> Result<(), String> {
    use sha2::Digest;
    if bytes.is_empty() || bytes.len() > MAX_ASSET {
        return Err("原图大小无效或超过24MiB".into());
    }
    let digest = format!("{:x}", sha2::Sha256::digest(bytes));
    if name.split('.').next() != Some(digest.as_str()) {
        return Err("云端原图内容摘要与文件名不一致".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "cloud_transport/tests.rs"]
mod tests;
