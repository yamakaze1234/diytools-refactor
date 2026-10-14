// 更新器隔离测试：使用测试签名和临时目录验证防篡改、路径边界、替换失败回滚及业务文件保留。
use super::*;
use ed25519_dalek::{Signer, SigningKey};

fn signed(
    mut change: impl FnMut(&mut serde_json::Value),
    binary: &[u8],
) -> (Envelope, VerifyingKey) {
    let key = SigningKey::from_bytes(&[29; 32]);
    let mut version = Version::parse(CURRENT).unwrap();
    version.patch += 1;
    let version = version.to_string();
    let name = format!("diytools-refactor-{version}-windows-x86_64.exe");
    let mut value = serde_json::json!({
        "schema":1,"appId":"io.diytools.refactor","channel":"refactor","platform":"windows-x86_64",
        "version":version,"publishedAt":"2026-10-12T01:00:00Z","notes":"更新说明",
        "artifact":{"name":name,"size":binary.len(),"sha256":format!("{:x}",Sha256::digest(binary)),
        "urls":[format!("https://github.com/yamakaze1234/diytools-refactor/releases/download/refactor-v{version}/{name}")]}
    });
    change(&mut value);
    let bytes = serde_json::to_vec(&value).unwrap();
    (
        Envelope {
            signature: STANDARD.encode(key.sign(&bytes).to_bytes()),
            payload: STANDARD.encode(bytes),
        },
        key.verifying_key(),
    )
}
pub(super) fn fixture() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/github-release-20261014/updater-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn signature_is_over_exact_payload_and_rejects_tampering() {
    let (mut envelope, key) = signed(|_| {}, b"new-executable");
    assert!(verify_envelope(&envelope, &key, "0.1.0").is_ok());
    let mut bytes = STANDARD.decode(&envelope.payload).unwrap();
    bytes.push(b' ');
    envelope.payload = STANDARD.encode(bytes);
    assert!(
        verify_envelope(&envelope, &key, "0.1.0")
            .unwrap_err()
            .contains("签名")
    );
    let (mut envelope, key) = signed(|_| {}, b"new-executable");
    envelope.signature.clear();
    assert!(verify_envelope(&envelope, &key, "0.1.0").is_err());
}
#[test]
fn rejects_wrong_contract_downgrade_and_untrusted_downloads() {
    for field in ["schema", "appId", "channel", "platform"] {
        let (envelope, key) = signed(
            |v| {
                v[field] = if field == "schema" {
                    2.into()
                } else {
                    "python-production".into()
                }
            },
            b"new",
        );
        assert!(
            verify_envelope(&envelope, &key, "0.1.0").is_err(),
            "{field}"
        );
    }
    let (envelope, key) = signed(|_| {}, b"new");
    assert!(
        verify_envelope(&envelope, &key, "9.0.0")
            .unwrap_err()
            .contains("降级")
    );
    for url in [
        "http://github.com/yamakaze1234/other-repository/releases/download/refactor-v0.1.1/x.exe",
        "https://github.com/attacker/diy-tools/releases/download/refactor-v0.1.1/x.exe",
        "https://gitea.example.invalid@evil.example/a.exe",
    ] {
        let (envelope, key) = signed(|v| v["artifact"]["urls"][0] = url.into(), b"new");
        assert!(verify_envelope(&envelope, &key, "0.1.0").is_err());
    }
    let (envelope, key) = signed(
        |v| v["artifact"]["name"] = "DIY配置工作台-v1.0.49.zip".into(),
        b"new",
    );
    assert!(verify_envelope(&envelope, &key, "0.1.0").is_err());
}
// 每条路径与请求头都独立验证，不能依赖 reqwest 自动过滤跨主机授权。
#[test]
fn api_contract_rejects_other_repository_paths_and_queries() {
    for path in [
        "tags/refactor-updates",
        "tags/refactor-v0.2.1",
        "assets/123",
    ] {
        assert!(api_url_allowed(
            &Url::parse(&format!(
                "https://api.github.com/repos/{REPOSITORY}/releases/{path}"
            ))
            .unwrap()
        ));
    }
    for url in [
        "https://api.github.com/repos/yamakaze1234/other-repository/releases/assets/123",
        "https://api.github.com/repos/attacker/diytools-refactor/releases/assets/123",
        "https://api.github.com/repos/yamakaze1234/diytools-refactor/releases/assets/0",
        "https://api.github.com/repos/yamakaze1234/diytools-refactor/releases/assets/123/evil",
        "https://api.github.com/repos/yamakaze1234/diytools-refactor/releases/tags/v0.2.0",
        "https://api.github.com/repos/yamakaze1234/diytools-refactor/releases/tags/refactor-v0.2.1-beta",
        "https://api.github.com/repos/yamakaze1234/diytools-refactor/releases/assets/123?token=secret",
        "https://api.github.com@evil.example/repos/yamakaze1234/diytools-refactor/releases/assets/123",
    ] {
        assert!(!api_url_allowed(&Url::parse(url).unwrap()), "{url}");
    }
}
#[test]
fn manual_redirects_allow_only_asset_api_to_designated_https_cdns() {
    let origin = Url::parse(&format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/assets/123"
    ))
    .unwrap();
    let cdn =
        Url::parse("https://release-assets.githubusercontent.com/asset?signature=secret").unwrap();
    assert!(redirect_allowed(&origin, &origin, &cdn));
    assert!(redirect_allowed(
        &origin,
        &cdn,
        &Url::parse("https://objects.githubusercontent.com/asset?sig=secret").unwrap()
    ));
    for url in [
        "http://release-assets.githubusercontent.com/asset",
        "https://evil.githubusercontent.com/a",
        "https://evil.example/a",
        "https://release-assets.githubusercontent.com:444/asset",
        "https://token@objects.githubusercontent.com/a",
        "https://github.com/yamakaze1234/diytools-refactor/releases/download/refactor-v0.2.1/a.exe",
        "https://api.github.com/repos/attacker/diytools-refactor/releases/assets/123",
    ] {
        assert!(!redirect_allowed(&origin, &cdn, &Url::parse(url).unwrap()));
    }
    assert!(!redirect_allowed(&origin, &cdn, &origin));
    assert!(!redirect_allowed(
        &release_url(CHANNEL_TAG).unwrap(),
        &origin,
        &cdn
    ));
    assert!(read_bounded(&b"12345"[..], 4).is_err());
}
#[test]
fn authorization_is_sensitive_and_never_sent_to_cdn() {
    let client = client().unwrap();
    let api = Url::parse(&format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/assets/123"
    ))
    .unwrap();
    let api_request = request(&client, &api, Some("ghp_test_secret"), true)
        .unwrap()
        .build()
        .unwrap();
    let authorization = api_request
        .headers()
        .get(reqwest::header::AUTHORIZATION)
        .unwrap();
    assert!(authorization.is_sensitive());
    assert_eq!(authorization.to_str().unwrap(), "Bearer ghp_test_secret");
    assert!(!format!("{api_request:?}").contains("ghp_test_secret"));
    for host in [
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    ] {
        let url = Url::parse(&format!("https://{host}/asset?signature=secret")).unwrap();
        let cdn_request = request(&client, &url, Some("ghp_test_secret"), true)
            .unwrap()
            .build()
            .unwrap();
        assert!(
            !cdn_request
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );
        assert_eq!(
            cdn_request.headers().get(reqwest::header::ACCEPT).unwrap(),
            "application/octet-stream"
        );
    }
    assert!(
        !request(&client, &api, None, true)
            .unwrap()
            .build()
            .unwrap()
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION)
    );
    let bad = Url::parse(
        "https://api.github.com/repos/attacker/repo/releases/assets/123?token=ghp_test_secret",
    )
    .unwrap();
    let error = request(&client, &bad, Some("ghp_test_secret"), true)
        .err()
        .unwrap();
    assert!(!error.contains("ghp_test_secret") && !error.contains("https://"));
}
fn release_fixture() -> serde_json::Value {
    serde_json::json!({"tag_name":CHANNEL_TAG,"draft":false,"prerelease":false,"assets":[{
        "id":123,"name":MANIFEST_NAME,"state":"uploaded",
        "url":format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/123"),
        "browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/{CHANNEL_TAG}/{MANIFEST_NAME}")}]})
}
#[test]
fn release_asset_id_name_and_exact_repository_are_required() {
    assert!(release_asset(&release_fixture(), CHANNEL_TAG, MANIFEST_NAME).is_ok());
    for (field, value) in [
        ("id", serde_json::json!(0)),
        ("name", serde_json::json!("evil.json")),
        (
            "url",
            serde_json::json!("https://api.github.com/repos/attacker/repo/releases/assets/123"),
        ),
        ("state", serde_json::json!("new")),
        (
            "browser_download_url",
            serde_json::json!(
                "https://github.com/yamakaze1234/other-repository/releases/download/refactor-updates/file.json"
            ),
        ),
    ] {
        let mut release = release_fixture();
        release["assets"][0][field] = value;
        assert!(
            release_asset(&release, CHANNEL_TAG, MANIFEST_NAME).is_err(),
            "{field}"
        );
    }
    let mut release = release_fixture();
    release["tag_name"] = "refactor-v0.1.0".into();
    assert!(release_asset(&release, CHANNEL_TAG, MANIFEST_NAME).is_err());
    let mut release = release_fixture();
    release["draft"] = true.into();
    assert!(release_asset(&release, CHANNEL_TAG, MANIFEST_NAME).is_err());
    let mut release = release_fixture();
    release["assets"]
        .as_array_mut()
        .unwrap()
        .push(release_fixture()["assets"][0].clone());
    assert!(release_asset(&release, CHANNEL_TAG, MANIFEST_NAME).is_err());
}
#[test]
fn single_signed_github_url_is_the_only_download_contract() {
    for urls in [
        serde_json::json!([]),
        serde_json::json!(["https://gitea.example.invalid/a"]),
        serde_json::json!([
            "https://github.com/yamakaze1234/diytools-refactor/a",
            "https://github.com/yamakaze1234/diytools-refactor/b"
        ]),
    ] {
        let (envelope, key) = signed(|v| v["artifact"]["urls"] = urls.clone(), b"new");
        assert!(verify_envelope(&envelope, &key, "0.1.0").is_err());
    }
}
#[test]
#[ignore = "Requires an already published GitHub release; downloads only, never launches or installs"]
fn live_github_download_probe() {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox/github-release-20261014/updater-live-probe");
    let report = download_probe(&output).expect("GitHub download-only probe failed");
    println!("{report}");
}
#[test]
fn download_enforces_signed_length_digest_and_progress() {
    let directory = fixture();
    let (envelope, key) = signed(|_| {}, b"correct-binary");
    let manifest = verify_envelope(&envelope, &key, "0.1.0").unwrap();
    for (name, bytes, valid) in [
        ("good", &b"correct-binary"[..], true),
        ("bad", &b"corrupt-binary"[..], false),
        ("short", &b"short"[..], false),
        ("long", &b"correct-binary-extra"[..], false),
    ] {
        let mut file = fs::File::create(directory.join(name)).unwrap();
        let mut received = 0;
        let result = stream_artifact(bytes, &mut file, &manifest.artifact, |n| received = n);
        assert_eq!(result.is_ok(), valid);
        if valid {
            assert_eq!(received, bytes.len() as u64);
        }
    }
}
fn plan_fixture() -> (PathBuf, PathBuf, PathBuf, VerifyingKey) {
    let root = fixture();
    let directory = root.join(".updates").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        root.join("diytools-portable.json"),
        br#"{"mode":"portable"}"#,
    )
    .unwrap();
    fs::write(root.join("desktop.exe"), b"old-binary").unwrap();
    fs::write(directory.join("helper.exe"), b"old-binary").unwrap();
    fs::write(directory.join("artifact.exe"), b"new-binary").unwrap();
    let (envelope, key) = signed(|_| {}, b"new-binary");
    let plan = Plan {
        schema: 1,
        parent_pid: std::process::id() + 1,
        target_name: "desktop.exe".into(),
        current_sha256: format!("{:x}", Sha256::digest(b"old-binary")),
        envelope,
    };
    let path = directory.join("plan.json");
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    (root, directory, path, key)
}
#[test]
fn helper_validates_layout_paths_original_and_signed_artifact() {
    let (root, directory, path, key) = plan_fixture();
    let helper = directory.join("helper.exe");
    assert!(validate_plan(&helper, &path, &key).is_ok());
    assert!(validate_plan(&helper, &root.join("plan.json"), &key).is_err());
    fs::write(directory.join("artifact.exe"), b"tampered").unwrap();
    assert!(validate_plan(&helper, &path, &key).is_err());
    fs::write(directory.join("artifact.exe"), b"new-binary").unwrap();
    fs::write(root.join("desktop.exe"), b"changed-old").unwrap();
    assert!(validate_plan(&helper, &path, &key).is_err());
}
#[test]
fn helper_refuses_target_escape_and_nonportable_marker() {
    let (root, directory, path, key) = plan_fixture();
    let mut plan: Plan = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    plan.target_name = "../outside.exe".into();
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    assert!(validate_plan(&directory.join("helper.exe"), &path, &key).is_err());
    plan.target_name = "desktop.exe".into();
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    fs::write(
        root.join("diytools-portable.json"),
        br#"{"mode":"installed"}"#,
    )
    .unwrap();
    assert!(validate_plan(&directory.join("helper.exe"), &path, &key).is_err());
}
#[test]
fn replacement_preserves_data_marker_and_previous_program() {
    let (root, directory, _, _) = plan_fixture();
    fs::create_dir(root.join("data")).unwrap();
    let data = root.join("data/workbench.sqlite");
    fs::write(&data, b"business-data-never-touch").unwrap();
    let marker = fs::read(root.join("diytools-portable.json")).unwrap();
    let mut cwd = None;
    replace_and_start(
        &root.join("desktop.exe"),
        &directory.join("artifact.exe"),
        &directory,
        |path| {
            cwd = path.parent().map(Path::to_path_buf);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(cwd, Some(root.clone()));
    assert_eq!(fs::read(root.join("desktop.exe")).unwrap(), b"new-binary");
    assert_eq!(
        fs::read(directory.join("backup.exe")).unwrap(),
        b"old-binary"
    );
    assert_eq!(fs::read(data).unwrap(), b"business-data-never-touch");
    assert_eq!(
        fs::read(root.join("diytools-portable.json")).unwrap(),
        marker
    );
}
#[test]
fn replacement_and_launch_failure_roll_back_without_overwriting_backups() {
    let (root, directory, _, _) = plan_fixture();
    let target = root.join("desktop.exe");
    assert!(
        replace_and_start(&target, &directory.join("missing.exe"), &directory, |_| Ok(
            ()
        ))
        .is_err()
    );
    assert_eq!(fs::read(&target).unwrap(), b"old-binary");
    let mut starts = 0;
    assert!(
        replace_and_start(&target, &directory.join("artifact.exe"), &directory, |_| {
            starts += 1;
            Err("simulated-start-failure".into())
        })
        .is_err()
    );
    assert_eq!(starts, 2);
    assert_eq!(fs::read(&target).unwrap(), b"old-binary");
    assert_eq!(
        fs::read(directory.join("failed-new.exe")).unwrap(),
        b"new-binary"
    );
    fs::write(directory.join("backup.exe"), b"previous-backup").unwrap();
    assert!(
        replace_and_start(
            &target,
            &directory.join("artifact.exe"),
            &directory,
            |_| Ok(())
        )
        .is_err()
    );
    assert_eq!(
        fs::read(directory.join("backup.exe")).unwrap(),
        b"previous-backup"
    );
}

// 主源成功不能触碰备用凭据，主源校验失败也不能被备用成功掩盖。
#[test]
fn primary_source_is_lazy_and_security_errors_stop_fallback() {
    assert_eq!(
        prefer_primary(Ok(Some(7)), || -> Result<i32, String> {
            panic!("不应读取备用凭据")
        })
        .unwrap(),
        7
    );
    assert_eq!(prefer_primary(Ok(None), || Ok(9)).unwrap(), 9);
    assert_eq!(
        prefer_primary(Err("签名错误".into()), || Ok(9)).unwrap_err(),
        "签名错误"
    );
}
#[test]
fn signed_sources_accept_gitea_and_legacy_but_reject_duplicates() {
    let add_gitea = |v: &mut serde_json::Value| {
        let url = format!(
            "https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases/download/refactor-v{}/{}",
            v["version"].as_str().unwrap(),
            v["artifact"]["name"].as_str().unwrap()
        );
        v["artifact"]["urls"]
            .as_array_mut()
            .unwrap()
            .insert(0, url.into());
    };
    let (envelope, key) = signed(add_gitea, b"new");
    assert_eq!(
        verify_envelope(&envelope, &key, "0.1.0")
            .unwrap()
            .artifact
            .urls
            .len(),
        2
    );
    let (envelope, key) = signed(
        |v| {
            add_gitea(v);
            v["artifact"]["urls"].as_array_mut().unwrap().pop();
        },
        b"new",
    );
    assert!(verify_envelope(&envelope, &key, "0.1.0").is_ok());
    let (envelope, key) = signed(
        |v| {
            let url = v["artifact"]["urls"][0].clone();
            v["artifact"]["urls"].as_array_mut().unwrap().push(url);
        },
        b"new",
    );
    assert!(verify_envelope(&envelope, &key, "0.1.0").is_err());
}
// 数据库不能恢复时不得把旧程序放回入口，更不能启动旧程序写入新格式。
#[test]
fn database_restore_failure_blocks_program_rollback_and_restart() {
    let (root, directory, _, _) = plan_fixture();
    let target = root.join("desktop.exe");
    let mut starts = 0;
    let result = replace_with_recovery(
        &target,
        &directory.join("artifact.exe"),
        &directory,
        |_| {
            starts += 1;
            Err("初始化失败".into())
        },
        || Err("快照损坏".into()),
    );
    assert!(result.unwrap_err().contains("禁止重启旧程序"));
    assert_eq!(starts, 1);
    assert_eq!(fs::read(&target).unwrap(), b"new-binary");
    assert_eq!(
        fs::read(directory.join("backup.exe")).unwrap(),
        b"old-binary"
    );
}

// 只有本次进程和候选版本的完整回执才确认初始化，残留/半写文件不能放行。
#[test]
fn startup_confirmation_requires_matching_process_and_version() {
    let directory = fixture();
    let path = directory.join("startup-ready.json");
    assert!(!startup_receipt_matches(&directory, 7, "0.3.0"));
    fs::write(&path, br#"{"pid":7"#).unwrap();
    assert!(!startup_receipt_matches(&directory, 7, "0.3.0"));
    fs::write(&path, br#"{"pid":7,"version":"0.3.0"}"#).unwrap();
    assert!(startup_receipt_matches(&directory, 7, "0.3.0"));
    assert!(!startup_receipt_matches(&directory, 8, "0.3.0"));
    assert!(!startup_receipt_matches(&directory, 7, "0.2.3"));
}
// 本机结果显示只采纳规范更新目录和终态；未完成下载不能遮住失败恢复说明。
#[test]
fn recovery_status_is_available_without_network_and_ignores_unfinished_updates() {
    let root = fixture();
    let directory = create_directory(&root).unwrap();
    write_status(&directory, "failed", "已恢复更新前数据库").unwrap();
    let unfinished = create_directory(&root).unwrap();
    write_status(&unfinished, "ready", "等待退出").unwrap();
    let result = latest_recovery_status(&root).unwrap().unwrap();
    assert_eq!(result["message"], "已恢复更新前数据库");
    assert_eq!(result["directory"], directory.to_string_lossy().as_ref());
}
