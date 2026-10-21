//! 隔离测试宿主：只接受源码 sandbox 内已经存在的测试库，不初始化或迁移业务库。
use crate::{agent_entry, agent_jobs, workbench_store};
use std::io::{BufRead, Write};

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let sandbox = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../sandbox")
        .canonicalize()?;
    let directory = std::env::args_os()
        .nth(1)
        .ok_or("请指定 sandbox 内的隔离测试目录")?;
    let directory = std::path::PathBuf::from(directory).canonicalize()?;
    if directory == sandbox || !directory.starts_with(&sandbox)
    {
        return Err("仅允许使用 sandbox 子目录内的测试库".into());
    }
    let tasks = std::env::args().nth(2).as_deref() == Some("--tasks");
    let store = if tasks {
        let seed=directory.join("source-state.json").canonicalize()?;
        if !seed.starts_with(&directory) {return Err("测试种子路径越界".into());}
        if directory.join("workbench.sqlite").exists() && !directory.join("workbench.sqlite").canonicalize()?.starts_with(&directory) {return Err("测试库路径越界".into());}
        workbench_store::initialize(&directory.join("workbench.sqlite"),&seed,&directory.join("workbench-assets")).map_err(std::io::Error::other)?
    } else {
        let database=directory.join("workbench.sqlite").canonicalize()?;
        if !database.starts_with(&directory) {return Err("测试库路径越界".into());}
        workbench_store::WorkbenchStore {path:database,assets:directory.join("workbench-assets")}
    };
    let jobs=if tasks {Some(std::sync::Arc::new(agent_jobs::AgentJobs::new(directory.clone(),store.clone())?))}else{None};
    let entry = agent_entry::AgentEntry::start(store.clone(), jobs.clone())
        .map_err(|error| std::io::Error::other(error.message))?;
    println!(
        "{}",
        serde_json::json!({
            "ready": true,
            "instance": diytools_agent_core::instance_for_pid(std::process::id())
        })
    );
    std::io::stdout().flush()?;
    // 父测试进程关闭 stdin 即关闭管道；没有独立守护进程残留。
    if let Some(jobs)=jobs {
        for line in std::io::stdin().lock().lines() {
            let input:serde_json::Value=serde_json::from_str(&line?)?;
            let result:Result<serde_json::Value,String>=match input["action"].as_str().unwrap_or("") {
                "request"=>workbench_store::request(&store,input["method"].as_str().unwrap_or("GET"),input["path"].as_str().unwrap_or("/"),input["body"].as_str()).map(|r|serde_json::json!({"status":r.status,"body":r.body})),
                "ready"=>match input["session"].as_str(){Some(session)=>jobs.ready_session(session,input["connect"].as_bool().unwrap_or(false)),None=>jobs.ready()}.map(|_|serde_json::Value::Null).map_err(|e|e.to_string()),
                "claim"=>match input["session"].as_str(){Some(session)=>jobs.claim_session(session),None=>jobs.claim()}.map(|v|v.unwrap_or(serde_json::Value::Null)).map_err(|e|e.to_string()),
                "progress"=>{let mut value=input.clone();if let Some(object)=value.as_object_mut(){for key in ["id","action","session","claimToken"]{object.remove(key);}}jobs.progress(input["id"].as_str().unwrap_or(""),value).map(|_|serde_json::Value::Null).map_err(|e|e.to_string())},
                "complete"=>match input["session"].as_str(){Some(session)=>jobs.complete_session(session,input["id"].as_str().unwrap_or(""),input["claimToken"].as_str().unwrap_or(""),input.get("result").filter(|v|!v.is_null()).cloned(),input.get("error").filter(|v|!v.is_null()).cloned()),None=>jobs.complete(input["id"].as_str().unwrap_or(""),input.get("result").filter(|v|!v.is_null()).cloned(),input.get("error").filter(|v|!v.is_null()).cloned())}.map(|_|serde_json::Value::Null).map_err(|e|e.to_string()),
                "export.write"=>crate::agent_files::write(&jobs,input["jobId"].as_str().unwrap_or(""),input["name"].as_str().unwrap_or(""),input["base64"].as_str().unwrap_or("")),
                "export.finish"=>crate::agent_files::finish(&jobs,input["jobId"].as_str().unwrap_or(""),input["reportHtml"].as_str(),&input["manifest"]),
                _=>Err("不支持的隔离测试动作".into())
            };
            println!("{}",match result {Ok(value)=>serde_json::json!({"ok":true,"value":value}),Err(error)=>serde_json::json!({"ok":false,"error":error})});
            std::io::stdout().flush()?;
        }
    } else {let _ = std::io::stdin().lock().lines().next();}
    entry.stop();
    Ok(())
}
