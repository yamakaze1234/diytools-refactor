/** Actual React panel + sync UI/controller; all API and worker I/O is isolated. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const origin=new URL(base).origin,errors=[],unexpected=[],requests=[];
let mode='authenticated',conflicts=0;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1100,height:900}});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
  if(path==='/sync-reui-test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/workbench/style.css"><link rel="stylesheet" href="/workbench/workbench-ui.css"><link rel="stylesheet" href="/workbench/reui-layout.css"></head><body><button id="workspace-sync"></button><span id="workspace-sync-status"></span><button id="operator-open"></button><dialog id="dialog"><form method="dialog"><h2 id="dialog-title"></h2><button id="test-close">关闭</button></form><div id="dialog-body"></div></dialog><script type="module">
   import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
   const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
   const {bindWorkspaceSync}=await import('/workbench/workspace-sync-ui.js');
   window.runs=[];window.messages=[];window.flushes=0;window.releases=0;window.renderer=createWorkbenchReactRenderer();
   const body=document.querySelector('#dialog-body'),dialog=document.querySelector('#dialog');
   const release=()=>{renderer.release(body);window.releases++;};
   dialog.addEventListener('close',()=>{if(!dialog.open)release();});
   const openDialog=(title,html)=>{release();document.querySelector('#dialog-title').textContent=title;body.innerHTML=html;if(!dialog.open)dialog.showModal();};
   window.ui=await bindWorkspaceSync({flush:async()=>{window.flushes++;},receive:async()=>true,esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),toast:m=>messages.push(m),openDialog,renderPanel:model=>renderer.dialog(body,'workspace-sync',model)});window.ready=true;
  </script></body></html>`});
  if(path==='/workbench/cloud-worker-client.js')return route.fulfill({contentType:'text/javascript',body:`export function createCloudWorker(){return {run:async args=>{window.runs.push(args);if(window.holdRun)await new Promise(resolve=>window.finishRun=resolve);return {pending:0,conflicts:0};},stop(){window.finishRun?.();window.finishRun=null;},conflicts:async()=>({rows:[],total:0})};}`});
  if(path.startsWith('/api/')){
   requests.push({path,method:route.request().method()});let value;
   if(path==='/api/native-cloud/status')value={configured:mode!=='local',session:{configured:mode!=='local',authenticated:mode==='authenticated',member:mode==='authenticated'?{name:'隔离成员',uid:'test',workspaceId:'isolated'}:null},checkpoint:{initialized:true,uid:'test',workspaceId:'isolated',conflicts}};
   else if(['/api/native-cloud/resume','/api/native-cloud/logout'].includes(path))value={};
   else if(path==='/api/cache/maintain')value={skipped:true};
   else if(path==='/api/cache/preview')value={count:0,categories:[]};
   else if(path==='/api/versions')value={versions:[]};
   else if(path==='/api/versions/status')value={count:0,bytes:0};
   else{unexpected.push(path);return route.fulfill({status:500,json:{error:'Unexpected isolated request'}});}
   return route.fulfill({json:value});
  }
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/sync-reui-test');await page.waitForFunction(()=>window.ready&&window.runs.length===1&&!window.ui.status().running);
 await page.click('#workspace-sync');await page.waitForSelector('#cloud-sync-now');
 assert.equal(await page.locator('#dialog-body [data-slot="frame"]').count(),3,'actual ReUI panels mounted');
 assert.equal(await page.locator('[data-cloud-shop]').count(),3);
 assert.equal(await page.locator('[data-cloud-shop="intel"]').isChecked(),true);
 await page.locator('[data-cloud-shop="gigabyte"]').check();await page.locator('[data-cloud-shop="jonsbo"]').check();
 assert.match(await page.locator('#cloud-shop-count').innerText(),/3 家/);
 await page.click('#cloud-sync-now');await page.waitForFunction(()=>runs.length===2&&!ui.status().running);
 assert.deepEqual(await page.evaluate(()=>runs.at(-1).shopIds),['intel','gigabyte','jonsbo']);
 await page.locator('[data-cloud-shop="intel"]').uncheck();await page.locator('[data-cloud-shop="gigabyte"]').uncheck();
 await page.locator('[data-cloud-shop="jonsbo"]').click();assert.equal(await page.locator('[data-cloud-shop="jonsbo"]').isChecked(),true);assert.match(await page.evaluate(()=>messages.at(-1)),/至少选择/);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('diy-cloud-selected-shops'))),['jonsbo']);

 // The native controls must remain mutable after the React mount.
 await page.evaluate(()=>window.holdRun=true);await page.click('#cloud-sync-now');await page.waitForFunction(()=>window.finishRun);
 assert.equal(await page.locator('#cloud-sync-now').isDisabled(),true);assert.equal(await page.locator('[data-cloud-shop="intel"]').isDisabled(),true);
 assert.equal(await page.locator('#cloud-pause').isDisabled(),false);assert.equal(await page.locator('#cloud-close').isDisabled(),false);
 await page.click('#cloud-pause');await page.waitForFunction(()=>!ui.status().running);assert.equal(await page.locator('#cloud-pause').innerText(),'继续同步');
 assert.equal(await page.locator('#cloud-sync-now').isDisabled(),false);await page.evaluate(()=>window.holdRun=false);
 conflicts=2;await page.evaluate(()=>ui.open());await page.waitForFunction(()=>!document.querySelector('#cloud-conflicts').hidden);
 conflicts=0;await page.evaluate(()=>ui.open());await page.waitForFunction(()=>document.querySelector('#cloud-conflicts').hidden);

 const releases=await page.evaluate(()=>window.releases);await page.click('#cloud-close');await page.waitForFunction(()=>!document.querySelector('#dialog').open);await page.waitForFunction(previous=>window.releases>previous,releases);
 assert.equal(await page.locator('#cloud-sync-now').count(),0,'closing unmounts React root');await page.click('#workspace-sync');await page.waitForSelector('#cloud-sync-now');assert.equal(await page.locator('[data-cloud-shop="jonsbo"]').isChecked(),true);
 await page.locator('#dialog-body summary').click();await page.click('#local-cache');await page.waitForSelector('#cache-clear');await page.click('#cache-back');await page.waitForSelector('#cloud-sync-now');assert.equal(await page.locator('#dialog-body [data-slot="frame"]').count(),3);
 await page.locator('#dialog-body summary').click();await page.click('#offline-history');await page.waitForSelector('#version-manage');assert.match(await page.locator('#dialog-body').innerText(),/尚无历史版本/);
 await page.click('#test-close');await page.waitForFunction(()=>!document.querySelector('#dialog').open);await page.click('#workspace-sync');await page.waitForSelector('#cloud-sync-now');
 if(process.env.UI_CAPTURE)await page.locator('#dialog').screenshot({path:process.env.UI_CAPTURE+'-authenticated.png'});
 await page.setViewportSize({width:480,height:850});assert.equal(await page.evaluate(()=>{const d=document.querySelector('#dialog');return d.scrollWidth<=d.clientWidth+1;}),true,'narrow dialog does not overflow');

 mode='expired';await page.reload();await page.waitForFunction(()=>window.ready);await page.click('#workspace-sync');await page.waitForSelector('#cloud-logout');assert.equal(await page.locator('#cloud-sync-now').count(),0);assert.equal(await page.locator('#cloud-logout').innerText(),'保存并重新登录');
 mode='local';await page.reload();await page.waitForFunction(()=>window.ready);await page.click('#workspace-sync');await page.waitForSelector('#cloud-close');assert.equal(await page.locator('#cloud-logout').count(),0);assert.equal(await page.locator('[data-cloud-shop]').count(),0);assert.equal(await page.evaluate(()=>runs.length),0);assert.match(await page.locator('#dialog-body').innerText(),/云同步未配置/);
 await page.locator('#dialog-body summary').click();assert.equal(await page.locator('#offline-history').isEnabled(),true);assert.equal(await page.locator('#local-cache').isEnabled(),true);
 if(process.env.UI_CAPTURE)await page.locator('#dialog').screenshot({path:process.env.UI_CAPTURE+'-local-narrow.png'});
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',checks:10,authenticated:true,threeShopSelection:true,lastShopProtected:true,runningControlsAndPause:true,conflictVisibility:true,closeAndRemount:true,cacheAndHistoryReturn:true,expired:true,local:true,narrow:true,apiRequests:requests.length,unexpected,errors}));
}finally{await browser.close();}
