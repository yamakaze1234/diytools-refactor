"""只读提取维护表综合表缓存价，严格保留文本平台码和原工作簿摘要。"""

import hashlib
import io
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from workbook_read import read_workbook_bytes


def read_quotations(path):
    from pyxlsb import open_workbook

    workbook = Path(path)
    if workbook.suffix.lower() != ".xlsb":
        raise ValueError("请选择不超过 128 MiB 的 XLSB 维护表")
    # 报价只取维护表 H 列；新版成本书的主机含税成本是另一数据源。
    data = read_workbook_bytes(workbook, 128)
    digest = hashlib.sha256(data).hexdigest()
    found, invalid, seen_header = [], 0, False
    with open_workbook(io.BytesIO(data)) as book:
        with book.get_sheet("综合表") as sheet:
            for cells in sheet.rows():
                row = cells[0].r + 1
                value = {c.c: c.v for c in cells}
                if row == 2:
                    seen_header = [value.get(i) for i in (2, 3, 4, 7)] == ["平台", "SPU", "SKU", "到手价"]
                    if not seen_header:
                        raise ValueError("维护表 C、D、E、H 列结构已变化")
                if row < 3 or str(value.get(2, "")).strip().upper() != "INTEL":
                    continue
                spu, sku = value.get(3), value.get(4)
                if any(not isinstance(x, str) or not re.fullmatch(r"[0-9]{1,24}", x.strip()) for x in (spu, sku)):
                    invalid += 1
                    continue
                try:
                    amount = Decimal(str(value.get(7))) * 100
                    cents = str(int(amount)) if amount.is_finite() and 0 <= amount < 10**15 and amount == amount.to_integral_value() else None
                except (ValueError, InvalidOperation):
                    cents = None
                found.append({"spu": spu.strip(), "sku": sku.strip(), "amount_cents": cents, "workbook_row": row})
                if len(found) > 100000:
                    raise ValueError("维护表数据超过 100000 条")
    if not seen_header:
        raise ValueError("缺少已知维护表表头")
    if hashlib.sha256(read_workbook_bytes(workbook, 128)).hexdigest() != digest:
        raise ValueError("读取期间表格发生变化，请重新选择")
    return {"rows": found, "workbook_sha256": digest, "invalidCount": invalid}
