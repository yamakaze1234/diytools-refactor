# 管理仅存于内存的 ERP 登录会话与商品只读查询；退出时清除本进程会话，不使其他程序的登录失效。
"""Memory-only ERP session; the only business requests are three read APIs."""

import contextlib
import importlib
import importlib.util
from pathlib import Path
from urllib.parse import urlsplit
import json
import logging
import math
import os
import sys
from datetime import datetime, timezone

MAX_ROWS = 500
READ_PATHS = {
    "pages/net/getNetGoodsList.htm",
    "pages/goods/searchGoodsDetail.htm",
    "pages/basgoods/searchNetSalesGoodsList.htm",
}


# 携带可安全返回给界面的错误码与提示，避免透传 SDK 原始异常。
class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# 临时屏蔽 Python 日志和原生标准输出，避免 SDK 的敏感调试信息混入 JSONL；退出时恢复。
@contextlib.contextmanager
def silence_sdk():
    """Discard Python/native SDK output and logging, including sensitive errors."""
    previous = logging.root.manager.disable
    saved = []
    with open(os.devnull, "w", encoding="utf-8") as sink:
        try:
            logging.disable(sys.maxsize)
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                    descriptor = stream.fileno()
                    backup = os.dup(descriptor)
                    os.dup2(sink.fileno(), descriptor)
                    saved.append((descriptor, backup))
                except (AttributeError, OSError, ValueError):
                    pass
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                yield
        finally:
            for descriptor, backup in reversed(saved):
                os.dup2(backup, descriptor)
                os.close(backup)
            logging.disable(previous)


# 只关闭本进程 HTTP 客户端并清空内存凭据，不调用会使共享 Cookie 失效的 logout。
def close_client(erp):
    """Never call logout: it invalidates cookies shared with other applications."""
    if erp is None:
        return
    with silence_sdk():
        client = getattr(erp, "client", None)
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        config = getattr(erp, "config", None)
        if isinstance(config, dict):
            config.clear()
        erp.cookies = ""
        erp.user = ""


# 配置只从宿主固定的本机文件读取；没有配置时状态/SQL 服务仍可使用，网页登录明确拒绝。
def local_erp_config():
    path = os.environ.get("DIYTOOLS_INTEGRATIONS")
    if not path:
        return {}
    try:
        config_path = Path(path)
        if not config_path.exists():
            return {}
        with config_path.open("rb") as stream:
            raw = stream.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            raise ValueError()
        document = json.loads(raw.decode("utf-8"))
        if document.get("version") != 1:
            raise ValueError()
        config = document.get("erp") or {}
        if not isinstance(config, dict):
            raise ValueError()
        domain = config.get("domain")
        if domain:
            parsed = urlsplit(domain)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
                raise ValueError()
            config = {"domain": domain.rstrip("/") + "/", "adapter_path": config_path.parent / "runtime" / "erp-adapter.py"}
        return config
    except Exception:
        raise WorkerError("ERP_CONFIG_INVALID", "本机 ERP 接入配置无效") from None


# 私有适配器仅从本机 data/runtime 加载；公开依赖锁文件和构建不引用公司包。
def load_adapter(config):
    path = config.get("adapter_path")
    if not path or not Path(path).is_file():
        raise WorkerError("PACKAGE_UNAVAILABLE", "请在本机安装 ERP 适配器")
    spec = importlib.util.spec_from_file_location("diytools_local_erp_adapter", path)
    if spec is None or spec.loader is None:
        raise WorkerError("PACKAGE_UNAVAILABLE", "本机 ERP 适配器不可用")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "create_client", None)) or not callable(getattr(module, "api_factories", None)):
        raise WorkerError("PACKAGE_UNAVAILABLE", "本机 ERP 适配器接口不完整")
    return module


# 每次连接按本机 HTTPS 地址创建客户端；适配器必须在登录发送前禁用跨来源重定向。
def create_sdk_client(config):
    local = local_erp_config()
    module = load_adapter(local)
    return module.create_client(config, domain=local["domain"])


def sdk_api_factories():
    return load_adapter(local_erp_config()).api_factories()


def _text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品字段格式无效")
    return value


# 商品 ID 保留字符串或整数的精度；拒绝浮点及布尔值，避免错误匹配长 SKU。
def _identifier(value, *, allow_empty=False):
    if value is None or value == "":
        if allow_empty:
            return ""
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品 ID 无效")
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品 ID 无效")
    result = str(value).strip()
    if not result:
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品 ID 无效")
    return result


# 规范化单条 BOM 配件，数量必须为有限非负数，赠品标记也必须在明确取值内。
def _row(item, default_id):
    if not isinstance(item, dict):
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品明细格式无效")
    quantity = item.get("n", 1)
    try:
        if isinstance(quantity, bool):
            raise ValueError()
        number = float(quantity)
        if not math.isfinite(number) or number < 0:
            raise ValueError()
    except (TypeError, ValueError, OverflowError):
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的商品数量无效") from None
    gift = item.get("b_gift", 0)
    if type(gift) not in (str, int, bool) or gift not in (0, 1, "0", "1", False, True):
        raise WorkerError("INVALID_RESPONSE", "ERP 返回的赠品标记无效")
    return {
        "goods_id": _identifier(item.get("goods_id") or item.get("id") or default_id),
        "quantity": int(number) if number.is_integer() else number,
        "code": _text(item.get("c_sku", "")),
        "name": _text(item.get("c_name", "")),
        "type": _text(item.get("c_type_name", "")),
        "category": _text(item.get("c_sub_category") or item.get("c_sub_category_name", "")),
        "brand": _text(item.get("c_brand", "")),
        "series": _text(item.get("c_series", "")),
        "model": _text(item.get("c_model", "")),
        "spec": _text(item.get("c_spec", "")),
        "is_gift": gift in (1, "1", True),
    }


# 一个常驻 worker 只管理一个 ERP 会话；工厂可注入，使协议测试无需实际网络。
class Session:
    def __init__(self, client_factory=create_sdk_client, api_factories=sdk_api_factories, version=None, config=None):
        self._erp = None
        self._client_factory = client_factory
        self._api_factories = api_factories
        self._config = local_erp_config() if config is None else config
        self._domain = self._config.get("domain")
        self.version = version or "external-adapter"

    def status(self):
        return {"connected": self._erp is not None, "user": self._erp.user if self._erp is not None else None,
                "domain": self._domain, "package_version": self.version}

    def disconnect(self):
        old, self._erp = self._erp, None
        close_client(old)
        return self.status()

    # 先释放旧会话，再验证域名和凭据；失败时不能继续复用上一次账号。
    def connect(self, request):
        self.disconnect()
        if not self._domain:
            raise WorkerError("ERP_NOT_CONFIGURED", "本机尚未配置 ERP 服务")
        if request.get("domain", self._domain) != self._domain:
            raise WorkerError("INVALID_DOMAIN", "ERP 地址与本机配置不一致")
        username = request.get("username", "")
        password = request.get("password", "")
        cookie = request.get("cookie", "")
        if not all(isinstance(value, str) for value in (username, password, cookie)):
            raise WorkerError("INVALID_REQUEST", "登录字段格式无效")
        username, cookie = username.strip(), cookie.strip()
        if cookie.startswith("_wdb="):
            cookie = cookie[5:]
        if any(character in cookie for character in (";", "\r", "\n", "\x00")):
            raise WorkerError("INVALID_REQUEST", "请提供单个 _wdb Cookie 值")
        if bool(username) != bool(password) or not (cookie or (username and password)):
            raise WorkerError("MISSING_CREDENTIALS", "请提供账号密码或有效 Cookie")
        config = {"cookie": cookie, "_username": username, "_password": password}
        erp = None
        try:
            with silence_sdk():
                erp = self._client_factory(config)
                if not isinstance(getattr(erp, "user", None), str) or not erp.user.strip():
                    raise WorkerError("AUTH_FAILED", "ERP 登录失败，请检查账号或 Cookie")
            self._erp = erp
            return self.status()
        except Exception as error:
            close_client(erp)
            config.clear()
            raise self._safe_error(error, connecting=True) from None

    # 仅依据异常类别产生界面提示，不返回可能带密码、Cookie 或服务器信息的原文。
    def _safe_error(self, error, *, connecting=False):
        if isinstance(error, WorkerError):
            return error
        name = type(error).__name__
        if name in {"ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "TimeoutException", "NetworkError", "ReadError", "WriteError", "RemoteProtocolError"}:
            return WorkerError("NETWORK_ERROR", "ERP 网络连接失败，请稍后重试")
        if isinstance(error, (ImportError, ModuleNotFoundError)):
            return WorkerError("PACKAGE_UNAVAILABLE", "本机 ERP 适配器不可用")
        if connecting:
            return WorkerError("AUTH_FAILED", "ERP 登录失败，请检查账号或 Cookie")
        if isinstance(error, AssertionError) and "登录" in str(error):
            return WorkerError("SESSION_EXPIRED", "ERP 会话已失效，请重新登录")
        return WorkerError("QUERY_FAILED", "ERP 查询失败，请重新连接后重试")

    # 请求路径必须在固定只读白名单内；校验业务失败标记及分页总数，不能把截断结果当成功。
    def _read(self, api):
        if api.base_url not in READ_PATHS or api.url != self._domain + api.base_url:
            raise WorkerError("INVALID_API", "ERP 查询接口不受支持")
        response = self._erp.client.post(api.url, params=api.params(), timeout=20, follow_redirects=False)
        self._erp._check_res(response)
        payload = response.json()
        if (not isinstance(payload, dict) or "data" not in payload
                or payload.get("success") is False or payload.get("result") is False
                or ("st" in payload and payload["st"] != 0)):
            raise WorkerError("INVALID_RESPONSE", "ERP 返回数据不完整")
        if "code" in payload and payload["code"] not in (0, "0", 200, "200"):
            raise WorkerError("QUERY_FAILED", "ERP 拒绝了商品查询")
        data = payload["data"]
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise WorkerError("INVALID_RESPONSE", "ERP 返回数据格式无效")
        if len(data) > MAX_ROWS:
            raise WorkerError("TOO_MANY_RESULTS", "ERP 查询结果超过 500 条，请缩小范围")
        if api.base_url == "pages/net/getNetGoodsList.htm":
            total = payload.get("total")
            if type(total) is not int or total < 0:
                raise WorkerError("INVALID_RESPONSE", "ERP 返回分页信息无效")
            if total > MAX_ROWS:
                raise WorkerError("TOO_MANY_RESULTS", "ERP 查询结果超过 500 条，请缩小范围")
            if total != len(data):
                raise WorkerError("INCOMPLETE_RESULTS", "ERP 返回的商品列表不完整")
        return data

    # 先精确匹配 SKU 再读取 BOM；多个关联商品视为歧义，无 BOM 时才核验单品信息。
    def query_goods(self, sku):
        if self._erp is None:
            raise WorkerError("NOT_CONNECTED", "请先连接 ERP")
        if not isinstance(sku, str) or not sku.strip() or len(sku) > 256:
            raise WorkerError("INVALID_REQUEST", "请提供有效 SKU 编码")
        sku = sku.strip()
        try:
            with silence_sdk():
                net_factory, detail_factory, info_factory = self._api_factories()
                api = net_factory(编码=sku, 维度="SKU")
                api.pageSize = MAX_ROWS
                records = self._read(api)
                exact = []
                for item in records:
                    if "sku_id" not in item:
                        raise WorkerError("INVALID_RESPONSE", "ERP 返回数据缺少 SKU 编码")
                    if _identifier(item["sku_id"]) == sku:
                        exact.append(item)
                ids = {_identifier(item.get("goods_id"), allow_empty=True) for item in exact}
                if len(ids) > 1:
                    raise WorkerError("AMBIGUOUS", "同一 SKU 关联多个 ERP 商品，请在 ERP 核对后重试")
                if ids == {""}:
                    raise WorkerError("NOT_LINKED", "该 SKU 尚未关联 ERP 商品")
                rows = []
                if ids:
                    goods_id = next(iter(ids))
                    details = self._read(detail_factory(goods_id=goods_id))
                    if details:
                        rows = [_row(item, goods_id) for item in details]
                    else:
                        info = self._read(info_factory(goods_id=goods_id))
                        if len(info) != 1 or _identifier(info[0].get("id") or info[0].get("goods_id")) != goods_id:
                            raise WorkerError("INVALID_RESPONSE", "ERP 返回的单品信息不完整")
                        rows = [_row(info[0], goods_id)]
                return {"sku": sku, "rows": rows, "queried_at": datetime.now(timezone.utc).isoformat()}
        except Exception as error:
            safe = self._safe_error(error)
            if safe.code in {"NETWORK_ERROR", "SESSION_EXPIRED", "QUERY_FAILED"}:
                self.disconnect()
            raise safe from None

    # 校验协议信封并分派显式支持的动作；未知动作不能穿透到 SDK。
    def handle(self, request):
        if not isinstance(request, dict) or not isinstance(request.get("id"), str) or len(request["id"]) > 256:
            raise WorkerError("INVALID_REQUEST", "请求格式无效")
        if request.get("domain", self._domain) != self._domain:
            if request.get("action") == "connect":
                self.disconnect()
            raise WorkerError("INVALID_DOMAIN", "ERP 地址与本机配置不一致")
        action = request.get("action")
        if action == "sql_cost_file":
            from cost_file import read_costs
            try:
                return read_costs(request.get("settings", {}))
            except (ValueError, OSError, KeyError) as error:
                raise WorkerError("COST_FILE_ERROR", "成本表读取失败：" + str(error)) from None
        if action in {"sql_read", "sql_credentials_load", "sql_credentials_clear"}:
            return self.handle_sql(request)
        if action == "status":
            return self.status()
        if action == "connect":
            return self.connect(request)
        if action == "disconnect":
            return self.disconnect()
        if action == "query_goods":
            return self.query_goods(request.get("sku"))
        raise WorkerError("UNKNOWN_ACTION", "不支持该 ERP 操作")

    # SQL 查询独立于网页登录；两次读取、规范化和输出大小检查都成功后才保存或清除凭据。
    def handle_sql(self, request):
        from sql_service import SqlError, normalize, read_bundle, settings
        import sql_credentials
        try:
            action = request["action"]
            if action == "sql_credentials_load":
                return sql_credentials.load()
            if action == "sql_credentials_clear":
                return sql_credentials.clear()
            config = settings(request.get("settings"))
            password = request.get("password")
            remember = request.get("remember")
            if not isinstance(password, str) or not 0 < len(password) <= 1024 or type(remember) is not bool:
                raise SqlError("数据库密码或保存选项无效", "INVALID_REQUEST")
            # Both queries and normalization must succeed before any vault mutation.
            with silence_sdk():
                rows = normalize(read_bundle(config, password))
            result = {"rows": rows, "settings": config}
            # Reserve room for the JSONL id/envelope; never save on output rejection.
            if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 32 * 1024 * 1024 - 2048:
                raise SqlError("数据库目录超过允许大小，已保留原保存", "OUTPUT_TOO_LARGE")
            if remember:
                sql_credentials.save(config, password)
            else:
                sql_credentials.clear()
            return result
        except SqlError as error:
            raise WorkerError(error.code, error.message) from None
        except Exception:
            raise WorkerError("SQL_CONNECTION", "数据库只读服务暂不可用，本机原数据未改动") from None
