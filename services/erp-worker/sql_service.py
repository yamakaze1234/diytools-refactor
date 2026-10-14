"""ERP SQL Server 只读查询入口；按准确 goods_id 读取库存、商品和利润成本。

连接、查询与关闭都在调用线程完成，不写 ERP；normalize 在整批校验通过后
才返回可供工作台使用的目录，缺失库存或成本以 None 表示未知。
"""
import math
import re
import socket
import threading
MAX_ROWS = 100000

class SqlError(Exception):
    def __init__(self, message, code="SQL_INVALID_RESPONSE"):
        super().__init__(message)
        self.code = code
        self.message = message

QUERIES = [
    'SELECT TOP (100001) CONVERT(varchar(20), [goods_id]) AS [goods_id], [库房], [商品编码], [商品名称], [分库数], [分库可销数], [分库待入], [库存成本] FROM [库存].[分库库存]',
    'SELECT TOP (100001) CONVERT(varchar(20), [goods_id]) AS [goods_id], [商品编码], [商品名称], [总数量], [可销数], [待入] FROM [库存].[库存查询]',
]


def settings(value):
    """校验连接参数并返回规范化副本；密码单独传入查询函数。"""
    if not isinstance(value, dict):
        raise SqlError('请填写服务器、数据库和账号', 'INVALID_REQUEST')
    result = {}
    for key in ('server', 'database', 'user'):
        item = value.get(key)
        if not isinstance(item, str) or not item.strip() or len(item) > 200:
            raise SqlError('请填写服务器、数据库和账号', 'INVALID_REQUEST')
        result[key] = item.strip()
    raw_port = value.get('port', 1433)
    if type(raw_port) is bool or not isinstance(raw_port, (int, str)) or (isinstance(raw_port, str) and not raw_port.isdecimal()):
        raise SqlError('数据库端口无效', 'INVALID_REQUEST')
    try:
        result['port'] = int(raw_port)
    except (ValueError, TypeError):
        raise SqlError('数据库端口无效', 'INVALID_REQUEST') from None
    if not 1 <= result['port'] <= 65535:
        raise SqlError('数据库端口无效', 'INVALID_REQUEST')
    for key in ('encrypt', 'trustServerCertificate'):
        if key in value and type(value[key]) is not bool:
            raise SqlError('数据库连接开关无效', 'INVALID_REQUEST')
    result['encrypt'] = value.get('encrypt') is not False
    result['trustServerCertificate'] = value.get('trustServerCertificate') is True
    return result


def normalize(bundle):
    """核验两张 ERP 视图的完整性、编码和身份后按 goods_id 合并。

只取“公司大库”的可销数及单件库存成本；目录存在但无对应仓库行时保持 None。
任一行身份重复、编码不一致或整批超限即拒收，调用方可保留原缓存。
"""
    if not isinstance(bundle, dict):
        raise SqlError('数据库返回结构无效')
    warehouses, catalog = bundle.get('warehouses'), bundle.get('catalog')
    if not isinstance(warehouses, list) or not isinstance(catalog, list) or not catalog or max(len(warehouses), len(catalog)) > 100000:
        raise SqlError('数据库目录为空、不完整或超过 100000 行，已保留原数据')
    if any(not isinstance(row, dict) for row in warehouses + catalog):
        raise SqlError('数据库返回行结构无效')
    # 兼容历史驱动把中文按 latin1 透传的结果；识别后整批按 gb18030 解码。
    legacy = any(r.get('库房') == bytes.fromhex('b9abcbbeb4f3bfe2').decode('latin1') for r in warehouses)
    by_id, codes, warehouse_keys, catalog_ids = {}, {}, set(), set()

    def decoded(value):
        if isinstance(value, bytes):
            try:
                return value.decode('gb18030' if legacy else 'utf-8')
            except UnicodeError:
                raise SqlError('数据库文本编码不一致，已保留原数据') from None
        if not isinstance(value, str):
            raise SqlError('数据库文本字段无效')
        if legacy and all(ord(c) < 256 for c in value):
            try:
                value = value.encode('latin1').decode('gb18030')
            except UnicodeError:
                raise SqlError('数据库文本编码不一致，已保留原数据') from None
        return value.strip()

    # 缺失库存保持未知；布尔值、空字符串和非有限数不能误当作有效库存或成本。
    def numeric(value):
        if value is None:
            return None
        try:
            if isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
                raise ValueError()
            number = float(value)
            if not math.isfinite(number):
                raise ValueError()
            return number
        except (ValueError, TypeError, OverflowError):
            raise SqlError('数据库库存数值无效，已保留原数据') from None

    # 按精确 goods_id 与商品编码建立一一对应关系，不允许同一编码对应多个商品。
    def identity(row):
        key = row.get('goods_id')
        if not isinstance(key, (str, int)) or isinstance(key, bool) or not re.fullmatch(r'[1-9]\d{0,19}', str(key)):
            raise SqlError('数据库 goods_id 缺失或不精确')
        key, name, sku = str(key), decoded(row.get('商品名称')), decoded(row.get('商品编码'))
        if not name or not sku or sku == '0':
            raise SqlError('数据库商品身份不完整')
        if (sku in codes and codes[sku] != key) or (key in by_id and by_id[key]['sku'] != sku):
            raise SqlError('数据库商品编号与编码不一致')
        codes[sku] = key
        return dict(goodsId=key, name=name, sku=sku)

    for raw in warehouses:
        if '分库数' not in raw or '分库可销数' not in raw:
            raise SqlError('数据库缺少公司大库库存字段')
        ident = identity(raw)
        key, warehouse = ident['goodsId'], decoded(raw.get('库房'))
        if not warehouse or len(warehouse) > 100 or (key, warehouse) in warehouse_keys:
            raise SqlError('库房身份无效或同一商品和库房出现重复记录')
        warehouse_keys.add((key, warehouse))
        numeric(raw.get('分库数'))
        numeric(raw.get('分库待入'))
        able = numeric(raw.get('分库可销数'))
        row = by_id.get(key, {**ident, 'stockAvailable': None, 'erp': None})
        if warehouse == '公司大库':
            if '库存成本' not in raw:
                raise SqlError('数据库缺少库存成本字段')
            cost = numeric(raw['库存成本'])
            if cost is not None and cost < 0:
                raise SqlError('SQL 库存成本必须是非负单件成本')
            row.update(stockAvailable=able, erp=cost)
        by_id[key] = row
    for raw in catalog:
        ident = identity(raw)
        key = ident['goodsId']
        if key in catalog_ids:
            raise SqlError('完整目录商品编号重复')
        catalog_ids.add(key)
        by_id[key] = {**by_id.get(key, dict(stockAvailable=None, erp=None)), **ident}
    return list(by_id.values())


_tls_settings = threading.local()
_install_lock = threading.Lock()
_installed = False


def _install_tls_adapter():
    # pytds 有 CA 文件参数但无“信任服务器证书”开关；按线程隔离该选项。
    global _installed
    with _install_lock:
        if _installed:
            return
        from pytds import tls
        from OpenSSL import SSL
        original = tls.create_context

        def context(cafile):
            ctx = original(cafile)
            if getattr(_tls_settings, 'trust', False):
                ctx.set_verify(SSL.VERIFY_NONE, lambda *_: True)
            return ctx
        tls.create_context = context
        _installed = True


def read_bundle(config, password, connector=None):
    """一次只读读取库存分库与完整目录，逐批 fetch；返回原始两组行。

超过十万行会拒收，避免把截断结果当作全量。错误仅返回分类提示，
不暴露可能含凭据的驱动原文；连接在 finally 关闭。
"""
    config = settings(config)
    if not isinstance(password, str) or not password or len(password) > 1024:
        raise SqlError('请输入数据库密码', 'INVALID_REQUEST')
    try:
        import certifi
        import pytds
        _install_tls_adapter()
    except Exception:
        raise SqlError('数据库只读依赖不可用', 'PACKAGE_UNAVAILABLE') from None
    connection = None
    stage = '连接数据库'
    try:
        _tls_settings.trust = config['trustServerCertificate']
        connection = (connector or pytds.connect)(server=config['server'], port=config['port'], database=config['database'], user=config['user'], password=password,
            login_timeout=10, timeout=30, as_dict=True, autocommit=True, readonly=True, appname='DIYWorkbenchPythonReadonly',
            cafile=certifi.where() if config['encrypt'] else None, validate_host=not config['trustServerCertificate'], enc_login_only=False, disable_connect_retry=True, pooling=False)
        stage = '读取库存'
        cursor, results = connection.cursor(), []
        for query in QUERIES:
            cursor.execute(query)
            rows = []
            while True:
                chunk = cursor.fetchmany(1000)
                if not chunk:
                    break
                rows.extend(chunk)
                if len(rows) > 100000:
                    raise SqlError('查询超过 100000 行，已拒收截断数据', 'SQL_TOO_MANY_RESULTS')
            results.append(rows)
        return dict(warehouses=results[0], catalog=results[1])
    except SqlError:
        raise
    except Exception as error:
        # 驱动错误可能包含凭据；只用于判断错误类别，不直接显示。
        message = str(error).lower()
        number = getattr(error, 'number', None)
        detail, code = '请核对公司网络、账号、实际数据库名和连接设置', 'SQL_CONNECTION'
        if isinstance(error, (TimeoutError, socket.timeout)) or 'timed out' in message:
            detail, code = '连接或查询超时，请检查网络及数据库负载', 'SQL_TIMEOUT'
        elif 'certificate' in message:
            detail, code = '证书校验失败；公司确认使用自签证书时可勾选信任服务器证书', 'SQL_CERTIFICATE'
        elif number in (4060, 911):
            detail, code = '数据库不存在或无权打开，请填写实际数据库名', 'SQL_DATABASE'
        elif number == 18456 or 'login failed' in message:
            detail, code = '登录失败，请核对用户名、密码和数据库访问权限', 'SQL_LOGIN'
        elif number in (207, 208, 229, 916):
            detail, code = '缺少库存视图、字段或只读查询权限', 'SQL_SCHEMA'
        raise SqlError(f'{stage}失败：{detail}。本机原数据未改动。', code) from None
    finally:
        _tls_settings.trust = False
        if connection:
            try:
                connection.close()
            except Exception:
                pass  # A broken network must not hide the original read error.

