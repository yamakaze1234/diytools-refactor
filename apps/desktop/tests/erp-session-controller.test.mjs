import test from 'node:test';
import assert from 'node:assert/strict';
import { createErpSessionController } from '../src/erp-session-controller.ts';

const connected = { connected: true, user: '测试账号', domain: "https://erp.example.test/", package_version: '1.0' };
const result = sku => ({ sku, rows: [{ goods_id: '1', quantity: 0, code: '001', name: '测试商品', is_gift: false }], queried_at: '2026-10-12T12:00:00+08:00' });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(request, desktop = true) {
  const calls = [], states = [];
  const controller = createErpSessionController({ desktop, onState: state => states.push(state), request: input => { calls.push(input); return request(input); } });
  return { controller, calls, states };
}
test('status begins unknown, checks without credentials, and permits later query', async () => {
  const flight = deferred(); const f = fixture(() => flight.promise);
  assert.equal(f.controller.state.session, null);
  const operation = f.controller.status(); assert.equal(f.controller.state.session, null);
  assert.deepEqual(f.calls, [{ action: 'status' }]);
  flight.resolve(connected); await operation; assert.equal(f.controller.state.session.connected, true);
});
test('text SKU preserves leading zeros and clears results as soon as input changes', async () => {
  const f = fixture(async input => input.action === 'query_goods' ? result(input.sku) : connected);
  await f.controller.status(); f.controller.setSku(' 000123 '); await f.controller.query();
  assert.deepEqual(f.calls.at(-1), { action: 'query_goods', sku: '000123' });
  assert.equal(f.controller.state.result.sku, '000123'); assert.equal(f.controller.state.result.rows[0].quantity, 0);
  f.controller.setSku('000124'); assert.equal(f.controller.state.result, null);
});
test('query retry failure clears earlier successful result and preserves safe failure', async () => {
  let fail = false; const f = fixture(async input => { if (input.action !== 'query_goods') return connected; if (fail) throw Error('查询失败，请重新连接。'); return result(input.sku); });
  await f.controller.status(); f.controller.setSku('001'); await f.controller.query();
  fail = true; await f.controller.query(); assert.equal(f.controller.state.result, null); assert.equal(f.controller.state.session, null); assert.match(f.controller.state.error, /查询失败/);
});
test('query cannot run disconnected or with blank SKU', async () => {
  const f = fixture(async () => connected);
  f.controller.setSku('001'); await f.controller.query(); assert.equal(f.calls.length, 0);
  await f.controller.status(); f.controller.setSku('  '); await f.controller.query();
  assert.equal(f.calls.length, 1); assert.match(f.controller.state.error, /请输入/);
});
test('pending operations prevent concurrent status, connect, disconnect, and query', async () => {
  const flight = deferred(); const f = fixture(() => flight.promise);
  const operation = f.controller.status();
  await f.controller.status(); await f.controller.connect({ username: 'test', password: 'secret' }); await f.controller.disconnect(); await f.controller.query();
  assert.equal(f.calls.length, 1); flight.resolve(connected); await operation;
});
test('changed SKU invalidates an in-flight result and its late errors', async () => {
  const flight = deferred(); const f = fixture(input => input.action === 'query_goods' ? flight.promise : Promise.resolve(connected));
  await f.controller.status(); f.controller.setSku('001'); const operation = f.controller.query(); f.controller.setSku('002');
  flight.resolve(result('001')); await operation;
  assert.equal(f.controller.state.result, null); assert.equal(f.controller.state.sku, '002'); assert.equal(f.controller.state.busy, null);
});
test('response SKU mismatch never labels unrelated rows as requested SKU', async () => {
  const f = fixture(async input => input.action === 'query_goods' ? result('999') : connected);
  await f.controller.status(); f.controller.setSku('001'); await f.controller.query();
  assert.equal(f.controller.state.result, null); assert.match(f.controller.state.error, /不一致/);
});
test('late failure after SKU changes still marks worker connection unconfirmed', async () => {
  const flight = deferred(); const f = fixture(input => input.action === 'query_goods' ? flight.promise : Promise.resolve(connected));
  await f.controller.status(); f.controller.setSku('001'); const operation = f.controller.query(); f.controller.setSku('002');
  flight.reject(Error('查询已超时。')); await operation;
  assert.equal(f.controller.state.session, null); assert.equal(f.controller.state.result, null); assert.equal(f.controller.state.error, '');
});
test('failed reconnect clears session/results and neither stores nor reveals credentials', async () => {
  const f = fixture(async input => { if (input.action === 'connect') throw Error(`连接失败 secret-pass ${input.cookie || ''}`); return input.action === 'query_goods' ? result(input.sku) : connected; });
  await f.controller.status(); f.controller.setSku('001'); await f.controller.query();
  await f.controller.connect({ username: 'test', password: 'secret-pass' });
  assert.equal(f.controller.state.session, null); assert.equal(f.controller.state.result, null);
  assert.equal(Object.hasOwn(f.calls.at(-1), "domain"), false); assert.equal(JSON.stringify(f.states).includes('secret-pass'), false);
  await f.controller.connect({ cookie: 'full-cookie' }); assert.equal(JSON.stringify(f.states).includes('full-cookie'), false);
});
test('disconnect failure clears previous connected proof and results; success reports disconnected', async () => {
  let fail = true; const f = fixture(async input => { if (input.action === 'disconnect') { if (fail) throw Error('断开失败，请刷新状态。'); return { ...connected, connected: false, user: null }; } return input.action === 'query_goods' ? result(input.sku) : connected; });
  await f.controller.status(); f.controller.setSku('001'); await f.controller.query(); await f.controller.disconnect();
  assert.equal(f.controller.state.result, null); assert.equal(f.controller.state.session, null);
  fail = false; await f.controller.disconnect(); assert.equal(f.controller.state.session.connected, false);
});
test('unmount ignores pending results without disconnecting worker; new controller reads status', async () => {
  const flight = deferred(); const f = fixture(() => flight.promise); const operation = f.controller.status();
  f.controller.dispose(); const count = f.states.length; flight.resolve(connected); await operation;
  await f.controller.disconnect(); await f.controller.connect({ cookie: 'cookie' });
  assert.equal(f.calls.length, 1); assert.equal(f.states.length, count);
  const next = fixture(async () => connected); await next.controller.status(); assert.equal(next.controller.state.session.connected, true);
});
test('browser preview performs no native operation', async () => {
  const f = fixture(() => assert.fail('browser must not invoke'), false);
  await f.controller.status(); await f.controller.connect({ username: 'test', password: 'secret' });
  f.controller.setSku('001'); await f.controller.query(); await f.controller.disconnect();
  assert.equal(f.calls.length, 0); assert.equal(f.controller.state.session, null);
});
test('empty query response is a successful empty result and malformed credentials never invoke', async () => {
  const f = fixture(async input => input.action === 'query_goods' ? { ...result(input.sku), rows: [] } : connected);
  await f.controller.connect({ username: '', password: '' }); assert.equal(f.calls.length, 0);
  await f.controller.status(); f.controller.setSku('001'); await f.controller.query();
  assert.deepEqual(f.controller.state.result.rows, []); assert.equal(f.controller.state.error, '');
});

// 未安装运行时必须显示可操作的本机接入提示，同时不能把错误原文泄露到页面。
test('missing optional runtime explains local setup without exposing server details', async () => {
 const env = fixture(async () => { throw Error('ERP_RUNTIME_UNAVAILABLE: underlying details'); });
 await env.controller.status();
 assert.match(env.controller.state.error, /本机未安装 ERP 可选运行时/);
 assert(!env.controller.state.error.includes('underlying details'));
});
