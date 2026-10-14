// 分实体权威存储：根元数据与每套配置分开保存，全量 JSON 仅供兼容读取时组装。
//! Schema 3 uses independent configuration records. The legacy name is a read-only view.
use super::*;

const SCHEMA_VERSION: i64 = 3;

// 迁移期间主连接持有写锁；另一个只读连接备份已提交快照，包含 WAL 中的资料。
pub(super) fn backup_before_migration(tx: &Transaction, path: &Path) -> Result<()> {
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|e| e.to_string())?;
    let legacy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='workbench_state' AND type='table')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if version == SCHEMA_VERSION || !legacy { return Ok(()); }
    let directory = path.parent().ok_or("数据库目录无效")?.join("schema-backups");
    fs::create_dir_all(&directory).map_err(|e| format!("迁移前备份目录创建失败：{e}"))?;
    let backup = directory.join(format!("pre-v3-{}.sqlite", unique()));
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    source.backup("main", &backup, None).map_err(|e| format!("迁移前备份失败，原库未迁移：{e}"))?;
    let verify = Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let health: String = verify.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if health != "ok" { return Err("迁移前备份完整性检查失败，原库未迁移".into()); }
    // 备份旁保留机器可读记录，降级工具必须使用该库而不能只替换 EXE。
    let record = json!({"schemaBefore":version,"schemaAfter":SCHEMA_VERSION,"database":path.file_name().and_then(|v|v.to_str()),"backup":backup.file_name().and_then(|v|v.to_str()),"quickCheck":health,"createdAt":now()});
    fs::write(backup.with_extension("json"), record.to_string()).map_err(|e| format!("迁移备份记录失败：{e}"))?;
    Ok(())
}

// 测试通过真实实体写入构造夹具，避免向只读兼容视图添加生产写入后门。
#[cfg(test)]
pub(crate) fn replace_fixture(c: &Connection, value: &Value) {
    let tx = c.unchecked_transaction().unwrap();
    replace(&tx, value).unwrap();
    tx.commit().unwrap();
}

// 未知新版本必须在任何建表或写入前拒绝，不能把未来数据库当成旧快照迁移。
pub(super) fn check_version(c: &Connection) -> Result<()> {
    let version: i64 = c.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|e| e.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!("本机数据库版本 {version} 高于此程序支持的版本 {SCHEMA_VERSION}，请更新程序"));
    }
    Ok(())
}

// 调用方持有初始化写事务：创建实体、核对数据和切换兼容入口必须同时提交。
pub(super) fn initialize(tx: &Transaction) -> Result<()> {
    check_version(tx)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|e|e.to_string())?;
    if version == SCHEMA_VERSION {
        let layout: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_metadata') AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_configs') AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='workbench_state')", [], |row|row.get(0)).map_err(|e|e.to_string())?;
        if !layout {return Err("本机数据库实体结构不完整，未重新导入或覆盖现有资料".into());}
        return Ok(());
    }
    // 逐套读取旧文档，避免同时构造旧库与新库的整份 Rust 对象树。
    let valid: bool = tx.query_row("SELECT json_valid(document) AND json_type(document,'$.configs')='array' FROM workbench_state WHERE id=1", [], |row|row.get(0)).map_err(|e|e.to_string())?;
    if !valid {return Err("旧配置数据不是有效数组，迁移已取消".into());}
    tx.execute_batch("CREATE TABLE workbench_metadata(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document,'$.configs') IS NULL));
        CREATE TABLE workbench_configs(id TEXT PRIMARY KEY CHECK(length(id)>0),position INTEGER NOT NULL UNIQUE CHECK(position>=0),document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object' AND json_type(document,'$.id')='text' AND json_extract(document,'$.id')=id));").map_err(|e|e.to_string())?;
    {
        let mut source = tx.prepare("SELECT CAST(j.key AS INTEGER),j.value FROM workbench_state s,json_each(s.document,'$.configs') j WHERE s.id=1 ORDER BY CAST(j.key AS INTEGER)").map_err(|e|e.to_string())?;
        let mut insert = tx.prepare("INSERT INTO workbench_configs VALUES(?1,?2,?3)").map_err(|e|e.to_string())?;
        for item in source.query_map([],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).map_err(|e|e.to_string())? {
            let (position,raw) = item.map_err(|e|e.to_string())?;
            let row: Value = serde_json::from_str(&raw).map_err(|e|e.to_string())?;
            let id = row["id"].as_str().filter(|id|!id.is_empty()).ok_or("配置 ID 无效，迁移已取消")?;
            if row.get("actualParts").is_some_and(|parts|!parts.is_array()&&!parts.is_null()) {return Err("实际配置格式无效，迁移已取消".into());}
            insert.execute(params![id,position,raw]).map_err(|e|e.to_string())?;
        }
    }
    tx.execute("INSERT INTO workbench_metadata SELECT id,json_remove(document,'$.configs') FROM workbench_state", []).map_err(|e|e.to_string())?;
    // 不保留会过期的旧 JSON 副本；旧 EXE 写入该视图将明确失败，回退须恢复迁移前备份。
    tx.execute_batch("DROP TRIGGER IF EXISTS workbench_state_header_insert;
        DROP TRIGGER IF EXISTS workbench_state_header_update;
        DROP TRIGGER IF EXISTS workbench_state_header_delete;
        DROP TABLE workbench_state;
        CREATE VIEW workbench_state AS SELECT id,json_set(document,'$.configs',json((SELECT json_group_array(json(document)) FROM (SELECT document FROM workbench_configs ORDER BY position)))) AS document FROM workbench_metadata;
        PRAGMA user_version=3;").map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 构造仍在 WAL 中的旧库，验证迁移备份确实包含最后一次已提交编辑。
    fn legacy(value: &Value) -> (PathBuf, Connection) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/entity-store-tests").join(unique());
        fs::create_dir_all(&root).unwrap();
        let c = db(&root.join("workbench.sqlite")).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE workbench_state(id INTEGER PRIMARY KEY,document TEXT NOT NULL);").unwrap();
        c.execute("INSERT INTO workbench_state VALUES(1,?1)", [value.to_string()]).unwrap();
        (root, c)
    }
    fn document() -> Value {
        json!({"revision":9,"unknown":{"id":"12345678901234567890","null":null},"configs":[{"id":"z","name":"最后提交","actualParts":[],"unknown":[1,null,"值"]},{"id":"a","deletedAt":"old","actualParts":null}]})
    }
    #[test]
    fn legacy_migration_preserves_order_unknowns_and_wal_backup_and_reopens() {
        let before = document();
        let (root, old) = legacy(&before);
        let store = super::super::initialize(&root.join("workbench.sqlite"), &root.join("absent.json"), &root.join("assets")).unwrap();
        let c = db(&store.path).unwrap();
        assert_eq!(state(&c).unwrap(), before);
        assert_eq!(c.pragma_query_value::<i64,_>(None,"user_version",|r|r.get(0)).unwrap(),3);
        assert!(c.execute("UPDATE workbench_state SET document='{}'",[]).is_err());
        let backups: Vec<_> = fs::read_dir(root.join("schema-backups")).unwrap().map(|p|p.unwrap().path()).filter(|p|p.extension().is_some_and(|v|v=="sqlite")).collect();
        assert_eq!(backups.len(),1);
        let backup = db(&backups[0]).unwrap();
        assert_eq!(state(&backup).unwrap(),before);
        assert_eq!(backup.pragma_query_value::<i64,_>(None,"user_version",|r|r.get(0)).unwrap(),0);
        // 老程序仍可写迁移前备份，当前库的兼容入口则明确只读。
        backup.execute("UPDATE workbench_state SET document=document",[]).unwrap();
        super::super::initialize(&store.path,&root.join("absent.json"),&store.assets).unwrap();
        assert_eq!(fs::read_dir(root.join("schema-backups")).unwrap().filter(|p|p.as_ref().unwrap().path().extension().is_some_and(|v|v=="sqlite")).count(),1);
        assert_eq!(state(&old).unwrap(),before);
    }
    #[test]
    fn invalid_entities_roll_back_schema_and_preserve_original() {
        let mut before=document(); before["configs"][1]["id"]=json!("z");
        let (root,c)=legacy(&before);
        assert!(super::super::initialize(&root.join("workbench.sqlite"),&root.join("absent"),&root.join("assets")).is_err());
        assert_eq!(state(&c).unwrap(),before);
        assert_eq!(c.pragma_query_value::<i64,_>(None,"user_version",|r|r.get(0)).unwrap(),0);
        assert_eq!(c.query_row::<i64,_,_>("SELECT count(*) FROM sqlite_master WHERE name='workbench_metadata'",[],|r|r.get(0)).unwrap(),0);
    }
    #[test]
    fn future_version_and_failed_backup_never_migrate() {
        for future in [false,true] {
            let (root,c)=legacy(&document());
            if future {c.pragma_update(None,"user_version",99).unwrap();}
            else {fs::write(root.join("schema-backups"),b"blocked-directory").unwrap();}
            assert!(super::super::initialize(&root.join("workbench.sqlite"),&root.join("absent"),&root.join("assets")).is_err());
            assert_eq!(state(&c).unwrap(),document());
            assert_eq!(c.query_row::<String,_,_>("SELECT type FROM sqlite_master WHERE name='workbench_state'",[],|r|r.get(0)).unwrap(),"table");
        }
    }
}

// 全量保存仍走原有历史与云同步事务；逐行保存保持原数组顺序和所有未知字段。
pub(super) fn replace(tx: &Transaction, value: &Value) -> Result<()> {
    validate(value)?;
    let mut metadata = value.as_object().ok_or("状态须为对象")?.clone();
    metadata.remove("configs");
    tx.execute("UPDATE workbench_metadata SET document=?1 WHERE id=1", [Value::Object(metadata).to_string()]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM workbench_configs", []).map_err(|e|e.to_string())?;
    {
        let mut insert=tx.prepare("INSERT INTO workbench_configs VALUES(?1,?2,?3)").map_err(|e|e.to_string())?;
        for (position,row) in value["configs"].as_array().unwrap().iter().enumerate() {
            insert.execute(params![row["id"].as_str().unwrap(),position as i64,row.to_string()]).map_err(|e|e.to_string())?;
        }
    }
    // 即使外部全量载入沿用相同 revision，也不能返回旧列表投影。
    tx.execute("DELETE FROM workbench_config_projection_meta", []).map_err(|e|e.to_string())?;
    Ok(())
}
