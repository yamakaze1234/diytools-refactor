// ERP 辅助进程从本机 data/runtime 读取；公开源码不内嵌或下载任何私有依赖。
use std::{path::Path, process::Stdio};
use tokio::process::{Child, Command};

// 外部运行时路径只由原生数据目录决定，不能由页面请求选择可执行文件。
pub fn command(data_dir: &Path) -> Result<Command, String> {
    let worker = data_dir.join("runtime").join("erp-worker.exe");
    let mut command = if worker.is_file() {
        let mut command = Command::new(&worker);
        command.current_dir(data_dir.join("runtime"));
        command
    } else {
        #[cfg(debug_assertions)]
        {
            // 开发环境可运行项目中的通用协议服务；安装私有适配器始终由用户在本机完成。
            let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../services/erp-worker");
            let executable = directory.join(if cfg!(windows) {
                ".venv/Scripts/python.exe"
            } else {
                ".venv/bin/python"
            });
            if !executable.is_file() {
                return Err("ERP_RUNTIME_UNAVAILABLE: 请在本机安装 ERP 可选运行时。".into());
            }
            let mut command = Command::new(executable);
            command
                .args(["-E", "-s", "-B"])
                .arg(directory.join("main.py"))
                .current_dir(directory);
            command
        }
        #[cfg(not(debug_assertions))]
        {
            return Err(
                "ERP_RUNTIME_UNAVAILABLE: 请在 data/runtime 放置本机 ERP 辅助程序。".into(),
            );
        }
    };
    // 本机接入配置固定在 data；worker 不接受命令行凭据或页面指定的配置路径。
    command.env("DIYTOOLS_INTEGRATIONS", data_dir.join("integrations.json"));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    // 先挂起、纳入作业对象再恢复，子进程及其后代统一受宿主管理。
    command.creation_flags(0x08000004);
    Ok(command)
}

// The job also terminates PyInstaller's child process when the app exits or times out.
#[cfg(windows)]
pub struct ProcessGuard(std::os::windows::io::OwnedHandle);
#[cfg(not(windows))]
pub struct ProcessGuard;

impl ProcessGuard {
    // Windows 先把挂起子进程纳入作业对象再恢复，保证退出或超时能回收它的后代进程。
    pub fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::*;
            unsafe {
                let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if raw.is_null() {
                    return Err("无法创建 ERP 进程保护".into());
                }
                let handle = OwnedHandle::from_raw_handle(raw);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                ) == 0
                    || AssignProcessToJobObject(
                        raw,
                        child.raw_handle().ok_or("ERP 进程不可用")? as _,
                    ) == 0
                {
                    return Err("无法保护 ERP 进程，请重新启动工作台。".into());
                }
                use windows_sys::Win32::System::{Diagnostics::ToolHelp::*, Threading::*};
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                    return Err("无法就绪 ERP 进程".into());
                }
                let snapshot = OwnedHandle::from_raw_handle(snapshot);
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                let mut found = false;
                let mut next = Thread32First(snapshot.as_raw_handle(), &mut entry);
                while next != 0 {
                    if Some(entry.th32OwnerProcessID) == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if thread.is_null() {
                            return Err("无法就绪 ERP 线程".into());
                        }
                        let thread = OwnedHandle::from_raw_handle(thread);
                        if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                            return Err("无法恢复 ERP 进程".into());
                        }
                        found = true;
                        break;
                    }
                    next = Thread32Next(snapshot.as_raw_handle(), &mut entry);
                }
                if !found {
                    return Err("无法定位 ERP 线程".into());
                }
                let guard = Self(handle);
                let _ = guard.0.as_raw_handle();
                Ok(guard)
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self)
        }
    }
}

// 公开 Excel 读取器随主程序交付，按内容摘要独立安装，不替换私有 ERP worker。
pub fn cost_command(data_dir: &Path) -> Result<Command,String> {
    use sha2::{Digest,Sha256};use std::{fs,io::Write};
    const READER:&[u8]=include_bytes!(concat!(env!("OUT_DIR"),"/cost-reader.exe"));
    if READER.is_empty(){return Err("请先构建内置 Excel 读取器".into());}
    let hash=format!("{:x}",Sha256::digest(READER));let dir=data_dir.join("runtime");fs::create_dir_all(&dir).map_err(|_|"无法准备 Excel 读取目录")?;
    let path=dir.join(format!("cost-reader-{hash}.exe"));
    if !path.exists(){
        let temporary=dir.join(format!("cost-reader-{}.tmp",uuid::Uuid::new_v4()));
        let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|"无法写入 Excel 读取器")?;
        f.write_all(READER).and_then(|_|f.sync_all()).map_err(|_|"Excel 读取器写入失败")?;drop(f);
        fs::rename(&temporary,&path).map_err(|_|"无法安装 Excel 读取器")?;
    }
    if format!("{:x}",Sha256::digest(fs::read(&path).map_err(|_|"无法校验 Excel 读取器")?))!=hash {return Err("Excel 读取器校验失败，请重新安装程序".into());}
    let mut command=Command::new(path);command.current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000004);
    Ok(command)
}
