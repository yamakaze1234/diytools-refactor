/** 多任务加购描述验收：真实 React/业务页面，接口只使用合成数据。 */
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
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:0}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);Object.assign(c.parts[3],state.sourceCatalog[1]);Object.assign(c.actualParts[3],state.sourceCatalog[1]);c.parts[0].upgrade='旧CPU文案';c.parts[3].upgrade='旧内存文案';}
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


 await page.locator('#link-upgrades').click();await page.locator('#upgrade-batch-add-task').waitFor();
 const part=name=>page.locator('#upgrade-batch-candidates label').filter({hasText:name}).locator('input');
 await part('验收CPU').check();await page.locator('#upgrade-batch-text').fill('CPU 新加购说明');
 await page.locator('#upgrade-batch-add-task').click();
 assert.equal(await page.locator('#upgrade-batch-text').inputValue(),'');
 await part('验收内存').check();await page.locator('#upgrade-batch-text').fill('内存 新加购说明');
 await page.locator('[data-upgrade-task="0"]').click();
 assert.equal(await page.locator('#upgrade-batch-text').inputValue(),'CPU 新加购说明');assert.equal(await part('验收CPU').isChecked(),true);assert.equal(await part('验收内存').isChecked(),false);
 await page.locator('[data-upgrade-task="1"]').click();assert.equal(await page.locator('#upgrade-batch-text').inputValue(),'内存 新加购说明');
 await page.locator('#upgrade-batch-preview').click();
 assert.match(await page.locator('#upgrade-batch-status').innerText(),/2 条任务，将修改 2 套配置/);
 const diff=await page.locator('#upgrade-batch-diff').innerText();assert.match(diff,/CPU 新加购说明/);assert.match(diff,/内存 新加购说明/);
 if(process.env.UPGRADE_TASK_SCREENSHOT)await page.locator('#dialog').screenshot({path:process.env.UPGRADE_TASK_SCREENSHOT});
 const before=await page.evaluate(()=>window.memoryProbe.snapshot());
 await page.locator('#upgrade-batch-apply').click();await page.waitForFunction(()=>document.querySelector('#upgrade-batch-status').textContent.startsWith('已保存'));
 for(const c of state.configs.slice(0,2)){assert.equal(c.parts[0].upgrade,'CPU 新加购说明');assert.equal(c.parts[3].upgrade,'内存 新加购说明');assert.deepEqual(c.actualParts,before.configs.find(b=>b.id===c.id).actualParts);}
 assert.equal(state.configs[2].parts[0].upgrade,'旧CPU文案');
 await page.locator('#upgrade-batch-undo').click();await page.waitForFunction(()=>document.querySelector('#upgrade-batch-status').textContent.startsWith('已还原'));
 for(const c of state.configs.slice(0,2)){assert.equal(c.parts[0].upgrade,'旧CPU文案');assert.equal(c.parts[3].upgrade,'旧内存文案');}
 await page.locator('#upgrade-batch-add-task').click();await part('验收CPU').check();await page.locator('#upgrade-batch-text').fill('冲突文案');
 await page.locator('#upgrade-batch-preview').click();assert.match(await page.locator('#upgrade-batch-status').innerText(),/任务 1 与 任务 3.*冲突/);assert.equal(await page.locator('#upgrade-batch-apply').isDisabled(),true);
 await page.locator('[data-upgrade-task-delete="2"]').click();assert.equal(await page.locator('[data-upgrade-task]').count(),2);
 await page.locator('#upgrade-batch-preview').click();assert.equal(await page.locator('#upgrade-batch-apply').isDisabled(),false);
 await page.locator('#upgrade-batch-text').fill('修改预览后的文案');assert.equal(await page.locator('#upgrade-batch-apply').isDisabled(),true);
 await page.locator('[data-upgrade-task="0"]').click();await page.locator('[data-upgrade-link]').uncheck();await page.locator('[data-upgrade-task="1"]').click();await page.locator('[data-upgrade-task="0"]').click();assert.equal(await page.locator('[data-upgrade-link]').isChecked(),false);
 await page.locator('#upgrade-batch-preview').click();assert.match(await page.locator('#upgrade-batch-status').innerText(),/任务 1.*选择影响的链接/);await page.locator('[data-upgrade-link]').check();
 for(const width of [1300,760]){await page.setViewportSize({width,height:1000});await page.locator('#upgrade-batch-add-task').scrollIntoViewIfNeeded();const box=await page.locator('#upgrade-batch-tasks').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);}
 await page.setViewportSize({width:1300,height:1000});
 await page.evaluate(()=>window.memoryProbe.close());await page.locator('#link-display-names').click();await page.locator('#upgrade-batch-query').fill('验收CPU');await page.locator('[data-upgrade-part]').click();await page.locator('#upgrade-batch-text').fill('新展示名');await page.locator('#upgrade-batch-preview').click();assert.equal(await page.locator('#upgrade-batch-apply').isDisabled(),false);assert.equal(await page.locator('#upgrade-batch-add-task').count(),0);
 await page.evaluate(()=>{window.memoryProbe.close();window.memoryProbe.selectForTest(['c2']);});
 await page.locator('#link-upgrades').click();await part('验收CPU').check();await page.locator('#upgrade-batch-text').fill('当前链接CPU');
 await page.locator('#upgrade-batch-add-task').click();await page.locator('#upgrade-batch-scope').selectOption('selected');await part('验收内存').check();await page.locator('#upgrade-batch-text').fill('勾选配置内存');
 assert.equal(await page.locator('[data-upgrade-link]').inputValue(),'p1');
 await page.locator('[data-upgrade-task="0"]').click();assert.equal(await page.locator('#upgrade-batch-scope').inputValue(),'link');
 await page.locator('#upgrade-batch-preview').click();assert.match(await page.locator('#upgrade-batch-status').innerText(),/2 条任务，将修改 3 套配置/);
 await page.locator('[data-upgrade-task="1"]').click();assert.equal(await page.locator('#upgrade-batch-scope').inputValue(),'selected');assert.equal(await page.locator('[data-upgrade-link]').inputValue(),'p1');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',checks:['task drafts and selections preserved','two descriptions merged into one save','actual parts unchanged','undo all tasks','conflicting targets blocked','delete task','invalidate edited preview','link deselection preserved','1300/760px layout','display names unchanged','per-task link/selected scope preserved']}));
}finally{await browser.close();}
