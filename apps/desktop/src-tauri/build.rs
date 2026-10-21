// 构建时嵌入独立 CLI，使旧版仅替换主 EXE 的更新方式也能补齐 Agent 入口。
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=DIYTOOLS_AGENT_CLI_PATH");
    println!("cargo:rerun-if-env-changed=CARGO_TARGET_DIR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var_os("CARGO_FEATURE_AGENT_TOOLS").is_some()
    {
        let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
        let cli = if let Some(path) = env::var_os("DIYTOOLS_AGENT_CLI_PATH") {
            PathBuf::from(path)
        } else {
            let target = env::var_os("CARGO_TARGET_DIR").map(|path| {
                let path = PathBuf::from(path);
                if path.is_absolute() { path } else { root.join(path) }
            })
                .unwrap_or_else(|| root.join("packages/agent-cli/target"));
            target.join("release/diytools-agent.exe")
        };
        let cli = fs::canonicalize(&cli).unwrap_or_else(|_| panic!(
            "Agent CLI missing: {}. Build packages/agent-cli first, or set DIYTOOLS_AGENT_CLI_PATH.", cli.display()));
        println!("cargo:rerun-if-changed={}", cli.display());
        let bytes = fs::read(&cli).expect("Cannot read Agent CLI");
        let offset = bytes.get(0x3c..0x40).and_then(|v| v.try_into().ok()).map(u32::from_le_bytes).unwrap_or(0) as usize;
        assert!(bytes.starts_with(b"MZ") && offset >= 0x40
            && bytes.get(offset..offset.saturating_add(6)) == Some(&b"PE\0\0\x64\x86"[..]),
            "Agent CLI must be a valid Windows x64 PE executable");
        let optional_size = u16::from_le_bytes(bytes.get(offset + 20..offset + 22).expect("Missing PE header").try_into().unwrap()) as usize;
        let sections = u16::from_le_bytes(bytes.get(offset + 6..offset + 8).expect("Missing PE sections").try_into().unwrap()) as usize;
        assert!(optional_size >= 112 && sections > 0
            && bytes.get(offset + 24..offset + 26) == Some(&[0x0b, 0x02][..])
            && bytes.len() >= offset + 24 + optional_size + sections * 40,
            "Agent CLI must contain complete PE32+ headers and section table");
        // 复制到 OUT_DIR，include_bytes 不依赖路径中的引号或非 ASCII 字符。
        fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("diytools-agent.exe"), bytes)
            .expect("Cannot stage embedded Agent CLI");
    }
    tauri_build::build()
}
