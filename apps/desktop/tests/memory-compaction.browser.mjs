/** 隔离内存样本：真实页面代码，接口只读写本进程的合成配置。 */
import assert from 'node:assert/strict';
import {artifact,configTable,displayText,actualPicker,openAdvanced,mainTable,saveUi,undoUi,redoUi,closeUi,textSelection,textOffsets} from './continuous-regression-helper.mjs';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const configs=Array.from({length:250},(_,i)=>{
 const product={id:`p${Math.floor(i/25)}`,name:`隔离链接${Math.floor(i/25)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/memory-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),historyState:()=>({undo:history.length,redo:redoHistory.length,counter:changeCounter}),syncReceive:()=>receiveErpForPrices({}, {syncDialog:true}),backgroundRefresh:()=>refreshCompactWorkspace(),info:()=>({full:fullWorkspace,details:state.configs.length,base:acceptedState.configs.length,index:lazyWorkspace.index().summaries.length,dirty,history:history.map(h=>({scope:h.historyScope,count:h.configs.length}))})};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({path,ids:payload?.ids});let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,structuredClone(payload[key])])),revision:state.revision+1,updatedAt:new Date().toISOString()};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:new Date().toISOString(),activityDelta:[]};}
  else if(path==='/api/cost-sync/settings')value=state.costSync||{mode:'cloud',path:'',sheet:'库存数据',goodsColumn:54,taxColumn:67};
  else if(path==='/api/session')value={defaultOperator:'内存隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/memory-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"] .link-arrow').click();await page.locator('[data-id="c0"]').click();
 await openAdvanced(page,'display');await page.locator('[data-config="name"]').waitFor();
 const before=await page.evaluate(()=>window.memoryProbe.info());assert.equal(before.details,25);
 // 同步窗口的显式回载允许保持本窗口，后台刷新仍不能跨过草稿保护。
 await page.click('#erp-sync');await page.locator('#cost-read').waitFor();
 assert.equal(await page.evaluate(()=>window.memoryProbe.backgroundRefresh()),false);
 state.costSync={mode:'nas',path:'D:/fixture.xlsx',sheet:'库存数据',goodsColumn:54,taxColumn:67};state.revision++;
 const fullReads=requests.filter(r=>r.path==='/api/state').length;
 assert.equal(await page.evaluate(()=>window.memoryProbe.syncReceive()),true);
 assert.equal(await page.locator('#erp-inline-shell').isVisible(),true);assert.equal((await page.evaluate(()=>window.memoryProbe.info())).details,25);
 assert.equal(requests.filter(r=>r.path==='/api/state').length,fullReads);await closeUi(page);

 await page.locator('#overview').click();await page.locator('.overview-row').first().waitFor();const hydrated=await page.evaluate(()=>window.memoryProbe.info());assert.equal(hydrated.details,250);assert.equal(hydrated.full,true);
 await page.evaluate(()=>{window.memoryEditorNode=document.querySelector('[data-config="name"]');});await closeUi(page);
 await page.waitForFunction(()=>!window.memoryProbe.info().full);
 const after=await page.evaluate(()=>({...window.memoryProbe.info(),sameEditor:window.memoryEditorNode===document.querySelector('[data-config="name"]'),dialogNodes:document.querySelector('#dialog-body').childElementCount}));
 assert.ok(after.details<=16);assert.ok(after.base<=16);assert.equal(after.index,250);assert(after.sameEditor);assert.equal(after.dialogNodes,0);
 const name=page.locator('[data-config="name"]');await name.fill('释放后编辑');await name.press('Tab');await saveUi(page);assert.equal(state.configs.find(c=>c.id==='c0').name,'释放后编辑');
 await undoUi(page);await saveUi(page);assert.equal(state.configs.find(c=>c.id==='c0').name,'配置0');
 await redoUi(page);await saveUi(page);assert.equal(state.configs.find(c=>c.id==='c0').name,'释放后编辑');
 await page.setViewportSize({width:900,height:900});await page.locator('#overview').click();await page.locator('.overview-row').first().waitFor();await closeUi(page);await page.waitForFunction(()=>!window.memoryProbe.info().full);
 assert.equal(await page.locator('[data-config="name"]').inputValue(),'释放后编辑');assert.deepEqual(errors,[]);
 const originalOrder=state.configs.map(c=>c.id);
 // 配置拖动和店铺优惠券分别走可见入口，保留两个独立历史节点。
 const from=page.locator('.config-item[data-id="c0"]'),to=page.locator('.config-item[data-id="c1"]');await from.scrollIntoViewIfNeeded();await to.scrollIntoViewIfNeeded();const transfer=await page.evaluateHandle(()=>new DataTransfer()),target=await to.boundingBox();await from.dispatchEvent('dragstart',{dataTransfer:transfer});await to.dispatchEvent('dragover',{dataTransfer:transfer,clientY:target.y+target.height-2});await to.dispatchEvent('drop',{dataTransfer:transfer,clientY:target.y+target.height-2});await transfer.dispose();await page.waitForFunction(()=>window.memoryProbe.snapshot().configs[0].id==='c1');await saveUi(page);assert.deepEqual(state.configs.map(c=>c.id),[originalOrder[1],originalOrder[0],...originalOrder.slice(2)]);await page.locator('#coupon-open').click();await page.locator('#shop-coupon').fill('10');await page.locator('#coupon-save').click();await saveUi(page);await page.waitForFunction(()=>!window.memoryProbe.info().full);
 const globalCompacted=await page.evaluate(()=>window.memoryProbe.info());assert(globalCompacted.history.some(h=>h.scope==='workspace'));assert.ok(globalCompacted.details<=16);
 state.configs.find(c=>c.id==='c200').name='远端未加载配置';const extra={...structuredClone(state.configs[0]),id:'remote-extra',productId:'remote-product',name:'远端新增'};state.configs.push(extra);state.revision++;
 await undoUi(page);await saveUi(page);await undoUi(page);await saveUi(page);
 assert.equal(state.shopSettings.intel.coupon,0);assert.deepEqual(state.configs.map(c=>c.id),[...originalOrder,'remote-extra']);assert.equal(state.configs.find(c=>c.id==='c200').name,'远端未加载配置');
 await page.waitForFunction(()=>!window.memoryProbe.info().full);
 await redoUi(page);await saveUi(page);await redoUi(page);await saveUi(page);assert.equal(state.shopSettings.intel.coupon,10);assert.deepEqual(state.configs.map(c=>c.id),[originalOrder[1],originalOrder[0],...originalOrder.slice(2),'remote-extra']);
 assert.deepEqual(errors,[]);
 const result={status:'passed',before,hydrated,after,globalCompacted,globalUndoRedoRemotePreserved:true,saveUndoRedo:true,narrowCompaction:true,errors,detailRequests:requests.filter(r=>r.ids).map(r=>r.ids.length)};await fs.writeFile(artifact('memory-compaction-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
