// 派生图片缓存：只管理已登记生成图；按内容摘要复用文件，原图和来源不明旧文件不参与清理。
//! Generated files only: originals and unregistered legacy files are never cleanup targets.
use super::*;

const KEEP_SECONDS: i64 = 3 * 24 * 60 * 60;
const TABLE: &str = "workbench_generated_images";

fn exists(c: &Connection) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [TABLE],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn schema(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS workbench_generated_images(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,config_id TEXT NOT NULL,layout TEXT NOT NULL,theme TEXT NOT NULL,
        used_at INTEGER NOT NULL,UNIQUE(path,config_id,layout,theme));
        CREATE INDEX IF NOT EXISTS workbench_generated_images_group ON workbench_generated_images(config_id,layout,theme,sequence);")
        .map_err(|e| e.to_string())
}

// 逐级拒绝链接和重解析点，清理及保存都不能借目录跳转访问缓存根之外。
fn ordinary_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if meta.file_type().is_symlink() || reparse {
                    return Err("生成图缓存路径包含链接或重解析点，已停止清理".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("无法检查生成图缓存路径：{e}")),
        }
    }
    Ok(())
}

// 仅把已登记生成图 URL 映射到受控 saved 目录，拒绝原图及任意文件名。
fn file_path(store: &WorkbenchStore, url: &str) -> Result<PathBuf> {
    let name = url
        .strip_prefix("/saved/generated-")
        .and_then(|v| v.strip_suffix(".png"))
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or("生成图缓存路径无效，已停止清理")?;
    let path = store
        .assets
        .join("saved")
        .join(format!("generated-{name}.png"));
    ordinary_path(&path)?;
    Ok(path)
}

fn digest_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

// 按 PNG 内容摘要复用文件，并登记配置、版式、主题的使用次序。
pub(super) fn save(
    tx: &Transaction<'_>,
    store: &WorkbenchStore,
    input: &Value,
    raw: &[u8],
    at: i64,
) -> Result<String> {
    schema(tx)?;
    let digest = format!("{:x}", Sha256::digest(raw));
    let url = format!("/saved/generated-{digest}.png");
    let path = file_path(store, &url)?;
    if path.exists() {
        if !path.is_file() || digest_file(&path)? != digest {
            return Err("生成图缓存内容校验失败，原文件已保留".into());
        }
    } else {
        fs::create_dir_all(path.parent().ok_or("生成图缓存路径无效")?)
            .map_err(|e| e.to_string())?;
        ordinary_path(&path)?;
        write_new(&path, raw)?;
    }
    // An association per configuration/style protects shared content even if another config changes.
    // Replacing its metadata allocates a new sequence, so reusing an older hash makes it latest again.
    tx.execute("DELETE FROM workbench_generated_images WHERE path=?1 AND config_id=?2 AND layout=?3 AND theme=?4",
        params![url, input["id"].as_str().ok_or("配置 ID 无效")?, input["layout"].as_str().ok_or("版式无效")?, input["theme"].as_str().ok_or("主题无效")?]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO workbench_generated_images(path,config_id,layout,theme,used_at) VALUES(?1,?2,?3,?4,?5)",
        params![url, input["id"].as_str().unwrap(), input["layout"].as_str().unwrap(), input["theme"].as_str().unwrap(), at]).map_err(|e| e.to_string())?;
    Ok(url)
}

#[derive(Debug)]
struct Candidate {
    url: String,
    path: PathBuf,
    bytes: u64,
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

// 扫描持久业务、历史及恢复内容中的引用；可重建投影不能充当永久保留依据。
fn referenced(c: &Connection, candidates: &HashSet<String>) -> Result<HashSet<String>> {
    // Rebuildable projections are not references: cleanup drops them before deleting files,
    // so counting them here would make preview and actual cleanup disagree.
    let tables: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>?1
        AND name NOT IN ('workbench_config_projection','workbench_config_projection_meta','workbench_cache_maintenance')")
        .map_err(|e| e.to_string())?.query_map([TABLE], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())?;
    let mut found = HashSet::new();
    for table in tables {
        let columns: Vec<String> = c
            .prepare(&format!("PRAGMA table_info({})", quoted(&table)))
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(1))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| e.to_string())?;
        for column in columns {
            // Scan one persisted text cell at a time; never clone/deserialize the full workspace.
            // Filename matching deliberately over-retains references embedded in JSON or escaped URLs.
            let sql = format!(
                "SELECT item.atom FROM {1} AS source, json_tree(CASE WHEN json_valid(source.{0}) THEN source.{0} ELSE json_quote(source.{0}) END) AS item WHERE typeof(source.{0})='text' AND item.type='text'",
                quoted(&column),
                quoted(&table)
            );
            let mut statement = c.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = statement.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let text = row
                    .get_ref(0)
                    .map_err(|e| e.to_string())?
                    .as_str()
                    .map_err(|e| e.to_string())?;
                for (start, _) in text.match_indices("generated-") {
                    if let Some(name) = text.get(start..start + 78) {
                        if candidates.contains(name) {
                            found.insert(name.to_owned());
                        }
                    }
                }
            }
        }
    }
    Ok(found)
}

// 只选超过三天且不是各配置版式主题最新图的记录，再排除所有持久引用。
fn candidates(tx: &Transaction<'_>, store: &WorkbenchStore, at: i64) -> Result<Vec<Candidate>> {
    if !exists(tx)? {
        return Ok(Vec::new());
    }
    let urls: Vec<String> = tx.prepare("SELECT path FROM workbench_generated_images GROUP BY path HAVING MAX(used_at)<=?1 AND path NOT IN (
        SELECT current.path FROM workbench_generated_images current WHERE current.sequence=(SELECT MAX(latest.sequence) FROM workbench_generated_images latest
        WHERE latest.config_id=current.config_id AND latest.layout=current.layout AND latest.theme=current.theme)) ORDER BY path")
        .map_err(|e| e.to_string())?.query_map([at.saturating_sub(KEEP_SECONDS)], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for url in urls {
        let path = file_path(store, &url)?;
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => files.push(Candidate {
                url,
                path,
                bytes: meta.len(),
            }),
            Ok(_) => return Err("生成图缓存目标不是普通文件，已停止清理".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("无法读取生成图缓存：{e}")),
        }
    }
    if files.is_empty() {
        return Ok(files);
    }
    let names = files
        .iter()
        .map(|v| v.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    let refs = referenced(tx, &names)?;
    files.retain(|v| !refs.contains(v.path.file_name().unwrap().to_str().unwrap()));
    for file in &files {
        verify_cached_content(file)?;
    }
    Ok(files)
}

// 清理前重新核验内容摘要；同名文件被替换时必须保留，不能误删其他内容。
fn verify_cached_content(file: &Candidate) -> Result<()> {
    let expected = file
        .url
        .strip_prefix("/saved/generated-")
        .and_then(|v| v.strip_suffix(".png"))
        .ok_or("生成图缓存路径无效")?;
    if digest_file(&file.path)? != expected {
        return Err("生成图缓存内容校验失败，文件可能已被替换；已保留原文件并停止清理".into());
    }
    Ok(())
}

fn category(count: usize, bytes: u64) -> Value {
    json!({"id":"generated-images","label":"过期生成图片缓存","count":count,"bytes":bytes,"storageEffect":"files-deleted","retentionSeconds":KEEP_SECONDS})
}

// 预览与实际清理共用候选筛选，返回文件数量和实际字节数。
pub(super) fn preview(tx: &Transaction<'_>, store: &WorkbenchStore, at: i64) -> Result<Value> {
    let files = candidates(tx, store, at)?;
    Ok(category(files.len(), files.iter().map(|v| v.bytes).sum()))
}

// 按用户要求直接删除符合全部条件的派生图；此策略不适用于原图或普通项目文件。
pub(super) fn clear(tx: &Transaction<'_>, store: &WorkbenchStore, at: i64) -> Result<Value> {
    clear_with(tx, store, at, |path| {
        fs::remove_file(path).map_err(|e| e.to_string())
    })
}

// 逐图复核后删除，成功后再删登记；中途失败报告已完成数量，不能宣称全部回滚。
fn clear_with(
    tx: &Transaction<'_>,
    store: &WorkbenchStore,
    at: i64,
    mut remove: impl FnMut(&Path) -> Result<()>,
) -> Result<Value> {
    let files = candidates(tx, store, at)?;
    let mut count = 0;
    let mut bytes = 0;
    for file in files {
        file_path(store, &file.url)?;
        verify_cached_content(&file)
            .map_err(|e| format!("生成图缓存清理未完成，已删除 {count} 张；{e}"))?;
        // 文件删除无法由数据库事务撤销；失败时必须报告真实已删数量并保留未删文件。
        remove(&file.path).map_err(|e| {
            format!("生成图缓存清理未完成，已删除 {count} 张；未删除的文件已保留，将稍后重试：{e}")
        })?;
        count += 1;
        bytes += file.bytes;
        tx.execute(
            "DELETE FROM workbench_generated_images WHERE path=?1",
            [&file.url],
        )
        .map_err(|e| format!("已删除 {count} 张生成图，缓存记录更新失败：{e}"))?;
    }
    Ok(category(count, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: i64 = 1_900_000_000;

    fn fixture() -> WorkbenchStore {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/image-cache-tests")
            .join(unique());
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        fs::write(
            &source,
            json!({"revision":1,"configs":[{"id":"a","parts":[]}],"logs":[]}).to_string(),
        )
        .unwrap();
        initialize(
            &root.join("workbench.sqlite"),
            &source,
            &root.join("assets"),
        )
        .unwrap()
    }
    fn input(id: &str, layout: &str, theme: &str) -> Value {
        json!({"id":id,"layout":layout,"theme":theme})
    }
    fn add(
        tx: &Transaction<'_>,
        s: &WorkbenchStore,
        bytes: &[u8],
        id: &str,
        layout: &str,
        theme: &str,
        at: i64,
    ) -> String {
        save(tx, s, &input(id, layout, theme), bytes, at).unwrap()
    }

    #[test]
    fn identical_content_reuses_one_file_and_new_sequence_without_touching_originals() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        let first = add(&tx, &s, b"one", "a", "long", "light", AT - KEEP_SECONDS - 1);
        let second = add(&tx, &s, b"two", "a", "long", "light", AT - KEEP_SECONDS - 1);
        let again = add(&tx, &s, b"one", "a", "long", "light", AT);
        assert_eq!(first, again);
        assert_eq!(fs::read_dir(s.assets.join("saved")).unwrap().count(), 2);
        assert_eq!(
            tx.query_row::<i64, _, _>("SELECT COUNT(*) FROM workbench_generated_images", [], |r| r
                .get(0))
                .unwrap(),
            2
        );
        fs::create_dir_all(s.assets.join("uploads")).unwrap();
        fs::write(s.assets.join("uploads/original.png"), b"keep").unwrap();
        fs::write(s.assets.join("saved/old-unregistered.png"), b"keep").unwrap();
        assert_eq!(preview(&tx, &s, AT).unwrap()["count"], 1);
        let result = clear(&tx, &s, AT).unwrap();
        assert_eq!(result["count"], 1);
        assert_eq!(result["bytes"], 3);
        assert!(file_path(&s, &first).unwrap().exists());
        assert!(!file_path(&s, &second).unwrap().exists());
        assert_eq!(
            fs::read(s.assets.join("uploads/original.png")).unwrap(),
            b"keep"
        );
        assert!(s.assets.join("saved/old-unregistered.png").exists());
    }

    #[test]
    fn latest_per_configuration_layout_theme_and_recent_shared_hash_are_retained() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        let old = AT - KEEP_SECONDS - 100;
        let shared = add(&tx, &s, b"shared", "a", "long", "light", old);
        add(&tx, &s, b"shared", "b", "square", "dark", old);
        add(&tx, &s, b"latest-a", "a", "long", "light", old);
        add(&tx, &s, b"square", "a", "square", "light", old);
        add(&tx, &s, b"dark", "a", "long", "dark", old);
        let recent = add(
            &tx,
            &s,
            b"recent",
            "c",
            "long",
            "light",
            AT - KEEP_SECONDS + 1,
        );
        add(&tx, &s, b"newer-c", "c", "long", "light", AT);
        assert_eq!(preview(&tx, &s, AT).unwrap()["count"], 0);
        add(&tx, &s, b"latest-b", "b", "square", "dark", old);
        assert_eq!(preview(&tx, &s, AT).unwrap()["count"], 1);
        clear(&tx, &s, AT).unwrap();
        assert!(!file_path(&s, &shared).unwrap().exists());
        assert!(file_path(&s, &recent).unwrap().exists());
    }

    #[test]
    fn persisted_history_recovery_cloud_receipts_and_escaped_json_protect_files() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        tx.execute_batch(
            "CREATE TABLE cloud_test(document TEXT); CREATE TABLE custom_json(payload TEXT);",
        )
        .unwrap();
        let targets = [
            "workbench_state",
            "workbench_history",
            "workbench_recovery",
            "workbench_receipts",
            "cloud_test",
            "custom_json",
        ];
        for (index, table) in targets.iter().enumerate() {
            let id = format!("c{index}");
            let url = add(
                &tx,
                &s,
                id.as_bytes(),
                &id,
                "long",
                "light",
                AT - KEEP_SECONDS - 1,
            );
            add(
                &tx,
                &s,
                format!("new-{id}").as_bytes(),
                &id,
                "long",
                "light",
                AT,
            );
            let document = json!({"image":url}).to_string();
            match *table {
                "workbench_state" => {
                    tx.execute(
                        "UPDATE workbench_state SET document=json_set(document,'$.image',?1)",
                        [&url],
                    )
                    .unwrap();
                }
                "workbench_history" => {
                    tx.execute(
                        "INSERT INTO workbench_history(at,revision,document) VALUES('old',1,?1)",
                        [&document],
                    )
                    .unwrap();
                }
                "workbench_recovery" => {
                    tx.execute(
                        "INSERT INTO workbench_recovery VALUES('draft','old',?1)",
                        [&document],
                    )
                    .unwrap();
                }
                "workbench_receipts" => {
                    tx.execute(
                        "INSERT INTO workbench_receipts VALUES('op','hash',?1)",
                        [&document],
                    )
                    .unwrap();
                }
                "custom_json" => {
                    tx.execute(
                        "INSERT INTO custom_json VALUES(?1)",
                        [document.replace("generated-", "\\u0067enerated-")],
                    )
                    .unwrap();
                }
                _ => {
                    tx.execute("INSERT INTO cloud_test VALUES(?1)", [&document])
                        .unwrap();
                }
            }
        }
        assert_eq!(preview(&tx, &s, AT).unwrap()["count"], 0);
        assert_eq!(clear(&tx, &s, AT).unwrap()["count"], 0);
        assert_eq!(fs::read_dir(s.assets.join("saved")).unwrap().count(), 12);
    }

    #[test]
    fn failed_delete_keeps_file_and_record_and_reports_partial_completion_truthfully() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        add(
            &tx,
            &s,
            b"first-old",
            "a",
            "long",
            "light",
            AT - KEEP_SECONDS - 1,
        );
        add(
            &tx,
            &s,
            b"second-old",
            "b",
            "long",
            "light",
            AT - KEEP_SECONDS - 1,
        );
        add(&tx, &s, b"a-new", "a", "long", "light", AT);
        add(&tx, &s, b"b-new", "b", "long", "light", AT);
        let files = candidates(&tx, &s, AT).unwrap();
        let mut calls = 0;
        let error = clear_with(&tx, &s, AT, |path| {
            calls += 1;
            if calls == 2 {
                Err("injected sharing violation".into())
            } else {
                fs::remove_file(path).map_err(|e| e.to_string())
            }
        })
        .unwrap_err();
        assert!(error.contains("已删除 1 张"));
        assert!(error.contains("injected sharing violation"));
        assert!(!files[0].path.exists());
        assert!(files[1].path.exists());
        assert_eq!(
            tx.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM workbench_generated_images WHERE path=?1",
                [&files[1].url],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        tx.rollback().unwrap();
    }

    #[test]
    fn invalid_paths_and_modified_content_are_refused() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        assert!(file_path(&s, "/saved/../../original.png").is_err());
        assert!(file_path(&s, "/uploads/generated-abc.png").is_err());
        let url = add(&tx, &s, b"expected", "a", "long", "light", AT);
        fs::write(file_path(&s, &url).unwrap(), b"modified").unwrap();
        assert!(
            save(&tx, &s, &input("a", "long", "light"), b"expected", AT)
                .unwrap_err()
                .contains("校验失败")
        );
        assert_eq!(fs::read(file_path(&s, &url).unwrap()).unwrap(), b"modified");
    }

    #[test]
    fn stale_projection_references_do_not_change_preview_or_clear_targets() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        // 用例需要故意陈旧的投影，先替换初始化建立的空投影表再写测试数据。
        tx.execute_batch("DROP TABLE workbench_config_projection; DROP TABLE workbench_config_projection_meta;").unwrap();
        let old = add(
            &tx,
            &s,
            b"old-projected",
            "a",
            "long",
            "light",
            AT - KEEP_SECONDS - 1,
        );
        add(&tx, &s, b"current", "a", "long", "light", AT);
        tx.execute_batch(
            "CREATE TABLE workbench_config_projection(id TEXT,document TEXT,summary TEXT);
            CREATE TABLE workbench_config_projection_meta(document TEXT);",
        )
        .unwrap();
        let stale = json!({"image":old}).to_string();
        tx.execute(
            "INSERT INTO workbench_config_projection VALUES('a',?1,?1)",
            [&stale],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO workbench_config_projection_meta VALUES(?1)",
            [&stale],
        )
        .unwrap();
        let before = preview(&tx, &s, AT).unwrap();
        assert_eq!(before["count"], 1);
        tx.execute_batch("DELETE FROM workbench_config_projection; DELETE FROM workbench_config_projection_meta;").unwrap();
        assert_eq!(preview(&tx, &s, AT).unwrap(), before);
        assert_eq!(clear(&tx, &s, AT).unwrap(), before);
        assert!(!file_path(&s, &old).unwrap().exists());
    }

    #[test]
    fn replaced_file_is_retained_in_preview_and_clear_even_after_candidates_were_scanned() {
        let s = fixture();
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        let old = add(
            &tx,
            &s,
            b"original-cache",
            "a",
            "long",
            "light",
            AT - KEEP_SECONDS - 1,
        );
        add(&tx, &s, b"current-cache", "a", "long", "light", AT);
        let path = file_path(&s, &old).unwrap();
        fs::write(&path, b"user replacement").unwrap();
        assert!(preview(&tx, &s, AT).unwrap_err().contains("校验失败"));
        assert!(clear(&tx, &s, AT).unwrap_err().contains("校验失败"));
        assert_eq!(fs::read(&path).unwrap(), b"user replacement");
        fs::write(&path, b"original-cache").unwrap();
        add(
            &tx,
            &s,
            b"other-old-cache",
            "b",
            "long",
            "light",
            AT - KEEP_SECONDS - 1,
        );
        add(&tx, &s, b"other-current", "b", "long", "light", AT);
        let files = candidates(&tx, &s, AT).unwrap();
        let second = files[1].path.clone();
        let mut deletes = 0;
        let error = clear_with(&tx, &s, AT, |path| {
            deletes += 1;
            fs::write(&second, b"changed after candidate scan").map_err(|e| e.to_string())?;
            fs::remove_file(path).map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert_eq!(deletes, 1);
        assert!(error.contains("已删除 1 张"));
        assert!(error.contains("校验失败"));
        assert_eq!(fs::read(second).unwrap(), b"changed after candidate scan");
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_directory_is_rejected_before_save_or_clear() {
        use std::os::windows::process::CommandExt;
        let s = fixture();
        let root = s.path.parent().unwrap();
        let target = root.join("external");
        fs::create_dir_all(&target).unwrap();
        let target = target.canonicalize().unwrap();
        let link = s.assets.canonicalize().unwrap().join("saved");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut c = db(&s.path).unwrap();
        let tx = c.transaction().unwrap();
        assert!(
            save(&tx, &s, &input("a", "long", "light"), b"data", AT)
                .unwrap_err()
                .contains("重解析点")
        );
        schema(&tx).unwrap();
        let path = format!("/saved/generated-{}.png", "a".repeat(64));
        tx.execute("INSERT INTO workbench_generated_images(path,config_id,layout,theme,used_at) VALUES(?1,'a','long','light',1)",[path]).unwrap();
        tx.execute("INSERT INTO workbench_generated_images(path,config_id,layout,theme,used_at) VALUES(?1,'a','long','light',2)",[format!("/saved/generated-{}.png","b".repeat(64))]).unwrap();
        assert!(clear(&tx, &s, AT).unwrap_err().contains("重解析点"));
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    }

    #[test]
    fn image_api_deduplicates_valid_revision_and_refuses_stale_output() {
        let s = fixture();
        let mut raw = b"\x89PNG\r\n\x1a\n".to_vec();
        raw.extend_from_slice(&[0; 16]);
        let input = json!({"id":"a","revision":1,"layout":"square","theme":"light","png":STANDARD.encode(raw)});
        let a: Value =
            serde_json::from_str(&save_image(&s, "/api/image", &input).unwrap().body).unwrap();
        let b: Value =
            serde_json::from_str(&save_image(&s, "/api/image", &input).unwrap().body).unwrap();
        assert_eq!(a, b);
        assert_eq!(fs::read_dir(s.assets.join("saved")).unwrap().count(), 1);
        let mut stale = input;
        stale["revision"] = json!(0);
        assert_eq!(save_image(&s, "/api/image", &stale).unwrap().status, 409);
    }
}
