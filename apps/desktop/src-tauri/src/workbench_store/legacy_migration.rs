//! First-use legacy import. Source reads are pinned; only the empty destination is mutated.
use super::*;
use std::{collections::BTreeSet, io::Read};

const LIMIT: u64 = 512 * 1024 * 1024;

// 大型已关闭的 Windows 旧库由 SQLite 按页只读读取，避免把历史空闲页全载入内存。
// 独占写共享限制持续到连接关闭；immutable 禁止 SQLite 触碰旧库和 SHM。
struct LegacySnapshot {
    connection: Connection,
    _pins: Vec<fs::File>,
}
impl std::ops::Deref for LegacySnapshot {
    type Target = Connection;
    fn deref(&self) -> &Connection { &self.connection }
}
impl std::ops::DerefMut for LegacySnapshot {
    fn deref_mut(&mut self) -> &mut Connection { &mut self.connection }
}

#[cfg(windows)]
fn large_closed_snapshot(path: &Path) -> Result<LegacySnapshot> {
    use std::os::windows::fs::OpenOptionsExt;
    let pin = |p: &Path| -> Result<fs::File> {
        ordinary(p)?;
        fs::OpenOptions::new().read(true).share_mode(1).open(p)
            .map_err(|_| "旧版数据库仍被占用，请正常退出旧版程序后重试迁移".into())
    };
    let main = pin(path)?;
    if !main.metadata().map_err(|e| e.to_string())?.is_file() { return Err("旧版数据库不是普通文件".into()); }
    let mut pins = vec![main];
    for name in ["workspace.sqlite-wal", "workspace.sqlite-journal"] {
        let sidecar = path.with_file_name(name);
        if sidecar.try_exists().map_err(|_| "无法确认旧版数据库日志状态，请检查目录读取权限")? {
            let file = pin(&sidecar)?;
            if file.metadata().map_err(|e| e.to_string())?.len() != 0 {
                return Err("大型旧版数据库尚有未合并日志，请正常打开并退出旧版后重试迁移".into());
            }
            pins.push(file);
        }
    }
    let mut uri = tauri::Url::from_file_path(path).map_err(|_| "旧版数据库路径无法转换")?;
    uri.set_query(Some("mode=ro&immutable=1"));
    let connection = Connection::open_with_flags(uri.as_str(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "无法按只读方式打开旧版大型数据库")?;
    connection.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA mmap_size=0;").map_err(|e|e.to_string())?;
    Ok(LegacySnapshot { connection, _pins: pins })
}

pub struct PreparedLegacyMigration {
    pub token: String,
    state: Value,
    records: Vec<Value>,
    outbox: Vec<Value>,
    owner: Value,
    cursor: i64,
    source_bound: bool,
    backup: PathBuf,
    assets: Vec<Value>,
    replacements: HashMap<String, String>,
    source_kind: &'static str,
}

impl PreparedLegacyMigration {
    pub fn preview(&self) -> Value {
        json!({"prepared":true,"token":self.token,"state":self.state,"records":self.records,
            "outbox":self.outbox,"sourceBound":self.source_bound,"assetReplacements":self.replacements,"summary":self.summary()})
    }
    fn summary(&self) -> Value {
        json!({"configurations":self.state["configs"].as_array().map_or(0, Vec::len),
            "records":self.records.len(),"uncertain":self.outbox.len(),"cursor":self.cursor,
            "copiedImages":self.assets.iter().filter(|r| r["copied"] == true).count(),
            "missingImages":self.assets.iter().filter(|r| r["copied"] != true).count(),
            "sourceKind":self.source_kind,"sourceBound":self.source_bound})
    }
}

// Never follow junctions or symlinks into another source/destination tree.
fn ordinary(path: &Path) -> Result<()> {
    for item in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        match fs::symlink_metadata(item) {
            Ok(meta) => {
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let link = false;
                if meta.file_type().is_symlink() || link {
                    return Err("迁移路径不能包含链接或重解析点".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("无法检查迁移路径".into()),
        }
    }
    Ok(())
}

fn bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    ordinary(path)?;
    let f = fs::File::open(path).map_err(|_| "无法读取旧版数据文件")?;
    let before = f.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > limit {
        return Err("旧版数据文件不是普通文件或超过大小限制".into());
    }
    let mut result = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut result)
        .map_err(|e| e.to_string())?;
    let after = fs::metadata(path).map_err(|e| e.to_string())?;
    if result.len() as u64 > limit
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("旧版资料正在变化，请退出旧版程序后重试".into());
    }
    Ok(result)
}

fn parse(raw: &[u8]) -> Result<Value> {
    let raw = raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw);
    serde_json::from_slice(raw).map_err(|_| "旧版数据 JSON 格式无效".into())
}
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

// SQLite READ_ONLY still updates WAL reader marks in the source -shm file.
// Pin bytes using ordinary reads instead; replay only checksum-verified committed frames
// into memory and let SQLite validate the resulting database. No credential-bearing raw
// database or SHM is copied to disk. Format follows bundled sqlite3.c walDecodeFrame.
fn sqlite_snapshot(path: &Path) -> Result<LegacySnapshot> {
    #[cfg(windows)]
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > LIMIT {
        return large_closed_snapshot(path);
    }
    let wal_path = path.with_file_name("workspace.sqlite-wal");
    let journal = path.with_file_name("workspace.sqlite-journal");
    if journal.exists() && fs::metadata(&journal).map_err(|e| e.to_string())?.len() > 0 {
        return Err("旧版数据库仍有恢复日志，请正常打开并退出旧版后重试".into());
    }
    let mut database = bytes(path, LIMIT)?;
    let wal = if wal_path.exists() {
        Some(bytes(&wal_path, LIMIT)?)
    } else {
        None
    };
    if bytes(path, LIMIT)? != database
        || wal_path.exists() != wal.is_some()
        || wal
            .as_ref()
            .is_some_and(|old| bytes(&wal_path, LIMIT).as_ref() != Ok(old))
    {
        return Err("旧版数据库正在变化，请退出旧版程序后重试".into());
    }
    if database.len() < 100 || &database[..16] != b"SQLite format 3\0" {
        return Err("旧版数据库文件头无效".into());
    }
    let be = |raw: &[u8]| u32::from_be_bytes(raw[..4].try_into().unwrap());
    let small = u16::from_be_bytes(database[16..18].try_into().unwrap());
    let page_size = if small == 1 { 65536 } else { small as usize };
    if !(512..=65536).contains(&page_size)
        || !page_size.is_power_of_two()
        || database.len() % page_size != 0
    {
        return Err("旧版数据库页面大小无效".into());
    }
    if let Some(wal) = wal.filter(|v| !v.is_empty()) {
        if wal.len() < 32 {
            return Err("旧版数据库 WAL 不完整".into());
        }
        let magic = be(&wal);
        if ![0x377f0682, 0x377f0683].contains(&magic)
            || be(&wal[4..]) != 3007000
            || be(&wal[8..]) as usize != page_size
        {
            return Err("旧版数据库 WAL 格式无效".into());
        }
        let checksum = |raw: &[u8], mut sum: [u32; 2]| {
            for chunk in raw.chunks_exact(8) {
                let word = |part: &[u8]| {
                    if magic & 1 == 0 {
                        u32::from_le_bytes(part[..4].try_into().unwrap())
                    } else {
                        be(part)
                    }
                };
                sum[0] = sum[0].wrapping_add(word(chunk)).wrapping_add(sum[1]);
                sum[1] = sum[1].wrapping_add(word(&chunk[4..])).wrapping_add(sum[0]);
            }
            sum
        };
        let mut sum = checksum(&wal[..24], [0, 0]);
        if sum != [be(&wal[24..]), be(&wal[28..])] {
            return Err("旧版数据库 WAL 头校验失败".into());
        }
        let frame_size = 24 + page_size;
        let mut frames = Vec::new();
        let mut committed = 0;
        let mut database_pages = 0;
        for frame in wal[32..].chunks_exact(frame_size) {
            // WAL reuse may retain an older salt suffix; it is outside this generation.
            if frame[8..16] != wal[16..24] {
                break;
            }
            let page = be(frame) as usize;
            if page == 0 || page > LIMIT as usize / page_size {
                return Err("旧版数据库 WAL 页码无效".into());
            }
            sum = checksum(&frame[..8], sum);
            sum = checksum(&frame[24..], sum);
            if sum != [be(&frame[16..]), be(&frame[20..])] {
                return Err("旧版数据库 WAL 内容校验失败".into());
            }
            frames.push((page, &frame[24..]));
            let size = be(&frame[4..]) as usize;
            if size > 0 {
                if size > LIMIT as usize / page_size {
                    return Err("旧版数据库 WAL 数据量超限".into());
                }
                committed = frames.len();
                database_pages = size;
            }
        }
        if committed > 0 {
            database.resize(database_pages * page_size, 0);
            for (page, raw) in frames.into_iter().take(committed) {
                if page <= database_pages {
                    database[(page - 1) * page_size..page * page_size].copy_from_slice(raw);
                }
            }
        }
    }
    // The in-memory snapshot has no WAL sidecar; select rollback read/write format locally.
    database[18] = 1;
    database[19] = 1;
    let mut c = Connection::open_in_memory().map_err(|e| e.to_string())?;
    c.deserialize_read_exact(
        "main",
        std::io::Cursor::new(&database),
        database.len(),
        true,
    )
    .map_err(|_| "无法读取旧版数据库内存快照")?;
    Ok(LegacySnapshot { connection: c, _pins: Vec::new() })
}
fn meta(c: &Connection, key: &str) -> Result<Value> {
    let raw: Option<String> = c
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
        .optional()
        .map_err(|_| "旧版同步数据库结构不受支持")?;
    raw.map(|raw| parse(raw.as_bytes()))
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}
fn credentials(value: &Value) -> bool {
    match value {
        Value::Object(o) => o.iter().any(|(k, v)| {
            [
                "password",
                "accessToken",
                "access_token",
                "refreshToken",
                "refresh_token",
                "secretKey",
                "secret_key",
            ]
            .contains(&k.as_str())
                || credentials(v)
        }),
        Value::Array(a) => a.iter().any(credentials),
        _ => false,
    }
}
fn urls(value: &Value, found: &mut BTreeSet<String>) {
    match value {
        Value::String(s) if s.starts_with("/uploads/") || s.starts_with("/saved/") => {
            found.insert(s.clone());
        }
        Value::Object(o) => {
            for v in o.values() {
                urls(v, found);
            }
        }
        Value::Array(a) => {
            for v in a {
                urls(v, found);
            }
        }
        _ => (),
    }
}
fn canonical_url(url: &str) -> bool {
    url.strip_prefix("/uploads/")
        .and_then(|s| s.split_once('.'))
        .is_some_and(|(hash, ext)| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && matches!(ext, "png" | "jpg")
        })
}
fn replace_urls(value: &mut Value, replacements: &HashMap<String, String>) {
    match value {
        Value::String(s) => {
            if let Some(new) = replacements.get(s) {
                *s = new.clone();
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                replace_urls(v, replacements);
            }
        }
        Value::Array(a) => {
            for v in a {
                replace_urls(v, replacements);
            }
        }
        _ => (),
    }
}
fn upload_name(name: &str, raw: &[u8]) -> Result<()> {
    let (stem, ext) = name.rsplit_once('.').ok_or("旧原图名称无效")?;
    let detected = if raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if raw.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else {
        return Err("旧原图内容不是 PNG 或 JPG".into());
    };
    let hash = digest(raw);
    let valid = if stem.len() == 64 {
        stem == hash
    } else {
        let p: Vec<_> = stem.split('-').collect();
        p.len() == 3
            && p[..2]
                .iter()
                .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            && p[2].len() == 16
            && hash.starts_with(p[2])
    };
    if ext != detected || !valid {
        return Err("旧原图文件名与内容摘要不一致，迁移未提交".into());
    }
    Ok(())
}

fn destination_empty(store: &WorkbenchStore) -> Result<()> {
    if cloud_state::first_use_status(store)?["required"] != true {
        return Err("迁移仅适用于尚未绑定的全新空目录，现有数据已保留".into());
    }
    Ok(())
}

// Only whitelisted snapshot fields leave the old SQLite. Credentials/runtime files are never opened.
pub(super) fn prepare(
    store: &WorkbenchStore,
    source: &Path,
    member: &Value,
    check: impl Fn() -> Result<()>,
) -> Result<PreparedLegacyMigration> {
    check()?;
    destination_empty(store)?;
    ordinary(source)?;
    ordinary(&store.path)?;
    ordinary(&store.assets)?;
    let source = source
        .canonicalize()
        .map_err(|_| "请选择旧版程序中存在的 data 目录")?;
    let target = store
        .path
        .parent()
        .ok_or("目标数据目录无效")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let asset_target = store.assets.canonicalize().map_err(|e| e.to_string())?;
    if !source.is_dir()
        || [&target, &asset_target]
            .iter()
            .any(|d| source.starts_with(d) || d.starts_with(&source))
    {
        return Err("旧版目录与新版目录不能相同、包含或重叠".into());
    }
    for key in ["uid", "workspaceId"] {
        if member[key].as_str().is_none_or(str::is_empty) {
            return Err("请先登录有效成员账号".into());
        }
    }
    let file = source.join("state.json");
    let raw_state = if file.exists() {
        Some(bytes(&file, LIMIT)?)
    } else {
        None
    };
    let mut state = raw_state
        .as_deref()
        .map(parse)
        .transpose()?
        .unwrap_or(Value::Null);
    let mut records = Vec::new();
    let mut outbox = Vec::new();
    let mut cursor = 0;
    let mut bound = false;
    let mut source_kind = "state.json";
    let sqlite = source.join("workspace.sqlite");
    if sqlite.exists() {
        ordinary(&sqlite)?;
        let mut c = sqlite_snapshot(&sqlite)?;
        c.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let tx = c.transaction().map_err(|e| e.to_string())?;
        let integrity: String = tx
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| "旧版数据库检查失败")?;
        if integrity != "ok" {
            return Err("旧版数据库完整性检查未通过".into());
        }
        let enabled = meta(&tx, "enabled")? == true;
        let saved = meta(&tx, "workspaceState")?;
        let local_revision = meta(&tx, "localWorkspaceRevision")?
            .as_i64()
            .filter(|revision| *revision != 0)
            .unwrap_or(-1);
        if saved.is_object()
            && (enabled
                || state.is_null()
                || local_revision >= state["revision"].as_i64().unwrap_or(0))
        {
            state = saved;
            source_kind = "workspace.sqlite";
        }
        let workspace = meta(&tx, "workspaceId")?;
        let uid = meta(&tx, "uid")?;
        for (key, value) in [("workspaceId", &workspace), ("uid", &uid)] {
            if !value.is_null()
                && value.as_str().is_some_and(|s| !s.is_empty())
                && value != &member[key]
            {
                return Err("旧版资料属于其他成员或工作区，请登录原成员账号后迁移".into());
            }
        }
        bound = enabled && workspace == member["workspaceId"] && uid == member["uid"];
        if enabled && !bound {
            return Err("旧版同步身份不完整，不能安全继承同步进度".into());
        }
        if bound {
            cursor = meta(&tx, "cursor")?
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or("旧版同步进度无效")?;
        }
        let mut q = tx
            .prepare("SELECT type,id,base,version,draft,conflict FROM records ORDER BY type,id")
            .map_err(|_| "旧版记录结构不受支持")?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (kind, id, base, version, draft, conflict) = row.map_err(|e| e.to_string())?;
            let decode = |raw: Option<String>| {
                raw.map(|s| parse(s.as_bytes()))
                    .transpose()
                    .map(|v| v.unwrap_or(Value::Null))
            };
            records.push(json!({"type":kind,"id":id,"base":decode(base)?,"version":version,"draft":decode(draft)?,"conflict":decode(conflict)?}));
        }
        let mut q = tx
            .prepare("SELECT mutation_id,type,id,request FROM outbox ORDER BY rowid")
            .map_err(|_| "旧版待确认队列结构不受支持")?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (mutation, kind, id, raw) = row.map_err(|e| e.to_string())?;
            let request = parse(raw.as_bytes())?;
            if request["payload"]["mutationId"] != mutation
                || request["payload"]["entityType"] != kind
                || request["payload"]["entityId"] != id
            {
                return Err("旧版待确认请求身份不一致".into());
            }
            outbox.push(request);
        }
        let mut pending_urls = BTreeSet::new();
        urls(&json!(outbox), &mut pending_urls);
        if pending_urls
            .iter()
            .any(|s| s.starts_with("/uploads/") && !canonical_url(s))
        {
            return Err(
                "旧版尚有使用旧原图路径的待确认提交，请先在旧版核实同步结果或恢复处理后重试".into(),
            );
        }
        let mut conflict_urls = BTreeSet::new();
        for r in &records {
            urls(&r["conflict"], &mut conflict_urls);
        }
        if conflict_urls
            .iter()
            .any(|s| s.starts_with("/uploads/") && !canonical_url(s))
        {
            return Err("旧版未解决冲突包含旧原图路径，请先处理冲突后重试迁移".into());
        }
        if !bound
            && (!outbox.is_empty()
                || records
                    .iter()
                    .any(|r| r["version"] != 0 || !r["base"].is_null() || !r["conflict"].is_null()))
        {
            return Err("旧版存在同步记录但未绑定有效身份，不能自动迁移".into());
        }
    }
    if state.is_null() {
        return Err("所选目录没有可迁移的 state.json 或 SQLite 工作区资料".into());
    }
    validate(&state)?;
    for field in ["templates", "sourceCatalog", "costSource", "caseGallery"] {
        if state.get(field).is_none() {
            state[field] = json!([]);
        }
        if !state[field].is_array() {
            return Err(format!("旧版 {field} 数据格式无效"));
        }
    }
    if state.get("shopSettings").is_none() {
        state["shopSettings"] = json!({});
    }
    if !state["shopSettings"].is_object() {
        return Err("旧版店铺设置格式无效".into());
    }
    if state.get("logs").is_some_and(|v| !v.is_array()) {
        return Err("旧版活动记录格式无效".into());
    }
    if credentials(&state) || records.iter().any(credentials) || outbox.iter().any(credentials) {
        return Err("旧版业务快照包含登录凭据字段，已停止迁移；请先清理快照中的凭据".into());
    }
    if let Some(raw) = &raw_state {
        if bytes(&file, LIMIT)? != *raw {
            return Err("旧版资料正在变化，请退出旧版程序后重试".into());
        }
    }
    check()?;
    let token = unique();
    let backup = target.join("legacy-migration-backups").join(&token);
    ordinary(&backup)?;
    let snapshot = json!({"format":1,"state":state,"records":records,"outbox":outbox,"uid":member["uid"],"workspaceId":member["workspaceId"],"cursor":cursor,"sourceBound":bound,"sourceKind":source_kind});
    write_new(
        &backup.join("source-snapshot.json"),
        snapshot.to_string().as_bytes(),
    )?;
    let mut refs = BTreeSet::new();
    urls(&snapshot, &mut refs);
    let mut assets = Vec::new();
    let mut replacements = HashMap::new();
    for url in refs {
        check()?;
        let (prefix, name) = url[1..].split_once('/').ok_or("旧版图片引用无效")?;
        if name.is_empty()
            || name.contains(['/', '\\', ':', '%', '?', '#'])
            || name == "."
            || name == ".."
        {
            return Err("旧版图片引用含不安全路径，迁移未提交".into());
        }
        let old = source
            .join(if prefix == "uploads" {
                "assets"
            } else {
                "images"
            })
            .join(name);
        let legacy = prefix == "uploads" && !canonical_url(&url);
        if !old.exists() {
            if legacy {
                return Err("旧命名原图缺失，无法安全转换路径，请先在旧版恢复原图".into());
            }
            assets.push(json!({"url":url,"copied":false}));
            continue;
        }
        let raw = bytes(
            &old,
            if prefix == "uploads" {
                MAX_UPLOAD_BYTES as u64
            } else {
                MAX_GENERATED_IMAGE_BYTES as u64
            },
        )?;
        if prefix == "uploads" {
            upload_name(name, &raw)?;
        }
        if legacy {
            replacements.insert(
                url.clone(),
                format!(
                    "/uploads/{}.{}",
                    digest(&raw),
                    name.rsplit('.').next().unwrap()
                ),
            );
        }
        let saved = backup.join("assets").join(prefix).join(name);
        ordinary(&saved)?;
        write_new(&saved, &raw)?;
        if digest(&bytes(&saved, MAX_GENERATED_IMAGE_BYTES as u64)?) != digest(&raw) {
            return Err("原图副本校验失败".into());
        }
        assets.push(json!({"url":url,"copied":true,"sha256":digest(&raw),"bytes":raw.len()}));
    }
    write_new(
        &backup.join("asset-manifest.json"),
        json!({"files":assets}).to_string().as_bytes(),
    )?;
    check()?;
    Ok(PreparedLegacyMigration {
        token,
        state,
        records,
        outbox,
        owner: member.clone(),
        cursor,
        source_bound: bound,
        backup,
        assets,
        replacements,
        source_kind,
    })
}

fn record_key(r: &Value) -> Result<(String, String)> {
    let field = |key| {
        r[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "迁移记录身份无效".to_string())
    };
    Ok((field("type")?, field("id")?))
}

pub(super) fn apply(
    store: &WorkbenchStore,
    p: &PreparedLegacyMigration,
    input: &Value,
    member: &Value,
    check: impl Fn() -> Result<()>,
) -> Result<Value> {
    check()?;
    if input["token"] != p.token
        || member["uid"] != p.owner["uid"]
        || member["workspaceId"] != p.owner["workspaceId"]
    {
        return Err("迁移准备已过期，请重新选择旧版目录".into());
    }
    if input.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !["token", "records", "materializedProjection"].contains(&k.as_str()))
    }) {
        return Err("迁移提交包含不允许的字段".into());
    }
    let rows = input["records"].as_array().ok_or("迁移记录须为数组")?;
    let index: HashMap<_, _> = rows
        .iter()
        .map(|r| Ok((record_key(r)?, r)))
        .collect::<Result<_>>()?;
    if index.len() != rows.len() {
        return Err("迁移记录身份重复".into());
    }
    let original: HashMap<_, _> = p
        .records
        .iter()
        .map(|r| Ok((record_key(r)?, r)))
        .collect::<Result<_>>()?;
    for (key, old) in &original {
        let next = index.get(key).ok_or("迁移不能丢弃旧版同步记录")?;
        for field in ["base", "version", "conflict"] {
            if next[field] != old[field] {
                return Err("迁移不能改写云端基线、版本或冲突".into());
            }
        }
    }
    for (key, row) in &index {
        if !original.contains_key(key)
            && (!row["base"].is_null() || row["version"] != 0 || !row["conflict"].is_null())
        {
            return Err("新增迁移记录必须是未上传的本机草稿".into());
        }
    }
    let mut document = json!({"format":1,"uid":member["uid"],"workspaceId":member["workspaceId"],"deviceId":unique(),"cursor":p.cursor,"localRevision":0,"records":rows,"outbox":p.outbox,"materializedProjection":input["materializedProjection"],"origin":"legacy-directory"});
    cloud_state::validate_document(&document, &Value::Null)?;
    if credentials(&document) {
        return Err("迁移记录不能包含登录凭据".into());
    }
    destination_empty(store)?;
    // Publish only verified image copies. Interrupted copies remain reusable; no source mutation.
    for asset in p.assets.iter().filter(|r| r["copied"] == true) {
        check()?;
        let url = asset["url"].as_str().ok_or("图片清单无效")?;
        let relative = &url[1..];
        let raw = bytes(
            &p.backup.join("assets").join(relative),
            MAX_GENERATED_IMAGE_BYTES as u64,
        )?;
        if digest(&raw) != asset["sha256"] {
            return Err("迁移图片副本已变化，请重新选择目录".into());
        }
        let path = store.assets.join(relative);
        ordinary(&path)?;
        if path.exists() {
            if bytes(&path, MAX_GENERATED_IMAGE_BYTES as u64)? != raw {
                return Err("新版目录含同名不同内容原图，已保留原文件".into());
            }
        } else {
            // A crash must never leave a truncated final image that prevents retry.
            let stage = path
                .parent()
                .ok_or("图片目录无效")?
                .join(format!(".legacy-{}.partial", unique()));
            ordinary(&stage)?;
            write_new(&stage, &raw)?;
            if let Err(e) = upload_assets::install(&stage, &path) {
                if !path.exists() || bytes(&path, MAX_GENERATED_IMAGE_BYTES as u64)? != raw {
                    return Err(format!("迁移图片写入失败：{e}"));
                }
            }
        }
        if relative.starts_with("uploads/") {
            upload_assets::save(store, &raw)?;
        }
    }
    let mut c = db(&store.path)?;
    cloud_state::schema(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    cloud_state::check_factory_empty(&tx)?;
    check()?;
    let before = state(&tx)?;
    let backup = p.backup.join(format!("before-apply-{}.json", unique()));
    write_new(
        &backup,
        json!({"format":1,"state":before,"cloud":null,"token":p.token})
            .to_string()
            .as_bytes(),
    )?;
    let mut after = p.state.clone();
    replace_urls(&mut after, &p.replacements);
    let archive = after
        .as_object_mut()
        .ok_or("旧工作区格式无效")?
        .remove("logs")
        .unwrap_or(json!([]));
    persist(
        &tx,
        &before,
        &mut after,
        &json!({"operator":member["name"],"message":"从旧版 data 目录迁移本机资料"}),
    )?;
    tx.execute(
        "UPDATE workbench_log_archive SET document=?1 WHERE id=1",
        [archive.to_string()],
    )
    .map_err(|e| e.to_string())?;
    document["localRevision"] = after["revision"].clone();
    tx.execute(
        "INSERT INTO workbench_cloud_state VALUES(1,1,?1)",
        [document.to_string()],
    )
    .map_err(|e| e.to_string())?;
    check()?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"ok":true,"initialized":true,"imported":true,"connected":true,"summary":p.summary(),"backup":p.backup,"uploaded":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[cfg(windows)]
    #[test]
    fn first_use_migration_large_closed_database_is_paged_and_write_pinned() {
        let (store, source) = fixture();
        let renamed=source.with_file_name("旧 data #%");
        fs::rename(&source,&renamed).unwrap();
        let source=renamed;
        drop(sqlite_source(&source, false));
        let path=source.join("workspace.sqlite");
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(LIMIT+4096).unwrap();
        let before=fs::metadata(&path).unwrap();
        {
            let snapshot=sqlite_snapshot(&path).unwrap();
            assert_eq!(meta(&snapshot,"cursor").unwrap(),325);
            assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
            assert!(snapshot.execute("DELETE FROM meta",[]).is_err());
        }
        let p=prepare(&store,&source,&owner(),||Ok(())).unwrap();
        assert_eq!(p.state["revision"],8);
        assert_eq!(p.source_kind,"workspace.sqlite");
        assert_eq!(p.cursor,325);
        assert!(!p.records.is_empty());
        assert_eq!(before.len(),fs::metadata(&path).unwrap().len());
        assert_eq!(before.modified().unwrap(),fs::metadata(&path).unwrap().modified().unwrap());
        assert!(!source.join("workspace.sqlite-wal").exists());
        assert!(!source.join("workspace.sqlite-shm").exists());
        fs::write(source.join("workspace.sqlite-wal"),b"pending").unwrap();
        assert!(sqlite_snapshot(&path).err().unwrap().contains("未合并日志"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit read-only legacy source probe; requires DIYTOOLS_LEGACY_SOURCE"]
    fn first_use_migration_large_real_source_readonly_probe() {
        let source=PathBuf::from(std::env::var("DIYTOOLS_LEGACY_SOURCE").expect("explicit source required"));
        let path=source.join("workspace.sqlite");
        let before=fs::metadata(&path).unwrap();
        let c=sqlite_snapshot(&path).unwrap();
        assert_eq!(c.query_row::<String,_,_>("PRAGMA quick_check",[],|r|r.get(0)).unwrap(),"ok");
        let saved=meta(&c,"workspaceState").unwrap();
        assert!(saved["configs"].is_array());
        let count:i64=c.query_row("SELECT COUNT(*) FROM records",[],|r|r.get(0)).unwrap();
        let pending:i64=c.query_row("SELECT COUNT(*) FROM outbox",[],|r|r.get(0)).unwrap();
        let member=json!({"uid":meta(&c,"uid").unwrap(),"workspaceId":meta(&c,"workspaceId").unwrap()});
        println!("readonly large source: bytes={} configs={} records={} outbox={} revision={}",before.len(),saved["configs"].as_array().unwrap().len(),count,pending,saved["revision"]);
        drop(c);
        assert_eq!(before.len(),fs::metadata(&path).unwrap().len());
        assert_eq!(before.modified().unwrap(),fs::metadata(&path).unwrap().modified().unwrap());
        let (store, _)=fixture();
        let prepared=prepare(&store,&source,&member,||Ok(())).unwrap();
        assert_eq!(prepared.state["configs"].as_array().unwrap().len(),saved["configs"].as_array().unwrap().len());
        println!("actual prepare: {}",prepared.summary());
    }

    fn factory() -> Value {
        json!({"revision":0,"configs":[],"templates":[],"sourceCatalog":[],"costSource":[],"caseGallery":[],"shopSettings":{}})
    }
    fn owner() -> Value {
        json!({"uid":"migration-user","workspaceId":"migration-team","name":"验收成员"})
    }
    fn fixture() -> (WorkbenchStore, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/first-use-migration-20261014/native-tests")
            .join(unique());
        fs::create_dir_all(&root).unwrap();
        let seed = root.join("seed.json");
        fs::write(&seed, factory().to_string()).unwrap();
        let dest = root.join("new-data");
        let store = initialize(
            &dest.join("workbench.sqlite"),
            &seed,
            &dest.join("workbench-assets"),
        )
        .unwrap();
        let source = root.join("old-data");
        fs::create_dir_all(&source).unwrap();
        let mut state = factory();
        state["revision"] = json!(7);
        state["configs"] =
            json!([{"id":"c1","shopId":"intel","name":"旧版已保存","price":123.45,"parts":[]}]);
        state["logs"] = json!([{"id":"old-log","message":"旧活动记录"}]);
        fs::write(source.join("state.json"), state.to_string()).unwrap();
        (store, source)
    }
    fn projected(state: &Value) -> Vec<Value> {
        state["configs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut d = c.clone();
                d.as_object_mut().unwrap().remove("price");
                d["priceCents"] =
                    json!((c["price"].as_f64().unwrap_or(0.0) * 100.0).round() as i64);
                d["workspaceOrder"] = json!(i);
                json!({"type":"configuration","id":c["id"],"data":d})
            })
            .collect()
    }
    fn payload(p: &PreparedLegacyMigration) -> Value {
        let mut migrated = p.state.clone();
        replace_urls(&mut migrated, &p.replacements);
        let projection = projected(&migrated);
        let mut records = if p.records.is_empty() {
            projection.iter().map(|r|json!({"type":r["type"],"id":r["id"],"base":null,"version":0,"draft":r["data"],"conflict":null})).collect::<Vec<_>>()
        } else {
            p.records.clone()
        };
        for r in &mut records {
            replace_urls(&mut r["draft"], &p.replacements);
        }
        json!({"token":p.token,"materializedProjection":projection,"records":records})
    }
    fn sqlite_source(source: &Path, wal: bool) -> Connection {
        let c = Connection::open(source.join("workspace.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE records(type TEXT,id TEXT,base TEXT,version INTEGER,draft TEXT,conflict TEXT);CREATE TABLE outbox(mutation_id TEXT,type TEXT,id TEXT,request TEXT);").unwrap();
        if wal {
            c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                .unwrap();
        }
        let mut saved = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        saved["revision"] = json!(8);
        saved["configs"][0]["name"] = json!("SQLite 已保存未上传");
        for (key, value) in [
            ("enabled", json!(true)),
            ("workspaceState", saved.clone()),
            ("localWorkspaceRevision", json!(8)),
            ("uid", owner()["uid"].clone()),
            ("workspaceId", owner()["workspaceId"].clone()),
            ("cursor", json!(325)),
            ("accessToken", json!("DO-NOT-COPY-CREDENTIAL")),
        ] {
            c.execute(
                "INSERT INTO meta VALUES(?1,?2)",
                params![key, value.to_string()],
            )
            .unwrap();
        }
        let draft = projected(&saved)[0]["data"].clone();
        let mut base = draft.clone();
        base["name"] = json!("云端旧名称");
        c.execute(
            "INSERT INTO records VALUES('configuration','c1',?1,9,?2,'null')",
            params![base.to_string(), draft.to_string()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO records VALUES('workspace_meta','root',?1,1,?1,'null')",
            [json!({"format":2}).to_string()],
        )
        .unwrap();
        let request = json!({"protocolVersion":2,"action":"sync.push","requestId":"request-before-migration","payload":{"mutationId":"mutation-before-migration","deviceId":"old-device","entityType":"configuration","entityId":"c1","baseVersion":9,"after":draft}});
        c.execute(
            "INSERT INTO outbox VALUES('mutation-before-migration','configuration','c1',?1)",
            [request.to_string()],
        )
        .unwrap();
        c
    }
    fn fingerprints(root: &Path) -> HashMap<String, String> {
        let mut out = HashMap::new();
        fn walk(root: &Path, path: &Path, out: &mut HashMap<String, String>) {
            for e in fs::read_dir(path).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    out.insert(
                        p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                        digest(&fs::read(&p).unwrap()),
                    );
                }
            }
        }
        walk(root, root, &mut out);
        out
    }

    #[test]
    fn first_use_migration_json_preserves_source_logs_and_unknown_business_fields() {
        let (store, source) = fixture();
        let mut state = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        state["customBusiness"] = json!({"longId":"999999999999999999","note":"保留"});
        fs::write(source.join("state.json"), state.to_string()).unwrap();
        fs::write(source.join("credentials.json"), "DO-NOT-COPY-CREDENTIAL").unwrap();
        let before = fingerprints(&source);
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        assert!(!p.source_bound);
        let receipt = apply(&store, &p, &payload(&p), &owner(), || Ok(())).unwrap();
        assert_eq!(receipt["initialized"], true);
        let c = db(&store.path).unwrap();
        assert_eq!(
            super::state(&c).unwrap()["customBusiness"],
            json!({"longId":"999999999999999999","note":"保留"})
        );
        assert!(
            logs(&c)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == "old-log")
        );
        assert_eq!(fingerprints(&source), before);
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            false
        );
        assert!(!p.backup.join("credentials.json").exists());
        assert!(
            !fs::read_to_string(p.backup.join("source-snapshot.json"))
                .unwrap()
                .contains("DO-NOT-COPY-CREDENTIAL")
        );
        assert!(apply(&store, &p, &payload(&p), &owner(), || Ok(())).is_err());
    }

    #[test]
    fn first_use_migration_sqlite_wal_snapshot_pending_requests_and_source_bytes_preserved() {
        let (store, source) = fixture();
        let live = sqlite_source(&source, true);
        let before = fingerprints(&source);
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        assert_eq!(p.state["configs"][0]["name"], "SQLite 已保存未上传");
        assert_eq!(p.cursor, 325);
        assert!(p.source_bound);
        apply(&store, &p, &payload(&p), &owner(), || Ok(())).unwrap();
        let saved: Value = serde_json::from_str(&cloud_state::load(&store).unwrap().body).unwrap();
        assert_eq!(saved["document"]["outbox"], json!(p.outbox));
        assert_eq!(saved["document"]["records"], json!(p.records));
        assert_eq!(saved["document"]["cursor"], 325);
        assert_eq!(
            saved["document"]["outbox"][0]["payload"]["deviceId"],
            "old-device"
        );
        assert_eq!(
            fingerprints(&source),
            before,
            "read-only source including WAL and SHM must be byte-identical"
        );
        assert!(
            !fs::read_to_string(p.backup.join("source-snapshot.json"))
                .unwrap()
                .contains("DO-NOT-COPY-CREDENTIAL")
        );
        drop(live);
    }

    #[test]
    fn first_use_migration_wrong_owner_and_nonempty_target_refused() {
        let (store, source) = fixture();
        drop(sqlite_source(&source, false));
        assert!(
            prepare(
                &store,
                &source,
                &json!({"uid":"other","workspaceId":"migration-team"}),
                || Ok(())
            )
            .err()
            .unwrap()
            .contains("其他成员")
        );
        let c = db(&store.path).unwrap();
        let mut changed = factory();
        changed["configs"] = json!([{"id":"existing","parts":[]}]);
        entities::replace_fixture(&c, &changed);
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            false
        );
        assert!(prepare(&store, &source, &owner(), || Ok(())).is_err());
        assert_eq!(state(&c).unwrap(), changed);
    }

    #[test]
    fn first_use_migration_session_change_rolls_back_and_can_retry() {
        let (store, source) = fixture();
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        let calls = Cell::new(0);
        let result = apply(&store, &p, &payload(&p), &owner(), || {
            calls.set(calls.get() + 1);
            if calls.get() >= 3 {
                Err("session-changed".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
        assert_eq!(state(&db(&store.path).unwrap()).unwrap(), factory());
        assert_eq!(
            apply(&store, &p, &payload(&p), &owner(), || Ok(())).unwrap()["initialized"],
            true
        );
    }

    #[test]
    fn first_use_migration_queue_insert_failure_rolls_back_state_archive_and_history() {
        let (store, source) = fixture();
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        let c = db(&store.path).unwrap();
        c.execute_batch("CREATE TRIGGER reject_migration BEFORE INSERT ON workbench_cloud_state BEGIN SELECT RAISE(ABORT,'fixture-error'); END;").unwrap();
        assert!(apply(&store, &p, &payload(&p), &owner(), || Ok(())).is_err());
        assert_eq!(state(&c).unwrap(), factory());
        assert_eq!(logs(&c).unwrap(), json!([]));
        assert_eq!(
            c.query_row("SELECT count(*) FROM workbench_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.execute_batch("DROP TRIGGER reject_migration").unwrap();
        assert!(apply(&store, &p, &payload(&p), &owner(), || Ok(())).is_ok());
    }

    #[test]
    fn first_use_migration_overlap_and_invalid_directories_rejected() {
        let (store, source) = fixture();
        for path in [
            store.path.parent().unwrap(),
            store.assets.as_path(),
            source.parent().unwrap(),
        ] {
            assert!(
                prepare(&store, path, &owner(), || Ok(()))
                    .err()
                    .unwrap()
                    .contains("重叠")
            );
        }
        assert!(prepare(&store, &source.join("missing"), &owner(), || Ok(())).is_err());
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
    }

    #[test]
    fn first_use_migration_invalid_token_immutable_tampering_and_injected_paths_refused() {
        let (store, source) = fixture();
        drop(sqlite_source(&source, false));
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        for field in ["base", "version", "conflict"] {
            let mut input = payload(&p);
            input["records"][0][field] = json!("tampered");
            assert!(apply(&store, &p, &input, &owner(), || Ok(())).is_err());
        }
        let mut input = payload(&p);
        input["token"] = json!("wrong");
        assert!(apply(&store, &p, &input, &owner(), || Ok(())).is_err());
        let mut input = payload(&p);
        input["path"] = json!(source);
        assert!(apply(&store, &p, &input, &owner(), || Ok(())).is_err());
        let mut input = payload(&p);
        input["outbox"] = json!([]);
        assert!(apply(&store, &p, &input, &owner(), || Ok(())).is_err());
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
    }

    #[test]
    fn first_use_migration_images_pin_alias_hash_and_immutable_requests() {
        let (store, source) = fixture();
        let raw = b"\x89PNG\r\n\x1a\nlegacy-fixture";
        let hash = digest(raw);
        let name = format!("123-456-{}.png", &hash[..16]);
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets").join(&name), raw).unwrap();
        let mut value = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        value["configs"][0]["caseImage"] = json!(format!("/uploads/{name}"));
        fs::write(source.join("state.json"), value.to_string()).unwrap();
        let before = fingerprints(&source);
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        apply(&store, &p, &payload(&p), &owner(), || Ok(())).unwrap();
        assert_eq!(
            fs::read(store.assets.join("uploads").join(&name)).unwrap(),
            raw
        );
        assert_eq!(
            fs::read(store.assets.join("uploads").join(format!("{hash}.png"))).unwrap(),
            raw
        );
        let old_doc: Value =
            serde_json::from_str(&cloud_state::load(&store).unwrap().body).unwrap();
        upload_assets::normalize(&store).unwrap();
        let next: Value = serde_json::from_str(&cloud_state::load(&store).unwrap().body).unwrap();
        assert_eq!(next["document"], old_doc["document"]);
        assert_eq!(
            next["state"]["configs"][0]["caseImage"],
            format!("/uploads/{hash}.png")
        );
        assert_eq!(before, fingerprints(&source));
    }

    #[test]
    fn first_use_migration_missing_legacy_image_and_corrupt_sqlite_leave_destination_empty() {
        let (store, source) = fixture();
        let mut v = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        v["configs"][0]["caseImage"] = json!("/uploads/12-34-0123456789abcdef.png");
        fs::write(source.join("state.json"), v.to_string()).unwrap();
        assert!(
            prepare(&store, &source, &owner(), || Ok(()))
                .err()
                .unwrap()
                .contains("原图缺失")
        );
        fs::write(source.join("workspace.sqlite"), "corrupt").unwrap();
        assert!(prepare(&store, &source, &owner(), || Ok(())).is_err());
        assert_eq!(state(&db(&store.path).unwrap()).unwrap(), factory());
    }

    #[test]
    fn first_use_migration_malformed_outbox_and_business_credentials_refused() {
        let (store, source) = fixture();
        let c = sqlite_source(&source, false);
        c.execute("UPDATE outbox SET mutation_id='wrong'", [])
            .unwrap();
        drop(c);
        assert!(
            prepare(&store, &source, &owner(), || Ok(()))
                .err()
                .unwrap()
                .contains("请求身份")
        );
        let (store, source) = fixture();
        let mut v = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        v["accessToken"] = json!("secret");
        fs::write(source.join("state.json"), v.to_string()).unwrap();
        assert!(
            prepare(&store, &source, &owner(), || Ok(()))
                .err()
                .unwrap()
                .contains("凭据")
        );
    }

    #[test]
    fn first_use_migration_3500_configurations_reopen_counts_and_source_hashes() {
        let (store, source) = fixture();
        let mut v = factory();
        v["revision"] = json!(3500);
        v["configs"]=json!((0..3500).map(|n|json!({"id":format!("config-{n}"),"name":format!("配置 {n}"),"parts":[],"price":100+n,"unknown":{"id":"999999999999999999"}})).collect::<Vec<_>>());
        fs::write(source.join("state.json"), v.to_string()).unwrap();
        let before = fingerprints(&source);
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        let report = apply(&store, &p, &payload(&p), &owner(), || Ok(())).unwrap();
        assert_eq!(report["summary"]["configurations"], 3500);
        let c = db(&store.path).unwrap();
        let restored = state(&c).unwrap();
        assert_eq!(restored["configs"], v["configs"]);
        assert_eq!(
            c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(before, fingerprints(&source));
    }

    #[test]
    fn first_use_migration_seeded_install_skips_choice_and_refuses_directory_import() {
        let (store, source) = fixture();
        fs::write(
            store.path.parent().unwrap().join("cloud-bootstrap.json"),
            "{}",
        )
        .unwrap();
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            false
        );
        assert!(prepare(&store, &source, &owner(), || Ok(())).is_err());
    }

    fn wal_fixture() -> (PathBuf, Connection) {
        let (_, source) = fixture();
        let c = sqlite_source(&source, true);
        (source, c)
    }
    fn copy_database(source: &Path) -> PathBuf {
        let copy = source
            .parent()
            .unwrap()
            .join(format!("snapshot-copy-{}", unique()));
        fs::create_dir_all(&copy).unwrap();
        for name in ["workspace.sqlite", "workspace.sqlite-wal"] {
            fs::write(copy.join(name), fs::read(source.join(name)).unwrap()).unwrap();
        }
        copy
    }
    fn assert_oracle(source: &Path, c: &Connection) {
        let mut oracle = Connection::open_in_memory().unwrap();
        rusqlite::backup::Backup::new(c, &mut oracle)
            .unwrap()
            .run_to_completion(128, Duration::from_millis(1), None)
            .unwrap();
        let snapshot = sqlite_snapshot(&source.join("workspace.sqlite")).unwrap();
        for table in ["meta", "records", "outbox"] {
            let query = format!("SELECT * FROM {table} ORDER BY 1,2");
            let read = |conn: &Connection| {
                let mut q = conn.prepare(&query).unwrap();
                let columns = q.column_count();
                q.query_map([], |r| {
                    Ok((0..columns)
                        .map(|n| r.get::<_, rusqlite::types::Value>(n).unwrap())
                        .collect::<Vec<_>>())
                })
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap()
            };
            assert_eq!(read(&snapshot), read(&oracle));
        }
        assert_eq!(
            snapshot
                .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }

    #[test]
    fn first_use_migration_wal_replay_matches_sqlite_backup_growth_delete_and_checkpoint_reuse() {
        let (source, c) = wal_fixture();
        assert_oracle(&source, &c);
        for round in 0..3 {
            c.execute_batch("BEGIN IMMEDIATE;").unwrap();
            for n in 0..180 {
                c.execute(
                    "INSERT OR REPLACE INTO meta VALUES(?1,?2)",
                    params![
                        format!("bulk-{n}"),
                        json!("x".repeat(2000 + round)).to_string()
                    ],
                )
                .unwrap();
            }
            c.execute_batch("COMMIT;").unwrap();
            assert_oracle(&source, &c);
            c.execute("DELETE FROM meta WHERE key LIKE 'bulk-%'", [])
                .unwrap();
            assert_oracle(&source, &c);
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
            assert_oracle(&source, &c);
            c.execute(
                "UPDATE meta SET value=?1 WHERE key='cursor'",
                [json!(400 + round).to_string()],
            )
            .unwrap();
            assert_oracle(&source, &c);
        }
    }

    #[test]
    fn first_use_migration_wal_uncommitted_pages_are_not_imported() {
        let (source, c) = wal_fixture();
        c.execute_batch("PRAGMA cache_size=1; BEGIN IMMEDIATE;")
            .unwrap();
        for n in 0..40 {
            c.execute(
                "INSERT INTO meta VALUES(?1,?2)",
                params![
                    format!("uncommitted-{n}"),
                    json!("x".repeat(4000)).to_string()
                ],
            )
            .unwrap();
        }
        let snapshot = sqlite_snapshot(&source.join("workspace.sqlite")).unwrap();
        assert_eq!(
            snapshot
                .query_row(
                    "SELECT count(*) FROM meta WHERE key LIKE 'uncommitted-%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(meta(&snapshot, "cursor").unwrap(), 325);
        c.execute_batch("ROLLBACK;").unwrap();
    }

    #[test]
    fn first_use_migration_wal_corrupt_header_or_frame_rejected() {
        let (source, _c) = wal_fixture();
        for offset in [24, 32 + 24 + 15] {
            let copy = copy_database(&source);
            let path = copy.join("workspace.sqlite-wal");
            let mut raw = fs::read(&path).unwrap();
            raw[offset] ^= 1;
            fs::write(&path, raw).unwrap();
            assert!(
                sqlite_snapshot(&copy.join("workspace.sqlite"))
                    .err()
                    .unwrap()
                    .contains("校验失败")
            );
        }
    }

    #[test]
    fn first_use_migration_wal_old_generation_tail_and_incomplete_tail_ignored() {
        let (source, c) = wal_fixture();
        let raw = fs::read(source.join("workspace.sqlite-wal")).unwrap();
        let page_size = u32::from_be_bytes(raw[8..12].try_into().unwrap()) as usize;
        for incomplete in [false, true] {
            let copy = copy_database(&source);
            let path = copy.join("workspace.sqlite-wal");
            let mut added = raw.clone();
            let mut frame = raw[32..32 + 24 + page_size].to_vec();
            frame[8] ^= 1;
            added.extend_from_slice(if incomplete { &frame[..17] } else { &frame });
            fs::write(&path, added).unwrap();
            assert_oracle(&copy, &c);
        }
    }

    #[test]
    fn first_use_migration_nonempty_rollback_journal_refused_without_source_write() {
        let (source, _c) = wal_fixture();
        fs::write(source.join("workspace.sqlite-journal"), b"pending-recovery").unwrap();
        let before = fingerprints(&source);
        assert!(
            sqlite_snapshot(&source.join("workspace.sqlite"))
                .err()
                .unwrap()
                .contains("恢复日志")
        );
        assert_eq!(before, fingerprints(&source));
    }

    #[test]
    fn first_use_migration_legacy_image_immutable_outbox_is_actionably_refused() {
        let (store, source) = fixture();
        let c = sqlite_source(&source, false);
        let raw: String = c
            .query_row("SELECT request FROM outbox", [], |r| r.get(0))
            .unwrap();
        let mut request: Value = serde_json::from_str(&raw).unwrap();
        request["payload"]["after"]["caseImage"] = json!("/uploads/12-34-0123456789abcdef.png");
        c.execute("UPDATE outbox SET request=?1", [request.to_string()])
            .unwrap();
        drop(c);
        let before = fingerprints(&source);
        assert!(
            prepare(&store, &source, &owner(), || Ok(()))
                .err()
                .unwrap()
                .contains("待确认提交")
        );
        assert_eq!(before, fingerprints(&source));
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
    }

    #[test]
    fn first_use_migration_pending_conflict_with_legacy_image_refused() {
        let (store, source) = fixture();
        let c = sqlite_source(&source, false);
        c.execute(
            "UPDATE records SET conflict=?1",
            [
                json!({"remote":{"data":{"caseImage":"/uploads/12-34-0123456789abcdef.png"}}})
                    .to_string(),
            ],
        )
        .unwrap();
        drop(c);
        assert!(
            prepare(&store, &source, &owner(), || Ok(()))
                .err()
                .unwrap()
                .contains("未解决冲突")
        );
        assert_eq!(
            cloud_state::first_use_status(&store).unwrap()["required"],
            true
        );
    }

    fn actual_js_plan(p: &PreparedLegacyMigration) -> Value {
        let mut command = std::process::Command::new("node");
        command.args(["--input-type=module","-e","import fs from 'node:fs';import {buildLegacyMigrationPlan} from './apps/desktop/public/workbench/legacy-migration-plan.js';process.stdout.write(JSON.stringify(buildLegacyMigrationPlan(JSON.parse(fs.readFileSync(0,'utf8'))))); "])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(p.preview().to_string().as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "JS migration builder: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        parse(&result.stdout).unwrap()
    }

    #[test]
    fn first_use_migration_actual_js_prepare_apply_reopen_file_only_and_pending_bound() {
        for bound in [false, true] {
            let (store, source) = fixture();
            if bound {
                drop(sqlite_source(&source, false));
            }
            let before = fingerprints(&source);
            let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
            let input = actual_js_plan(&p);
            apply(&store, &p, &input, &owner(), || Ok(())).unwrap();
            let saved: Value = parse(cloud_state::load(&store).unwrap().body.as_bytes()).unwrap();
            assert_eq!(saved["document"]["records"], input["records"]);
            assert_eq!(
                saved["document"]["materializedProjection"],
                input["materializedProjection"]
            );
            assert_eq!(saved["document"]["outbox"], json!(p.outbox));
            assert_eq!(saved["state"]["configs"], p.state["configs"]);
            assert_eq!(before, fingerprints(&source));
        }
    }

    #[test]
    fn first_use_migration_actual_js_rewrites_legacy_images_before_worker_validation() {
        let (store, source) = fixture();
        let raw = b"\x89PNG\r\n\x1a\nlegacy-integrated-fixture";
        let hash = digest(raw);
        let name = format!("123-456-{}.png", &hash[..16]);
        let old = format!("/uploads/{name}");
        let canonical = format!("/uploads/{hash}.png");
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets").join(&name), raw).unwrap();
        let mut saved = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        saved["configs"][0]["caseImage"] = json!(old);
        fs::write(source.join("state.json"), saved.to_string()).unwrap();
        let c = sqlite_source(&source, false);
        c.execute("DELETE FROM outbox", []).unwrap();
        drop(c);
        let before = fingerprints(&source);
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        let input = actual_js_plan(&p);
        assert_eq!(input["records"][0]["base"]["caseImage"], old);
        assert_eq!(input["records"][0]["draft"]["caseImage"], canonical);
        apply(&store, &p, &input, &owner(), || Ok(())).unwrap();
        let loaded: Value = parse(cloud_state::load(&store).unwrap().body.as_bytes()).unwrap();
        assert_eq!(loaded["state"]["configs"][0]["caseImage"], canonical);
        assert_eq!(
            loaded["document"]["records"][0]["draft"]["caseImage"],
            canonical
        );
        assert_eq!(loaded["document"]["records"][0]["base"]["caseImage"], old);
        assert_eq!(before, fingerprints(&source));
    }

    #[test]
    fn first_use_migration_disabled_zero_revision_prefers_json_and_imports_draft_only() {
        let (store, source) = fixture();
        let c = sqlite_source(&source, false);
        let mut file = parse(&fs::read(source.join("state.json")).unwrap()).unwrap();
        file["revision"] = json!(0);
        file["configs"][0]["name"] = json!("JSON 最初保存");
        fs::write(source.join("state.json"), file.to_string()).unwrap();
        c.execute("UPDATE meta SET value='false' WHERE key='enabled'", [])
            .unwrap();
        c.execute(
            "UPDATE meta SET value='0' WHERE key='localWorkspaceRevision'",
            [],
        )
        .unwrap();
        c.execute("DELETE FROM outbox", []).unwrap();
        c.execute("DELETE FROM records WHERE type='workspace_meta'", [])
            .unwrap();
        c.execute(
            "UPDATE records SET base='null',version=0,draft=?1",
            [projected(&file)[0]["data"].to_string()],
        )
        .unwrap();
        drop(c);
        let before = fingerprints(&source);
        let p = prepare(&store, &source, &owner(), || Ok(())).unwrap();
        assert!(!p.source_bound);
        assert_eq!(p.source_kind, "state.json");
        assert_eq!(p.state["configs"][0]["name"], "JSON 最初保存");
        let plan = actual_js_plan(&p);
        apply(&store, &p, &plan, &owner(), || Ok(())).unwrap();
        let loaded: Value = parse(cloud_state::load(&store).unwrap().body.as_bytes()).unwrap();
        assert_eq!(loaded["document"]["cursor"], 0);
        assert_eq!(loaded["document"]["records"][0]["base"], Value::Null);
        assert_eq!(before, fingerprints(&source));
    }
}
