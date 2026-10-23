// 原图按完整内容摘要保存；兼容旧上传命名时保留原文件，确保历史恢复仍能读取。
use super::*;
use std::io::Read;

// 所有祖先都必须是普通目录；不允许 junction/symlink 把原图读写引向目录外。
fn ordinary(path: &Path) -> Result<()> {
    for (index, item) in path.ancestors().enumerate() {
        if item.as_os_str().is_empty() { continue; }
        match fs::symlink_metadata(item) {
            Ok(meta) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if meta.file_type().is_symlink() || reparse || (index > 0 && !meta.is_dir()) {
                    return Err("原图路径包含链接、重解析点或非目录，已停止处理".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("无法检查原图路径：{e}")),
        }
    }
    Ok(())
}

fn extension(raw: &[u8]) -> Result<&'static str> {
    if raw.len() > MAX_UPLOAD_BYTES { return Err("原图超过 24 MiB 上限".into()); }
    if raw.starts_with(b"\x89PNG\r\n\x1a\n") { Ok("png") }
    else if raw.starts_with(b"\xff\xd8\xff") { Ok("jpg") }
    else { Err("原图内容不是 PNG 或 JPG".into()) }
}

// 有界读取避免损坏或异常大文件占满内存，文件类型检查在读取前完成。
fn read(path: &Path) -> Result<Vec<u8>> {
    ordinary(path)?;
    let file = fs::File::open(path).map_err(|e| format!("无法读取原图 {}：{e}", path.file_name().unwrap_or_default().to_string_lossy()))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_UPLOAD_BYTES as u64 { return Err("原图不是普通文件或超过大小上限".into()); }
    let mut raw = Vec::new();
    file.take(MAX_UPLOAD_BYTES as u64 + 1).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    extension(&raw)?;
    Ok(raw)
}

// 只接受已知的旧上传格式，拒绝斜杠、路径穿越、额外后缀以及任意手写文件名。
fn legacy(url: &str) -> Option<(&str, &str)> {
    let name = url.strip_prefix("/uploads/")?;
    let (stem, ext) = name.rsplit_once('.')?;
    if !matches!(ext, "png" | "jpg") { return None; }
    let mut parts = stem.split('-');
    for _ in 0..2 {
        let digits = parts.next()?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) { return None; }
    }
    let short = parts.next()?;
    if parts.next().is_some() || short.len() != 16 || !short.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return None; }
    Some((short, ext))
}

// Win32 扩展路径不再处理 ../ 或相对路径，先按 Windows 规则展开，再补长路径前缀。
// std::fs 已做类似转换；直接调用 MoveFileW 时须自行处理，保留 UNC 和现有扩展路径。
#[cfg(windows)]
fn windows_move_path(path: &Path) -> std::io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "原图路径不是有效的 Windows 文件路径");
    if path.as_os_str().encode_wide().any(|unit| unit == 0) { return Err(invalid()); }
    let absolute = std::path::absolute(path)?;
    let units: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    let Component::Prefix(prefix) = absolute.components().next().ok_or_else(invalid)? else { return Err(invalid()); };
    let mut result = match prefix.kind() {
        Prefix::Disk(_) => r"\\?\".encode_utf16().chain(units).collect::<Vec<_>>(),
        Prefix::UNC(_, _) => r"\\?\UNC\".encode_utf16().chain(units.into_iter().skip(2)).collect(),
        Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _) => units,
        _ => return Err(invalid()),
    };
    result.push(0);
    Ok(result)
}

// Windows 的 MoveFileW 原子安装且拒绝覆盖目标，也兼容不支持硬链接的可移动磁盘。
pub(super) fn install(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" { fn MoveFileW(existing: *const u16, new: *const u16) -> i32; }
        let source = windows_move_path(source)?;
        let target = windows_move_path(target)?;
        // 两个路径均为受控目录内生成的名称，缓冲区以 NUL 结尾并在调用期间存活。
        if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } == 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    #[cfg(not(windows))]
    { fs::hard_link(source, target) }
}

pub(super) fn save(store: &WorkbenchStore, raw: &[u8]) -> Result<String> {
    let ext = extension(raw)?;
    let name = format!("{:x}.{ext}", Sha256::digest(raw));
    let folder = store.assets.join("uploads");
    let target = folder.join(&name);
    ordinary(&target)?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    ordinary(&target)?;
    if target.exists() {
        if read(&target)? != raw { return Err("同名原图校验失败，已保留原文件".into()); }
        return Ok(format!("/uploads/{name}"));
    }
    // 暂存完整文件后原子发布；目标存在时不覆盖，避免并发上传留下半张原图。
    let stage = folder.join(format!(".upload-{}.partial", unique()));
    write_new(&stage, raw)?;
    ordinary(&target)?;
    let published = install(&stage, &target);
    // 此文件是本次上传独有的暂存文件，不涉及任何用户原图或历史文件。
    let _ = fs::remove_file(&stage);
    if let Err(error) = published {
        if !target.exists() { return Err(format!("原图写入失败：{error}")); }
    }
    if read(&target)? != raw { return Err("同名原图校验失败，已保留原文件".into()); }
    Ok(format!("/uploads/{name}"))
}

fn replace(value: &mut Value, replacements: &HashMap<String, String>) -> usize {
    match value {
        Value::String(url) => {
            if let Some(target) = replacements.get(url) { *url = target.clone(); 1 } else { 0 }
        }
        Value::Array(values) => values.iter_mut().map(|v| replace(v, replacements)).sum(),
        Value::Object(fields) => fields.values_mut().map(|v| replace(v, replacements)).sum(),
        _ => 0,
    }
}

fn candidates(c: &Connection) -> Result<Vec<String>> {
    let mut stmt = c.prepare("SELECT DISTINCT value FROM workbench_state,json_tree(workbench_state.document) WHERE json_tree.type='text' AND value LIKE '/uploads/%'").map_err(|e| e.to_string())?;
    let urls = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(urls.into_iter().filter(|url| legacy(url).is_some()).collect())
}

pub(super) fn normalize(store: &WorkbenchStore) -> Result<Value> {
    let mut c = db(&store.path)?;
    // 正常同步仅作只读检查，不占写锁；确需转换时在写事务内重读，避免覆盖并发编辑。
    if candidates(&c)?.is_empty() { return Ok(json!({"files":0,"references":0})); }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let mut replacements = HashMap::new();
    for url in candidates(&tx)? {
        if let Some((short, ext)) = legacy(&url) {
            let raw = read(&store.assets.join("uploads").join(url.strip_prefix("/uploads/").unwrap()))?;
            if extension(&raw)? != ext || !format!("{:x}", Sha256::digest(&raw)).starts_with(short) {
                return Err(format!("旧原图内容校验失败：{}", url.strip_prefix("/uploads/").unwrap()));
            }
            replacements.insert(url, save(store, &raw)?);
        }
    }
    if replacements.is_empty() { return Ok(json!({"files":0,"references":0})); }
    let before = state(&tx)?;
    let mut after = before.clone();
    let count = replace(&mut after, &replacements);
    // 正文、历史、活动记录同事务；云检查点与已分配 mutation ID 的 outbox 完全不改写。
    persist(&tx, &before, &mut after, &json!({"message":"兼容旧原图同步路径"}))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"files":replacements.len(),"references":count,"revision":revision(&after)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_move_path_preserves_unc_and_resolves_relative_before_prefixing() {
        let decoded = |path: &Path| {
            let units = windows_move_path(path).unwrap();
            assert_eq!(units.last(), Some(&0));
            String::from_utf16(&units[..units.len()-1]).unwrap()
        };
        assert_eq!(decoded(Path::new(r"\\server\share\folder\..\image.png")), r"\\?\UNC\server\share\image.png");
        assert_eq!(decoded(Path::new(r"\\?\UNC\server\share\image.png")), r"\\?\UNC\server\share\image.png");
        assert_eq!(decoded(Path::new(r"\\?\C:\folder\image.png")), r"\\?\C:\folder\image.png");
        let expected = std::path::absolute("image.png").unwrap();
        assert_eq!(decoded(Path::new(r"folder\..\image.png")), format!(r"\\?\{}", expected.display()));
        assert_eq!(windows_move_path(Path::new("image\0.png")).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    }

    #[cfg(windows)]
    #[test]
    fn upload_install_long_paths_is_atomic_and_never_replaces_existing_target() {
        use std::os::windows::ffi::OsStrExt;
        // Keep ../ in the input, matching builds from a deeply nested release checkout.
        let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/upload-long-path-regression").join(unique());
        while root.as_os_str().encode_wide().count() < 340 { root = root.join("long-directory-segment-for-original-image-migration"); }
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.partial");
        let target = root.join("published.png");
        ordinary(&source).unwrap();ordinary(&target).unwrap();
        fs::write(&source, b"complete-original-image").unwrap();
        install(&source, &target).unwrap();
        assert!(!source.exists());assert_eq!(fs::read(&target).unwrap(), b"complete-original-image");
        fs::write(&source, b"must-not-overwrite").unwrap();
        assert!(install(&source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"complete-original-image");
        assert_eq!(fs::read(&source).unwrap(), b"must-not-overwrite");
    }

    fn fixture() -> (WorkbenchStore, String, Vec<u8>) {
        let root = std::env::temp_dir().join(format!("diy-upload-path-{}", unique()));
        fs::create_dir_all(&root).unwrap();
        let raw = b"\x89PNG\r\n\x1a\nfixture-original".to_vec();
        let url = format!("/uploads/12-345-{}.png", &format!("{:x}", Sha256::digest(&raw))[..16]);
        let source = root.join("source.json");
        fs::write(&source, json!({"revision":7,"configs":[{"id":"c1","name":"保持名称","price":123,"caseImage":url,"extra":[url]}],"caseGallery":[{"url":url}],"unknown":{"number":"999999999999999999"},"templates":[],"logs":[]}).to_string()).unwrap();
        let store = initialize(&root.join("workbench.sqlite"), &source, &root.join("assets")).unwrap();
        fs::create_dir_all(store.assets.join("uploads")).unwrap();
        fs::write(store.assets.join(&url[1..]), &raw).unwrap();
        (store, url, raw)
    }

    #[test]
    fn upload_deduplicates_png_and_jpg_with_full_hash() {
        let (store, _, raw) = fixture();
        let first = save_image(&store, "/api/upload", &json!({"base64":STANDARD.encode(&raw)})).unwrap();
        let first: Value = serde_json::from_str(&first.body).unwrap();
        let url = first["url"].as_str().unwrap();
        assert_eq!(url, format!("/uploads/{:x}.png", Sha256::digest(&raw)));
        assert_eq!(save(&store, &raw).unwrap(), url);
        let jpg = b"\xff\xd8\xffjpeg";
        assert_eq!(save(&store, jpg).unwrap(), format!("/uploads/{:x}.jpg", Sha256::digest(jpg)));
        fs::write(store.assets.join(&url[1..]), b"broken").unwrap();
        assert!(save(&store, &raw).is_err());
    }

    #[test]
    fn repair_only_references_is_idempotent_and_preserves_cloud_and_history_sources() {
        let (store, old, raw) = fixture();
        let c = db(&store.path).unwrap();
        cloud_state::load(&store).unwrap();
        let cloud = "{\"outbox\":{\"mutationId\":\"immutable\",\"payload\":{\"after\":\"unchanged\"}}}";
        c.execute("INSERT INTO workbench_cloud_state VALUES(1,9,?1)", [cloud]).unwrap();
        let cloud:String=c.query_row("SELECT document FROM workbench_cloud_state",[],|r|r.get(0)).unwrap();
        let before = state(&c).unwrap();
        let result = normalize(&store).unwrap();
        assert_eq!(result["references"], 3);
        let canonical = format!("/uploads/{:x}.png", Sha256::digest(&raw));
        let mut expected = before.clone();
        replace(&mut expected, &HashMap::from([(old.clone(), canonical.clone())]));
        let after = state(&c).unwrap();
        expected["revision"] = json!(8);
        expected["updatedAt"] = after["updatedAt"].clone();
        assert_eq!(after, expected);
        assert_eq!(c.query_row("SELECT document FROM workbench_cloud_state", [], |r| r.get::<_,String>(0)).unwrap(), cloud);
        assert_eq!(read(&store.assets.join(&old[1..])).unwrap(), raw);
        assert_eq!(read(&store.assets.join(&canonical[1..])).unwrap(), raw);
        assert_eq!(normalize(&store).unwrap()["references"], 0);
        assert_eq!(state(&c).unwrap(), after);
        assert_eq!(c.query_row("SELECT count(*) FROM workbench_history", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
        // 模拟历史恢复旧引用后再次规范化，旧原图仍在，转换可重复完成。
        entities::replace_fixture(&c, &before);
        assert_eq!(normalize(&store).unwrap()["references"], 3);
    }

    #[test]
    fn corrupt_or_missing_legacy_file_rolls_back_database() {
        let (store, old, _) = fixture();
        let c = db(&store.path).unwrap();
        let before = state(&c).unwrap();
        fs::rename(store.assets.join(&old[1..]), store.assets.join("original-preserved.png")).unwrap();
        assert!(normalize(&store).is_err());
        assert_eq!(state(&c).unwrap(), before);
        fs::write(store.assets.join(&old[1..]), b"\x89PNG\r\n\x1a\nwrong-hash").unwrap();
        assert!(normalize(&store).is_err());
        assert_eq!(state(&c).unwrap(), before);
        assert_eq!(c.query_row("SELECT count(*) FROM workbench_history", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
    }

    #[test]
    fn legacy_parser_rejects_traversal_and_unknown_names() {
        for path in ["/uploads/../12-345-1234567890abcdef.png", "/uploads/12-345-1234567890ABCDEF.png", "/uploads/a-b-1234567890abcdef.png", "/uploads/12-345-1234567890abcdef.png/child", "/uploads/12-345-1234567890abcdef.png.exe", "/uploads/12-345-1234567890abcdef\\.png"] {
            assert!(legacy(path).is_none(), "{path}");
        }
        assert!(legacy("/uploads/12-345-1234567890abcdef.png").is_some());
    }

    #[test]
    fn later_invalid_file_does_not_commit_earlier_valid_reference() {
        let (store, _, _) = fixture();
        let c = db(&store.path).unwrap();
        let mut before = state(&c).unwrap();
        before["missing"] = json!("/uploads/12-999-0123456789abcdef.png");
        entities::replace_fixture(&c, &before);
        assert!(normalize(&store).is_err());
        assert_eq!(state(&c).unwrap(), before);
    }

    #[test]
    fn canonical_references_do_not_wait_for_another_writer() {
        let (store, _, _) = fixture();
        normalize(&store).unwrap();
        let c = db(&store.path).unwrap();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        let started = std::time::Instant::now();
        assert_eq!(normalize(&store).unwrap()["references"], 0);
        assert!(started.elapsed() < Duration::from_secs(2));
        c.execute_batch("ROLLBACK").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn junction_upload_directory_is_rejected_without_reading_or_writing_target() {
        use std::os::windows::process::CommandExt;
        let (mut store, _, raw) = fixture();
        let external = store.assets.join("uploads");
        let alternate = store.assets.join("alternate");
        fs::create_dir(&alternate).unwrap();
        let junction = alternate.join("uploads");
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"]).arg(&junction).arg(&external)
            .creation_flags(0x08000000).output().unwrap();
        assert!(status.status.success(), "junction fixture creation failed");
        let count = fs::read_dir(&external).unwrap().count();
        store.assets = alternate;
        assert!(save(&store, &raw).is_err());
        assert!(normalize(&store).is_err());
        assert_eq!(fs::read_dir(&external).unwrap().count(), count);
    }

    #[test]
    #[ignore = "Only runs against an explicitly selected sandbox copy; never a live database"]
    fn repair_isolated_database_copy() {
        let path = PathBuf::from(std::env::var("DIY_UPLOAD_REPAIR_COPY").expect("sandbox copy path required"));
        let canonical = fs::canonicalize(&path).unwrap();
        assert!(canonical.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("sandbox")), "must be a sandbox database copy");
        ordinary(&path).unwrap();
        let store = WorkbenchStore { assets: path.parent().unwrap().join("workbench-assets"), path };
        let c = db(&store.path).unwrap();
        let before = state(&c).unwrap();
        let cloud_before: String = c.query_row("SELECT document FROM workbench_cloud_state WHERE id=1", [], |r| r.get(0)).unwrap();
        let expected_map: HashMap<String, String> = candidates(&c).unwrap().into_iter().map(|url| {
            let raw = read(&store.assets.join(&url[1..])).unwrap();
            let canonical = format!("/uploads/{:x}.{}", Sha256::digest(&raw), extension(&raw).unwrap());
            (url, canonical)
        }).collect();
        let result = normalize(&store).unwrap();
        let after = state(&c).unwrap();
        let mut expected = before.clone();
        let expected_count = replace(&mut expected, &expected_map);
        if expected_count > 0 {
            expected["revision"] = json!(revision(&before) + 1);
            expected["updatedAt"] = after["updatedAt"].clone();
        }
        assert_eq!(after, expected, "all fields except known references/revision/timestamp must remain equal");
        assert_eq!(result["references"], json!(expected_count));
        assert_eq!(c.query_row("SELECT document FROM workbench_cloud_state WHERE id=1", [], |r| r.get::<_, String>(0)).unwrap(), cloud_before);
        for old in expected_map.keys() { assert!(store.assets.join(&old[1..]).is_file()); }
        assert_eq!(normalize(&store).unwrap()["references"], 0);
        fs::write(store.path.parent().unwrap().join("upload-repair-report.json"), serde_json::to_string_pretty(&result).unwrap()).unwrap();
        println!("{result}");
    }
}
