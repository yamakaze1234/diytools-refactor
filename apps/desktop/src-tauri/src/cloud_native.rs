// 云同步原生入口：隔离登录凭据，协调本机绑定、原图缓存、取消状态与持久队列授权。
//! Native IPC boundary for cloud access. No credentials are returned to the renderer.
use crate::{
    cloud_transport::{CLOUD_NOT_CONFIGURED, CloudTransport, CloudTransportConfig},
    workbench_store::{self, ApiResponse, WorkbenchStore},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

pub struct CloudRuntime {
    transport: Arc<CloudTransport>,
    nas: Option<reqwest::Url>,
    nas_deployment: Option<String>,
    nas_main: bool,
    plan: Mutex<Option<CachedPlan>>,
    legacy: Mutex<Option<(u64, workbench_store::PreparedLegacyMigration)>>,
    identity_gate: RwLock<()>,
    assets_gate: Mutex<()>,
    connect_gate: Mutex<()>,
    epoch: AtomicU64,
    asset_cancel_epoch: AtomicU64,
    cancelled_assets: Mutex<BTreeSet<String>>,
}
struct CachedPlan {
    token: String,
    bytes: Vec<u8>,
    document: Value,
    epoch: u64,
}
impl CloudRuntime {
    // 创建共享传输会话及身份、原图、首次绑定的独立互斥门，避免任务相互覆盖。
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        #[cfg(feature="nas-acceptance")]
        let transport = crate::nas_acceptance::transport()?;
        #[cfg(not(feature="nas-acceptance"))]
        let path = data_dir.join("integrations.json");
        // 外部文件优先；只有文件完全不存在才使用构建注入的默认认证，错误配置不静默回退。
        #[cfg(not(feature="nas-acceptance"))]
        let transport = match fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(64 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "CLOUD_CONFIG_INVALID: 无法读取本机接入配置")?;
                if bytes.len() > 64 * 1024 {
                    return Err("CLOUD_CONFIG_INVALID: 本机接入配置过大".into());
                }
                let document: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "CLOUD_CONFIG_INVALID: 本机接入配置格式无效")?;
                if document["version"] != 1 {
                    return Err("CLOUD_CONFIG_INVALID: 本机接入配置版本无效".into());
                }
                match document.get("cloud").filter(|value| !value.is_null()) {
                    Some(value) => CloudTransport::new(
                        serde_json::from_value::<CloudTransportConfig>(value.clone())
                            .map_err(|_| "CLOUD_CONFIG_INVALID: 本机云服务配置格式无效")?,
                    )?,
                    None => CloudTransport::unconfigured()?,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                crate::embedded_auth::transport()?
            }
            Err(_) => return Err("CLOUD_CONFIG_INVALID: 无法读取本机接入配置".into()),
        };
        let nas=std::env::var("DIYTOOLS_NAS_API_URL").ok().and_then(|s| nas_base(&s));
        let nas_main=std::env::var_os("DIYTOOLS_NAS_MAIN").is_some_and(|value| value == "1");
        let nas_deployment=std::env::var_os("DIYTOOLS_NAS_DEPLOYMENT_ID").map(|value|{
            value.into_string().ok().filter(|id|valid_nas_deployment(id)).ok_or("正式 NAS 部署标识无效")
        }).transpose()?;
        if cfg!(feature="formal-nas-client")&&nas.is_some()&&nas_deployment.is_none(){
            return Err("正式 NAS 连接配置缺失，请检查程序旁的 nas-launch.json".into());
        }
        let valid_endpoint=nas.as_ref().is_some_and(|url|{
            if cfg!(feature="nas-acceptance") {url.host_str()==Some("127.0.0.1")} else {production_nas_endpoint(url)}
        });
        if nas_deployment.is_some()&&(!nas_main||!valid_endpoint){
            return Err("正式 NAS 需要独立的局域网 HTTPS 地址，不能使用试验端口".into());
        }
        // 虚拟路径仅作凭据管理器的命名范围，不创建目录，也不轮换原本机工作区的登录记录。
        let nas_scope=nas.as_ref().map(|u|nas_endpoint_id(u,nas_deployment.as_deref()));
        let scope=if nas_main {data_dir.join(".nas-sessions").join(nas_scope.as_deref().unwrap_or("unconfigured"))} else {data_dir.to_path_buf()};
        let mut transport=transport;
        if nas_main&&nas.is_some(){
            if let Ok(pem)=std::env::var("DIYTOOLS_NAS_CA_PEM") {
                transport=transport.with_nas_ca(pem.as_bytes())?;
            } else if std::env::var("DIYTOOLS_NAS_SYSTEM_CA").ok().as_deref()==Some("1") {
                transport=transport.with_nas_system_ca()?;
            } else { match fs::File::open(data_dir.join("nas-ca.pem")){
                Ok(file)=>{
                    let mut pem=Vec::new();
                    file.take(16*1024+1).read_to_end(&mut pem).map_err(|_|"无法读取 NAS 局域网根证书")?;
                    transport=transport.with_nas_ca(&pem)?;
                }
                Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},
                Err(_)=>return Err("无法打开 NAS 局域网根证书".into()),
            }}
        }
        if let Some(id)=&nas_deployment {transport=transport.with_nas_deployment(id.clone())?;}
        let transport=if cfg!(feature="nas-acceptance") {transport} else {transport.with_persistence(&scope)?};
        Ok(Self {
            transport: Arc::new(transport),
            nas,
            nas_deployment,
            nas_main,
            plan: Mutex::new(None),
            legacy: Mutex::new(None),
            identity_gate: RwLock::new(()),
            assets_gate: Mutex::new(()),
            connect_gate: Mutex::new(()),
            epoch: AtomicU64::new(0),
            asset_cancel_epoch: AtomicU64::new(0),
            cancelled_assets: Mutex::new(BTreeSet::new()),
        })
    }

    pub(crate) fn nas_main(&self) -> bool { self.nas_main }

    fn check_nas_profile(&self) -> Result<(),String>{
        if self.nas_deployment.is_none(){return Ok(());}
        let base=self.nas.as_ref().ok_or("正式 NAS 地址未配置")?;
        self.transport.check_nas_deployment(base).map_err(|(_,code)|match code{
            "NAS_DEPLOYMENT_MISMATCH"=>"正式 NAS 部署标识不匹配，请核对独立测试程序的连接配置".into(),
            _=>"暂时无法建立到正式 NAS 的可信 HTTPS 连接".into(),
        })
    }

    // 原图只来自已配置的服务摘要入口，使用无账号、无重定向的独立二进制请求。
    pub(crate) fn nas_image(&self, path: &str) -> Result<(&'static str, Vec<u8>), u16> {
        let base = self.nas.as_ref().filter(|_| self.nas_main).ok_or(404u16)?;
        let name = path.strip_prefix("/images/").ok_or(404u16)?;
        let (hash, extension) = name.split_once('.').ok_or(404u16)?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(404);
        }
        let mime = match extension {"png"=>"image/png","jpg"|"jpeg"=>"image/jpeg",_=>return Err(404)};
        let url = base.join(path).map_err(|_|404u16)?;
        self.transport.check_nas_deployment(base).map_err(|(status,_)|status)?;
        let bytes = self.transport.nas_image(url, mime)?;
        let signature = if mime=="image/png" { &b"\x89PNG\r\n\x1a\n"[..] } else { &b"\xff\xd8\xff"[..] };
        if !bytes.starts_with(signature) || format!("{:x}",Sha256::digest(&bytes)) != hash { return Err(502); }
        Ok((mime,bytes))
    }
}

pub(crate) fn valid_nas_deployment(id:&str)->bool{
    id.strip_prefix("intel-production-").is_some_and(|value|{
        !value.is_empty()&&value.len()<=31&&!value.starts_with('-')&&!value.ends_with('-')&&
        value.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-')
    })
}

pub(crate) fn production_nas_endpoint(url:&reqwest::Url)->bool{
    url.port().is_some_and(|port|port>=1024&&port!=18443)&&url.host_str().and_then(|ip|ip.parse::<std::net::Ipv4Addr>().ok()).is_some_and(|ip|ip.is_private())
}

// 试验仍沿用原 URL 作用域，否则旧草稿会丢失。正式同时按端点和服务代号隔离。
fn nas_endpoint_id(url:&reqwest::Url,deployment:Option<&str>)->String{
    let source=match deployment{Some(value)=>format!("{}\0{}",url.as_str(),value),None=>url.as_str().to_owned()};
    format!("{:x}",Sha256::digest(source.as_bytes()))
}

pub(crate) fn nas_base(raw: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(raw).ok()?;
    // 禁止渲染器传入服务器地址；只接受启动时设置的固定 HTTPS 服务入口。
    (url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() &&
        url.password().is_none() && url.path() == "/" && url.query().is_none() && url.fragment().is_none())
        .then_some(url)
}

// 无窗口原生探针：使用正式相同的证书信任，只访问公开健康路由，不读取账号和工作区。
pub fn run_nas_tls_probe()->Option<i32>{
    let mut args=std::env::args_os().skip(1);
    if args.next().as_deref()!=Some(std::ffi::OsStr::new("--verify-nas-lan-tls")){return None;}
    let result=(||{
        let output=args.next().ok_or("缺少探针输出位置")?;
        if args.next().is_some(){return Err("探针参数无效");}
        let exe=std::env::current_exe().map_err(|_|"无法定位独立程序")?;
        let dir=exe.parent().ok_or("无法定位测试目录")?;
        let pem=fs::read(dir.join("data/nas-ca.pem")).map_err(|_|"缺少独立 NAS 根证书")?;
        let url=std::env::var("DIYTOOLS_NAS_API_URL").ok().and_then(|value|nas_base(&value)).ok_or("NAS HTTPS 地址无效")?;
        let probe=crate::cloud_transport::nas_tls_client(&pem).map_err(|_|"CA 无效")?;
        let response=probe.get(url.join("/healthz").map_err(|_|"健康地址无效")?).send();
        let (status,passed)=match response{
            Ok(value)=>{
                let status=value.status().as_u16();
                let body=value.take(4097).bytes().collect::<Result<Vec<_>,_>>().unwrap_or_default();
                let health=serde_json::from_slice::<Value>(&body).unwrap_or_default();
                (Some(status),status==200&&health["ok"]==true&&health["checks"]["process"]==true)
            }
            Err(_)=>(None,false),
        };
        let report=json!({"endpoint":url.as_str(),"caSha256":format!("{:x}",Sha256::digest(&pem)),"httpStatus":status,
            "trustedHttps":passed,"windowCreated":false,"databaseOpened":false,"credentialsRead":false});
        let mut file=fs::OpenOptions::new().create_new(true).write(true).open(output).map_err(|_|"不能新建探针结果")?;
        file.write_all(report.to_string().as_bytes()).map_err(|_|"不能输出探针结果")?;
        Ok(if passed{0}else{2})
    })();
    Some(result.unwrap_or(1))
}

fn nas_route(base: &reqwest::Url, method: &str, route: &str) -> Option<(reqwest::Method, reqwest::Url)> {
    if route.len() > 4096 || route.contains(['\\', '#']) ||
        !route.starts_with("/api/v1/") || route.bytes().any(|x| x.is_ascii_control()) {
        return None;
    }
    let url = base.join(route).ok()?;
    let path = url.path().strip_prefix("/api/v1/")?;
    let parts = path.split('/').collect::<Vec<_>>();
    // 页面只可使用试验业务入口，不能用这个原生命令发送任意同源请求。
    let valid = matches!((method, parts.as_slice()),
        ("GET", ["me"]) |
        ("GET", ["operations", "workspace-index" | "workspace-catalog"]) |
        ("POST", ["operations", "workspace", "configurations" | "import-preview" | "costs" | "settings" | "quotations" | "source-usage"]) |
        ("GET", ["operations", "workspace", "activity"]) |
        ("POST", ["operations", "workspace", "profit", "start" | "status" | "history" | "reset"]) |
        ("POST", ["operations", "workspace", "price-history", "list" | "detail" | "day" | "handle"]) |
        ("GET", ["operations", "workspace", "receipts" | "quotations", _]) |
        ("GET", ["operations", "catalog", "sources" | "addons" | "gallery" | "templates" | "shared-sources"]) |
        ("GET", ["operations", "catalog", "sources" | "addons" | "gallery" | "templates" | "receipts" | "shared-sources", _]) |
        ("POST", ["operations", "catalog", "sources" | "gallery" | "templates" | "shared-sources"]) |
        ("POST", ["operations", "catalog", "sources" | "gallery" | "templates", _, "archive" | "restore" | "copy" | "apply"]) |
        ("PUT", ["operations", "catalog", "sources" | "addons" | "gallery" | "templates" | "shared-sources", _]) |
        ("GET", ["operations", "save-receipts" | "sources" | "costs" | "templates" | "gallery", _]) |
        ("GET", ["operations" | "sales", "configurations"]) |
        ("GET", ["operations" | "sales", "configurations", _]) |
        ("GET", ["operations" | "sales", "configurations", _, "addons"]) |
        ("POST", ["operations", "configurations"]) |
        ("POST", ["operations", "configurations", _, "archive" | "restore"]) |
        ("PUT", ["operations", "configurations", _]) |
        ("PUT", ["operations", "configurations", _, "design"]));
    (valid && url.origin() == base.origin() && parts.iter().all(|p| !p.is_empty()))
        .then(|| (reqwest::Method::from_bytes(method.as_bytes()).ok(), url))
        .and_then(|(method,url)| Some((method?,url)))
}

#[cfg(test)]
#[test]
fn nas_native_routes_only_allow_configured_https_business_methods() {
    assert!(nas_base("http://nas.example/").is_none());
    assert!(nas_base("https://a:b@nas.example/").is_none());
    assert!(nas_base("https://nas.example/path").is_none());
    let base = nas_base("https://nas.example:18443/").unwrap();
    let route = nas_route(&base, "PUT", "/api/v1/operations/configurations/id/design?shop_id=intel").unwrap();
    assert_eq!(route.1.origin(), base.origin());
    assert!(nas_route(&base, "PUT", "/api/v1/sales/configurations/id").is_none());
    assert!(nas_route(&base, "PUT", "/api/v1/operations/configurations/%2e%2e/me").is_none());
    assert!(nas_route(&base, "POST", "https://outside.example/api/v1/operations/configurations").is_none());
    assert!(nas_route(&base, "GET", "/api/v1//outside.example").is_none());
}

#[cfg(test)]
#[test]
fn production_nas_endpoint_and_recovery_keys_do_not_overlap_trial() {
    let trial=nas_base("https://192.168.50.10:18443/").unwrap();
    let formal=nas_base("https://192.168.50.10:19443/").unwrap();
    let wrong=nas_base("https://example.invalid:19443/").unwrap();
    assert!(!production_nas_endpoint(&trial)&&!production_nas_endpoint(&wrong)&&production_nas_endpoint(&formal));
    assert_eq!(nas_endpoint_id(&trial,None),format!("{:x}",Sha256::digest(trial.as_str().as_bytes())));
    assert!(valid_nas_deployment("intel-production-v1")&&!valid_nas_deployment("intel-production-v1\n"));
    assert_ne!(nas_endpoint_id(&formal,Some("intel-production-v1")),nas_endpoint_id(&formal,Some("intel-production-v2")));
    assert_ne!(nas_endpoint_id(&formal,Some("intel-production-v1")),nas_endpoint_id(&trial,None));
}

#[tauri::command]
// 由固定 NAS 入口承接试验配置操作，响应、凭据和异常经过原生边界。
pub async fn nas_native_request(
    method: String,
    route: String,
    body: Option<String>,
    expected_actor: Option<(String, String)>,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let runtime = Arc::clone(runtime.inner());
    if method == "GET" && route == "/settings" {
        let endpoint_id = runtime.nas.as_ref().map(|url|nas_endpoint_id(url,runtime.nas_deployment.as_deref()));
        return Ok(response(200, json!({"configured":runtime.nas.is_some(),"endpoint_id":endpoint_id,"main_editor":runtime.nas_main,"deployment_id":runtime.nas_deployment,"acceptance":cfg!(feature="nas-acceptance")})));
    }
    let rejected = |status, code| Ok(response(status, json!({"ok":false,"error":code})));
    let Some(base) = &runtime.nas else { return rejected(400, "NAS_NOT_CONFIGURED"); };
    let Some((method, url)) = nas_route(base, &method, &route) else { return rejected(400, "INVALID_REQUEST"); };
    if (method == reqwest::Method::GET) != body.is_none() ||
        body.as_ref().is_some_and(|s| s.len() > 1024 * 1024) ||
        (method != reqwest::Method::GET && expected_actor.is_none()) {
        return rejected(400, "INVALID_REQUEST");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_identity) = runtime.identity_gate.read() else {
            return response(503, json!({"ok":false,"error":"NETWORK_OR_RESPONSE_ERROR"}));
        };
        match runtime.transport.nas_request(url, method, body.map(|s|("application/json".into(),s.into_bytes())), expected_actor) {
            Ok((status, value)) => response(status, value),
            Err((status, code)) => response(status, json!({"ok":false,"error":code})),
        }
    }).await.map_err(|_| "NAS 原生请求异常".into())
}

#[tauri::command]
// 原图通过固定 NAS 上传路由发送原始字节；登录令牌和目标地址不交给前端。
pub async fn nas_upload_request(
    mime: String,
    shop_id: Option<String>,
    operation_id: String,
    base64: String,
    expected_actor: (String,String),
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    use base64::Engine;
    const LIMIT: usize=24*1024*1024;
    let runtime=Arc::clone(runtime.inner());
    let Some(base)=runtime.nas.as_ref().filter(|_|runtime.nas_main) else {
        return Ok(response(403,json!({"ok":false,"error":"NAS_NOT_CONFIGURED"})));
    };
    // 本机只允许固定店铺；当前账号能否上传仍由 NAS 服务核验。
    let shop = shop_id.as_deref().unwrap_or("intel");
    if !matches!(shop,"intel"|"gigabyte"|"jonsbo") || !matches!(mime.as_str(),"image/png"|"image/jpeg") || operation_id.len()!=36||
        uuid::Uuid::parse_str(&operation_id).is_err() || base64.len()>LIMIT.div_ceil(3)*4 {
        return Ok(response(400,json!({"ok":false,"error":"INVALID_IMAGE"})));
    }
    let mut url=base.join("/api/v1/operations/catalog/assets").map_err(|_|"NAS 图片地址无效")?;
    url.query_pairs_mut().append_pair("shop_id",shop).append_pair("operation_id",&operation_id);
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_identity)=runtime.identity_gate.read() else {
            return response(503,json!({"ok":false,"error":"NETWORK_OR_RESPONSE_ERROR"}));
        };
        let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(base64) else {
            return response(400,json!({"ok":false,"error":"INVALID_IMAGE"}));
        };
        if bytes.is_empty()||bytes.len()>LIMIT {return response(400,json!({"ok":false,"error":"INVALID_IMAGE"}));}
        match runtime.transport.nas_request(url,reqwest::Method::POST,Some((mime,bytes)),Some(expected_actor)){
            Ok((status,value))=>response(status,value),
            Err((status,code))=>response(status,json!({"ok":false,"error":code})),
        }
    }).await.map_err(|_|"NAS 图片请求异常".into())
}

#[tauri::command]
// 独立 NAS 启动的账号入口只保留原认证动作，不装配或调用本机工作区和旧同步检查点。
pub async fn nas_identity_request(
    action: String,
    payload_json: String,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let authenticate = || -> Result<Value,String> {
            if !runtime.nas_main { return Err("当前不是 NAS 主工作区".into()); }
            if payload_json.len()>16*1024 { return Err("登录请求过大".into()); }
            let payload = parse_payload(&payload_json)?;
            match action.as_str() {
                "status"=>Ok(json!({"session":runtime.transport.status()?})),
                "login"=>{
                    let _gate = runtime.identity_gate.write().map_err(|_|"登录状态异常")?;
                    runtime.check_nas_profile()?;
                    runtime.transport.login_with_remember(payload["username"].as_str().ok_or("请输入账号")?,
                        payload["password"].as_str().ok_or("请输入密码")?,payload["remember"].as_bool().unwrap_or(false))
                }
                "resume"=>{
                    let _gate = runtime.identity_gate.write().map_err(|_|"登录状态异常")?;
                    runtime.check_nas_profile()?;
                    runtime.transport.resume()
                }
                "logout"=>runtime.transport.logout(),
                _=>Err("NAS 模式不允许旧同步操作".into()),
            }
        };
        match authenticate(){Ok(value)=>response(200,value),Err(message)=>response(400,json!({"error":message}))}
    }).await.map_err(|_| "NAS 登录请求异常".into())
}
fn response(status: u16, value: Value) -> ApiResponse {
    ApiResponse {
        status,
        body: value.to_string(),
    }
}
// 核对固定 NAS 上的现有运营身份，ERP 查询前后都检查；只读过程不持有账号锁。
async fn verify_nas_reader(runtime: Arc<CloudRuntime>, actor: (String,String), shop: String) -> Result<(),String>{
    tauri::async_runtime::spawn_blocking(move ||{
        let _gate=runtime.identity_gate.read().map_err(|_|"登录状态异常")?;
        let target=runtime.nas.as_ref().filter(|_|runtime.nas_main).ok_or("当前不是 NAS 工作区")?.join("/api/v1/me")
            .map_err(|_|"NAS 地址无效")?;
        let (status,me)=runtime.transport.nas_request(target,reqwest::Method::GET,None,Some(actor.clone()))
            .map_err(|_|"请核对当前 NAS 运营身份")?;
        let capability=if let Some(map)=me.get("shop_capabilities") { &map[shop.as_str()] } else if shop=="intel" { &me } else { &Value::Null };
        let role_ok=me["shops"].as_array().is_some_and(|rows|rows.iter().any(|row|row["shop_id"].as_str()==Some(shop.as_str())&&row["role"]=="operations"));
        if status!=200||me["uid"].as_str()!=Some(actor.1.as_str())||me["workspace_id"].as_str()!=Some(actor.0.as_str())||
            !role_ok||capability["workspace_writes"]!=true {
            return Err("原账号已变化或没有本店运营权限".into());
        }
        Ok(())
    }).await.map_err(|_|"NAS 身份核验异常")?
}

#[tauri::command]
pub async fn nas_erp_read(
    kind: String,
    shop_id: Option<String>,
    goods_ids: Vec<String>,
    connection: Option<Value>,
    expected_actor: (String,String),
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
    worker: tauri::State<'_, crate::erp_session::ErpSessionState>,
) -> Result<ApiResponse,String>{
    // 只开放固定只读查询和原生文件选择；英特尔对外报价表不用于其他店铺。
    let shop=shop_id.unwrap_or_else(||"intel".into());
    if !matches!(shop.as_str(),"intel"|"gigabyte"|"jonsbo")||(kind=="quote-file"&&shop!="intel")||
        !matches!(kind.as_str(),"erp"|"erp-saved"|"erp-status"|"erp-clear"|"erp-form"|"tax-file"|"tax-status"|"tax-choose"|"tax-read"|"tax-current"|"quote-file")||
        matches!(kind.as_str(),"erp-form"|"tax-read")!=connection.is_some()||goods_ids.len()>5000||
        goods_ids.iter().any(|id|id.is_empty()||id.len()>20||!id.bytes().all(|c|c.is_ascii_digit())) {
        return Err("ERP 查询范围无效".into());
    }
    let runtime=Arc::clone(runtime.inner());
    verify_nas_reader(Arc::clone(&runtime),expected_actor.clone(),shop.clone()).await?;
    let scope_data=(runtime.nas.as_ref().map(|url|url.as_str()),runtime.nas_deployment.as_deref(),&expected_actor);
    // 英特尔保留既有连接范围；新店独立存储连接与所选工作簿。
    let scope_bytes=if shop=="intel" { serde_json::to_vec(&scope_data) } else { serde_json::to_vec(&(scope_data,&shop)) };
    let scope=format!("{:x}",Sha256::digest(scope_bytes.map_err(|_|"本机连接范围无效")?));
    let worker=worker.inner();
    if matches!(kind.as_str(),"erp-status"|"erp-clear") {
        let action=if kind=="erp-status"{"sql_credentials_status"}else{"sql_credentials_clear"};
        let value=worker.nas_form_request(&scope,json!({"action":action})).await?;
        verify_nas_reader(runtime,expected_actor,shop.clone()).await?;
        return Ok(response(200,json!({"ok":true,"saved":value["saved"]==true,"settings":value["settings"]})));
    }
    let tax_preference=||worker.nas_scope_dir(&scope).map(|directory|directory.join("cost-workbook.json"));
    if kind=="tax-status" {
        let settings=nas_cost_preference(&tax_preference()?)?;
        verify_nas_reader(runtime,expected_actor,shop.clone()).await?;
        return Ok(response(200,json!({"ok":true,"settings":settings})));
    }
    let mut workbook_info=Value::Null;
    let result=if kind=="erp-saved"{
        // 只能从原生文件对话框选择，页面不能提交凭据或磁盘路径。
        let file=tauri::async_runtime::spawn_blocking(||rfd::FileDialog::new()
            .set_title("选择原工作台保存的 ERP 只读连接（sql-credentials.dpapi.json）")
            .add_filter("加密连接文件",&["json"]).pick_file()).await.map_err(|_|"打开文件选择器失败")?;
        let Some(path)=file else{return Ok(response(200,json!({"ok":true,"cancelled":true})));};
        verify_nas_reader(Arc::clone(&runtime),expected_actor.clone(),shop.clone()).await?;
        worker.nas_read_selected_vault(&path).await?
    } else if kind=="erp"{worker.nas_form_request(&scope,json!({"action":"sql_read_nas"})).await?}
    else if kind=="erp-form"{
        let input=nas_erp_form(connection.as_ref().ok_or("请填写公司数据库连接")?)?;
        worker.nas_form_request(&scope,input).await?
    }else{
        let quote=kind=="quote-file";
        let mut workbook=match kind.as_str(){
            "tax-current"=>nas_current_cost_workbook(&tax_preference()?)?,
            "tax-read"=>nas_cost_preference(&tax_preference()?)?,
            _=>NasCostWorkbook::default(),
        };
        let read_existing=matches!(kind.as_str(),"tax-read"|"tax-current");
        let file=if read_existing{workbook.path.clone()}else{tauri::async_runtime::spawn_blocking(move||if quote{
            rfd::FileDialog::new().set_title("选择英特尔主机维护表").add_filter("维护表",&["xlsb"]).pick_file()
        }else{rfd::FileDialog::new().set_title("选择当前店铺含税成本表").add_filter("Excel 表格",&["xlsb","xlsx"]).pick_file()})
            .await.map_err(|_|"打开文件选择器失败")?};
        if read_existing&&file.is_none(){return Err("请在 ERP 资料中选择主机成本表".into());}
        let Some(path)=file else{return Ok(response(200,json!({"ok":true,"cancelled":true})));};
        verify_nas_reader(Arc::clone(&runtime),expected_actor.clone(),shop.clone()).await?;
        if kind=="tax-choose" {
            workbook.path=Some(path);
            save_nas_cost_preference(&tax_preference()?,&workbook)?;
            return Ok(response(200,json!({"ok":true,"settings":workbook})));
        }
        let input=if quote{json!({"action":"nas_quotation_file","settings":{"path":path.to_string_lossy()}})}
        // 修复版以 M 列商品 ID 匹配 Z 列主机含税成本，不能读取 AA 列单品含税。
        else{
            if let Some(layout)=connection.as_ref(){workbook.apply_layout(layout)?;}
            if path.file_name().is_some_and(|name|name=="主机成本表V2新_修复版.xlsb")&&(workbook.sheet!="库存数据"||workbook.goods_column!=13||workbook.tax_column!=26){return Err("修复版请使用库存数据工作表和 M / Z 列".into());}
            json!({"action":"sql_cost_file","settings":{"mode":"nas","path":path.to_string_lossy(),"sheet":workbook.sheet,"goodsColumn":workbook.goods_column,"taxColumn":workbook.tax_column}})
        };
        let rows=worker.sql_request(input).await?;
        if kind=="tax-current"{
            let modified=fs::metadata(&path).and_then(|file|file.modified()).ok()
                .and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok()).map(|elapsed|elapsed.as_millis() as u64);
            workbook_info=json!({"name":path.file_name().and_then(|name|name.to_str()),"modified":modified});
        }
        if kind=="tax-read"{save_nas_cost_preference(&tax_preference()?,&workbook)?;}
        rows
    };
    verify_nas_reader(runtime,expected_actor,shop.clone()).await?;
    if kind=="quote-file"{
        return Ok(response(200,json!({"ok":true,"rows":result["rows"],"workbook_sha256":result["workbook_sha256"],
            "invalidCount":result["invalidCount"].as_u64().unwrap_or(0)})));
    }
    let wanted=goods_ids.into_iter().collect::<BTreeSet<_>>();
    let rows=result["rows"].as_array().ok_or("ERP 查询返回无效")?.iter().filter(|row|
        row[if matches!(kind.as_str(),"erp"|"erp-saved"|"erp-form"){"goodsId"}else{"goods_id"}].as_str().is_some_and(|id|wanted.contains(id))).collect::<Vec<_>>();
    Ok(response(200,json!({"ok":true,"rows":rows,"settings":result["settings"],"workbook":workbook_info,"invalidCount":result["invalidCount"].as_u64().unwrap_or(0)})))
}

// 设置白名单避免把未知字段、路径、SQL 或原始校验错误带进凭据存储。
fn nas_erp_form(value:&Value)->Result<Value,String>{
    let form=value.as_object().ok_or("请填写公司数据库连接")?;
    let settings=value["settings"].as_object().ok_or("请填写公司数据库连接")?;
    let keys=["server","port","database","user","encrypt","trustServerCertificate"];
    if form.len()!=3||form.keys().any(|key|!matches!(key.as_str(),"settings"|"password"|"remember"))||
       settings.len()!=keys.len()||settings.keys().any(|key|!keys.contains(&key.as_str()))||
       ["server","database","user"].iter().any(|key|!settings[*key].as_str().is_some_and(|text|!text.trim().is_empty()&&text.len()<=800&&!text.contains('\0')))||
       !value["password"].as_str().is_some_and(|text|!text.is_empty()&&text.len()<=4096&&!text.contains('\0'))||
       !value["remember"].is_boolean(){return Err("公司数据库连接参数无效".into());}
    Ok(json!({"action":"sql_read_nas_form","settings":value["settings"],"password":value["password"],"remember":value["remember"]}))
}

// 文件路径只来自原生选择；用户可为其他模板调整读取列，修复版继续采用 M/Z。
#[derive(serde::Deserialize,serde::Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct NasCostWorkbook { path:Option<std::path::PathBuf>,sheet:String,goods_column:u64,tax_column:u64 }
impl Default for NasCostWorkbook {
    fn default()->Self{Self{path:None,sheet:"库存数据".into(),goods_column:13,tax_column:26}}
}
impl NasCostWorkbook {
    fn apply_layout(&mut self,value:&Value)->Result<(),String>{
        let fields=value.as_object().ok_or("成本表列设置无效")?;
        if fields.len()!=3||fields.keys().any(|name|!matches!(name.as_str(),"sheet"|"goodsColumn"|"taxColumn")){return Err("成本表列设置无效".into());}
        let sheet=value["sheet"].as_str().filter(|v|!v.trim().is_empty()&&v.chars().count()<=31).ok_or("工作表名称无效")?;
        let col=|name|value[name].as_u64().filter(|n|(1..=16384).contains(n)).ok_or("成本表列超出 Excel 范围");
        let goods=col("goodsColumn")?;let tax=col("taxColumn")?;
        if goods==tax{return Err("商品编号和含税成本不能在同一列".into());}
        self.sheet=sheet.trim().into();self.goods_column=goods;self.tax_column=tax;Ok(())
    }
}
fn nas_cost_preference(preference:&std::path::Path)->Result<NasCostWorkbook,String>{
    let file=match fs::File::open(preference){Ok(file)=>file,Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(NasCostWorkbook::default()),Err(_)=>return Err("读取本机成本表设置失败".into())};
    let mut data=Vec::new();file.take(8193).read_to_end(&mut data).map_err(|_|"读取本机成本表设置失败")?;
    if data.len()>8192{return Err("本机成本表设置无效".into());}
    let settings:NasCostWorkbook=serde_json::from_slice(&data).map_err(|_|"本机成本表设置无效")?;
    if settings.path.as_deref().is_some_and(|path|!valid_nas_cost_path(path)){return Err("原成本表路径不可用，请重新选择 Excel 文件".into());}
    Ok(settings)
}
// 共用文件路径来自本机配置。每次打开都读取已保存的工作簿，摘要有变化即重新解析。
fn nas_current_cost_workbook(preference:&std::path::Path)->Result<NasCostWorkbook,String>{
    let root=preference.ancestors().nth(3).ok_or("找不到本机成本表目录")?;
    let settings=nas_cost_preference(&root.join("nas-host-cost-workbook.json"))?;
    if settings.path.is_some(){return Ok(settings);}
    nas_cost_preference(preference)
}
fn valid_nas_cost_path(path:&std::path::Path)->bool{
    path.is_absolute()&&path.extension().and_then(|x|x.to_str()).is_some_and(|ext|["xlsb","xlsx"].iter().any(|a|ext.eq_ignore_ascii_case(a)))
}
fn save_nas_cost_preference(preference:&std::path::Path,settings:&NasCostWorkbook)->Result<(),String>{
    if !settings.path.as_deref().is_some_and(|path|valid_nas_cost_path(path)&&path.is_file()){return Err("请选择可读 Excel 文件".into());}
    let directory=preference.parent().ok_or("没有本机成本表目录")?;
    fs::create_dir_all(directory).map_err(|_|"无法建立成本表设置目录")?;
    let staged=directory.join(format!("cost-workbook.{}.tmp",uuid::Uuid::new_v4()));
    let data=serde_json::to_vec(settings).map_err(|_|"成本表路径无效")?;
    fs::write(&staged,data).map_err(|_|"保存成本表设置失败")?;
    fs::rename(staged,preference).map_err(|_|"保存成本表设置失败".into())
}
// 仅使用原生传输层已验证的成员身份，不能以页面传入值替代。
fn member(runtime: &CloudRuntime) -> Result<Value, String> {
    // 本地模式不能通过加载或绑定入口间接触发云操作。
    if runtime.transport.status()?["configured"] == false {
        return Err(CLOUD_NOT_CONFIGURED.into());
    }
    runtime
        .transport
        .current_member()?
        .ok_or_else(|| "请先登录成员账号".into())
}

// 原图必须使用 SHA-256 文件名和允许的扩展名，不能接受任意路径或地址。
fn asset_name(url: &str) -> Result<&str, String> {
    let name = url.strip_prefix("/uploads/").ok_or("原图路径无效")?;
    let (hash, ext) = name.split_once('.').ok_or("原图路径无效")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !["png", "jpg"].contains(&ext)
    {
        return Err("原图路径无效".into());
    }
    Ok(name)
}
// 验证非空原图、大小上限和内容摘要，命名一致才可复用已有缓存。
fn verified(name: &str, bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len() <= 24 * 1024 * 1024
        && name.split('.').next() == Some(format!("{:x}", Sha256::digest(bytes)).as_str())
}
// 先校验再暂存并同步落盘；同名文件只有内容正确时可复用，不覆盖异常文件。
fn cache_bytes(store: &WorkbenchStore, name: &str, bytes: &[u8]) -> Result<(), String> {
    if !verified(name, bytes) {
        return Err("原图内容校验失败".into());
    }
    let root = store.assets.join("uploads");
    fs::create_dir_all(&root).map_err(|_| "无法创建原图缓存目录")?;
    let target = root.join(name);
    if target.exists() {
        let current = fs::read(&target).map_err(|_| "无法读取已有原图")?;
        if verified(name, &current) {
            return Ok(());
        }
        return Err("本机已有同名原图校验失败，请检查；未覆盖原文件".into());
    }
    let temporary = root.join(format!(".cloud-{}.partial", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法暂存原图")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "原图暂存失败，未替换已有图片")?;
    drop(file);
    // MoveFileW is atomic and never replaces a concurrently created destination.
    // Failed staging files remain available for recoverable cleanup.
    if install_staged(&temporary, &target).is_err()
        && !fs::read(&target).is_ok_and(|current| verified(name, &current))
    {
        return Err("原图缓存安装未完成，请重试；已保留暂存文件".into());
    }
    Ok(())
}

// Windows 原子安装暂存图且不覆盖并发创建的目标；失败时保留暂存内容。
fn install_staged(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
        }
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both paths are generated under the validated content-addressed cache root.
        if unsafe { MoveFileW(source.as_ptr(), destination.as_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}
// 按环境、工作区和文件名记录已验证的云端原图，避免跨账号复用上传确认。
fn asset_db(store: &WorkbenchStore) -> Result<Connection, String> {
    let c = Connection::open(&store.path).map_err(|e| e.to_string())?;
    c.busy_timeout(Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS workbench_cloud_assets(environment TEXT NOT NULL,workspace TEXT NOT NULL,name TEXT NOT NULL,verified_at TEXT NOT NULL,PRIMARY KEY(environment,workspace,name))").map_err(|e|e.to_string())?;
    Ok(c)
}
// 本机有合格原图时直接复用；上传确认只在云端可用且成员身份未变化后登记。
fn ensure_one(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    owner: &Value,
    url: &str,
    upload: bool,
    check_cancel: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check_cancel()?;
    let name = asset_name(url)?;
    let workspace = owner["workspaceId"].as_str().ok_or("成员工作区无效")?;
    let file = store.assets.join("uploads").join(name);
    let local = if file.exists() {
        if fs::metadata(&file).map_err(|_| "无法读取本机原图")?.len() > 24 * 1024 * 1024 {
            return Err("本机原图超过24MiB".into());
        }
        let bytes = fs::read(&file).map_err(|_| "无法读取本机原图")?;
        if !verified(name, &bytes) {
            return Err("本机原图摘要与文件名不一致".into());
        }
        Some(bytes)
    } else {
        None
    };
    if !upload && local.is_some() {
        return Ok(());
    }
    if upload {
        let c = asset_db(store)?;
        let cached:Option<i64>=c.query_row("SELECT 1 FROM workbench_cloud_assets WHERE environment=?1 AND workspace=?2 AND name=?3",params![runtime.transport.environment(),workspace,name],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if cached.is_some() && local.is_some() {
            return Ok(());
        }
    }
    check_cancel()?;
    match runtime.transport.storage_get(name) {
        Ok(bytes) => cache_bytes(store, name, &bytes)?,
        Err(error) if upload && error.starts_with("STORAGE_NOT_FOUND:") => {
            check_cancel()?;
            let bytes = local.ok_or("本机和云端均缺少原图，已停止提交配置")?;
            runtime.transport.storage_upload(
                name,
                &bytes,
                if name.ends_with(".png") {
                    "image/png"
                } else {
                    "image/jpeg"
                },
            )?;
        }
        Err(error) => return Err(error),
    }
    if runtime
        .transport
        .current_member()?
        .as_ref()
        .is_none_or(|current| {
            current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"]
        })
    {
        return Err("登录成员已变化，未确认原图上传".into());
    }
    if upload {
        check_cancel()?;
        asset_db(store)?
            .execute(
                "INSERT OR REPLACE INTO workbench_cloud_assets VALUES(?1,?2,?3,?4)",
                params![
                    runtime.transport.environment(),
                    workspace,
                    name,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
// 去重并校验原图列表，绑定当前成员与取消代次，再以最多四路并发补齐图片。
fn ensure_assets(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    payload: &Value,
    upload: bool,
) -> Result<Value, String> {
    let operation = asset_operation(payload)?;
    let epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
    let check_cancel = || check_asset_operation(runtime, &operation, epoch);
    check_cancel()?;
    let _assets = runtime.assets_gate.lock().map_err(|_| "原图任务状态异常")?;
    check_cancel()?;
    let owner = member(runtime)?;
    workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
    let urls = payload["urls"].as_array().ok_or("原图列表无效")?;
    if urls.len() > 20000 {
        return Err("原图列表超过允许上限".into());
    }
    let urls: Vec<String> = urls
        .iter()
        .map(|v| {
            let s = v.as_str().ok_or("原图路径无效")?;
            asset_name(s)?;
            Ok(s.to_string())
        })
        .collect::<Result<BTreeSet<_>, String>>()?
        .into_iter()
        .collect();
    bounded_assets(&urls, |url| {
        check_cancel()?;
        ensure_one(runtime, store, &owner, url, upload, &check_cancel)
    })?;
    check_cancel()?;
    Ok(json!({"ok":true,"images":urls.len(),"concurrency":4}))
}

fn asset_operation(payload: &Value) -> Result<String, String> {
    let value = payload["operationId"].as_str().ok_or("原图任务ID无效")?;
    Ok(uuid::Uuid::parse_str(value)
        .map_err(|_| "原图任务ID无效".to_string())?
        .to_string())
}

// 全局取消代次与单任务取消记录任一变化都停止后续工作，已验证缓存仍保留。
fn check_asset_operation(
    runtime: &CloudRuntime,
    operation: &str,
    epoch: u64,
) -> Result<(), String> {
    if runtime.asset_cancel_epoch.load(Ordering::SeqCst) != epoch
        || runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?
            .contains(operation)
    {
        return Err("原图任务已暂停，已验证并缓存的图片保留在本机".into());
    }
    Ok(())
}

// 四个线程共享任务游标；遇错停止领取新图片，并等待已经开始的任务收尾。
fn bounded_assets(
    urls: &[String],
    task: impl Fn(&str) -> Result<(), String> + Sync,
) -> Result<(), String> {
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let error = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..urls.len().min(4) {
            let task = &task;
            let next = &next;
            let stopped = &stopped;
            let error = &error;
            scope.spawn(move || {
                while !stopped.load(Ordering::SeqCst) {
                    let position = next.fetch_add(1, Ordering::SeqCst);
                    let Some(url) = urls.get(position) else {
                        break;
                    };
                    if let Err(message) = task(url) {
                        stopped.store(true, Ordering::SeqCst);
                        if let Ok(mut error) = error.lock() {
                            *error = Some(message);
                        }
                        break;
                    }
                }
            });
        }
    });
    match error.into_inner().map_err(|_| "原图任务状态异常")? {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// First connection is local only: use the verified migration seed when present,
/// otherwise bind only a factory-empty workspace for downloading existing records.
/// Never derive publish records from unbound business data or renderer paths/tokens.
// 有准备文件时保留迁移流程；无准备文件只允许全新空库从当前成员下载云端已有数据。
fn connect_seed(
    store: &WorkbenchStore,
    owner: &Value,
    check_session: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check_session()?;
    let status = workbench_store::cloud_checkpoint_status(store)?;
    if status["initialized"] == true {
        workbench_store::cloud_checkpoint_authorize(store, owner, None)?;
        return Ok(
            json!({"ok":true,"connected":true,"initialized":true,"imported":false,"checkpoint":status}),
        );
    }
    let path = store
        .path
        .parent()
        .ok_or("本机数据目录无效")?
        .join("cloud-bootstrap.json");
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let status = workbench_store::cloud_checkpoint_bind_empty(store, owner, check_session)?;
            return Ok(json!({"ok":true,"connected":true,"initialized":true,"imported":false,"checkpoint":status}));
        }
        Err(_) => return Err("无法读取本机同步准备信息，数据已保留。".into()),
    };
    let mut bytes = Vec::new();
    file.take(512 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取本机同步准备信息")?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("本机同步准备信息超过大小限制".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let plan: Value =
        serde_json::from_slice(&bytes).map_err(|_| "本机同步准备信息无效，数据已保留。")?;
    drop(bytes);
    workbench_store::cloud_checkpoint_preview_plan(store, &plan, owner).map_err(connect_error)?;
    check_session()?;
    // apply rechecks member, raw local-state hash and revision under IMMEDIATE
    // transaction, then backs up before changing state/queue atomically.
    workbench_store::cloud_checkpoint_apply_plan(store, &plan, owner, &hash)
        .map_err(connect_error)?;
    drop(plan);
    let status = workbench_store::cloud_checkpoint_status(store)?;
    Ok(json!({"ok":true,"connected":true,"initialized":true,"imported":true,"checkpoint":status}))
}

fn connect_error(message: String) -> String {
    if message.contains("成员不一致") {
        return "当前账号与本机数据所属成员不一致，请登录原成员账号。".into();
    }
    if message.contains("对应的数据已变化") {
        return "本机数据已更新，同步准备信息已过期；修改已保留，请更新工作台后重试。".into();
    }
    message.replace("接入计划", "同步准备信息")
}

// 登录独占身份门，普通操作共享身份门；退出只推进取消代次，不等待慢网络返回。
fn dispatch(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    action: &str,
    payload: Value,
) -> Result<ApiResponse, String> {
    if action == "assetsCancel" {
        let operation = asset_operation(&payload)?;
        let mut cancelled = runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?;
        if cancelled.len() >= 10000 && !cancelled.contains(&operation) {
            return Err("原图取消记录达到上限，请重新登录后继续".into());
        }
        cancelled.insert(operation.clone());
        return Ok(response(
            200,
            json!({"ok":true,"cancelled":true,"operationId":operation}),
        ));
    }
    let epoch = runtime.epoch.load(Ordering::SeqCst);
    if action == "logout" {
        // Never wait for an identity reader/network or an in-flight SQLite transaction.
        runtime.epoch.fetch_add(1, Ordering::SeqCst);
        runtime.asset_cancel_epoch.fetch_add(1, Ordering::SeqCst);
        runtime
            .cancelled_assets
            .lock()
            .map_err(|_| "原图任务状态异常")?
            .clear();
        let value = runtime.transport.logout()?;
        if let Ok(mut plan) = runtime.plan.try_lock() {
            *plan = None;
        }
        if let Ok(mut legacy) = runtime.legacy.try_lock() { *legacy = None; }
        return Ok(response(200, value));
    }
    if action == "login" {
        let _identity = runtime.identity_gate.write().map_err(|_| "登录状态异常")?;
        if runtime.epoch.load(Ordering::SeqCst) != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        let value = runtime.transport.login_with_remember(
            payload["username"].as_str().ok_or("请输入账号")?,
            payload["password"].as_str().ok_or("请输入密码")?,
            payload.get("remember").and_then(Value::as_bool).unwrap_or(false),
        )?;
        if runtime.epoch.load(Ordering::SeqCst) != epoch {
            return Err("登录已取消，请重新登录".into());
        }
        runtime.epoch.fetch_add(1, Ordering::SeqCst);
        *runtime.plan.lock().map_err(|_| "接入计划状态异常")? = None;
        *runtime.legacy.lock().map_err(|_| "迁移状态异常")? = None;
        return Ok(response(200, value));
    }
    let _identity = runtime.identity_gate.read().map_err(|_| "登录状态异常")?;
    if runtime.epoch.load(Ordering::SeqCst) != epoch {
        return Err("云同步操作已取消".into());
    }
    let result = dispatch_bound(runtime, store, action, payload, epoch)?;
    if runtime.epoch.load(Ordering::SeqCst) != epoch {
        return Err("登录状态已变化，本机数据已保留".into());
    }
    Ok(result)
}

// 在固定登录代次下路由云业务和本机检查点，持久请求校验通过后才允许发送。
fn dispatch_bound(
    runtime: &CloudRuntime,
    store: &WorkbenchStore,
    action: &str,
    payload: Value,
    epoch: u64,
) -> Result<ApiResponse, String> {
    let value = match action {
        "firstUseStatus" => {
            if payload.as_object().is_none_or(|object| !object.is_empty()) {
                return Err("首次使用检查不接受其他参数".into());
            }
            member(runtime)?;
            workbench_store::cloud_first_use_status(store)?
        }
        "migrateLegacy" => {
            if payload.as_object().is_none_or(|object| !object.is_empty()) {
                return Err("迁移仅接受本机目录选择，不接受路径参数".into());
            }
            let _connect = runtime.connect_gate.lock().map_err(|_| "同步连接状态异常")?;
            *runtime.legacy.lock().map_err(|_| "迁移状态异常")? = None;
            let owner = member(runtime)?;
            if workbench_store::cloud_first_use_status(store)?["required"] != true {
                return Err("当前目录已包含数据或同步准备信息，不能再次迁移".into());
            }
            let Some(path) = rfd::FileDialog::new().set_title("选择旧版程序的 data 目录（请先退出旧版程序）").pick_folder() else {
                return Ok(response(200, json!({"cancelled":true})));
            };
            let prepared = workbench_store::cloud_prepare_legacy(store, &path, &owner, || {
                if runtime.epoch.load(Ordering::SeqCst) != epoch { return Err("迁移已取消，原数据保持不变".into()); }
                let current = member(runtime)?;
                if current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"] { return Err("登录成员已变化，迁移未提交".into()); }
                Ok(())
            })?;
            let preview = prepared.preview();
            *runtime.legacy.lock().map_err(|_| "迁移状态异常")? = Some((epoch, prepared));
            preview
        }
        "migrateLegacyApply" => {
            let _connect = runtime.connect_gate.lock().map_err(|_| "同步连接状态异常")?;
            let mut guard = runtime.legacy.lock().map_err(|_| "迁移状态异常")?;
            let (prepared_epoch, prepared) = guard.as_ref().ok_or("迁移准备已过期，请重新选择旧版目录")?;
            if *prepared_epoch != epoch { return Err("登录状态已变化，请重新选择旧版目录".into()); }
            let owner = member(runtime)?;
            let result = workbench_store::cloud_apply_legacy(store, prepared, &payload, &owner, || {
                if runtime.epoch.load(Ordering::SeqCst) != epoch { return Err("迁移已取消，原数据保持不变".into()); }
                let current = member(runtime)?;
                if current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"] { return Err("登录成员已变化，迁移未提交".into()); }
                Ok(())
            })?;
            *guard = None;
            result
        }
        "connect" => {
            if payload.as_object().is_none_or(|object| !object.is_empty()) {
                return Err("连接同步不接受路径或其他参数".into());
            }
            let _connect = runtime
                .connect_gate
                .lock()
                .map_err(|_| "同步连接状态异常")?;
            let owner = member(runtime)?;
            connect_seed(store, &owner, || {
                if runtime.epoch.load(Ordering::SeqCst) != epoch {
                    return Err("同步连接已取消，本机数据已保留".into());
                }
                let current = member(runtime)?;
                if current["uid"] != owner["uid"] || current["workspaceId"] != owner["workspaceId"]
                {
                    return Err("登录成员已变化，请重新连接同步".into());
                }
                Ok(())
            })?
        }
        "resume" => runtime.transport.resume()?,
        "status" => {
            json!({"session":runtime.transport.status()?,"checkpoint":workbench_store::cloud_checkpoint_status(store)?})
        }
        "load" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
            // 先转换旧上传引用，再给同步引擎建立基线；不改写已生成的云 mutation。
            workbench_store::normalize_upload_references(store)?;
            return workbench_store::cloud_checkpoint_load(store);
        }
        "commit" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, None)?;
            return workbench_store::cloud_checkpoint_commit(store, &payload);
        }
        "call" => {
            let owner = member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store, &owner, Some(&payload))?;
            runtime.transport.call(payload)?
        }
        "costsPreview" => {
            let owner=member(runtime)?;
            workbench_store::cloud_checkpoint_authorize(store,&owner,None)?;
            let settings=workbench_store::cost_sync::settings(store)?;
            if settings["mode"]!="cloud"{return Err("当前使用本地 NAS 成本，不接收云端成本".into());}
            let started=std::time::Instant::now();let mut cursor=String::new();let mut checkpoint=Value::Null;let mut rows=Vec::new();let mut complete=false;let mut pages=0;
            for _ in 0..100 {
                if runtime.epoch.load(Ordering::SeqCst)!=epoch||started.elapsed().as_secs()>90{return Err("成本读取已取消或超时，未应用任何价格".into());}
                let page=runtime.transport.call(json!({"protocolVersion":2,"action":"costs.page","payload":{"cursor":cursor,"checkpoint":checkpoint,"limit":1000}}))?;
                if page["ok"]!=true{return Err(page["message"].as_str().unwrap_or("云端成本读取失败，请重新读取").into());}
                if page["workspaceId"]!=owner["workspaceId"]{return Err("成本来源工作区不匹配".into());}
                if page["checkpoint"].as_str().is_none_or(|s|s.len()!=32||!s.chars().all(|c|c.is_ascii_hexdigit())){return Err("成本版本标识无效".into());}
                if checkpoint.is_null(){checkpoint=page["checkpoint"].clone();}else if checkpoint!=page["checkpoint"]{return Err("云端成本已变化，请重新读取".into());}
                let next=page["nextCursor"].as_str().ok_or("成本分页游标无效")?;
                let batch=page["rows"].as_array().filter(|r|r.len()<=1000).ok_or("成本分页格式无效")?;
                if !batch.is_empty()&&next<=cursor.as_str(){return Err("成本分页未推进".into());}
                rows.extend(batch.iter().cloned());pages+=1;
                if page["hasMore"]==false{complete=true;break;}
                if page["hasMore"]!=true||batch.is_empty(){return Err("成本分页不完整".into());}cursor=next.to_owned();
            }
            if !complete{return Err("成本目录超过分页上限，未应用任何价格".into());}
            if runtime.epoch.load(Ordering::SeqCst)!=epoch{return Err("登录已变化，成本读取已取消".into());}
            let mut result=workbench_store::cost_sync::preview(store,Value::Array(rows),&settings)?;
            result["pages"]=pages.into();result["elapsedMs"]=(started.elapsed().as_millis() as u64).into();result
        }
        "assetsEnsure" => ensure_assets(runtime, store, &payload, true)?,
        "assetsDownload" => ensure_assets(runtime, store, &payload, false)?,
        "planPreview" => {
            let owner = member(runtime)?;
            // Invoked only by the user's explicit button, never by background work.
            let Some(path) = rfd::FileDialog::new()
                .set_title("选择已核验的云同步接入计划")
                .add_filter("JSON 接入计划", &["json"])
                .pick_file()
            else {
                return Ok(response(200, json!({"cancelled":true})));
            };
            if fs::metadata(&path).map_err(|_| "无法读取接入计划")?.len() > 512 * 1024 * 1024
            {
                return Err("接入计划过大".into());
            }
            let mut bytes = Vec::new();
            fs::File::open(path)
                .map_err(|_| "无法读取接入计划")?
                .take(512 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "无法读取接入计划")?;
            if bytes.len() > 512 * 1024 * 1024 {
                return Err("接入计划过大".into());
            }
            let plan: Value = serde_json::from_slice(&bytes).map_err(|_| "接入计划JSON格式无效")?;
            let summary = workbench_store::cloud_checkpoint_preview_plan(store, &plan, &owner)?;
            let token = format!("{:x}", Sha256::digest(&bytes));
            *runtime.plan.lock().map_err(|_| "接入计划状态异常")? = Some(CachedPlan {
                token: token.clone(),
                bytes,
                document: plan,
                epoch,
            });
            json!({"token":token,"summary":summary})
        }
        "planApply" => {
            let owner = member(runtime)?;
            let mut guard = runtime.plan.lock().map_err(|_| "接入计划状态异常")?;
            let plan = guard.as_ref().ok_or("请先选择并预览接入计划")?;
            if payload["token"].as_str() != Some(plan.token.as_str())
                || plan.epoch != epoch
                || plan.token != format!("{:x}", Sha256::digest(&plan.bytes))
            {
                return Err("接入计划已变化，请重新预览".into());
            }
            let result = workbench_store::cloud_checkpoint_apply_plan(
                store,
                &plan.document,
                &owner,
                &plan.token,
            )?;
            *guard = None;
            return Ok(result);
        }
        _ => return Err("未知云同步操作".into()),
    };
    Ok(response(200, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    // 未配置时 status 与 resume 都保持本地模式，接入动作在身份核验前被拒绝。
    // 正式版缺文件时使用内置认证，另由 embedded_auth_fallback 测试覆盖。
    #[cfg(not(feature = "formal-nas-client"))]
    #[test]
    fn absent_config_status_resume_and_connect_are_local_only() {
        let (store, _, _) = connect_fixture();
        let runtime = CloudRuntime::new(store.path.parent().unwrap()).unwrap();
        for action in ["status", "resume"] {
            let result = dispatch(&runtime, &store, action, json!({})).unwrap();
            let document: Value = serde_json::from_str(&result.body).unwrap();
            let session = if action == "status" {
                &document["session"]
            } else {
                &document
            };
            assert_eq!(session["configured"], false);
            assert_eq!(session["authenticated"], false);
        }
        assert_eq!(
            dispatch(&runtime, &store, "connect", json!({})).unwrap_err(),
            CLOUD_NOT_CONFIGURED
        );
    }

    fn connect_fixture() -> (WorkbenchStore, Value, Value) {
        let empty = store();
        let root = empty.path.parent().unwrap();
        let initial = root.join("initial.json");
        fs::write(&initial,json!({"revision":7,"configs":[{"id":"a","name":"old","parts":[]}],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{},"logs":[]}).to_string()).unwrap();
        let store = workbench_store::initialize(&empty.path, &initial, &empty.assets).unwrap();
        let c = Connection::open(&store.path).unwrap();
        let raw: String = c
            .query_row(
                "SELECT document FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut after: Value = serde_json::from_str(&raw).unwrap();
        after["configs"][0]["name"] = json!("old-pending-kept");
        let mut records = vec![
            json!({"type":"configuration","id":"a","version":2,"base":{"id":"a","name":"old"},"draft":{"id":"a","name":"old-pending-kept"},"conflict":null}),
        ];
        for n in 0..30 {
            let row = json!({"id":format!("old-deleted-{n}"),"name":"old deleted fixture","parts":[],"deletedAt":"2026-10-12T00:00:00Z"});
            after["configs"].as_array_mut().unwrap().push(row.clone());
            records.push(json!({"type":"configuration","id":row["id"],"version":2,"base":row,"draft":row,"conflict":null}));
        }
        let owner =
            json!({"uid":"fixture-member","workspaceId":"fixture-workspace","name":"测试成员"});
        let outbox = json!([{"protocolVersion":2,"action":"sync.push","requestId":"original-request","payload":{"mutationId":"original-mutation","deviceId":"original-device","entityType":"configuration","entityId":"a","baseVersion":2,"after":{"id":"a","name":"old-pending-kept"}}}]);
        let plan = json!({"format":1,"ready":true,"origin":"cutover-preflight","nativeTargetStateSha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"nativeBaseRevision":7,
            "member":{"uid":owner["uid"],"workspaceId":owner["workspaceId"],"deviceId":"new-device"},"state":after,"cursor":5,"records":records,"outbox":outbox,"materializedProjection":[],
            "oldSourceSnapshotSha256":"frozen-fixture-only","resolutionPolicy":{"kind":"keep-old-deleted-record","authorizedByUser":true}});
        (store, owner, plan)
    }
    fn write_connect_seed(store: &WorkbenchStore, plan: &Value) -> Vec<u8> {
        let bytes = serde_json::to_vec_pretty(plan).unwrap();
        fs::write(
            store.path.parent().unwrap().join("cloud-bootstrap.json"),
            &bytes,
        )
        .unwrap();
        bytes
    }

    // 与 lib.rs 出厂初始化一致，不能用“删掉所有配置”冒充全新工作区。
    fn factory_fixture() -> WorkbenchStore {
        let empty = store();
        let initial = empty.path.parent().unwrap().join("initial.json");
        fs::write(&initial, r#"{"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{},"logs":[]}"#).unwrap();
        workbench_store::initialize(&empty.path, &initial, &empty.assets).unwrap()
    }

    #[test]
    fn factory_connect_without_seed_binds_empty_checkpoint_idempotently_and_isolates_owner() {
        let store = factory_fixture();
        let owner = json!({"uid":"fresh-member","workspaceId":"team"});
        assert_eq!(connect_seed(&store, &owner, || Ok(())).unwrap()["connected"], true);
        let first: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body).unwrap();
        let document = &first["document"];
        assert_eq!(document["cursor"], 0);
        assert_eq!(document["records"], json!([]));
        assert_eq!(document["outbox"], json!([]));
        assert_eq!(document["materializedProjection"], json!([]));
        assert!(uuid::Uuid::parse_str(document["deviceId"].as_str().unwrap()).is_ok());
        connect_seed(&store, &owner, || Ok(())).unwrap();
        let second: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body).unwrap();
        assert_eq!(first, second);
        assert!(connect_seed(&store, &json!({"uid":"other","workspaceId":"team"}), || Ok(())).is_err());
        assert!(connect_seed(&store, &json!({"uid":"fresh-member","workspaceId":"other"}), || Ok(())).is_err());
        let other = factory_fixture();
        connect_seed(&other, &owner, || Ok(())).unwrap();
        let third: Value = serde_json::from_str(&workbench_store::cloud_checkpoint_load(&other).unwrap().body).unwrap();
        assert_ne!(third["document"]["deviceId"], document["deviceId"]);
    }

    #[test]
    fn factory_connect_rejects_each_business_collection_unknown_fields_and_archived_data() {
        let owner = json!({"uid":"u","workspaceId":"w"});
        for key in ["configs","templates","sourceCatalog","costSource","caseGallery","shopSettings","unknownBusiness"] {
            let store = factory_fixture();
            let c = Connection::open(&store.path).unwrap();
            let raw: String = c.query_row("SELECT document FROM workbench_state", [], |r| r.get(0)).unwrap();
            let mut doc: Value = serde_json::from_str(&raw).unwrap();
            doc[key] = json!([{"id":"preserved-config","preserve":true}]);
            workbench_store::replace_fixture(&c, &doc);
            assert!(connect_seed(&store, &owner, || Ok(())).is_err(), "{key}");
            assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        }
        for sql in ["UPDATE workbench_log_archive SET document='[{\"old\":true}]'", "CREATE TABLE future_business(value TEXT); INSERT INTO future_business VALUES('kept')", "INSERT INTO workbench_recovery VALUES('draft','now','{}')", "INSERT INTO workbench_history(at,revision,document) VALUES('old',1,'{}')"] {
            let store = factory_fixture();
            Connection::open(&store.path).unwrap().execute_batch(sql).unwrap();
            assert!(connect_seed(&store, &owner, || Ok(())).is_err());
            assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        }
    }

    #[test]
    fn factory_connect_rechecks_state_session_and_rolls_back_failed_binding() {
        use std::cell::Cell;
        let owner = json!({"uid":"u","workspaceId":"w"});
        let store = factory_fixture();
        let calls = Cell::new(0);
        assert!(connect_seed(&store, &owner, || {
            calls.set(calls.get() + 1);
            // connect首次检查、存储事务前、插入前、提交前：最后一次模拟退出。
            if calls.get() == 4 { Err("session cancelled".into()) } else { Ok(()) }
        }).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        let c = Connection::open(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_empty_binding BEFORE INSERT ON workbench_cloud_meta BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(connect_seed(&store, &owner, || Ok(())).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
        c.execute_batch("DROP TRIGGER reject_empty_binding").unwrap();
        let calls = Cell::new(0);
        assert!(connect_seed(&store, &owner, || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 { c.execute("UPDATE workbench_metadata SET document=json_set(document,'$.unknownBusiness','concurrent')", []).unwrap(); }
            Ok(())
        }).is_err());
        assert_eq!(workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"], false);
    }
    #[test]
    fn automatic_connect_uses_fixed_seed_preserves_deletions_outbox_and_is_idempotent() {
        let (store, owner, plan) = connect_fixture();
        let raw = write_connect_seed(&store, &plan);
        let result = connect_seed(&store, &owner, || Ok(())).unwrap();
        assert_eq!(result["connected"], true);
        assert_eq!(result["imported"], true);
        assert!(result.to_string().len() < 2000);
        let snapshot: Value =
            serde_json::from_str(&workbench_store::cloud_checkpoint_load(&store).unwrap().body)
                .unwrap();
        assert_eq!(snapshot["state"]["revision"], 8);
        assert_eq!(snapshot["document"]["outbox"], plan["outbox"]);
        assert_eq!(snapshot["document"]["records"], plan["records"]);
        assert_eq!(
            snapshot["state"]["configs"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| !row["deletedAt"].is_null())
                .count(),
            30
        );
        let backup_path = fs::read_dir(store.path.parent().unwrap().join("cloud-cutover-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let backup: Value = serde_json::from_slice(&fs::read(&backup_path).unwrap()).unwrap();
        assert_eq!(backup["planHash"], format!("{:x}", Sha256::digest(&raw)));
        assert_eq!(backup["state"]["revision"], 7);
        assert_eq!(
            fs::read(store.path.parent().unwrap().join("cloud-bootstrap.json")).unwrap(),
            raw
        );
        // Once bound, reconnect never reconsumes the seed or overwrites local state.
        fs::write(
            store.path.parent().unwrap().join("cloud-bootstrap.json"),
            b"invalid-after-initial-connect",
        )
        .unwrap();
        let again = connect_seed(&store, &owner, || Ok(())).unwrap();
        assert_eq!(again["imported"], false);
        assert_eq!(again["checkpoint"]["cloudVersion"], 1);
        assert_eq!(again["checkpoint"]["workspaceRevision"], 8);
        assert!(
            connect_seed(
                &store,
                &json!({"uid":"other","workspaceId":owner["workspaceId"]}),
                || Ok(())
            )
            .is_err()
        );
    }
    #[test]
    fn automatic_connect_rejects_missing_stale_or_wrong_member_seed_without_changes() {
        let (store, owner, plan) = connect_fixture();
        let missing = connect_seed(&store, &owner, || Ok(())).unwrap_err();
        assert!(missing.contains("准备信息缺失"));
        write_connect_seed(&store, &plan);
        let wrong = connect_seed(
            &store,
            &json!({"uid":"other","workspaceId":owner["workspaceId"]}),
            || Ok(()),
        )
        .unwrap_err();
        assert!(wrong.contains("原成员账号"));
        let mut stale = plan.clone();
        stale["nativeBaseRevision"] = json!(6);
        write_connect_seed(&store, &stale);
        let error = connect_seed(&store, &owner, || Ok(())).unwrap_err();
        assert!(error.contains("过期"));
        assert!(!error.contains("接入计划"));
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        let c = Connection::open(&store.path).unwrap();
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT json_extract(document,'$.revision') FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            7
        );
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
        let runtime = CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap();
        assert!(
            dispatch(
                &runtime,
                &store,
                "connect",
                json!({"path":"arbitrary.json"})
            )
            .unwrap_err()
            .contains("不接受路径")
        );
    }
    #[test]
    fn automatic_connect_checks_session_after_preflight_and_rolls_back_failed_apply() {
        let (store, owner, plan) = connect_fixture();
        write_connect_seed(&store, &plan);
        let checks = AtomicUsize::new(0);
        assert!(
            connect_seed(&store, &owner, || {
                if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err("fixture logout".into())
                }
            })
            .is_err()
        );
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        assert!(
            !store
                .path
                .parent()
                .unwrap()
                .join("cloud-cutover-backups")
                .exists()
        );
        let c = Connection::open(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_auto_connect BEFORE INSERT ON workbench_cloud_meta BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(connect_seed(&store, &owner, || Ok(())).is_err());
        assert_eq!(
            workbench_store::cloud_checkpoint_status(&store).unwrap()["initialized"],
            false
        );
        assert_eq!(
            c.query_row::<i64, _, _>(
                "SELECT json_extract(document,'$.revision') FROM workbench_state WHERE id=1",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            7
        );
        assert_eq!(
            c.query_row::<i64, _, _>("SELECT count(*) FROM workbench_activity", [], |row| row
                .get(0))
                .unwrap(),
            0
        );
        c.execute_batch("DROP TRIGGER reject_auto_connect").unwrap();
        assert_eq!(
            connect_seed(&store, &owner, || Ok(())).unwrap()["connected"],
            true
        );
    }
    #[test]
    fn cancel_before_asset_dispatch_remains_recorded_without_waiting_for_gates() {
        let runtime = CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap();
        let store = store();
        let operation = uuid::Uuid::new_v4().to_string();
        let _identity = runtime.identity_gate.read().unwrap();
        let _assets = runtime.assets_gate.lock().unwrap();
        let result = dispatch(
            &runtime,
            &store,
            "assetsCancel",
            json!({"operationId":operation}),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.body).unwrap()["cancelled"],
            true
        );
        // The late job is rejected before trying either gate or requiring login.
        let error = ensure_assets(
            &runtime,
            &store,
            &json!({"operationId":operation,"urls":[]}),
            false,
        )
        .unwrap_err();
        assert!(error.contains("暂停"));
        assert!(asset_operation(&json!({"operationId":"invalid"})).is_err());
    }
    #[test]
    fn cancel_leaves_current_four_assets_and_does_not_start_the_next_image() {
        let runtime =
            Arc::new(CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap());
        let store = store();
        let operation = uuid::Uuid::new_v4().to_string();
        let epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
        let started = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let (sender, receiver) = mpsc::channel();
        let other = runtime.clone();
        let other_operation = operation.clone();
        let other_started = started.clone();
        let other_completed = completed.clone();
        let other_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            let urls: Vec<String> = (0..20).map(|n| n.to_string()).collect();
            bounded_assets(&urls, |_| {
                check_asset_operation(&other, &other_operation, epoch)?;
                other_started.fetch_add(1, Ordering::SeqCst);
                sender.send(()).unwrap();
                other_barrier.wait();
                other_completed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });
        for _ in 0..4 {
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        dispatch(
            &runtime,
            &store,
            "assetsCancel",
            json!({"operationId":operation}),
        )
        .unwrap();
        barrier.wait();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(completed.load(Ordering::SeqCst), 4);
        let previous_epoch = runtime.asset_cancel_epoch.load(Ordering::SeqCst);
        dispatch(&runtime, &store, "logout", json!({})).unwrap();
        assert!(runtime.cancelled_assets.lock().unwrap().is_empty());
        assert!(check_asset_operation(&runtime, &operation, previous_epoch).is_err());
    }
    #[test]
    fn serialized_payload_parse_errors_never_echo_credentials() {
        assert!(parse_payload("{}").unwrap().is_object());
        for input in ["[1]", "null", "{\"password\":\"test-secret\", invalid"] {
            let error = parse_payload(input).unwrap_err();
            assert!(!error.contains("test-secret"));
            assert!(!error.contains(input));
        }
    }
    fn store() -> WorkbenchStore {
        // 使用短暂存根，避免源码在深层验收副本时使 Win32 测试文件名超过 MAX_PATH。
        let root = std::env::temp_dir()
            .join("diy-cloud-native-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        WorkbenchStore {
            path: root.join("workbench.sqlite"),
            assets: root.join("assets"),
        }
    }
    #[test]
    fn content_cache_is_verified_atomic_and_preserves_wrong_existing_bytes() {
        let store = store();
        let bytes = b"test-native-image";
        let name = format!("{:x}.png", Sha256::digest(bytes));
        assert!(asset_name(&format!("/uploads/{name}")).is_ok());
        assert!(asset_name("/uploads/../secret.png").is_err());
        cache_bytes(&store, &name, bytes).unwrap();
        let path = store.assets.join("uploads").join(&name);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        cache_bytes(&store, &name, bytes).unwrap();
        fs::write(&path, b"wrong-existing-owned-fixture").unwrap();
        assert!(cache_bytes(&store, &name, bytes).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"wrong-existing-owned-fixture");
        assert!(cache_bytes(&store, &name, b"bad-hash").is_err());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn four_asset_lanes_finish_each_independent_image_and_stop_on_failure() {
        let urls: Vec<String> = (0..24).map(|n| n.to_string()).collect();
        let active = AtomicUsize::new(0);
        let high = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        bounded_assets(&urls, |_| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            high.fetch_max(count, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(3));
            active.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert_eq!(done.load(Ordering::SeqCst), 24);
        assert_eq!(high.load(Ordering::SeqCst), 4);
        let calls = AtomicUsize::new(0);
        assert!(
            bounded_assets(&urls, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("fixture failure".into())
            })
            .is_err()
        );
        assert!(calls.load(Ordering::SeqCst) <= 4);
    }
    #[test]
    fn logout_invalidates_epoch_without_waiting_for_identity_reader() {
        let runtime =
            Arc::new(CloudRuntime::new(std::path::Path::new("unused-cloud-test-data")).unwrap());
        let store = store();
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let other = runtime.clone();
        let worker = std::thread::spawn(move || {
            let _guard = other.identity_gate.read().unwrap();
            started.send(()).unwrap();
            wait.recv().unwrap();
        });
        ready.recv().unwrap();
        let result = dispatch(&runtime, &store, "logout", json!({})).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.body).unwrap()["authenticated"],
            false
        );
        assert_eq!(runtime.epoch.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        worker.join().unwrap();
    }
}

#[tauri::command]
// 把云端阻塞操作移出界面线程，并沿用统一的状态码与 JSON 回执。
pub async fn cloud_native_request(
    action: String,
    payload: Value,
    store: tauri::State<'_, WorkbenchStore>,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let store = store.inner().clone();
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        match dispatch(&runtime, &store, &action, payload) {
            Ok(result) => result,
            Err(message) => response(400, json!({"error":message})),
        }
    })
    .await
    .map_err(|_| "云同步任务异常，本机数据已保留".into())
}

/// Large controller documents stay serialized until the blocking thread, keeping
/// the renderer's main thread free of whole-checkpoint parse/stringify work.
#[tauri::command]
// 接收序列化请求体后走相同原生边界，避免绕过成员和队列校验。
pub async fn cloud_native_json_request(
    action: String,
    payload_json: String,
    store: tauri::State<'_, WorkbenchStore>,
    runtime: tauri::State<'_, Arc<CloudRuntime>>,
) -> Result<ApiResponse, String> {
    let store = store.inner().clone();
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let result = parse_payload(&payload_json)
            .and_then(|payload| dispatch(&runtime, &store, &action, payload));
        match result {
            Ok(result) => result,
            Err(message) => response(400, json!({"error":message})),
        }
    })
    .await
    .map_err(|_| "云同步任务异常，本机数据已保留".into())
}

fn parse_payload(raw: &str) -> Result<Value, String> {
    if raw.len() > 512 * 1024 * 1024 {
        return Err("云同步请求过大".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "云同步请求JSON格式无效")?;
    if !value.is_object() {
        return Err("云同步请求须为对象".into());
    }
    Ok(value)
}

// 新设备无接入文件使用内置默认值；显式覆盖、禁用及损坏文件均保持原语义。
#[cfg(test)]
#[test]
fn embedded_auth_fallback_respects_external_config_precedence(){
    let dir=std::env::temp_dir().join(format!("diy-auth-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let runtime=CloudRuntime::new(&dir).unwrap();
    assert_eq!(runtime.transport.environment(),crate::embedded_auth::transport().unwrap().environment());
    std::fs::write(dir.join("integrations.json"),br#"{"version":1,"cloud":{"envId":"override-demo","endpoint":"https://example.invalid/"}}"#).unwrap();
    let runtime=CloudRuntime::new(&dir).unwrap();assert!(runtime.transport.environment().starts_with("override-demo@"));
    std::fs::write(dir.join("integrations.json"),br#"{"version":1,"cloud":null}"#).unwrap();
    assert_eq!(CloudRuntime::new(&dir).unwrap().transport.status().unwrap()["configured"],false);
    std::fs::write(dir.join("integrations.json"),b"invalid-json").unwrap();assert!(CloudRuntime::new(&dir).is_err());
}
