// 旧历史归档只读访问与选中配置恢复；恢复须核对预览版本、归档摘要和所需本机素材。
//! Read-only legacy archive; only an explicitly previewed selection can enter the current store.
use super::*;
use rusqlite::OpenFlags;
use std::io::Read;
use std::sync::{Mutex, OnceLock};

const PAGE: usize = 50;
const EXPANDED_LIMIT: u64 = 256 * 1024 * 1024;

fn archive_root(store: &WorkbenchStore) -> PathBuf {
    store.path.parent().unwrap().join("legacy-history")
}
// 读取归档清单并要求格式、版本和完成标记有效；实际文件摘要在打开数据库时另行核验。
fn manifest(store: &WorkbenchStore) -> Result<Value> {
    let path = archive_root(store).join("manifest.json");
    if !path.is_file() {
        return Err("尚未导入旧历史归档".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value["format"] != "diytools-legacy-history"
        || value["formatVersion"] != 1
        || value["status"] != "complete"
    {
        return Err("旧历史归档尚未完成校验".into());
    }
    Ok(value)
}
// 使用只读连接访问旧历史归档，避免查看历史时改变原库。
fn archive_db(store: &WorkbenchStore, name: &str) -> Result<Connection> {
    let m = manifest(store)?;
    let key = name.strip_suffix(".sqlite").ok_or("归档数据库名称无效")?;
    let expected = &m["databases"][key];
    let sha = expected["sha256"]
        .as_str()
        .filter(|s| s.len() == 64)
        .ok_or("归档数据库摘要缺失")?;
    if expected["file"] != name {
        return Err("归档数据库清单无效".into());
    }
    let path = archive_root(store).join(name);
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let signature = (
        metadata.len(),
        metadata.modified().map_err(|e| e.to_string())?,
        sha.to_owned(),
    );
    if expected["bytes"].as_u64() != Some(metadata.len()) {
        return Err("旧历史数据库大小不符".into());
    }
    for suffix in ["-wal", "-journal"] {
        if fs::metadata(format!("{}{suffix}", path.display())).is_ok_and(|m| m.len() > 0) {
            return Err("旧历史归档出现未校验的写入日志".into());
        }
    }
    type Signature = (u64, std::time::SystemTime, String);
    static VERIFIED: OnceLock<Mutex<HashMap<PathBuf, Signature>>> = OnceLock::new();
    let cache = VERIFIED.get_or_init(Default::default);
    let verified = cache.lock().map_err(|_| "归档校验锁不可用")?.get(&path) == Some(&signature);
    if !verified {
        let mut reader = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let after = fs::metadata(&path).map_err(|e| e.to_string())?;
        if format!("{:x}", hasher.finalize()) != sha
            || after.len() != signature.0
            || after.modified().map_err(|e| e.to_string())? != signature.1
        {
            return Err("旧历史数据库摘要不符或校验时发生变化".into());
        }
        cache
            .lock()
            .map_err(|_| "归档校验锁不可用")?
            .insert(path.clone(), signature);
    }
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("旧历史归档不可读：{e}"))?;
    c.pragma_update(None, "query_only", true)
        .map_err(|e| e.to_string())?;
    let query = if name == "versions.sqlite" {
        "SELECT COUNT(DISTINCT scope) FROM versions"
    } else {
        "SELECT COUNT(DISTINCT workspace) FROM profit_runs"
    };
    let scopes: i64 = c
        .query_row(query, [], |r| r.get(0))
        .map_err(|e| format!("旧历史表结构无效：{e}"))?;
    if scopes > 1 {
        return Err("归档包含多个旧工作区，请按工作区拆分后导入".into());
    }
    Ok(c)
}
fn offset(input: &Value) -> usize {
    input["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize
}
fn id(input: &Value) -> Result<&str> {
    input["id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("旧版本 ID 无效".into())
}

// 限制解压大小并验证内容摘要、版本和结构，防止损坏归档进入恢复流程。
fn load_version(store: &WorkbenchStore, input: &Value) -> Result<(Value, String)> {
    let c = archive_db(store, "versions.sqlite")?;
    let (encoding, hash, content, revision): (String, String, Vec<u8>, i64) = c
        .query_row(
            "SELECT encoding,hash,content,revision FROM versions WHERE id=?1",
            [id(input)?],
            |r| {
                let bytes = match r.get_ref(2)? {
                    rusqlite::types::ValueRef::Blob(b) | rusqlite::types::ValueRef::Text(b) => {
                        b.to_vec()
                    }
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            2,
                            "content".into(),
                            r.get_ref(2)?.data_type(),
                        ))
                    }
                };
                Ok((r.get(0)?, r.get(1)?, bytes, r.get(3)?))
            },
        )
        .map_err(|_| "旧版本不存在或格式无效")?;
    let bytes = match encoding.as_str() {
        "zlib" => {
            let mut raw = Vec::new();
            let mut decoder = flate2::read::ZlibDecoder::new(content.as_slice());
            decoder
                .by_ref()
                .take(EXPANDED_LIMIT + 1)
                .read_to_end(&mut raw)
                .map_err(|_| "旧版本解压失败")?;
            if raw.len() as u64 <= EXPANDED_LIMIT && decoder.total_in() != content.len() as u64 {
                return Err("旧版本压缩内容含额外数据".into());
            }
            raw
        }
        "json" => content,
        _ => return Err("旧版本压缩格式不支持".into()),
    };
    if bytes.len() as u64 > EXPANDED_LIMIT {
        return Err("旧版本超过解压上限".into());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err("旧版本内容摘要不符".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "旧版本 JSON 无效")?;
    validate(&value)?;
    if value["revision"].as_i64() != Some(revision) {
        return Err("旧版本修订号与内容不符".into());
    }
    Ok((value, hash))
}
// 合并旧行并清理旧快照不存在的删除标记和实际 BOM，恢复后的成本口径以旧版为准。
fn restored_row(current: Option<&Value>, old: &Value) -> Value {
    let mut result = current.cloned().unwrap_or_else(|| json!({}));
    let object = result.as_object_mut().unwrap();
    object.extend(old.as_object().unwrap().clone());
    // These absent markers describe an active, ordinary old record; retaining a
    // present-day deletion marker would make a successful recovery stay hidden.
    for marker in ["deletedAt", "deletedBy", "emptyLinkDraft"] {
        if old.get(marker).is_none() {
            object.remove(marker);
        }
    }
    // Earlier snapshots used parts as the actual BOM. A newer actualParts value
    // must not silently survive and make the recovered costs use today's BOM.
    if old.get("actualParts").is_none() {
        object.remove("actualParts");
    }
    result
}
fn differences(current: &Value, old: &Value) -> Vec<Value> {
    let current_by_id: HashMap<&str, &Value> = current["configs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
        .collect();
    old["configs"].as_array().unwrap().iter().filter(|row| {
        let before=current_by_id.get(row["id"].as_str().unwrap()).copied();
        before!=Some(&restored_row(before,row))
    })
        .map(|row| json!({"id":row["id"],"shopId":row["shopId"],"product":row["product"],"name":row["name"],"deletedAt":row["deletedAt"],"kind":if current_by_id.contains_key(row["id"].as_str().unwrap()){"替换配置"}else{"找回配置"}})).collect()
}
// 检查恢复配置引用的本机及内置素材，远程或失效图片不能被视为完整离线恢复。
fn missing_assets(store: &WorkbenchStore, value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::String(s) if s.starts_with("/uploads/") || s.starts_with("/saved/") => {
            let path = Path::new(s.trim_start_matches('/'));
            let local = store.assets.join(path);
            let valid = !s.contains(['\\', ':', '%', '?', '#'])
                && !path
                    .components()
                    .any(|p| !matches!(p, Component::Normal(_)))
                && local.is_file()
                && store
                    .assets
                    .canonicalize()
                    .ok()
                    .zip(local.canonicalize().ok())
                    .is_some_and(|(base, file)| file.starts_with(base));
            if !valid {
                out.insert(s.clone());
            }
        }
        Value::String(s) if s.starts_with("/assets/") => {
            static BUILTINS: OnceLock<HashSet<String>> = OnceLock::new();
            let known = BUILTINS.get_or_init(|| {
                let v: Value = serde_json::from_str(include_str!(
                    "../../../public/workbench/source-manifest.json"
                ))
                .unwrap();
                v["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|f| f["file"].as_str().map(|s| format!("/{s}")))
                    .collect()
            });
            if !known.contains(s) {
                out.insert(s.clone());
            }
        }
        Value::String(s)
            if s.starts_with("/images/")
                || s.starts_with("images/")
                || s.starts_with("cloud://")
                || s.starts_with("cloudbase://") =>
        {
            out.insert(s.clone());
        }
        Value::Object(o) => {
            for (key, v) in o {
                // Product URLs are business links. Image fields must be available
                // offline; accepting an HTTP image here would claim a complete restore.
                if ["caseImage", "backgroundImage", "backgroundUrl"].contains(&key.as_str())
                    && v.as_str().is_some_and(|s| {
                        s.starts_with("http://") || s.starts_with("https://") || s.contains(":\\")
                    })
                {
                    out.insert(v.as_str().unwrap().to_owned());
                }
                if let Some(rows) = v.as_array().filter(|_| key == "posterImages") {
                    for row in rows {
                        if let Some(url) = row["url"]
                            .as_str()
                            .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
                        {
                            out.insert(url.to_owned());
                        }
                    }
                }
                missing_assets(store, v, out);
            }
        }
        Value::Array(a) => {
            for v in a {
                missing_assets(store, v, out);
            }
        }
        _ => {}
    }
}
// 分页展示旧版与当前配置的差异，单套预览同时返回缺失素材和当前基线版本。
fn preview(store: &WorkbenchStore, input: &Value) -> Result<Value> {
    let (old, hash) = load_version(store, input)?;
    let current = state(&db(&store.path)?)?;
    let changes = differences(&current, &old);
    let mut missing = HashSet::new();
    let page: Vec<_> = changes
        .iter()
        .skip(offset(input))
        .take(PAGE)
        .cloned()
        .collect();
    if let Some(config_id) = input["configId"].as_str() {
        let old_row = old["configs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == config_id)
            .ok_or("旧版本中没有该配置")?;
        let before = current["configs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == config_id);
        let after = restored_row(before, old_row);
        missing_assets(store, &after, &mut missing);
        return Ok(
            json!({"id":id(input)?,"hash":hash,"baseRevision":current["revision"],"before":before,"after":after,"missingAssets":missing}),
        );
    }
    Ok(
        json!({"id":id(input)?,"hash":hash,"revision":old["revision"],"baseRevision":current["revision"],"total":changes.len(),"offset":offset(input),"limit":PAGE,"changes":page,"scope":"selected-configs-only"}),
    )
}
// 只还原明确选择的配置；重新核对版本、摘要和素材，再生成新历史事务。
fn restore(store: &WorkbenchStore, input: &Value) -> Result<ApiResponse> {
    let ids = input["configIds"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or("请选择 1 至 100 套配置")?;
    let ids: HashSet<&str> = ids
        .iter()
        .map(|v| v.as_str().ok_or("配置 ID 无效"))
        .collect::<std::result::Result<_, _>>()?;
    let (old, hash) = load_version(store, input)?;
    if input["hash"] != hash {
        return Ok(failure(409, "旧版本已变化，请重新预览"));
    }
    let mut c = db(&store.path)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let before = state(&tx)?;
    if before["revision"] != input["baseRevision"] {
        return Ok(failure(409, "当前配置已变化，请重新预览"));
    }
    let old_rows: HashMap<&str, &Value> = old["configs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
        .collect();
    let mut missing = HashSet::new();
    let current_rows: HashMap<&str, &Value> = before["configs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["id"].as_str().map(|id| (id, c)))
        .collect();
    for selected_id in &ids {
        let row = old_rows.get(selected_id).ok_or("选中配置不属于该旧版本")?;
        missing_assets(
            store,
            &restored_row(current_rows.get(selected_id).copied(), row),
            &mut missing,
        );
    }
    if !missing.is_empty() {
        return Ok(failure(
            400,
            "所选旧配置缺少本地素材，请先补齐素材后重新预览",
        ));
    }
    let mut target = before.clone();
    let rows = target["configs"].as_array_mut().unwrap();
    // Preserve today's order. Recovered missing rows follow the old snapshot's order.
    for row in rows.iter_mut() {
        if let Some(old_row) = row["id"]
            .as_str()
            .filter(|id| ids.contains(id))
            .and_then(|id| old_rows.get(id))
        {
            *row = restored_row(Some(row), old_row);
        }
    }
    let existing: HashSet<String> = rows
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    for row in old["configs"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        if ids.contains(id) && !existing.contains(id) {
            rows.push(row.clone());
        }
    }
    let mut counts = HashMap::<&str, usize>::new();
    for row in rows
        .iter()
        .filter(|r| r["deletedAt"].is_null() || r["deletedAt"] == "")
    {
        *counts
            .entry(row["shopId"].as_str().unwrap_or("intel"))
            .or_default() += 1;
    }
    if counts.values().any(|n| *n > 8000) {
        return Ok(failure(400, "还原后超过每店 8000 套配置上限"));
    }
    validate(&target)?;
    persist(
        &tx,
        &before,
        &mut target,
        &json!({"operator":"本机操作员","message":"从旧历史归档还原选中配置"}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(
        200,
        json!({"ok":true,"revision":target["revision"],"restored":ids.len()}),
    ))
}

pub(super) fn request(
    store: &WorkbenchStore,
    method: &str,
    path: &str,
    input: &Value,
) -> Result<ApiResponse> {
    match (method, path) {
        ("GET", "/api/legacy-history/status") => {
            if !archive_root(store).join("manifest.json").is_file() {
                return Ok(response(200, json!({"available":false})));
            }
            let m = manifest(store)?;
            Ok(response(
                200,
                json!({"available":true,"databases":m["databases"],"verification":m["verification"]}),
            ))
        }
        ("POST", "/api/legacy-history/versions") => {
            let c = archive_db(store, "versions.sqlite")?;
            let total: i64 = c
                .query_row("SELECT COUNT(*) FROM versions", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let mut q=c.prepare("SELECT id,scope,at,revision,reason,name,pinned FROM versions ORDER BY rowid DESC LIMIT ?1 OFFSET ?2").map_err(|e|e.to_string())?;
            let versions=q.query_map(params![PAGE as i64,offset(input) as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"scope":r.get::<_,String>(1)?,"at":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?,"reason":r.get::<_,String>(4)?,"name":r.get::<_,Option<String>>(5)?,"pinned":r.get::<_,i64>(6)?!=0}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
            Ok(response(
                200,
                json!({"versions":versions,"total":total,"offset":offset(input),"limit":PAGE}),
            ))
        }
        ("POST", "/api/legacy-history/preview") => Ok(response(200, preview(store, input)?)),
        ("POST", "/api/legacy-history/restore") => restore(store, input),
        ("GET", "/api/legacy-history/profit") => {
            let c = archive_db(store, "profit.sqlite")?;
            let mut q=c.prepare("SELECT id,started_at,status,covered,source,formula FROM profit_runs ORDER BY started_at DESC LIMIT 100").map_err(|e|e.to_string())?;
            let runs=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"started_at":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"covered":r.get::<_,i64>(3)?,"source":r.get::<_,String>(4)?,"formula":r.get::<_,String>(5)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
            Ok(response(200, json!({"runs":runs,"readonly":true})))
        }
        ("POST", "/api/legacy-history/profit") => {
            let c = archive_db(store, "profit.sqlite")?;
            let run_id = id(input)?;
            let total: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM profit_results WHERE run_id=?1",
                    [run_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let mut q=c.prepare("SELECT r.config_id,r.shop_id,r.metric,r.valid,r.profit_cents,r.anchor_delta_cents,r.reason,s.content,s.content_hash FROM profit_results r JOIN profit_snapshots s ON s.run_id=r.run_id AND s.shop_id=r.shop_id AND s.config_id=r.config_id WHERE r.run_id=?1 ORDER BY r.rowid LIMIT ?2 OFFSET ?3").map_err(|e|e.to_string())?;
            let mut rows=q.query_map(params![run_id,PAGE as i64,offset(input) as i64],|r|Ok(json!({"configId":r.get::<_,String>(0)?,"shopId":r.get::<_,String>(1)?,"metric":r.get::<_,String>(2)?,"valid":r.get::<_,i64>(3)?!=0,"profitCents":r.get::<_,Option<i64>>(4)?,"anchorDeltaCents":r.get::<_,Option<i64>>(5)?,"reason":r.get::<_,String>(6)?,"content":r.get::<_,String>(7)?,"contentHash":r.get::<_,String>(8)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
            for row in &mut rows {
                let raw = row["content"].as_str().unwrap();
                if format!("{:x}", Sha256::digest(raw.as_bytes()))
                    != row["contentHash"].as_str().unwrap()
                {
                    return Err("旧利润快照摘要不符".into());
                }
                let snapshot: Value =
                    serde_json::from_str(raw).map_err(|_| "旧利润快照JSON无效")?;
                if snapshot["configId"] != row["configId"] || snapshot["shopId"] != row["shopId"] {
                    return Err("旧利润快照身份不符".into());
                }
                row["snapshot"] = snapshot;
                row.as_object_mut().unwrap().remove("content");
            }
            Ok(response(
                200,
                json!({"rows":rows,"total":total,"offset":offset(input),"limit":PAGE,"readonly":true}),
            ))
        }
        _ => Ok(failure(404, "旧历史接口不存在")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_display_parts_remain_the_actual_bom_when_actual_parts_were_absent() {
        let current = json!({"id":"a","parts":[{"model":"today"}],"actualParts":[{"model":"today actual"}],"futureField":7});
        let old = json!({"id":"a","parts":[{"model":"old actual"}]});
        let restored = restored_row(Some(&current), &old);
        assert!(restored.get("actualParts").is_none());
        assert_eq!(restored["parts"], old["parts"]);
        assert_eq!(restored["futureField"], 7);
        let explicit_empty = json!({"id":"a","parts":[{"model":"display"}],"actualParts":[]});
        assert_eq!(
            restored_row(Some(&current), &explicit_empty)["actualParts"],
            json!([])
        );
    }
    fn refresh_manifest(store: &WorkbenchStore) {
        let path = archive_root(store).join("versions.sqlite");
        let bytes = fs::read(&path).unwrap();
        fs::write(archive_root(store).join("manifest.json"),json!({"format":"diytools-legacy-history","formatVersion":1,"status":"complete","databases":{"versions":{"file":"versions.sqlite","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))}}}).to_string()).unwrap();
    }
    fn fixture() -> (WorkbenchStore, Value) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../sandbox/legacy-history-tests")
            .join(unique());
        fs::create_dir_all(&root).unwrap();
        let current = json!({"revision":7,"configs":[{"id":"a","shopId":"intel","name":"今日A","parts":[],"actualParts":[],"newField":{"keep":true}},{"id":"b","shopId":"intel","name":"今日B","parts":[]}],"templates":[],"shopSettings":{"intel":{"currentOnly":true}},"currentOnly":"preserve","logs":[]});
        let seed = root.join("seed.json");
        fs::write(&seed, current.to_string()).unwrap();
        let store =
            initialize(&root.join("workbench.sqlite"), &seed, &root.join("assets")).unwrap();
        fs::create_dir_all(archive_root(&store)).unwrap();
        let old = json!({"revision":1,"configs":[{"id":"a","shopId":"intel","name":"旧A","parts":[],"actualParts":[],"oldUnknown":{"raw":1.2}},{"id":"c","shopId":"intel","name":"找回C","parts":[]}],"templates":[],"shopSettings":{"old":true}});
        let c = Connection::open(archive_root(&store).join("versions.sqlite")).unwrap();
        c.execute_batch("CREATE TABLE versions(id TEXT PRIMARY KEY,scope TEXT,at TEXT,revision INTEGER,reason TEXT,hash TEXT,content BLOB,encoding TEXT,name TEXT,pinned INTEGER);").unwrap();
        let bytes = old.to_string().into_bytes();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let mut compressed =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        compressed.write_all(&bytes).unwrap();
        c.execute(
            "INSERT INTO versions VALUES('old','local','2026-10-11',1,'old',?1,?2,'zlib','固定',1)",
            params![hash, compressed.finish().unwrap()],
        )
        .unwrap();
        refresh_manifest(&store);
        (store, current)
    }
    #[test]
    fn archive_preview_restore_selection_is_transactional_and_current_history_can_undo() {
        let (store, current) = fixture();
        let archive = fs::read(archive_root(&store).join("versions.sqlite")).unwrap();
        let p = preview(&store, &json!({"id":"old"})).unwrap();
        assert_eq!(p["total"], 2);
        assert_eq!(state(&db(&store.path).unwrap()).unwrap(), {
            let mut c = current.clone();
            c.as_object_mut().unwrap().remove("logs");
            c
        });
        let result = restore(
            &store,
            &json!({"id":"old","hash":p["hash"],"baseRevision":7,"configIds":["a","c"]}),
        )
        .unwrap();
        assert_eq!(result.status, 200);
        let c = db(&store.path).unwrap();
        let after = state(&c).unwrap();
        assert_eq!(after["configs"][0]["name"], "旧A");
        assert_eq!(after["configs"][0]["oldUnknown"]["raw"], 1.2);
        assert_eq!(
            after["configs"][0]["newField"],
            current["configs"][0]["newField"]
        );
        assert_eq!(
            preview(&store, &json!({"id":"old","configId":"a"})).unwrap()["after"],
            after["configs"][0]
        );
        assert_eq!(after["configs"][1], current["configs"][1]);
        assert_eq!(after["configs"][2]["id"], "c");
        assert_eq!(after["shopSettings"], current["shopSettings"]);
        assert_eq!(after["currentOnly"], "preserve");
        assert_eq!(reconstruct(&c, 1).unwrap()["configs"], current["configs"]);
        assert_eq!(
            archive,
            fs::read(archive_root(&store).join("versions.sqlite")).unwrap()
        );
        assert_eq!(
            restore(
                &store,
                &json!({"id":"old","hash":p["hash"],"baseRevision":7,"configIds":["a"]})
            )
            .unwrap()
            .status,
            409
        );
    }
    #[test]
    fn archive_corruption_empty_selection_and_missing_assets_do_not_mutate_current() {
        let (store, _) = fixture();
        let before = state(&db(&store.path).unwrap()).unwrap();
        assert!(restore(&store, &json!({"id":"old","configIds":[]})).is_err());
        let archive = Connection::open(archive_root(&store).join("versions.sqlite")).unwrap();
        let missing = json!({"revision":2,"configs":[{"id":"a","parts":[],"caseImage":"/uploads/missing.png"}]});
        let raw = missing.to_string();
        let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
        archive
            .execute(
                "UPDATE versions SET content=?1,encoding='json',hash=?2,revision=2",
                params![raw, hash],
            )
            .unwrap();
        refresh_manifest(&store);
        let p = preview(&store, &json!({"id":"old","configId":"a"})).unwrap();
        assert_eq!(p["missingAssets"].as_array().unwrap().len(), 1);
        assert_eq!(
            restore(
                &store,
                &json!({"id":"old","hash":hash,"baseRevision":7,"configIds":["a"]})
            )
            .unwrap()
            .status,
            400
        );
        archive
            .execute("UPDATE versions SET hash='wrong'", [])
            .unwrap();
        refresh_manifest(&store);
        assert!(preview(&store, &json!({"id":"old"}))
            .unwrap_err()
            .contains("内容摘要"));
        assert_eq!(state(&db(&store.path).unwrap()).unwrap(), before);
    }
    #[test]
    fn archive_metadata_is_paged_and_incomplete_archive_is_unavailable() {
        let (store, _) = fixture();
        let result = request(
            &store,
            "POST",
            "/api/legacy-history/versions",
            &json!({"offset":0}),
        )
        .unwrap();
        let page: Value = serde_json::from_str(&result.body).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["versions"][0]["name"], "固定");
        assert_eq!(page["versions"][0]["pinned"], true);
        let result = request(
            &store,
            "POST",
            "/api/legacy-history/versions",
            &json!({"offset":50}),
        )
        .unwrap();
        let page: Value = serde_json::from_str(&result.body).unwrap();
        assert_eq!(page["versions"], json!([]));
        fs::write(archive_root(&store).join("manifest.json"), "{}").unwrap();
        assert!(manifest(&store).is_err());
    }
    #[test]
    fn restored_fields_match_preview_and_do_not_keep_current_deletion_markers() {
        let current = json!({"id":"a","name":"same","newField":{"keep":true},"deletedAt":"2026-10-12","emptyLinkDraft":true,"optional":"value"});
        let old = json!({"id":"a","name":"same","optional":null});
        let result = restored_row(Some(&current), &old);
        assert!(result.get("deletedAt").is_none());
        assert!(result.get("emptyLinkDraft").is_none());
        assert_eq!(result["newField"], current["newField"]);
        assert!(result["optional"].is_null());
        assert_eq!(
            differences(&json!({"configs":[result]}), &json!({"configs":[old]})),
            Vec::<Value>::new()
        );
    }
    #[test]
    fn archive_database_tampering_is_rejected_before_reading_rows() {
        let (store, _) = fixture();
        archive_db(&store, "versions.sqlite").unwrap();
        let c = Connection::open(archive_root(&store).join("versions.sqlite")).unwrap();
        c.execute("UPDATE versions SET name='tampered'", [])
            .unwrap();
        assert!(archive_db(&store, "versions.sqlite")
            .unwrap_err()
            .contains("摘要"));
    }
    #[test]
    fn missing_assets_rejects_remote_images_but_retains_business_links_and_bundled_images() {
        let (store, _) = fixture();
        let mut missing = HashSet::new();
        missing_assets(
            &store,
            &json!({"productUrl":"https://example.com/product","caseImage":"/assets/case.png","posterImages":[{"url":"https://example.com/image.png"}],"backgroundImage":"cloud://missing","legacy":"/images/missing.png"}),
            &mut missing,
        );
        assert_eq!(missing.len(), 3);
        assert!(!missing.contains("/assets/case.png"));
        assert!(!missing.contains("https://example.com/product"));
    }
}
