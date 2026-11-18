//! 正式便携客户端的自包含启动入口：连接参数来自程序旁文件，草稿目录保持不变。
use std::{path::Path, io::Read};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct LaunchConfig { version: u32, api_url: String, deployment_id: String }

// 与原生请求层共用校验，拒绝试验地址、URL 凭据和不匹配的部署代号。
fn parse(bytes: &[u8]) -> Result<LaunchConfig, String> {
    let mut config: LaunchConfig=serde_json::from_slice(bytes).map_err(|_| "nas-launch.json 格式无效，请恢复随程序提供的连接配置")?;
    let url=crate::cloud_native::nas_base(&config.api_url).filter(crate::cloud_native::production_nas_endpoint)
        .ok_or("正式程序需要有效的局域网 HTTPS 地址，不能使用试验端口")?;
    if config.version!=1 || !crate::cloud_native::valid_nas_deployment(&config.deployment_id) {
        return Err("nas-launch.json 版本或部署标识无效".into());
    }
    config.api_url=url.to_string();Ok(config)
}

fn load(directory:&Path)->Result<LaunchConfig,String>{
    let marker=std::fs::read(directory.join("diytools-portable.json")).map_err(|_|"请在完整的三店 NAS 程序目录中启动 EXE")?;
    let marker:serde_json::Value=serde_json::from_slice(&marker).map_err(|_|"便携目录标记无效")?;
    if marker["mode"]!="portable" {return Err("便携目录标记无效".into());}
    if !directory.join("data/nas-ca.pem").is_file(){return Err("缺少 data/nas-ca.pem 服务端证书，请恢复原程序目录文件".into());}
    match std::fs::File::open(directory.join("nas-launch.json")) {
        Ok(file)=>{
            let mut bytes=Vec::new();file.take(4097).read_to_end(&mut bytes).map_err(|_|"无法读取 nas-launch.json")?;
            if bytes.len()>4096{return Err("nas-launch.json 超过允许大小".into());}
            parse(&bytes)
        }
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{
            // 兼容旧目录的原启动器；新安装始终提供 JSON，双击 EXE 无需环境变量。
            let api_url=std::env::var("DIYTOOLS_NAS_API_URL").map_err(|_|"缺少 nas-launch.json，请恢复随程序提供的连接配置")?;
            let deployment_id=std::env::var("DIYTOOLS_NAS_DEPLOYMENT_ID").map_err(|_|"缺少正式部署标识")?;
            parse(&serde_json::to_vec(&serde_json::json!({"version":1,"api_url":api_url,"deployment_id":deployment_id})).map_err(|_|"连接配置无效")?)
        }
        Err(_)=>Err("无法读取 nas-launch.json".into())
    }
}

// 纯函数集中定义环境参数，便于核对直启与旧 CMD 使用完全相同的数据作用域。
fn launch_environment(directory:&Path,config:&LaunchConfig)->Vec<(&'static str,std::ffi::OsString)>{
    vec![
        ("DIYTOOLS_NAS_MAIN","1".into()),
        ("DIYTOOLS_NAS_API_URL",config.api_url.clone().into()),
        ("DIYTOOLS_NAS_DEPLOYMENT_ID",config.deployment_id.clone().into()),
        ("DIYTOOLS_AGENT_ENABLED","0".into()),
        ("WEBVIEW2_USER_DATA_FOLDER",directory.join("data/webview2").into_os_string()),
        ("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","".into()),
    ]
}

/// 在创建 Tauri、异步运行时或任何线程之前装配启动参数。
/// # Safety
/// 调用方必须保证当前仍处于 main 的单线程启动阶段，没有并发读取环境变量。
pub(crate) fn legacy_connection(directory:&Path)->Result<crate::nas_connection::ConnectionConfig,String>{
    let config=load(directory)?;
    let pem=std::fs::read_to_string(directory.join("data/nas-ca.pem")).map_err(|_|"无法读取 CA 证书")?;
    crate::nas_connection::validate(crate::nas_connection::ConnectionConfig{version:1,name:"DIY工作台".into(),api_url:config.api_url,deployment_id:config.deployment_id,ca_pem:Some(pem)},true)
}

pub unsafe fn prepare_formal_launch()->Result<(),String>{
    let exe=std::env::current_exe().map_err(|_|"无法定位程序目录")?;
    let directory=exe.parent().ok_or("无法定位程序目录")?;
    // 首次便携启动只建立目录标记；缺少连接时进入设置页，绝不退回旧 SQLite。
    if !directory.join("diytools-portable.json").exists(){
        std::fs::write(directory.join("diytools-portable.json"),b"{\"mode\":\"portable\"}").map_err(|_|"程序目录不可写，请解压到可写目录")?;
    }
    let result=crate::nas_connection::read(directory).and_then(|saved|match saved{Some(value)=>Ok(value),None=>legacy_connection(directory)});
    for key in ["DIYTOOLS_NAS_API_URL","DIYTOOLS_NAS_DEPLOYMENT_ID","DIYTOOLS_NAS_CA_PEM","DIYTOOLS_CONNECTION_ERROR"]{
        unsafe{std::env::remove_var(key);}
    }
    unsafe{
        std::env::set_var("DIYTOOLS_NAS_MAIN","1");
        std::env::set_var("DIYTOOLS_AGENT_ENABLED","0");
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER",directory.join("data/webview2"));
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","");
        std::env::set_var("DIYTOOLS_NAS_SYSTEM_CA","1");
    }
    match result{
        Ok(config)=>unsafe{
            let legacy=LaunchConfig{version:1,api_url:config.api_url,deployment_id:config.deployment_id};
            for (key,value) in launch_environment(directory,&legacy){std::env::set_var(key,value);}
            if let Some(pem)=config.ca_pem{std::env::set_var("DIYTOOLS_NAS_CA_PEM",pem);std::env::set_var("DIYTOOLS_NAS_SYSTEM_CA","0");}
        },
        Err(message)=>unsafe{std::env::set_var("DIYTOOLS_CONNECTION_ERROR",message);},
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(url:&str,id:&str)->Vec<u8>{serde_json::to_vec(&serde_json::json!({"version":1,"api_url":url,"deployment_id":id})).unwrap()}
    #[test]
    fn formal_config_normalizes_without_changing_session_scope(){
        let config=parse(&document("https://192.168.1.11:19443","intel-production-example")).unwrap();
        assert_eq!(config.api_url,"https://192.168.1.11:19443/");
        assert_eq!(config.deployment_id,"intel-production-example");
    }
    #[test]
    fn direct_launch_reuses_existing_data_and_disables_legacy_agent(){
        let config=parse(&document("https://192.168.1.11:19443/","intel-production-example")).unwrap();
        let directory=Path::new("portable-folder");
        let values:std::collections::HashMap<_,_>=launch_environment(directory,&config).into_iter().collect();
        assert_eq!(values["WEBVIEW2_USER_DATA_FOLDER"],directory.join("data/webview2").into_os_string());
        assert_eq!(values["DIYTOOLS_NAS_MAIN"],"1");
        assert_eq!(values["DIYTOOLS_AGENT_ENABLED"],"0");
        assert_eq!(values["DIYTOOLS_NAS_DEPLOYMENT_ID"],"intel-production-example");
    }
    #[test]
    fn rejects_trial_remote_credentials_and_malformed_config(){
        for url in ["https://192.168.1.11:18443/","http://192.168.1.11:19443/","https://example.com:19443/","https://user:secret@192.168.1.11:19443/","https://192.168.1.11:19443/path"] {
            assert!(parse(&document(url,"intel-production-example")).is_err());
        }
        assert!(parse(&document("https://192.168.1.11:19443/","trial")).is_err());
        assert!(parse(br#"{"version":2,"api_url":"https://192.168.1.11:19443/","deployment_id":"intel-production-example"}"#).is_err());
        assert!(parse(b"{}").is_err());
    }
}
