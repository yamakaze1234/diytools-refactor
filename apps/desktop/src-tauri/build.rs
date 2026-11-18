// 构建时嵌入独立 CLI，使旧版仅替换主 EXE 的更新方式也能补齐 Agent 入口。
use std::{env, fs, path::PathBuf};

fn main() {
    // 仅正式构建可注入默认认证接入；只提取两个非密码字段，原文件不进入源码或交付包。
    println!("cargo:rerun-if-env-changed=DIYTOOLS_AUTH_DEFAULTS_PATH");
    let auth=if env::var_os("CARGO_FEATURE_FORMAL_NAS_CLIENT").is_some() {
        if let Some(path)=env::var_os("DIYTOOLS_AUTH_DEFAULTS_PATH") {
            println!("cargo:rerun-if-changed={}",PathBuf::from(&path).display());
            let bytes=fs::read(path).expect("Cannot read default authentication settings");
            assert!(bytes.len()<=64*1024,"Authentication settings too large");
            let document:serde_json::Value=serde_json::from_slice(&bytes).expect("Invalid authentication settings JSON");
            let cloud=document.get("cloud").and_then(|value|value.as_object()).expect("Missing authentication settings");
            assert!(document["version"]==1 && cloud.len()==2,"Only authentication endpoint and environment may be embedded");
            let environment=cloud.get("envId").and_then(|v|v.as_str()).expect("Missing authentication environment");
            let endpoint=cloud.get("endpoint").and_then(|v|v.as_str()).expect("Missing authentication endpoint");
            assert!(!environment.is_empty()&&environment.len()<=128&&environment.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'),"Invalid authentication environment");
            assert!(endpoint.starts_with("https://")&&endpoint.len()<=2048&&!endpoint.contains(['@','?','#','\n','\r']),"Invalid authentication endpoint");
            serde_json::to_vec(&serde_json::json!({"envId":environment,"endpoint":endpoint})).expect("Cannot encode authentication defaults")
        } else {Vec::new()}
    } else {Vec::new()};
    // 每次明确写入，包括无默认值的构建，避免增量编译残留旧组织信息。
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("auth-defaults.json"),auth).expect("Cannot stage authentication defaults");
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
    println!("cargo:rerun-if-env-changed=DIYTOOLS_COST_READER_PATH");
    let bytes=if let Some(path)=env::var_os("DIYTOOLS_COST_READER_PATH") {
        println!("cargo:rerun-if-changed={}",PathBuf::from(&path).display());
        let bytes=fs::read(path).expect("Cannot read public Excel reader");assert!(bytes.starts_with(b"MZ"),"Invalid Excel reader executable");bytes
    } else {
        assert!(env::var("PROFILE").as_deref()!=Ok("release") || env::var("CARGO_CFG_TARGET_OS").as_deref()!=Ok("windows"),"Build tools/build-cost-reader.ps1 first and set DIYTOOLS_COST_READER_PATH");Vec::new()
    };
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("cost-reader.exe"),bytes).expect("Cannot embed Excel reader");
    tauri_build::build()
}
