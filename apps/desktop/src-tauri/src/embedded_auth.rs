//! 构建注入的默认账号认证接入：只在外部 integrations.json 不存在时使用。
use crate::cloud_transport::{CloudTransport,CloudTransportConfig};

#[cfg(feature="formal-nas-client")]
const DEFAULTS:&[u8]=include_bytes!(concat!(env!("OUT_DIR"),"/auth-defaults.json"));
#[cfg(not(feature="formal-nas-client"))]
const DEFAULTS:&[u8]=b"";

fn from_bytes(bytes:&[u8])->Result<CloudTransport,String>{
    if bytes.is_empty(){return CloudTransport::unconfigured();}
    let config:CloudTransportConfig=serde_json::from_slice(bytes).map_err(|_|"内置账号接入格式无效")?;
    // 复用原生认证地址校验，默认值不放宽 HTTPS、凭据和根路径限制。
    CloudTransport::new(config)
}
pub(crate) fn transport()->Result<CloudTransport,String>{from_bytes(DEFAULTS)}

#[cfg(test)] mod tests{
    use super::*;
    #[test] fn embedded_auth_defaults_reject_secrets_and_insecure_urls(){
        for bytes in [br#"{"envId":"demo","endpoint":"http://example.invalid/"}"#.as_slice(),
            br#"{"envId":"demo","endpoint":"https://example.invalid/","password":"example-only"}"#.as_slice(),
            br#"{"envId":"demo","endpoint":"https://user:example@example.invalid/"}"#.as_slice()]{assert!(from_bytes(bytes).is_err());}
    }
    #[test] fn embedded_auth_defaults_missing_and_configured_are_distinct(){
        assert_eq!(from_bytes(b"").unwrap().status().unwrap()["configured"],false);
        assert_eq!(from_bytes(br#"{"envId":"demo","endpoint":"https://example.invalid/"}"#).unwrap().status().unwrap()["configured"],true);
    }
    // 本地交付检查不打印实际接入参数，也不会发起认证请求。
    #[test] fn embedded_auth_defaults_match_build_and_fresh_directory(){
        if DEFAULTS.is_empty(){return;}
        assert_eq!(transport().unwrap().status().unwrap()["configured"],true);
        assert!(serde_json::from_slice::<serde_json::Value>(DEFAULTS).unwrap().as_object().unwrap().len()==2);
    }
}
