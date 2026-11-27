/** 用合成三店 NAS 和可控浏览器时钟核验每小时检查、草稿保护和刷新后的基线。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {fixtureActor,fixtureDeployment,fixtureWorkspace,startSourceAcceptance} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';
import {closeWorkbenchDialog,openWorkbenchEditor} from './review-frontend-visible-ui.mjs';

const fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成三店 SQL fixture 目录');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const api=await startSourceAcceptance({fixture,root:join(fixture,'hourly-update-uploads'),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const hour=3_600_000;
let browser;
const releaseReceipt=Promise.withResolvers();

// 另一位运营的独立成本记录不触碰正在编辑的配置。读取时仍走真实的审计 SQL 和 NAS API。
async function peerUpdate(when,version){
 const actor='fixture_verified02',op=randomUUID();
 await api.db.query(`INSERT INTO intel_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
  VALUES($1,$2,$3,'intel','costs',$4,'{}')`,[fixtureWorkspace,actor,op,'0'.repeat(64)]);
 const {rows}=await api.db.query(`INSERT INTO intel_live.workspace_audit
  VALUES($1,$2,$3,1,'100001','tax_edit',$4,$5,gen_random_uuid(),$6) RETURNING created_at`,[fixtureWorkspace,actor,op,version-1,version,when]);
 return rows[0].created_at.toISOString();
}

try{
 const initial=await peerUpdate(new Date(Date.now()-24*hour),2);
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:950},bypassCSP:true});
 await page.clock.install({time:new Date()});
 page.setDefaultTimeout(12000);
 const errors=[],auditReads=[],saves=[];
 const serverCommitted=Promise.withResolvers();
 let rejectAudit=false;
 page.on('pageerror',error=>errors.push(error.message));
 const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace(
  '<script type="module" src="./bootstrap.js"></script>',`<script type="module">
   import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;
   window.__vite_plugin_react_preamble_installed__=true;
   const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
   window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');
   document.body.classList.remove('login-required');
  </script>`);
 await page.route('**/workbench/hourly-update-fixture?*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'hourly-update-isolated',deployment_id:fixtureDeployment}});
  if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
  if(path.endsWith('/workspace/activity')&&req.method()==='GET'){
   auditReads.push(url.search);
   if(rejectAudit)return route.fulfill({status:503,json:{ok:false,error:'SERVICE_UNAVAILABLE'}});
  }
  const res=await fetch(api.url+path+url.search,{method:req.method(),headers:{...req.headers(),'x-workbench-deployment':fixtureDeployment},body:req.postData()??undefined});
  if(req.method()==='PUT'&&path.endsWith('/configurations/fixture-overlap')){
   saves.push(res.status);serverCommitted.resolve(res);
   // NAS 事务已结束，浏览器侧延迟接收原回执，以重现计时器唤醒的竞争窗口。
   await releaseReceipt.promise;
  }
  await route.fulfill({status:res.status,contentType:'application/json',body:await res.text()});
 });
 const refresh=page.locator('#workspace-sync'),badge=page.locator('#nas-update-hint');
 const auditResponse=()=>page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/workspace/activity')&&r.request().method()==='GET');
 const jump=async ms=>page.clock.setSystemTime(new Date(await page.evaluate(()=>Date.now())+ms));
 const focus=()=>page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 async function editName(name){
  const field=page.locator('[data-config="name"]:visible');
  if(!await field.count())await openWorkbenchEditor(page,'display');
  await field.fill(name);await field.press('Tab');
  await page.locator('#save:not(:disabled)').waitFor();
 }
 await page.goto(base+'/workbench/hourly-update-fixture?workspace=nas');
 await page.waitForFunction(at=>window.workbenchReady&&document.querySelector('#nas-data-time')?.dateTime===at,initial);
 assert.equal(await refresh.textContent(),'刷新工作台');
 assert.equal(await badge.isVisible(),false);
 // 测试通过宿主真实设置关闭两小时自动保存，留出用户主动刷新时仍有草稿的场景。
 await page.evaluate(()=>window.postMessage({type:'workbench-nas-autosave-settings'},location.origin));
 await page.locator('#nas-auto-save-toggle').uncheck();
 await closeWorkbenchDialog(page);
 const config=page.locator('.config-item[data-id="fixture-overlap"]');
 if(!await config.isVisible())await page.locator('[data-product-toggle="fixture-link"] .link-arrow').click();
 await config.click();
 await editName('本人保存的配置');
 await page.locator('#save').click();
 const receiptResponse=await serverCommitted.promise;
 assert.equal(receiptResponse.status,200);
 const receipt=(await receiptResponse.clone().json()).data;
 const {rows:[audit]}=await api.db.query('SELECT next_version::text AS version FROM intel_live.audit_events WHERE operation_id=$1',[receipt.operation_id]);
 assert.equal(audit?.version,receipt.version,'前台检查触发前，NAS 已提交保存和对应审计');
 const readsWhileSaving=auditReads.length;
 await jump(hour+1000);await focus();await settle();
 assert.equal(auditReads.length,readsWhileSaving,'保存回执在途时推迟本轮审计读，不能将本人写入误判为他人更新');
 assert.equal(await badge.isVisible(),false);
 releaseReceipt.resolve();
 await page.waitForFunction(at=>document.querySelector('#save')?.disabled&&document.querySelector('#nas-data-time')?.dateTime>at,initial);
 assert.equal(await badge.isVisible(),false,'收到原回执后仍应保持常态');
 assert.deepEqual(saves,[200]);
 // 跳过一小时只触发一轮后台定时器，核验其确实读了审计且本人保存没有点亮提醒。
 const before=auditReads.length;
 await Promise.all([auditResponse(),page.clock.fastForward(hour+100)]);
 await settle();
 assert.equal(auditReads.length,before+1);
 assert.equal(await badge.isVisible(),false);
 const current=await peerUpdate(new Date(),3);
 const beforeFocus=auditReads.length;
 await jump(hour-60_000);
 await focus();await settle();
 assert.equal(auditReads.length,beforeFocus,'未到一小时不应因反复切换窗口请求 NAS');
 await jump(61_000);
 await Promise.all([auditResponse(),focus()]);
 await badge.waitFor();
 assert.equal(auditReads.length,beforeFocus+1);
 assert.match(await refresh.innerText(),/刷新工作台\s*·\s*有更新/);
 const expectedTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(current));
 assert.equal((await badge.innerText()).trim(),'服务端有更新 '+expectedTime);
 const colors=()=>refresh.evaluate(button=>{
  const {backgroundColor,color,borderTopColor}=getComputedStyle(button);
  return {backgroundColor,color,borderTopColor};
 });
 const yellow='rgb(255, 250, 0)';
 assert.equal((await colors()).backgroundColor,yellow);
 assert.equal((await colors()).color,'rgb(22, 22, 22)');

 await editName('刷新后仍在的本机草稿');
 const softer=await colors();
 assert.equal(softer.backgroundColor,'rgb(43, 42, 20)');
 assert.equal(softer.color,yellow);
 assert.equal(softer.borderTopColor,yellow);
 assert.match(await refresh.getAttribute('title'),/草稿/);
 rejectAudit=true;
 await jump(hour+1000);
 // 隐藏后重新可见和窗口 focus 都要补检。失败不得清掉已确认的旧提醒。
 await Promise.all([auditResponse(),page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))]);
 await settle();
 assert.equal((await badge.innerText()).trim(),'服务端有更新 '+expectedTime);
 assert.deepEqual(await colors(),softer);
 assert.deepEqual(saves,[200]);
 rejectAudit=false;
 await Promise.all([page.waitForEvent('load'),refresh.click()]);
 await page.waitForFunction(at=>window.workbenchReady&&document.querySelector('#nas-data-time')?.dateTime===at,current);
 assert.equal(await refresh.textContent(),'刷新工作台');
 assert.equal(await badge.isVisible(),false);
 const drafts=await page.evaluate(async()=> (await window.workbenchCacheStatus()).drafts);
 assert(drafts.some(row=>row.id==='fixture-overlap'&&row.name==='刷新后仍在的本机草稿'));
 // 切到同样拥有 fixture-overlap 的另一店，旧店草稿、提醒和定时器都不能随页面迁移。
 await peerUpdate(new Date(),4);
 await jump(hour+1000);
 await Promise.all([auditResponse(),focus()]);
 await badge.waitFor();
 await Promise.all([page.waitForEvent('load'),page.locator('#shop-picker').selectOption('jonsbo')]);
 await page.waitForFunction(()=>window.workbenchReady&&document.querySelector('#shop-picker').value==='jonsbo'&&
  document.querySelector('#nas-data-time')?.dateTime&&document.querySelector('#nas-data-time-state').textContent==='');
 assert.equal(await badge.isVisible(),false);
 assert.equal(await page.evaluate(async()=> (await window.workbenchCacheStatus()).count),0);
 const priorShopReads=auditReads.length;
 await Promise.all([auditResponse(),page.clock.fastForward(hour+100)]);
 await settle();
 assert.deepEqual(auditReads.slice(priorShopReads),['?shop_id=jonsbo']);
 assert.equal(await badge.isVisible(),false);
 assert.deepEqual(saves,[200]);
 assert.deepEqual(errors,[]);
 console.log('NAS 顶栏浏览器验收通过：小时巡检、前台补检、本人保存回执在途、草稿双态、断网保留提醒、刷新保留草稿、切店隔离。');
}finally{releaseReceipt.resolve();await browser?.close();await api.close();}
