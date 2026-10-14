// Windows 便携版更新：验证签名、下载长度和摘要，等待旧进程退出后替换程序，不接触业务库。
//! Signed refactor-only Windows portable updates. No business-store access.
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::{Url, blocking::Client};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
pub(crate) mod access;
mod gitea;
mod recovery;

const CURRENT: &str = env!("CARGO_PKG_VERSION");
const MANIFEST_NAME: &str = "diytools-refactor-windows-x86_64.json";
const MAX_METADATA: u64 = 128 * 1024;
const MAX_BINARY: u64 = 512 * 1024 * 1024;
const REPOSITORY: &str = "yamakaze1234/diytools-refactor";
const CHANNEL_TAG: &str = "refactor-updates";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    payload: String,
    signature: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    app_id: String,
    channel: String,
    platform: String,
    version: String,
    published_at: String,
    notes: String,
    artifact: Artifact,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    name: String,
    size: u64,
    sha256: String,
    urls: Vec<String>,
}
#[derive(Clone)]
struct Checked {
    envelope: Envelope,
    manifest: Manifest,
    source: String,
}
struct Pending {
    checked: Checked,
    directory: PathBuf,
}
#[derive(Default)]
struct Inner {
    checked: Option<Checked>,
    pending: Option<Pending>,
}
#[derive(Default)]
pub struct UpdaterState(Mutex<Inner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    current_version: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    source: Option<String>,
    can_install: bool,
    message: String,
}
#[derive(Serialize)]
pub struct DownloadReport {
    version: String,
    source: String,
}
#[derive(Serialize)]
pub struct InstallReport {
    message: String,
}
#[derive(Clone, Serialize)]
struct Progress {
    phase: &'static str,
    received: u64,
    total: u64,
}

fn public_key() -> Result<VerifyingKey, String> {
    let raw = STANDARD
        .decode(include_str!("../updater-public-key.txt").trim())
        .map_err(|_| "更新公钥格式错误")?;
    let bytes: [u8; 32] = raw.try_into().map_err(|_| "更新公钥长度错误")?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "更新公钥无效".into())
}

// 先验证签名覆盖的原始载荷，再核对产品、平台、版本和下载契约。
fn verify_envelope(
    envelope: &Envelope,
    key: &VerifyingKey,
    current: &str,
) -> Result<Manifest, String> {
    if envelope.payload.len() as u64 > MAX_METADATA || envelope.signature.len() > 128 {
        return Err("更新清单超过长度限制".into());
    }
    let bytes = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "清单编码无效")?;
    let sig = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "签名编码无效")?;
    let signature = Signature::from_slice(&sig).map_err(|_| "更新签名长度无效")?;
    key.verify_strict(&bytes, &signature)
        .map_err(|_| "更新清单签名验证失败")?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "更新清单格式无效")?;
    if manifest.schema != 1
        || manifest.app_id != "io.diytools.refactor"
        || manifest.channel != "refactor"
        || manifest.platform != "windows-x86_64"
    {
        return Err("更新清单不属于本重构版本/平台".into());
    }
    let version = Version::parse(&manifest.version).map_err(|_| "更新版本号无效")?;
    let current = Version::parse(current).map_err(|_| "当前版本号无效")?;
    if version < current {
        return Err("拒绝降级更新".into());
    }
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("更新版本须为稳定语义版本".into());
    }
    if chrono::DateTime::parse_from_rfc3339(&manifest.published_at).is_err()
        || manifest.notes.len() > 16 * 1024
    {
        return Err("发布日期或说明无效".into());
    }
    let artifact = &manifest.artifact;
    if artifact.name != format!("diytools-refactor-{}-windows-x86_64.exe", manifest.version)
        || artifact.size == 0
        || artifact.size > MAX_BINARY
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || artifact.urls.is_empty()
        || artifact.urls.len() > 2
        || (artifact.urls.len() == 2 && artifact.urls[0] == artifact.urls[1])
    {
        return Err("更新产物名称/长度/摘要无效".into());
    }
    for url in &artifact.urls {
        let url = Url::parse(url).map_err(|_| "更新下载地址无效")?;
        if !download_url_matches(
            &url,
            &format!("refactor-v{}", manifest.version),
            &artifact.name,
        ) && !gitea::download_matches(
            &url,
            &format!("refactor-v{}", manifest.version),
            &artifact.name,
        ) {
            return Err("更新下载地址超出受信仓库".into());
        }
    }
    Ok(manifest)
}

// 更新地址须满足固定 HTTPS 信任范围，不能跟随任意下载主机。
fn secure_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
// 只认可本仓库的精确 API 路径，令牌不能进入其他仓库、搜索或任意 API。
fn api_url_allowed(url: &Url) -> bool {
    if !secure_url(url) || url.host_str() != Some("api.github.com") || url.query().is_some() {
        return false;
    }
    let prefix = format!("/repos/{REPOSITORY}/releases/");
    let Some(rest) = url.path().strip_prefix(&prefix) else {
        return false;
    };
    if let Some(id) = rest.strip_prefix("assets/") {
        return !id.is_empty()
            && id.bytes().all(|b| b.is_ascii_digit())
            && id.parse::<u64>().is_ok_and(|n| n > 0);
    }
    if let Some(tag) = rest.strip_prefix("tags/") {
        return tag == CHANNEL_TAG
            || tag.strip_prefix("refactor-v").is_some_and(|value| {
                Version::parse(value).is_ok_and(|version| {
                    version.pre.is_empty()
                        && version.build.is_empty()
                        && version.to_string() == value
                })
            });
    }
    false
}
fn download_url_matches(url: &Url, tag: &str, name: &str) -> bool {
    secure_url(url)
        && url.host_str() == Some("github.com")
        && url.query().is_none()
        && url.path() == format!("/{REPOSITORY}/releases/download/{tag}/{name}")
}
// 自动重定向禁用；附件 API 只可进入 GitHub 两个指定 CDN，CDN 不能跳回 API。
fn redirect_allowed(origin: &Url, current: &Url, next: &Url) -> bool {
    let asset_api = api_url_allowed(origin) && origin.path().contains("/releases/assets/");
    asset_api
        && secure_url(next)
        && matches!(
            current.host_str(),
            Some(
                "api.github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
        && matches!(
            next.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
}
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("DIYTools-Refactor-Updater/1")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化更新网络客户端".into())
}
// 每一次请求都重新构造请求头；CDN 请求绝不携带 Authorization。
fn request(
    client: &Client,
    url: &Url,
    token: Option<&str>,
    binary: bool,
) -> Result<reqwest::blocking::RequestBuilder, String> {
    let is_api = url.host_str() == Some("api.github.com");
    if is_api && !api_url_allowed(url) {
        return Err("GitHub API 地址超出受信仓库".into());
    }
    if !is_api
        && (!binary
            || !secure_url(url)
            || !matches!(
                url.host_str(),
                Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
            ))
    {
        return Err("更新请求地址不受信".into());
    }
    let mut builder = client.get(url.clone()).header(
        reqwest::header::ACCEPT,
        if binary {
            "application/octet-stream"
        } else {
            "application/vnd.github+json"
        },
    );
    if is_api {
        builder = builder.header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = token {
            let mut authorization =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| "GitHub 更新授权格式无效")?;
            authorization.set_sensitive(true);
            builder = builder.header(reqwest::header::AUTHORIZATION, authorization);
        }
    }
    Ok(builder)
}
// 网络错误只报告固定说明和状态码，禁止暴露 token 或带签名的 CDN URL。
fn response_status(
    response: reqwest::blocking::Response,
    has_token: bool,
) -> Result<reqwest::blocking::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if matches!(status.as_u16(), 401 | 403 | 404) {
        return Err(if has_token {
            format!(
                "GitHub 更新访问受限（HTTP {}）；请核对 token 授权的本仓库 Contents 读取权限、有效期及发布状态",
                status.as_u16()
            )
        } else {
            format!(
                "GitHub 更新访问受限（HTTP {}）；私有仓库需要保存读取 token 或先在本机 gh auth login，未检测到可用授权",
                status.as_u16()
            )
        });
    }
    Err(format!("GitHub 更新请求失败（HTTP {}）", status.as_u16()))
}
fn asset_response(
    client: &Client,
    url: &Url,
    token: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    if !api_url_allowed(url) || !url.path().contains("/releases/assets/") {
        return Err("附件 API 地址不受信".into());
    }
    let mut current = url.clone();
    for hop in 0..=5 {
        let response = request(client, &current, token, true)?
            .send()
            .map_err(|_| "GitHub 附件下载请求失败")?;
        if !response.status().is_redirection() {
            return response_status(response, token.is_some());
        }
        if hop == 5 {
            return Err("GitHub 附件重定向超过限制".into());
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|h| h.to_str().ok())
            .ok_or("GitHub 附件重定向缺少地址")?;
        let next = current
            .join(location)
            .map_err(|_| "GitHub 附件重定向地址无效")?;
        if !redirect_allowed(url, &current, &next) {
            return Err("GitHub 附件重定向地址不受信".into());
        }
        current = next;
    }
    Err("GitHub 附件重定向超过限制".into())
}
fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取更新响应失败")?;
    if bytes.len() as u64 > limit {
        return Err("更新响应超过长度限制".into());
    }
    Ok(bytes)
}
fn get_metadata(client: &Client, url: &Url, token: Option<&str>) -> Result<Vec<u8>, String> {
    let response = request(client, url, token, false)?
        .timeout(Duration::from_secs(25))
        .send()
        .map_err(|_| "GitHub 发布信息请求失败")?;
    let response = response_status(response, token.is_some())?;
    if response.content_length().is_some_and(|n| n > MAX_METADATA) {
        return Err("更新响应过大".into());
    }
    read_bounded(response, MAX_METADATA)
}
fn release_asset(release: &serde_json::Value, tag: &str, name: &str) -> Result<Url, String> {
    if release["tag_name"] != tag || release["draft"] != false || release["prerelease"] != false {
        return Err("GitHub 发布标签或发布状态不符合更新契约".into());
    }
    let assets = release["assets"].as_array().ok_or("GitHub 发布缺少附件")?;
    let mut matching = assets.iter().filter(|asset| asset["name"] == name);
    let asset = matching.next().ok_or("尚无兼容本重构版本的签名更新附件")?;
    if matching.next().is_some() {
        return Err("GitHub 发布附件名称重复".into());
    }
    let id = asset["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("GitHub 附件 ID 无效")?;
    let expected = format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/{id}");
    if asset["url"].as_str() != Some(expected.as_str()) || asset["state"] != "uploaded" {
        return Err("GitHub 附件 API 地址或状态无效".into());
    }
    let browser = Url::parse(
        asset["browser_download_url"]
            .as_str()
            .ok_or("GitHub 附件缺少下载地址")?,
    )
    .map_err(|_| "GitHub 附件下载地址无效")?;
    if !download_url_matches(&browser, tag, name) {
        return Err("GitHub 附件下载地址超出受信仓库".into());
    }
    Url::parse(&expected).map_err(|_| "GitHub 附件 API 地址无效".into())
}
fn release_url(tag: &str) -> Result<Url, String> {
    let url = Url::parse(&format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}"
    ))
    .map_err(|_| "发布标签无效")?;
    if !api_url_allowed(&url) {
        return Err("发布标签无效".into());
    }
    Ok(url)
}
fn check_github(client: &Client, token: Option<&str>) -> Result<Checked, String> {
    let release: serde_json::Value =
        serde_json::from_slice(&get_metadata(client, &release_url(CHANNEL_TAG)?, token)?)
            .map_err(|_| "发布信息格式无效")?;
    let asset = release_asset(&release, CHANNEL_TAG, MANIFEST_NAME)?;
    let response = asset_response(client, &asset, token)?;
    if response.content_length().is_some_and(|n| n > MAX_METADATA) {
        return Err("签名清单过大".into());
    }
    let envelope: Envelope = serde_json::from_slice(&read_bounded(response, MAX_METADATA)?)
        .map_err(|_| "签名清单封装无效")?;
    let manifest = verify_envelope(&envelope, &public_key()?, CURRENT)?;
    Ok(Checked {
        envelope,
        manifest,
        source: "GitHub".into(),
    })
}
// 下载前重新核对版本发布附件与已签名 URL；私有和公开仓库共用附件 API。
fn github_artifact_response(
    client: &Client,
    manifest: &Manifest,
    token: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let tag = format!("refactor-v{}", manifest.version);
    let release: serde_json::Value =
        serde_json::from_slice(&get_metadata(client, &release_url(&tag)?, token)?)
            .map_err(|_| "发布信息格式无效")?;
    let url = release_asset(&release, &tag, &manifest.artifact.name)?;
    let response = asset_response(client, &url, token)?;
    if response
        .content_length()
        .is_some_and(|n| n != manifest.artifact.size)
    {
        return Err("下载长度与签名清单不符".into());
    }
    Ok(response)
}

// 主源成功时完全不读取备用凭据；主源安全校验失败时禁止静默降级。
fn prefer_primary<T>(
    primary: Result<Option<T>, String>,
    fallback: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match primary {
        Ok(Some(value)) => Ok(value),
        Ok(None) => fallback(),
        Err(error) => Err(error),
    }
}
fn check_source(client: &Client) -> Result<Checked, String> {
    prefer_primary(gitea::check(client), || {
        let token = access::resolve()?;
        check_github(client, token.as_ref().map(access::Token::value))
            .map_err(|error| format!("Gitea 暂不可用；备用源：{error}"))
    })
}
// 只尝试清单已签名的源；备用下载的实际来源同步呈现给用户。
fn artifact_response(
    client: &Client,
    manifest: &Manifest,
) -> Result<(reqwest::blocking::Response, String), String> {
    let tag = format!("refactor-v{}", manifest.version);
    let signed_source = |gitea_source: bool| {
        manifest.artifact.urls.iter().any(|text| {
            Url::parse(text).is_ok_and(|url| {
                if gitea_source {
                    gitea::download_matches(&url, &tag, &manifest.artifact.name)
                } else {
                    download_url_matches(&url, &tag, &manifest.artifact.name)
                }
            })
        })
    };
    let primary = if signed_source(true) {
        gitea::artifact(client, manifest)?.map(|response| (response, "Gitea".into()))
    } else {
        None
    };
    prefer_primary(Ok(primary), || {
        if !signed_source(false) {
            return Err("Gitea 下载暂不可用，清单未包含备用下载源".into());
        }
        let token = access::resolve()?;
        github_artifact_response(client, manifest, token.as_ref().map(access::Token::value))
            .map(|response| (response, "GitHub".into()))
    })
}

// 无窗口线上验收只写独立输出目录：检查签名并下载核验 EXE，绝不启动或替换程序。
fn download_probe(output: &Path) -> Result<serde_json::Value, String> {
    fs::create_dir_all(output).map_err(|_| "无法创建更新验收目录")?;
    plain_path(output)?;
    let directory = output.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&directory).map_err(|_| "无法创建独立更新验收目录")?;
    let client = client()?;
    let checked = check_source(&client)?;
    let (response, source) = artifact_response(&client, &checked.manifest)?;
    let artifact_path = directory.join(&checked.manifest.artifact.name);
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&artifact_path)
        .map_err(|_| "无法创建更新验收附件")?;
    stream_artifact(response, &mut file, &checked.manifest.artifact, |_| {})?;
    fs::write(
        directory.join(MANIFEST_NAME),
        serde_json::to_vec(&checked.envelope).map_err(|_| "无法保存签名清单")?,
    )
    .map_err(|_| "无法保存签名清单")?;
    let report = serde_json::json!({"currentVersion":CURRENT,"version":checked.manifest.version,
        "source":source,"signatureVerified":true,"sha256Verified":true,"lengthVerified":true,
        "artifact":artifact_path,"size":checked.manifest.artifact.size,"sha256":checked.manifest.artifact.sha256,
        "access":if source == "Gitea" { serde_json::json!({"source":"anonymous","configured":false}) } else { serde_json::to_value(access::status()?).map_err(|_| "授权状态编码失败")? },"installed":false,"started":false});
    fs::write(
        directory.join("probe-result.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "无法保存验收结果")?,
    )
    .map_err(|_| "无法保存验收结果")?;
    Ok(report)
}
fn executable_root() -> Result<(PathBuf, PathBuf), String> {
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = executable.parent().ok_or("程序目录不可用")?.to_path_buf();
    Ok((executable, root))
}
fn portable_marker(root: &Path) -> Result<(), String> {
    plain_path(root)?;
    let marker = root.join("diytools-portable.json");
    plain_path(&marker)?;
    let value: serde_json::Value = serde_json::from_slice(&read_bounded(
        fs::File::open(marker).map_err(|_| "仅便携版本支持直接更新")?,
        4096,
    )?)
    .map_err(|_| "便携版标记无效")?;
    if value["mode"] != "portable" {
        return Err("便携版标记模式无效".into());
    }
    Ok(())
}
// 仅在可验证的便携安装布局下开放自动替换，其他环境保留手动处理。
fn install_capability() -> Result<(), String> {
    if !cfg!(target_os = "windows") || !cfg!(target_arch = "x86_64") || cfg!(debug_assertions) {
        return Err("当前运行环境仅支持检查更新；直接更新需要 Windows x64 正式便携版".into());
    }
    portable_marker(&executable_root()?.1)
}
// 拒绝符号链接和重解析点等特殊路径，防止更新动作越出预期目录。
fn plain_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("更新路径不能是符号链接".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("更新路径不能是重解析点".into());
            }
        }
    }
    Ok(())
}
fn create_directory(root: &Path) -> Result<PathBuf, String> {
    let updates = root.join(".updates");
    if !updates.exists() {
        fs::create_dir(&updates).map_err(|e| e.to_string())?;
    }
    plain_path(&updates)?;
    let directory = updates.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

#[tauri::command]
// 后台读取并校验发布信息，缓存已验证结果供下载阶段复用。
pub async fn updater_check(app: tauri::AppHandle) -> Result<CheckReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdaterState>();
        let mut inner = state.0.try_lock().map_err(|_| "另一项更新操作正在进行")?;
        inner.checked = None;
        inner.pending = None;
        let checked = check_source(&client()?)?;
        let available = Version::parse(&checked.manifest.version).map_err(|e| e.to_string())?
            > Version::parse(CURRENT).map_err(|e| e.to_string())?;
        let capability = install_capability();
        let report = CheckReport {
            current_version: CURRENT.into(),
            available,
            version: Some(checked.manifest.version.clone()),
            notes: Some(checked.manifest.notes.clone()),
            source: Some(checked.source.clone()),
            can_install: capability.is_ok(),
            message: if available {
                capability
                    .err()
                    .unwrap_or_else(|| "发现已验证签名的新版本，可下载后直接更新".into())
            } else {
                "已成功核验签名清单，当前版本已是最新".into()
            },
        };
        if available {
            inner.checked = Some(checked);
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

// 本机更新结果不依赖网络，离线时也能说明上次回滚原因和备份位置。
#[tauri::command]
pub fn updater_recovery_status() -> Result<Option<serde_json::Value>, String> {
    let (_, root) = executable_root()?;
    latest_recovery_status(&root)
}
fn latest_recovery_status(root: &Path) -> Result<Option<serde_json::Value>, String> {
    let updates = root.join(".updates");
    if !updates.exists() {
        return Ok(None);
    }
    plain_path(&updates)?;
    let mut latest: Option<(std::time::SystemTime, serde_json::Value)> = None;
    for entry in fs::read_dir(&updates).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| uuid::Uuid::parse_str(name).ok())
            .is_none()
        {
            continue;
        }
        let path = entry.path().join("status.json");
        if !path.exists() || plain_path(&path).is_err() {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let Ok(bytes) = read_bounded(file, 16384) else {
            continue;
        };
        let Ok(mut status) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if !matches!(
            status["phase"].as_str(),
            Some("installed" | "failed" | "started-unconfirmed")
        ) {
            continue;
        }
        let Ok(modified) = fs::metadata(&path).and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest.as_ref().is_none_or(|(time, _)| modified > *time) {
            status["directory"] = entry.path().to_string_lossy().to_string().into();
            latest = Some((modified, status));
        }
    }
    Ok(latest.map(|(_, value)| value))
}

// 流式下载同时累计大小和摘要，只有与签名清单完全一致才算下载成功。
fn stream_artifact(
    mut reader: impl Read,
    file: &mut fs::File,
    artifact: &Artifact,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let mut digest = Sha256::new();
    let mut received = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "读取更新文件失败")?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > artifact.size || received > MAX_BINARY {
            return Err("更新下载超过签名清单长度".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        digest.update(&buffer[..count]);
        progress(received);
    }
    if received != artifact.size
        || format!("{:x}", digest.finalize()) != artifact.sha256.to_ascii_lowercase()
    {
        return Err("更新文件长度或 SHA256 验证失败，禁止安装".into());
    }
    file.sync_all().map_err(|e| e.to_string())
}
#[tauri::command]
// 下载到本次独立更新目录，校验完成后登记待安装状态，不直接覆盖运行程序。
pub async fn updater_download(app: tauri::AppHandle) -> Result<DownloadReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_capability()?;
        let state = app.state::<UpdaterState>();
        let mut inner = state.0.try_lock().map_err(|_| "另一项更新操作正在进行")?;
        let checked = inner.checked.clone().ok_or("请先检查并核验新版本")?;
        inner.pending = None;
        verify_envelope(&checked.envelope, &public_key()?, CURRENT)?;
        let root = executable_root()?.1;
        let client = client()?;
        let directory = create_directory(&root)?;
        let mut download_source = checked.source.clone();
        let outcome = (|| {
            let (response, source) = artifact_response(&client, &checked.manifest)?;
            download_source = source;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(directory.join("artifact.exe"))
                .map_err(|e| e.to_string())?;
            let mut last = Instant::now() - Duration::from_secs(1);
            stream_artifact(
                response,
                &mut file,
                &checked.manifest.artifact,
                |received| {
                    if last.elapsed() >= Duration::from_millis(100)
                        || received == checked.manifest.artifact.size
                    {
                        let _ = app.emit(
                            "updater-progress",
                            Progress {
                                phase: "downloading",
                                received,
                                total: checked.manifest.artifact.size,
                            },
                        );
                        last = Instant::now();
                    }
                },
            )
        })();
        if let Err(error) = outcome {
            let _ = write_status(&directory, "download-failed", &error);
            return Err(error);
        }
        let report = DownloadReport {
            version: checked.manifest.version.clone(),
            source: download_source,
        };
        inner.pending = Some(Pending { checked, directory });
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema: u32,
    parent_pid: u32,
    target_name: String,
    current_sha256: String,
    envelope: Envelope,
}
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_BINARY {
            return Err("程序文件超过更新长度限制".into());
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn write_status(directory: &Path, phase: &str, message: &str) -> Result<(), String> {
    let message: String = message.chars().take(2048).collect();
    fs::write(directory.join("status.json"), serde_json::to_vec(&serde_json::json!({"phase":phase,"message":message,"at":chrono::Utc::now().to_rfc3339()})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn hidden_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
struct HelperChild {
    child: std::process::Child,
    armed: bool,
}
impl Drop for HelperChild {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
#[tauri::command]
// 再次校验新程序并启动隐藏助手，确认助手就绪后才请求主程序退出。
pub async fn updater_install(app: tauri::AppHandle) -> Result<InstallReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_capability()?;
        let state = handle.state::<UpdaterState>();
        let mut inner = state.0.try_lock().map_err(|_| "另一项更新操作正在进行")?;
        let pending = inner.pending.take().ok_or("请先下载并校验更新")?;
        let (executable, root) = executable_root()?;
        let manifest = verify_envelope(&pending.checked.envelope, &public_key()?, CURRENT)?;
        let artifact = pending.directory.join("artifact.exe");
        plain_path(&artifact)?;
        if hash_file(&artifact)? != manifest.artifact.sha256.to_ascii_lowercase()
            || fs::metadata(&artifact).map_err(|e| e.to_string())?.len() != manifest.artifact.size
        {
            return Err("待安装文件已改变，禁止安装".into());
        }
        let helper = pending.directory.join("helper.exe");
        let mut helper_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&helper)
            .map_err(|e| e.to_string())?;
        std::io::copy(
            &mut fs::File::open(&executable).map_err(|e| e.to_string())?,
            &mut helper_file,
        )
        .map_err(|e| e.to_string())?;
        helper_file.sync_all().map_err(|e| e.to_string())?;
        drop(helper_file);
        let plan = Plan {
            schema: 1,
            parent_pid: std::process::id(),
            target_name: executable
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("程序文件名无效")?
                .into(),
            current_sha256: hash_file(&executable)?,
            envelope: pending.checked.envelope,
        };
        let plan_path = pending.directory.join("plan.json");
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&plan_path)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&plan).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let child = hidden_command(&helper)
            // 上一次更新的回执环境不能传播到新的助手或回滚程序。
            .env_remove("DIYTOOLS_UPDATE_RECEIPT")
            .arg("--apply-update")
            .arg(&plan_path)
            .current_dir(&root)
            .spawn()
            .map_err(|e| format!("更新助手启动失败：{e}"))?;
        let mut child = HelperChild { child, armed: true };
        let start = Instant::now();
        loop {
            if pending.directory.join("ready.json").is_file() {
                let ready: serde_json::Value = serde_json::from_slice(&read_bounded(
                    fs::File::open(pending.directory.join("ready.json"))
                        .map_err(|e| e.to_string())?,
                    4096,
                )?)
                .map_err(|e| e.to_string())?;
                if ready["pid"] == child.child.id() && ready["parentPid"] == std::process::id() {
                    child.armed = false;
                    break;
                }
            }
            if let Some(code) = child.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("更新助手未就绪即退出：{code}；程序保持运行"));
            }
            if start.elapsed() > Duration::from_secs(15) {
                return Err("更新助手就绪超时；程序保持运行".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(InstallReport {
            message: "更新助手已就绪，程序将退出并安装已验证版本".into(),
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    // The frontend awaits this only to surface errors; a ready helper now owns replacement.
    app.exit(0);
    Ok(InstallReport {
        message: "更新助手已就绪".into(),
    })
}

// 助手独立复核目录布局、签名、旧程序摘要和新程序长度，拒绝重放已用计划。
fn validate_plan(
    helper: &Path,
    plan_path: &Path,
    key: &VerifyingKey,
) -> Result<(Plan, PathBuf, PathBuf), String> {
    plain_path(helper)?;
    let canonical_helper = helper.canonicalize().map_err(|e| e.to_string())?;
    let helper = canonical_helper.as_path();
    plain_path(plan_path)?;
    let canonical_plan = plan_path.canonicalize().map_err(|e| e.to_string())?;
    let plan_path = canonical_plan.as_path();
    let directory = helper.parent().ok_or("助手目录无效")?;
    let updates = directory.parent().ok_or("更新目录无效")?;
    let root = updates.parent().ok_or("便携目录无效")?;
    if helper.file_name().and_then(|n| n.to_str()) != Some("helper.exe")
        || updates.file_name().and_then(|n| n.to_str()) != Some(".updates")
        || directory
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| uuid::Uuid::parse_str(n).ok())
            .is_none()
        || plan_path != directory.join("plan.json")
    {
        return Err("更新助手/计划路径无效".into());
    }
    portable_marker(root)?;
    plain_path(plan_path)?;
    let plan: Plan = serde_json::from_slice(&read_bounded(
        fs::File::open(plan_path).map_err(|e| e.to_string())?,
        MAX_METADATA,
    )?)
    .map_err(|e| e.to_string())?;
    if plan.schema != 1
        || plan.parent_pid == 0
        || plan.parent_pid == std::process::id()
        || !matches!(
            Path::new(&plan.target_name)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [std::path::Component::Normal(_)]
        )
        || !plan.target_name.to_ascii_lowercase().ends_with(".exe")
    {
        return Err("更新计划目标无效".into());
    }
    let manifest = verify_envelope(&plan.envelope, key, CURRENT)?;
    if Version::parse(&manifest.version).map_err(|e| e.to_string())?
        <= Version::parse(CURRENT).map_err(|e| e.to_string())?
    {
        return Err("助手拒绝同版本或降级更新".into());
    }
    let target = root.join(&plan.target_name);
    let artifact = directory.join("artifact.exe");
    plain_path(&target)?;
    plain_path(&artifact)?;
    if hash_file(helper)? != plan.current_sha256 || hash_file(&target)? != plan.current_sha256 {
        return Err("当前程序与更新助手摘要不一致".into());
    }
    if fs::metadata(&artifact).map_err(|e| e.to_string())?.len() != manifest.artifact.size
        || hash_file(&artifact)? != manifest.artifact.sha256.to_ascii_lowercase()
    {
        return Err("助手拒绝长度或摘要不符的新程序".into());
    }
    if directory.join("backup.exe").exists()
        || directory.join("failed-new.exe").exists()
        || directory.join("ready.json").exists()
        || directory.join("startup-ready.json").exists()
        || directory.join("database-backup").exists()
    {
        return Err("更新目录已使用，拒绝重放".into());
    }
    Ok((plan, target, artifact))
}

// 保留旧程序再安装新程序；替换或启动失败时恢复旧程序，不覆盖已有备份。
#[cfg(test)]
fn replace_and_start(
    target: &Path,
    artifact: &Path,
    directory: &Path,
    start: impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    replace_with_recovery(target, artifact, directory, start, || Ok(()))
}

// 数据库恢复先于旧程序重启，恢复失败时保留新旧程序及完整备份供处理。
fn replace_with_recovery(
    target: &Path,
    artifact: &Path,
    directory: &Path,
    mut start: impl FnMut(&Path) -> Result<(), String>,
    mut restore: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let backup = directory.join("backup.exe");
    if backup.exists() || directory.join("failed-new.exe").exists() {
        return Err("备份目标已存在，拒绝覆盖".into());
    }
    fs::rename(target, &backup).map_err(|e| format!("保留旧程序失败：{e}"))?;
    if let Err(error) = fs::rename(artifact, target) {
        fs::rename(&backup, target).map_err(|rollback| {
            format!(
                "替换失败：{error}；回滚失败：{rollback}；旧程序在 {}",
                backup.display()
            )
        })?;
        return match start(target) {
            Ok(()) => Err(format!("替换失败，已恢复并重新启动旧程序：{error}")),
            Err(restart) => Err(format!(
                "替换失败，旧程序已恢复但重启失败：{error}；{restart}"
            )),
        };
    }
    if let Err(error) = start(target) {
        restore().map_err(|restore_error| {
            format!("新程序启动失败：{error}；数据库恢复失败：{restore_error}；禁止重启旧程序")
        })?;
        fs::rename(target, directory.join("failed-new.exe")).map_err(|rollback| {
            format!(
                "启动失败：{error}；保留失败新程序失败：{rollback}；旧程序在 {}",
                backup.display()
            )
        })?;
        fs::rename(&backup, target).map_err(|rollback| {
            format!(
                "启动失败：{error}；恢复旧程序失败：{rollback}；旧程序在 {}",
                backup.display()
            )
        })?;
        return match start(target) {
            Ok(()) => Err(format!("新程序启动失败，已恢复并重新启动旧程序：{error}")),
            Err(restart) => Err(format!(
                "新程序启动失败，旧程序已恢复但重启失败：{error}；{restart}"
            )),
        };
    }
    Ok(())
}

#[cfg(windows)]
fn apply_update(plan_path: &Path) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            QueryFullProcessImageNameW, WaitForSingleObject,
        },
    };
    let helper = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let (plan, target, artifact) = validate_plan(&helper, plan_path, &public_key()?)?;
    let directory = helper.parent().ok_or("更新目录无效")?;
    let handle = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            plan.parent_pid,
        )
    };
    if handle.is_null() {
        return Err("原程序进程不可用；不会替换程序".into());
    }
    struct Handle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let handle = Handle(handle);
    let mut buffer = vec![0_u16; 32768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err("不能确认原程序路径".into());
    }
    let parent_path = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
    if parent_path.canonicalize().map_err(|e| e.to_string())?
        != target.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("原进程不是待更新程序，拒绝替换".into());
    }
    write_status(
        directory,
        "ready",
        "已验证签名、路径、原程序与下载摘要，等待原进程退出",
    )?;
    let mut ready_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(directory.join("ready.tmp"))
        .map_err(|e| e.to_string())?;
    ready_file
        .write_all(
            &serde_json::to_vec(
                &serde_json::json!({"pid":std::process::id(),"parentPid":plan.parent_pid}),
            )
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    ready_file.sync_all().map_err(|e| e.to_string())?;
    drop(ready_file);
    fs::rename(directory.join("ready.tmp"), directory.join("ready.json"))
        .map_err(|e| e.to_string())?;
    if unsafe { WaitForSingleObject(handle.0, 60000) } != WAIT_OBJECT_0 {
        return Err("原程序未在60秒内退出，旧程序保持不变".into());
    }
    // Revalidate both bytes and paths immediately before the first rename.
    portable_marker(target.parent().ok_or("便携目录无效")?)?;
    plain_path(&target)?;
    plain_path(&artifact)?;
    let manifest = verify_envelope(&plan.envelope, &public_key()?, CURRENT)?;
    if hash_file(&target)? != plan.current_sha256
        || hash_file(&artifact)? != manifest.artifact.sha256.to_ascii_lowercase()
        || fs::metadata(&artifact).map_err(|e| e.to_string())?.len() != manifest.artifact.size
    {
        return Err("等待退出期间文件发生变化，拒绝替换".into());
    }
    // 旧进程已完全退出，先备份包含 WAL 提交的数据库，再替换可执行文件。
    let snapshot =
        match recovery::Snapshot::capture(target.parent().ok_or("便携目录无效")?, directory) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                // 备份失败尚未修改程序或业务库，恢复用户的旧程序入口。
                let restart = hidden_command(&target)
                    .env_remove("DIYTOOLS_UPDATE_RECEIPT")
                    .current_dir(target.parent().ok_or("便携目录无效")?)
                    .spawn();
                return Err(match restart {
                    Ok(_) => format!("更新前数据库备份失败，更新已取消并重新启动旧程序：{error}"),
                    Err(restart) => {
                        format!("更新前数据库备份失败，旧程序未改变但重启失败：{error}；{restart}")
                    }
                });
            }
        };
    let mut first_start = true;
    let mut confirmed = false;
    replace_with_recovery(
        &target,
        &artifact,
        directory,
        |path| {
            // 替换本身失败时同样回到旧程序，无需等待新版本回执。
            let initial = first_start && hash_file(path)? != plan.current_sha256;
            first_start = false;
            let mut command = hidden_command(path);
            command.env_remove("DIYTOOLS_UPDATE_RECEIPT");
            command.current_dir(path.parent().ok_or("程序目录无效")?);
            if initial {
                command.env("DIYTOOLS_UPDATE_RECEIPT", directory);
            }
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            if !initial {
                return Ok(());
            }
            let began = Instant::now();
            loop {
                // 必须先确认进程仍存活；只有已经退出的失败程序才能安全回滚数据库。
                match child.try_wait() {
                    Ok(Some(code)) => return Err(format!("新进程初始化失败并退出：{code}")),
                    Err(_) => return Ok(()), // 无法确认退出时保持新版本和备份，绝不冒险回滚活动库。
                    Ok(None) => {}
                }
                if startup_receipt_matches(directory, child.id(), &manifest.version) {
                    confirmed = true;
                    return Ok(());
                }
                if began.elapsed() > Duration::from_secs(120) {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        },
        || snapshot.restore(),
    )?;
    if confirmed {
        write_status(
            directory,
            "installed",
            "新版本已完成数据库及本机运行时初始化；更新前程序与一致性数据库备份已保留",
        )
    } else {
        write_status(
            directory,
            "started-unconfirmed",
            "新进程仍运行或状态不能确认，尚未收到初始化完成回执；保留更新前程序和数据库备份，未回滚活动数据库",
        )
    }
}
#[cfg(not(windows))]
fn apply_update(_plan_path: &Path) -> Result<(), String> {
    Err("此平台不支持便携直接更新".into())
}

// 新版 setup 完成后写入进程/版本回执，普通启动没有环境参数时不写任何更新文件。
pub(crate) fn acknowledge_startup() -> Result<(), String> {
    let Some(directory) = std::env::var_os("DIYTOOLS_UPDATE_RECEIPT") else {
        return Ok(());
    };
    let directory = PathBuf::from(directory);
    plain_path(&directory)?;
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = executable.parent().ok_or("更新启动程序目录无效")?;
    if directory.parent() != Some(root.join(".updates").as_path())
        || directory
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| uuid::Uuid::parse_str(n).ok())
            .is_none()
    {
        return Err("更新启动回执目录无效".into());
    }
    portable_marker(root)?;
    let path = directory.join("startup-ready.json");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(
        &serde_json::to_vec(&serde_json::json!({"pid":std::process::id(),"version":CURRENT}))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

// 忽略尚未完整写入或不属于本次进程的回执，继续等待实际初始化结果。
fn startup_receipt_matches(directory: &Path, pid: u32, version: &str) -> bool {
    fs::File::open(directory.join("startup-ready.json"))
        .ok()
        .and_then(|file| read_bounded(file, 4096).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| value["pid"] == pid && value["version"] == version)
}

// 仅在明确的更新助手参数下执行替换流程，普通启动不进入安装逻辑。
pub fn helper_entry() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next()?;
    if first == "--probe-updates" {
        let Some(output) = args.next() else {
            return Some(2);
        };
        if args.next().is_some() {
            return Some(2);
        }
        return Some(match download_probe(Path::new(&output)) {
            Ok(report) => {
                println!("{report}");
                0
            }
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                1
            }
        });
    }
    if first == "--check-updates" {
        let result = client().and_then(|client| check_source(&client));
        match result {
            Ok(checked) => {
                println!(
                    "{}",
                    serde_json::json!({"currentVersion":CURRENT,"version":checked.manifest.version,"source":checked.source,"signatureVerified":true})
                );
                return Some(0);
            }
            Err(error) => {
                println!(
                    "{}",
                    serde_json::json!({"currentVersion":CURRENT,"error":error})
                );
                return Some(1);
            }
        }
    }
    if first != "--apply-update" {
        return None;
    }
    let Some(path) = args.next() else {
        return Some(2);
    };
    if args.next().is_some() {
        return Some(2);
    }
    let path = PathBuf::from(path);
    match apply_update(&path) {
        Ok(()) => Some(0),
        Err(error) => {
            // Only log alongside our actual helper, never at an arbitrary CLI plan path.
            if let Ok(executable) = std::env::current_exe()
                && executable.file_name().and_then(|n| n.to_str()) == Some("helper.exe")
                && let Some(directory) = executable.parent()
            {
                let _ = write_status(directory, "failed", &error);
            }
            eprintln!("{error}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests;
