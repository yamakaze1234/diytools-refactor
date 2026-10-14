// 本地图片协议：只开放 uploads/saved 下的普通图片，并提供画布导出所需的跨域响应头。
//! Scoped local image serving; persisted business URLs remain /uploads and /saved.
use std::path::{Component, Path, PathBuf};
use tauri::http::{Request, Response};

pub struct AssetRoot(pub PathBuf);

// 解码百分号路径并拒绝无效 UTF-8，后续再按文件路径组件校验边界。
fn decode_path(raw: &str) -> Result<String, ()> {
    let mut out = Vec::new();
    let mut bytes = raw.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hi = (bytes.next().ok_or(())? as char).to_digit(16).ok_or(())?;
            let lo = (bytes.next().ok_or(())? as char).to_digit(16).ok_or(())?;
            out.push((hi * 16 + lo) as u8);
        } else {
            out.push(byte);
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

// 先限制业务目录，再规范化实际路径，防止相对路径或链接跳出图片根目录。
fn resolve(root: &Path, raw: &str) -> Result<PathBuf, ()> {
    let decoded = decode_path(raw)?;
    if decoded.contains(['\\', ':', '\0']) {
        return Err(());
    }
    let path = Path::new(decoded.strip_prefix('/').ok_or(())?);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(());
    }
    let head = path.components().next().ok_or(())?;
    if head.as_os_str() != "uploads" && head.as_os_str() != "saved" {
        return Err(());
    }
    let base = root.canonicalize().map_err(|_| ())?;
    let file = base.join(path).canonicalize().map_err(|_| ())?;
    if !file.starts_with(base) || !file.is_file() {
        return Err(());
    }
    Ok(file)
}

// 仅响应图片 GET/HEAD；明确 MIME 和大小上限，允许受控本机图片进入导出画布。
pub fn serve(root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result: Result<(&str, Vec<u8>), u16> = (|| {
        if request.method() != "GET" && request.method() != "HEAD" {
            return Err(405);
        }
        let file = resolve(root, request.uri().path()).map_err(|_| 404u16)?;
        let mime = match file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => return Err(415),
        };
        if file.metadata().map_err(|_| 404u16)?.len() > 128 * 1024 * 1024 {
            return Err(413);
        }
        let data = if request.method() == "HEAD" {
            Vec::new()
        } else {
            std::fs::read(file).map_err(|_| 404u16)?
        };
        Ok((mime, data))
    })();
    let (status, mime, body) = match result {
        Ok((mime, data)) => (200, mime, data),
        Err(status) => (
            status,
            "text/plain; charset=utf-8",
            b"Local asset unavailable".to_vec(),
        ),
    };
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-cache")
        .body(body)
        .expect("static asset response headers")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_non_image_roots() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for value in [
            "/uploads/../Cargo.toml",
            "/uploads/%2e%2e/Cargo.toml",
            "/uploads/a%5cb",
            "/uploads/a%3ab",
            "/saved/%00.png",
            "/Cargo.toml",
            "/uploads/%ff.png",
        ] {
            assert!(resolve(root, value).is_err(), "{value}");
        }
    }
}
