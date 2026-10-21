//! 每个运行中的导出任务拥有独立子目录；不覆盖用户文件，不相信前端提供的摘要。
use crate::agent_jobs::AgentJobs;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;
const MAX_IMAGE: u64 = 128 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MAX_METADATA: usize = 8 * 1024 * 1024;
static FILE_LOCK: Mutex<()> = Mutex::new(());
type Result<T> = std::result::Result<T, String>;
struct Session {
    dir: PathBuf,
    _guards: Vec<File>,
}
#[derive(Clone)]
struct Entry {
    name: String,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    crc: u32,
}
impl Entry {
    fn value(&self) -> Value {
        json!({"name":self.name,"bytes":self.bytes,"sha256":self.sha256})
    }
}
fn plain(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}
fn open_plain(path: &Path) -> Result<File> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !plain(&before) {
        return Err("不允许符号链接或 junction".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .custom_flags(0x02000000 | 0x00200000)
            .share_mode(1 | 2);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !plain(&metadata) {
        return Err("不允许符号链接或 junction".into());
    }
    Ok(file)
}
fn guard_directory(path: &Path, guards: &mut Vec<File>) -> Result<()> {
    let file = open_plain(path)?;
    if !file.metadata().map_err(|e| e.to_string())?.is_dir() {
        return Err("路径不是目录".into());
    }
    guards.push(file);
    Ok(())
}
fn session(jobs: &AgentJobs, id: &str) -> Result<Session> {
    let parsed = Uuid::parse_str(id).map_err(|_| "jobId 必须为 UUID")?;
    if parsed.to_string() != id {
        return Err("jobId 必须为标准 UUID".into());
    }
    let params = jobs.export_params(id).map_err(|e| e.to_string())?;
    let output = PathBuf::from(params["outputDir"].as_str().ok_or("缺少输出目录")?);
    if !output.is_absolute()
        || output.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("输出目录必须为不含相对片段的绝对目录".into());
    }
    if !output.try_exists().map_err(|e| format!("无法检查输出目录：{e}"))? {
        return Err("输出目录不存在，请先创建 outputDir 目录".into());
    }
    let mut guards = vec![];
    let ancestors: Vec<_> = output.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        guard_directory(ancestor, &mut guards)?;
    }
    let dir = output.join(format!("diytools-agent-{id}"));
    match fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    guard_directory(&dir, &mut guards)?;
    Ok(Session {
        dir,
        _guards: guards,
    })
}
fn segment_valid(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.encode_utf16().count() <= 160
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        && !matches!(
            stem.as_str(),
            "COM¹" | "COM²" | "COM³" | "LPT¹" | "LPT²" | "LPT³"
        )
}
fn image_name(name: &str) -> Result<Vec<&str>> {
    let parts: Vec<_> = name.split('/').collect();
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|p| !segment_valid(p)) {
        return Err("图片名称只允许最多两层普通相对路径".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Err("只允许 PNG/JPEG/WebP 图片".into());
    }
    Ok(parts)
}
fn target(session: &mut Session, name: &str, create: bool) -> Result<PathBuf> {
    let parts = image_name(name)?;
    if parts.len() == 2 {
        let directory = session.dir.join(parts[0]);
        if create {
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        guard_directory(&directory, &mut session._guards)?;
    }
    Ok(parts
        .iter()
        .fold(session.dir.clone(), |path, part| path.join(part)))
}
fn digest(path: &Path, name: &str) -> Result<Entry> {
    let mut file = open_plain(path)?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("输出项必须为普通文件".into());
    }
    let mut hash = Sha256::new();
    let mut crc = !0u32;
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_TOTAL + MAX_METADATA as u64 {
            return Err("文件超过导出容量上限".into());
        }
        hash.update(&buffer[..count]);
        crc = crc_update(crc, &buffer[..count]);
    }
    Ok(Entry {
        name: name.into(),
        path: path.into(),
        bytes,
        sha256: format!("{:x}", hash.finalize()),
        crc: !crc,
    })
}
const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ ((0u32.wrapping_sub(value & 1)) & 0xedb88320);
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();
fn crc_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc = (crc >> 8) ^ CRC_TABLE[((crc ^ *byte as u32) & 255) as usize];
    }
    crc
}
fn inspect(path: &Path, name: &str, hash: bool) -> Result<Entry> {
    if hash {
        return digest(path, name);
    }
    let file = open_plain(path)?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("输出项必须为普通文件".into());
    }
    Ok(Entry {
        name: name.into(),
        path: path.into(),
        bytes: metadata.len(),
        sha256: String::new(),
        crc: 0,
    })
}
fn scan(session: &mut Session, hash: bool) -> Result<BTreeMap<String, Entry>> {
    let mut result = BTreeMap::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    for item in fs::read_dir(&session.dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "文件名不是有效 Unicode")?;
        let metadata = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        if !plain(&metadata) {
            return Err("导出目录含符号链接或 junction".into());
        }
        if metadata.is_dir() {
            if !segment_valid(&name) {
                return Err("无效导出子目录".into());
            }
            guard_directory(&item.path(), &mut session._guards)?;
            for child in fs::read_dir(item.path()).map_err(|e| e.to_string())? {
                let child = child.map_err(|e| e.to_string())?;
                let child_name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| "文件名不是有效 Unicode")?;
                let name = format!("{name}/{child_name}");
                image_name(&name)?;
                let entry = inspect(&child.path(), &name, hash)?;
                if entry.bytes > MAX_IMAGE {
                    return Err("单张图片超过 128MiB".into());
                }
                if !names.insert(name.to_lowercase()) {
                    return Err("图片名称大小写冲突".into());
                }
                total += entry.bytes;
                result.insert(name, entry);
            }
        } else if ["report.html", "manifest.json", "export.zip"].contains(&name.as_str()) {
            let file = open_plain(&item.path())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("导出附件必须为普通文件".into());
            }
        } else {
            image_name(&name)?;
            let entry = inspect(&item.path(), &name, hash)?;
            if entry.bytes > MAX_IMAGE {
                return Err("单张图片超过 128MiB".into());
            }
            if !names.insert(name.to_lowercase()) {
                return Err("图片名称大小写冲突".into());
            }
            total += entry.bytes;
            result.insert(name, entry);
        }
        if total > MAX_TOTAL {
            return Err("图片总量超过 512MiB".into());
        }
        if result.len() > 3000 {
            return Err("图片数量超过 3000 张".into());
        }
    }
    Ok(result)
}
fn write_once(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = digest(path, "")?;
            let hash = format!("{:x}", Sha256::digest(bytes));
            if existing.bytes != bytes.len() as u64 || existing.sha256 != hash {
                return Err("文件已存在且内容不同；未覆盖已有文件".into());
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}
pub fn write(jobs: &AgentJobs, job_id: &str, name: &str, base64: &str) -> Result<Value> {
    let _lock = FILE_LOCK.lock().map_err(|_| "导出文件锁不可用")?;
    image_name(name)?;
    if base64.len() as u64 > MAX_IMAGE.div_ceil(3) * 4 {
        return Err("单张图片超过 128MiB".into());
    }
    let bytes = STANDARD.decode(base64).map_err(|_| "图片 Base64 无效")?;
    if bytes.len() as u64 > MAX_IMAGE {
        return Err("单张图片超过 128MiB".into());
    }
    let mut session = session(jobs, job_id)?;
    // 上传每张图片只扫描元数据计算容量，避免多图导出反复哈希整个目录。
    let entries = scan(&mut session, false)?;
    if entries
        .keys()
        .any(|existing| existing != name && existing.to_lowercase() == name.to_lowercase())
    {
        return Err("图片名称大小写冲突".into());
    }
    let path = target(&mut session, name, true)?;
    let old = entries.get(name).map(|e| e.bytes).unwrap_or(0);
    if entries.values().map(|e| e.bytes).sum::<u64>() - old + bytes.len() as u64 > MAX_TOTAL {
        return Err("图片总量超过 512MiB".into());
    }
    if !entries.contains_key(name) && entries.len() >= 3000 {
        return Err("图片数量超过 3000 张".into());
    }
    if session.dir.join("manifest.json").exists() && !entries.contains_key(name) {
        return Err("导出已经封存，不能添加新图片".into());
    }
    write_once(&path, &bytes)?;
    Ok(
        json!({"ok":true,"name":name,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))}),
    )
}
pub fn finish(
    jobs: &AgentJobs,
    job_id: &str,
    report_html: Option<&str>,
    manifest: &Value,
) -> Result<Value> {
    let _lock = FILE_LOCK.lock().map_err(|_| "导出文件锁不可用")?;
    let mut session = session(jobs, job_id)?;
    let images = scan(&mut session, true)?;
    let rows = manifest["files"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 3000)
        .ok_or("manifest.files 必须包含 1 至 3000 项")?;
    if !manifest.is_object() {
        return Err("manifest 必须为对象".into());
    }
    if manifest["revision"].as_u64().is_none() || !manifest["configs"].is_array() {
        return Err("manifest 必须包含非负整数 revision 和 configs 数组".into());
    }
    let mut names = HashSet::new();
    let mut files = vec![];
    for row in rows {
        let name = row["name"].as_str().ok_or("manifest 图片缺少 name")?;
        image_name(name)?;
        if !names.insert(name.to_owned()) {
            return Err("manifest 图片名称重复".into());
        }
        let entry = images.get(name).ok_or("manifest 包含尚未写入的图片")?;
        let mut value = entry.value();
        for key in ["configId", "layout"] {
            if let Some(metadata) = row.get(key) {
                if !metadata.is_string() {
                    return Err("manifest 图片 metadata 必须为字符串".into());
                }
                value[key] = metadata.clone();
            }
        }
        files.push(value);
    }
    if names.len() != images.len() {
        return Err("manifest 未包含所有已写入图片".into());
    }
    let mut document = manifest.clone();
    document["files"] = json!(files);
    document["jobId"] = json!(job_id);
    let manifest_bytes = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
    if manifest_bytes.len() > MAX_METADATA || report_html.is_some_and(|s| s.len() > MAX_METADATA) {
        return Err("报告或 manifest 超过 8MiB".into());
    }
    let metadata_size =
        manifest_bytes.len() as u64 + report_html.map(|s| s.len() as u64).unwrap_or(0);
    if images.values().map(|e| e.bytes).sum::<u64>() + metadata_size > MAX_TOTAL {
        return Err("图片和报告总量超过 512MiB".into());
    }
    let report_path = session.dir.join("report.html");
    if report_html.is_none() && report_path.exists() {
        return Err("已有报告与本次无报告请求不一致".into());
    }
    if let Some(html) = report_html {
        write_once(&report_path, html.as_bytes())?;
    }
    let manifest_path = session.dir.join("manifest.json");
    write_once(&manifest_path, &manifest_bytes)?;
    let mut zip_entries: Vec<_> = images.into_values().collect();
    if report_html.is_some() {
        zip_entries.push(digest(&report_path, "report.html")?);
    }
    zip_entries.push(digest(&manifest_path, "manifest.json")?);
    zip_entries.sort_by(|a, b| a.name.cmp(&b.name));
    let zip_path = session.dir.join("export.zip");
    write_zip(&zip_path, &zip_entries)?;
    Ok(
        json!({"ok":true,"directory":session.dir,"zipPath":zip_path,"reportPath":report_html.map(|_|report_path),"manifestPath":manifest_path,"files":files}),
    )
}

struct HashWriter {
    hash: Sha256,
    bytes: u64,
}
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.hash.update(bytes);
        self.bytes += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn write_zip(path: &Path, entries: &[Entry]) -> Result<()> {
    // 先流式生成预期摘要，旧 ZIP 只有字节数和 SHA 全部相同才允许幂等重试。
    let mut expected = HashWriter {
        hash: Sha256::new(),
        bytes: 0,
    };
    zip_stream(&mut expected, entries)?;
    let expected_hash = format!("{:x}", expected.hash.finalize());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1);
    }
    match options.open(path) {
        Ok(mut file) => {
            zip_stream(&mut file, entries)?;
            file.sync_all().map_err(|e| e.to_string())?;
            let actual = digest(path, "")?;
            if actual.bytes != expected.bytes || actual.sha256 != expected_hash {
                return Err("ZIP 写入校验失败，已保留文件".into());
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let actual = digest(path, "")?;
            if actual.bytes != expected.bytes || actual.sha256 != expected_hash {
                Err("ZIP 已存在且内容不同；未覆盖".into())
            } else {
                Ok(())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}
fn zip_stream(writer: &mut impl Write, entries: &[Entry]) -> Result<()> {
    let mut central = Vec::new();
    let mut position = 0u32;
    for entry in entries {
        let name = entry.name.as_bytes();
        let size = u32::try_from(entry.bytes).map_err(|_| "ZIP 文件过大")?;
        let mut header = vec![];
        put32(&mut header, 0x04034b50);
        put16(&mut header, 20);
        put16(&mut header, 0x800);
        put16(&mut header, 0);
        put16(&mut header, 0);
        put16(&mut header, 33);
        put32(&mut header, entry.crc);
        put32(&mut header, size);
        put32(&mut header, size);
        put16(&mut header, name.len() as u16);
        put16(&mut header, 0);
        header.extend_from_slice(name);
        writer.write_all(&header).map_err(|e| e.to_string())?;
        let mut input = open_plain(&entry.path)?;
        let mut copied = 0u64;
        let mut crc = !0u32;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            copied += count as u64;
            if copied > entry.bytes {
                return Err("ZIP 生成期间源文件变更".into());
            }
            crc = crc_update(crc, &buffer[..count]);
            hash.update(&buffer[..count]);
            writer
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        if copied != entry.bytes
            || !crc != entry.crc
            || format!("{:x}", hash.finalize()) != entry.sha256
        {
            return Err("ZIP 生成期间源文件变更".into());
        }
        put32(&mut central, 0x02014b50);
        put16(&mut central, 20);
        put16(&mut central, 20);
        put16(&mut central, 0x800);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 33);
        put32(&mut central, entry.crc);
        put32(&mut central, size);
        put32(&mut central, size);
        put16(&mut central, name.len() as u16);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, 0);
        put32(&mut central, position);
        central.extend_from_slice(name);
        position = position
            .checked_add(header.len() as u32)
            .and_then(|v| v.checked_add(size))
            .ok_or("ZIP 大小溢出")?;
    }
    writer.write_all(&central).map_err(|e| e.to_string())?;
    let mut end = vec![];
    put32(&mut end, 0x06054b50);
    put16(&mut end, 0);
    put16(&mut end, 0);
    put16(&mut end, entries.len() as u16);
    put16(&mut end, entries.len() as u16);
    put32(&mut end, central.len() as u32);
    put32(&mut end, position);
    put16(&mut end, 0);
    writer.write_all(&end).map_err(|e| e.to_string())
}
fn put16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn put32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
#[cfg(test)]
#[path = "agent_files/tests.rs"]
mod tests;
