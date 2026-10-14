// 更新恢复只在旧进程正常退出后取一致性快照；失败库原样保留，不覆盖或删除业务文件。
use super::plain_path;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const DATABASES: [&str; 3] = ["workbench.sqlite", "refactor.sqlite", "migration.sqlite"];

pub(super) struct Snapshot {
    data: PathBuf,
    directory: PathBuf,
    files: Vec<(String, String)>,
}

// 数据库可能大于程序文件，单独流式计算摘要，不沿用 EXE 的长度上限。
fn digest(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn check(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if result != "ok" {
        return Err("更新数据库快照完整性检查失败".into());
    }
    Ok(())
}
impl Snapshot {
    pub(super) fn capture(root: &Path, directory: &Path) -> Result<Self, String> {
        let data = root.join("data");
        let snapshot = directory.join("database-backup");
        fs::create_dir(&snapshot).map_err(|e| format!("创建更新数据备份失败：{e}"))?;
        let mut files = Vec::new();
        if data.exists() {
            plain_path(&data)?;
        }
        for name in DATABASES {
            let source = data.join(name);
            if !source.exists() {
                continue;
            }
            plain_path(&source)?;
            // SQLite backup 会合入 WAL 中已提交的数据，不能直接复制主文件。
            let connection = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            let destination = snapshot.join(name);
            connection
                .backup("main", &destination, None)
                .map_err(|e| format!("更新数据备份失败：{e}"))?;
            check(&destination)?;
            fs::OpenOptions::new()
                .write(true)
                .open(&destination)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
            files.push((name.to_string(), digest(&destination)?));
        }
        // 留下完整清单用于人工核验与恢复；失败快照绝不能当作完成备份。
        fs::write(
            snapshot.join("manifest.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"schema":1,"complete":true,"files":files}),
            )
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            data,
            directory: snapshot,
            files,
        })
    }

    // 仅在确认失败新进程已经结束后调用；还原失败必须阻止旧 EXE 重启。
    pub(super) fn restore(&self) -> Result<(), String> {
        plain_path(&self.directory)?;
        if self.data.exists() {
            plain_path(&self.data)?;
        }
        let staged = self.directory.join("restore-staged");
        let failed = self.directory.join("failed-data");
        fs::create_dir(&staged).map_err(|e| e.to_string())?;
        fs::create_dir(&failed).map_err(|e| e.to_string())?;
        // 所有快照先校验并复制到暂存区，磁盘不足时不触碰当前数据库。
        for (name, expected) in &self.files {
            let source = self.directory.join(name);
            plain_path(&source)?;
            if digest(&source)? != *expected {
                return Err("更新数据备份摘要不符，拒绝自动回滚".into());
            }
            check(&source)?;
            fs::copy(&source, staged.join(name)).map_err(|e| e.to_string())?;
        }
        for name in DATABASES {
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let file = self.data.join(format!("{name}{suffix}"));
                if file.exists() {
                    plain_path(&file)?;
                }
            }
        }
        fs::create_dir_all(&self.data).map_err(|e| e.to_string())?;
        for name in DATABASES {
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let file = self.data.join(format!("{name}{suffix}"));
                if file.exists() {
                    fs::rename(&file, failed.join(format!("{name}{suffix}")))
                        .map_err(|e| format!("保留失败版本数据库失败，禁止启动旧版本：{e}"))?;
                }
            }
            let restored = staged.join(name);
            if restored.exists() {
                fs::rename(restored, self.data.join(name))
                    .map_err(|e| format!("还原更新前数据库失败，禁止启动旧版本：{e}"))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rollback_restores_pre_migration_data_and_preserves_failed_database() {
        let root = super::super::tests::fixture();
        let data = root.join("data");
        fs::create_dir(&data).unwrap();
        let path = data.join("workbench.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE value(v); INSERT INTO value VALUES ('before'); PRAGMA user_version=0;").unwrap();
        let snapshot = Snapshot::capture(&root, &root).unwrap();
        db.execute_batch("UPDATE value SET v='after'; PRAGMA user_version=3;")
            .unwrap();
        drop(db);
        let extra = Connection::open(data.join("migration.sqlite")).unwrap();
        extra.execute_batch("CREATE TABLE new_schema(v);").unwrap();
        drop(extra);
        snapshot.restore().unwrap();
        let restored = Connection::open(&path).unwrap();
        assert_eq!(
            restored
                .query_row("SELECT v FROM value", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "before"
        );
        assert_eq!(
            restored
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            0
        );
        assert!(
            snapshot
                .directory
                .join("failed-data/workbench.sqlite")
                .is_file()
        );
        assert!(
            snapshot
                .directory
                .join("failed-data/migration.sqlite")
                .is_file()
        );
        assert!(!data.join("migration.sqlite").exists());
    }
    #[test]
    fn corrupt_backup_leaves_current_database_untouched() {
        let root = super::super::tests::fixture();
        fs::create_dir(root.join("data")).unwrap();
        let path = root.join("data/workbench.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE value(v); INSERT INTO value VALUES (7);")
            .unwrap();
        drop(db);
        let snapshot = Snapshot::capture(&root, &root).unwrap();
        let original = digest(&path).unwrap();
        fs::write(snapshot.directory.join("workbench.sqlite"), b"corrupt").unwrap();
        assert!(snapshot.restore().is_err());
        assert_eq!(digest(&path).unwrap(), original);
    }
}
