//! ERP 可选组件只读取 Gitea 固定通道。签名清单同时约束 ZIP 以及解压后的每个文件。
use super::*;
use crate::erp_session::ErpSessionState;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use tempfile::{NamedTempFile, TempDir};

pub(super) const TAG: &str = "erp-runtime-updates";
pub(super) const MANIFEST_NAME: &str = "diytools-erp-runtime-windows-x86_64.json";
const RECORD: &str = "erp-runtime-manifest.json";
const MEMBERS: [&str; 4] = [
    "erp-worker.exe",
    "erp-adapter.py",
    "erp-matching-adapter.py",
    "erp.domain",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Component {
    schema: u32,
    app_id: String,
    platform: String,
    channel: String,
    version: String,
    artifact: Artifact,
    files: BTreeMap<String, Member>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    status: &'static str,
    installed_version: Option<String>,
    available_version: Option<String>,
    has_local: bool,
    message: String,
}

fn artifact_name(version: &str) -> String {
    format!("erp-runtime-{version}-windows-x86_64.zip")
}
pub(super) fn valid_artifact_name(name: &str) -> bool {
    name.strip_prefix("erp-runtime-")
        .and_then(|s| s.strip_suffix("-windows-x86_64.zip"))
        .is_some_and(stable_version)
}
fn stable_version(s: &str) -> bool {
    Version::parse(s).is_ok_and(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == s)
}
fn digest_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn member_limit(name: &str) -> u64 {
    match name {
        "erp-worker.exe" => MAX_BINARY,
        "erp.domain" => 2048,
        _ => 1024 * 1024,
    }
}

// 签名必须属于组件用途，且只允许四个固定成员和一个同源 ZIP。
fn verify(envelope: &Envelope, key: &VerifyingKey) -> Result<Component, String> {
    let bytes = verified_payload(envelope, key)?;
    let c: Component = serde_json::from_slice(&bytes).map_err(|_| "ERP 组件清单格式无效")?;
    if c.schema != 1
        || c.app_id != "io.diytools.erp-runtime"
        || c.channel != TAG
        || c.platform != "windows-x86_64"
        || !stable_version(&c.version)
        || c.artifact.name != artifact_name(&c.version)
        || !digest_valid(&c.artifact.sha256)
        || !(1..=MAX_BINARY).contains(&c.artifact.size)
        || c.artifact.urls.len() != 1
        || !Url::parse(&c.artifact.urls[0])
            .is_ok_and(|url| gitea::download_matches(&url, TAG, &c.artifact.name))
        || c.files.len() != MEMBERS.len()
        || MEMBERS.iter().any(|name| {
            !c.files.get(*name).is_some_and(|file| {
                (1..=member_limit(name)).contains(&file.size) && digest_valid(&file.sha256)
            })
        })
    {
        return Err("ERP 组件用途、签名文件清单或 Gitea 下载地址无效".into());
    }
    Ok(c)
}

fn load_json(path: &Path, limit: u64) -> Result<Value, String> {
    plain_path(path)?;
    let f = fs::File::open(path).map_err(|_| "无法读取本机组件配置")?;
    serde_json::from_slice(&read_bounded(f, limit)?).map_err(|_| "本机组件配置格式无效".into())
}
fn config(data: &Path) -> Result<Value, String> {
    let path = data.join("integrations.json");
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(json!({"version": 1}));
    }
    let doc = load_json(&path, 64 * 1024)?;
    if doc["version"] != 1 || (!doc["erp"].is_null() && !doc["erp"].is_object()) {
        return Err("本机接入配置无效，无法合并组件设置".into());
    }
    Ok(doc)
}

fn checked_dir(parent: &Path, name: &str) -> Result<PathBuf, String> {
    plain_path(parent)?;
    let dir = parent.join(name);
    match fs::create_dir(&dir) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("无法创建 ERP 组件目录".into()),
    }
    plain_path(&dir)?;
    if !dir.is_dir() {
        return Err("ERP 组件目录无效".into());
    }
    Ok(dir)
}

// 与 Python OperationLock 互斥；不会按 operation.lock 是否存在判断运行状态。
pub(crate) fn operation_lock(data: &Path) -> Result<fs::File, String> {
    let dir = checked_dir(&checked_dir(data, "runtime")?, "erp-matching")?;
    let path = dir.join("operation.lock");
    if fs::symlink_metadata(&path).is_ok() {
        plain_path(&path)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|_| "无法打开本机 ERP 操作锁")?;
    file.try_lock()
        .map_err(|_| "ERP 匹配或读取任务正在运行，请等待完成后重试。")?;
    if file.metadata().map_err(|_| "无法检查 ERP 操作锁")?.len() == 0 {
        file.write_all(b"0").map_err(|_| "无法初始化 ERP 操作锁")?;
    }
    Ok(file)
}

// 新目录在完整校验后才通过 integrations 的一次原子写入生效。旧安装继续读取原有位置。
fn selection(data: &Path, cfg: &Value) -> Result<(PathBuf, bool), String> {
    let base = data.join("runtime");
    let Some(selection) = cfg["erp"].get("runtimeId") else {
        return Ok((base, false));
    };
    let id = selection
        .as_str()
        .and_then(|v| uuid::Uuid::parse_str(v).ok())
        .ok_or("本机组件版本记录无效")?;
    Ok((base.join(format!("erp-component-{id}")), true))
}
pub(crate) fn active_directory(data: &Path) -> Result<PathBuf, String> {
    let (dir, signed) = selection(data, &config(data)?)?;
    if signed {
        verify_installed(&dir, &public_key()?)?;
    }
    Ok(dir)
}
fn read_record(path: &Path) -> Result<Envelope, String> {
    serde_json::from_value(load_json(path, MAX_METADATA)?)
        .map_err(|_| "本机组件签名记录无效".into())
}
fn verify_installed(dir: &Path, key: &VerifyingKey) -> Result<Component, String> {
    let c = verify(&read_record(&dir.join(RECORD))?, key)?;
    for (name, file) in &c.files {
        let path = dir.join(name);
        plain_path(&path)?;
        let meta = fs::metadata(&path).map_err(|_| "本机组件文件缺失")?;
        if !meta.is_file() || meta.len() != file.size || hash_file(&path)? != file.sha256 {
            return Err("本机组件文件完整性检查失败".into());
        }
    }
    Ok(c)
}

fn remote(client: &Client) -> Result<(Envelope, Component), String> {
    let url = gitea::release_asset(client, TAG, MANIFEST_NAME)?.ok_or("Gitea 组件通道暂不可用")?;
    let response = gitea::response(client, &url, true)?.ok_or("暂时无法读取 Gitea 组件清单")?;
    let envelope = serde_json::from_slice(&read_bounded(response, MAX_METADATA)?)
        .map_err(|_| "Gitea 组件签名信封格式无效")?;
    let c = verify(&envelope, &public_key()?)?;
    Ok((envelope, c))
}
fn archive(client: &Client, c: &Component, output: &mut fs::File) -> Result<(), String> {
    let url = gitea::release_asset(client, TAG, &c.artifact.name)?.ok_or("Gitea 组件包暂不可用")?;
    if url.as_str() != c.artifact.urls[0] {
        return Err("组件包与签名地址不符".into());
    }
    let response = gitea::response(client, &url, false)?.ok_or("暂时无法下载 Gitea 组件包")?;
    if response
        .content_length()
        .is_some_and(|n| n != c.artifact.size)
    {
        return Err("Gitea 组件包长度无效".into());
    }
    stream_artifact(response, output, &c.artifact, |_| ())
}

fn valid_domain(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && !raw.chars().any(char::is_whitespace)
    })
}

// 按白名单创建新文件；即使包由可信密钥签发也拒绝目录、重复项、链接及过量解压数据。
fn extract(
    reader: impl std::io::Read + std::io::Seek,
    dir: &Path,
    c: &Component,
) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(reader).map_err(|_| "ERP 组件 ZIP 格式无效")?;
    let mut seen = BTreeSet::new();
    if zip.len() != MEMBERS.len() {
        return Err("组件包文件数不符".into());
    }
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| "无法读取 ERP 组件 ZIP 成员")?;
        let name = entry.name().to_owned();
        let file = c.files.get(&name).ok_or("组件 ZIP 含不允许的路径")?;
        if entry.name_raw() != name.as_bytes()
            || !MEMBERS.contains(&name.as_str())
            || !seen.insert(name.clone())
            || !entry.is_file()
            || entry
                .unix_mode()
                .is_some_and(|m| !matches!(m & 0o170000, 0 | 0o100000))
            || entry.size() != file.size
        {
            return Err("组件 ZIP 路径、类型、重复项或长度无效".into());
        }
        let path = dir.join(&name);
        let mut out = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| "无法暂存 ERP 组件文件")?;
        let size = std::io::copy(&mut (&mut entry).take(file.size + 1), &mut out)
            .map_err(|_| "解压 ERP 组件失败")?;
        if size != file.size {
            return Err("组件解压长度不符".into());
        }
        out.sync_all().map_err(|_| "无法持久化 ERP 组件")?;
        if hash_file(&path)? != file.sha256 {
            return Err("组件文件摘要不符".into());
        }
    }
    Ok(())
}
fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        plain_path(path)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "组件记录序列化失败")?;
    let mut temporary = NamedTempFile::new_in(path.parent().ok_or("组件目录无效")?)
        .map_err(|_| "无法暂存组件记录")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "无法持久化组件记录")?;
    temporary
        .persist(path)
        .map_err(|_| "无法原子切换组件记录")?;
    Ok(())
}

fn activate(
    data: &Path,
    envelope: &Envelope,
    c: &Component,
    reader: impl Read + std::io::Seek,
) -> Result<(), String> {
    let runtime = checked_dir(data, "runtime")?;
    let staged = TempDir::new_in(&runtime).map_err(|_| "无法创建组件暂存目录")?;
    extract(reader, staged.path(), c)?;
    let domain =
        fs::read_to_string(staged.path().join("erp.domain")).map_err(|_| "组件接入配置无效")?;
    let domain = domain.trim();
    if !valid_domain(domain) {
        return Err("组件接入地址必须为不含凭据的 HTTPS 来源".into());
    }
    let mut doc = config(data)?;
    let id = uuid::Uuid::new_v4();
    if doc["erp"].is_null() {
        doc["erp"] = json!({});
    }
    doc["erp"]["domain"] = json!(domain);
    doc["erp"]["runtimeId"] = json!(id.to_string());
    if serde_json::to_vec_pretty(&doc)
        .map_err(|_| "接入配置无效")?
        .len()
        > 64 * 1024
    {
        return Err("接入配置超出容量限制".into());
    }
    atomic_json(&staged.path().join(RECORD), envelope)?;
    let destination = runtime.join(format!("erp-component-{id}"));
    fs::rename(staged.path(), &destination).map_err(|_| "无法安装完整组件目录")?;
    // 先写可重建的顶层签名副本，再提交运行目录与域名；断电时旧指针仍能使用原目录及其签名。
    atomic_json(&runtime.join(RECORD), envelope)?;
    atomic_json(&data.join("integrations.json"), &doc)
}

struct Local {
    has_local: bool,
    installed: Option<Component>,
    intact: bool,
}
fn local(data: &Path, key: &VerifyingKey) -> Result<Local, String> {
    let cfg = config(data)?;
    let (dir, signed) = selection(data, &cfg)?;
    let has_local = cfg["erp"]["domain"].as_str().is_some_and(valid_domain)
        && MEMBERS[..3].iter().all(|f| dir.join(f).is_file());
    let installed = if signed {
        read_record(&dir.join(RECORD))
            .and_then(|r| verify(&r, key))
            .ok()
    } else {
        None
    };
    let intact = signed
        && has_local
        && verify_installed(&dir, key).is_ok()
        && read_record(&data.join("runtime").join(RECORD))
            .and_then(|r| verify(&r, key))
            .is_ok_and(|copy| {
                installed
                    .as_ref()
                    .is_some_and(|current| copy.artifact.sha256 == current.artifact.sha256)
            });
    Ok(Local {
        has_local,
        installed,
        intact,
    })
}
fn report(local: &Local, remote: Result<Component, String>) -> Result<Report, String> {
    let installed_version = local.installed.as_ref().map(|c| c.version.clone());
    let has_local = local.has_local;
    let (status, available_version, message) = match remote {
        Err(e) => ("unavailable", None, e),
        Ok(c) => {
            if let Some(old) = local.installed.as_ref() {
                let new_version = Version::parse(&c.version).map_err(|_| "组件版本格式无效")?;
                let old_version =
                    Version::parse(&old.version).map_err(|_| "本机组件版本格式无效")?;
                if new_version < old_version {
                    return Err("组件通道版本低于本机已签名版本，拒绝降级".into());
                }
                if new_version == old_version && old.artifact.sha256 != c.artifact.sha256 {
                    return Err("同一组件版本对应不同签名内容，请核对通道".into());
                }
            }
            let (status, message) =
                if local.intact && installed_version.as_ref() == Some(&c.version) {
                    ("ready", "ERP 组件已就绪")
                } else if has_local || installed_version.is_some() {
                    ("outdated", "本机 ERP 组件可更新或修复")
                } else {
                    ("missing", "本机尚未安装 ERP 匹配组件")
                };
            (status, Some(c.version), message.to_owned())
        }
    };
    Ok(Report {
        status,
        installed_version,
        available_version,
        has_local,
        message,
    })
}

#[tauri::command]
pub async fn erp_runtime_check(app: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let updater = app.state::<UpdaterState>();
        let _update = updater.0.lock().map_err(|_| "更新状态暂不可用")?;
        let state = app.state::<ErpSessionState>();
        let local = local(state.data_dir()?, &public_key()?)?;
        report(
            &local,
            client().and_then(|http| remote(&http).map(|(_, c)| c)),
        )
    })
    .await
    .map_err(|_| "组件检查未完成".to_owned())?
}

#[tauri::command]
pub async fn erp_runtime_install(app: tauri::AppHandle) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let updater = app.state::<UpdaterState>();
        let inner = updater
            .0
            .try_lock()
            .map_err(|_| "其他更新操作正在运行，请稍后再试")?;
        if inner.pending.is_some() {
            return Err("请先完成已下载的主程序更新".into());
        }
        let state = app.state::<ErpSessionState>();
        let http = client()?;
        let (envelope, c) = remote(&http)?;
        let data = state.data_dir()?;
        let checked = report(
            &local(data, &public_key()?)?,
            Ok(verify(&envelope, &public_key()?)?),
        )?;
        if checked.status == "ready" {
            return Ok(checked);
        }
        // 下载安装前确认无运行任务；下载期间保留已有会话，最终切换前再次持锁并优雅停止。
        tauri::async_runtime::block_on(state.when_idle(false, |_| Ok(())))?;
        let mut temp = NamedTempFile::new_in(data).map_err(|_| "无法暂存组件压缩包")?;
        archive(&http, &c, temp.as_file_mut())?;
        tauri::async_runtime::block_on(state.when_idle(true, |data| {
            let existing = local(data, &public_key()?)?;
            let checked = report(&existing, Ok(verify(&envelope, &public_key()?)?))?;
            if checked.status != "ready" {
                activate(
                    data,
                    &envelope,
                    &c,
                    temp.reopen().map_err(|_| "无法读取暂存组件包")?,
                )?;
            }
            report(&local(data, &public_key()?)?, Ok(c))
        }))
    })
    .await
    .map_err(|_| "组件安装未完成".to_owned())?
}

#[cfg(test)]
#[path = "component_tests.rs"]
mod tests;
