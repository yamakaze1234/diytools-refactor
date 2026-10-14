# ERP 协议与适配层的离线测试：使用假的 HTTP/ERP 对象，覆盖可选适配器协议，但不连接 ERP。
"""Offline protocol and SDK-adapter checks; these never contact ERP."""

import io
import json
import logging
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from main import MAX_INPUT, serve
from session import Session, WorkerError, create_sdk_client, sdk_api_factories, silence_sdk, local_erp_config, load_adapter

DOMAIN = "https://erp.example.test/"
TEST_CONFIG = {"domain": DOMAIN}

SECRET = "password-cookie-private-marker"
LONG_ID = "900719925474099312345678901"


# 复现 SDK 的 URL 和参数接口，让白名单与参数映射检查不依赖网络。
class FakeApi:
    def __init__(self, path, **fields):
        self.base_url = path
        self.url = DOMAIN + path
        self.fields = fields

    def params(self):
        return self.fields


def factories():
    return (lambda **fields: FakeApi("pages/net/getNetGoodsList.htm", **fields),
            lambda **fields: FakeApi("pages/goods/searchGoodsDetail.htm", **fields),
            lambda **fields: FakeApi("pages/basgoods/searchNetSalesGoodsList.htm", **fields))


# 记录请求并返回预设响应，用于验证重定向、超时和只读路径约束。
class FakeHttp:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        print(SECRET)
        print(SECRET, file=sys.stderr)
        logging.critical(SECRET)
        value = self.payloads.pop(0)
        if isinstance(value, Exception):
            raise value
        return SimpleNamespace(json=lambda: value)

    def close(self):
        self.closed = True


# 以本地对象模拟登录态和业务响应，logout 调用可被测试明确发现。
class FakeErp:
    def __init__(self, payloads, config):
        self.client = FakeHttp(payloads)
        self.config = config
        self.cookies = config.get("cookie", "")
        self.user = "tester"

    def __bool__(self):
        raise AssertionError("SDK bool must not be called")

    def logout(self):
        raise AssertionError("SDK logout must not be called")

    def post_api(self, api):
        raise AssertionError("generic SDK write route must not be called")

    def _check_res(self, response):
        pass


def net(*items):
    return {"data": list(items), "total": len(items)}


def exact(goods_id=LONG_ID, sku="sku1"):
    return {"sku_id": sku, "goods_id": goods_id}


# 覆盖会话隔离、精确 SKU 关联、错误脱敏和 JSONL 限制；适配器检查也用替身阻断网络。
class SessionTests(unittest.TestCase):
    def make_session(self, payloads=()):
        clients = []

        def factory(config):
            print(SECRET)
            print(SECRET, file=sys.stderr)
            client = FakeErp(payloads, config)
            clients.append(client)
            return client

        session = Session(factory, factories, "test-adapter", config=TEST_CONFIG)
        session.connect({"cookie": "_wdb=" + SECRET})
        self.addCleanup(session.disconnect)
        return session, clients[0]

    def assert_error(self, code, call):
        with self.assertRaises(WorkerError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(SECRET, caught.exception.message)

    def test_cookie_normalized_disconnect_no_logout(self):
        session, erp = self.make_session()
        self.assertEqual(erp.cookies, SECRET)
        self.assertTrue(session.status()["connected"])
        self.assertFalse(session.disconnect()["connected"])
        self.assertTrue(erp.client.closed)
        self.assertEqual(erp.config, {})
        self.assertEqual(erp.cookies, "")

    def test_business_failure_flags_cannot_become_empty_success(self):
        for flag in ({"success": False}, {"result": False}, {"st": -1}):
            with self.subTest(flag=flag):
                session, _ = self.make_session([{"data": [], "total": 0, **flag}])
                self.assert_error("INVALID_RESPONSE", lambda: session.query_goods("001"))

    def test_password_passed_plaintext_sdk_md5_only(self):
        captured = []
        session = Session(lambda config: captured.append(config.copy()) or FakeErp([], config), factories, "test-adapter", config=TEST_CONFIG)
        self.addCleanup(session.disconnect)
        session.connect({"username": "test", "password": SECRET})
        self.assertEqual(captured[0]["_password"], SECRET)

    def test_invalid_domain_clears_old_session_without_network(self):
        session, erp = self.make_session()
        self.assert_error("INVALID_DOMAIN", lambda: session.connect({"domain": "https://evil.test/", "cookie": SECRET}))
        self.assertFalse(session.status()["connected"])
        self.assertTrue(erp.client.closed)
        self.assertEqual(erp.client.calls, [])

    def test_invalid_credentials_clears_old_session(self):
        session, erp = self.make_session()
        self.assert_error("MISSING_CREDENTIALS", lambda: session.connect({"username": "test"}))
        self.assertTrue(erp.client.closed)
        self.assertFalse(session.status()["connected"])

    def test_failed_constructor_is_safe(self):
        def failing(config):
            raise RuntimeError(SECRET)
        session = Session(failing, factories, "test-adapter", config=TEST_CONFIG)
        self.assert_error("AUTH_FAILED", lambda: session.connect({"cookie": SECRET}))
        self.assertFalse(session.status()["connected"])

    def test_missing_user_fails_and_closes(self):
        client = FakeErp([], {})
        client.user = ""
        session = Session(lambda config: client, factories, "test-adapter", config=TEST_CONFIG)
        self.assert_error("AUTH_FAILED", lambda: session.connect({"cookie": SECRET}))
        self.assertTrue(client.client.closed)

    def test_exact_match_large_ids_quantity_and_only_read_routes(self):
        session, erp = self.make_session([net(exact(sku="sku10"), exact()), {"data": [{"goods_id": LONG_ID, "n": "2.5", "c_name": "GPU", "b_gift": "1"}]}])
        result = session.query_goods("sku1")
        self.assertEqual(result["rows"][0]["goods_id"], LONG_ID)
        self.assertEqual(result["rows"][0]["quantity"], 2.5)
        self.assertTrue(result["rows"][0]["is_gift"])
        self.assertEqual(len(erp.client.calls), 2)
        self.assertEqual(erp.client.calls[1][1]["params"]["goods_id"], LONG_ID)
        self.assertTrue(all(call[1]["follow_redirects"] is False for call in erp.client.calls))

    def test_integer_id_remains_exact_and_float_id_rejected(self):
        session, _ = self.make_session([net(exact(int(LONG_ID))), {"data": [{"id": int(LONG_ID)}]}])
        self.assertEqual(session.query_goods("sku1")["rows"][0]["goods_id"], LONG_ID)
        session, _ = self.make_session([net(exact(float(LONG_ID)))])
        self.assert_error("INVALID_RESPONSE", lambda: session.query_goods("sku1"))

    def test_multishop_same_link_is_allowed(self):
        session, _ = self.make_session([net(exact(), exact()), {"data": [{"id": LONG_ID}]}])
        self.assertEqual(len(session.query_goods("sku1")["rows"]), 1)

    def test_multishop_distinct_link_is_ambiguous(self):
        session, erp = self.make_session([net(exact(), exact("other"))])
        self.assert_error("AMBIGUOUS", lambda: session.query_goods("sku1"))
        self.assertEqual(len(erp.client.calls), 1)

    def test_nonexact_match_returns_known_empty(self):
        session, erp = self.make_session([net(exact(sku="sku10"))])
        self.assertEqual(session.query_goods("sku1")["rows"], [])
        self.assertEqual(len(erp.client.calls), 1)

    def test_unlinked_and_missing_sku_are_explicit(self):
        for payload, code in [(net(exact("")), "NOT_LINKED"), (net({"goods_id": LONG_ID}), "INVALID_RESPONSE")]:
            session, _ = self.make_session([payload])
            self.assert_error(code, lambda: session.query_goods("sku1"))

    def test_single_product_fallback(self):
        session, erp = self.make_session([net(exact()), {"data": []}, {"data": [{"id": LONG_ID, "c_sku": "part1"}]}])
        self.assertEqual(session.query_goods("sku1")["rows"][0]["quantity"], 1)
        self.assertEqual(erp.client.calls[2][0], DOMAIN + "pages/basgoods/searchNetSalesGoodsList.htm")

    def test_missing_or_different_product_not_fake_success(self):
        for payload in [{"data": []}, {"data": [{"id": "other"}]}]:
            session, _ = self.make_session([net(exact()), {"data": []}, payload])
            self.assert_error("INVALID_RESPONSE", lambda: session.query_goods("sku1"))

    def test_result_limits_and_incomplete_results(self):
        cases = [("TOO_MANY_RESULTS", {"data": [], "total": 501}),
                 ("INCOMPLETE_RESULTS", {"data": [], "total": 1}),
                 ("INVALID_RESPONSE", {"data": []}),
                 ("INVALID_RESPONSE", {"total": 0}),
                 ("QUERY_FAILED", {"data": [], "total": 0, "code": -1})]
        for code, payload in cases:
            session, _ = self.make_session([payload])
            self.assert_error(code, lambda: session.query_goods("sku1"))
        session, _ = self.make_session([net(exact()), {"data": [{"id": LONG_ID}] * 501}])
        self.assert_error("TOO_MANY_RESULTS", lambda: session.query_goods("sku1"))

    def test_invalid_quantities_never_become_nan(self):
        for value in ["NaN", "Infinity", True, -1, None]:
            session, _ = self.make_session([net(exact()), {"data": [{"id": LONG_ID, "n": value}]}])
            self.assert_error("INVALID_RESPONSE", lambda: session.query_goods("sku1"))

    def test_expired_or_unknown_errors_clear_session_safely(self):
        for failure, code in [(AssertionError("账号没有登录 " + SECRET), "SESSION_EXPIRED"), (RuntimeError(SECRET), "QUERY_FAILED")]:
            session, erp = self.make_session([failure])
            self.assert_error(code, lambda: session.query_goods("sku1"))
            self.assertFalse(session.status()["connected"])
            self.assertTrue(erp.client.closed)

    def test_network_error_is_classified(self):
        import httpx
        session, _ = self.make_session([httpx.ConnectError(SECRET)])
        self.assert_error("NETWORK_ERROR", lambda: session.query_goods("sku1"))

    # 回归 stdout 泄露与 EOF 清理：协议只能输出信封，不能带出模拟 SDK 的秘密文本。
    def test_serve_secret_suppression_and_eof_close(self):
        session, erp = self.make_session([net(exact()), {"data": [{"id": LONG_ID}]}])
        lines = [{"id": "a", "action": "query_goods", "sku": "sku1"}, {"id": "b", "action": "write", "password": SECRET}]
        output = io.StringIO()
        serve(io.BytesIO(b"\n".join(json.dumps(line).encode() for line in lines) + b"\n"), output, session)
        text = output.getvalue()
        self.assertNotIn(SECRET, text)
        responses = [json.loads(line) for line in text.splitlines()]
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[1]["error"]["code"], "UNKNOWN_ACTION")
        self.assertTrue(erp.client.closed)

    def test_protocol_recovers_after_bad_json_and_oversized_line(self):
        session = Session(version="test-adapter", config=TEST_CONFIG)
        output = io.StringIO()
        content = b"bad json\n" + b"x" * (MAX_INPUT + 500) + b'\n{"id":"ok","action":"status"}\n'
        serve(io.BytesIO(content), output, session)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item.get("error", {}).get("code") for item in responses], ["INVALID_REQUEST", "INPUT_TOO_LARGE", None])
        self.assertEqual(responses[-1]["id"], "ok")

    def test_protocol_output_limit(self):
        session, _ = self.make_session([net(exact()), {"data": [{"id": LONG_ID, "c_name": "字" * 800000}]}])
        output = io.StringIO()
        serve(io.BytesIO(b'{"id":"a","action":"query_goods","sku":"sku1"}\n'), output, session)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "OUTPUT_TOO_LARGE")

    # 本机配置缺失时，连接在凭据交给适配器之前就被拒绝；状态仍可离线读取。
    def test_missing_configuration_does_not_invoke_adapter(self):
        factory = unittest.mock.Mock()
        session = Session(factory, factories, "test-adapter", config={})
        self.assertFalse(session.status()["connected"])
        self.assert_error("ERP_NOT_CONFIGURED", lambda: session.connect({"cookie": SECRET}))
        factory.assert_not_called()

    # 示例 HTTPS 根地址有效，危险地址与过大配置在离线解析阶段被拒绝。
    def test_configuration_https_validation(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "integrations.json"
            with patch.dict("os.environ", {"DIYTOOLS_INTEGRATIONS": str(path)}):
                self.assertEqual(local_erp_config(), {})
                for domain in ["http://erp.example.test", "https://user@erp.example.test", "https://erp.example.test/path", "https://erp.example.test?q=1", "https://erp.example.test#x"]:
                    path.write_text(json.dumps({"version": 1, "erp": {"domain": domain}}), encoding="utf-8")
                    self.assert_error("ERP_CONFIG_INVALID", local_erp_config)
                path.write_text(json.dumps({"version": 1, "erp": {"domain": DOMAIN}}), encoding="utf-8")
                self.assertEqual(local_erp_config()["domain"], DOMAIN)
                path.write_text("x" * (64 * 1024 + 1), encoding="utf-8")
                self.assert_error("ERP_CONFIG_INVALID", local_erp_config)

    # 公开 worker 只加载本机可选插件接口，不导入任何私有 ERP 包。
    def test_external_adapter_contract(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "erp-adapter.py"
            self.assert_error("PACKAGE_UNAVAILABLE", lambda: load_adapter({"adapter_path": path}))
            path.write_text("def create_client(config, *, domain): return config\ndef api_factories(): return ()\n", encoding="utf-8")
            adapter = load_adapter({"adapter_path": path})
            self.assertEqual(adapter.create_client({"sample": True}, domain=DOMAIN), {"sample": True})
            self.assertEqual(adapter.api_factories(), ())


if __name__ == "__main__":
    unittest.main()
