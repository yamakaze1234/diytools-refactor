"""从冻住的两店业务快照生成待人工执行的正式 SQL；本工具不连接任何数据库。"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re

from export_intel_support import canonical, sha256


SQL_DIR = Path(__file__).resolve().parents[1] / 'sql'
SHOPS = ('gigabyte', 'jonsbo')
DB = 'diy_workbench'
INTEL_BATCH = 'intel-8151-9824e38b051851d8-fd417cd8'
INTEL_DIGEST = 'fd417cd8365bf476afd95c56c3a06bc395b04baca1741f3fe1f949b3cdcdf747'
SHA256 = r'[0-9a-f]{64}'
UID = r'[A-Za-z0-9_-]{8,128}'
PASSWORD = r'[A-Za-z0-9_-]{43,128}'
ASSET = rf'/uploads/({SHA256})\.(png|jpg|jpeg)'
SNAPSHOT_KINDS = {'shop', 'settings', 'source', 'cost', 'gallery', 'template', 'configuration', 'archived_configuration'}
SECRET_KEY = re.compile(r'password|access_?token|refresh_?token|authorization|cookie|secret', re.I)
FILES = (
    '004-runtime-operations.template.sql', '005-main-editor-catalog-read.sql', '006-catalog-management.sql',
    '007-workspace-operations.sql', '009-operations-activity-page.sql', '010-profit-observations.sql',
    '011-operations-price-history.sql',
)
# 旧模板的每个 SQL 权限面已逐项审查；原文件变化时强制重新审查，防止盲套新语句。
REVIEWED_SQL_SHA = dict(zip(('003-intel-live.sql', *FILES), (
    '7fe3f3fb4a457e805637a3a57a49c7607044bfa59f88fda541b1a9ddb26efd1f',
    '43feff48b8f69112a97a7c86751f0302a2eff3c411f00918081cfc4e081cc9de',
    '8980e6b6e6b0d801dcdae64775baa38b761c0078b36963bb0eef9f7f261c1362',
    '773ccda24d82863cbb8c2ab4139b52a4c464226aaac4e8646e5618158265c2ca',
    'f45ef9f9b45736176f3f9f5beb1cb666273877f6ed27aec5b5ab7ff9a89f7ee7',
    '8667479b602941f72ac5ea16a234d1242540b3dd1b7230c20c563670bd27cd9a',
    'e852b8b8c8c3c6fd99ddedef8e7ef91e0f767e808712909217c0ccbbdcb4c42f',
    '282b6c0b48c84f0350575b520584b2b2b613242d73019bffb8b367a35c9f80cd',
), strict=True))


def need(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def read_sql(file):
    content = (SQL_DIR / file).read_text(encoding='utf-8-sig').rstrip()
    if file in REVIEWED_SQL_SHA:
        need(sha256(content.encode('utf-8')) == REVIEWED_SQL_SHA[file], '上游 SQL 已改变，须重新审核 ' + file)
    return content


def output_bytes(path, body):
    with path.open('xb') as stream:
        stream.write(body)


def output_text(path, body):
    output_bytes(path, body.encode('utf-8'))


def output_json(path, value):
    output_text(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def dollar(value, tag):
    delimiter = '$' + tag + '$'
    need(delimiter not in value, 'SQL 传输分隔符冲突；原文未改写')
    return delimiter + value + delimiter


def edit(text, old, new, count=1):
    need(text.count(old) == count, '依赖 SQL 边界发生变化，请重新审查')
    return text.replace(old, new)


def sql_block(sql, tag):
    return ' EXECUTE ' + dollar('\n' + sql + '\n', tag) + ';\n'


def profile(shop):
    need(shop in SHOPS, '只允许已核准的技嘉、乔思伯扩店')
    return shop + '_live', shop + '_access', shop + '_import', f'diy_api_{shop}_production'


def protect_template(text, shop):
    live, access, receiving, role = profile(shop)
    for token, value in [('__LIVE__', live), ('__ACCESS__', access), ('__IMPORT__', receiving), ('__SHOP__', shop), ('__ROLE__', role)]:
        text = text.replace(token, value)
    return text


def contains_secret(node):
    if isinstance(node, dict):
        return any(SECRET_KEY.fullmatch(key) or contains_secret(value) for key, value in node.items())
    if isinstance(node, list):
        return any(map(contains_secret, node))
    return False


def image_references(node):
    if isinstance(node, str) and node.startswith('/uploads/'):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from image_references(value)
    elif isinstance(node, list):
        for value in node:
            yield from image_references(value)


def source_references(node):
    if isinstance(node, dict):
        if isinstance(node.get('sourceId'), str) and node['sourceId']:
            yield node['sourceId']
        for value in node.values():
            yield from source_references(value)
    elif isinstance(node, list):
        for value in node:
            yield from source_references(value)


def snapshot_data(snapshot, shop):
    profile(shop)
    info = read_json(snapshot / 'manifest.json')
    revision = str(info['source_revision'])
    need(info['shop_id'] == shop and re.fullmatch(r'\d+', revision, re.ASCII) and
         re.fullmatch(rf'{shop}-{revision}-[0-9a-f]{{16}}', info['batch_id']), '店铺或源修订合同不匹配')
    raw = (snapshot / 'records.jsonl').read_bytes()
    rows = [json.loads(line) for line in raw.splitlines()]
    need(sha256(raw) == info['records_sha256'] and len(rows) == info['records_count'], '冻结业务原文摘要或数量不匹配')
    active, archived, source_ids = {}, set(), set()
    keys, all_images, all_sources = set(), set(), set()
    for row in rows:
        kind, identity, owner, shared, doc = (row[k] for k in ('kind', 'id', 'owner', 'shared', 'document'))
        need(kind in SNAPSHOT_KINDS and isinstance(identity, str) and bool(identity) and (kind, identity) not in keys and
             isinstance(doc, dict) and not contains_secret(doc) and type(shared) is bool and
             sha256(canonical(doc)) == row['sha256'], '出现未知、重复、摘要异常或含认证字段的原文记录')
        keys.add((kind, identity))
        if kind in {'shop', 'settings', 'configuration', 'archived_configuration', 'template'}:
            need(owner == shop and not shared, '店铺私有业务出现跨店归属')
            if kind in {'shop', 'settings'}:
                need(identity == shop and (kind != 'shop' or doc.get('id') == shop), '店铺主档身份不符')
            else:
                need(doc.get('shopId') == shop and doc.get('id') == identity, '业务文档明示店铺或标识不符')
            if kind == 'configuration':
                need(not doc.get('deletedAt'), '应归档的配置进入了活跃范围')
                active[identity] = doc
            if kind == 'archived_configuration':
                need(bool(doc.get('deletedAt')), '归档记录缺少删除时间')
                archived.add(identity)
        else:
            need(owner in {*SHOPS, 'intel', 'shared', 'unassigned'} and (owner == shop or shared),
                 '跨店或无归属目录必须是已审阅的只读副本')
            field = {'source': 'sourceId', 'cost': 'goodsId', 'gallery': 'id'}[kind]
            need(doc.get(field) == identity, '目录业务标识不符')
            if kind == 'source':
                need((doc.get('shopId') or 'unassigned') == owner, '目录实体与冻结归属矛盾')
                source_ids.add(identity)
        # 旧软删除只进入私有接收区；它们不假定尚能使用历史依赖或图片。
        if kind != 'archived_configuration':
            all_images.update(image_references(doc))
            if kind in {'configuration', 'template', 'source'}:
                all_sources.update(source_references(doc))
    need(bool(active) and not (archived & active.keys()) and {(k, shop) for k in ('shop', 'settings')} <= keys,
         '无可用店铺数据，或同一配置混入活跃和归档')
    # 编辑文档的原料和图片外键失败要在生成前报告；不凭空补记录。
    need(all_sources <= source_ids, f'{shop} 有 {len(all_sources - source_ids)} 项活跃来源引用未闭合')
    assets = read_json(snapshot / 'assets.json')
    need(sha256(canonical(assets)) == info['assets_sha256'], '原图索引摘要不匹配')
    asset_ids = set()
    for asset in assets:
        match = re.fullmatch(ASSET, asset['uri'])
        need(match is not None and asset['uri'] not in asset_ids and asset['file'] == 'assets/' + asset['sha256'] and
             set(asset) == {'uri', 'sha256', 'file', 'size'}, '原图不满足唯一路径合同')
        path = (snapshot / asset['file']).resolve()
        need(path.is_relative_to(snapshot.resolve()) and path.is_file(), '原图不存在或路径越界')
        data = path.read_bytes()
        need(asset['size'] > 0 and len(data) == asset['size'] and sha256(data) == asset['sha256'],
             '原图字节或摘要不匹配')
        asset_ids.add(asset['uri'])
        rows.append(dict(kind='asset', id=asset['uri'], owner='shared', shared=True, document=asset))
    need(asset_ids == all_images, f'{shop} 原图索引与业务引用不完全一致')
    prices = read_json(snapshot / 'workbook-prices.json')
    source, workbook, sheet = (prices[k] for k in ('source', 'workbook_sha256', 'sheet'))
    absent = source == 'missing_verified_maintenance_workbook'
    need((absent and workbook is None and sheet is None) or
         (not absent and isinstance(source, str) and bool(source) and isinstance(workbook, str) and
          re.fullmatch(SHA256, workbook) and isinstance(sheet, str) and bool(sheet)), '维护表证据未通过格式核验')
    quoted = set()
    for price in prices['configurations']:
        cid = price['configuration_id']
        need(cid in active and cid not in quoted, '报价引用未知、归档或重复配置')
        quoted.add(cid)
        check = {'configuration_id', 'status', 'amount_cents', 'workbench_price_cents', 'difference_cents', 'workbook_rows'}
        need(set(price) == check and isinstance(price['workbook_rows'], list) and
             all(type(row) is int and 0 < row <= 1048576 for row in price['workbook_rows']) and
             len(set(price['workbook_rows'])) == len(price['workbook_rows']), '报价核对记录不符合合同')
        found = price['status'] == 'matched'
        for key in ('amount_cents', 'workbench_price_cents', 'difference_cents'):
            num = price[key]
            need(num is None or (isinstance(num, str) and re.fullmatch(r'0|-?[1-9][0-9]{0,17}', num) and
                  (key == 'difference_cents' or not num.startswith('-'))), '报价金额不是精确整数分')
        need((found and not absent and bool(active[cid].get('spu')) and bool(active[cid].get('skuId')) and
              price['amount_cents'] is not None and bool(price['workbook_rows'])) or
             (price['status'] == 'unmatched' and price['amount_cents'] is None and price['difference_cents'] is None and
              not price['workbook_rows']), '缺少有效证据的配置不能生成对外价')
        rows.append(dict(kind='quotation', id=cid, owner=shop, shared=False,
                         document={**price, 'workbook_sha256': workbook, 'sheet': sheet, 'source': source}))
    need(quoted == set(active), '所有活跃配置必须明确标记已核对报价或缺价')
    payload = []
    for row in sorted(rows, key=lambda row: (row['kind'], row['id'])):
        document = canonical(row['document'])
        payload.append({**{key: row[key] for key in ('kind', 'id', 'owner', 'shared')},
                        'document_json': document.decode('utf-8'), 'sha256': sha256(document)})
    payload_body = canonical(payload)
    digest = sha256(payload_body)
    # 只转存运行所需的证据字段，本地路径、碰撞审阅及缺货信息留在私有快照。
    manifest = dict(shop_id=shop, source_revision=int(revision), batch_id=info['batch_id'] + '-' + digest[:8],
                    records_sha256=info['records_sha256'], assets_sha256=info['assets_sha256'],
                    counts=dict(Counter(row['kind'] for row in rows)), receiving_records_count=len(rows),
                    payload_sha256=digest, workbook_sha256=workbook, target_database=DB, workbook_source=source)
    return payload_body.decode('utf-8'), manifest


def intel_guard():
    return f""" IF to_regclass('intel_live.bootstrap') IS NULL OR to_regclass('nas_import.batches') IS NULL
 THEN RAISE EXCEPTION '找不到已核对的英特尔正式 r8151；未修改数据库'; END IF;
 IF NOT EXISTS(SELECT FROM intel_live.bootstrap b JOIN nas_import.batches i USING(batch_id)
     WHERE b.shop_id='intel' AND b.batch_id='{INTEL_BATCH}' AND b.payload_sha256='{INTEL_DIGEST}'
       AND i.payload_sha256=b.payload_sha256 AND i.manifest->>'shop_id'='intel' AND i.manifest->>'source_revision'='8151')
 THEN RAISE EXCEPTION '找不到已核对的英特尔正式 r8151；未修改数据库'; END IF;
"""


def operation_header(lock):
    return f""" IF current_database()<>'{DB}' THEN RAISE EXCEPTION '只允许正式库 diy_workbench'; END IF;
 IF current_setting('standard_conforming_strings')<>'on' THEN RAISE EXCEPTION '连接必须使用标准字符串模式'; END IF;
 PERFORM pg_advisory_xact_lock(814517,{lock});
""" + intel_guard()


def scope_runtime(shop):
    live, _, receiving, _ = profile(shop)
    runtime = read_sql('003-intel-live.sql')
    runtime = edit(runtime, '-- 仅在试验库执行这条完整 DO。建表、初始化和核对同事务；样本与导入原文不改动。',
                   '-- 新店运行结构由已固定的接收批次初始化；归档只在接收区保留。')
    runtime = edit(runtime, "'diy_workbench_trial' THEN RAISE EXCEPTION '运行结构只允许试验库'",
                   "'diy_workbench' THEN RAISE EXCEPTION '运行结构只允许正式库'")
    runtime = edit(runtime, "PERFORM pg_advisory_xact_lock(814517,2);", f"PERFORM pg_advisory_xact_lock(814517,{22+SHOPS.index(shop)});")
    runtime = edit(runtime, "('shop','settings','source','cost','asset','gallery','template','configuration','quotation')",
                   "('shop','settings','source','cost','asset','gallery','template','configuration','quotation','archived_configuration')")
    runtime = edit(runtime, "workbench_price_cents bigint NOT NULL CHECK(workbench_price_cents>=0)",
                   "workbench_price_cents bigint CHECK(workbench_price_cents>=0)")
    runtime = edit(runtime, "workbook_sha256 text NOT NULL CHECK(workbook_sha256 ~ '^[0-9a-f]{64}$'), source text NOT NULL, sheet text NOT NULL,",
                   "workbook_sha256 text CHECK(workbook_sha256 ~ '^[0-9a-f]{64}$'), source text NOT NULL, sheet text,")
    runtime = edit(runtime, "CHECK ((status='matched')=(amount_cents IS NOT NULL))",
                   """CHECK ((status='matched')=(amount_cents IS NOT NULL)),
 CHECK ((source='missing_verified_maintenance_workbook' AND workbook_sha256 IS NULL AND sheet IS NULL AND status='unmatched')
   OR (source<>'missing_verified_maintenance_workbook' AND workbook_sha256 IS NOT NULL AND sheet IS NOT NULL))""")
    # 两个新店保留同一已验证的回组规则；仅替换显式存在的店铺、接收和运行边界。
    runtime = runtime.replace('intel_live', live).replace('nas_import', receiving).replace("'intel'", quote(shop))
    return runtime.replace('英特尔', {'gigabyte': '技嘉', 'jonsbo': '乔思伯'}[shop])


def binding(manifest):
    shop = manifest['shop_id']
    live, _, receive, _ = profile(shop)
    batch, digest, count = manifest['batch_id'], manifest['payload_sha256'], manifest['receiving_records_count']
    need(manifest['target_database'] == DB and re.fullmatch(rf'{shop}-[0-9]+-[0-9a-f]{{16}}-[0-9a-f]{{8}}', batch) and
         re.fullmatch(SHA256, digest) and type(count) is int and count > 0 and batch.endswith(digest[:8]), '批次授权清单不符')
    return f""" IF NOT EXISTS(SELECT FROM {live}.bootstrap b JOIN {receive}.batches a USING(batch_id)
  WHERE b.shop_id='{shop}' AND b.batch_id='{batch}' AND b.payload_sha256='{digest}'
    AND a.payload_sha256=b.payload_sha256 AND a.record_count={count} AND a.manifest->>'shop_id'='{shop}')
    OR (SELECT count(*) FROM {receive}.records WHERE batch_id='{batch}')<>{count}
    OR EXISTS(SELECT FROM {receive}.records WHERE batch_id='{batch}' AND md5(document::text)<>stored_md5)
 THEN RAISE EXCEPTION '{shop} 的冻结批次不匹配'; END IF;
"""


def build_data(snapshot, shop, output):
    payload, manifest = snapshot_data(snapshot, shop)
    live, access, receiving, role = profile(shop)
    tag = manifest['payload_sha256'][:16]
    receiver = f"""-- 在正式库以完整一条 DO 执行。任何错误均取消本店接收和初始化。
-- 目标中已有任何对象时拒绝重跑；先用对应只读 SQL 回读状态。
DO $add_{shop}_snapshot$
DECLARE
 payload_text text := {dollar(payload, 'payload_' + tag)};
 manifest_value jsonb := {dollar(canonical(manifest).decode('utf-8'), 'manifest_' + tag)}::jsonb;
 payload jsonb;
BEGIN
{operation_header(20)}
 IF to_regnamespace('{receiving}') IS NOT NULL OR to_regnamespace('{live}') IS NOT NULL OR
    to_regnamespace('{access}') IS NOT NULL OR to_regrole('{role}') IS NOT NULL
 THEN RAISE EXCEPTION '店铺接收区、运行区或角色已存在；未替换，先执行只读核对'; END IF;
 IF encode(sha256(convert_to(payload_text,'UTF8')),'hex') IS DISTINCT FROM manifest_value->>'payload_sha256'
 THEN RAISE EXCEPTION '传输摘要不一致'; END IF;
 payload := payload_text::jsonb;
 IF jsonb_typeof(payload)<>'array' OR jsonb_array_length(payload)<>{manifest['receiving_records_count']} OR
    EXISTS(SELECT FROM jsonb_array_elements(payload) x WHERE
      encode(sha256(convert_to(x->>'document_json','UTF8')),'hex') IS DISTINCT FROM x->>'sha256')
 THEN RAISE EXCEPTION '传输记录数量或独立摘要不一致'; END IF;
 CREATE SCHEMA {receiving};
 REVOKE ALL ON SCHEMA {receiving} FROM PUBLIC;
 CREATE TABLE {receiving}.batches(
  batch_id text PRIMARY KEY CHECK(batch_id='{manifest['batch_id']}'), manifest jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256='{manifest['payload_sha256']}'),
  record_count integer NOT NULL CHECK(record_count={manifest['receiving_records_count']}),
  imported_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE {receiving}.records(
  batch_id text NOT NULL REFERENCES {receiving}.batches, kind text NOT NULL, record_id text NOT NULL,
  owner_shop text NOT NULL, shared boolean NOT NULL, document jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK(length(source_sha256)=64), stored_md5 text NOT NULL,
  CHECK(owner_shop='{shop}' OR shared),
  PRIMARY KEY(batch_id,kind,record_id)
 );
 REVOKE ALL ON ALL TABLES IN SCHEMA {receiving} FROM PUBLIC;
 COMMENT ON SCHEMA {receiving} IS '仅管理员审计冻结原文；包括旧软删除，服务账号不读此区';
 INSERT INTO {receiving}.batches(batch_id,manifest,payload_sha256,record_count)
  VALUES(manifest_value->>'batch_id',manifest_value,manifest_value->>'payload_sha256',jsonb_array_length(payload));
 INSERT INTO {receiving}.records
 SELECT manifest_value->>'batch_id',x->>'kind',x->>'id',x->>'owner',(x->>'shared')::boolean,
  (x->>'document_json')::jsonb,x->>'sha256',md5(((x->>'document_json')::jsonb)::text)
 FROM jsonb_array_elements(payload) x;
"""
    receiver += sql_block(scope_runtime(shop), 'store_runtime_' + tag)
    receiver += binding(manifest) + f"END $add_{shop}_snapshot$;\n"
    output.mkdir(parents=True, exist_ok=False)
    output_text(output / f'02-{shop}-import.sql', receiver)
    manifest['import_sql_sha256'] = sha256(receiver.encode('utf-8'))
    output_json(output / 'manifest.json', manifest)
    output_text(output / f'03-{shop}-readback.sql', store_readback(manifest))
    return manifest


def store_readback(manifest):
    binding(manifest)
    shop, batch = (manifest[k] for k in ('shop_id', 'batch_id'))
    live, _, receiving, _ = profile(shop)
    return f"""-- 正式库只读核对：先核批次及各类摘要，再核运行区；运营后配置深等差异可正常增加。
SELECT current_database() database_name,b.batch_id,b.payload_sha256,b.record_count,b.manifest->'counts' expected_by_kind,
 (SELECT jsonb_object_agg(kind,n) FROM (SELECT kind,count(*) n FROM {receiving}.records GROUP BY kind) r) actual_by_kind,
 (SELECT count(*) FROM {receiving}.records WHERE stored_md5<>md5(document::text)) receiving_changed,
 (SELECT count(*) FROM {live}.configurations WHERE shop_id='{shop}' AND archived_at IS NULL) active,
 (SELECT count(*) FROM {receiving}.records WHERE kind='archived_configuration') archived_in_receiving,
 (SELECT count(*) FROM {receiving}.records r LEFT JOIN {live}.configuration_documents c ON c.configuration_id=r.record_id
  WHERE r.batch_id=b.batch_id AND r.kind='configuration' AND c.document IS DISTINCT FROM r.document) runtime_document_mismatch,
 (SELECT count(*) FROM {live}.configurations WHERE version<>1) changed_after_import,
 (SELECT count(*) FROM {live}.configurations WHERE sku='' AND archived_at IS NULL) missing_sku,
 (SELECT count(*) FROM {live}.configurations WHERE spu='' AND archived_at IS NULL) missing_spu,
 (SELECT count(*) FROM {live}.sources) sources,(SELECT count(*) FROM {live}.gallery) gallery,
 (SELECT count(*) FROM {live}.costs) costs,(SELECT count(*) FROM {live}.assets) assets,
 (SELECT count(*) FROM {live}.quotations WHERE status='matched') matched_quotes,
 (SELECT count(*) FROM {live}.quotations WHERE status='unmatched') unmatched_quotes,
 (SELECT count(*) FROM {live}.publications WHERE published) published
FROM {receiving}.batches b JOIN {live}.bootstrap l USING(batch_id)
WHERE b.batch_id='{batch}' AND b.payload_sha256='{manifest['payload_sha256']}'
 AND l.payload_sha256=b.payload_sha256 AND l.shop_id='{shop}';
"""

def scoped_permissions(file, shop, password):
    live, access, _, role = profile(shop)
    original = read_sql(file)
    # 009/010/011 原本也支持试验；本轮固定使用新店正式登录角色，不能意外回落试验。
    if file[:3] in {'009', '010', '011'}:
        selector = r" runtime_role:=CASE current_database\(\).*? END;"
        need(len(re.findall(selector, original, flags=re.S)) == 1, '历史权限的目标选择发生变化')
        original = re.sub(selector,
                          f" IF current_database()<>'{DB}' THEN RAISE EXCEPTION '只允许正式库'; END IF;\n runtime_role:='{role}';",
                          original, flags=re.S)
        original = original.replace('英特尔正式库或试验库', '本店正式库')
    else:
        need('diy_workbench_trial' in original and 'diy_api_operations' in original, '权限模板边界发生变化')
        original = original.replace('diy_workbench_trial', DB).replace('diy_api_operations', role).replace('试验库', '正式库')
    if file[:3] == '004':
        original = edit(original, "runtime_password text := '__SET_RANDOM_PASSWORD__';",
                        'runtime_password text := ' + quote(password) + ';')
        original = edit(original, 'LOGIN NOSUPERUSER', 'LOGIN NOINHERIT NOSUPERUSER')
    if file[:3] == '010':
        original = edit(original, 'hashtextextended(ws,814569)', f"hashtextextended('{shop}:'||ws,814569)")
    if file[:3] == '011':
        # 成本历史的 before/after 由服务从快照产生，防止关联到其他店或未知配置。
        original = edit(original, "OR length(args->>'message')>100", """OR length(args->>'message')>100
     OR EXISTS(SELECT FROM jsonb_array_elements(args->'configs') x
      WHERE x->'before'->>'shopId' IS DISTINCT FROM 'intel'
        OR x->'after'->>'shopId' IS DISTINCT FROM 'intel'
        OR x->'before'->>'id' IS DISTINCT FROM x->'after'->>'id'
        OR NOT EXISTS(SELECT FROM intel_live.configurations c
         WHERE c.shop_id='intel' AND c.configuration_id=x->'after'->>'id'))""")
    # 模板的商品、历史及覆盖均沿用同一张本店表；英特尔前缀的三个覆盖表名保留兼容。
    original = original.replace('intel_live', live).replace('nas_business', access).replace("'intel'", quote(shop))
    original = original.replace('英特尔', {'gigabyte': '技嘉', 'jonsbo': '乔思伯'}[shop])
    # 本地写模式只读有效成员视图；没有对视图的外键，用组基础表的真实成员统一处理停用。
    if file[:3] == '006':
        original = edit(original, f'FOREIGN KEY(workspace_id,uid) REFERENCES {access}.members',
                        'FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members')
    # 旧脚本间的锁只用于安装；新店独立使用固定锁，不与英特尔的既有迁移相混。
    original = re.sub(r'pg_advisory_xact_lock\(814517,[3-7]\)',
                      f'pg_advisory_xact_lock(814517,{24+SHOPS.index(shop)})', original)
    return original


def read_roster(path):
    roster = read_json(path)
    need(set(roster) == {'workspace_id', 'group_code', 'members'} and
         roster['workspace_id'] == 'workbench-main' and roster['group_code'] == 'dou-intel-operations' and
         isinstance(roster['members'], list) and 0 < len(roster['members']) <= 1000, '须提供完整且非空的核准运营组名单')
    ids = set()
    for member in roster['members']:
        need(set(member) == {'uid', 'existing_database_member', 'verified_existing_cloudbase'} and
             isinstance(member['uid'], str) and re.fullmatch(UID, member['uid']) and
             member['uid'] not in ids and member['existing_database_member'] in {'enabled', 'absent'} and
             member['verified_existing_cloudbase'] is True, '成员身份未验证、被停用、待确认或重复')
        ids.add(member['uid'])
    return roster['members']


def membership_install(members):
    values = ',\n  '.join(f"({quote(row['uid'])},{quote(row['existing_database_member'])})" for row in members)
    checked = """ -- 冻结核过的原成员状态；禁用或身份竞争时整条撤回。不会为任何现有成员开通或改角色。
 LOCK TABLE nas_business.members IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT FROM pg_temp.approved_roster x LEFT JOIN nas_business.members m ON m.workspace_id='workbench-main' AND m.uid=x.uid
   WHERE (x.expected='enabled' AND m.enabled IS DISTINCT FROM true) OR (x.expected='absent' AND m.uid IS NOT NULL))
 THEN RAISE EXCEPTION '已核准成员的现有状态发生变化；未覆盖原成员权限'; END IF;
 INSERT INTO nas_business.members(workspace_id,uid,enabled)
  SELECT 'workbench-main',uid,true FROM pg_temp.approved_roster WHERE expected='absent';
 INSERT INTO nas_business.operation_group_members(workspace_id,group_code,uid)
  SELECT 'workbench-main','dou-intel-operations',uid FROM pg_temp.approved_roster;
"""
    return f""" -- 名单仅用于此事务，完整 SQL 不得提交或共享。
 CREATE TEMP TABLE approved_roster(uid text PRIMARY KEY, expected text NOT NULL) ON COMMIT DROP;
 INSERT INTO pg_temp.approved_roster VALUES
  {values};
""" + checked


def expected_intel_owner():
    return """ -- 只有原函数所有者可安装扩店授权，确保不变更现用函数的所有者或隐式依赖。
 IF to_regrole('diy_api_intel_production') IS NULL
    OR to_regclass('nas_business.members') IS NULL OR to_regclass('nas_business.shop_roles') IS NULL
    OR to_regprocedure('intel_live.catalog_is_operator()') IS NULL
    OR NOT EXISTS(SELECT FROM pg_proc p JOIN pg_roles r ON p.proowner=r.oid
      WHERE p.oid=to_regprocedure('intel_live.catalog_is_operator()') AND r.rolname=current_user
       AND p.provolatile='s' AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
       AND strpos(p.prosrc,'FROM nas_business.members m JOIN nas_business.shop_roles r')>0)
    OR NOT EXISTS(SELECT FROM pg_proc p JOIN pg_roles r ON p.proowner=r.oid
      WHERE p.oid=to_regprocedure('intel_live.set_quotation_publication(text,boolean)') AND r.rolname=current_user
        AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
        AND strpos(p.prosrc,'INSERT INTO intel_live.publications(configuration_id,published)')>0)
    OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='intel_live' AND p.proname IN ('operations_activity','operations_activity_page','profit_observe','operations_price_history','set_quotation_publication')
       AND r.rolname<>current_user AND NOT r.rolsuper)
 THEN RAISE EXCEPTION '英特尔正式授权结构或函数所有者不符合已核对状态；未替换'; END IF;
"""


def make_access(manifests, roster_path, password_paths, output):
    members = read_roster(roster_path)
    manifests = {shop: read_json(manifests[shop]) for shop in SHOPS}
    passwords = {shop: password_paths[shop].read_text(encoding='utf-8-sig').strip() for shop in SHOPS}
    need(len(set(passwords.values())) == len(SHOPS) and
         all(re.fullmatch(PASSWORD, pwd) for pwd in passwords.values()), '新店登录须为各自独立的私有随机密码')
    install = """-- 正式三店运营组及两新店受限账号。私有 SQL 含数据库凭据与已核准 UID。
-- 先核对两个批次；执行本文件完整一条 DO。重复执行或状态不清立即撤回，不刷新密码。
DO $install_three_operations$
BEGIN
""" + operation_header(20) + expected_intel_owner()
    install += """ IF to_regnamespace('intel_access') IS NOT NULL OR to_regclass('nas_business.operation_groups') IS NOT NULL
    OR to_regclass('nas_business.operation_group_members') IS NOT NULL OR to_regclass('nas_business.operation_group_shops') IS NOT NULL
    OR to_regclass('nas_business.group_shop_roles') IS NOT NULL
 THEN RAISE EXCEPTION '正式组授权结构已存在；未替换'; END IF;
"""
    for shop in SHOPS:
        manifest = manifests[shop]
        need(manifest['shop_id'] == shop, '正式权限必须绑定对应店铺的核对清单')
        live, access, receiving, role = profile(shop)
        install += f""" IF to_regnamespace('{access}') IS NOT NULL OR to_regrole('{role}') IS NOT NULL THEN
  RAISE EXCEPTION '目标店铺已有角色或授权结构；未替换';
 END IF;
 IF to_regclass('{live}.bootstrap') IS NULL OR to_regclass('{receiving}.batches') IS NULL THEN
  RAISE EXCEPTION '请先回读该店数据批次及摘要';
 END IF;
""" + binding(manifest)
    install += sql_block(read_sql('012-production-operation-groups.template.sql'), 'new_group_structure')
    install += membership_install(members)
    for shop in SHOPS:
        live, _, _, role = profile(shop)
        install += sql_block(protect_template(read_sql('013-production-store-access.template.sql'), shop), shop + '_access_structure')
        for file in FILES:
            install += sql_block(scoped_permissions(file, shop, passwords[shop]), shop + '_install_' + file[:3])
        install += sql_block(protect_template(read_sql('014-production-store-write-guards.template.sql'), shop), shop + '_write_guards')
        install += f""" IF EXISTS(SELECT FROM {live}.publications WHERE published)
    OR EXISTS(SELECT FROM {live}.catalog_shared_editors)
    OR has_schema_privilege('{role}','intel_live','USAGE')
    OR has_schema_privilege('{role}','nas_import','USAGE')
    OR has_schema_privilege('{role}','{shop}_import','USAGE')
    OR has_table_privilege('{role}','nas_business.members','SELECT')
    OR has_table_privilege('{role}','nas_business.operation_group_members','INSERT')
 THEN RAISE EXCEPTION '新店初始发布、跨店隔离或成员边界不一致'; END IF;
"""
    install += f""" IF (SELECT count(*) FROM nas_business.operation_group_members WHERE workspace_id='workbench-main' AND group_code='dou-intel-operations')<>{len(members)}
    OR (SELECT count(*) FROM nas_business.operation_group_shops WHERE workspace_id='workbench-main' AND group_code='dou-intel-operations')<>3
    OR EXISTS(SELECT FROM pg_temp.approved_roster x WHERE
     NOT EXISTS(SELECT FROM intel_access.shop_roles r WHERE r.uid=x.uid AND r.workspace_id='workbench-main' AND r.role='operations')
     OR NOT EXISTS(SELECT FROM gigabyte_access.shop_roles r WHERE r.uid=x.uid AND r.workspace_id='workbench-main' AND r.role='operations')
     OR NOT EXISTS(SELECT FROM jonsbo_access.shop_roles r WHERE r.uid=x.uid AND r.workspace_id='workbench-main' AND r.role='operations'))
    OR has_schema_privilege('diy_api_intel_production','gigabyte_live','USAGE')
    OR has_schema_privilege('diy_api_intel_production','jonsbo_live','USAGE')
    OR has_schema_privilege('diy_api_gigabyte_production','jonsbo_live','USAGE')
    OR has_schema_privilege('diy_api_jonsbo_production','gigabyte_live','USAGE')
 THEN RAISE EXCEPTION '核准名单的生效范围或运行账号隔离不一致'; END IF;
END $install_three_operations$;
"""
    output.mkdir(parents=True, exist_ok=False)
    output_text(output / '04-install-three-operations-private.sql', install)
    output_text(output / '05-operations-readback.sql', access_readback(len(members)))
    summary = dict(status='prepared_not_executed', group='抖英特运营组', expected_members=len(members),
                   install_sha256=sha256(install.encode('utf-8')),
                   batches={shop: manifest['batch_id'] for shop, manifest in manifests.items()})
    output_json(output / 'manifest.json', summary)
    return summary


def access_readback(expected_members):
    base = f"""-- 只读核对正式授权；输出成员数量与权限边界，不返回 UID、账号和凭据。
WITH group_summary AS (
 SELECT g.display_name,g.workspace_id,g.group_code,
  (SELECT count(*) FROM nas_business.operation_group_members m WHERE m.workspace_id=g.workspace_id AND m.group_code=g.group_code) enrolled_members,
  (SELECT count(*) FROM nas_business.operation_group_members m JOIN nas_business.members a USING(workspace_id,uid)
   WHERE m.workspace_id=g.workspace_id AND m.group_code=g.group_code AND a.enabled) enabled_members
 FROM nas_business.operation_groups g WHERE g.group_code='dou-intel-operations' AND g.workspace_id='workbench-main'
),
runtime AS (
 SELECT s.*,r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS restricted_login
 FROM (VALUES ('intel','intel_live','intel_access','nas_import','diy_api_intel_production'),
              ('gigabyte','gigabyte_live','gigabyte_access','gigabyte_import','diy_api_gigabyte_production'),
              ('jonsbo','jonsbo_live','jonsbo_access','jonsbo_import','diy_api_jonsbo_production'))
  s(shop_id,live_schema,access_schema,receiving_schema,login_role)
 JOIN pg_roles r ON r.rolname=s.login_role
),
group_roles AS (
 SELECT m.shop_id,count(*) operators FROM nas_business.group_shop_roles m
 WHERE m.workspace_id='workbench-main' AND m.role='operations' GROUP BY m.shop_id
),
store_runtime AS (
 SELECT n.shop_id,n.restricted_login,has_schema_privilege(n.login_role,n.live_schema,'USAGE') own_live,
  has_schema_privilege(n.login_role,n.access_schema,'USAGE') own_access,
  has_table_privilege(n.login_role,n.access_schema||'.shop_roles','SELECT') effective_roles_read,
  NOT has_table_privilege(n.login_role,n.access_schema||'.shop_roles','INSERT,UPDATE,DELETE') effective_roles_read_only,
  (SELECT count(*) FROM runtime other WHERE other.shop_id<>n.shop_id AND (
    has_schema_privilege(n.login_role,other.live_schema,'USAGE')
    OR has_schema_privilege(n.login_role,other.access_schema,'USAGE'))) other_store_schemas,
  (SELECT count(*) FROM runtime other WHERE has_schema_privilege(n.login_role,other.receiving_schema,'USAGE')) receiving_schemas,
  has_table_privilege(n.login_role,'nas_business.operation_group_members','INSERT,UPDATE,DELETE') may_change_group,
  has_table_privilege(n.login_role,'nas_business.members','INSERT,UPDATE,DELETE') may_change_members,
  has_function_privilege(n.login_role,n.live_schema||'.operations_activity_page(date,date,integer,integer)','EXECUTE') activity,
  has_function_privilege(n.login_role,n.live_schema||'.profit_observe(text,jsonb)','EXECUTE') profit_history,
  has_function_privilege(n.login_role,n.live_schema||'.operations_price_history(text,jsonb)','EXECUTE') price_history
 FROM runtime n
)
SELECT current_database() database_name,g.display_name,g.enrolled_members,g.enabled_members,{expected_members} expected_members,
 (SELECT count(*) FROM nas_business.operation_group_shops a WHERE a.workspace_id=g.workspace_id AND a.group_code=g.group_code) assigned_shops,
 (SELECT jsonb_object_agg(shop_id,operators) FROM group_roles) group_operators_by_shop,
 (SELECT count(*) FROM nas_business.shop_roles a WHERE a.shop_id='intel') legacy_intel_role_rows,
 (SELECT count(*) FROM intel_live.catalog_shared_editors) legacy_intel_delegate_rows,
 (SELECT count(*) FROM gigabyte_live.catalog_shared_editors) gigabyte_delegate_rows,
 (SELECT count(*) FROM jonsbo_live.catalog_shared_editors) jonsbo_delegate_rows,
 (SELECT count(*) FROM gigabyte_live.publications WHERE published) gigabyte_published,
 (SELECT count(*) FROM jonsbo_live.publications WHERE published) jonsbo_published,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY shop_id) FROM store_runtime r) isolation
FROM group_summary g;
"""
    return base


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    data = sub.add_parser('data')
    data.add_argument('--shop', choices=SHOPS, required=True)
    data.add_argument('--snapshot', type=Path, required=True)
    data.add_argument('--output', type=Path, required=True)
    access = sub.add_parser('access')
    for shop in SHOPS:
        access.add_argument(f'--{shop}-manifest', type=Path, required=True)
        access.add_argument(f'--{shop}-password-file', type=Path, required=True)
    access.add_argument('--roster-file', type=Path, required=True)
    access.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'data':
        summary = build_data(args.snapshot, args.shop, args.output)
    else:
        summary = make_access({shop: getattr(args, shop + '_manifest') for shop in SHOPS}, args.roster_file,
                              {shop: getattr(args, shop + '_password_file') for shop in SHOPS}, args.output)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
