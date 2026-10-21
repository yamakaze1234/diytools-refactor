// 真实云传输的无窗口验收宿主：密码只从标准输入进入，测试工作区门禁独立于生产实现。
use crate::cloud_transport::{CloudTransport, CloudTransportConfig};
use serde_json::{Value, json};
use std::{io::{BufRead, Write}, path::PathBuf};

struct ReviewSession {
    transport: CloudTransport,
    expected_workspace: String,
}

// 工作区不可在同一进程内重绑定；空标识或成员变化均拒绝业务访问。
fn require_test_member(expected: &str, member: Option<&Value>) -> Result<(), String> {
    if expected.is_empty() || expected == "workbench-main" || member.and_then(|m|m["workspaceId"].as_str()) != Some(expected) {
        return Err("REVIEW_WORKSPACE_MISMATCH: 非预期测试工作区，已禁止业务访问".into());
    }
    Ok(())
}

impl ReviewSession {
    fn status(&self) -> Result<Value, String> {
        let mut value=self.transport.status()?;
        value["testWorkspaceMatches"]=json!(require_test_member(&self.expected_workspace,value.get("member")).is_ok());
        Ok(value)
    }

    fn handle(&self, input: &Value) -> Result<Value, String> {
        match input["op"].as_str() {
            Some("login") => {
                let username=input["username"].as_str().ok_or("缺少用户名")?;
                let password=input["password"].as_str().ok_or("缺少密码")?;
                self.transport.login_with_remember(username,password,false)?;
                self.status()
            }
            Some("status") => self.status(),
            Some("logout") => {self.transport.logout()?;self.status()},
            Some("call") => {
                let request=input["request"].clone();
                let action=request["action"].as_str().ok_or("缺少业务动作")?;
                if action=="session.get" {return self.transport.call(request);}
                require_test_member(&self.expected_workspace,self.transport.current_member()?.as_ref())?;
                // 每次变更之前重新查询正式会话，防止测试成员被移动到其他工作区后仍然写入。
                if matches!(action,"sync.push"|"sync.pushBatch") {
                    self.transport.resume()?;
                    if let Err(error)=require_test_member(&self.expected_workspace,self.transport.current_member()?.as_ref()) {
                        self.transport.logout()?;
                        return Err(error);
                    }
                }
                self.transport.call(request)
            }
            _ => Err("不支持的验收操作".into()),
        }
    }
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    // 编译 feature 和实际执行目录双门禁；初始化不加载任何生产数据库或系统凭据。
    let sandbox=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox").canonicalize()?;
    let executable=std::env::current_exe()?.canonicalize()?;
    let directory=PathBuf::from(std::env::var_os("DIYTOOLS_REVIEW_DIRECTORY").ok_or("缺少隔离验收目录")?).canonicalize()?;
    if !executable.starts_with(&sandbox)||!directory.starts_with(&sandbox)||directory==sandbox||!directory.is_dir(){return Err("仅允许 sandbox 内的独立云验收宿主".into());}
    let stdin=std::io::stdin();let mut stdout=std::io::BufWriter::new(std::io::stdout());let mut session:Option<ReviewSession>=None;
    for line in stdin.lock().lines() {
        let line=line?;
        let result=(|| -> Result<Value,String> {
            if line.len()>1_000_000{return Err("验收输入过大".into());}
            let input:Value=serde_json::from_str(&line).map_err(|_|"验收输入不是有效 JSON")?;
            if input["op"]=="init" {
                if session.is_some(){return Err("验收工作区已固定，不能再次初始化".into());}
                let expected=input["expectedWorkspace"].as_str().filter(|s|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control)).ok_or("缺少预期测试工作区")?.to_string();
                if expected=="workbench-main" {return Err("REVIEW_PRODUCTION_WORKSPACE: 禁止将生产工作区用于验收".into());}
                let config:CloudTransportConfig=serde_json::from_value(input["config"].clone()).map_err(|_|"云传输配置无效")?;
                session=Some(ReviewSession{transport:CloudTransport::new(config)?,expected_workspace:expected});
                return session.as_ref().unwrap().status();
            }
            session.as_ref().ok_or("请先初始化验收传输")?.handle(&input)
        })();
        // 只输出脱敏会话与业务结果，禁止回显完整请求、配置、密码或原生令牌。
        let output=match result {Ok(value)=>json!({"ok":true,"result":value}),Err(error)=>json!({"ok":false,"error":error})};
        serde_json::to_writer(&mut stdout,&output)?;stdout.write_all(b"\n")?;stdout.flush()?;
    }
    if let Some(session)=session {let _=session.transport.logout();}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    // 门禁测试不联网：未登录、空预期和其他工作区均不能进入业务动作。
    fn only_exact_expected_workspace_passes() {
        assert!(require_test_member("test",None).is_err());
        assert!(require_test_member("",Some(&json!({"workspaceId":""}))).is_err());
        assert!(require_test_member("test",Some(&json!({"workspaceId":"production"}))).is_err());
        assert!(require_test_member("test",Some(&json!({"workspaceId":"test"}))).is_ok());
        assert!(require_test_member("workbench-main",Some(&json!({"workspaceId":"workbench-main"}))).is_err());
    }
}
