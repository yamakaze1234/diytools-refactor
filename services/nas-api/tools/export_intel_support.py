"""迁移文件采用固定 UTF-8 序列化，确保本地与数据库传输摘要可核对。"""
import hashlib
import json


def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')


def sha256(value):
    return hashlib.sha256(value).hexdigest()
