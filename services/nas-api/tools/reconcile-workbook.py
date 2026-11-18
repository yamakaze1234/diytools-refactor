"""只读核对维护表缓存到手价；以店铺、SPU、SKU精确匹配，不推算缺失价格。"""
import argparse
import collections
import hashlib
import io
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from pyxlsb import open_workbook


def cents(value):
    try:
        number = Decimal(str(value)) * 100
        return str(int(number)) if number.is_finite() and number >= 0 and number == number.to_integral_value() else None
    except (ValueError, InvalidOperation):
        return None


def identity(value):
    # 长商品码必须原为文本，Excel数值型长码不能恢复精度，拒绝自动匹配。
    return value.strip() if isinstance(value, str) and value.strip().isdigit() else None


def reconcile(snapshot, workbook, output):
    data = workbook.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    index = collections.defaultdict(list)
    rejected = []
    with open_workbook(io.BytesIO(data)) as book:
        with book.get_sheet('综合表') as sheet:
            for row in sheet.rows():
                values = {cell.c: cell.v for cell in row}
                row_number = row[0].r + 1
                if row_number == 2:
                    assert [values.get(i) for i in (2, 3, 4, 7)] == ['平台', 'SPU', 'SKU', '到手价'], '维护表列结构变化'
                if row_number < 3 or str(values.get(2, '')).strip().upper() != 'INTEL':
                    continue
                spu, sku = identity(values.get(3)), identity(values.get(4))
                if not spu or not sku:
                    rejected.append(row_number)
                    continue
                index[(spu, sku)].append(dict(row=row_number, amount_cents=cents(values.get(7))))
    records = [json.loads(line) for line in (snapshot / 'records.jsonl').read_text(encoding='utf-8').splitlines()]
    results = []
    for record in records:
        if record['kind'] != 'configuration':
            continue
        config = record['document']
        matches = index.get((config.get('spu'), config.get('skuId')), [])
        status = 'matched' if len(matches) == 1 and matches[0]['amount_cents'] is not None else 'ambiguous' if len(matches) > 1 else 'missing_price' if matches else 'unmatched'
        amount = matches[0]['amount_cents'] if status == 'matched' else None
        local = cents(config.get('price'))
        results.append(dict(configuration_id=config['id'], status=status, amount_cents=amount, workbench_price_cents=local,
                            difference_cents=str(int(amount)-int(local)) if amount is not None and local is not None else None,
                            workbook_rows=[row['row'] for row in matches]))
    if hashlib.sha256(workbook.read_bytes()).hexdigest() != sha:
        raise ValueError('核对期间维护表发生变化')
    result = dict(workbook_sha256=sha, sheet='综合表', price_column='H', identity_columns=['C', 'D', 'E'],
                  source='saved_formula_cache', recalculated=False, rejected_identity_rows=rejected,
                  counts=dict(collections.Counter(row['status'] for row in results)),
                  differing_prices=sum(row['difference_cents'] not in (None, '0') for row in results), configurations=results)
    with output.open('x', encoding='utf-8') as file:
        json.dump(result, file, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({key:value for key,value in result.items() if key not in ('configurations', 'rejected_identity_rows')}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--workbook', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    reconcile(args.snapshot, args.workbook, args.output)
