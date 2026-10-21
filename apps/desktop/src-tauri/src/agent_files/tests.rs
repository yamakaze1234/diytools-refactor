use super::*;
use crate::workbench_store::WorkbenchStore;
fn fixture() -> (PathBuf, AgentJobs, String) {
    let folder = std::env::temp_dir().join(format!("diy-agent-files-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&folder).unwrap();
    let store = WorkbenchStore {
        path: folder.join("synthetic.sqlite"),
        assets: folder.join("assets"),
    };
    let jobs = AgentJobs::new(folder.join("runtime"), store).unwrap();
    jobs.ready().unwrap();
    let job=jobs.dispatch("export.start",&json!({"operationId":Uuid::new_v4().to_string(),"images":"both","report":true,"outputDir":folder})).unwrap();
    jobs.claim().unwrap();
    (folder, jobs, job["jobId"].as_str().unwrap().into())
}
fn manifest() -> Value {
    json!({"revision":7,"configs":[{"id":"config"}],"files":[{"name":"long/测试.png","configId":"config","layout":"long","bytes":999,"sha256":"untrusted"}]})
}
#[test]
fn real_files_manifest_zip_crc_and_retry_are_verified() {
    let (_, jobs, id) = fixture();
    let bytes = b"synthetic image bytes";
    let encoded = STANDARD.encode(bytes);
    let written = write(&jobs, &id, "long/测试.png", &encoded).unwrap();
    assert_eq!(written["bytes"], bytes.len());
    assert_eq!(
        write(&jobs, &id, "long/测试.png", &encoded).unwrap(),
        written
    );
    assert!(write(&jobs, &id, "long/测试.png", &STANDARD.encode(b"different")).is_err());
    let result = finish(
        &jobs,
        &id,
        Some("<!doctype html><meta charset=utf-8>报告"),
        &manifest(),
    )
    .unwrap();
    let document: Value =
        serde_json::from_slice(&fs::read(result["manifestPath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(document["files"][0]["bytes"], bytes.len());
    assert_ne!(document["files"][0]["sha256"], "untrusted");
    let archive = fs::read(result["zipPath"].as_str().unwrap()).unwrap();
    let entries = read_zip(&archive);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries["long/测试.png"], bytes);
    assert!(entries.contains_key("manifest.json"));
    assert!(entries.contains_key("report.html"));
    assert_eq!(
        finish(
            &jobs,
            &id,
            Some("<!doctype html><meta charset=utf-8>报告"),
            &manifest()
        )
        .unwrap(),
        result
    );
    assert!(write(&jobs, &id, "new.png", &encoded).is_err());
    assert!(finish(&jobs, &id, Some("changed report"), &manifest()).is_err());
    assert_eq!(
        fs::read(result["zipPath"].as_str().unwrap()).unwrap(),
        archive
    );
}
fn read16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn read32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn independent_crc(bytes: &[u8]) -> u32 {
    // 测试使用独立逐位实现，不复用生产 CRC，防止同一个编码错误互相掩盖。
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            if crc & 1 == 1 {
                crc = (crc >> 1) ^ 0xedb88320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}
fn read_zip(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let end = bytes.len() - 22;
    assert_eq!(read32(bytes, end), 0x06054b50);
    let central_start = read32(bytes, end + 16) as usize;
    let mut cursor = central_start;
    let mut files = BTreeMap::new();
    for _ in 0..read16(bytes, end + 10) {
        assert_eq!(read32(bytes, cursor), 0x02014b50);
        assert_eq!(read16(bytes, cursor + 10), 0);
        assert_eq!(read16(bytes, cursor + 8), 0x800);
        let size = read32(bytes, cursor + 24) as usize;
        let crc = read32(bytes, cursor + 16);
        let name_size = read16(bytes, cursor + 28) as usize;
        let name = std::str::from_utf8(&bytes[cursor + 46..cursor + 46 + name_size])
            .unwrap()
            .to_owned();
        let local = read32(bytes, cursor + 42) as usize;
        assert_eq!(read32(bytes, local), 0x04034b50);
        assert_eq!(read32(bytes, local + 14), crc);
        let start = local + 30 + read16(bytes, local + 26) as usize;
        let body = &bytes[start..start + size];
        assert_eq!(independent_crc(body), crc);
        files.insert(name, body.to_vec());
        cursor += 46 + name_size;
    }
    assert_eq!(cursor, end);
    assert_eq!(end - central_start, read32(bytes, end + 12) as usize);
    files
}
#[test]
fn rejects_traversal_reserved_names_and_unclaimed_jobs() {
    let (folder, jobs, id) = fixture();
    for name in [
        "../x.png",
        "a/../x.png",
        "a\\x.png",
        "C:x.png",
        "x.png:stream",
        "a/b/c.png",
        "CON.png",
        "COM1.jpg",
        "x./a.png",
        "LPT¹.png",
        "a//x.png",
        "/x.png",
        "x.txt",
    ] {
        assert!(write(&jobs, &id, name, "eA==").is_err(), "{name}");
    }
    let store = WorkbenchStore {
        path: folder.join("none.sqlite"),
        assets: folder.join("none"),
    };
    let fresh = AgentJobs::new(folder.join("other"), store).unwrap();
    assert!(write(&fresh, &id, "x.png", "eA==").is_err());
    jobs.complete(&id, Some(json!({"ok":true})), None).unwrap();
    assert!(write(&jobs, &id, "x.png", "eA==").is_err());
}
#[test]
fn manifest_mismatch_zip_collision_and_unknown_files_never_overwrite() {
    let (_, jobs, id) = fixture();
    write(&jobs, &id, "long/测试.png", "eA==").unwrap();
    let mut missing = manifest();
    missing["files"][0]["name"] = json!("missing.png");
    assert!(finish(&jobs, &id, None, &missing).is_err());
    let params = jobs.export_params(&id).unwrap();
    let dir =
        PathBuf::from(params["outputDir"].as_str().unwrap()).join(format!("diytools-agent-{id}"));
    fs::write(dir.join("export.zip"), b"existing zip").unwrap();
    assert!(finish(&jobs, &id, None, &manifest()).is_err());
    assert_eq!(fs::read(dir.join("export.zip")).unwrap(), b"existing zip");
    fs::write(dir.join("unrelated.txt"), b"existing user file").unwrap();
    assert!(write(&jobs, &id, "more.png", "eA==").is_err());
    assert_eq!(
        fs::read(dir.join("unrelated.txt")).unwrap(),
        b"existing user file"
    );
}
#[cfg(windows)]
#[test]
fn junction_ancestor_is_rejected_without_writing_target() {
    use std::os::windows::process::CommandExt;
    let (folder, jobs, id) = fixture();
    let target_dir = folder.join("junction-target");
    fs::create_dir(&target_dir).unwrap();
    let generated = folder.join(format!("diytools-agent-{id}"));
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&generated)
        .arg(&target_dir)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(write(&jobs, &id, "x.png", "eA==").is_err());
    assert!(fs::read_dir(&target_dir).unwrap().next().is_none());
}
#[test]
fn crc_known_vector_and_image_size_preflight() {
    assert_eq!(!crc_update(!0, b"123456789"), 0xcbf43926);
    assert!(image_name("a/normal.webp").is_ok());
    let (_, jobs, id) = fixture();
    let invalid = STANDARD.encode([0u8; 3]);
    assert!(write(&jobs, &id, "bad.png", &format!("{invalid}!")).is_err());
}
