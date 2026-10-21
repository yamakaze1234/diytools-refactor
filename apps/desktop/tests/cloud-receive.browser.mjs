/** 实际 app + 同步 UI/controller 回读闭环；仅用内存本机接口与合成同步传输。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const config=blankConfig(null,{id:'receive-product',name:'隔离同步链接',shopId:'intel',configs:[]},'初始名称');
Object.assign(config,{id:'receive-config',version:'初始版本',shortName:'隔离简称',shortNameAuto:false});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs:[config],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
let syncChange=null,syncRuns=0,indexReads=0;const saves=[],errors=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.on('pageerror',error=>errors.push(error.message));
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/receive-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 // 仅替换传输引擎；同步 UI、控制器、实际 receive 与紧凑工作区均使用原实现。
 await page.route('**/workbench/cloud-worker-client.js',route=>route.fulfill({contentType:'text/javascript',body:`export function createCloudWorker(){return {run:async()=>{const r=await fetch('/api/synthetic-sync',{method:'POST'});return r.json();},stop(){}};}`}));
 const app=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',route=>route.fulfill({contentType:'text/javascript',body:app+'\nwindow.receiveProbe=()=>({revision:state.revision,version:current()?.version,baseVersion:acceptedState.configs.find(c=>c.id===active)?.version,dirty,conflict,fullWorkspace});window.receiveFull=()=>ensureFullWorkspace();window.receiveRun=()=>workspaceSyncUi.runAgent();window.receiveDraftDialog=()=>openDialog("隔离编辑弹窗","<input id=synthetic-draft value=尚未提交><button id=synthetic-close>关闭</button>");'}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,payload=request.method()==='POST'&&request.postData()?request.postDataJSON():null;let value={};
  if(path==='/api/workspace/index'){indexReads++;const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&request.method()==='GET')value=state;
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){
   saves.push(structuredClone(payload));
   if(payload.changes.some(change=>change.base.version!==state.configs.find(c=>c.id===change.id).version)){await route.fulfill({status:409,json:{error:'同一字段已被修改，请重新预览'}});return;}
   state.configs=state.configs.map(c=>payload.changes.find(change=>change.id===c.id)?.after||c);state.revision++;state.updatedAt=new Date().toISOString();value={configs:payload.changes.map(c=>c.after),revision:state.revision,updatedAt:state.updatedAt,activityDelta:[]};
  }else if(path==='/api/synthetic-sync'){
   syncRuns++;if(syncChange){Object.assign(state.configs[0],syncChange);state.revision++;state.updatedAt=new Date().toISOString();syncChange=null;}value={pending:0,conflicts:0};
  }else if(path==='/api/session')value={defaultOperator:'隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:true,session:{configured:true,authenticated:true,member:{uid:'synthetic',workspaceId:'receive',name:'隔离成员'}},checkpoint:{initialized:true,uid:'synthetic',workspaceId:'receive',conflicts:0}};
  else if(path==='/api/cache/maintain')value={skipped:true};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto((process.env.REACT_TEST_URL||'http://127.0.0.1:5194')+'/workbench/receive-fixture');await page.waitForFunction(()=>window.workbenchReady&&window.receiveProbe);
 await page.waitForFunction(()=>document.querySelector('#workspace-sync-status').textContent==='自动同步已开启');
 await page.locator('[data-product-toggle="receive-product"]').click();await page.locator('[data-id="receive-config"]').click();await page.locator('[data-config="version"]').waitFor();
 const baseline=await page.evaluate(()=>window.receiveProbe());assert.equal(baseline.baseVersion,'初始版本');
 syncChange={name:'A不同字段名称',version:'B不同字段版本'};
 await page.locator('#workspace-sync').click();await page.locator('#cloud-sync-now').click();
 await page.waitForFunction(()=>!document.querySelector('#cloud-sync-now').disabled);
 assert.equal(state.configs[0].version,'B不同字段版本');
 const afterSync=await page.evaluate(()=>({...window.receiveProbe(),dialogOpen:document.querySelector('#dialog').open,fieldVersion:document.querySelector('[data-config="version"]').value}));
 // 同步完成即已接收界面基线；关闭之后马上输入不与后台回读竞赛。
 assert.equal(afterSync.dialogOpen,true);assert.equal(afterSync.version,'B不同字段版本');assert.equal(afterSync.baseVersion,'B不同字段版本');assert.equal(afterSync.fieldVersion,'B不同字段版本');
 await page.locator('#cloud-close').click();await page.locator('[data-config="version"]').fill('A下一次本地修改');await page.locator('#save').click();
 await page.waitForFunction(()=>!window.workbenchHasPendingChanges());
 assert.equal(state.configs[0].name,'A不同字段名称');assert.equal(state.configs[0].version,'A下一次本地修改');
 const final=await page.evaluate(()=>window.receiveProbe());assert.equal(final.conflict,false);assert.equal(saves.at(-1).changes[0].base.version,'B不同字段版本');
 // 全量模式使用同一同步完成边界，普通编辑弹窗仍不得被云回读覆盖。
 await page.evaluate(()=>window.receiveFull());assert.equal((await page.evaluate(()=>window.receiveProbe())).fullWorkspace,true);
 syncChange={version:'全量远端版本'};await page.locator('#workspace-sync').click();await page.locator('#cloud-sync-now').click();await page.waitForFunction(()=>!document.querySelector('#cloud-sync-now').disabled);
 const full=await page.evaluate(()=>window.receiveProbe());assert.equal(full.version,'全量远端版本');assert.equal(full.baseVersion,'全量远端版本');
 await page.locator('#cloud-close').click();await page.evaluate(()=>window.receiveDraftDialog());
 syncChange={version:'编辑弹窗后的远端版本'};await page.evaluate(()=>window.receiveRun());
 const deferred=await page.evaluate(()=>window.receiveProbe());assert.equal(deferred.version,'全量远端版本');assert.equal(await page.locator('#synthetic-draft').inputValue(),'尚未提交');
 await page.locator('#synthetic-close').evaluate(node=>{node.onclick=()=>document.querySelector('#dialog').close();});await page.locator('#synthetic-close').click();
 await page.waitForFunction(()=>window.receiveProbe().baseVersion==='编辑弹窗后的远端版本');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',syncRuns,indexReads,afterSync,final,full,otherEditorDialogDeferred:true,saves:saves.length,errors},null,2));
}finally{await browser.close();}
