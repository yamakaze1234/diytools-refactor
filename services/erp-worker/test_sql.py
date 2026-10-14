# SQL 规范化、凭据保险库及 JSONL 边界测试；查询使用假连接，Windows DPAPI 使用隔离凭据文件验证。
"""Offline SQL fixtures and real Windows DPAPI; never contact a database."""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sql_credentials as vault
import sql_service as sql
from main import MAX_OUTPUT, MAX_SQL_OUTPUT, serve
from session import Session, WorkerError

SECRET = "isolated-test-private-password"
CONFIG = {"server": "test.invalid", "database": "isolated", "user": "fake"}


def warehouse(**updates):
    row = {"goods_id": "9007199254740993123", "库房": "公司大库", "商品编码": "sku", "商品名称": "机箱",
           "分库数": 10, "分库可销数": 8, "分库待入": None, "库存成本": 20}
    row.update(updates)
    return row


def catalog(**updates):
    row = {"goods_id": "9007199254740993123", "商品编码": "sku", "商品名称": "机箱", "总数量": 10, "可销数": 8, "待入": None}
    row.update(updates)
    return row


def bundle():
    return {"warehouses": [warehouse()], "catalog": [catalog()]}


# 模拟固定 SQL 查询与分页读取，记录执行语句并检查关闭资源。
class FakeConnection:
    def __init__(self, groups):
        self.groups, self.queries, self.closed = groups, [], False
    def cursor(self):
        return self
    def execute(self, query):
        self.queries.append(query)
        self.current = iter(self.groups[len(self.queries) - 1])
    def fetchmany(self, size):
        return next(self.current, [])
    def close(self):
        self.closed = True


# 合成两张库存视图验证身份、编码和未知值规则，同时检查查询仅使用固定 SELECT。
class SqlTests(unittest.TestCase):
    def test_settings_validation_and_normalization(self):
        normalized = sql.settings({**CONFIG, "port": "1433", "server": " test.invalid "})
        self.assertEqual(normalized, {**CONFIG, "port": 1433, "encrypt": True, "trustServerCertificate": False})
        for change in ({"port": True}, {"port": 0}, {"port": 65536}, {"port": 1.5}, {"port": ""},
                       {"encrypt": "false"}, {"trustServerCertificate": 1}, {"user": " "}):
            with self.subTest(change=change), self.assertRaises(sql.SqlError) as raised:
                sql.settings({**CONFIG, **change})
            self.assertEqual(raised.exception.code, "INVALID_REQUEST")

    def test_exact_identity_company_warehouse_and_unknown(self):
        rows = sql.normalize({"warehouses": [warehouse(), warehouse(goods_id="2", 商品编码="b", 库房="外库")],
                              "catalog": [catalog(), catalog(goods_id="2", 商品编码="b"), catalog(goods_id="3", 商品编码="c")]})
        self.assertEqual(rows[0], {"goodsId": "9007199254740993123", "sku": "sku", "name": "机箱", "stockAvailable": 8.0, "erp": 20.0})
        self.assertIsNone(rows[1]["erp"])
        self.assertIsNone(rows[1]["stockAvailable"])
        self.assertIsNone(rows[2]["stockAvailable"])
        nulls = sql.normalize({"warehouses": [warehouse(分库可销数=None, 库存成本=None)], "catalog": [catalog()]})
        self.assertIsNone(nulls[0]["erp"])
        zeros = sql.normalize({"warehouses": [warehouse(分库可销数=0, 库存成本=0)], "catalog": [catalog()]})
        self.assertEqual((zeros[0]["stockAvailable"], zeros[0]["erp"]), (0, 0))

    def test_integrity_failures_never_produce_rows(self):
        invalid = [None, {"warehouses": [], "catalog": []}, {"warehouses": [None], "catalog": [catalog()]},
                   {"warehouses": [warehouse(), warehouse()], "catalog": [catalog()]},
                   {"warehouses": [], "catalog": [catalog(), catalog()]},
                   {"warehouses": [warehouse()], "catalog": [catalog(商品编码="other")]},
                   {"warehouses": [warehouse(goods_id=1.5)], "catalog": [catalog()]},
                   {"warehouses": [warehouse(库存成本=-1)], "catalog": [catalog()]},
                   {"warehouses": [warehouse(分库可销数=float('nan'))], "catalog": [catalog()]},
                   {"warehouses": [warehouse(分库可销数=True)], "catalog": [catalog()]},
                   {"warehouses": [warehouse(商品名称=b'\xff')], "catalog": [catalog()]}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(sql.SqlError):
                sql.normalize(value)

    def test_legacy_encoding_is_preserved(self):
        raw = warehouse()
        for key in ('库房', '商品名称'):
            raw[key] = raw[key].encode('gb18030').decode('latin1')
        result = sql.normalize({"warehouses": [raw], "catalog": [catalog()]})
        self.assertEqual(result[0]['name'], '机箱')
        self.assertEqual(result[0]['stockAvailable'], 8)

    def test_only_fixed_readonly_selects_and_close(self):
        connection = FakeConnection([[[warehouse()]], [[catalog()]]])
        captured = {}
        def connector(**values):
            captured.update(values)
            return connection
        self.assertEqual(sql.read_bundle(CONFIG, SECRET, connector), bundle())
        self.assertEqual(connection.queries, sql.QUERIES)
        self.assertTrue(all(query.startswith('SELECT TOP (100001)') for query in connection.queries))
        self.assertTrue(captured['readonly'])
        self.assertTrue(captured['autocommit'])
        self.assertFalse(captured['pooling'])
        self.assertFalse(captured['disable_connect_retry'] is False)
        self.assertTrue(captured['validate_host'])
        self.assertTrue(connection.closed)
        self.assertFalse(sql._tls_settings.trust)

    def test_exact_limit_and_sentinel_rejected(self):
        connection = FakeConnection([[[warehouse()] * 100000], [[catalog()]]])
        self.assertEqual(len(sql.read_bundle(CONFIG, SECRET, lambda **_: connection)['warehouses']), 100000)
        connection = FakeConnection([[[warehouse()] * 100001], [[catalog()]]])
        with self.assertRaises(sql.SqlError) as raised:
            sql.read_bundle(CONFIG, SECRET, lambda **_: connection)
        self.assertEqual(raised.exception.code, 'SQL_TOO_MANY_RESULTS')
        self.assertEqual(len(connection.queries), 1)
        self.assertTrue(connection.closed)

    def test_redacted_driver_error_categories(self):
        for error, code in [(TimeoutError(SECRET), 'SQL_TIMEOUT'), (Exception('certificate ' + SECRET), 'SQL_CERTIFICATE'),
                            (Exception('login failed ' + SECRET), 'SQL_LOGIN'), (Exception(SECRET), 'SQL_CONNECTION')]:
            def connector(**_):
                raise error
            with self.subTest(code=code), self.assertRaises(sql.SqlError) as raised:
                sql.read_bundle(CONFIG, SECRET, connector)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn(SECRET, str(raised.exception))
        for number, code in [(4060, 'SQL_DATABASE'), (207, 'SQL_SCHEMA'), (18456, 'SQL_LOGIN')]:
            error = Exception(SECRET)
            error.number = number
            with self.assertRaises(sql.SqlError) as raised:
                sql.read_bundle(CONFIG, SECRET, lambda **_: (_ for _ in ()).throw(error))
            self.assertEqual(raised.exception.code, code)

    def test_tls_trust_is_thread_local_and_reset(self):
        observed = []
        def connector(**values):
            observed.append((sql._tls_settings.trust, values['validate_host'], values['cafile']))
            return FakeConnection([[[warehouse()]], [[catalog()]]])
        sql.read_bundle({**CONFIG, 'trustServerCertificate': True, 'encrypt': False}, SECRET, connector)
        sql.read_bundle(CONFIG, SECRET, connector)
        self.assertEqual(observed[0], (True, False, None))
        self.assertEqual(observed[1][:2], (False, True))
        self.assertFalse(sql._tls_settings.trust)


# 在隔离目录验证真实 DPAPI 和协议顺序，任何无效读取或输出超限都不能改变原凭据。
class VaultAndProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[2] / 'sandbox' / 'sql-worker-tests'
        cls.root.mkdir(parents=True, exist_ok=True)
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(dir=self.root))
        self.path = self.directory / 'connection.dpapi.json'
        self.environment = patch.dict(os.environ, {'DIYTOOLS_SQL_VAULT': str(self.path)})
        self.environment.start()
    def tearDown(self):
        self.environment.stop()

    @unittest.skipUnless(os.name == 'nt', 'real Windows DPAPI')
    def test_real_dpapi_roundtrip_tombstone_and_no_plaintext(self):
        self.assertEqual(vault.load(), {'saved': False, 'settings': None, 'password': ''})
        vault.save(CONFIG, SECRET)
        value = vault.load()
        self.assertEqual(value['password'], SECRET)
        self.assertEqual(value['settings'], sql.settings(CONFIG))
        self.assertNotIn(SECRET, self.path.read_text())
        self.assertNotIn(CONFIG['server'], self.path.read_text())
        vault.clear()
        self.assertTrue(self.path.exists())
        self.assertEqual(vault.load()['saved'], False)
        self.assertNotIn('ciphertext', self.path.read_text())

    # 模拟最终替换失败，确认原凭据文件内容仍完整保留。
    @unittest.skipUnless(os.name == 'nt', 'real Windows DPAPI')
    def test_failed_atomic_replace_keeps_original(self):
        vault.save(CONFIG, SECRET)
        before = self.path.read_bytes()
        with patch('sql_credentials.os.replace', side_effect=OSError(SECRET)), self.assertRaises(sql.SqlError):
            vault.save(CONFIG, 'replacement-private-password')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(vault.load()['password'], SECRET)
        with patch('sql_credentials.os.replace', side_effect=OSError(SECRET)), self.assertRaises(sql.SqlError):
            vault.clear()
        self.assertEqual(self.path.read_bytes(), before)

    @unittest.skipUnless(os.name == 'nt', 'real Windows DPAPI')
    def test_corrupt_vault_and_dpapi_error_redacted(self):
        self.path.write_text('{"ciphertext":"' + SECRET + '"}')
        with self.assertRaises(sql.SqlError) as raised:
            vault.load()
        self.assertNotIn(SECRET, str(raised.exception))
        with self.assertRaises(sql.SqlError) as raised:
            vault.dpapi(SECRET.encode())
        self.assertNotIn(SECRET, str(raised.exception))

    def test_request_cannot_select_vault_file(self):
        outside = self.directory / 'untrusted.json'
        result = Session(version='offline').handle({'id': 'x', 'action': 'sql_credentials_clear', 'path': str(outside)})
        self.assertFalse(result['saved'])
        self.assertTrue(self.path.exists())
        self.assertFalse(outside.exists())
        with patch.dict(os.environ, {'DIYTOOLS_SQL_VAULT': ''}), self.assertRaises(sql.SqlError):
            vault.load()

    def test_invalid_or_failed_query_never_mutates_vault(self):
        request = {'id': 'x', 'action': 'sql_read', 'settings': CONFIG, 'password': SECRET, 'remember': True}
        with patch('sql_service.read_bundle') as read, patch('sql_credentials.save') as save, patch('sql_credentials.clear') as clear:
            with self.assertRaises(WorkerError):
                Session(version='offline').handle({**request, 'remember': 'true'})
            read.assert_not_called()
            read.side_effect = sql.SqlError('safe failure', 'SQL_TIMEOUT')
            with self.assertRaises(WorkerError):
                Session(version='offline').handle(request)
            read.side_effect = None
            read.return_value = {'warehouses': [], 'catalog': []}
            with self.assertRaises(WorkerError):
                Session(version='offline').handle(request)
            save.assert_not_called()
            clear.assert_not_called()

    def test_save_or_clear_only_after_success_and_normalize(self):
        for remember in (False, True):
            order = []
            request = {'id': 'x', 'action': 'sql_read', 'settings': CONFIG, 'password': SECRET, 'remember': remember}
            with patch('sql_service.read_bundle', side_effect=lambda *_: order.append('read') or bundle()), \
                 patch('sql_credentials.save', side_effect=lambda *_: order.append('save')), \
                 patch('sql_credentials.clear', side_effect=lambda: order.append('clear')):
                result = Session(version='offline').handle(request)
            self.assertEqual(order, ['read', 'save' if remember else 'clear'])
            self.assertEqual(result['settings'], sql.settings(CONFIG))
            self.assertEqual(result['rows'][0]['erp'], 20)

    def test_output_oversize_never_changes_saved_connection(self):
        request = {'id': 'x', 'action': 'sql_read', 'settings': CONFIG, 'password': SECRET, 'remember': True}
        with patch('sql_service.read_bundle', return_value=bundle()), \
             patch('sql_service.normalize', return_value=[{'name': 'x' * MAX_SQL_OUTPUT}]), \
             patch('sql_credentials.save') as save, patch('sql_credentials.clear') as clear:
            with self.assertRaises(WorkerError) as raised:
                Session(version='offline').handle(request)
            self.assertEqual(raised.exception.code, 'OUTPUT_TOO_LARGE')
            save.assert_not_called()
            clear.assert_not_called()

    def test_sql_only_has_larger_jsonl_output_limit(self):
        class FakeSession:
            def handle(self, request):
                return {'rows': ['x' * (MAX_OUTPUT + 100)]}
            def disconnect(self):
                pass
        for action, expected in [('sql_read', True), ('status', False), ('sql_credentials_load', False)]:
            output = io.StringIO()
            serve(io.BytesIO(json.dumps({'id': 'test', 'action': action}).encode()), output, FakeSession())
            response = json.loads(output.getvalue())
            self.assertEqual(response['ok'], expected)


if __name__ == '__main__':
    unittest.main()
