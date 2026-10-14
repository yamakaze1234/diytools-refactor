import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdaterAccessController } from '../src/updater-access-controller.ts';

test('token passes only to native save and never appears in emitted state', async () => {
  const calls = [], states = [];
  const controller = createUpdaterAccessController({ invoke: async (command, args) => { calls.push({ command, args }); return { configured: true, source: 'credential' }; }, onState: state => states.push(state) });
  assert.equal(await controller.save('  memory-only-token  '), true);
  assert.deepEqual(calls, [{ command: 'updater_access_save', args: { token: 'memory-only-token' } }]);
  assert.equal(JSON.stringify(states).includes('memory-only-token'), false);
  assert.equal(controller.status().status.source, 'credential');
});

test('raw native errors cannot echo a token and synchronous failures remain retryable', async () => {
  let fail = true;
  const controller = createUpdaterAccessController({ invoke: () => { if (fail) throw Error('request memory-only-token'); return Promise.resolve({ configured: false, source: 'none' }); }, onState() {} });
  assert.equal(await controller.save('memory-only-token'), false);
  assert.equal(controller.status().error.includes('memory-only-token'), false);
  fail = false; assert.equal(await controller.refresh(), true);
});

test('blank token does not save; clear can reveal reusable gh authorization', async () => {
  const calls = [];
  const controller = createUpdaterAccessController({ invoke: async command => { calls.push(command); return { configured: true, source: 'gh' }; }, onState() {} });
  assert.equal(await controller.save('  '), false); assert.equal(calls.length, 0);
  assert.equal(await controller.clear(), true); assert.deepEqual(calls, ['updater_access_clear']);
  assert.equal(controller.status().status.source, 'gh');
});

test('pending access request blocks overlapping mutation and disposal ignores late status', async () => {
  let resolve; const wait = new Promise(done => { resolve = done; }); const states = [], calls = [];
  const controller = createUpdaterAccessController({ invoke: command => { calls.push(command); return wait; }, onState: state => states.push(state) });
  const request = controller.refresh(); assert.equal(await controller.save('secret'), false);
  controller.dispose(); const count = states.length; resolve({ configured: true, source: 'gh' }); await request;
  assert.deepEqual(calls, ['updater_access_status']); assert.equal(states.length, count);
});
