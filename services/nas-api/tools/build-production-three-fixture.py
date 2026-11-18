"""构造测试专用三店数据；不读取正式数据、不接数据库、凭据是固定合成字符。"""
import argparse
from base64 import b64decode
import importlib.util
from pathlib import Path

from export_intel_support import canonical, sha256


spec = importlib.util.spec_from_file_location('three', Path(__file__).with_name('build-production-three.py'))
three = importlib.util.module_from_spec(spec)
spec.loader.exec_module(three)

EXISTING = 'fixture_existing01'
APPROVED = 'fixture_verified02'
LEGACY = 'fixture_legacy03'
DISABLED = 'fixture_disabled04'
COLLISION = 'fixture-overlap'


def docs(shop):
    # 两店刻意复用配置、来源和图库 ID；展示内容与归属应始终由本店快照决定。
    config = dict(id=COLLISION, shopId=shop, productId='fixture-link', name=f'{shop} 商品',
                  skuId='12345', spu='98765', workspaceOrder=1, price=2800,
                  parts=[dict(lineId='fixture-line', slot='CPU', goodsId='100001', qty=1,
                              name=f'{shop} CPU', sourceId='fixture-local')],
                  actualParts=[], addons=[], modules=[])
    archived = {**config, 'id': 'fixture-archived', 'deletedAt': '2026-11-01T00:00:00.000Z'}
    source = dict(sourceId='fixture-local', shopId=shop, goodsId='100001', name=f'{shop} 来源')
    copied_source = dict(sourceId='fixture-shared', shopId='intel', goodsId='100002', name='已核对跨店副本')
    gallery_file = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNggAAAABYAAH5S9zoAAAAASUVORK5CYII=') + shop.encode()
    digest = sha256(gallery_file)
    uri = f'/uploads/{digest}.png'
    gallery = dict(id='fixture-gallery', url=uri, name='外观档案', brand='测试', model='M', color='', edition='')
    template = dict(id='fixture-template', shopId=shop, name='模板', configs=[config])
    price = dict(configuration_id=COLLISION, status='unmatched', amount_cents=None,
                 workbench_price_cents='280000', difference_cents=None, workbook_rows=[])
    records = [
        ('shop', shop, shop, False, {'id': shop, 'name': shop}),
        ('settings', shop, shop, False, {}),
        ('configuration', COLLISION, shop, False, config),
        ('source', 'fixture-local', shop, False, source),
        ('source', 'fixture-shared', 'intel', True, copied_source),
        ('gallery', 'fixture-gallery', shop, False, gallery),
        ('cost', '100001', 'shared', True, {'goodsId': '100001', 'erp': 12, 'tax': 13}),
        ('template', 'fixture-template', shop, False, template),
    ]
    asset = dict(uri=uri, sha256=digest, file='assets/'+digest, size=len(gallery_file))
    return records, archived, asset, gallery_file, price


def snapshot(path, shop):
    records, archived, asset, body, price = docs(shop)
    records.append(('archived_configuration', archived['id'], shop, False, archived))
    rows = [dict(kind=k, id=i, owner=o, shared=s, document=d, sha256=sha256(canonical(d))) for k, i, o, s, d in records]
    raw = b''.join(canonical(row)+b'\n' for row in rows)
    sha = sha256(raw)
    path.mkdir(parents=True, exist_ok=False)
    (path/'assets').mkdir()
    three.output_bytes(path/asset['file'], body)
    three.output_bytes(path/'records.jsonl', raw)
    three.output_json(path/'assets.json', [asset])
    three.output_json(path/'workbook-prices.json', dict(source='missing_verified_maintenance_workbook',
                          configurations=[price], workbook_sha256=None, sheet=None))
    three.output_json(path/'manifest.json', dict(shop_id=shop, source_revision=1,
                      batch_id=f'{shop}-1-{sha[:16]}', records_sha256=sha, records_count=len(rows),
                      assets_sha256=sha256(canonical([asset]))))


def intel_fixture():
    records, _, asset, _, price = docs('intel')
    records.extend([
        ('asset',asset['uri'],'shared',True,asset),
        ('quotation',COLLISION,'intel',False,{
            **price, 'source':'synthetic_only', 'sheet':'synthetic_only', 'workbook_sha256':'f'*64,
        }),
    ])
    intel_schema = """-- 测试仅模拟已部署英特尔结构与初始状态。
CREATE SCHEMA nas_import;
REVOKE ALL ON SCHEMA nas_import FROM PUBLIC;
CREATE TABLE nas_import.batches(batch_id text PRIMARY KEY,manifest jsonb NOT NULL,payload_sha256 text NOT NULL,
 record_count integer NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE nas_import.records (batch_id text NOT NULL REFERENCES nas_import.batches,kind text NOT NULL,record_id text NOT NULL,
 owner_shop text NOT NULL,shared boolean NOT NULL,document jsonb NOT NULL,source_sha256 text NOT NULL, stored_md5 text NOT NULL,
 PRIMARY KEY(batch_id,kind,record_id));
"""
    batch = three.quote(three.INTEL_BATCH)
    intel_schema += f"""INSERT INTO nas_import.batches VALUES({batch},'{{"shop_id":"intel","source_revision":"8151"}}',
 '{three.INTEL_DIGEST}',{len(records)});
"""
    for kind, identity, owner, shared, doc in records:
        raw = canonical(doc)
        d = three.dollar(raw.decode(), 'intel_fixture')+'::jsonb'
        intel_schema += (f"INSERT INTO nas_import.records VALUES({batch},'{kind}','{identity}','{owner}',"
                         f"{str(shared).lower()},{d},'{sha256(raw)}',md5(({d})::text));\n")
    intel_schema += three.read_sql('003-intel-live.sql').replace('diy_workbench_trial',three.DB) + '\n'
    intel_schema += f"""
CREATE SCHEMA nas_business;
REVOKE ALL ON SCHEMA nas_business FROM PUBLIC;
CREATE TABLE nas_business.members(workspace_id text NOT NULL, uid text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,uid));
CREATE TABLE nas_business.shop_roles(workspace_id text NOT NULL,uid text NOT NULL,shop_id text NOT NULL REFERENCES intel_live.shops,
 role text NOT NULL,PRIMARY KEY(workspace_id,uid,shop_id), FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members);
INSERT INTO nas_business.members VALUES('workbench-main','{EXISTING}',true),('workbench-main','{LEGACY}',true),('workbench-main','{DISABLED}',false);
INSERT INTO nas_business.shop_roles VALUES('workbench-main','{EXISTING}','intel','sales'),
 ('workbench-main','{LEGACY}','intel','operations'),('workbench-main','{DISABLED}','intel','operations');
"""
    for file in three.FILES:
        sql = three.read_sql(file)
        if file[:3] in {'004','005','006','007'}:
            sql = sql.replace('diy_workbench_trial',three.DB).replace('diy_api_operations','diy_api_intel_production')
        if file[:3]=='004':
            sql = sql.replace("runtime_password text := '__SET_RANDOM_PASSWORD__';","runtime_password text := '"+'I'*48+"';")
        intel_schema += sql + '\n'
    intel_schema += f"""
UPDATE intel_live.quotations SET status='matched',amount_cents=280000,workbook_rows='[2]' WHERE configuration_id='{COLLISION}';
INSERT INTO intel_live.catalog_shared_editors VALUES('workbench-main','{LEGACY}','gallery');
-- 已有业务变更不等于初始快照，应完整保留。
UPDATE intel_live.configurations SET version=9 WHERE configuration_id='{COLLISION}';
"""
    return intel_schema


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--gigabyte-real', type=Path)
    parser.add_argument('--jonsbo-real', type=Path)
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=False)
    three.output_text(out/'intel-fixture.sql', intel_fixture())
    snapshot(out/'intel-source','intel')
    passwords, manifests = {}, {}
    for ix, shop in enumerate(three.SHOPS):
        incoming = getattr(args,shop+'_real')
        if incoming is None:
            snapshot(out/(shop+'-source'),shop)
            three.build_data(out/(shop+'-source'),shop,out/shop)
            incoming = out/shop
        manifests[shop] = incoming/'manifest.json'
        passwords[shop] = out/(shop+'.test-password')
        three.output_text(passwords[shop], ('G','J')[ix]*48)
    roster = out/'fixture-roster.json'
    three.output_json(roster, dict(workspace_id='workbench-main',group_code='dou-intel-operations',members=[
        dict(uid=EXISTING,existing_database_member='enabled',verified_existing_cloudbase=True),
        dict(uid=APPROVED,existing_database_member='absent',verified_existing_cloudbase=True),
    ]))
    three.make_access(manifests,roster,passwords,out/'access')


if __name__ == '__main__':
    main()
