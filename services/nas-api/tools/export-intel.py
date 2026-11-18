"""以同一 SQLite 只读事务导出英特尔业务文档及依赖；不复制凭据与历史库。"""
import argparse
import collections
import hashlib
import json
import re
import sqlite3
import subprocess
from pathlib import Path


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def refs(value, keys):
    return {str(row[key]) for row in walk(value) for key in keys if row.get(key) not in (None, '')}


def images(value):
    if isinstance(value, str):
        if value.startswith('/uploads/'):
            yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from images(child)
    elif isinstance(value, list):
        for child in value:
            yield from images(child)


def export(source, output, asset_root=None):
    # 目录必须全新，防止混入上一次批次或误覆盖用户文件。
    output.mkdir(parents=True, exist_ok=False)
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        metadata = json.loads(db.execute('SELECT document FROM workbench_metadata WHERE id=1').fetchone()[0])
        configs = [json.loads(row[0]) for row in db.execute('SELECT document FROM workbench_configs ORDER BY id')]
        # 状态头字段存 JSON 文本，按业务代码同样先解码再与元数据比较。
        header = dict(zip(('revision', 'updated_at'), db.execute("SELECT json_extract(revision,'$'),json_extract(updated_at,'$') FROM workbench_state_header WHERE id=1").fetchone()))
        db.rollback()
    # 正式迁移必须来自同一版配置与元数据；不静默选择两个版本号中的任意一个。
    if metadata.get('revision') != header['revision']:
        raise ValueError('工作台元数据修订号与 SQLite 状态头不一致')
    live = [row for row in configs if row.get('shopId') == 'intel' and not row.get('deletedAt')]
    deleted = [row for row in configs if row.get('shopId') == 'intel' and row.get('deletedAt')]
    other = [row for row in configs if row.get('shopId') != 'intel' and not row.get('deletedAt')]
    templates = [row for row in metadata.get('templates', []) if row.get('shopId') == 'intel']
    catalog = metadata.get('sourceCatalog', [])
    required_sources = refs([live, templates], ['sourceId'])
    sources = [row for row in catalog if row.get('shopId') == 'intel' or row.get('sourceId') in required_sources]
    # 跟随来源可再引用来源，闭包收集，不按当前店铺截断跨店依赖。
    while True:
        required_sources |= refs(sources, ['sourceId'])
        expanded = [row for row in catalog if row.get('shopId') == 'intel' or row.get('sourceId') in required_sources]
        if len(expanded) == len(sources):
            break
        sources = expanded
    # 三类虚拟特殊配件来自现有客户端规则，保留来源标记，不能伪造 ERP 商品码。
    preset_module = Path(__file__).resolve().parents[3] / 'apps/desktop/public/workbench/special-components.js'
    presets = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.withSpecialPresets([],'intel')))",
        preset_module.as_uri()], encoding='utf-8'))
    missing_sources = required_sources - {row['sourceId'] for row in sources}
    used_presets = [row for row in presets if row['sourceId'] in missing_sources]
    sources += used_presets
    goods = refs([live, templates, sources], ['goodsId', 'addonGoodsId'])
    costs = [row for row in metadata.get('costSource', []) if str(row.get('goodsId', '')) in goods]
    shop = next(row for row in metadata['shops'] if row['id'] == 'intel')
    settings = metadata.get('shopSettings', {}).get('intel', {})
    image_refs = set(images([live, templates, sources, shop, settings]))
    gallery = [row for row in metadata.get('caseGallery', []) if row.get('url') in image_refs]
    other_sources = refs(other, ['sourceId'])
    other_goods = refs(other, ['goodsId', 'addonGoodsId'])
    other_images = set(images(other))
    rows = []
    keys = set()

    def add(kind, identity, doc, owner, shared=False):
        identity = str(identity or '')
        if not identity or (kind, identity) in keys:
            raise ValueError('缺少或重复业务标识：' + kind + ':' + identity)
        # 不允许业务文档夹带认证字段；命中后停下审查，不静默删改原文。
        for node in walk(doc):
            if any(re.fullmatch(r'(password|access_?token|refresh_?token|authorization|cookie|secret)', key, re.I) for key in node):
                raise ValueError('业务文档含认证字段：' + kind + ':' + identity)
        keys.add((kind, identity))
        rows.append(dict(kind=kind, id=identity, owner=owner, shared=shared, document=doc, sha256=digest(encoded(doc))))

    add('shop', 'intel', shop, 'intel')
    add('settings', 'intel', settings, 'intel')
    for row in live:
        add('configuration', row['id'], row, 'intel')
    for row in templates:
        add('template', row['id'], row, 'intel')
    for row in sources:
        add('source', row['sourceId'], row, row.get('shopId') or 'unassigned', row['sourceId'] in other_sources or row.get('shopId') != 'intel')
    for row in costs:
        add('cost', row['goodsId'], row, 'shared', str(row['goodsId']) in other_goods)
    for row in gallery:
        add('gallery', row['id'], row, 'shared', row.get('url') in other_images)
    assets, missing_assets = [], []
    # 一致 DB 副本和原文件可在不同目录；仍只按原 SHA 路径和文件稳定性读取。
    asset_root = (asset_root or source.parent / 'workbench-assets').resolve(strict=True)
    (output / 'assets').mkdir()
    for ref in sorted(image_refs):
        path = (asset_root / ref.lstrip('/')).resolve()
        if not path.is_relative_to(asset_root):
            raise ValueError('素材路径越界')
        if not path.is_file():
            missing_assets.append(ref)
            continue
        # 一次读取决定摘要和复制内容；随后验证源文件未被并发替换。
        body = path.read_bytes()
        sha = digest(body)
        if digest(path.read_bytes()) != sha:
            raise ValueError('素材读取期间发生变化：' + ref)
        dest = output / 'assets' / sha
        if not dest.exists():
            dest.write_bytes(body)
        assets.append(dict(uri=ref, sha256=sha, size=len(body), file='assets/' + sha))
    rows.sort(key=lambda row: (row['kind'], row['id']))
    record_bytes = b''.join(encoded(row) + b'\n' for row in rows)
    (output / 'records.jsonl').write_bytes(record_bytes)
    # 软删除仅作本地核对归档，不进入接收库中的有效配置。
    (output / 'deleted-configurations.json').write_bytes(encoded(deleted))
    (output / 'assets.json').write_bytes(encoded(assets))
    summary = dict(
        source_revision=metadata.get('revision'), state_header=header,
        counts=dict(collections.Counter(row['kind'] for row in rows)), deleted_count=len(deleted),
        missing_spu=[row['id'] for row in live if not row.get('spu')],
        missing_sku=[row['id'] for row in live if not row.get('skuId')],
        missing_source_ids=sorted(required_sources - {row['sourceId'] for row in sources}),
        missing_cost_goods=sorted(goods - {str(row['goodsId']) for row in costs}),
        missing_assets=missing_assets, assets=len(assets),
        shared_dependencies=[dict(kind=row['kind'], id=row['id'], owner=row['owner']) for row in rows if row['shared']],
        quotation_status='workbook_not_reconciled',
        missing_part_goods={kind: sum(not row.get('goodsId') for config in live for row in config.get(kind, [])) for kind in ('parts', 'actualParts')},
    )
    manifest = dict(format_version=1, shop_id='intel', source_revision=str(metadata.get('revision')),
                    records_sha256=digest(record_bytes), records_count=len(rows), counts=summary['counts'],
                    assets_sha256=digest(encoded(assets)), assets_count=len(assets),
                    deleted_sha256=digest(encoded(deleted)), quotation_status='workbook_not_reconciled')
    manifest['builtin_sources'] = [row['sourceId'] for row in used_presets]
    manifest['builtin_rule_sha256'] = digest(preset_module.read_bytes())
    manifest['batch_id'] = 'intel-' + manifest['source_revision'] + '-' + manifest['records_sha256'][:16]
    (output / 'manifest.json').write_bytes(encoded(manifest))
    (output / 'scope-report.json').write_bytes(encoded(summary))
    print(json.dumps({**manifest, 'missing_assets': len(missing_assets), 'missing_sources': len(summary['missing_source_ids']), 'missing_costs': len(summary['missing_cost_goods'])}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--asset-root', type=Path)
    args = parser.parse_args()
    export(args.source, args.output, args.asset_root)
