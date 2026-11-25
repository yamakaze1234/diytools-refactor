// 使用合成签名验证真实解压和原子提交路径，不连接发布站点或 ERP。
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use std::io::Cursor;
use zip::{ZipWriter, write::SimpleFileOptions};

fn members() -> Vec<(&'static str, &'static [u8])> {
    vec![
        ("erp-worker.exe", b"offline-worker"),
        ("erp-adapter.py", b"# offline"),
        ("erp-matching-adapter.py", b"# offline match"),
        ("erp.domain", b"https://fixture.invalid/"),
    ]
}

fn package(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for &(name, bytes) in files {
        out.start_file(name, SimpleFileOptions::default()).unwrap();
        out.write_all(bytes).unwrap();
    }
    out.finish().unwrap().into_inner()
}
fn fixture(
    version: &str,
    bytes: &[u8],
    change: impl FnOnce(&mut Value),
) -> (Envelope, VerifyingKey) {
    let info =
        |data: &[u8]| json!({"size":data.len(),"sha256":format!("{:x}",Sha256::digest(data))});
    let files: serde_json::Map<_, _> = members()
        .into_iter()
        .map(|(name, b)| (name.into(), info(b)))
        .collect();
    let name = artifact_name(version);
    let mut a = info(bytes);
    a["name"] = json!(name);
    a["urls"] = json!([format!(
        "https://{}/{}/releases/download/{TAG}/{name}",
        gitea::HOST,
        gitea::REPO
    )]);
    let mut doc = json!({"schema":1,"appId":"io.diytools.erp-runtime","channel":TAG,"platform":"windows-x86_64","version":version,"artifact":a,"files":files});
    change(&mut doc);
    let sk = SigningKey::from_bytes(&[37; 32]);
    let payload = serde_json::to_vec(&doc).unwrap();
    (
        Envelope {
            payload: STANDARD.encode(&payload),
            signature: STANDARD.encode(sk.sign(&payload).to_bytes()),
        },
        sk.verifying_key(),
    )
}

#[test]
fn rejects_bad_signature_wrong_channel_and_untrusted_source() {
    let (mut envelope, key) = fixture("1.0.0", b"zip", |_| ());
    assert!(verify(&envelope, &key).is_ok());
    envelope.payload = STANDARD.encode(b"{}");
    assert!(verify(&envelope, &key).is_err());
    for field in ["appId", "channel", "platform", "version"] {
        let (envelope, key) = fixture("1.0.0", b"zip", |v| v[field] = json!("other"));
        assert!(verify(&envelope, &key).is_err());
    }
    let (envelope, key) = fixture("1.0.0", b"zip", |v| {
        v["artifact"]["urls"] = json!(["https://example.invalid/runtime.zip"])
    });
    assert!(verify(&envelope, &key).is_err());
}

#[test]
fn rejects_traversal_non_members_changed_content_and_truncated_download() {
    let dir = TempDir::new().unwrap();
    for name in [
        "../escape.py",
        "dir/erp-adapter.py",
        "C:/extra",
        "ERP-ADAPTER.PY",
        "erp-adapter.py:ads",
    ] {
        let mut files = members();
        files[1].0 = name;
        let bytes = package(&files);
        let (envelope, key) = fixture("1.0.0", &bytes, |_| ());
        let c = verify(&envelope, &key).unwrap();
        assert!(activate(dir.path(), &envelope, &c, Cursor::new(bytes)).is_err());
        assert!(!dir.path().join("integrations.json").exists());
    }
    let mut files = members();
    files[0].1 = b"altered-worker";
    let bytes = package(&files);
    let (e, k) = fixture("1.0.0", &bytes, |_| ());
    let c = verify(&e, &k).unwrap();
    assert!(activate(dir.path(), &e, &c, Cursor::new(&bytes)).is_err());
    let mut sink = NamedTempFile::new().unwrap();
    assert!(
        stream_artifact(
            &bytes[..bytes.len() - 1],
            sink.as_file_mut(),
            &c.artifact,
            |_| ()
        )
        .is_err()
    );
}

#[test]
fn commits_a_verified_generation_preserves_connection_fields_and_repairs_tampering() {
    let data = TempDir::new().unwrap();
    let bytes = package(&members());
    let (e, k) = fixture("1.0.0", &bytes, |_| ());
    let c = verify(&e, &k).unwrap();
    fs::write(
        data.path().join("integrations.json"),
        br#"{"version":1,"erp":{"other":true},"unrelated":{"config":123}}"#,
    )
    .unwrap();
    let vault = data.path().join("sql-credentials.dpapi.json");
    fs::write(&vault, b"protected").unwrap();
    let before = local(data.path(), &k).unwrap();
    assert_eq!(
        report(&before, Ok(verify(&e, &k).unwrap())).unwrap().status,
        "missing"
    );
    activate(data.path(), &e, &c, Cursor::new(&bytes)).unwrap();
    let configuration = config(data.path()).unwrap();
    assert_eq!(configuration["erp"]["other"], true);
    assert_eq!(configuration["unrelated"]["config"], 123);
    assert_eq!(fs::read(vault).unwrap(), b"protected");
    let l = local(data.path(), &k).unwrap();
    assert!(l.has_local && l.intact);
    assert_eq!(
        report(&l, Ok(verify(&e, &k).unwrap())).unwrap().status,
        "ready"
    );
    let (older, key) = fixture("0.9.0", &bytes, |_| ());
    assert!(report(&l, Ok(verify(&older, &key).unwrap())).is_err());
    let dir = selection(data.path(), &configuration).unwrap().0;
    fs::write(dir.join("erp-adapter.py"), b"changed").unwrap();
    let damaged = local(data.path(), &k).unwrap();
    assert_eq!(
        report(&damaged, Ok(verify(&e, &k).unwrap()))
            .unwrap()
            .status,
        "outdated"
    );
    activate(data.path(), &e, &c, Cursor::new(&bytes)).unwrap();
    assert!(local(data.path(), &k).unwrap().intact);
}

#[test]
fn idle_check_holds_the_interprocess_lock_and_releases_it_for_next_operation() {
    let dir = TempDir::new().unwrap();
    let state = ErpSessionState::default();
    state
        .configure_vault(dir.path().join("sql-credentials.dpapi.json"))
        .unwrap();
    let other = operation_lock(dir.path()).unwrap();
    assert!(tauri::async_runtime::block_on(state.when_idle(true, |_| Ok(()))).is_err());
    drop(other);
    tauri::async_runtime::block_on(state.when_idle(false, |data| {
        assert!(operation_lock(data).is_err());
        Ok(())
    }))
    .unwrap();
    assert!(operation_lock(dir.path()).is_ok());
}

#[test]
fn installer_accepts_the_locally_provided_release_candidate() {
    // 可选真实签名候选验收：全部安装验证在临时目录完成，不修改用户安装。
    let Some(dir) = std::env::var_os("DIYTOOLS_TEST_ERP_CANDIDATE").map(PathBuf::from) else {
        return;
    };
    let e = read_record(&dir.join(MANIFEST_NAME)).unwrap();
    let key = public_key().unwrap();
    let c = verify(&e, &key).unwrap();
    let source = fs::File::open(dir.join(&c.artifact.name)).unwrap();
    let mut temp = NamedTempFile::new().unwrap();
    stream_artifact(source, temp.as_file_mut(), &c.artifact, |_| ()).unwrap();
    let install = TempDir::new().unwrap();
    activate(install.path(), &e, &c, temp.reopen().unwrap()).unwrap();
    let local = local(install.path(), &key).unwrap();
    assert_eq!(report(&local, Ok(c)).unwrap().status, "ready");
    // 在同一原生进程内从新目录拉起冻结 worker，确认状态和断开请求均可处理。
    let state = ErpSessionState::default();
    state
        .configure_vault(install.path().join("sql-credentials.dpapi.json"))
        .unwrap();
    let environment = tauri::async_runtime::block_on(
        crate::erp_environment::check_erp_environment_at(install.path()),
    )
    .unwrap();
    assert_eq!(environment.erp_package.status, "ready");
    assert!(!environment.erp_connected);
    let status = tauri::async_runtime::block_on(state.offline_probe()).unwrap();
    assert_eq!(status["status"]["connected"], false);
    assert_eq!(status["disconnected"]["connected"], false);
    assert!(
        active_directory(install.path())
            .unwrap()
            .join("erp-worker.exe")
            .is_file()
    );
}
