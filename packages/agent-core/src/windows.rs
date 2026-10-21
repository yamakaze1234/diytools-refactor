use super::{frame_size, Handler};
use crate::{validate_instance, AgentError, Request, Response, MAX_FRAME_BYTES};
use std::{
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, Threading::*},
};

const TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(5);
struct Handle(HANDLE);
// 句柄由单个传输线程独占，主线程只通过原子标志要求退出。
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct LocalAllocation(*mut core::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub struct ServerHandle {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn win_error(context: &str) -> AgentError {
    AgentError::new(
        "PIPE_IO_ERROR",
        format!("{context}: {}", std::io::Error::last_os_error()),
    )
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn current_sid() -> Result<String, AgentError> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(win_error("读取用户令牌"));
        }
        let token = Handle(token);
        let mut size = 0;
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut size);
        if size == 0 {
            return Err(win_error("读取用户 SID 长度"));
        }
        // TOKEN_USER 需要指针对齐，使用 usize 存储而非字节数组。
        let mut buffer = vec![
            0usize;
            (size as usize + std::mem::size_of::<usize>() - 1)
                / std::mem::size_of::<usize>()
        ];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(win_error("读取用户 SID"));
        }
        let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
        let mut output = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut output) == 0 {
            return Err(win_error("转换用户 SID"));
        }
        let _allocation = LocalAllocation(output.cast());
        let mut len = 0;
        while *output.add(len) != 0 {
            len += 1;
        }
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            output, len,
        )))
    }
}
fn pipe_name(instance: &str) -> Result<Vec<u16>, AgentError> {
    validate_instance(instance)?;
    Ok(wide(&format!(
        r"\\.\pipe\diytools-agent-v1-{}-{instance}",
        current_sid()?
    )))
}
fn create_server(instance: &str) -> Result<Handle, AgentError> {
    let name = pipe_name(instance)?;
    let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{})", current_sid()?));
    unsafe {
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(win_error("创建管道 ACL"));
        }
        let _allocation = LocalAllocation(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        // 显式 DACL 仅允许当前用户及 SYSTEM；首实例锁防止重复服务，拒绝网络客户端。
        let handle = CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            (MAX_FRAME_BYTES + 4) as u32,
            (MAX_FRAME_BYTES + 4) as u32,
            0,
            &attributes,
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error("创建命名管道"));
        }
        Ok(Handle(handle))
    }
}
fn check(deadline: Instant, stop: &AtomicBool) -> Result<(), AgentError> {
    if stop.load(Ordering::Acquire) {
        return Err(AgentError::new("SERVER_STOPPED", "服务已停止"));
    }
    if Instant::now() >= deadline {
        return Err(AgentError::new("PIPE_TIMEOUT", "命名管道请求超时"));
    }
    Ok(())
}
fn read_exact(
    handle: HANDLE,
    bytes: &mut [u8],
    deadline: Instant,
    stop: &AtomicBool,
) -> Result<(), AgentError> {
    let mut offset = 0;
    while offset < bytes.len() {
        check(deadline, stop)?;
        let mut count = 0;
        let ok = unsafe {
            ReadFile(
                handle,
                bytes[offset..].as_mut_ptr(),
                (bytes.len() - offset) as u32,
                &mut count,
                null_mut(),
            )
        };
        if ok != 0 && count > 0 {
            offset += count as usize;
            continue;
        }
        let error = unsafe { GetLastError() };
        if ok == 0 && error != ERROR_NO_DATA && error != ERROR_PIPE_LISTENING {
            return Err(win_error("读取管道"));
        }
        thread::sleep(POLL);
    }
    Ok(())
}
fn read_frame<T: serde::de::DeserializeOwned>(
    handle: HANDLE,
    deadline: Instant,
    stop: &AtomicBool,
) -> Result<T, AgentError> {
    let mut header = [0; 4];
    read_exact(handle, &mut header, deadline, stop)?;
    let mut bytes = vec![0; frame_size(header)?];
    read_exact(handle, &mut bytes, deadline, stop)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AgentError::new("INVALID_FRAME", "帧内容不是有效的协议 JSON"))
}
fn write_frame<T: serde::Serialize>(
    handle: HANDLE,
    value: &T,
    deadline: Instant,
    stop: &AtomicBool,
) -> Result<(), AgentError> {
    let body = serde_json::to_vec(value)
        .map_err(|_| AgentError::new("INVALID_FRAME", "无法编码协议 JSON"))?;
    frame_size((body.len() as u32).to_le_bytes())?;
    let mut bytes = Vec::with_capacity(body.len() + 4);
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    let mut offset = 0;
    while offset < bytes.len() {
        check(deadline, stop)?;
        let mut count = 0;
        let ok = unsafe {
            WriteFile(
                handle,
                bytes[offset..].as_ptr(),
                (bytes.len() - offset) as u32,
                &mut count,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(win_error("写入管道"));
        }
        offset += count as usize;
        if count == 0 {
            thread::sleep(POLL);
        }
    }
    Ok(())
}
pub fn serve(instance: &str, handler: Handler) -> Result<ServerHandle, AgentError> {
    let pipe = create_server(instance)?;
    let stop = Arc::new(AtomicBool::new(false));
    let callback_stop = stop.clone();
    let (tasks, incoming) = mpsc::sync_channel::<(Request, Instant, mpsc::SyncSender<Response>)>(1);
    // 一个服务只创建一个回调线程，超时回调不会不断产生新线程。
    // Drop 不等待业务回调；关闭任务发送端后，正常回调线程会自行退出。
    thread::Builder::new()
        .name("diytools-agent-handler".into())
        .spawn(move || {
            while let Ok((request, deadline, sender)) = incoming.recv() {
                // 排队请求若已经超时或服务关闭，不能在之后补执行。
                if check(deadline, &callback_stop).is_err() {
                    continue;
                }
                let _ = sender.send(handler(request));
            }
        })
        .map_err(|e| AgentError::new("PIPE_START_FAILED", e.to_string()))?;
    let thread_stop = stop.clone();
    let worker = thread::Builder::new()
        .name("diytools-agent-pipe".into())
        .spawn(move || {
            let pipe = pipe;
            while !thread_stop.load(Ordering::Acquire) {
                let connected = unsafe { ConnectNamedPipe(pipe.0, null_mut()) };
                let error = unsafe { GetLastError() };
                if connected == 0 && error != ERROR_PIPE_CONNECTED {
                    if error == ERROR_NO_DATA || error == ERROR_PIPE_NOT_CONNECTED {
                        unsafe {
                            DisconnectNamedPipe(pipe.0);
                        }
                    }
                    thread::sleep(POLL);
                    continue;
                }
                let deadline = Instant::now() + TIMEOUT;
                if let Ok(request) = read_frame::<Request>(pipe.0, deadline, &thread_stop) {
                    let response = if let Err(error) = request.validate() {
                        Some(Response::failure(&request, error))
                    } else {
                        // 业务回调不在管道线程执行，卡住的回调不能阻止服务句柄退出。
                        let (sender, receiver) = mpsc::sync_channel(1);
                        if tasks.try_send((request.clone(), deadline, sender)).is_err() {
                            Some(Response::failure(
                                &request,
                                AgentError::new("HANDLER_BUSY", "请求处理线程忙或已退出"),
                            ))
                        } else {
                            loop {
                                if check(deadline, &thread_stop).is_err() {
                                    break None;
                                }
                                match receiver.recv_timeout(POLL) {
                                    Ok(response) => break Some(response),
                                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                                        break Some(Response::failure(
                                            &request,
                                            AgentError::new("HANDLER_FAILED", "请求处理失败"),
                                        ))
                                    }
                                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                                }
                            }
                        }
                    };
                    if let Some(response) = response {
                        // 大响应仍须给调用方明确协议错误，不能只断开连接丢失原因。
                        // 无效请求也可能带超长 requestId，因此错误回执的标识同样有界。
                        let response = if serde_json::to_vec(&response)
                            .map(|bytes| bytes.len() > MAX_FRAME_BYTES)
                            .unwrap_or(true)
                        {
                            let mut failure = Response::failure(
                                &request,
                                AgentError::new(
                                    "RESPONSE_TOO_LARGE",
                                    "响应超过 1MiB 帧上限，请缩小查询范围或分页读取",
                                ),
                            );
                            failure.request_id = request.request_id.chars().take(128).collect();
                            failure
                        } else {
                            response
                        };
                        if write_frame(pipe.0, &response, deadline, &thread_stop).is_ok() {
                            // DisconnectNamedPipe 会丢弃客户端尚未读走的数据；等待客户端正常关闭，
                            // 但不用可能永久阻塞的 FlushFileBuffers，超时和停止仍可打断。
                            while check(deadline, &thread_stop).is_ok() {
                                if unsafe {
                                    PeekNamedPipe(
                                        pipe.0,
                                        null_mut(),
                                        0,
                                        null_mut(),
                                        null_mut(),
                                        null_mut(),
                                    )
                                } == 0
                                {
                                    break;
                                }
                                thread::sleep(POLL);
                            }
                        }
                    }
                }
                unsafe {
                    DisconnectNamedPipe(pipe.0);
                }
            }
        })
        .map_err(|e| AgentError::new("PIPE_START_FAILED", e.to_string()))?;
    Ok(ServerHandle {
        stop,
        worker: Some(worker),
    })
}
pub fn call(instance: &str, request: &Request) -> Result<Response, AgentError> {
    request.validate()?;
    let name = pipe_name(instance)?;
    let deadline = Instant::now() + TIMEOUT;
    let stop = AtomicBool::new(false);
    let pipe = loop {
        check(deadline, &stop)?;
        // 禁止服务端借客户端令牌模拟；客户端和服务端均使用非阻塞管道 I/O。
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break Handle(handle);
        }
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND {
            return Err(win_error("连接管道"));
        }
        thread::sleep(POLL);
    };
    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(pipe.0, &mode, null(), null()) } == 0 {
        return Err(win_error("设置管道模式"));
    }
    write_frame(pipe.0, request, deadline, &stop)?;
    let response: Response = read_frame(pipe.0, deadline, &stop)?;
    response.validate_for(request)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn real_pipe_roundtrip_and_shutdown() {
        let instance = format!("test-{}-roundtrip", std::process::id());
        let server = serve(
            &instance,
            Arc::new(|r| Response::success(&r, json!({"pong": true}))),
        )
        .unwrap();
        assert!(serve(&instance, Arc::new(|r| Response::success(&r, json!({})))).is_err());
        let request = Request {
            protocol_version: 1,
            request_id: "test-1".into(),
            method: "ping".into(),
            params: json!({}),
        };
        for _ in 0..3 {
            assert_eq!(
                call(&instance, &request).unwrap().data.unwrap()["pong"],
                true
            );
        }
        let start = Instant::now();
        drop(server);
        assert!(start.elapsed() < Duration::from_secs(1));
        let replacement = serve(&instance, Arc::new(|r| Response::success(&r, json!({})))).unwrap();
        drop(replacement);
    }
    fn raw_client(instance: &str) -> Handle {
        let name = pipe_name(instance).unwrap();
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let mode = PIPE_NOWAIT;
        assert_ne!(
            unsafe { SetNamedPipeHandleState(handle, &mode, null(), null()) },
            0
        );
        Handle(handle)
    }
    #[test]
    fn rejects_bad_frames_and_versions_over_real_pipe() {
        let instance = format!("test-{}-badframes", std::process::id());
        let invoked = Arc::new(AtomicBool::new(false));
        let observed = invoked.clone();
        let server = serve(
            &instance,
            Arc::new(move |r| {
                observed.store(true, Ordering::Release);
                Response::success(&r, json!({}))
            }),
        )
        .unwrap();
        let pipe = raw_client(&instance);
        let request = Request {
            protocol_version: 999,
            request_id: "bad-version".into(),
            method: "ping".into(),
            params: json!({}),
        };
        let stop = AtomicBool::new(false);
        write_frame(pipe.0, &request, Instant::now() + TIMEOUT, &stop).unwrap();
        let response: Response = read_frame(pipe.0, Instant::now() + TIMEOUT, &stop).unwrap();
        assert_eq!(response.error.unwrap().code, "PROTOCOL_VERSION_MISMATCH");
        assert!(!invoked.load(Ordering::Acquire));
        drop(pipe);
        drop(server);
        let server = serve(&instance, Arc::new(|r| Response::success(&r, json!({})))).unwrap();
        let pipe = raw_client(&instance);
        let oversized = (MAX_FRAME_BYTES as u32 + 1).to_le_bytes();
        let mut count = 0;
        assert_ne!(
            unsafe { WriteFile(pipe.0, oversized.as_ptr(), 4, &mut count, null_mut()) },
            0
        );
        assert!(read_frame::<Response>(pipe.0, Instant::now() + TIMEOUT, &stop).is_err());
        drop(pipe);
        drop(server);
    }
    #[test]
    fn shutdown_interrupts_partial_frame() {
        let instance = format!("test-{}-partial", std::process::id());
        let server = serve(&instance, Arc::new(|r| Response::success(&r, json!({})))).unwrap();
        let pipe = raw_client(&instance);
        let mut count = 0;
        assert_ne!(
            unsafe { WriteFile(pipe.0, [16u8, 0].as_ptr(), 2, &mut count, null_mut()) },
            0
        );
        thread::sleep(Duration::from_millis(30));
        let start = Instant::now();
        drop(server);
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn call_rejects_wrong_response_id() {
        let instance = format!("test-{}-wrongid", std::process::id());
        let server = serve(
            &instance,
            Arc::new(|r| {
                let mut response = Response::success(&r, json!({}));
                response.request_id = "wrong".into();
                response
            }),
        )
        .unwrap();
        let request = Request {
            protocol_version: 1,
            request_id: "expected".into(),
            method: "ping".into(),
            params: json!({}),
        };
        assert_eq!(
            call(&instance, &request).unwrap_err().code,
            "RESPONSE_ID_MISMATCH"
        );
        drop(server);
    }
    #[test]
    fn oversized_response_returns_bounded_error_and_keeps_serving() {
        let instance = format!("test-{}-large-response", std::process::id());
        let server = serve(
            &instance,
            Arc::new(|r| {
                let data = if r.method == "large" {
                    json!({ "name": "x".repeat(MAX_FRAME_BYTES) })
                } else {
                    json!({"pong": true})
                };
                Response::success(&r, data)
            }),
        )
        .unwrap();
        let mut request = Request {
            protocol_version: 1,
            request_id: "large-response".into(),
            method: "large".into(),
            params: json!({}),
        };
        let response = call(&instance, &request).unwrap();
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "RESPONSE_TOO_LARGE");
        assert!(serde_json::to_vec(&response).unwrap().len() < 1024);
        request.method = "ping".into();
        assert_eq!(
            call(&instance, &request).unwrap().data.unwrap()["pong"],
            true
        );
        drop(server);
    }
    #[test]
    fn stalled_handler_has_bounded_client_and_shutdown() {
        let instance = format!("test-{}-timeout", std::process::id());
        let release = Arc::new(AtomicBool::new(false));
        let callback_release = release.clone();
        let server = serve(
            &instance,
            Arc::new(move |r| {
                while !callback_release.load(Ordering::Acquire) {
                    thread::sleep(POLL);
                }
                Response::success(&r, json!({}))
            }),
        )
        .unwrap();
        let request = Request {
            protocol_version: 1,
            request_id: "timeout".into(),
            method: "ping".into(),
            params: json!({}),
        };
        let start = Instant::now();
        assert!(call(&instance, &request).is_err());
        assert!(start.elapsed() < TIMEOUT + Duration::from_secs(1));
        let start = Instant::now();
        drop(server);
        assert!(start.elapsed() < Duration::from_secs(1));
        release.store(true, Ordering::Release);
    }
}
