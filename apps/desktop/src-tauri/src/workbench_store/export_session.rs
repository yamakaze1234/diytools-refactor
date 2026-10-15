//! 分批导出仅使用本进程选定目录的会话令牌，避免整批 Base64 触发 IPC 字符串上限。
use super::*;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

struct Session {
    folder: PathBuf,
    saved: Vec<String>,
    names: HashSet<String>,
    parents: HashSet<String>,
    error: Option<String>,
    touched: Instant,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Session>> { SESSIONS.get_or_init(|| Mutex::new(HashMap::new())) }
fn receipt(session: &Session) -> Value {
    json!({"ok":session.error.is_none(),"cancelled":false,"directory":session.folder,"files":session.saved,"error":session.error})
}
pub(super) fn begin(payload: &Value, directory: &Path) -> Result<Value> {
    let name=payload["name"].as_str().filter(|name|export_segment_valid(name)).ok_or("导出文件夹名称无效")?;
    let mut all=sessions().lock().map_err(|e|e.to_string())?;
    all.retain(|_,session|session.touched.elapsed()<Duration::from_secs(3600));
    if all.len()>=16 { return Err("同时导出的任务过多，请等待已有任务完成".into()); }
    let folder=create_export_folder(directory,name)?;
    let token=uuid::Uuid::new_v4().to_string();
    all.insert(token.clone(),Session{folder:folder.clone(),saved:Vec::new(),names:HashSet::new(),parents:HashSet::new(),error:None,touched:Instant::now()});
    Ok(json!({"ok":true,"token":token,"directory":folder,"files":[]}))
}
pub(super) fn dispatch(payload: &Value) -> Result<Value> {
    let token=payload["token"].as_str().ok_or("缺少导出会话")?;
    let mut all=sessions().lock().map_err(|e|e.to_string())?;
    if payload["phase"]=="finish" {
        let session=all.remove(token).ok_or("导出会话已结束，请重新导出")?;
        return Ok(receipt(&session));
    }
    if payload["phase"]!="append" {return Err("未知导出阶段".into());}
    let session=all.get_mut(token).ok_or("导出会话已结束，请重新导出")?;
    session.touched=Instant::now();
    if session.error.is_none() {
        if let Err(error)=append(session,payload) { session.error=Some(error); }
    }
    Ok(receipt(session))
}
fn append(session: &mut Session, payload: &Value) -> Result<()> {
    let rows=payload["files"].as_array().filter(|rows|!rows.is_empty()&&rows.len()<=64).ok_or("分批导出文件列表无效")?;
    if session.saved.len()+rows.len()>3000 {return Err("导出文件超过3000个，请缩小范围".into());}
    let mut encoded=0usize;
    let mut names=session.names.clone();
    let mut decoded=Vec::new();
    for row in rows {
        let name=row["name"].as_str().ok_or("导出文件名无效")?;
        let segments=name.split('/').collect::<Vec<_>>();
        if segments.len()>2 || !segments.iter().all(|s|export_segment_valid(s)) || !names.insert(name.to_lowercase()) {return Err("导出文件名重复或包含路径".into());}
        let data=row["base64"].as_str().ok_or("导出文件编码无效")?;
        encoded=encoded.checked_add(data.len()).ok_or("导出编码大小无效")?;
        if encoded>180*1024*1024 {return Err("单批导出数据过大，请拆分后重试".into());}
        decoded.push((name.to_owned(),decode_limited(data,MAX_GENERATED_IMAGE_BYTES)?));
    }
    for (name,_) in &decoded {
        if let Some((parent,_))=name.split_once('/') && names.contains(&parent.to_lowercase()) {return Err("导出目录与文件同名".into());}
    }
    if fs::symlink_metadata(&session.folder).map_err(|e|e.to_string())?.file_type().is_symlink() {return Err("导出目录已被替换".into());}
    for (name,raw) in decoded {
        if let Some((parent,_))=name.split_once('/') {
            if session.parents.insert(parent.to_lowercase()) {fs::create_dir(session.folder.join(parent)).map_err(|e|e.to_string())?;}
            let meta=fs::symlink_metadata(session.folder.join(parent)).map_err(|e|e.to_string())?;
            if !meta.is_dir()||meta.file_type().is_symlink(){return Err("导出子目录已被替换".into());}
        }
        write_new(&session.folder.join(&name),&raw)?;
        session.names.insert(name.to_lowercase());session.saved.push(name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_share_folder_and_finish_invalidates_token() {
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/upgrade-batch-20261015/native-export").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let opened=begin(&json!({"name":"分批验证"}),&root).unwrap();
        let token=&opened["token"];
        for name in ["链接_配置图/1_配置1.png","链接_配置图/2_配置2.png"] {
            let result=dispatch(&json!({"phase":"append","token":token,"files":[{"name":name,"base64":STANDARD.encode(b"png")}]})).unwrap();assert_eq!(result["ok"],true);
            assert_eq!(fs::read(Path::new(opened["directory"].as_str().unwrap()).join(name)).unwrap(),b"png");
        }
        let finished=dispatch(&json!({"phase":"finish","token":token})).unwrap();assert_eq!(finished["files"].as_array().unwrap().len(),2);
        assert!(dispatch(&json!({"phase":"append","token":token,"files":[]})).is_err());
    }
    #[test]
    fn collision_preserves_saved_receipt_and_rejects_path_escape() {
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../sandbox/upgrade-batch-20261015/native-export").join(uuid::Uuid::new_v4().to_string());fs::create_dir_all(&root).unwrap();
        for invalid in ["1.png","../escape.png","C:/escape.png"] {
            let opened=begin(&json!({"name":"保护验证"}),&root).unwrap();let token=&opened["token"];
            let put=|name:&str|dispatch(&json!({"phase":"append","token":token,"files":[{"name":name,"base64":STANDARD.encode(b"first")}]})).unwrap();
            assert_eq!(put("1.png")["ok"],true);let failed=put(invalid);assert_eq!(failed["ok"],false);assert_eq!(failed["files"],json!(["1.png"]));
            assert_eq!(fs::read(Path::new(opened["directory"].as_str().unwrap()).join("1.png")).unwrap(),b"first");
            dispatch(&json!({"phase":"finish","token":token})).unwrap();
        }
    }
}
