import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/workbench/profit-check-ui.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function openProfitCheck', 'function openProfitCheck');
const completed = { run: { status: 'completed' }, results: [] };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ request, save = async () => {} }) {
  let elements = new Map(), serial = 0;
  const calls = [], messages = [];
  const node = () => ({ isConnected: true, open: true, textContent: '', innerHTML: '', disabled: false,
    classList: { add() {} }, querySelectorAll: () => [],
    querySelector(selector) { return this.children?.get(selector) ?? null; } });
  const document = { querySelector: key => elements.get(key) ?? null,
    getElementById: key => elements.get('#' + key) ?? null };
  const context = vm.createContext({ document, setTimeout, confirm: () => true,
    crypto: { randomUUID: () => `request-${++serial}` },
    isLegacyTemplateConfig: c => c.productCategory === '主机模板', mountProfitScope() {} });
  vm.runInContext(source, context);
  const open = () => {
    context.openProfitCheck({
      openDialog() {
        for (const element of elements.values()) element.isConnected = false;
        elements = new Map(['#profit-output', '#profit-start', '#profit-history', '#dialog', '.profit-scope',
          '#profit-publish-save', '#profit-publish-enabled', '#profit-publish-directory', '#profit-publish-status']
          .map(key => [key, node()]));
        elements.get('#profit-output').children = new Map(['#profit-category-note', '#profit-results'].map(key => [key, node()]));
      },
      request: async (path, options) => {
        const body = JSON.parse(options.body); calls.push({ path, body });
        return request(path, body);
      }, save, shopId: () => 'intel',
      configs: () => [{ id: 'a', shopId: 'intel' }], selected: () => [],
      esc: String, toast: text => messages.push(text),
    });
    return { start: elements.get('#profit-start'), history: elements.get('#profit-history'), output: elements.get('#profit-output'), dialog: elements.get('#dialog') };
  };
  return { open, calls, messages };
}

test('closing or replacing the dialog while saving cannot start an obsolete detection', async () => {
  const saving = deferred(), env = harness({ save: () => saving.promise, request: () => { throw Error('unexpected'); } });
  const old = env.open(), pending = old.start.onclick();
  const fresh = env.open(), initial = fresh.output.textContent;
  saving.resolve(); await pending;
  assert.equal(env.calls.length, 0);
  assert.equal(fresh.output.textContent, initial);
  assert.equal(fresh.start.disabled, false);
});

test('a closed native dialog keeps its DOM but cannot start detection after save completes', async () => {
  const saving = deferred(), env = harness({ save: () => saving.promise, request: () => { throw Error('unexpected'); } });
  const dialog = env.open(), pending = dialog.start.onclick();
  dialog.dialog.open = false;
  assert.equal(dialog.output.isConnected, true);
  saving.resolve(); await pending;
  assert.equal(env.calls.length, 0);
  assert.equal(dialog.start.disabled, false);
});

test('old start completion cannot poll into a reopened dialog', async () => {
  const starting = deferred(), dispatched = deferred();
  const env = harness({ request: path => { assert.equal(path, '/api/profit/start'); dispatched.resolve(); return starting.promise; } });
  const old = env.open(), pending = old.start.onclick();
  await dispatched.promise;
  const fresh = env.open(), initial = fresh.output.textContent;
  starting.resolve({ runId: 'old-run' }); await pending;
  assert.equal(env.calls.length, 1);
  assert.equal(fresh.output.textContent, initial);
  assert.equal(fresh.output.innerHTML, '');
});

test('old status and history responses cannot overwrite a reopened dialog', async () => {
  for (const action of ['status', 'history']) {
    const response = deferred(), dispatched = deferred();
    const env = harness({ request: path => {
      if (path === '/api/profit/start') return { runId: 'old-run' };
      assert.equal(path, `/api/profit/${action}`); dispatched.resolve(); return response.promise;
    } });
    const old = env.open(), pending = action === 'status' ? old.start.onclick() : old.history.onclick();
    await dispatched.promise;
    const fresh = env.open(), initial = fresh.output.textContent;
    response.resolve(action === 'status' ? completed : { runs: [] }); await pending;
    assert.equal(fresh.output.textContent, initial, action);
    assert.equal(fresh.output.innerHTML, '', action);
  }
});

test('a lost start response retries the same request until completion; a new detection gets a new ID', async () => {
  let starts = 0;
  const env = harness({ request: path => {
    if (path === '/api/profit/start') {
      if (++starts === 1) throw Error('response lost');
      return { runId: 'committed-run' };
    }
    assert.equal(path, '/api/profit/status'); return completed;
  } });
  const dialog = env.open();
  await dialog.start.onclick();
  assert.equal(dialog.output.textContent, 'response lost');
  await dialog.start.onclick();
  await dialog.start.onclick();
  const requests = env.calls.filter(call => call.path === '/api/profit/start');
  assert.deepEqual(requests[1].body, requests[0].body);
  assert.notEqual(requests[2].body.requestId, requests[1].body.requestId);
  assert.equal(dialog.start.disabled, false);
  assert.match(dialog.output.innerHTML, /ERP 利润未知/);
});

test('save failure remains visible and does not create a profit run', async () => {
  const env = harness({ save: async () => { throw Error('save failed'); }, request: () => { throw Error('unexpected'); } });
  const dialog = env.open(); await dialog.start.onclick();
  assert.equal(env.calls.length, 0);
  assert.equal(dialog.output.textContent, 'save failed');
  assert.equal(dialog.start.disabled, false);
});
