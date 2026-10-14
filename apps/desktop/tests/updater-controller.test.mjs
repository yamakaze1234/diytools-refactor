import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdaterController, shouldPreventUpdaterClose } from '../src/updater-controller.ts';
import { createWorkbenchCloseController } from '../src/legacy/close-controller.ts';

const release = { currentVersion: '0.1.0', version: '0.2.0', available: true, canInstall: true, source: 'Gitea', message: '可以更新' };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  const calls = [], states = [];
  let held = false;
  const workbench = { workbenchBeforeQuit: async () => calls.push('save'), workbenchHasPendingChanges: () => false };
  const controller = createUpdaterController({
    check: async () => { calls.push('check'); return release; },
    download: async () => { calls.push('download'); return { version: '0.2.0', source: 'Gitea' }; },
    install: async () => { calls.push('install'); },
    getWorkbench: () => workbench,
    hasUnsavableChanges: () => false,
    acquireInstall: () => { if (held) return false; held = true; calls.push('acquire'); return true; },
    releaseInstall: () => { held = false; calls.push('release'); },
    freeze: value => calls.push(value ? 'freeze' : 'unfreeze'),
    onState: state => states.push(state),
    ...overrides,
  });
  return { controller, calls, states, workbench, get held() { return held; } };
}
async function downloaded(f) { await f.controller.check(); await f.controller.download(); }

test('check failure is visible and cannot download or install', async () => {
  const f = fixture({ check: async () => { throw Error('Gitea 和 GitHub 查询均失败'); } });
  await f.controller.check(); await f.controller.download(); await f.controller.install();
  assert.equal(f.controller.state.phase, 'ready');
  assert.match(f.controller.state.error, /查询均失败/); assert.deepEqual(f.calls, []);
});
test('no compatible release cannot download even if a version exists', async () => {
  const f = fixture({ check: async () => ({ ...release, canInstall: false, message: '没有兼容的桌面更新包' }) });
  await f.controller.check(); await f.controller.download();
  assert.equal(f.controller.state.release.canInstall, false); assert.deepEqual(f.calls, []);
});
test('download failure retains release and allows retry', async () => {
  let attempts = 0;
  const f = fixture({ download: async () => { if (++attempts === 1) throw Error('SHA256 校验失败'); return { version: '0.2.0', source: 'GitHub' }; } });
  await downloaded(f); assert.equal(f.controller.state.phase, 'ready'); assert.match(f.controller.state.error, /校验失败/);
  await f.controller.install(); assert.equal(f.calls.includes('install'), false);
  await f.controller.download(); assert.equal(f.controller.state.phase, 'downloaded'); assert.equal(f.controller.state.downloaded.source, 'GitHub');
});
test('download keeps editing unlocked and progress ignores invalid or stale events', async () => {
  const flight = deferred(); const f = fixture({ download: () => flight.promise });
  await f.controller.check(); const download = f.controller.download();
  f.controller.progress({ phase: 'downloading', received: -1, total: 100 }); assert.equal(f.controller.state.progress, null);
  f.controller.progress({ phase: 'downloading', received: 20, total: 100 }); assert.equal(f.controller.state.progress.received, 20);
  assert.deepEqual(f.calls, ['check']);
  flight.resolve({ version: '0.2.0', source: 'Gitea' }); await download;
  f.controller.progress({ phase: 'downloading', received: 90, total: 100 }); assert.equal(f.controller.state.progress, null);
});
test('successful install freezes, awaits confirmed save, then keeps guard until native exit', async () => {
  const f = fixture(); await downloaded(f); await f.controller.install();
  assert.deepEqual(f.calls, ['check', 'download', 'acquire', 'freeze', 'save', 'install']);
  assert.equal(f.controller.state.phase, 'installing'); assert.equal(f.held, true);
});
test('save rejection restores editing without installing', async () => {
  const f = fixture(); f.workbench.workbenchBeforeQuit = async () => { throw Error('磁盘写入失败'); };
  await downloaded(f); await f.controller.install();
  assert.equal(f.controller.state.phase, 'downloaded'); assert.match(f.controller.state.error, /磁盘写入失败/);
  assert.equal(f.calls.includes('install'), false); assert.deepEqual(f.calls.slice(-2), ['release', 'unfreeze']); assert.equal(f.held, false);
});
test('recovery draft with pending changes blocks installation', async () => {
  const f = fixture(); f.workbench.workbenchHasPendingChanges = () => true;
  await downloaded(f); await f.controller.install();
  assert.match(f.controller.state.error, /恢复草稿不能替代保存/); assert.equal(f.calls.includes('install'), false); assert.equal(f.held, false);
});
test('missing workbench readiness hooks blocks installation', async () => {
  const f = fixture({ getWorkbench: () => ({}) }); await downloaded(f); await f.controller.install();
  assert.match(f.controller.state.error, /尚未就绪/); assert.equal(f.calls.includes('install'), false); assert.equal(f.held, false);
});
test('unsavable active page dirty blocks installation before acquiring guard', async () => {
  const f = fixture({ hasUnsavableChanges: () => true }); await downloaded(f); await f.controller.install();
  assert.match(f.controller.state.error, /先保存或放弃/); assert.deepEqual(f.calls, ['check', 'download']);
});
test('native close conflict cannot acquire install or release someone else guard', async () => {
  const f = fixture({ acquireInstall: () => false }); await downloaded(f); await f.controller.install();
  assert.match(f.controller.state.error, /正在退出/); assert.deepEqual(f.calls, ['check', 'download']);
});
test('double installation invokes save and backend once', async () => {
  const save = deferred(); const f = fixture(); f.workbench.workbenchBeforeQuit = () => save.promise;
  await downloaded(f); const flight = f.controller.install(); await f.controller.install();
  assert.equal(f.calls.filter(call => call === 'acquire').length, 1);
  save.resolve(); await flight; assert.equal(f.calls.filter(call => call === 'install').length, 1);
});
test('backend installation error unfreezes and requires a fresh trusted download', async () => {
  const f = fixture({ install: async () => { throw Error('更新助手启动失败'); } }); await downloaded(f); await f.controller.install();
  assert.equal(f.controller.state.phase, 'ready'); assert.equal(f.controller.state.downloaded, null); assert.match(f.controller.state.error, /重新下载后重试/); assert.equal(f.held, false);
  assert.deepEqual(f.calls.slice(-2), ['release', 'unfreeze']);
  await f.controller.install(); assert.equal(f.calls.filter(call => call === 'acquire').length, 1);
  await f.controller.download(); assert.equal(f.controller.state.phase, 'downloaded');
});
test('unmount while saving cannot install or emit detached state', async () => {
  const save = deferred(); const f = fixture(); f.workbench.workbenchBeforeQuit = () => save.promise;
  await downloaded(f); const flight = f.controller.install(); f.controller.dispose(); const count = f.states.length;
  save.resolve(); await flight; assert.equal(f.calls.includes('install'), false); assert.equal(f.states.length, count); assert.equal(f.held, false);
});
test('replacement iframe while saving blocks installation', async () => {
  const save = deferred(); let workbench = { workbenchBeforeQuit: () => save.promise, workbenchHasPendingChanges: () => false };
  const f = fixture({ getWorkbench: () => workbench }); await downloaded(f); const flight = f.controller.install();
  workbench = {}; save.resolve(); await flight;
  assert.match(f.controller.state.error, /页面已变化/); assert.equal(f.calls.includes('install'), false); assert.equal(f.held, false);
});
test('disposed checks and downloads cannot emit late completion or begin new work', async () => {
  const check = deferred(); const f = fixture({ check: () => check.promise });
  const flight = f.controller.check(); f.controller.dispose(); const count = f.states.length;
  check.resolve(release); await flight; await f.controller.check(); assert.equal(f.states.length, count);
  const download = deferred(); const second = fixture({ download: () => download.promise });
  await second.controller.check(); const downloadFlight = second.controller.download(); second.controller.dispose(); const nextCount = second.states.length;
  download.resolve({ version: '0.2.0', source: 'Gitea' }); await downloadFlight; assert.equal(second.states.length, nextCount);
});
test('check/download duplicates cannot replace staged release or run concurrently', async () => {
  const check = deferred(); let queries = 0; const f = fixture({ check: () => { queries++; return check.promise; } });
  const flight = f.controller.check(); await f.controller.check(); await f.controller.download();
  assert.equal(queries, 1); check.resolve(release); await flight; await f.controller.download(); await f.controller.check(); await f.controller.download();
  assert.equal(queries, 1); assert.equal(f.calls.filter(call => call === 'download').length, 1);
});
test('independent Tauri close listener flags cannot bypass a rejected workbench save', async () => {
  let destroyed = 0;
  const close = createWorkbenchCloseController({ getWorkbench: () => ({ workbenchBeforeQuit: async () => { throw Error('保存失败'); } }), closeWindow: async () => assert.fail('must not close'), onPending: () => {}, onError: () => {} });
  const wrapper = async listener => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    await listener(event); if (!event.prevented) destroyed++;
  };
  await Promise.all([
    wrapper(event => close.handle(event)),
    wrapper(event => { if (shouldPreventUpdaterClose(true, false)) event.preventDefault(); }),
  ]);
  assert.equal(destroyed, 0);
  assert.equal(shouldPreventUpdaterClose(false, true), true);
  assert.equal(shouldPreventUpdaterClose(false, false), false);
});
test('workbench controller remains sole close owner on successful native reentry', async () => {
  let destroyed = 0, close;
  const dispatch = async () => {
    const listeners = [event => close.handle(event), event => { if (shouldPreventUpdaterClose(true, false)) event.preventDefault(); }];
    await Promise.all(listeners.map(async listener => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      await listener(event); if (!event.prevented) destroyed++;
    }));
  };
  close = createWorkbenchCloseController({ getWorkbench: () => workbench, closeWindow: dispatch, onPending: () => {}, onError: message => assert.fail(message) });
  const workbench = { workbenchBeforeQuit: async () => {} };
  await dispatch(); assert.equal(destroyed, 1);
});

test('one click downloads, confirms saved data and installs without a second action', async () => {
  const f = fixture(); await f.controller.check(); await f.controller.update();
  assert.deepEqual(f.calls, ['check', 'download', 'acquire', 'freeze', 'save', 'install']);
  assert.equal(f.controller.state.phase, 'installing');
});

test('duplicate one-click actions share download and installation', async () => {
  const download = deferred(); let downloads = 0;
  const f = fixture({ download: () => { downloads++; return download.promise; } });
  await f.controller.check(); const first = f.controller.update(); const second = f.controller.update();
  assert.equal(first, second); assert.equal(downloads, 1);
  download.resolve({ version: '0.2.0', source: 'GitHub' }); await first;
  assert.equal(f.calls.filter(call => call === 'install').length, 1);
});

test('closing during one-click download keeps the package but cancels automatic restart', async () => {
  const download = deferred(); const f = fixture({ download: () => download.promise });
  await f.controller.check(); const request = f.controller.update(); f.controller.cancelUpdate();
  assert.equal(f.controller.state.restartAfterDownload, false);
  download.resolve({ version: '0.2.0', source: 'GitHub' }); await request;
  assert.equal(f.controller.state.phase, 'downloaded'); assert.equal(f.calls.includes('save'), false);
  await f.controller.update(); assert.equal(f.calls.includes('install'), true);
});

test('failed verification never saves or installs; one-click retry downloads afresh', async () => {
  let attempts = 0; const f = fixture({ download: async () => { if (++attempts === 1) throw Error('签名校验失败'); return { version: '0.2.0', source: 'GitHub' }; } });
  await f.controller.check(); await f.controller.update();
  assert.equal(f.calls.includes('save'), false); assert.equal(f.calls.includes('install'), false);
  await f.controller.update(); assert.equal(attempts, 2); assert.equal(f.calls.includes('install'), true);
});

test('one-click retains confirmed-save protection and a retry reuses validated download', async () => {
  const f = fixture(); let fail = true;
  f.workbench.workbenchBeforeQuit = async () => { if (fail) throw Error('同步尚未正常保存'); };
  await f.controller.check(); await f.controller.update();
  assert.equal(f.controller.state.phase, 'downloaded'); assert.equal(f.calls.includes('install'), false);
  fail = false; await f.controller.update();
  assert.equal(f.calls.filter(call => call === 'download').length, 1); assert.equal(f.calls.includes('install'), true);
});

test('dispose during one-click download prevents later automatic installation', async () => {
  const download = deferred(); const f = fixture({ download: () => download.promise });
  await f.controller.check(); const request = f.controller.update(); f.controller.dispose();
  download.resolve({ version: '0.2.0', source: 'GitHub' }); await request;
  assert.equal(f.calls.includes('save'), false); assert.equal(f.calls.includes('install'), false);
});
