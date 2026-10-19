import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkbenchBridge, resolveWorkbenchAsset, unavailableWorkbenchOperation, LOCAL_WORKBENCH_ROUTES } from '../src/legacy/local-bridge.ts';

// 桌面目录来自本机私有文件，不能误退回内置税价数据；浏览器继续使用空的公开目录。
test('native catalog is read through the local store without fetching bundled business data', async () => {
 const calls=[]; const target=frame(()=>{throw Error('private catalog must not use static fetch');});
 await installWorkbenchBridge(target,{invoke:async(command,args)=>{calls.push({command,args});return {status:200,body:'[{"goodsId":"fixture"}]'};}});
 assert.deepEqual(await (await target.fetch('/catalog.json')).json(),[{goodsId:'fixture'}]);
 assert.equal(calls[0].command,'workbench_request');
 assert.equal(calls[0].args.path,'/api/catalog');
});

function frame(original = async () => new Response('static')) {
  return { location: new URL('http://localhost:1420/workbench/index.html'), fetch: original };
}

test('分批导出桥接逐次传递会话阶段，不拼接整批图片',async()=>{
 const calls=[],target=frame();
 await installWorkbenchBridge(target,{invoke:async(command,args)=>{calls.push({command,args});return {ok:true,token:'test',files:[]};}});
 for(const payload of [{phase:'begin',name:'测试'},{phase:'append',token:'test',files:[{name:'1_配置1.png',base64:'cG5n'}]},{phase:'finish',token:'test'}]){
  await target.pywebview.api.export_image_folder_session(payload);
 }
 assert.deepEqual(calls.map(c=>c.command),Array(3).fill('workbench_export_folder'));
 assert.deepEqual(calls.map(c=>c.args.payload.phase),['begin','append','finish']);
 assert.equal(calls[0].args.payload.files,undefined);assert.equal(calls[2].args.payload.files,undefined);
});

test('native markup CORS covers relative and already resolved material URLs',async()=>{
 const old=globalThis.MutationObserver;
 globalThis.MutationObserver=class{observe(){}disconnect(){}};
 const origin='http://workbench-asset.localhost';
 const images=['/uploads/a.png',origin+'/uploads/b.png',origin+'/saved/c.png','https://example.org/remote.png'].map(src=>({tagName:'IMG',attributes:{src},getAttribute(name){return this.attributes[name]??null;},setAttribute(name,value){this.attributes[name]=value;}}));
 const target=frame();target.document={documentElement:{nodeType:1,tagName:'HTML',querySelectorAll:()=>images}};target.addEventListener=()=>{};
 try{
  await installWorkbenchBridge(target,{invoke:async()=>{},assetOrigin:origin});
  assert.equal(images[0].attributes.src,origin+'/uploads/a.png');
  for(const image of images.slice(0,3))assert.equal(image.attributes.crossorigin,'anonymous');
  assert.equal(images[3].attributes.crossorigin,undefined);
 }finally{if(old===undefined)delete globalThis.MutationObserver;else globalThis.MutationObserver=old;}
});

test('native cloud is POST-only with no query credentials and preserves CAS errors', async () => {
 const calls=[],target=frame();await installWorkbenchBridge(target,{invoke:async(command,args)=>{calls.push({command,args});return{status:409,body:'{"error":"stale"}'};}});
 const response=await target.fetch('/api/native-cloud/commit',{method:'POST',body:'{"cloudVersion":4}'});
 assert.equal(response.status,409);assert.deepEqual(calls,[{command:'cloud_native_json_request',args:{action:'commit',payloadJson:'{"cloudVersion":4}'}}]);
 for(const path of ['/api/native-cloud/login?password=test','/api/native-cloud/unknown'])assert.equal((await target.fetch(path,{method:'POST',body:'{}'})).status,400);
 assert.equal((await target.fetch('/api/native-cloud/login')).status,400);
 assert.equal(calls.length,1);
 await target.fetch('/api/native-cloud/connect',{method:'POST',body:'{}'});
 assert.deepEqual(calls[1],{command:'cloud_native_json_request',args:{action:'connect',payloadJson:'{}'}});
 const browser=frame(()=>{throw Error('must not send login to dev server');});await installWorkbenchBridge(browser,{native:false});assert.equal((await browser.fetch('/api/native-cloud/login',{method:'POST',body:'{}'})).status,503);
});

test('native state writes preserve exact payload, status and backend error', async () => {
  const calls = [];
  const target = frame();
  await installWorkbenchBridge(target, { invoke: async (command, args) => {
    calls.push({ command, args });
    return { status: 409, body: '{"error":"修改冲突","conflicts":["price"]}' };
  } });
  const payload = '{"baseRevision":7,"configs":[{"id":"a","price":8799.01}]}';
  const response = await target.fetch('/api/state', { method: 'POST', body: payload });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '修改冲突', conflicts: ['price'] });
  assert.deepEqual(calls, [{ command: 'workbench_request', args: { method: 'POST', path: '/api/state', body: payload } }]);
});

test('Request input, local unknown routes and history queries preserve contracts', async () => {
  const calls = [];
  const target = frame();
  await installWorkbenchBridge(target, { invoke: async (command, args) => {
    calls.push({ command, args }); return { status: 404, body: '{"error":"未实现"}' };
  } });
  await target.fetch(new Request('http://localhost:1420/api/versions/preview', { method: 'POST', body: '{"id":"v1"}' }));
  const response = await target.fetch('/api/unknown?before=7');
  assert.equal(response.status, 404);
  assert.equal(calls[0].args.body, '{"id":"v1"}');
  assert.equal(calls[1].args.path, '/api/unknown?before=7');
  assert.equal(calls[1].args.body, null);
  assert.ok(LOCAL_WORKBENCH_ROUTES.includes('/api/configs/batch'));
  assert.ok(LOCAL_WORKBENCH_ROUTES.includes('/api/profit/reset'));
});

test('online API operations fail truthfully without native invocation or network', async () => {
  let invoked = 0, fetched = 0;
  const target = frame(async () => { fetched++; throw Error('network forbidden'); });
  await installWorkbenchBridge(target, { invoke: async () => { invoked++; throw Error('should not run'); } });
  for (const path of ['/api/workspace-sync/config', '/api/cloud-sync/run', '/api/sql-sync/product', '/api/sql-sync/forget', '/api/product-sync/start', '/api/erp-sync/start']) {
    const response = await target.fetch(path, { method: 'POST', body: '{}' });
    assert.equal(response.status, 503, path);
    assert.ok((await response.json()).error.length > 10);
  }
  assert.equal(invoked, 0); assert.equal(fetched, 0);
  assert.equal(unavailableWorkbenchOperation('/api/profit/history', 'GET'), null);
  assert.equal(unavailableWorkbenchOperation('/api/profit/start', 'POST'), null);
  assert.equal(unavailableWorkbenchOperation('/api/workspace-sync/local-history', 'POST'), null);
});

test('offline profit start/status/history/reset dispatch exact requests and preserve stale-result errors', async () => {
  const calls = [], target = frame();
  await installWorkbenchBridge(target, { invoke: async (command, args) => {
    calls.push({ command, args });
    return args.path === '/api/profit/reset'
      ? { status: 409, body: '{"error":"这不是当前配置的最新有效结果"}' }
      : { status: 200, body: '{"offline":true,"erpCollected":false}' };
  } });
  for (const [path, payload] of [
    ['/api/profit/start', { requestId: 'profit-idem-1', shopId: 'intel', configIds: ['00123'] }],
    ['/api/profit/status', { shopId: 'intel', runId: 'profit-run' }],
    ['/api/profit/history', { shopId: 'intel' }],
    ['/api/profit/reset', { requestId: 'reset-idem-1', shopId: 'intel', configId: '00123', metric: 'accounting', resultId: 'old-result' }],
  ]) {
    const body = JSON.stringify(payload);
    const response = await target.fetch(path, { method: 'POST', body });
    assert.equal(response.status, path.endsWith('reset') ? 409 : 200);
    assert.deepEqual(calls.at(-1), { command: 'workbench_request', args: { method: 'POST', path, body } });
    if (response.ok) assert.deepEqual(await response.json(), { offline: true, erpCollected: false });
    else assert.match((await response.json()).error, /最新有效结果/);
  }
});

test('company SQL exact routes dispatch dedicated command and preserve real failures', async () => {
  const calls = [];
  const target = frame();
  await installWorkbenchBridge(target, { invoke: async (command, args) => {
    calls.push({ command, args }); return { status: 409, body: '{"error":"预览已过期"}' };
  } });
  for (const [method, path, body] of [
    ['GET', '/api/sql-sync/credentials', null],
    ['GET', '/api/erp-sync/status', null],
    ['POST', '/api/sql-sync/credentials/clear', '{}'],
    ['POST', '/api/sql-sync/preview', '{"settings":{"database":"company"},"password":"fixture","remember":false,"operator":"test"}'],
    ['POST', '/api/sql-sync/apply', '{"id":"p1"}'],
  ]) {
    const response = await target.fetch(path, { method, ...(body === null ? {} : { body }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: '预览已过期' });
    assert.deepEqual(calls.at(-1), { command: 'sql_sync_request', args: { method, path, body } });
  }
  for (const [method, path] of [['POST', '/api/sql-sync/credentials'], ['GET', '/api/sql-sync/apply'], ['POST', '/api/erp-sync/status']]) {
    assert.equal((await target.fetch(path, { method })).status, 503);
  }
  assert.equal(calls.length, 5);
});

test('SQL browser mode forwards to real provider and rejects credential URL parameters', async () => {
  const calls = [];
  const target = frame(async (input, init) => {
    calls.push({ input, init }); return new Response('{"error":"SQL 未连接"}', { status: 503 });
  });
  await installWorkbenchBridge(target, { native: false });
  assert.equal((await target.fetch('/api/sql-sync/preview', { method: 'POST', body: '{}' })).status, 503);
  assert.equal(calls[0].input, '/api/sql-sync/preview');
  assert.equal((await target.fetch('/api/sql-sync/credentials?password=fixture')).status, 400);
  assert.equal(calls.length, 1);
});

test('SQL failures sanitize native errors and pre-dispatch aborts cannot start an apply', async () => {
  const target = frame(); let calls = 0;
  await installWorkbenchBridge(target, { invoke: async () => { calls++; throw Error('password=fixture'); } });
  const response = await target.fetch('/api/sql-sync/preview', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /fixture/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(target.fetch('/api/sql-sync/apply', { method: 'POST', body: '{"id":"p1"}', signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal((await target.fetch('/api/sql-sync/apply?password=fixture', { method: 'POST', body: '{}' })).status, 400);
  assert.equal(calls, 1);
});

test('browser preview requires a real local provider and forwards save failure', async () => {
  const calls = [];
  const target = frame(async (input, init) => {
    calls.push({ input, init }); return new Response('{"error":"浏览器预览未启用保存"}', { status: 503 });
  });
  await installWorkbenchBridge(target, { native: false });
  const response = await target.fetch('/api/state', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  assert.equal(calls[0].input, '/api/state');
  assert.equal(target.pywebview, undefined);
  assert.equal(target.resolveWorkbenchAsset('/uploads/photo.png'), '/uploads/photo.png');
});

test('catalog and builtin assets use copied static files; unrelated URLs remain untouched', async () => {
  const calls = [];
  const target = frame(async (input) => { calls.push(String(input)); return new Response('[]'); });
  await installWorkbenchBridge(target, { native: false });
  await target.fetch('/catalog.json'); await target.fetch('/assets/aorus-logo.png');
  await target.fetch('/workbench/core.js'); await target.fetch('https://example.org/api/state');
  assert.deepEqual(calls, ['http://localhost:1420/workbench/catalog.json', 'http://localhost:1420/workbench/assets/aorus-logo.png', '/workbench/core.js', 'https://example.org/api/state']);
});

test('native binary reads and renderer asset URLs do not modify stored values', async () => {
  const calls = [];
  const target = frame();
  await installWorkbenchBridge(target, { assetOrigin: 'http://workbench-asset.localhost', invoke: async (command, args) => {
    calls.push({ command, args }); return { mime: 'image/png', base64: 'AAECAw==' };
  } });
  const source = '/uploads/my%20image.png';
  assert.equal(target.resolveWorkbenchAsset(source), 'http://workbench-asset.localhost/uploads/my%20image.png');
  assert.equal(source, '/uploads/my%20image.png');
  assert.equal(resolveWorkbenchAsset('data:image/png;base64,AA==', 'http://workbench-asset.localhost'), 'data:image/png;base64,AA==');
  const response = await target.fetch(source);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3]);
  assert.deepEqual(calls[0], { command: 'workbench_read_asset', args: { path: source } });
  assert.equal((await target.fetch('/saved/a.png', { method: 'POST' })).status, 405);
});

test('native command failures and malformed receipts never look saved', async () => {
  for (const invoke of [async () => { throw Error('disk full'); }, async () => ({ status: 200 }), async () => ({ status: 0, body: '{}' })]) {
    const target = frame(); await installWorkbenchBridge(target, { invoke });
    const result = await target.fetch('/api/state', { method: 'POST', body: '{}' });
    assert.equal(result.ok, false); assert.match((await result.json()).error, /本机接口/);
  }
});

test('aborted requests cannot dispatch a write; in-flight abortion retains fetch semantics', async () => {
  let count = 0;
  const target = frame();
  await installWorkbenchBridge(target, { invoke: async () => { count++; return new Promise(() => {}); } });
  const first = new AbortController(); first.abort();
  await assert.rejects(target.fetch('/api/state', { method: 'POST', body: '{}', signal: first.signal }), { name: 'AbortError' });
  assert.equal(count, 0);
  const second = new AbortController();
  const pending = target.fetch('/api/state', { signal: second.signal });
  second.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('bridge installation is idempotent; folder export sends exact old payload and propagates errors', async () => {
  const calls = [];
  const target = frame();
  const options = { invoke: async (command, args) => { calls.push({ command, args }); throw Error('export unavailable'); } };
  await installWorkbenchBridge(target, options);
  const fetch = target.fetch;
  await installWorkbenchBridge(target, options); assert.equal(target.fetch, fetch);
  const payload = { name: '图片', files: [{ name: '001.png', base64: 'AA==' }] };
  await assert.rejects(target.pywebview.api.export_image_folder(payload), /export unavailable/);
  assert.deepEqual(calls, [{ command: 'workbench_export_folder', args: { payload } }]);
});


test('iframe reload reinstalls native routes for a new document on the same WindowProxy',async()=>{
 const target=frame(async()=>new Response('<!doctype html>'));
 let calls=0;const options={invoke:async()=>{calls++;return {status:200,body:'{"ok":true}'};}};
 target.document={};await installWorkbenchBridge(target,options);
 const initial=target.fetch;await installWorkbenchBridge(target,options);assert.equal(target.fetch,initial);
 target.document={};target.fetch=async()=>new Response('<!doctype html>');
 await installWorkbenchBridge(target,options);
 assert.deepEqual(await (await target.fetch('/api/workspace/index')).json(),{ok:true});assert.equal(calls,1);
});

test('diagnostics skip native version query and stay readable while native calls hang',async()=>{
 const target=frame(),calls=[];let finish;
 await installWorkbenchBridge(target,{invoke:async command=>{calls.push(command);if(command==='plugin:app|version')return new Promise(()=>{});return new Promise(resolve=>{finish=resolve;});}});
 const exported=target.workbenchExportDiagnostics();
 assert.deepEqual(calls,['workbench_export_folder']);
 const text=JSON.parse(target.workbenchDiagnosticText());assert.match(text.version,/^\d+\.\d+\.\d+$/);
 finish({cancelled:true});assert.equal(await exported,'cancelled');
});

test('save timeout records frontend wait separately from a late native save receipt',async()=>{
 const target=frame();let complete,dispatched;
 const ready=new Promise(resolve=>{dispatched=resolve;});
 await installWorkbenchBridge(target,{invoke:async()=>{dispatched();return new Promise(resolve=>{complete=resolve;});}});
 const controller=new AbortController();
 const response=target.fetch('/api/configs/patch',{method:'POST',body:'{}',signal:controller.signal});
 await ready;controller.abort(new DOMException('signal timed out','TimeoutError'));
 await assert.rejects(response,{name:'TimeoutError'});
 let entries=JSON.parse(target.workbenchDiagnosticText()).events;
 assert(entries.some(e=>e.stage==='local-save-wait'&&e.code==='TIMEOUT'));
 assert.equal(entries.findLast(e=>e.stage==='local-save').phase,'running');
 complete({status:200,body:'{"ok":true}'});
 await new Promise(resolve=>setImmediate(resolve));
 entries=JSON.parse(target.workbenchDiagnosticText()).events;
 assert.equal(entries.findLast(e=>e.stage==='local-save').phase,'ok');
 assert.equal(entries.findLast(e=>e.stage==='local-save-wait').code,'TIMEOUT');
});
