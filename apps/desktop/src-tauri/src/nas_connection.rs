//! 正式工作台连接设置：匿名 TLS 检查后单文件原子保存，重启才切换运行时。
use serde::{Deserialize, Serialize};
use std::{io::{Read, Write}, path::{Path, PathBuf}, time::Duration};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConnectionConfig {
    pub version: u32,
    pub name: String,
    pub api_url: String,
    #[serde(default)] pub deployment_id: String,
    pub ca_pem: Option<String>,
}
pub(crate) const FILE: &str = "workbench-connection.json";

pub(crate) fn validate(mut config: ConnectionConfig, saved: bool) -> Result<ConnectionConfig, String> {
    config.name=config.name.trim().into();
    if config.version!=1 || config.name.is_empty() || config.name.chars().count()>80 || config.name.chars().any(char::is_control) {
        return Err("请填写 1–80 个字符的连接名称".into());
    }
    // 本轮沿用正式部署边界，不把试验端口当成正式工作区。
    config.api_url=crate::cloud_native::nas_base(config.api_url.trim())
        .filter(crate::cloud_native::production_nas_endpoint)
        .ok_or("请填写正式局域网 HTTPS 根地址和端口，不能使用试验端口")?.to_string();
    if saved && !crate::cloud_native::valid_nas_deployment(&config.deployment_id) {
        return Err("服务端部署标识无效，请重新测试连接".into());
    }
    if let Some(pem)=&config.ca_pem {
        if pem.contains("PRIVATE KEY") || pem.len()>16*1024 || !pem.contains("-----BEGIN CERTIFICATE-----") {
            return Err("请选择 PEM 格式的公开 CA 证书，不能导入私钥".into());
        }
        reqwest::Certificate::from_pem(pem.as_bytes()).map_err(|_|"CA 证书格式无效")?;
    }
    Ok(config)
}

fn directory()->Result<PathBuf,String>{
    std::env::current_exe().map_err(|_|"无法定位程序目录")?.parent().map(Path::to_path_buf).ok_or("无法定位程序目录".into())
}
pub(crate) fn read(directory:&Path)->Result<Option<ConnectionConfig>,String>{
    let file=match std::fs::File::open(directory.join(FILE)) {
        Ok(file)=>file,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("无法读取连接设置".into())
    };
    let mut bytes=Vec::new();file.take(24*1024+1).read_to_end(&mut bytes).map_err(|_|"无法读取连接设置")?;
    if bytes.len()>24*1024 {return Err("连接设置文件过大".into());}
    validate(serde_json::from_slice(&bytes).map_err(|_|"连接设置格式无效，请重新配置")?,true).map(Some)
}

fn client(config:&ConnectionConfig)->Result<reqwest::blocking::Client,String>{
    match &config.ca_pem {
        Some(pem)=>crate::cloud_transport::nas_tls_client(pem.as_bytes()),
        None=>crate::cloud_transport::nas_system_tls_client(),
    }
}
// 健康接口只发送匿名 GET；拒绝重定向及响应过大，不向候选地址发送登录令牌。
fn probe(config:ConnectionConfig)->Result<ConnectionConfig,String>{
    let mut config=validate(config,false)?;
    let url=crate::cloud_native::nas_base(&config.api_url).ok_or("服务地址无效")?;
    let response=client(&config)?.get(url.join("/healthz").map_err(|_|"服务地址无效")?)
        .timeout(Duration::from_secs(10)).send().map_err(|_|"无法建立可信 HTTPS 连接，请检查地址、网络与 CA 证书")?;
    if response.status()!=200 {return Err("服务端健康检查失败，请确认工作台服务正在运行".into());}
    let header=response.headers().get("x-workbench-deployment").and_then(|v|v.to_str().ok()).unwrap_or("").to_string();
    let mut body=Vec::new();response.take(4097).read_to_end(&mut body).map_err(|_|"服务端响应中断")?;
    if body.len()>4096 {return Err("服务端响应格式不兼容".into());}
    let value:Value=serde_json::from_slice(&body).map_err(|_|"服务端响应格式不兼容")?;
    if value["ok"]!=true || value["checks"]["process"]!=true || value["deployment_id"]!=header || !crate::cloud_native::valid_nas_deployment(&header) {
        return Err("目标不是兼容的正式工作台服务端".into());
    }
    if !config.deployment_id.is_empty() && config.deployment_id!=header {
        return Err("服务端部署已变化，请重新测试连接并确认".into());
    }
    config.deployment_id=header;Ok(config)
}

fn persist(directory:&Path, config:&ConnectionConfig)->Result<(),String>{
    let bytes=serde_json::to_vec_pretty(config).map_err(|_|"无法生成连接设置")?;
    let target=directory.join(FILE);
    let temporary=directory.join(format!(".connection-{}.tmp",uuid::Uuid::new_v4()));
    let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_|"程序目录不可写，无法保存连接设置")?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|"连接设置写入失败")?;drop(file);
    // Windows 的 rename 不能覆盖既有文件；MoveFileEx 的替换确保地址与证书同时切换。
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name="kernel32")] unsafe extern "system" {fn MoveFileExW(from:*const u16,to:*const u16,flags:u32)->i32;}
        let from:Vec<u16>=temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to:Vec<u16>=target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe{MoveFileExW(from.as_ptr(),to.as_ptr(),1|8)}==0 {return Err("无法替换连接设置，请确认目录可写".into());}
    }
    #[cfg(not(windows))] std::fs::rename(&temporary,&target).map_err(|_|"无法替换连接设置")?;
    Ok(())
}
fn require_formal()->Result<(),String>{if cfg!(all(feature="formal-nas-client",not(feature="nas-acceptance"))){Ok(())}else{Err("此程序不支持服务端连接设置".into())}}

#[tauri::command]
pub async fn nas_connection_settings()->Result<Value,String>{
    require_formal()?;
    // 无效配置也能打开修复页面，不阻止首次启动。
    let dir=directory()?;
    let result=read(&dir);
    match result {
        Ok(Some(config))=>Ok(json!({"config":config,"error":""})),
        Ok(None)=>{
            #[cfg(feature="formal-nas-client")]
            if let Ok(config)=crate::nas_launch::legacy_connection(&dir){return Ok(json!({"config":config,"error":""}));}
            Ok(json!({"config":null,"error":std::env::var("DIYTOOLS_CONNECTION_ERROR").unwrap_or_default()}))
        },
        Err(error)=>Ok(json!({"config":null,"error":error})),
    }
}
#[tauri::command]
pub async fn nas_connection_certificate()->Result<Option<String>,String>{
    require_formal()?;
    tauri::async_runtime::spawn_blocking(||{
        let Some(path)=rfd::FileDialog::new().set_title("选择服务端 CA 证书").add_filter("PEM 证书",&["pem","crt"]).pick_file() else{return Ok(None)};
        let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"无法读取证书")?.take(16*1024+1).read_to_end(&mut bytes).map_err(|_|"无法读取证书")?;
        if bytes.len()>16*1024{return Err("证书文件过大".into())}
        let text=String::from_utf8(bytes).map_err(|_|"请使用 PEM 格式的 CA 证书")?;
        if text.contains("PRIVATE KEY"){return Err("不能导入私钥，请选择公开 CA 证书".into())}
        reqwest::Certificate::from_pem(text.as_bytes()).map_err(|_|"证书格式无效")?;Ok(Some(text))
    }).await.map_err(|_|"证书选择失败")?
}
#[tauri::command]
pub async fn nas_connection_test(config:ConnectionConfig)->Result<ConnectionConfig,String>{
    require_formal()?;tauri::async_runtime::spawn_blocking(move||probe(config)).await.map_err(|_|"连接检查异常")?
}
#[tauri::command]
pub async fn nas_connection_save(config:ConnectionConfig)->Result<(),String>{
    require_formal()?;let dir=directory()?;
    tauri::async_runtime::spawn_blocking(move||{let config=probe(config)?;persist(&dir,&config)}).await.map_err(|_|"连接保存异常")?
}
#[tauri::command]
pub fn nas_connection_restart(app:tauri::AppHandle)->Result<(),String>{require_formal()?;app.restart()}

#[cfg(test)] mod tests {
    use super::*;
    fn config()->ConnectionConfig{ConnectionConfig{version:1,name:"DIY工作台".into(),api_url:"https://192.168.1.10:19443".into(),deployment_id:"intel-production-example".into(),ca_pem:None}}
    #[test] fn validates_and_roundtrips_atomic_connection_without_password(){
        let dir=std::env::temp_dir().join(format!("diy-connection-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&dir).unwrap();
        let first=validate(config(),true).unwrap();persist(&dir,&first).unwrap();
        let mut second=first.clone();second.name="第二个连接".into();persist(&dir,&second).unwrap();
        assert_eq!(read(&dir).unwrap().unwrap().name,second.name);
        let value:Value=serde_json::from_slice(&std::fs::read(dir.join(FILE)).unwrap()).unwrap();assert!(value.get("password").is_none());
    }
    #[test] fn rejects_credentials_private_key_and_untrusted_configuration(){
        for url in ["http://192.168.1.10:19443/","https://user:pass@192.168.1.10:19443/","https://192.168.1.10:18443/"]{let mut c=config();c.api_url=url.into();assert!(validate(c,false).is_err());}
        let mut c=config();c.ca_pem=Some("PRIVATE KEY".into());assert!(validate(c,false).is_err());
        let mut c=config();c.deployment_id="trial".into();assert!(validate(c,true).is_err());
    }
    // 显式指定测试地址及 CA 才运行，只访问匿名健康接口，不读员工凭据或业务数据。
    #[test] #[ignore]
    fn live_tls_probe_checks_real_service_and_rejects_missing_ca(){
        let mut c=config();c.api_url=std::env::var("DIYTOOLS_CONNECTION_TEST_URL").unwrap();c.deployment_id.clear();
        c.ca_pem=Some(std::fs::read_to_string(std::env::var("DIYTOOLS_CONNECTION_TEST_CA").unwrap()).unwrap());
        let result=probe(c.clone()).unwrap();assert!(crate::cloud_native::valid_nas_deployment(&result.deployment_id));
        c.ca_pem=None;assert!(probe(c).is_err());
    }
}
