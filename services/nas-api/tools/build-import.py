"""生成目标库显式锁定的单语句事务导入；独立接收区保留全量原文。"""
import argparse
import hashlib
import json
from pathlib import Path
from export_intel_support import canonical, sha256


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def build(snapshot, output, database='diy_workbench_trial'):
    if database not in ('diy_workbench_trial','diy_workbench'):
        raise ValueError('未授权的工作台数据库名')
    target_error='只允许试验库' if database.endswith('_trial') else '只允许正式库'
    manifest = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
    raw = (snapshot / 'records.jsonl').read_bytes()
    assert sha256(raw) == manifest['records_sha256'], '记录文件摘要不匹配'
    rows = [json.loads(line) for line in raw.splitlines()]
    assert len(rows) == manifest['records_count']
    prices = json.loads((snapshot / 'workbook-prices.json').read_text(encoding='utf-8'))
    assets = json.loads((snapshot / 'assets.json').read_text(encoding='utf-8'))
    assert sha256(canonical(assets)) == manifest['assets_sha256']
    for asset in assets:
        path = (snapshot / asset['file']).resolve()
        assert path.is_relative_to(snapshot.resolve()) and sha256(path.read_bytes()) == asset['sha256']
    for row in rows:
        assert sha256(canonical(row['document'])) == row['sha256']
    # 报价核对与素材索引也进入接收区，但不自动发布销售报价。
    rows += [dict(kind='quotation', id=row['configuration_id'], owner='intel', shared=False, document={**row, 'workbook_sha256':prices['workbook_sha256'], 'sheet':prices['sheet'], 'source':prices['source']}) for row in prices['configurations']]
    rows += [dict(kind='asset', id=row['uri'], owner='shared', shared=True, document=row) for row in assets]
    rows.sort(key=lambda row:(row['kind'], row['id']))
    payload = []
    for row in rows:
        document = canonical(row['document'])
        payload.append({**{key:row[key] for key in ('kind','id','owner','shared')}, 'document_json':document.decode('utf-8'), 'sha256':sha256(document)})
    fingerprint = sha256(canonical(payload))
    batch = manifest['batch_id'] + '-' + fingerprint[:8]
    manifest = {**manifest, 'batch_id':batch, 'receiving_records_count':len(rows), 'payload_sha256':fingerprint, 'workbook_sha256':prices['workbook_sha256']}
    schema = '''
CREATE SCHEMA IF NOT EXISTS nas_import;
REVOKE ALL ON SCHEMA nas_import FROM PUBLIC;
CREATE TABLE IF NOT EXISTS nas_import.batches(
 batch_id text PRIMARY KEY, manifest jsonb NOT NULL, payload_sha256 text NOT NULL,
 record_count integer NOT NULL CHECK(record_count>0), imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nas_import.records(
 batch_id text NOT NULL REFERENCES nas_import.batches, kind text NOT NULL, record_id text NOT NULL,
 owner_shop text NOT NULL, shared boolean NOT NULL, document jsonb NOT NULL,
 source_sha256 text NOT NULL CHECK(length(source_sha256)=64), stored_md5 text NOT NULL,
 PRIMARY KEY(batch_id,kind,record_id)
);
COMMENT ON SCHEMA nas_import IS '全店迁移接收区；原文核对与后续规范化依据，不是现用业务数据源';
COMMENT ON TABLE nas_import.batches IS '已完整提交的迁移批次，含源版本及文件摘要';
COMMENT ON TABLE nas_import.records IS '无损业务文档、依赖、素材索引和维护表报价核对；不含软删除归档或凭据';
'''
    sql = f"-- 仅在 {database} 执行整个文件；单条 DO 内任一步失败会全部回滚。\nDO $full_import$\nDECLARE\n"
    sql += ' payload_text text := ' + literal(canonical(payload).decode('utf-8')) + ';\n'
    sql += ' manifest_value jsonb := ' + literal(canonical(manifest).decode('utf-8')) + '::jsonb;\n'
    sql += f""" payload jsonb; item jsonb; batch text; existing text; actual integer;
BEGIN
 IF current_database()<>{literal(database)} THEN RAISE EXCEPTION {literal(target_error)}; END IF;
 PERFORM pg_advisory_xact_lock(814517,1);
 IF encode(sha256(convert_to(payload_text,'UTF8')),'hex') <> manifest_value->>'payload_sha256' THEN RAISE EXCEPTION '传输摘要不一致'; END IF;
 payload := payload_text::jsonb; batch := manifest_value->>'batch_id';
"""
    sql += schema
    sql += '''
 SELECT payload_sha256 INTO existing FROM nas_import.batches WHERE batch_id=batch;
 IF existing IS NOT NULL THEN
  IF existing<>manifest_value->>'payload_sha256' THEN RAISE EXCEPTION '同批次内容冲突'; END IF;
 ELSE
  INSERT INTO nas_import.batches VALUES(batch,manifest_value,manifest_value->>'payload_sha256',jsonb_array_length(payload),now());
  FOR item IN SELECT value FROM jsonb_array_elements(payload) LOOP
   IF encode(sha256(convert_to(item->>'document_json','UTF8')),'hex') <> item->>'sha256' THEN RAISE EXCEPTION '记录摘要不一致'; END IF;
   INSERT INTO nas_import.records VALUES(batch,item->>'kind',item->>'id',item->>'owner',(item->>'shared')::boolean,
    (item->>'document_json')::jsonb,item->>'sha256',md5(((item->>'document_json')::jsonb)::text));
  END LOOP;
 END IF;
 SELECT count(*) INTO actual FROM nas_import.records WHERE batch_id=batch;
 IF actual<>jsonb_array_length(payload) THEN RAISE EXCEPTION '导入数量不一致'; END IF;
 -- 重复执行只核对，不覆盖；检测记录被删除、替换或后续误改。
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload) p LEFT JOIN nas_import.records r
   ON r.batch_id=batch AND r.kind=p->>'kind' AND r.record_id=p->>'id'
   WHERE r.record_id IS NULL OR r.source_sha256<>p->>'sha256' OR r.document IS DISTINCT FROM (p->>'document_json')::jsonb
    OR r.owner_shop<>p->>'owner' OR r.shared IS DISTINCT FROM (p->>'shared')::boolean)
 THEN RAISE EXCEPTION '导入回读不一致'; END IF;
END $full_import$;
'''
    output.mkdir(parents=True, exist_ok=False)
    (output/'01-导入全店接收区.sql').write_text(sql,encoding='utf-8')
    (output/'manifest.json').write_bytes(canonical(manifest))
    verify = "SELECT b.batch_id,b.record_count,b.payload_sha256,r.kind,count(*) AS records,bool_and(md5(r.document::text)=r.stored_md5) AS content_unchanged FROM nas_import.batches b JOIN nas_import.records r USING(batch_id) WHERE batch_id="+literal(batch)+" GROUP BY b.batch_id,b.record_count,b.payload_sha256,r.kind ORDER BY r.kind;\n"
    (output/'02-只读核对.sql').write_text(verify,encoding='utf-8')
    return dict(batch_id=batch,records=len(rows),sql_bytes=len(sql.encode('utf-8')),payload_sha256=fingerprint,target_database=database)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--database',choices=('diy_workbench_trial','diy_workbench'),default='diy_workbench_trial')
    args=parser.parse_args()
    print(json.dumps(build(args.snapshot,args.output,args.database)))
