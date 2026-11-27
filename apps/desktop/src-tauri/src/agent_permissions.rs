//! 本机总开关独立保存；成员偏好与任务日志使用同一部署、工作区和账号范围。
use diytools_agent_core::AgentError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::RwLock,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Flags {
    pub read_configs: bool,
    pub read_sources: bool,
    pub read_inventory_activity: bool,
    pub write_draft_configs: bool,
    pub write_configs: bool,
    pub write_sources: bool,
    pub write_sources_shared: bool,
    pub write_sources_follow_configs: bool,
    pub allow_export: bool,
    pub allow_sync: bool,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            read_configs: true,
            read_sources: true,
            read_inventory_activity: true,
            write_draft_configs: false,
            write_configs: false,
            write_sources: false,
            write_sources_shared: false,
            write_sources_follow_configs: false,
            allow_export: false,
            allow_sync: false,
        }
    }
}

impl Flags {
    pub fn permits(&self, method: &str) -> bool {
        match method {
            "status" | "shops.list" | "jobs.status" => true,
            "configs.find" | "configs.get" => self.read_configs,
            "sources.find" | "sources.get" => self.read_sources,
            "inventory.check" | "activity.list" => self.read_inventory_activity,
            "changes.preview" | "changes.apply" => self.write_configs,
            "draft.preview" | "draft.apply" => self.write_draft_configs,
            "sources.preview" | "sources.apply" => self.write_sources,
            "export.start" => self.allow_export,
            "sync.run" => self.allow_sync,
            _ => false,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    enabled: bool,
    accounts: BTreeMap<String, Flags>,
}
pub(crate) struct Policy {
    path: PathBuf,
    state: RwLock<Document>,
}
type Result<T> = std::result::Result<T, AgentError>;

impl Policy {
    pub fn open(folder: &Path) -> io::Result<Self> {
        let path = folder.join("permissions.json");
        let document = match fs::read(&path) {
            Ok(bytes) => {
                let doc: Document = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                if doc.version != 1 {
                    return Err(io::Error::other("未知的 AI 权限文件版本"));
                }
                doc
            }
            // 只有首次使用可初始化，权限文件损坏或磁盘拒绝访问时关闭 Agent 入口。
            Err(err) if err.kind() == io::ErrorKind::NotFound => Document {
                version: 1,
                enabled: true,
                accounts: BTreeMap::new(),
            },
            Err(err) => return Err(err),
        };
        Ok(Self {
            path,
            state: RwLock::new(document),
        })
    }
    pub fn get(&self, scope: &str) -> Result<(bool, Flags)> {
        let state = self
            .state
            .read()
            .map_err(|_| AgentError::new("PERMISSIONS_UNAVAILABLE", "本机权限暂不可用"))?;
        Ok((
            state.enabled,
            state.accounts.get(scope).cloned().unwrap_or_default(),
        ))
    }
    pub fn update(
        &self,
        scope: &str,
        patch: &Value,
        three_shops: bool,
        config_writes: bool,
    ) -> Result<()> {
        let invalid = || AgentError::new("INVALID_PARAMS", "AI 权限包含未知字段或无效开关值");
        let fields = patch
            .as_object()
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        let mut state = self
            .state
            .write()
            .map_err(|_| AgentError::new("PERMISSIONS_UNAVAILABLE", "权限保存锁不可用"))?;
        let mut next = state.clone();
        let mut flags = json!(next.accounts.get(scope).cloned().unwrap_or_default());
        for (key, value) in fields {
            let checked = value.as_bool().ok_or_else(invalid)?;
            if key == "enabled" {
                next.enabled = checked;
            } else if let Some(field) = flags.get_mut(key) {
                *field = Value::Bool(checked);
            } else {
                return Err(invalid());
            }
        }
        let mut flags: Flags = serde_json::from_value(flags).map_err(|_| invalid())?;
        // 子开关不能独立留在开启态，界面预设与逐个勾选使用相同约束。
        flags.write_sources_shared &= flags.write_sources && three_shops;
        flags.write_sources_follow_configs &=
            flags.write_sources && flags.write_configs && config_writes;
        next.accounts.insert(scope.to_string(), flags);
        let tmp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let save = || -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&tmp)?;
            serde_json::to_writer_pretty(&mut file, &next).map_err(io::Error::other)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            crate::agent_jobs::replace(&tmp, &self.path)
        };
        if let Err(err) = save() {
            let _ = fs::remove_file(&tmp);
            return Err(AgentError::new(
                "PERMISSIONS_SAVE_FAILED",
                format!("无法保存本机权限：{err}"),
            ));
        }
        *state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_preferences_and_instance_switch_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let policy = Policy::open(dir.path()).unwrap();
        policy
            .update(
                "部署A/三店账号",
                &json!({"writeConfigs":true,"writeSources":true,
            "writeSourcesShared":true,"writeSourcesFollowConfigs":true}),
                true,
                true,
            )
            .unwrap();
        // 同机登录单店账号后仍是默认只读。总开关则对同一安装中的所有成员立即生效。
        assert_eq!(
            policy.get("部署A/单店账号").unwrap(),
            (true, Flags::default())
        );
        policy
            .update(
                "部署A/单店账号",
                &json!({"enabled":false,"writeSources":true,
            "writeSourcesShared":true,"writeSourcesFollowConfigs":true}),
                false,
                false,
            )
            .unwrap();
        let (enabled, flags) = Policy::open(dir.path())
            .unwrap()
            .get("部署A/三店账号")
            .unwrap();
        assert!(
            !enabled
                && flags.write_configs
                && flags.write_sources_shared
                && flags.write_sources_follow_configs
        );
        let (_, single) = policy.get("部署A/单店账号").unwrap();
        assert!(!single.write_sources_shared && !single.write_sources_follow_configs);
        assert_eq!(policy.get("部署B/三店账号").unwrap().1, Flags::default());
        assert!(
            policy
                .update(
                    "部署A/单店账号",
                    &json!({"enabled":true,"invented":true}),
                    false,
                    false
                )
                .is_err()
        );
        assert!(!policy.get("部署A/单店账号").unwrap().0);
    }

    #[test]
    fn damaged_or_unknown_permission_data_never_enables_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("permissions.json");
        for bytes in [
            "{",
            "{}",
            r#"{"version":2,"enabled":true,"accounts":{}}"#,
            r#"{"version":1,"enabled":true,"accounts":{"a":{}}}"#,
        ] {
            fs::write(&file, bytes).unwrap();
            assert!(Policy::open(dir.path()).is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), bytes);
        }
    }
}
