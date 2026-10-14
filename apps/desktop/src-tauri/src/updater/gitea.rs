// Gitea 更新通道：仅匿名读取固定仓库，任何发布者或 GitHub 令牌都不传给此通道。
use super::*;

pub(super) const HOST: &str = "gitea.cq360.top";
pub(super) const REPO: &str = "CoreStudio/diy-tools-refactor";

pub(super) fn download_matches(url: &Url, tag: &str, name: &str) -> bool {
    secure_url(url)
        && url.host_str() == Some(HOST)
        && url.query().is_none()
        && url.path() == format!("/{REPO}/releases/download/{tag}/{name}")
}
fn tag_valid(tag: &str) -> bool {
    tag == CHANNEL_TAG
        || tag.strip_prefix("refactor-v").is_some_and(|text| {
            Version::parse(text)
                .is_ok_and(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == text)
        })
}
// 只允许精确发布 API、固定标签下载及同站点附件 UUID，禁止带凭据或跨站跳转。
fn allowed(url: &Url) -> bool {
    if !secure_url(url) || url.host_str() != Some(HOST) || url.query().is_some() {
        return false;
    }
    if let Some(tag) = url
        .path()
        .strip_prefix(&format!("/api/v1/repos/{REPO}/releases/tags/"))
    {
        return tag_valid(tag);
    }
    if let Some(path) = url
        .path()
        .strip_prefix(&format!("/{REPO}/releases/download/"))
    {
        if let Some((tag, name)) = path.split_once('/') {
            return tag_valid(tag)
                && (name == MANIFEST_NAME
                    || (tag.starts_with("refactor-v")
                        && name
                            == format!("diytools-refactor-{}-windows-x86_64.exe", &tag[10..])));
        }
    }
    url.path()
        .strip_prefix("/attachments/")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}
// 连接失败或服务不可用才切换备用源；格式、签名与地址错误必须明确失败。
fn response(
    client: &Client,
    url: &Url,
    metadata: bool,
) -> Result<Option<reqwest::blocking::Response>, String> {
    if !allowed(url) {
        return Err("Gitea 更新地址超出受信仓库".into());
    }
    let mut current = url.clone();
    for hop in 0..=3 {
        // 不设置 Authorization；调用方也不能提供令牌。
        let result = client
            .get(current.clone())
            .timeout(Duration::from_secs(if metadata { 12 } else { 180 }))
            .send();
        let Ok(result) = result else {
            return Ok(None);
        };
        if result.status().is_redirection() {
            if hop == 3 {
                return Err("Gitea 更新重定向超过限制".into());
            }
            let location = result
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|x| x.to_str().ok())
                .ok_or("Gitea 更新跳转地址缺失")?;
            let next = current
                .join(location)
                .map_err(|_| "Gitea 更新跳转地址无效")?;
            // 只有附件下载可以进入同站附件路径，不能跳入登录页或其他接口。
            if !allowed(&next) || next.path().starts_with("/api/") {
                return Err("Gitea 更新跳转地址不受信".into());
            }
            current = next;
            continue;
        }
        if !result.status().is_success() {
            return Ok(None);
        }
        return Ok(Some(result));
    }
    Ok(None)
}
fn release_asset(client: &Client, tag: &str, name: &str) -> Result<Option<Url>, String> {
    let url = Url::parse(&format!(
        "https://{HOST}/api/v1/repos/{REPO}/releases/tags/{tag}"
    ))
    .map_err(|_| "Gitea 标签无效")?;
    let Some(response) = response(client, &url, true)? else {
        return Ok(None);
    };
    let release: serde_json::Value = serde_json::from_slice(&read_bounded(response, MAX_METADATA)?)
        .map_err(|_| "Gitea 发布信息格式无效")?;
    asset_url(&release, tag, name).map(Some)
}
fn asset_url(release: &serde_json::Value, tag: &str, name: &str) -> Result<Url, String> {
    if release["tag_name"] != tag || release["draft"] != false || release["prerelease"] != false {
        return Err("Gitea 发布状态不符合更新契约".into());
    }
    let rows = release["assets"].as_array().ok_or("Gitea 发布缺少附件")?;
    let mut matching = rows.iter().filter(|row| row["name"] == name);
    let row = matching.next().ok_or("Gitea 发布缺少所需签名附件")?;
    if matching.next().is_some() {
        return Err("Gitea 发布附件名称重复".into());
    }
    let url = Url::parse(
        row["browser_download_url"]
            .as_str()
            .ok_or("Gitea 附件缺少地址")?,
    )
    .map_err(|_| "Gitea 附件地址无效")?;
    if !download_matches(&url, tag, name) {
        return Err("Gitea 附件不属于指定仓库和版本".into());
    }
    Ok(url)
}
pub(super) fn check(client: &Client) -> Result<Option<Checked>, String> {
    let Some(url) = release_asset(client, CHANNEL_TAG, MANIFEST_NAME)? else {
        return Ok(None);
    };
    let Some(response) = response(client, &url, true)? else {
        return Ok(None);
    };
    let envelope: Envelope = serde_json::from_slice(&read_bounded(response, MAX_METADATA)?)
        .map_err(|_| "Gitea 签名清单格式无效")?;
    let manifest = verify_envelope(&envelope, &public_key()?, CURRENT)?;
    Ok(Some(Checked {
        envelope,
        manifest,
        source: "Gitea".into(),
    }))
}
pub(super) fn artifact(
    client: &Client,
    manifest: &Manifest,
) -> Result<Option<reqwest::blocking::Response>, String> {
    let tag = format!("refactor-v{}", manifest.version);
    let Some(url) = release_asset(client, &tag, &manifest.artifact.name)? else {
        return Ok(None);
    };
    if !manifest.artifact.urls.contains(&url.to_string()) {
        return Err("Gitea 附件与签名下载地址不同".into());
    }
    let Some(response) = response(client, &url, false)? else {
        return Ok(None);
    };
    if response
        .content_length()
        .is_some_and(|n| n != manifest.artifact.size)
    {
        return Err("Gitea 附件长度与签名不同".into());
    }
    Ok(Some(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trusted_addresses_exclude_old_repo_login_and_other_hosts() {
        for path in [
            format!("/api/v1/repos/{REPO}/releases/tags/{CHANNEL_TAG}"),
            format!(
                "/{REPO}/releases/download/refactor-v0.2.2/diytools-refactor-0.2.2-windows-x86_64.exe"
            ),
            "/attachments/7a27b49e-c721-4f39-81e9-83a6dfbf4bac".into(),
        ] {
            assert!(
                allowed(&Url::parse(&format!("https://{HOST}{path}")).unwrap()),
                "{path}"
            );
        }
        for url in [
            format!("http://{HOST}/{REPO}/releases/download/{CHANNEL_TAG}/{MANIFEST_NAME}"),
            format!("https://{HOST}/user/login"),
            format!(
                "https://{HOST}/CoreStudio/diy-tools/releases/download/{CHANNEL_TAG}/{MANIFEST_NAME}"
            ),
            format!("https://{HOST}/attachments/../../user"),
            format!("https://{HOST}/attachments/invalid"),
            format!("https://{HOST}:444/attachments/7a27b49e-c721-4f39-81e9-83a6dfbf4bac"),
        ] {
            assert!(!allowed(&Url::parse(&url).unwrap()), "{url}");
        }
    }
    #[test]
    fn attachment_must_match_version_name_and_published_state() {
        let mut release = serde_json::json!({"tag_name":CHANNEL_TAG,"draft":false,"prerelease":false,"assets":[{"name":MANIFEST_NAME,"browser_download_url":format!("https://{HOST}/{REPO}/releases/download/{CHANNEL_TAG}/{MANIFEST_NAME}")}]});
        assert!(asset_url(&release, CHANNEL_TAG, MANIFEST_NAME).is_ok());
        release["draft"] = true.into();
        assert!(asset_url(&release, CHANNEL_TAG, MANIFEST_NAME).is_err());
        release["draft"] = false.into();
        release["assets"][0]["browser_download_url"] = format!(
            "https://{HOST}/CoreStudio/diy-tools/releases/download/{CHANNEL_TAG}/{MANIFEST_NAME}"
        )
        .into();
        assert!(asset_url(&release, CHANNEL_TAG, MANIFEST_NAME).is_err());
    }
}
