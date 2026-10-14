//! 重构样本专用存储。金额为整数分；每次事务只处理一套实际配置。
//! 撤销栈随业务事务写入，恢复旧内容时递增版本，不能回退并发版本号。
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct LocalStore(pub PathBuf);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub category: String,
    pub name: String,
    pub quantity: i64,
    pub unit_cost_cents: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub id: String,
    pub name: String,
    pub sale_price_cents: i64,
    pub revision: i64,
    pub actual_parts: Vec<Part>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub sale_price_cents: i64,
    pub revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub config: Config,
    pub undo_count: i64,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("本地数据库操作失败：{error}")
}

fn connect(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error)?;
    Ok(connection)
}

// 创建独立样本库结构，仅空库放入演示配置，不用于导入完整生产工作台。
pub fn initialize(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut connection = connect(path)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(db_error)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version == 0 {
        tx.execute_batch("CREATE TABLE configs (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, sale_price_cents INTEGER NOT NULL CHECK(sale_price_cents >= 0), revision INTEGER NOT NULL);
            CREATE TABLE actual_parts (
            config_id TEXT NOT NULL REFERENCES configs(id), id TEXT NOT NULL, position INTEGER NOT NULL,
            category TEXT NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
            unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0), PRIMARY KEY(config_id,id));
            CREATE TABLE undo_history (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, config_id TEXT NOT NULL REFERENCES configs(id), before_json TEXT NOT NULL);
            CREATE INDEX undo_config ON undo_history(config_id, sequence);
            PRAGMA user_version=1;").map_err(db_error)?;
        // 只在首次建库时生成虚构样本，不因列表为空或重启覆盖用户编辑。
        for config in samples() {
            tx.execute(
                "INSERT INTO configs VALUES (?1,?2,?3,?4)",
                params![
                    config.id,
                    config.name,
                    config.sale_price_cents,
                    config.revision
                ],
            )
            .map_err(db_error)?;
            write_parts(&tx, &config)?;
        }
    } else if version != 1 {
        return Err(format!("不支持的样本数据库版本 {version}，未修改数据。"));
    }
    tx.commit().map_err(db_error)
}

fn samples() -> Vec<Config> {
    [
        ("sample-office", "办公配置 · 样本", 299_900),
        ("sample-gaming", "游戏配置 · 样本", 599_900),
        ("sample-creator", "创作配置 · 样本", 899_900),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, name, price))| Config {
        id: id.into(),
        name: name.into(),
        sale_price_cents: price,
        revision: 1,
        actual_parts: [
            (
                "cpu",
                "CPU",
                "示例处理器",
                1,
                80_000 + index as i64 * 40_000,
            ),
            ("board", "主板", "示例主板", 1, 50_000),
            ("ram", "内存", "示例内存 16GB", 2, 20_000),
            ("ssd", "硬盘", "示例固态 1TB", 1, 35_000),
            ("case", "机箱", "示例机箱", 1, 20_000),
            ("psu", "电源", "示例电源", 1, 25_000),
        ]
        .into_iter()
        .map(|(id, category, name, quantity, unit_cost_cents)| Part {
            id: id.into(),
            category: category.into(),
            name: name.into(),
            quantity,
            unit_cost_cents,
        })
        .collect(),
    })
    .collect()
}

// 保存前检查配置身份、整数分金额及配件数量，避免无效样本进入事务。
fn validate(config: &Config) -> Result<()> {
    if config.name.trim().is_empty() || config.name.chars().count() > 120 {
        return Err("配置名称需要 1–120 个字符。".into());
    }
    if !(0..=1_000_000_000).contains(&config.sale_price_cents) {
        return Err("售价必须在 0–1000 万元之间。".into());
    }
    if config.actual_parts.is_empty() || config.actual_parts.len() > 100 {
        return Err("实际配件需要 1–100 行。".into());
    }
    let mut ids = HashSet::new();
    for part in &config.actual_parts {
        if part.id.is_empty() || part.id.len() > 100 || !ids.insert(&part.id) {
            return Err("配件 ID 为空或重复。".into());
        }
        if part.name.trim().is_empty()
            || part.name.chars().count() > 200
            || part.category.trim().is_empty()
            || part.category.chars().count() > 30
        {
            return Err("请填写有效的配件类别和名称。".into());
        }
        if !(1..=999).contains(&part.quantity)
            || !(0..=1_000_000_000).contains(&part.unit_cost_cents)
        {
            return Err("配件数量需为 1–999 的整数，单价需在 0–1000 万元之间。".into());
        }
    }
    Ok(())
}

// 按原顺序替换一套配置的实际配件；调用者须与配置及撤销记录置于同一事务。
fn write_parts(connection: &Connection, config: &Config) -> Result<()> {
    connection
        .execute("DELETE FROM actual_parts WHERE config_id=?1", [&config.id])
        .map_err(db_error)?;
    for (position, part) in config.actual_parts.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO actual_parts VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    config.id,
                    part.id,
                    position as i64,
                    part.category,
                    part.name,
                    part.quantity,
                    part.unit_cost_cents
                ],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

// 读取配置、按顺序的实际配件和可撤销次数，保持详情回执一致。
fn read_detail(connection: &Connection, id: &str) -> Result<Detail> {
    let mut config = connection
        .query_row(
            "SELECT id,name,sale_price_cents,revision FROM configs WHERE id=?1",
            [id],
            |row| {
                Ok(Config {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sale_price_cents: row.get(2)?,
                    revision: row.get(3)?,
                    actual_parts: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or("配置不存在，请刷新列表。")?;
    let mut stmt=connection.prepare("SELECT id,category,name,quantity,unit_cost_cents FROM actual_parts WHERE config_id=?1 ORDER BY position").map_err(db_error)?;
    config.actual_parts = stmt
        .query_map([id], |row| {
            Ok(Part {
                id: row.get(0)?,
                category: row.get(1)?,
                name: row.get(2)?,
                quantity: row.get(3)?,
                unit_cost_cents: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let undo_count = connection
        .query_row(
            "SELECT COUNT(*) FROM undo_history WHERE config_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    Ok(Detail { config, undo_count })
}

impl LocalStore {
    // 列表只返回摘要字段，完整配件由详情入口另行读取。
    pub fn list(&self) -> Result<Vec<Summary>> {
        let connection = connect(&self.0)?;
        let mut stmt = connection
            .prepare("SELECT id,name,sale_price_cents,revision FROM configs ORDER BY rowid")
            .map_err(db_error)?;
        stmt.query_map([], |row| {
            Ok(Summary {
                id: row.get(0)?,
                name: row.get(1)?,
                sale_price_cents: row.get(2)?,
                revision: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)
    }
    // 在同一读取事务中获取配置和配件，避免跨保存版本拼接详情。
    pub fn detail(&self, id: &str) -> Result<Detail> {
        let mut connection = connect(&self.0)?;
        let tx = connection.transaction().map_err(db_error)?;
        let result = read_detail(&tx, id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
    // 核对当前版本后保存，内容确有变化才递增版本并写入撤销快照。
    pub fn save(&self, mut config: Config) -> Result<Detail> {
        validate(&config)?;
        config.name = config.name.trim().to_string();
        let mut connection = connect(&self.0)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current = read_detail(&tx, &config.id)?;
        if current.config.revision != config.revision {
            return Err("配置已在其他窗口修改。请重新读取后再编辑，当前草稿仍保留。".into());
        }
        if current.config != config {
            tx.execute(
                "INSERT INTO undo_history(config_id,before_json) VALUES (?1,?2)",
                params![
                    config.id,
                    serde_json::to_string(&current.config).map_err(|e| e.to_string())?
                ],
            )
            .map_err(db_error)?;
            config.revision += 1;
            tx.execute(
                "UPDATE configs SET name=?2,sale_price_cents=?3,revision=?4 WHERE id=?1",
                params![
                    config.id,
                    config.name,
                    config.sale_price_cents,
                    config.revision
                ],
            )
            .map_err(db_error)?;
            write_parts(&tx, &config)?;
        }
        let result = read_detail(&tx, &config.id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
    // 恢复内容但继续递增版本，同时消费最新撤销记录，避免版本号倒退。
    pub fn undo(&self, id: &str, expected_revision: i64) -> Result<Detail> {
        let mut connection = connect(&self.0)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current = read_detail(&tx, id)?;
        if current.config.revision != expected_revision {
            return Err("配置版本已变化，请重新读取后再撤销。".into());
        }
        let (sequence,json):(i64,String)=tx.query_row("SELECT sequence,before_json FROM undo_history WHERE config_id=?1 ORDER BY sequence DESC LIMIT 1", [id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(db_error)?.ok_or("没有可以撤销的保存记录。")?;
        let mut before: Config =
            serde_json::from_str(&json).map_err(|_| "撤销记录损坏，未修改配置。".to_string())?;
        validate(&before)?;
        if before.id != id {
            return Err("撤销记录所属配置不一致，未修改配置。".into());
        }
        before.revision = current.config.revision + 1;
        tx.execute(
            "UPDATE configs SET name=?2,sale_price_cents=?3,revision=?4 WHERE id=?1",
            params![id, before.name, before.sale_price_cents, before.revision],
        )
        .map_err(db_error)?;
        write_parts(&tx, &before)?;
        tx.execute("DELETE FROM undo_history WHERE sequence=?1", [sequence])
            .map_err(db_error)?;
        let result = read_detail(&tx, id)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
}

#[tauri::command]
pub async fn list_configs(store: tauri::State<'_, LocalStore>) -> Result<Vec<Summary>> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_config(store: tauri::State<'_, LocalStore>, id: String) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.detail(&id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_config(store: tauri::State<'_, LocalStore>, config: Config) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.save(config))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn undo_config(
    store: tauri::State<'_, LocalStore>,
    id: String,
    expected_revision: i64,
) -> Result<Detail> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.undo(&id, expected_revision))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> LocalStore {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = root.join(format!(
            "test-local-store-{}-{stamp}.sqlite",
            std::process::id()
        ));
        initialize(&path).unwrap();
        LocalStore(path)
    }
    #[test]
    fn save_reopen_undo_reopen_preserves_values_and_other_config() {
        let store = store();
        let original = store.detail("sample-office").unwrap().config;
        let other = store.detail("sample-gaming").unwrap().config;
        let mut changed = original.clone();
        changed.name = "持久化验证".into();
        changed.sale_price_cents = 123456;
        changed.actual_parts[2].quantity = 3;
        changed.actual_parts[2].unit_cost_cents = 12345;
        let saved = store.save(changed).unwrap();
        let reopened = LocalStore(store.0.clone());
        initialize(&reopened.0).unwrap();
        assert_eq!(reopened.detail(&original.id).unwrap().config, saved.config);
        assert_eq!(reopened.detail(&other.id).unwrap().config, other);
        let undone = reopened.undo(&original.id, saved.config.revision).unwrap();
        assert_eq!(undone.config.actual_parts, original.actual_parts);
        assert_eq!(undone.config.name, original.name);
        assert_eq!(undone.config.sale_price_cents, original.sale_price_cents);
        assert_eq!(undone.config.revision, 3);
        assert_eq!(
            LocalStore(store.0).detail(&original.id).unwrap().undo_count,
            0
        );
    }
    #[test]
    fn stale_save_and_undo_do_not_overwrite_newer_content() {
        let store = store();
        let original = store.detail("sample-office").unwrap().config;
        let mut changed = original.clone();
        changed.name = "新版本".into();
        let saved = store.save(changed).unwrap();
        assert!(store.save(original.clone()).is_err());
        assert!(store.undo(&original.id, original.revision).is_err());
        assert_eq!(store.detail(&original.id).unwrap().config, saved.config);
        assert_eq!(store.detail(&original.id).unwrap().undo_count, 1);
    }
    #[test]
    fn invalid_part_does_not_create_history_or_partial_save() {
        let store = store();
        let original = store.detail("sample-office").unwrap().config;
        let mut changed = original.clone();
        changed.name = "不应保存".into();
        changed.actual_parts[0].quantity = 0;
        assert!(store.save(changed).is_err());
        let result = store.detail(&original.id).unwrap();
        assert_eq!(result.config, original);
        assert_eq!(result.undo_count, 0);
    }
    #[test]
    fn multiple_undo_and_noop_save() {
        let store = store();
        let original = store.detail("sample-office").unwrap().config;
        assert_eq!(store.save(original.clone()).unwrap().undo_count, 0);
        let mut one = original.clone();
        one.name = "第一步".into();
        let first = store.save(one).unwrap();
        let mut two = first.config.clone();
        two.name = "第二步".into();
        let second = store.save(two).unwrap();
        let undone = store.undo(&original.id, second.config.revision).unwrap();
        assert_eq!(undone.config.name, "第一步");
        assert_eq!(
            store
                .undo(&original.id, undone.config.revision)
                .unwrap()
                .config
                .name,
            original.name
        );
    }
    #[test]
    fn database_failure_rolls_back_config_and_history() {
        let store = store();
        let original = store.detail("sample-office").unwrap().config;
        let connection = connect(&store.0).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_part BEFORE INSERT ON actual_parts BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").unwrap();
        let mut changed = original.clone();
        changed.name = "失败的事务".into();
        assert!(store.save(changed).is_err());
        let result = store.detail(&original.id).unwrap();
        assert_eq!(result.config, original);
        assert_eq!(result.undo_count, 0);
    }
}
