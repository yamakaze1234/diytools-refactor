pub use crate::instance_for_pid;
use crate::{AgentError, Request, Response};
use std::sync::Arc;

pub type Handler = Arc<dyn Fn(Request) -> Response + Send + Sync>;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(windows)]
pub use platform::{call, serve, ServerHandle};

#[cfg(not(windows))]
pub struct ServerHandle;
#[cfg(not(windows))]
pub fn serve(_: &str, _: Handler) -> Result<ServerHandle, AgentError> {
    Err(AgentError::new(
        "UNSUPPORTED_PLATFORM",
        "本机 Agent 命名管道仅支持 Windows",
    ))
}
#[cfg(not(windows))]
pub fn call(_: &str, _: &Request) -> Result<Response, AgentError> {
    Err(AgentError::new(
        "UNSUPPORTED_PLATFORM",
        "本机 Agent 命名管道仅支持 Windows",
    ))
}

pub(crate) fn frame_size(header: [u8; 4]) -> Result<usize, AgentError> {
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > crate::MAX_FRAME_BYTES {
        return Err(AgentError::new("INVALID_FRAME", "帧长度必须为 1 至 1MiB"));
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_invalid_frame_lengths() {
        assert!(super::frame_size(0u32.to_le_bytes()).is_err());
        assert!(super::frame_size((crate::MAX_FRAME_BYTES as u32 + 1).to_le_bytes()).is_err());
        assert!(super::frame_size(u32::MAX.to_le_bytes()).is_err());
        assert_eq!(super::frame_size(1024u32.to_le_bytes()).unwrap(), 1024);
    }
}
