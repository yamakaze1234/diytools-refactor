// 旧数据迁移样本库：保留完整 JSON 和导入包原文，以独立本机版本管理改名与撤销。
//! Isolated legacy snapshots. Preserve the complete JSON state and archive exact bundle bytes.
//! Only an explicit config-name edit is allowed; local revisions never reuse legacy revisions.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const DATABASE_VERSION: i64 = 1;

#[derive(Clone)]
pub struct ImportedStore(pub PathBuf);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub source_label: String,
    pub config_count: usize,
    pub active_count: usize,
    pub shop_count: usize,
    pub issues: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub workspace_id: String,
    pub already_imported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub source_label: String,
    pub config_count: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub id: String,
    pub revision: i64,
    pub undo_count: i64,
    pub state: Value,
}

struct Bundle {
    bytes: Vec<u8>,
    state: Value,
    preview: Preview,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("隔离迁移数据库操作失败：{error}")
}

fn connect(path: &Path) -> Result<Connection> {
    // Never silently recreate a deleted database during an edit/read.
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version != DATABASE_VERSION {
        return Err(format!(
            "不支持的隔离迁移数据库版本 {version}，未修改数据。"
        ));
    }
    Ok(connection)
}

// 初始化隔离导入库及撤销结构，不打开或修改旧生产数据库。
pub fn initialize(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建迁移目录：{e}"))?;
    }
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version == 0 {
        tx.execute_batch(
            "CREATE TABLE imported_workspaces (
            id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, source_label TEXT NOT NULL,
            config_count INTEGER NOT NULL CHECK(config_count >= 0),
            revision INTEGER NOT NULL CHECK(revision >= 1), state_json TEXT NOT NULL,
            original_bundle BLOB NOT NULL);
            CREATE TABLE imported_undo_history (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL REFERENCES imported_workspaces(id),
            before_revision INTEGER NOT NULL CHECK(before_revision >= 1),
            config_id TEXT NOT NULL, name_existed INTEGER NOT NULL CHECK(name_existed IN (0,1)),
            before_name_json TEXT, after_name TEXT NOT NULL,
            CHECK((name_existed=0 AND before_name_json IS NULL) OR (name_existed=1 AND before_name_json IS NOT NULL)));
            CREATE INDEX imported_undo_workspace ON imported_undo_history(workspace_id, sequence);
            PRAGMA user_version=1;",
        )
        .map_err(db_error)?;
    } else if version != DATABASE_VERSION {
        return Err(format!(
            "不支持的隔离迁移数据库版本 {version}，未修改数据。"
        ));
    }
    tx.commit().map_err(db_error)
}

fn size_error() -> String {
    "迁移包超过 64 MiB（67,108,864 字节）上限。此阶段请先生成较小的隔离样本；全量迁移需要后续分页方案。".into()
}

// 限制导入包大小并完整读取原文字节，以便摘要确认和精确保留原始包。
fn read_bundle(path: &Path) -> Result<Bundle> {
    let file = File::open(path).map_err(|e| format!("无法读取迁移包：{e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取迁移包信息：{e}"))?;
    if !metadata.is_file() {
        return Err("迁移包路径必须是普通 JSON 文件。".into());
    }
    if metadata.len() > MAX_BUNDLE_BYTES {
        return Err(size_error());
    }
    // take also bounds a concurrently growing file; do not allocate from untrusted metadata.
    let mut bytes = Vec::new();
    file.take(MAX_BUNDLE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取迁移包失败：{e}"))?;
    if bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err(size_error());
    }
    parse_bundle(bytes)
}

// 验证完整状态的最低业务结构，同时保留当前模型未认识的字段。
fn validate_state(state: &Value) -> Result<&Vec<Value>> {
    let state = state.as_object().ok_or("迁移包 state 必须是 JSON 对象。")?;
    let configs = state
        .get("configs")
        .and_then(Value::as_array)
        .ok_or("迁移包 state.configs 必须是数组。")?;
    let mut ids = HashSet::new();
    for (index, config) in configs.iter().enumerate() {
        let object = config
            .as_object()
            .ok_or_else(|| format!("第 {} 条配置必须是 JSON 对象。", index + 1))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("第 {} 条配置 ID 必须是字符串。", index + 1))?;
        if id.trim().is_empty() || !ids.insert(id) {
            return Err(format!("第 {} 条配置 ID 为空或重复。", index + 1));
        }
    }
    Ok(configs)
}

// Match legacy JavaScript truthiness for deletedAt without changing the original value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn deleted(config: &Value) -> bool {
    config.get("deletedAt").is_some_and(truthy)
}

// 先检查 JSON 语法，再显式构造对象，拒绝重复键并保留未知键及精确数字语义。
fn parse_json(bytes: &[u8]) -> Result<Value> {
    // Validate the grammar first without allocating values. Build objects explicitly afterwards:
    // Value's default visitor silently accepts duplicate keys, and arbitrary_precision uses an
    // internal number marker which must not reinterpret a legitimate unknown object key.
    serde_json::from_slice::<serde::de::IgnoredAny>(bytes)
        .map_err(|e| format!("不是有效的 UTF-8 JSON：{e}"))?;
    StrictJson { bytes, position: 0 }.value(0)
}

struct StrictJson<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl StrictJson<'_> {
    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.position)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.position += 1;
        }
    }
    fn string(&mut self) -> Result<String> {
        let start = self.position;
        self.position += 1;
        while let Some(byte) = self.bytes.get(self.position) {
            if *byte == b'"' {
                self.position += 1;
                return serde_json::from_slice(&self.bytes[start..self.position])
                    .map_err(|e| e.to_string());
            }
            if *byte == b'\\' {
                self.position += 1;
            }
            self.position += 1;
        }
        Err("JSON 字符串不完整。".into())
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > 128 {
            return Err("JSON 嵌套超过 128 层上限。".into());
        }
        self.whitespace();
        match self.bytes.get(self.position) {
            Some(b'{') => {
                self.position += 1;
                self.whitespace();
                let mut map = serde_json::Map::new();
                if self.bytes.get(self.position) == Some(&b'}') {
                    self.position += 1;
                    return Ok(Value::Object(map));
                }
                loop {
                    self.whitespace();
                    let key = self.string()?;
                    if map.contains_key(&key) {
                        return Err(format!("JSON 对象包含重复键 {key:?}，未导入数据。"));
                    }
                    self.whitespace();
                    self.position += 1; // Grammar validation established the colon.
                    let value = self.value(depth + 1)?;
                    map.insert(key, value);
                    self.whitespace();
                    let separator = self.bytes.get(self.position);
                    self.position += 1;
                    if separator == Some(&b'}') {
                        return Ok(Value::Object(map));
                    }
                }
            }
            Some(b'[') => {
                self.position += 1;
                self.whitespace();
                let mut array = Vec::new();
                if self.bytes.get(self.position) == Some(&b']') {
                    self.position += 1;
                    return Ok(Value::Array(array));
                }
                loop {
                    array.push(self.value(depth + 1)?);
                    self.whitespace();
                    let separator = self.bytes.get(self.position);
                    self.position += 1;
                    if separator == Some(&b']') {
                        return Ok(Value::Array(array));
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(_) => {
                let start = self.position;
                while self
                    .bytes
                    .get(self.position)
                    .is_some_and(|byte| !byte.is_ascii_whitespace() && !b",]}".contains(byte))
                {
                    self.position += 1;
                }
                let token = &self.bytes[start..self.position];
                match token {
                    b"null" => Ok(Value::Null),
                    b"true" => Ok(Value::Bool(true)),
                    b"false" => Ok(Value::Bool(false)),
                    _ => serde_json::from_slice::<serde_json::Number>(token)
                        .map(Value::Number)
                        .map_err(|e| e.to_string()),
                }
            }
            None => Err("JSON 内容不完整。".into()),
        }
    }
}

// 检查迁移协议、来源和状态，按原始字节生成预览令牌，不改写业务字段。
fn parse_bundle(bytes: Vec<u8>) -> Result<Bundle> {
    let value = parse_json(&bytes)?;
    let object = value.as_object().ok_or("迁移包必须是 JSON 对象。")?;
    if object.get("formatVersion").and_then(Value::as_u64) != Some(1) {
        return Err("不支持的迁移包 formatVersion，只支持版本 1。".into());
    }
    let source = object
        .get("source")
        .and_then(Value::as_object)
        .ok_or("迁移包 source 必须是 JSON 对象。")?;
    let source_label = source
        .get("label")
        .and_then(Value::as_str)
        .ok_or("迁移包 source.label 必须是字符串。")?
        .to_owned();
    let report = object
        .get("report")
        .and_then(Value::as_object)
        .ok_or("迁移包 report 必须是 JSON 对象。")?;
    let mut issues = Vec::new();
    if let Some(raw_issues) = report.get("issues") {
        let raw_issues = raw_issues
            .as_array()
            .ok_or("迁移包 report.issues 必须是数组。")?;
        // Reports may include structured issues. Return plain JSON text, never HTML.
        for issue in raw_issues {
            issues.push(
                issue
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| issue.to_string()),
            );
        }
    }
    let state = object.get("state").ok_or("迁移包缺少 state。")?;
    let configs = validate_state(state)?;
    let config_count = configs.len();
    let active_count = configs.iter().filter(|config| !deleted(config)).count();
    let mut shops = HashSet::new();
    for config in configs {
        if let Some(id) = config
            .get("shopId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            shops.insert(id);
        }
    }
    if let Some(declared) = state.get("shops").and_then(Value::as_array) {
        for shop in declared {
            if let Some(id) = shop
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                shops.insert(id);
            }
        }
    }
    let preview = Preview {
        token: format!("{:x}", Sha256::digest(&bytes)),
        source_label,
        config_count,
        active_count,
        shop_count: shops.len(),
        issues,
    };
    Ok(Bundle {
        state: state.clone(),
        bytes,
        preview,
    })
}

// 只读取并检查迁移包，返回数量与摘要令牌，不创建导入工作区。
pub fn preview(path: &Path) -> Result<Preview> {
    Ok(read_bundle(path)?.preview)
}

// 读取独立导入工作区并校验状态，损坏记录不能进入改名或撤销流程。
fn read_detail(connection: &Connection, id: &str) -> Result<Detail> {
    let row: Option<(i64, String)> = connection
        .query_row(
            "SELECT revision,state_json FROM imported_workspaces WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let (revision, json) = row.ok_or("导入工作区不存在，请刷新列表。")?;
    let state =
        parse_json(json.as_bytes()).map_err(|e| format!("导入工作区数据损坏，未修改数据：{e}"))?;
    validate_state(&state)?;
    let undo_count = connection
        .query_row(
            "SELECT COUNT(*) FROM imported_undo_history WHERE workspace_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    Ok(Detail {
        id: id.to_owned(),
        revision,
        undo_count,
        state,
    })
}

// 生成本机递增版本，恢复旧内容时不复用旧快照版本号。
fn next_revision(revision: i64) -> Result<i64> {
    revision
        .checked_add(1)
        .ok_or_else(|| "工作区版本已达上限，未修改数据。".into())
}

// 所有导入样本编辑都以预期版本校验并发，防止旧页面覆盖新保存。
fn check_revision(detail: &Detail, expected: i64) -> Result<()> {
    if detail.revision != expected {
        return Err("工作区版本已变化，请重新读取后再操作；当前草稿仍保留。".into());
    }
    Ok(())
}

impl ImportedStore {
    // 重新读取包并核对预览令牌，保存原始包与完整状态后才确认导入。
    pub fn apply(&self, path: &Path, expected_token: &str) -> Result<ImportResult> {
        let bundle = read_bundle(path)?;
        if bundle.preview.token != expected_token {
            return Err("迁移包在预览后已变化，请重新预览并确认，未导入数据。".into());
        }
        let mut connection = connect(&self.0)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM imported_workspaces WHERE token=?1",
                [expected_token],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(workspace_id) = existing {
            tx.commit().map_err(db_error)?;
            return Ok(ImportResult {
                workspace_id,
                already_imported: true,
            });
        }
        let workspace_id = format!("import-{}", bundle.preview.token);
        let json = serde_json::to_string(&bundle.state).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO imported_workspaces(id,token,source_label,config_count,revision,state_json,original_bundle) VALUES (?1,?2,?3,?4,1,?5,?6)",
            params![workspace_id, expected_token, bundle.preview.source_label, bundle.preview.config_count as i64, json, bundle.bytes]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(ImportResult {
            workspace_id,
            already_imported: false,
        })
    }

    pub fn list(&self) -> Result<Vec<Summary>> {
        let connection = connect(&self.0)?;
        let mut stmt = connection
            .prepare("SELECT id,source_label,config_count FROM imported_workspaces ORDER BY rowid")
            .map_err(db_error)?;
        stmt.query_map([], |row| {
            Ok(Summary {
                id: row.get(0)?,
                source_label: row.get(1)?,
                config_count: row.get(2)?,
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)
    }

    pub fn detail(&self, id: &str) -> Result<Detail> {
        let mut connection = connect(&self.0)?;
        let tx = connection.transaction().map_err(db_error)?;
        let result = read_detail(&tx, id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }

    // 仅修改目标配置名称；完整状态其余字段保持原样，并记录撤销前值。
    pub fn rename(
        &self,
        id: &str,
        config_id: &str,
        name: &str,
        expected_revision: i64,
    ) -> Result<Detail> {
        if name.trim().is_empty() || name.chars().count() > 120 {
            return Err("配置名称需要 1–120 个字符。".into());
        }
        let mut connection = connect(&self.0)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut current = read_detail(&tx, id)?;
        check_revision(&current, expected_revision)?;
        let config = current
            .state
            .get_mut("configs")
            .and_then(Value::as_array_mut)
            .unwrap()
            .iter_mut()
            .find(|config| config.get("id").and_then(Value::as_str) == Some(config_id))
            .ok_or("配置不存在，请重新读取工作区。")?;
        if deleted(config) {
            return Err("已删除配置只保留归档，此阶段不能编辑。".into());
        }
        if config.get("name").and_then(Value::as_str) != Some(name) {
            let before_name = config
                .get("name")
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| e.to_string())?;
            let name_existed = before_name.is_some();
            config
                .as_object_mut()
                .unwrap()
                .insert("name".into(), Value::String(name.to_owned()));
            let revision = next_revision(current.revision)?;
            let json = serde_json::to_string(&current.state).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO imported_undo_history(workspace_id,before_revision,config_id,name_existed,before_name_json,after_name) VALUES (?1,?2,?3,?4,?5,?6)", params![id, current.revision, config_id, name_existed, before_name, name]).map_err(db_error)?;
            tx.execute(
                "UPDATE imported_workspaces SET state_json=?2,revision=?3 WHERE id=?1",
                params![id, json, revision],
            )
            .map_err(db_error)?;
        }
        let result = read_detail(&tx, id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }

    // 从导入工作区的撤销记录恢复内容，同时递增本机并发版本。
    pub fn undo(&self, id: &str, expected_revision: i64) -> Result<Detail> {
        let mut connection = connect(&self.0)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut current = read_detail(&tx, id)?;
        check_revision(&current, expected_revision)?;
        let latest: Option<(i64, i64, String, i64, Option<String>, String)> = tx.query_row("SELECT sequence,before_revision,config_id,name_existed,before_name_json,after_name FROM imported_undo_history WHERE workspace_id=?1 ORDER BY sequence DESC LIMIT 1", [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).optional().map_err(db_error)?;
        let (sequence, before_revision, config_id, name_existed, before_name_json, after_name) =
            latest.ok_or("没有可以撤销的名称修改。")?;
        let previous_name = match (name_existed, before_name_json) {
            (0, None) => None,
            (1, Some(json)) => {
                Some(parse_json(json.as_bytes()).map_err(|_| "撤销记录损坏，未修改数据。")?)
            }
            _ => return Err("撤销记录名称状态无效，未修改数据。".into()),
        };
        if before_revision >= current.revision {
            return Err("撤销记录版本无效，未修改数据。".into());
        }
        // Restore only the exact name field; unrelated state is never sourced from history.
        let configs = current
            .state
            .get_mut("configs")
            .and_then(Value::as_array_mut)
            .unwrap();
        let target = configs
            .iter_mut()
            .find(|config| config.get("id").and_then(Value::as_str) == Some(config_id.as_str()))
            .ok_or("撤销记录配置不存在，未修改数据。")?;
        if deleted(target) {
            return Err("撤销记录含已删除配置，未修改数据。".into());
        }
        if target.get("name").and_then(Value::as_str) != Some(after_name.as_str()) {
            return Err("撤销记录与当前配置名称不一致，未修改数据。".into());
        }
        if let Some(name) = previous_name {
            target.as_object_mut().unwrap().insert("name".into(), name);
        } else {
            target.as_object_mut().unwrap().remove("name");
        }
        let revision = next_revision(current.revision)?;
        let json = serde_json::to_string(&current.state).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE imported_workspaces SET state_json=?2,revision=?3 WHERE id=?1",
            params![id, json, revision],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM imported_undo_history WHERE sequence=?1",
            [sequence],
        )
        .map_err(db_error)?;
        let result = read_detail(&tx, id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
}

#[tauri::command]
pub async fn preview_legacy_import(path: String) -> Result<Preview> {
    tauri::async_runtime::spawn_blocking(move || preview(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn apply_legacy_import(
    store: tauri::State<'_, ImportedStore>,
    path: String,
    expected_token: String,
) -> Result<ImportResult> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.apply(Path::new(&path), &expected_token))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn list_imported_workspaces(
    store: tauri::State<'_, ImportedStore>,
) -> Result<Vec<Summary>> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_imported_workspace(
    store: tauri::State<'_, ImportedStore>,
    workspace_id: String,
) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.detail(&workspace_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn rename_imported_config(
    store: tauri::State<'_, ImportedStore>,
    workspace_id: String,
    config_id: String,
    name: String,
    expected_revision: i64,
) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.rename(&workspace_id, &config_id, &name, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn undo_imported_workspace(
    store: tauri::State<'_, ImportedStore>,
    workspace_id: String,
    expected_revision: i64,
) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.undo(&workspace_id, expected_revision))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // Test artifacts stay in ignored sandbox for the main agent to recycle after review.
    fn root() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox")
            .join(format!(
                "test-migration-store-{}-{stamp}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    fn synthetic() -> Value {
        json!({"formatVersion":1,"source":{"label":"isolated sample","snapshotId":"sample","unknown":null},
        "report":{"issues":["unmapped ERP", {"kind":"missing asset"}],"counts":{},"extra":false},
        "state":{"revision":923,"unknown":{"null":null,"nested":[1, false, {"layout":"original"}]},
            "shops":[{"id":"店铺二"},{"id":"店铺一"}],"configs":[
            {"id":"000001","shopId":"店铺一","spu":"0000000000000123","name":"原名",
                "parts":[{"id":"p","qty":2,"displayName":"<b>原样</b>","unitCost":12.345}],
                "actualParts":[],"priceCents":879900,"costOverride":123456,
                "sourceFollow":{"id":"source-1","fields":["name"]},"deletedAt":null,"layout":{"x":1}},
            {"id":"another","shopId":"店铺二","name":null,"parts":[],"actualParts":null,"manualPrice":true},
            {"id":"deleted","shopId":"店铺二","deletedAt":"2026-10-01","name":"已删","unknown":[null]}
        ]}})
    }
    fn fixture() -> (ImportedStore, PathBuf, Value) {
        let root = root();
        let store = ImportedStore(root.join("migration.sqlite"));
        initialize(&store.0).unwrap();
        let value = synthetic();
        let bundle = root.join("bundle.json");
        std::fs::write(&bundle, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        (store, bundle, value)
    }
    fn import(store: &ImportedStore, bundle: &Path) -> String {
        let token = preview(bundle).unwrap().token;
        store.apply(bundle, &token).unwrap().workspace_id
    }

    #[test]
    fn preview_is_read_only_reports_counts_and_sha256() {
        let root = root();
        let bundle = root.join("bundle.json");
        let bytes = serde_json::to_vec_pretty(&synthetic()).unwrap();
        std::fs::write(&bundle, &bytes).unwrap();
        let before = std::fs::read(&bundle).unwrap();
        let result = preview(&bundle).unwrap();
        assert_eq!(result.token, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(
            (result.config_count, result.active_count, result.shop_count),
            (3, 2, 2)
        );
        assert_eq!(result.issues.len(), 2);
        assert_eq!(std::fs::read(&bundle).unwrap(), before);
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 1);
    }

    #[test]
    fn changed_bytes_after_preview_rejected_without_import() {
        let (store, bundle, _) = fixture();
        let token = preview(&bundle).unwrap().token;
        let mut bytes = std::fs::read(&bundle).unwrap();
        bytes.push(b'\n');
        std::fs::write(&bundle, &bytes).unwrap();
        assert!(
            store
                .apply(&bundle, &token)
                .unwrap_err()
                .contains("预览后已变化")
        );
        assert!(store.list().unwrap().is_empty());
        assert_eq!(std::fs::read(&bundle).unwrap(), bytes);
    }

    #[test]
    fn archive_and_reopen_rename_undo_preserve_every_other_field() {
        let (store, bundle, original) = fixture();
        let bytes = std::fs::read(&bundle).unwrap();
        let id = import(&store, &bundle);
        let initial = store.detail(&id).unwrap();
        assert_eq!(initial.state, original["state"]);
        assert_eq!(initial.revision, 1);
        let mut expected = initial.state.clone();
        expected["configs"][0]["name"] = json!("保留 BOM 与手改价");
        let saved = store.rename(&id, "000001", "保留 BOM 与手改价", 1).unwrap();
        assert_eq!(saved.state, expected);
        assert_eq!((saved.revision, saved.undo_count), (2, 1));
        let reopened = ImportedStore(store.0.clone());
        initialize(&reopened.0).unwrap();
        assert_eq!(reopened.detail(&id).unwrap(), saved);
        let undone = reopened.undo(&id, 2).unwrap();
        assert_eq!(undone.state, initial.state);
        assert_eq!((undone.revision, undone.undo_count), (3, 0));
        assert_eq!(ImportedStore(store.0.clone()).detail(&id).unwrap(), undone);
        let archive: Vec<u8> = connect(&store.0)
            .unwrap()
            .query_row(
                "SELECT original_bundle FROM imported_workspaces WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archive, bytes);
        assert_eq!(std::fs::read(&bundle).unwrap(), bytes);
        assert_eq!(store.list().unwrap()[0].config_count, 3);
    }

    #[test]
    fn duplicate_import_keeps_later_edits_and_history() {
        let (store, bundle, _) = fixture();
        let token = preview(&bundle).unwrap().token;
        let initial = store.apply(&bundle, &token).unwrap();
        assert!(!initial.already_imported);
        let saved = store
            .rename(&initial.workspace_id, "000001", "已修改", 1)
            .unwrap();
        let repeated = store.apply(&bundle, &token).unwrap();
        assert!(repeated.already_imported);
        assert_eq!(repeated.workspace_id, initial.workspace_id);
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.detail(&repeated.workspace_id).unwrap(), saved);
    }

    #[test]
    fn stale_invalid_deleted_and_noop_are_atomic() {
        let (store, bundle, _) = fixture();
        let id = import(&store, &bundle);
        assert_eq!(
            (
                store.rename(&id, "000001", "原名", 1).unwrap().revision,
                store.detail(&id).unwrap().undo_count
            ),
            (1, 0)
        );
        let saved = store.rename(&id, "000001", "first", 1).unwrap();
        for (config_id, name, revision) in [
            ("000001", "stale", 1),
            ("000001", " ", 2),
            ("deleted", "bad", 2),
            ("missing", "bad", 2),
        ] {
            assert!(store.rename(&id, config_id, name, revision).is_err());
            assert_eq!(store.detail(&id).unwrap(), saved);
        }
        assert!(store.undo(&id, 1).is_err());
        assert_eq!(store.detail(&id).unwrap(), saved);
    }

    #[test]
    fn missing_and_null_names_restored_by_multiple_undo() {
        let (store, bundle, mut value) = fixture();
        value["state"]["configs"][0]
            .as_object_mut()
            .unwrap()
            .remove("name");
        std::fs::write(&bundle, serde_json::to_vec(&value).unwrap()).unwrap();
        let id = import(&store, &bundle);
        store.rename(&id, "000001", "first", 1).unwrap();
        store.rename(&id, "another", "second", 2).unwrap();
        let first_undo = store.undo(&id, 3).unwrap();
        assert_eq!(first_undo.state["configs"][1]["name"], Value::Null);
        let second_undo = store.undo(&id, 4).unwrap();
        assert_eq!(second_undo.state, value["state"]);
        assert!(second_undo.state["configs"][0].get("name").is_none());
        assert_eq!((second_undo.revision, second_undo.undo_count), (5, 0));
        assert!(store.undo(&id, 5).is_err());
    }

    #[test]
    fn invalid_bundle_shapes_and_ids_rejected() {
        let original = synthetic();
        let mut variants = Vec::new();
        for field in ["state", "source", "report"] {
            let mut bad = original.clone();
            bad[field] = Value::Null;
            variants.push(bad);
        }
        let mut bad = original.clone();
        bad["formatVersion"] = json!(2);
        variants.push(bad);
        let mut bad = original.clone();
        bad["state"]["configs"] = json!({});
        variants.push(bad);
        for id in [
            json!(""),
            json!("  "),
            json!(123),
            Value::Null,
            json!("000001"),
        ] {
            let mut bad = original.clone();
            bad["state"]["configs"][1]["id"] = id;
            variants.push(bad);
        }
        for bad in variants {
            assert!(parse_bundle(serde_json::to_vec(&bad).unwrap()).is_err());
        }
        assert!(parse_bundle(vec![0xff]).is_err());
        assert!(parse_bundle(b"{broken".to_vec()).is_err());
    }

    #[test]
    fn oversized_sparse_file_fails_before_loading() {
        let path = root().join("large.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_BUNDLE_BYTES + 1)
            .unwrap();
        assert!(preview(&path).unwrap_err().contains("64 MiB"));
    }

    #[test]
    fn exact_string_ids_empty_configs_unknown_numbers_and_truthiness() {
        let mut value = synthetic();
        value["state"]["configs"][1]["id"] = json!("1");
        let mut bundle = parse_bundle(serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(bundle.preview.config_count, 3);
        value["state"]["configs"] = json!([]);
        bundle = parse_bundle(serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            (bundle.preview.config_count, bundle.preview.active_count),
            (0, 0)
        );
        let (store, path, _) = fixture();
        let bytes = br#"{"formatVersion":1,"source":{"label":"numbers"},"report":{},"state":{"large":123456789012345678901234567890,"fraction":0.12345678901234567890,"configs":[{"id":"1","name":"n"}]}}"#;
        std::fs::write(&path, bytes).unwrap();
        let id = import(&store, &path);
        let original = store.detail(&id).unwrap();
        store.rename(&id, "1", "new", 1).unwrap();
        let restored = store.undo(&id, 2).unwrap();
        assert_eq!(original.state, restored.state);
        assert_eq!(
            restored.state["large"].to_string(),
            "123456789012345678901234567890"
        );
        assert_eq!(
            restored.state["fraction"].to_string(),
            "0.12345678901234567890"
        );
        for deleted_at in [Value::Null, json!(false), json!(0), json!("")] {
            assert!(!deleted(&json!({"deletedAt":deleted_at})));
        }
        for deleted_at in [json!(true), json!(1), json!("time"), json!([]), json!({})] {
            assert!(deleted(&json!({"deletedAt":deleted_at})));
        }
    }

    #[test]
    fn database_failure_rolls_back_rename_history_and_undo() {
        let (store, bundle, _) = fixture();
        let id = import(&store, &bundle);
        let initial = store.detail(&id).unwrap();
        let connection = connect(&store.0).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON imported_workspaces BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(store.rename(&id, "000001", "fail", 1).is_err());
        assert_eq!(store.detail(&id).unwrap(), initial);
        connection
            .execute_batch("DROP TRIGGER reject_update;")
            .unwrap();
        let saved = store.rename(&id, "000001", "saved", 1).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_pop BEFORE DELETE ON imported_undo_history BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(store.undo(&id, 2).is_err());
        assert_eq!(store.detail(&id).unwrap(), saved);
    }

    #[test]
    fn failed_import_and_unsupported_database_do_not_write() {
        let (store, bundle, _) = fixture();
        let connection = connect(&store.0).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON imported_workspaces BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(
            store
                .apply(&bundle, &preview(&bundle).unwrap().token)
                .is_err()
        );
        assert!(store.list().unwrap().is_empty());
        connection.pragma_update(None, "user_version", 99).unwrap();
        assert!(initialize(&store.0).is_err());
        assert!(store.list().is_err());
        assert!(
            store
                .apply(&bundle, &preview(&bundle).unwrap().token)
                .is_err()
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM imported_workspaces", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn corrupted_undo_cannot_change_unrelated_fields() {
        let (store, bundle, _) = fixture();
        let id = import(&store, &bundle);
        let saved = store.rename(&id, "000001", "new", 1).unwrap();
        connect(&store.0)
            .unwrap()
            .execute(
                "UPDATE imported_undo_history SET before_name_json=?1",
                ["{broken"],
            )
            .unwrap();
        assert!(store.undo(&id, 2).unwrap_err().contains("记录损坏"));
        assert_eq!(store.detail(&id).unwrap(), saved);
        connect(&store.0)
            .unwrap()
            .execute(
                "UPDATE imported_undo_history SET before_name_json='null',after_name='wrong'",
                [],
            )
            .unwrap();
        assert!(store.undo(&id, 2).unwrap_err().contains("名称不一致"));
        assert_eq!(store.detail(&id).unwrap(), saved);
    }

    #[test]
    fn duplicate_keys_rejected_at_all_levels_and_escaped_keys_match() {
        for bytes in [
            br#"{"state":{},"state":{}}"#.as_slice(),
            br#"{"state":{"configs":[{"id":"1","name":"first","name":"last"}]}}"#.as_slice(),
            br#"{"report":{"nested":[{"name":1,"\u006eame":2}]}}"#.as_slice(),
        ] {
            assert!(parse_json(bytes).unwrap_err().contains("重复键"));
        }
        // A serde_json internal marker remains an ordinary unknown object field.
        let parsed = parse_json(br#"{"$serde_json::private::Number":"123","nested":{"large":123456789012345678901234567890}}"#).unwrap();
        assert!(parsed.is_object());
        assert_eq!(parsed["$serde_json::private::Number"], json!("123"));
        assert_eq!(parse_json(parsed.to_string().as_bytes()).unwrap(), parsed);
    }

    #[test]
    fn history_contains_only_the_name_even_when_state_is_large() {
        let (store, bundle, mut value) = fixture();
        value["state"]["largeUnknown"] = json!("x".repeat(1024 * 1024));
        std::fs::write(&bundle, serde_json::to_vec(&value).unwrap()).unwrap();
        let id = import(&store, &bundle);
        store.rename(&id, "000001", "small", 1).unwrap();
        let history_size: i64 = connect(&store.0).unwrap().query_row("SELECT length(before_name_json)+length(after_name)+length(config_id) FROM imported_undo_history",[],|row| row.get(0)).unwrap();
        assert!(history_size < 100);
        assert_eq!(store.undo(&id, 2).unwrap().state, value["state"]);
    }

    #[test]
    #[ignore = "Run explicitly with DIYTOOLS_REVIEW_BUNDLE pointing to an isolated sandbox bundle"]
    fn review_bundle_import_rename_reopen_undo() {
        let path = PathBuf::from(
            std::env::var_os("DIYTOOLS_REVIEW_BUNDLE").expect("Set DIYTOOLS_REVIEW_BUNDLE"),
        );
        let sandbox = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox")
            .canonicalize()
            .unwrap();
        assert!(
            path.canonicalize().unwrap().starts_with(&sandbox),
            "Review bundle must be inside the ignored sandbox"
        );
        let source = std::fs::read(&path).unwrap();
        let root = root();
        let store = ImportedStore(root.join("migration.sqlite"));
        initialize(&store.0).unwrap();
        let bundle = read_bundle(&path).unwrap();
        let id = store
            .apply(&path, &bundle.preview.token)
            .unwrap()
            .workspace_id;
        let initial = store.detail(&id).unwrap();
        assert!(initial.state == bundle.state, "Import changed state");
        let config_id = validate_state(&initial.state)
            .unwrap()
            .iter()
            .find(|config| !deleted(config))
            .and_then(|config| config.get("id"))
            .and_then(Value::as_str)
            .expect("Review bundle needs an active config")
            .to_owned();
        let name = if initial.state["configs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|config| config["id"] == config_id)
            .unwrap()
            .get("name")
            .and_then(Value::as_str)
            == Some("isolated review rename")
        {
            "isolated review rename 2"
        } else {
            "isolated review rename"
        };
        let mut expected = initial.state.clone();
        expected["configs"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|config| config["id"] == config_id)
            .unwrap()["name"] = json!(name);
        let saved = store.rename(&id, &config_id, name, 1).unwrap();
        assert!(saved.state == expected, "Rename changed unrelated state");
        let reopened = ImportedStore(store.0.clone());
        initialize(&reopened.0).unwrap();
        assert!(
            reopened.detail(&id).unwrap() == saved,
            "Reopen changed saved state"
        );
        assert!(
            reopened
                .apply(&path, &bundle.preview.token)
                .unwrap()
                .already_imported,
            "Repeated import was not idempotent"
        );
        assert!(
            reopened.detail(&id).unwrap() == saved,
            "Repeated import reverted edits"
        );
        let undone = reopened.undo(&id, saved.revision).unwrap();
        assert!(
            undone.state == initial.state,
            "Undo changed unrelated state"
        );
        assert!(
            undone.revision == 3 && undone.undo_count == 0,
            "Undo metadata invalid"
        );
        assert!(
            ImportedStore(store.0.clone()).detail(&id).unwrap() == undone,
            "Undo did not persist"
        );
        let archive: Vec<u8> = connect(&store.0)
            .unwrap()
            .query_row(
                "SELECT original_bundle FROM imported_workspaces WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(archive == source, "Archive bytes changed");
        assert!(
            std::fs::read(&path).unwrap() == source,
            "Source bytes changed"
        );
        println!(
            "isolated review passed: {} configs; test DB: {}",
            bundle.preview.config_count,
            store.0.display()
        );
    }

    #[test]
    fn concurrent_import_creates_one_workspace_and_concurrent_rename_has_one_winner() {
        let (store, bundle, _) = fixture();
        let token = preview(&bundle).unwrap().token;
        let mut handles = Vec::new();
        for _ in 0..2 {
            let (store, bundle, token) = (store.clone(), bundle.clone(), token.clone());
            handles.push(std::thread::spawn(move || {
                store.apply(&bundle, &token).unwrap()
            }));
        }
        let first = handles.remove(0).join().unwrap();
        let second = handles.remove(0).join().unwrap();
        assert_eq!(first.workspace_id, second.workspace_id);
        assert_ne!(first.already_imported, second.already_imported);
        let id = first.workspace_id;
        let mut handles = Vec::new();
        for name in ["one", "two"] {
            let (store, id) = (store.clone(), id.clone());
            handles.push(std::thread::spawn(move || {
                store.rename(&id, "000001", name, 1)
            }));
        }
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
        let detail = store.detail(&id).unwrap();
        assert_eq!((detail.revision, detail.undo_count), (2, 1));
    }
}
