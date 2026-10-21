//! 主 EXE 自备 CLI；安装目录只写工具与连接描述，不触碰 data。
use std::{fs, io::{self, Write}, path::{Path, PathBuf}};
use sha2::{Digest, Sha256};

const CLI: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/diytools-agent.exe"));

pub fn enabled(value: Option<&std::ffi::OsStr>) -> bool {
    value != Some(std::ffi::OsStr::new("0"))
}

fn regular_or_missing(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            use std::os::windows::fs::MetadataExt;
            if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other("Agent 文件位置被目录或链接占用"));
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

// MoveFileEx 替换同卷文件，不先删除旧文件；失败时保留原件。
fn replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32; }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(io::Error::last_os_error())
    } else { Ok(()) }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> io::Result<()> {
    regular_or_missing(target)?;
    let temporary = target.with_file_name(format!(".agent-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        regular_or_missing(target)?;
        replace(&temporary, target)
    })();
    // 仅清理本次 create_new 生成的临时文件，不删除既有安装文件。
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

pub fn prepare(directory: &Path) -> io::Result<PathBuf> { prepare_bytes(directory, CLI) }

fn prepare_bytes(directory: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    use std::os::windows::fs::MetadataExt;
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err(io::Error::other("Agent 安装目录不能是链接"));
    }
    let primary = directory.join("diytools-agent.exe");
    if regular_or_missing(&primary)? {
        match fs::read(&primary) {
            Ok(current) if current == bytes => return Ok(primary),
            Ok(_) => {},
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {},
            Err(error) => return Err(error),
        }
    }
    match atomic_write(&primary, bytes) {
        Ok(()) => Ok(primary),
        Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
            // 正在执行的旧 CLI 可能被 Windows 锁定；新连接使用内容寻址文件，旧进程保持运行。
            let digest = format!("{:x}", Sha256::digest(bytes));
            let alternate = directory.join(format!("diytools-agent-{}.exe", &digest[..16]));
            if !(regular_or_missing(&alternate)? && fs::read(&alternate)? == bytes) {
                atomic_write(&alternate, bytes)?;
            }
            Ok(alternate)
        }
        Err(error) => Err(error),
    }
}

pub fn publish(directory: &Path, cli: &Path, executable: &Path, pid: u32) -> io::Result<()> {
    let connection = serde_json::json!({
        "instance": format!("desktop-{pid}"), "pid": pid, "exe": executable,
        "cli": cli, "updatedAt": chrono::Utc::now().to_rfc3339()
    });
    atomic_write(&directory.join("agent-connection.json"), &serde_json::to_vec_pretty(&connection)?)
}

pub fn report_failure(directory: &Path, error: &io::Error) {
    // 不记录请求、环境值、成员凭据；写盘失败仍用原生提示给出可定位错误。
    let message = format!("Agent 入口未启用，工作台可继续使用。请检查程序目录写入权限及 Agent 文件占用情况。\n错误类别：{:?}；系统错误码：{:?}", error.kind(), error.raw_os_error());
    let path = directory.join("agent-bootstrap-error.txt");
    let _ = atomic_write(&path, message.as_bytes());
    std::thread::spawn(move || {
        rfd::MessageDialog::new().set_title("DIY Tools Agent 入口启动失败")
            .set_description(format!("{message}\n诊断文件：{}", path.display()))
            .set_level(rfd::MessageLevel::Error).show();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("diytools-bootstrap-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn exe_only_upgrade_prepares_cli_and_refreshes_pid_without_touching_data() {
        let fixture = Fixture::new(); let dir = &fixture.0;
        fs::write(dir.join("DIYTools.exe"), b"host").unwrap();
        fs::write(dir.join("diytools-portable.json"), br#"{"mode":"portable"}"#).unwrap();
        let cli = prepare_bytes(dir, b"cli-v1").unwrap();
        publish(dir, &cli, &dir.join("DIYTools.exe"), 123).unwrap();
        fs::create_dir(dir.join("data")).unwrap();
        fs::write(dir.join("data/business"), b"preserve").unwrap();
        let cli = prepare_bytes(dir, b"cli-v2").unwrap();
        publish(dir, &cli, &dir.join("DIYTools.exe"), 456).unwrap();
        assert_eq!(fs::read(cli).unwrap(), b"cli-v2");
        let value: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("agent-connection.json")).unwrap()).unwrap();
        assert_eq!(value["pid"], 456); assert_eq!(value["instance"], "desktop-456");
        assert_eq!(fs::read(dir.join("data/business")).unwrap(), b"preserve");
    }
    #[test]
    fn locked_old_cli_uses_new_content_addressed_path() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new(); let dir = &fixture.0;
        let primary = prepare_bytes(dir, b"old").unwrap();
        let _locked = fs::OpenOptions::new().read(true).share_mode(0).open(&primary).unwrap();

        let selected = prepare_bytes(dir, b"new").unwrap();
        assert_ne!(selected, primary); assert_eq!(fs::read(selected).unwrap(), b"new");
        drop(_locked);
        assert_eq!(fs::read(primary).unwrap(), b"old");
    }
    #[test]
    fn rejects_directory_conflicts_and_preserves_existing_connection() {
        let fixture = Fixture::new(); let dir = &fixture.0;
        fs::create_dir(dir.join("diytools-agent.exe")).unwrap();
        assert!(prepare_bytes(dir, b"new").is_err());
        fs::create_dir(dir.join("agent-connection.json")).unwrap();
        assert!(publish(dir, &dir.join("cli"), &dir.join("exe"), 1).is_err());
    }
    #[test]
    fn enabled_by_default_and_explicit_zero_disables() {
        assert!(enabled(None)); assert!(enabled(Some("1".as_ref())));
        assert!(!enabled(Some("0".as_ref())));
    }
}
