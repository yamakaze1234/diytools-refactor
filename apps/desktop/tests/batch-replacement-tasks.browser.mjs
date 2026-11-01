/** 库存和全店配件多任务验收：真实 React/业务页面，接口只使用合成数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5209';

const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/2)}`,name:`隔离链接${Math.floor(i/2)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'验收CPU',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'验收内存',erp:220,tax:240}];
state.sourceCatalog.push({shopId:'intel',sourceId:'new-cpu',goodsId:'2001',name:'替换CPU',erp:900,tax:950},{shopId:'intel',sourceId:'new-memory',goodsId:'2002',name:'替换内存',erp:330,tax:350});
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:p.goodsId.startsWith('2')?100:0}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);Object.assign(c.parts[3],state.sourceCatalog[1]);Object.assign(c.actualParts[3],state.sourceCatalog[1]);c.actualParts[3].qty=2;c.parts[0].upgrade='旧CPU文案';c.parts[3].upgrade='旧内存文案';}
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/upgrade-tasks-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),selectForTest:ids=>{selected=new Set(ids);},close:()=>closeDialog()};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({method:req.method(),path,ids:payload?.ids});let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,structuredClone(payload[key])])),revision:state.revision+1,updatedAt:new Date().toISOString()};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:new Date().toISOString(),activityDelta:[]};}
  else if(path==='/api/cost-sync/settings')value=state.costSync||{mode:'cloud',path:'',sheet:'库存数据',goodsColumn:54,taxColumn:67};
  else if(path==='/api/price-changes/list')value={batches:[]};
  else if(path==='/api/session')value={defaultOperator:'内存隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/upgrade-tasks-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();



 const savedCount=()=>requests.filter(r=>r.method==='POST'&&['/api/configs/batch','/api/configs/patch'].includes(r.path)).length;
 const choose=async(prefix,oldName,newId)=>{
  if(prefix==='global'){await page.locator('#global-query').fill(oldName);await page.locator('[data-global-part]').click();}
  else {await page.locator('.stock-issue').filter({hasText:oldName}).locator('[data-stock-edit]').click();await page.locator('#stock-select-all').click();}
  await page.locator(`#${prefix}-new-query`).fill(newId);
  await page.locator(`#${prefix==='global'?'global-product-search':'stock-picker'} [data-product-id]`).click();
 };
 await page.locator('#global-batch-open').evaluate(button=>button.click());
 await choose('global','验收CPU','2001');await page.locator('#global-qty').fill('2');
 await page.locator('[data-global-link]').last().uncheck();
 await page.locator('#global-add-task').click();await choose('global','验收内存','2002');
 await page.locator('[data-global-link]').last().uncheck();
 await page.locator('[data-global-task="0"]').click();assert.equal(await page.locator('#global-qty').inputValue(),'2');assert.match(await page.locator('#global-product-search [data-product-picked]').innerText(),/替换CPU/);assert.equal(await page.locator('[data-global-link]').last().isChecked(),false);
 await page.locator('[data-global-task="1"]').click();assert.match(await page.locator('#global-product-search [data-product-picked]').innerText(),/替换内存/);
 await page.locator('#global-preview').click();assert.match(await page.locator('#global-status').innerText(),/2 条任务，将修改 2 套配置/);
 assert.match(await page.locator('#global-diff').innerText(),/实际配置 · CPU/);assert.match(await page.locator('#global-diff').innerText(),/展示配件 · 内存/);
 const baseline=structuredClone(state.configs),count=savedCount();
 await page.locator('#global-apply').click();await page.waitForFunction(()=>document.querySelector('#global-status').textContent.startsWith('已统一修改'));
 assert.equal(savedCount()-count,1);
 for(const c of state.configs.slice(0,2)){assert.equal(c.parts[0].goodsId,'2001');assert.equal(c.actualParts[0].goodsId,'2001');assert.equal(c.parts[3].goodsId,'2002');assert.equal(c.actualParts[3].goodsId,'2002');assert.equal(c.actualParts[3].qty,2);assert.equal(c.parts[3].qty,1);assert.equal(c.parts[0].qty,2);}
 assert.deepEqual(state.configs.slice(2),baseline.slice(2));
 await page.locator('#global-undo').click();await page.waitForFunction(()=>document.querySelector('#global-status').textContent.startsWith('已还原'));
 assert.deepEqual(state.configs.map(({shortName,...c})=>c),baseline.map(({shortName,...c})=>c));
 await choose('global','验收CPU','2001');await page.locator('#global-add-task').click();await choose('global','验收CPU','2002');await page.locator('#global-preview').click();assert.match(await page.locator('#global-status').innerText(),/冲突/);assert.equal(await page.locator('#global-apply').isDisabled(),true);
 await page.locator('[data-global-task-delete="1"]').click();await page.locator('#global-preview').click();assert.equal(await page.locator('#global-apply').isDisabled(),false);
 await page.locator('#global-qty').fill('3');assert.equal(await page.locator('#global-apply').isDisabled(),true);
 await page.evaluate(()=>window.memoryProbe.close());
 await page.locator('#product-stock-check').click();await page.waitForFunction(()=>document.querySelector('#stock-message')?.textContent.startsWith('检查完成'));
 await choose('stock','验收CPU','2001');await page.locator('#stock-add-task').click();await choose('stock','验收内存','2002');
 await page.locator('[data-stock-task="0"]').click();assert.match(await page.locator('#stock-picker [data-product-picked]').innerText(),/替换CPU/);assert.equal(await page.locator('[data-stock-link]').isChecked(),true);
 await page.locator('[data-stock-task="1"]').click();await page.locator('#stock-preview').click();assert.match(await page.locator('#stock-message').innerText(),/2 条任务，将修改 1 个链接、2 套配置/);
 assert.match(await page.locator('#stock-diff').innerText(),/展示配件 · CPU/);assert.match(await page.locator('#stock-diff').innerText(),/实际配置 · 内存/);
 for(const width of [1300,760]){await page.setViewportSize({width,height:1000});for(const id of ['stock-tasks','stock-task-actions']){await page.locator('#'+id).scrollIntoViewIfNeeded();const box=await page.locator('#'+id).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);}}
 if(process.env.BATCH_TASK_SCREENSHOT){await page.setViewportSize({width:1300,height:1000});await page.locator('#stock-tasks').scrollIntoViewIfNeeded();await page.locator('#dialog').screenshot({path:process.env.BATCH_TASK_SCREENSHOT});}
 const stockCount=savedCount();await page.locator('#stock-apply').click();await page.waitForFunction(()=>document.querySelector('#stock-message')?.textContent.startsWith('已保存'));
 assert.equal(savedCount()-stockCount,1);
 for(const c of state.configs.slice(0,2)){assert.equal(c.parts[0].goodsId,'2001');assert.equal(c.actualParts[0].goodsId,'2001');assert.equal(c.parts[3].goodsId,'2002');assert.equal(c.actualParts[3].goodsId,'2002');assert.equal(c.actualParts[3].qty,2);assert.equal(c.parts[3].qty,1);}
 assert.deepEqual(state.configs.slice(2),baseline.slice(2));assert.equal(await page.locator('[data-stock-task]').count(),1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['global draft switch and independent link selection','global two replacements in one save','global undo','global conflicting tasks and delete','preview invalidation','stock draft switch','stock replaces display and actual in one save','stock current link scope','1300/760px layout','completed queue reset','no page errors']}));
}finally{await browser.close();}
