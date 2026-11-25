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


def catalog(**updates):
    row = {"goods_id": "9007199254740993123", "商品编码": "sku", "商品名称": "机箱", "总数量": 10, "可销数": 8, "待入": 7, "最终可销": 8, "待入可销": 15, "单价成本": 20, "encoding_probe": "中文"}
    row.update(updates)
    return row


def bundle():
    return {"catalog": [catalog()]}


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


# 合成库存目录验证身份、编码和未知值规则，同时检查查询仅使用固定 SELECT。
class SqlTests(unittest.TestCase):
    def test_native_sellable_fields_and_zero_stock_cost(self):
        for cost, final, incoming in [(33, 0, 9), (0, -8, -2), (None, None, None)]:
            with self.subTest(cost=cost, final=final, incoming=incoming):
                result = sql.normalize({'catalog': [catalog(单价成本=cost, 最终可销=final, 待入可销=incoming)]})[0]
                self.assertEqual((result['erp'], result['stockAvailable'], result['stockIncomingAvailable']),
                                 (cost, final, incoming))
                self.assertEqual(result['goodsId'], "9007199254740993123")

    def test_cost_invalid_is_unknown_without_affecting_stock(self):
        for value in [-1, float('nan'), float('inf'), True, '', 'bad']:
            row = sql.normalize({'catalog': [catalog(单价成本=value)]})[0]
            self.assertIsNone(row['erp'])
            self.assertEqual(row['stockAvailable'], 8)

    def test_settings_validation_and_normalization(self):
        normalized = sql.settings({**CONFIG, "port": "1433", "server": " test.invalid "})
        self.assertEqual(normalized, {**CONFIG, "port": 1433, "encrypt": True, "trustServerCertificate": False})
        for change in ({"port": True}, {"port": 0}, {"port": 65536}, {"port": 1.5}, {"port": ""},
                       {"encrypt": "false"}, {"trustServerCertificate": 1}, {"user": " "}):
            with self.subTest(change=change), self.assertRaises(sql.SqlError) as raised:
                sql.settings({**CONFIG, **change})
            self.assertEqual(raised.exception.code, "INVALID_REQUEST")

    def test_integrity_failures_never_produce_rows(self):
        invalid = [[], [None], [catalog(), catalog()], [catalog(), catalog(goods_id='2')],
                   [catalog(goods_id=1.5)], [catalog(最终可销=float('nan'))],
                   [catalog(待入可销=True)], [catalog(商品名称=b'\xff')],
                   [{k:v for k,v in catalog().items() if k!='待入可销'}]]
        for rows in invalid:
            with self.subTest(rows=rows), self.assertRaises(sql.SqlError):
                sql.normalize({'catalog': rows})

    def test_legacy_encoding_is_preserved(self):
        legacy = lambda s: s.encode('gb18030').decode('latin1')
        row = catalog(商品编码=legacy('板-1'), 商品名称=legacy('机箱'), encoding_probe=legacy('中文'))
        result = sql.normalize({'catalog': [row]})[0]
        self.assertEqual((result['name'], result['sku']), ('机箱', '板-1'))
        del row['encoding_probe']
        self.assertEqual(sql.normalize({'catalog': [row]})[0]['name'], '机箱')
        self.assertEqual(sql.normalize({'catalog': [catalog(商品名称='Café') ]})[0]['name'], 'Café')

    def test_only_fixed_readonly_selects_and_close(self):
        connection = FakeConnection([[[catalog()]]])
        captured = {}
        def connector(**values):
            captured.update(values)
            return connection
        self.assertEqual(sql.read_bundle(CONFIG, SECRET, connector), bundle())
        self.assertEqual(connection.queries, [sql.CATALOG_QUERY])
        self.assertIn('FROM [库存].[库存查询]', connection.queries[0])
        self.assertNotIn('分库库存', connection.queries[0])
        self.assertTrue(all(query.startswith('SELECT TOP (100001)') for query in connection.queries))
        self.assertTrue(captured['readonly'])
        self.assertTrue(captured['autocommit'])
        self.assertFalse(captured['pooling'])
        self.assertFalse(captured['disable_connect_retry'] is False)
        self.assertTrue(captured['validate_host'])
        self.assertTrue(connection.closed)
        self.assertFalse(sql._tls_settings.trust)

    def test_exact_limit_and_sentinel_rejected(self):
        connection = FakeConnection([[[catalog()] * 100000]])
        self.assertEqual(len(sql.read_bundle(CONFIG, SECRET, lambda **_: connection)['catalog']), 100000)
        connection = FakeConnection([[[catalog()] * 100001]])
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
            return FakeConnection([[[catalog()]]])
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
            read.return_value = {'catalog': []}
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

    def test_nas_reuses_saved_read_only_connection_without_vault_mutation(self):
        session = Session(version='offline')
        request = {'id': 'x', 'action': 'sql_read_nas', 'remember': False, 'password': 'false-credential'}
        with patch('sql_credentials.load', return_value={'saved': True, 'settings': CONFIG, 'password': SECRET}), \
             patch('sql_service.read_bundle', return_value=bundle()) as read, \
             patch('sql_credentials.save') as save, patch('sql_credentials.clear') as clear:
            result = session.handle(request)
            read.assert_called_once_with(CONFIG, SECRET)
            self.assertEqual(set(result), {'rows'})
            self.assertEqual(result['rows'][0]['stockAvailable'], 8)
            save.assert_not_called()
            clear.assert_not_called()

        # 未配置与当前 Windows 用户无法解密不同；无封套时也不能触发 SQL 查询。
        with patch('sql_credentials.load', return_value={'saved': False}), patch('sql_service.read_bundle') as read:
            with self.assertRaises(WorkerError) as missing:
                session.handle(request)
            self.assertEqual(missing.exception.code, 'SQL_CREDENTIALS_NOT_SAVED')
            read.assert_not_called()

    def test_nas_form_does_not_return_password_or_clear_a_saved_connection(self):
        session = Session(version='offline')
        with patch('sql_credentials.load', return_value={'saved': True, 'settings': CONFIG, 'password': SECRET}):
            self.assertEqual(session.handle({'id': 'status', 'action': 'sql_credentials_status'}), {'saved': True, 'settings': CONFIG})
        for remember in (False, True):
            request = {'id': 'form', 'action': 'sql_read_nas_form', 'settings': CONFIG, 'password': SECRET, 'remember': remember}
            # 只有已验证的成功查询才写当前 NAS 档案，取消保存不会清掉之前凭据。
            with patch('sql_service.read_bundle', return_value=bundle()) as read, \
                 patch('sql_credentials.save') as save, patch('sql_credentials.clear') as clear:
                result = session.handle(request)
                read.assert_called_once_with(sql.settings(CONFIG), SECRET)
                self.assertEqual(set(result), {'rows', 'settings'})
                self.assertEqual(save.call_count, int(remember))
                clear.assert_not_called()
                read.side_effect = sql.SqlError('network', 'SQL_CONNECTION')
                with self.assertRaises(WorkerError):
                    session.handle(request)
                self.assertEqual(save.call_count, int(remember))
                clear.assert_not_called()

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
