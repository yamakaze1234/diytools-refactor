//! 完整桌面验收包仅连接本包启动的合成服务。正式构建不编入本入口。
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{OnceLock, mpsc},
    time::{Duration, Instant},
};

const DEPLOYMENT: &str = "intel-production-acceptance";
static SESSION: OnceLock<(String,String)> = OnceLock::new();

pub struct LocalAcceptance {
    child: Child,
    _guard: File,
}
impl Drop for LocalAcceptance {
    fn drop(&mut self) {
        // 关闭管道让服务先完成持久化，之后才释放目录独占锁。
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) { return; }
            std::thread::sleep(Duration::from_millis(40));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn transport() -> Result<crate::cloud_transport::CloudTransport,String> {
    let (url,token)=SESSION.get().ok_or("完整测试服务尚未启动")?;
    crate::cloud_transport::CloudTransport::acceptance(url,token)
}

// 必须在 Tauri 初始化前调用。启动参数只由本包的回环服务产生。
pub fn start() -> Result<LocalAcceptance,String> {
    let exe = std::env::current_exe().map_err(|_|"无法定位完整测试版")?;
    let dir = exe.parent().ok_or("无法定位完整测试版")?;
    let engine = dir.join("验收服务");
    let data = dir.join("acceptance-data");
    std::fs::create_dir_all(&data).map_err(|_|"请将完整测试包解压到可写目录")?;
    let guard=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(data.join("run.lock"))
        .map_err(|_|"无法打开独立验收目录")?;
    guard.try_lock().map_err(|_|"这一份完整测试版已运行，请返回已打开的窗口")?;
    let ca = std::fs::read_to_string(engine.join("fixture/test-ca.pem")).map_err(|_|"请完整解压测试包，缺少验收证书")?;
    let log = File::create(data.join("startup.log")).map_err(|_|"无法写入测试启动日志")?;
    let token=uuid::Uuid::new_v4().to_string();
    let mut command=Command::new(engine.join("node.exe"));
    command.arg(engine.join("services/nas-api/tools/shared-sources-acceptance.mjs")).arg(engine.join("fixture")).arg(&data)
        .current_dir(&engine).env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env("DIYTOOLS_ACCEPTANCE_TOKEN",&token)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child=command.spawn().map_err(|_|"无法启动验收服务，请完整解压测试包")?;
    let mut process=LocalAcceptance{child,_guard:guard};
    let stdout=process.child.stdout.take().ok_or("验收服务启动输出不可用")?;
    let (tx,rx)=mpsc::channel();
    std::thread::spawn(move||{
        let mut result=String::new();
        if BufReader::new(stdout).read_line(&mut result).is_ok(){ let _=tx.send(result); }
    });
    let line=rx.recv_timeout(Duration::from_secs(40)).map_err(|_|"验收服务未就绪，请查看 acceptance-data/startup.log")?;
    let url=crate::cloud_native::nas_base(line.trim())
        .filter(|url|url.host_str()==Some("127.0.0.1")&&url.port().is_some_and(|port|port>=1024))
        .ok_or("验收服务未返回回环地址，请查看 acceptance-data/startup.log")?;
    let client=crate::cloud_transport::nas_tls_client(ca.as_bytes())?;
    let health=url.join("/healthz").map_err(|_|"验收服务地址无效")?;
    let response=client.get(health).send().map_err(|_|"验收服务的 HTTPS 证书核验失败")?;
    if !response.status().is_success()||response.headers().get("x-workbench-deployment").and_then(|h|h.to_str().ok())!=Some(DEPLOYMENT) {
        return Err("验收服务未通过启动核对".into());
    }
    let _=SESSION.set((url.to_string(),token));
    // 子进程已启动，仍在主线程装配 Tauri；下面变量只给当前验收版读取。
    unsafe {
        std::env::set_var("DIYTOOLS_NAS_MAIN","1");
        std::env::set_var("DIYTOOLS_NAS_API_URL",url.as_str());
        std::env::set_var("DIYTOOLS_NAS_DEPLOYMENT_ID",DEPLOYMENT);
        std::env::set_var("DIYTOOLS_NAS_CA_PEM",ca);
        std::env::set_var("DIYTOOLS_NAS_SYSTEM_CA","0");
        std::env::set_var("DIYTOOLS_AGENT_ENABLED","0");
        std::env::remove_var("DIYTOOLS_CONNECTION_ERROR");
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER",data.join("webview2"));
    }
    Ok(process)
}
