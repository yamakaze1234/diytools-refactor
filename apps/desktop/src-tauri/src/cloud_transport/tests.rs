// 传输层隔离测试：本地模拟 HTTP 响应，覆盖成员校验、刷新并发、退出取消和原图幂等回读。
use super::*;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;

struct Reply {
    status: u16,
    body: String,
    delay: Duration,
    extra_headers: String,
}

impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            body: value.to_string(),
            delay: Duration::ZERO,
            extra_headers: String::new(),
        }
    }
    fn status(code: u16, value: Value) -> Self {
        Self {
            status: code,
            ..Self::json(value)
        }
    }
}

struct Wire {
    path: String,
    body: Value,
    raw: Vec<u8>,
    headers: String,
}

struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new(handler: impl Fn(Wire) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if let Some(wire) = read_request(&mut stream) {
                            let reply = handler(wire);
                            thread::sleep(reply.delay);
                            let text = format!(
                                "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
                                reply.status,
                                reply.body.len(),
                                reply.extra_headers,
                                reply.body
                            );
                            let _ = stream.write_all(text.as_bytes());
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            stop,
            worker: Some(worker),
        }
    }
    fn transport(&self) -> CloudTransport {
        // Only tests can pass this localhost URL. Production new() fixes HTTPS/env.
        CloudTransport::build(self.url.clone(), Duration::from_secs(2), MAX_RESPONSE).unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Wire> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 2048];
    loop {
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(position) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..position]).to_string();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= position + 4 + length {
                return Some(Wire {
                    path: headers.lines().next()?.split_whitespace().nth(1)?.into(),
                    body: serde_json::from_slice(&bytes[position + 4..position + 4 + length])
                        .unwrap_or(Value::Null),
                    raw: bytes[position + 4..position + 4 + length].to_vec(),
                    headers,
                });
            }
        }
    }
}

fn token(access: &str) -> Value {
    json!({"token_type":"Bearer","access_token":access,"refresh_token":"test-refresh-secret","expires_in":3600,"sub":"member-1"})
}
fn member() -> Value {
    json!({"ok":true,"uid":"member-1","workspaceId":"workspace-1","memberId":"m1","name":"成员","protocolVersion":2,"ready":true})
}
fn pull() -> Value {
    json!({"protocolVersion":2,"action":"sync.pull","requestId":"fixed-request","payload":{"cursor":0,"limit":100}})
}

#[test]
fn login_native_only_and_history_rpc_contract() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let server = Server::new(move |wire| {
        let response = if wire.path == "/auth/v1/signin" {
            assert_eq!(wire.body["username"], "test-user");
            token("test-access-secret")
        } else if wire.body["action"] == "session.get" {
            member()
        } else {
            json!({"ok":true,"records":[],"accessToken":"test-access-secret","message":"test-access-secret/test-refresh-secret"})
        };
        captured.lock().unwrap().push(wire);
        Reply::json(response)
    });
    let transport = server.transport();
    assert!(
        !transport.resume().unwrap()["authenticated"]
            .as_bool()
            .unwrap()
    );
    let login = transport
        .login("test-user", "test-password-secret")
        .unwrap();
    assert_eq!(login["member"]["memberId"], "m1");
    assert_eq!(transport.status().unwrap()["authenticated"], true);
    assert!(!login.to_string().contains("secret"));
    let result = transport
        .call(json!({"action":"records.commits","requestId":"history-id","payload":{"before":123}}))
        .unwrap();
    assert!(result.get("accessToken").is_none());
    assert!(!result.to_string().contains("secret"));
    let captured = requests.lock().unwrap();
    let history = captured.last().unwrap();
    assert_eq!(history.path, "/v1/rdb/rest/rpc/wa_commit_history");
    assert_eq!(history.body["request"]["requestId"], "history-id");
    assert!(history.body.get("accessToken").is_none());
    assert!(
        history
            .headers
            .to_ascii_lowercase()
            .contains("authorization: bearer test-access-secret")
    );
    drop(captured);
    assert_eq!(transport.logout().unwrap()["authenticated"], false);
    assert!(transport.call(pull()).is_err());
}

#[test]
fn member_failure_does_not_establish_session() {
    let server = Server::new(|wire| {
        Reply::json(if wire.path == "/auth/v1/signin" {
            token("test-access-secret")
        } else {
            json!({"ok":false,"code":"NOT_MEMBER","message":"test-password-secret"})
        })
    });
    let transport = server.transport();
    let error = transport
        .login("test-user", "test-password-secret")
        .unwrap_err();
    assert!(!error.contains("secret"));
    assert_eq!(transport.resume().unwrap()["authenticated"], false);
}

#[test]
fn reject_anonymous_scope_claims_and_wrong_member_subject() {
    let mut anonymous = token("opaque");
    anonymous["scope"] = json!("profile anonymous");
    assert!(parse_tokens(&anonymous).is_err());
    use base64::Engine;
    let claim =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"is_anonymous":true}"#);
    anonymous["scope"] = json!("profile");
    anonymous["access_token"] = json!(format!("header.{claim}.signature"));
    assert!(parse_tokens(&anonymous).is_err());
    assert!(parse_member(&member(), "other-member").is_err());
    let mut anonymous_member = member();
    anonymous_member["isAnonymous"] = json!(true);
    assert!(parse_member(&anonymous_member, "member-1").is_err());
}

#[test]
fn reject_invalid_env_action_protocol_and_renderer_url() {
    for env in ["", "bad.example", "../evil", "example-env/evil"] {
        assert!(
            CloudTransport::new(CloudTransportConfig {
                env_id: env.into(),
                endpoint: "https://cloud.example.test".into()
            })
            .is_err()
        );
    }
    assert!(validate_request(json!({"action":"assets.prepare"})).is_err());
    assert!(validate_request(json!({"action":"admin.delete"})).is_err());
    for protocol in [json!(1), json!("2"), json!(null)] {
        assert!(
            validate_request(json!({"action":"session.get","protocolVersion":protocol})).is_err()
        );
    }
    assert!(validate_request(json!({"action":"session.get","url":"http://evil"})).is_err());
    assert!(validate_request(json!({"action":"session.get","accessToken":"secret"})).is_err());
    assert!(validate_request(json!({"action":"session.get","payload":[]})).is_err());
}

#[test]
fn near_expiry_refresh_is_single_flight() {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let count = refreshes.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("initial-access-secret"))
        } else if wire.path == "/auth/v1/token" {
            assert_eq!(wire.body["grant_type"], "refresh_token");
            assert_eq!(wire.body["refresh_token"], "test-refresh-secret");
            count.fetch_add(1, Ordering::SeqCst);
            Reply::json(token("renewed-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            Reply::json(json!({"ok":true}))
        }
    });
    let transport = Arc::new(server.transport());
    transport.login("test-user", "test-password").unwrap();
    transport
        .state()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .tokens
        .expires = Instant::now();
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let transport = transport.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                transport.call(pull()).unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
}

#[test]
fn unauthorized_refresh_preserves_entire_mutation_envelope() {
    let submissions = Arc::new(Mutex::new(Vec::new()));
    let captured = submissions.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("initial-access-secret"))
        } else if wire.path == "/auth/v1/token" {
            Reply::json(token("renewed-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            let mut requests = captured.lock().unwrap();
            let mut envelope = wire.body;
            envelope.as_object_mut().unwrap().remove("accessToken");
            requests.push(envelope);
            if requests.len() == 1 {
                Reply::status(401, json!({"message":"secret"}))
            } else {
                Reply::json(json!({"ok":true,"results":[]}))
            }
        }
    });
    let transport = server.transport();
    transport.login("test-user", "test-password").unwrap();
    let request = json!({"protocolVersion":2,"action":"sync.pushBatch","requestId":"same-batch-id","payload":{"requests":[{"protocolVersion":2,"action":"sync.push","requestId":"same-item-id","payload":{"mutationId":"immutable-mutation","deviceId":"device1","after":{"name":"unchanged"}}}]}});
    transport.call(request.clone()).unwrap();
    let requests = submissions.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], request);
    assert_eq!(requests[1], request);
}

#[test]
fn unsafe_mutation_is_not_automatically_replayed() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let count = attempts.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("initial-access-secret"))
        } else if wire.path == "/auth/v1/token" {
            Reply::json(token("renewed-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            count.fetch_add(1, Ordering::SeqCst);
            Reply::status(401, json!({}))
        }
    });
    let transport = server.transport();
    transport.login("user", "password").unwrap();
    assert!(
        transport
            .call(json!({"action":"sync.push","payload":{"after":{}}}))
            .unwrap_err()
            .contains("未自动重发")
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[test]
fn logout_cancels_late_login_without_waiting_for_network() {
    let (sender, receiver) = mpsc::channel();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            sender.send(()).unwrap();
            Reply {
                delay: Duration::from_millis(120),
                ..Reply::json(token("test-access-secret"))
            }
        } else {
            Reply::json(member())
        }
    });
    let transport = Arc::new(server.transport());
    let other = transport.clone();
    let login = thread::spawn(move || other.login("test-user", "test-password"));
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    let start = Instant::now();
    transport.logout().unwrap();
    assert!(start.elapsed() < Duration::from_millis(80));
    assert!(login.join().unwrap().is_err());
    assert_eq!(transport.resume().unwrap()["authenticated"], false);
}

#[test]
fn logout_cancels_late_business_response() {
    let (sender, receiver) = mpsc::channel();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            sender.send(()).unwrap();
            Reply {
                delay: Duration::from_millis(120),
                ..Reply::json(json!({"ok":true}))
            }
        }
    });
    let transport = Arc::new(server.transport());
    transport.login("test-user", "test-password").unwrap();
    let other = transport.clone();
    let call = thread::spawn(move || other.call(pull()));
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    transport.logout().unwrap();
    assert!(call.join().unwrap().is_err());
}

#[test]
fn failed_refresh_invalidates_native_session() {
    let server = Server::new(|wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.path == "/auth/v1/token" {
            Reply::status(
                400,
                json!({"error":"invalid_grant","error_description":"test-refresh-secret"}),
            )
        } else {
            Reply::json(member())
        }
    });
    let transport = server.transport();
    transport.login("test-user", "test-password").unwrap();
    transport
        .state()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .tokens
        .expires = Instant::now();
    let error = transport.call(pull()).unwrap_err();
    assert!(!error.contains("secret"));
    assert_eq!(transport.resume().unwrap()["authenticated"], false);
}

#[test]
fn timeout_oversize_invalid_json_and_redirect_errors_are_sanitized() {
    for mode in ["timeout", "oversize", "invalid", "redirect", "server-error"] {
        let server = Server::new(move |_| match mode {
            "timeout" => Reply {
                delay: Duration::from_millis(100),
                ..Reply::json(token("test-access-secret"))
            },
            "oversize" => Reply::json(json!({"error":"test-password-secret".repeat(100)})),
            "invalid" => Reply {
                body: "test-password-secret invalid json".into(),
                ..Reply::json(json!({}))
            },
            "redirect" => Reply {
                extra_headers: "Location: http://127.0.0.1:1/leak\r\n".into(),
                ..Reply::status(302, json!({"error":"test-password-secret"}))
            },
            _ => Reply::status(500, json!({"error":"test-password-secret"})),
        });
        let transport =
            CloudTransport::build(server.url.clone(), Duration::from_millis(35), 1000).unwrap();
        let error = transport
            .login("test-user", "test-password-secret")
            .unwrap_err();
        assert!(!error.contains("secret"));
        assert!(!error.contains("127.0.0.1"));
        assert_eq!(transport.resume().unwrap()["authenticated"], false);
    }
}

#[test]
fn private_asset_targets_hash_mime_and_not_found() {
    use sha2::Digest;
    let bytes = b"test-image-bytes";
    let name = format!("{:x}.png", sha2::Sha256::digest(bytes));
    let captured = Arc::new(Mutex::new(Vec::new()));
    let requests = captured.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            assert!(
                wire.path
                    .starts_with("/v1/storages/object/workbench-assets/workspace-1/")
            );
            let post = wire.headers.starts_with("POST ");
            if post {
                assert!(
                    wire.headers
                        .to_ascii_lowercase()
                        .contains("x-upsert: false")
                );
                assert!(
                    wire.headers
                        .to_ascii_lowercase()
                        .contains("content-type: image/png")
                );
                assert_eq!(wire.raw, bytes);
            }
            requests.lock().unwrap().push(wire.path);
            if post {
                Reply::json(json!({"ok":true}))
            } else {
                Reply {
                    body: String::from_utf8_lossy(bytes).into(),
                    ..Reply::json(json!({}))
                }
            }
        }
    });
    let transport = server.transport();
    transport.login("test-user", "test-password").unwrap();
    assert_eq!(
        transport.current_member().unwrap().unwrap()["uid"],
        "member-1"
    );
    assert!(
        transport
            .storage_upload(&name, bytes, "image/jpeg")
            .is_err()
    );
    assert!(
        transport
            .storage_upload(&name, b"different", "image/png")
            .is_err()
    );
    assert!(transport.storage_get("../../evil.png").is_err());
    transport.storage_upload(&name, bytes, "image/png").unwrap();
    assert_eq!(transport.storage_get(&name).unwrap(), bytes);
    assert_eq!(captured.lock().unwrap().len(), 2);

    let missing = Server::new(|wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            Reply::status(404, json!({"message":"test-access-secret"}))
        }
    });
    let transport = missing.transport();
    transport.login("test-user", "test-password").unwrap();
    assert!(
        transport
            .storage_get(&name)
            .unwrap_err()
            .starts_with("STORAGE_NOT_FOUND:")
    );
}

#[test]
fn conflicted_immutable_upload_is_confirmed_by_readback() {
    use sha2::Digest;
    let bytes = b"existing-image";
    let name = format!("{:x}.jpg", sha2::Sha256::digest(bytes));
    let posts = Arc::new(AtomicUsize::new(0));
    let count = posts.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else if wire.headers.starts_with("POST ") {
            count.fetch_add(1, Ordering::SeqCst);
            Reply::status(409, json!({"message":"test-access-secret"}))
        } else {
            Reply {
                body: String::from_utf8_lossy(bytes).into(),
                ..Reply::json(json!({}))
            }
        }
    });
    let transport = server.transport();
    transport.login("test-user", "test-password").unwrap();
    assert_eq!(
        transport
            .storage_upload(&name, bytes, "image/jpeg")
            .unwrap()["ok"],
        true
    );
    assert_eq!(posts.load(Ordering::SeqCst), 1);
}

#[test]
fn logout_cancels_refresh_and_preserves_logged_out_state() {
    let (sender, receiver) = mpsc::channel();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("initial-access-secret"))
        } else if wire.path == "/auth/v1/token" {
            sender.send(()).unwrap();
            Reply {
                delay: Duration::from_millis(120),
                ..Reply::json(token("renewed-access-secret"))
            }
        } else {
            Reply::json(member())
        }
    });
    let transport = Arc::new(server.transport());
    transport.login("test-user", "test-password").unwrap();
    transport
        .state()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .tokens
        .expires = Instant::now();
    let other = transport.clone();
    let call = thread::spawn(move || other.call(pull()));
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    transport.logout().unwrap();
    assert!(call.join().unwrap().is_err());
    assert!(transport.current_member().unwrap().is_none());
}

#[test]
fn revoked_membership_resume_clears_session() {
    let sessions = Arc::new(AtomicUsize::new(0));
    let count = sessions.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if count.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::json(member())
        } else {
            Reply::json(json!({"ok":false,"code":"NOT_MEMBER"}))
        }
    });
    let transport = server.transport();
    transport.login("test-user", "test-password").unwrap();
    assert!(transport.resume().is_err());
    assert!(transport.current_member().unwrap().is_none());
}

#[test]
fn uncertain_business_timeout_has_no_automatic_retry() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let count = attempts.clone();
    let server = Server::new(move |wire| {
        if wire.path == "/auth/v1/signin" {
            Reply::json(token("test-access-secret"))
        } else if wire.body["action"] == "session.get" {
            Reply::json(member())
        } else {
            count.fetch_add(1, Ordering::SeqCst);
            Reply {
                delay: Duration::from_millis(100),
                ..Reply::json(json!({"ok":true}))
            }
        }
    });
    let transport =
        CloudTransport::build(server.url.clone(), Duration::from_millis(35), MAX_RESPONSE).unwrap();
    transport.login("test-user", "test-password").unwrap();
    assert!(
        transport
            .call(
                json!({"action":"sync.push","payload":{"mutationId":"fixed-mutation","after":{}}})
            )
            .is_err()
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert!(transport.current_member().unwrap().is_some());
}

#[test]
fn private_asset_unauthorized_refreshes_only_once() {
    use sha2::Digest;
    let bytes = b"test-image";
    let name = format!("{:x}.png", sha2::Sha256::digest(bytes));
    for upload in [false, true] {
        let refreshes = Arc::new(AtomicUsize::new(0));
        let count = refreshes.clone();
        let server = Server::new(move |wire| {
            if wire.path == "/auth/v1/signin" {
                Reply::json(token("initial-access-secret"))
            } else if wire.path == "/auth/v1/token" {
                count.fetch_add(1, Ordering::SeqCst);
                Reply::json(token("renewed-access-secret"))
            } else if wire.body["action"] == "session.get" {
                Reply::json(member())
            } else {
                Reply::status(401, json!({"message":"test-access-secret"}))
            }
        });
        let transport = server.transport();
        transport.login("test-user", "test-password").unwrap();
        if upload {
            assert!(transport.storage_upload(&name, bytes, "image/png").is_err());
        } else {
            assert!(transport.storage_get(&name).is_err());
        }
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert!(transport.current_member().unwrap().is_none());
    }
}

// 本机未配置云服务时，状态可读但认证与请求必须在联网前被拒绝。
#[test]
fn missing_configuration_is_local_only() {
    let transport = CloudTransport::unconfigured().unwrap();
    assert_eq!(transport.status().unwrap()["configured"], false);
    assert_eq!(transport.resume().unwrap()["configured"], false);
    assert_eq!(
        transport.login("tester", "placeholder").unwrap_err(),
        CLOUD_NOT_CONFIGURED
    );
    assert_eq!(transport.access().unwrap_err(), CLOUD_NOT_CONFIGURED);
    assert_eq!(transport.logout().unwrap()["authenticated"], false);
}

// 配置地址仍保持 HTTPS 与单一来源边界，不能将凭据发送至重定向地址。
#[test]
fn configured_cloud_requires_https_origin() {
    for endpoint in [
        "http://cloud.example.test",
        "https://user@cloud.example.test",
        "https://cloud.example.test/path",
        "https://cloud.example.test?q=1",
        "https://cloud.example.test#x",
    ] {
        assert!(
            CloudTransport::new(CloudTransportConfig {
                env_id: "example-env".into(),
                endpoint: endpoint.into()
            })
            .is_err()
        );
    }
    let transport = CloudTransport::new(CloudTransportConfig {
        env_id: "example-env".into(),
        endpoint: "https://cloud.example.test".into(),
    })
    .unwrap();
    assert_eq!(transport.status().unwrap()["configured"], true);
}
