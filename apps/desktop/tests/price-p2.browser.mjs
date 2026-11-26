// 真实 React 工作台的合成业务回归：矩阵、服务端基线、根生命周期及 Excel 编辑交互。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const sources=[
 {sourceId:'cpu',shopId:'intel',slot:'CPU',goodsId:'1001',name:'合成 CPU',erp:500,tax:600,stockAvailable:20},
 {sourceId:'memory',shopId:'intel',slot:'内存',goodsId:'1002',name:'合成内存',erp:100,tax:120,stockAvailable:40},
 {sourceId:'new-cpu',shopId:'intel',slot:'CPU',goodsId:'1003',name:'新款 CPU',erp:700,tax:800,stockAvailable:15},
];
const configs=[0,6,12,24].map((term,i)=>{
 const product={id:'p'+i,shopId:'intel',name:'合成链接'+i,spu:'900'+i,installment:term};
 const c=blankConfig(null,product,'配置'+(i+1));
 return {...c,id:'c'+i,skuId:'800'+i,shortName:'简称'+i,shortNameAuto:false,price:2999,overviewFeeRate:5.125,
  parts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}],
  actualParts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}]};
});
let saved=normalizeWorkspaceState({revision:1,dataVersion:3,configs,sourceCatalog:sources,costSource:sources,shopSettings:{intel:{coupon:400,pricingRule:{fee6:3.25,fee12:6.75}}},templates:[],caseGallery:[],logs:[]},[]);
const queueRoot=await fs.mkdtemp(join(tmpdir(),'diy-erp-match-browser-'));
const python=fileURLToPath(new URL('../../../services/erp-worker/.venv/Scripts/python.exe',import.meta.url));
const worker=spawn(python,['-B','-u',fileURLToPath(new URL('./fixtures/matching-worker.py',import.meta.url))],{windowsHide:true,env:{...process.env,DIYTOOLS_ERP_OPERATIONS:queueRoot,PYTHONIOENCODING:'utf-8'}});
const pending=new Map();let seq=0,stderr='';worker.stderr.on('data',data=>stderr+=data);
createInterface({input:worker.stdout}).on('line',line=>{const result=JSON.parse(line);const entry=pending.get(result.id);if(entry){pending.delete(result.id);entry.resolve(result);}});
worker.on('exit',()=>{for(const entry of pending.values())entry.reject(Error('mock worker exited '+stderr));});
const native=input=>new Promise((resolve,reject)=>{const id='browser-'+(++seq);pending.set(id,{resolve,reject});worker.stdin.write(JSON.stringify({id,...input})+'\n');});
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},bypassCSP:true,permissions:['clipboard-read','clipboard-write']});
 page.on('pageerror',e=>errors.push(e.stack));
 // 人工保存验收期间延长原有自动保存等待，避免测试操作间隔改变待保存状态。
 await page.addInitScript(()=>{const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===950?60000:ms,...args);});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
 window.cardRoots=new Set();window.cardReleases=0;
 window.createWorkbenchReactRenderer=()=>{const renderer=createWorkbenchReactRenderer();return {...renderer,
 configCard:(container,model)=>{cardRoots.add(container);renderer.configCard(container,model);},
 release:container=>{if(cardRoots.delete(container))cardReleases++;renderer.release(container);}};};
 await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 const app=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/p2-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:app+'\nwindow.p2Probe={snapshot:()=>structuredClone(state),history:()=>history.length,pending:()=>[...pendingImages],standard:()=>fullAction(openLocalStandardProduct)()};'}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,payload=request.method()==='POST'?request.postDataJSON():null;
  let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=saved;value={revision:saved.revision,updatedAt:saved.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:saved.revision,configs:saved.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&request.method()==='GET')value=saved;
  else if(path==='/api/state'&&request.method()==='POST'){saved={...saved,...payload,revision:saved.revision+1};value={...saved,state:structuredClone(saved)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){
   const configs=payload.changes.map(c=>structuredClone(c.after));saved.configs=saved.configs.map(c=>configs.find(s=>s.id===c.id)||c);saved.revision++;
   value={configs,revision:saved.revision,updatedAt:new Date().toISOString(),activityDelta:[]};
  }else if(path==='/api/session')value={defaultOperator:'合成验收'};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 let rejectNextPreview=false;
 await page.route('**/api/erp-matching',async route=>{
  const input=route.request().postDataJSON();
  if(rejectNextPreview&&input.action==='match_preview'){
   rejectNextPreview=false;return route.fulfill({json:{ok:false,error:{message:'模拟预览请求失败'}}});
  }
  await route.fulfill({json:await native(input)});
 });
 const open=async()=>{await page.goto(base+'/workbench/p2-fixture');await page.waitForFunction(()=>window.workbenchReady);await page.getByRole('button',{name:'价格',exact:true}).click();await page.locator('#price-profit-title').waitFor();};
 await page.addInitScript(()=>{
  // 只模拟组件通道，登录和匹配仍走真实 JSONL 测试 worker。
  window.fixtureRuntimeStatus=sessionStorage.getItem('fixture-runtime')||'missing';window.fixtureInstalls=0;
  window.workbenchErpRuntime=async action=>{
   if(action==='install'){window.fixtureInstalls++;window.fixtureRuntimeStatus='ready';sessionStorage.setItem('fixture-runtime','ready');}
   return {status:window.fixtureRuntimeStatus,hasLocal:window.fixtureRuntimeStatus!=='missing'};
  };
 });
 await open();
 const cell=(id,key)=>page.locator(`[data-row-id="${id}"][data-pp-cell="${key}"]`),row=id=>page.locator(`[data-pp-row="${id}"]`);
 const card=id=>page.locator(`[data-pp-card="${id}"]`);
 const snapshot=()=>page.evaluate(()=>window.p2Probe.snapshot());
 const edit=async(locator,value)=>{await locator.fill(value);await locator.press('Enter');};
 const paste=async(id,key,text)=>{await cell(id,key).click();await page.evaluate(t=>navigator.clipboard.writeText(t),text);await page.keyboard.press('Control+v');};
 const find=(state,id)=>state.configs.find(c=>c.id===id);
 page.setDefaultTimeout(20000);
 const control=payload=>native({action:'fixture_control',payload});
 assert.equal((await control({})).result.reads.length,0);
 assert.equal(await page.locator('.pp-fields th').filter({hasText:'ERP 匹配状态'}).count(),0);
 // 未选择时禁用匹配入口；本机尚未登录时主动展开连接区。
 const toolbar=page.locator('#pp-erp-match');
 assert.equal(await toolbar.isDisabled(),true);
 await page.locator('[data-pp-pick="c0"]').check();await toolbar.click();
 await page.getByRole('button',{name:'一键安装组件'}).click();
 await page.locator('[data-runtime-banner]').waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>fixtureInstalls),1);
 await page.locator('#erp-match-session[data-connected="false"]').waitFor();
 assert.equal(await page.locator('#erp-match-login').evaluate(el=>el.open),true);
 assert.equal(await page.locator('#erp-match-connect.primary').isVisible(),true);
 assert.equal(await page.locator('#erp-match-background').isVisible(),false);
 await page.locator('#erp-match-close').click();await page.locator('[data-pp-pick="c0"]').uncheck();
 await page.evaluate(()=>window.fixtureRuntimeStatus='outdated');
 // 店铺设置三标签：默认不展开新增区，同货号合并，沿用正式保存路径。
 if(await page.locator('.pp-menu').getAttribute('open')===null)await page.locator('.pp-menu > summary').click();await page.locator('#pp-shop-settings').click();
 assert.equal(await page.getByRole('tab').count(),3);assert.equal(await page.locator('#shop-extra-add').isVisible(),false);
 for(const id of ['shop-erp-save','coupon-save','service-save','shop-price-save','shop-extra-signin','shop-extra-add-button']){
  assert.equal(await page.locator('#'+id+'.primary').count(),1);
 }
 await page.getByRole('button',{name:'一键更新组件'}).click();await page.locator('[data-runtime-banner]').waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>fixtureInstalls),2);
 assert.equal(await page.locator('[data-extra-qty]').count(),5);
 await page.locator('[data-extra-remove]').first().click();await page.locator('#shop-extra-restore').click();
 assert.equal(await page.locator('[data-extra-qty]').count(),5);assert.match(await page.locator('#shop-extras-table').innerText(),/29369/);
 while(await page.locator('[data-extra-remove]').count())await page.locator('[data-extra-remove]').first().click();
 await page.locator('#shop-extra-toggle').click();assert.equal(await page.locator('#shop-extra-add-button').isDisabled(),true);
 await page.locator('#shop-extra-connect').click();
 await page.locator('#shop-extra-user').fill('offline-mock');await page.locator('#shop-extra-password').fill('fixture-only');await page.locator('#shop-extra-password').press('Enter');
 await page.waitForFunction(()=>document.querySelector('#shop-extra-status').textContent.includes('已连接'));
 assert.equal(await page.locator('#shop-extra-password').inputValue(),'');
 for(const qty of [2,3]){
  if(!await page.locator('#shop-extra-add').isVisible())await page.locator('#shop-extra-toggle').click();
  await page.locator('#shop-extra-query').fill('9001');await page.locator('#shop-extra-query').press('Enter');await page.locator('[data-extra-pick]').click();assert.equal(await page.locator('[data-extra-pick]').getAttribute('aria-pressed'),'true');
  await page.locator('#shop-extra-qty').fill(String(qty));await page.locator('#shop-extra-add-button').click();
 }
 assert.equal(await page.locator('#shop-extra-add').isVisible(),true);
 assert.match(await page.locator('#shop-extra-status').innerText(),/固定电源线.*5 件/);
 assert.equal(await page.locator('#shop-extra-connect').isVisible(),false);await page.locator('#shop-extra-toggle').click();
 assert.equal(await page.locator('#shop-extra-add').isVisible(),false);
 assert.equal(await page.locator('[data-extra-qty]').inputValue(),'5');await page.locator('#shop-erp-save').click();await page.locator('#dialog').waitFor({state:'hidden'});
 assert.deepEqual(saved.shopSettings.intel.erpDefaultExtras,[{goodsId:'9001',name:'固定电源线',qty:5}]);
 if(await page.locator('.pp-menu').getAttribute('open')===null)await page.locator('.pp-menu > summary').click();await page.locator('#pp-shop-settings').click();
 await page.getByRole('tab',{name:'店铺券与服务承诺'}).click();assert.equal(await page.locator('#shop-coupon').inputValue(),'400');
 await page.getByRole('tab',{name:'分期息点'}).click();assert.equal(await page.locator('#shop-price-erpRate').isVisible(),false);assert.match(await page.locator('[data-shop-panel=rule]').innerText(),/24.*10%/);
 await page.locator('#dialog').press('Escape');
 const checks=id=>page.locator(`[data-pp-pick="${id}"]`);await checks('c0').check();await checks('c1').check();
 assert.match(await page.locator('#pp-erp-match').innerText(),/\(2\)/);
 assert.equal((await control({})).result.reads.filter(row=>row[0]==='platform_goods').length,0);
 await toolbar.click();await page.locator('#erp-match-session[data-connected="true"]').waitFor();
 assert.match(await page.locator('#erp-match-session').innerText(),/offline-mock/);
 assert.match(await page.locator('#erp-match-summary').innerText(),/已勾选 2 套/);
 assert.equal(await page.locator('#erp-match-login').evaluate(el=>el.open),false);
 assert.equal(await page.locator('#erp-match-mode').count(),0);
 await page.locator('#erp-match-close').click();await toolbar.click();
 await page.locator('#erp-match-preview.primary').click();
 await page.waitForFunction(()=>!document.querySelector('#erp-match-execute').hidden&&!document.querySelector('#erp-match-execute').disabled);
 assert.equal(await page.locator('#erp-match-execute.primary').isVisible(),true);assert.equal(await page.locator('#erp-match-background').isVisible(),false);
 assert.equal((await control({})).result.writes.length,0);await page.locator('[data-erp-filter="update"]').click();
 await page.locator('.erp-empty').waitFor();await page.locator('[data-erp-filter="create"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.erp-badge.create').length===2);
 assert.equal(await page.locator('#erp-match-pager').isVisible(),false);
 const geom=await page.locator('.erp-action-cell').first().evaluate(el=>({width:el.getBoundingClientRect().width,wrap:getComputedStyle(el).whiteSpace,dialog:el.closest('dialog').getBoundingClientRect().width}));
 assert.equal(geom.width,145);assert.equal(geom.wrap,'nowrap');assert.equal(geom.dialog,980);
 assert.equal(await page.locator('.erp-bom[open]').count(),0);
 await page.locator('.erp-bom summary').first().click();assert.match(await page.locator('.erp-bom[open]').innerText(),/#9001\s*×5/);
 assert.match(await page.locator('.erp-diff').first().innerText(),/0 → 1/);
 // 第二次预览未获 worker 确认时，上一份回执不能充当本次的执行许可。
 rejectNextPreview=true;await page.locator('#erp-match-preview').click();
 await page.getByText('模拟预览请求失败',{exact:true}).waitFor();
 assert.equal(await page.locator('#erp-match-execute').isDisabled(),true);
 await page.locator('#erp-match-preview').click();await page.waitForFunction(()=>!document.querySelector('#erp-match-execute').hidden&&!document.querySelector('#erp-match-execute').disabled);
 page.once('dialog',dialog=>dialog.accept());await page.locator('#erp-match-execute').click();await page.locator('#erp-match-background').click();
 // 后台执行过程中继续改价，卡片和输入焦点不被状态轮询冲掉。
 await cell('c0','price').click();await cell('c0','price').fill('4500');await cell('c0','price').press('Enter');
 assert.equal(find(await snapshot(),'c0').price,4500);assert.match(await page.locator('#pp-erp-match').innerText(),/ERP 匹配中/);
 const busy=await native({action:'sql_cost_file',settings:{path:'invalid'}});assert.equal(busy.error.code,'ERP_OPERATION_BUSY');
 page.once('dialog',dialog=>dialog.dismiss());const closed=await page.evaluate(()=>workbenchBeforeQuit().then(()=>'',error=>error.message));assert.match(closed,/取消关闭/);
 await page.waitForFunction(()=>document.querySelector('.erp-match-floating').textContent.includes('已完成'));
 assert.equal(find(await snapshot(),'c0').price,4500);
 let job=(await native({action:'match_status'})).result.job;assert.equal(job.finished,2);assert.ok(job.items.every(item=>item.state==='verified'));
 // 从回执打开弹窗时，表格可以已经取消勾选，仍保留任务套数和 BOM。
 await checks('c0').uncheck();await checks('c1').uncheck();await page.locator('[data-erp-task]').click();
 await page.locator('#erp-match-session[data-connected="true"]').waitFor();
 assert.equal(await page.locator('#erp-match-summary').innerText(),'当前表格已勾选 0 套 · 本次任务 2 套');
 assert.equal(await page.locator('#erp-match-preview').isDisabled(),true);
 assert.equal(await page.locator('#erp-match-preview.primary').count(),0);
 await page.locator('.erp-bom summary').first().click();assert.match(await page.locator('.erp-bom[open]').innerText(),/#9001\s*×5/);
 await page.locator('#erp-match-close').click();await page.locator('.erp-match-floating').waitFor({state:'hidden'});
 assert.equal((await control({})).result.writes.length,12);
 await page.locator('#pp-save').click();await page.waitForFunction(()=>document.querySelectorAll('[data-pp-dirty]').length===0);
 // 已有关联套餐时读取差异，以全批计数二次确认；取消确认不执行写入。
 await checks('c0').check();await control({adjustMatchedBom:'8000'});await toolbar.click();await page.locator('#erp-match-preview').click();
 await page.waitForFunction(()=>document.querySelectorAll('.erp-badge.update').length===1&&!document.querySelector('#erp-match-execute').disabled);
 assert.match(await page.locator('#erp-match-hint').innerText(),/本批含 1 套将更新原套餐 BOM/);
 const colors=await page.locator('.erp-badge.update').evaluate(el=>{
  const root=document.documentElement,old=root.dataset.workbenchTheme;
  const light=getComputedStyle(el).backgroundColor;root.dataset.workbenchTheme='dark';
  const dark=getComputedStyle(el).backgroundColor;
  if(old===undefined)delete root.dataset.workbenchTheme;else root.dataset.workbenchTheme=old;
  return {light,dark};
 });
 assert.notEqual(colors.light,colors.dark);
 if(process.env.ERP_MATCH_SCREENSHOT)await page.locator('#dialog').screenshot({path:process.env.ERP_MATCH_SCREENSHOT});
 const acknowledgment=page.waitForEvent('dialog');
 const tapped=page.locator('#erp-match-execute').click();const confirmation=await acknowledgment;
 assert.match(confirmation.message(),/本批含 1 套将更新原套餐 BOM，确认执行本次快照/);await confirmation.dismiss();await tapped;
 assert.equal((await control({})).result.writes.length,12);
 await page.locator('#erp-match-close').click();await checks('c0').uncheck();
 await checks('c2').check();
 // 明确只读失败后重新预览，仍需再次人工确认；没有自动重试写入。
 await control({failReads:3});await page.locator('#pp-erp-match').click();await page.locator('#erp-match-preview').click();
 await page.waitForFunction(()=>!document.querySelector('#erp-match-retry').hidden);
 await page.locator('#erp-match-retry').click();await page.waitForFunction(()=>!document.querySelector('#erp-match-execute').hidden&&!document.querySelector('#erp-match-execute').disabled);
 page.once('dialog',dialog=>dialog.accept());await page.locator('#erp-match-execute').click();await page.locator('#erp-match-background').click();
 await page.waitForFunction(()=>document.querySelector('.erp-match-floating').textContent.includes('已完成'));
 await page.locator('[data-erp-dismiss]').click();await page.locator('.erp-match-floating').waitFor({state:'hidden'});
 assert.equal((await control({})).result.writes.length,18);
 // 重建页面后等待旧回执真正到达，避免仅断言浮条初始化时的隐藏状态。
 await page.reload();await page.waitForFunction(()=>window.workbenchReady);
 await page.waitForFunction(()=>document.querySelector('.erp-match-floating strong')?.textContent.includes('已完成'));
 assert.equal(await page.locator('.erp-match-floating').evaluate(el=>el.hidden),true);
 await page.getByRole('button',{name:'价格',exact:true}).click();await page.locator('#price-profit-title').waitFor();
 // 写入超时后只提供远端只读核验，反复点击不能降级成可重新写入状态。
 await checks('c2').uncheck();await checks('c3').check();await control({failWrite:'save_bom'});
 await page.locator('#pp-erp-match').click();await page.locator('#erp-match-preview').click();
 await page.waitForFunction(()=>!document.querySelector('#erp-match-execute').hidden&&!document.querySelector('#erp-match-execute').disabled);
 page.once('dialog',dialog=>dialog.accept());await page.locator('#erp-match-execute').click();
 await page.waitForFunction(()=>document.querySelector('#erp-match-message').textContent.includes('未确认'));
 assert.equal(await page.locator('.erp-match-floating').evaluate(el=>el.hidden),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('diy-erp-matching-dismissed-v1')),null);
 const count=(await control({})).result.writes.length;
 for(let i=0;i<2;i++){
  await page.locator('#erp-match-recover').click();await page.waitForFunction(()=>!document.querySelector('#erp-match-recover').hidden&&document.querySelector('#erp-match-message').textContent.includes('需要只读核验'));
 }
 assert.equal((await control({})).result.writes.length,count);assert.equal(await page.locator('#erp-match-preview').isDisabled(),true);assert.equal(await page.locator('#erp-match-retry').isVisible(),false);
 const receipts=await fs.readdir(queueRoot);for(const file of receipts.filter(file=>file.endsWith('.json')))assert.ok(!(await fs.readFile(join(queueRoot,file),'utf8')).includes('fixture-only'));
 if(process.env.P2_SCREENSHOT)await page.screenshot({path:process.env.P2_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);assert.equal(stderr,'');console.log(JSON.stringify({ok:true,settingsTabs:true,extrasMergedSaved:true,noAutomaticSkuReads:true,backgroundEditing:true,closeConfirmation:true,costLock:true,readRetry:true,unknownWriteProtected:true,queueRoot}));
}finally{await browser.close();worker.stdin.end();worker.kill();}
