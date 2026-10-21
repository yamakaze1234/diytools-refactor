//! 仅本机、当前用户隔离的桌面 Agent 协议与传输，不包含业务数据库访问。
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub protocol_version: u32,
    pub request_id: String,
    pub ok: bool,
    pub data: Option<Value>,
    pub error: Option<AgentError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentError {
    pub code: String,
    pub message: String,
}

impl AgentError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AgentError {}

impl Request {
    pub fn validate(&self) -> Result<(), AgentError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(AgentError::new(
                "PROTOCOL_VERSION_MISMATCH",
                "不支持的协议版本",
            ));
        }
        if self.request_id.is_empty()
            || self.request_id.len() > 128
            || self.method.is_empty()
            || self.method.len() > 128
        {
            return Err(AgentError::new(
                "INVALID_REQUEST",
                "requestId 和 method 必须为 1 至 128 字节",
            ));
        }
        Ok(())
    }
}

impl Response {
    pub fn success(request: &Request, data: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            ok: true,
            data: Some(data),
            error: None,
        }
    }
    pub fn failure(request: &Request, error: AgentError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            ok: false,
            data: None,
            error: Some(error),
        }
    }
    pub fn validate_for(&self, request: &Request) -> Result<(), AgentError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(AgentError::new(
                "PROTOCOL_VERSION_MISMATCH",
                "响应协议版本不匹配",
            ));
        }
        if self.request_id != request.request_id {
            return Err(AgentError::new(
                "RESPONSE_ID_MISMATCH",
                "响应 requestId 不匹配",
            ));
        }
        // JSON null 在 Option<Value> 中也表示 None，成功响应允许空数据。
        if (self.ok && self.error.is_some())
            || (!self.ok && (self.data.is_some() || self.error.is_none()))
        {
            return Err(AgentError::new("INVALID_RESPONSE", "响应结果结构无效"));
        }
        Ok(())
    }
}

pub fn instance_for_pid(pid: u32) -> String {
    format!("desktop-{pid}")
}

pub fn validate_instance(instance: &str) -> Result<(), AgentError> {
    if instance.is_empty()
        || instance.len() > 64
        || !instance
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AgentError::new(
            "INVALID_INSTANCE",
            "实例名只允许 1 至 64 个英文字母、数字、连字符或下划线",
        ));
    }
    Ok(())
}

pub mod transport;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_protocol() {
        assert!(serde_json::from_str::<Request>(
            r#"{"protocolVersion":1,"requestId":"a","method":"ping","params":{},"sql":"SELECT 1"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"protocolVersion":"1","requestId":"a","method":"ping","params":{}}"#
        )
        .is_err());
        let mut request = Request {
            protocol_version: 99,
            request_id: "a".into(),
            method: "ping".into(),
            params: Value::Null,
        };
        assert!(request.validate().is_err());
        request.protocol_version = 1;
        assert!(Response::success(&request, Value::Null)
            .validate_for(&request)
            .is_ok());
        let mut response = Response::success(&request, Value::Null);
        response.request_id = "other".into();
        assert!(response.validate_for(&request).is_err());
        response.request_id = "a".into();
        response.protocol_version = 2;
        assert!(response.validate_for(&request).is_err());
    }
    #[test]
    fn instances_cannot_escape_namespace() {
        assert_eq!(instance_for_pid(42), "desktop-42");
        for value in ["", "../x", "x\\evil", "x/y", "a.b", "桌面"] {
            assert!(validate_instance(value).is_err());
        }
    }
    #[test]
    fn response_preserves_large_numeric_identifiers() {
        let raw = r#"{"protocolVersion":1,"requestId":"id","ok":true,"data":{"skuId":123456789012345678901234567890,"goodsId":"0009"},"error":null}"#;
        let response: Response = serde_json::from_str(raw).unwrap();
        let encoded = serde_json::to_string(&response).unwrap();
        assert!(encoded.contains("123456789012345678901234567890"));
        assert!(encoded.contains("\"0009\""));
    }
}
