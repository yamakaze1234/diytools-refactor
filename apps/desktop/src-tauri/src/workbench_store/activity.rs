// 操作记录分页查询：让 SQLite 筛选归档和当前日志，只把请求页载入 Rust 内存。
//! Read only the requested activity page into Rust. Legacy archive stays in SQLite.
use super::*;
use chrono::{FixedOffset, NaiveDate, TimeZone};

struct Query {
    page: i64,
    size: i64,
    from: Option<i64>,
    to: Option<i64>,
}
fn date(raw: &str) -> Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| "日期须为 YYYY-MM-DD")?;
    if raw.len() != 10 || parsed.format("%Y-%m-%d").to_string() != raw {
        return Err("日期须为 YYYY-MM-DD".into());
    }
    Ok(parsed)
}
fn midnight(day: NaiveDate) -> Result<i64> {
    FixedOffset::east_opt(8 * 3600).unwrap()
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
        .single().map(|v| v.timestamp_millis()).ok_or("日期范围无效".into())
}
// 验证分页与筛选条件，日期边界按工作台使用的北京时间转换。
fn query(path: &str) -> Result<Query> {
    let url = reqwest::Url::parse(&format!("http://workbench.local{path}"))
        .map_err(|_| "操作记录查询参数无效")?;
    let mut q = Query { page: 0, size: 30, from: None, to: None };
    let mut seen = HashSet::new();
    let mut days = (None, None);
    for (key, raw) in url.query_pairs() {
        if !seen.insert(key.to_string()) { return Err("操作记录查询参数不可重复".into()); }
        match key.as_ref() {
            "page" | "pageSize" => {
                if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("分页参数须为非负整数".into());
                }
                let value: i64 = raw.parse().map_err(|_| "分页参数超出范围")?;
                if key == "page" { q.page = value; }
                else if (1..=100).contains(&value) { q.size = value; }
                else { return Err("pageSize 须为 1 至 100".into()); }
            }
            "from" => { if !raw.is_empty() { days.0 = Some(date(&raw)?); } }
            "to" => { if !raw.is_empty() { days.1 = Some(date(&raw)?); } }
            _ => return Err("未知操作记录查询参数".into()),
        }
    }
    if let (Some(from), Some(to)) = days {
        if from > to { return Err("开始日期不得晚于结束日期".into()); }
    }
    q.from = days.0.map(midnight).transpose()?;
    q.to = days.1.map(|day| midnight(day.succ_opt().ok_or("日期范围无效")?)).transpose()?;
    Ok(q)
}

// Input order matches logs(): newest native rows first, then legacy archive order.
// JS recentActivity filters age, de-duplicates in that input order, then stably
// sorts by timestamp. Calendar filtering must happen AFTER this de-duplication.
const ROWS: &str = r#"
WITH raw AS (
 SELECT 0 source, -sequence position, document FROM workbench_activity
 UNION ALL
 SELECT 1, CAST(j.key AS INTEGER), j.value
 FROM workbench_log_archive a, json_each(a.document) j
 WHERE a.id=1 AND j.type='object'
), extracted AS (
 SELECT *, json_extract(document,'$.at') stamp,
 json_type(document,'$.id') id_type, json_extract(document,'$.id') id_value
 FROM raw
), timed AS (
 SELECT *, CAST(ROUND((julianday(CASE
   WHEN length(stamp)=10 THEN stamp
   WHEN substr(stamp,-1) IN ('Z','z') OR substr(stamp,-6,1) IN ('+','-') THEN stamp
   ELSE stamp || '+08:00' END)-2440587.5)*86400000) AS INTEGER) at_ms,
 CASE
   WHEN id_type='text' AND id_value!='' THEN 'string:' || id_value
   WHEN id_type IN ('integer','real') AND id_value!=0 THEN 'number:' || CAST(CAST(id_value AS REAL) AS TEXT)
   WHEN id_type='true' THEN 'boolean:true'
   WHEN id_type IN ('object','array') THEN 'object:' || source || ':' || position
   ELSE 'string:' || json_array(json_extract(document,'$.at'),json_extract(document,'$.operator'),json_extract(document,'$.message'))
 END identity FROM extracted
), eligible AS (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY source,position) occurrence
 FROM timed WHERE at_ms>=?1 AND at_ms<=?2
), filtered AS (
 SELECT * FROM eligible WHERE occurrence=1
 AND (?3 IS NULL OR at_ms>=?3) AND (?4 IS NULL OR at_ms<?4)
)
"#;
pub(super) fn request(store: &WorkbenchStore, path: &str) -> Result<ApiResponse> {
    query_at(store, path, chrono::Utc::now().timestamp_millis())
}
// 在 SQLite 中合并当前记录和归档后分页，保持过滤口径与稳定顺序。
pub(super) fn query_at(store: &WorkbenchStore, path: &str, now_ms: i64) -> Result<ApiResponse> {
    let q = query(path)?;
    let mut c = db(&store.path)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let binds = params![now_ms - 7 * 24 * 3600 * 1000, now_ms + 60_000, q.from, q.to];
    let total: i64 = tx.query_row(&format!("{ROWS} SELECT COUNT(*) FROM filtered"), binds, |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page = q.page.min(((total - 1) / q.size).max(0));
    let mut rows = Vec::<Value>::new();
    {
        let mut stmt = tx.prepare(&format!("{ROWS} SELECT document FROM filtered ORDER BY at_ms DESC,source,position LIMIT ?5 OFFSET ?6"))
            .map_err(|e| e.to_string())?;
        for row in stmt.query_map(params![now_ms - 7 * 24 * 3600 * 1000, now_ms + 60_000, q.from, q.to, q.size, page * q.size], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())? {
            rows.push(serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?);
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response(200, json!({"rows":rows,"total":total,"page":page,"pageSize":q.size})))
}
