import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchCloseController } from '../src/legacy/close-controller.ts';

function event() { return { prevented: false, preventDefault() { this.prevented = true; } }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('failed save blocks native close and reports visible failure', async () => {
  let closes = 0;
  const pending = [], errors = [];
  const workbench = { workbenchBeforeQuit: async () => { throw Error('恢复草稿也未保存'); } };
  const controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => { closes++; }, onPending: value => pending.push(value), onError: value => errors.push(value) });
  const request = event(); await controller.handle(request);
  assert.equal(request.prevented, true); assert.equal(closes, 0);
  assert.deepEqual(pending, [true, false]); assert.deepEqual(errors, ['恢复草稿也未保存']);
  assert.equal(controller.pending, false);
});

test('awaits save once, blocks duplicate close, then permits only confirmed native reentry', async () => {
  const save = deferred(); let saves = 0, closes = 0;
  const workbench = { workbenchBeforeQuit: async () => { saves++; await save.promise; } };
  let controller, reentry;
  controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => { closes++; reentry = event(); await controller.handle(reentry); },
    onPending: () => {}, onError: error => assert.fail(error) });
  const first = event(); const flight = controller.handle(first);
  const duplicate = event(); await controller.handle(duplicate);
  assert.equal(first.prevented, true); assert.equal(duplicate.prevented, true);
  assert.equal(saves, 1); assert.equal(closes, 0);
  save.resolve(); await flight;
  assert.equal(closes, 1); assert.equal(reentry.prevented, false);
  assert.equal(controller.pending, true, 'editing remains locked until native destruction');
  const extra = event(); await controller.handle(extra); assert.equal(extra.prevented, true);
});

test('unmount during save cannot close a replacement page or update detached UI', async () => {
  const save = deferred(); let closes = 0;
  const changes = [];
  const workbench = { workbenchBeforeQuit: () => save.promise };
  const controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => { closes++; }, onPending: value => changes.push(value), onError: error => assert.fail(error) });
  const flight = controller.handle(event()); controller.dispose(); save.resolve(); await flight;
  assert.equal(closes, 0); assert.deepEqual(changes, [true]);
  const stale = event(); await controller.handle(stale); assert.equal(stale.prevented, true);
});

test('iframe replacement during save retains window and reports the changed page', async () => {
  const save = deferred(); let closes = 0, error = '';
  let workbench = { workbenchBeforeQuit: () => save.promise };
  const controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => { closes++; }, onPending: () => {}, onError: value => { error = value; } });
  const flight = controller.handle(event()); workbench = {}; save.resolve(); await flight;
  assert.equal(closes, 0); assert.match(error, /页面已变化/); assert.equal(controller.pending, false);
});

test('native close dispatch failure resets guard so a later close retries the save', async () => {
  let saves = 0, closes = 0, errors = 0;
  const workbench = { workbenchBeforeQuit: async () => { saves++; } };
  const controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => { closes++; throw Error('native denied'); }, onPending: () => {}, onError: () => { errors++; } });
  await controller.handle(event()); const retry = event(); await controller.handle(retry);
  assert.equal(retry.prevented, true); assert.equal(saves, 2); assert.equal(closes, 2); assert.equal(errors, 2);
});

test('close IPC may resolve before the reentry event without losing save authorization', async () => {
  const workbench = { workbenchBeforeQuit: async () => {} };
  const pending = [];
  const controller = createWorkbenchCloseController({ getWorkbench: () => workbench,
    closeWindow: async () => {}, onPending: value => pending.push(value), onError: error => assert.fail(error) });
  await controller.handle(event());
  const delayed = event(); await controller.handle(delayed);
  assert.equal(delayed.prevented, false); assert.deepEqual(pending, [true]);
});
