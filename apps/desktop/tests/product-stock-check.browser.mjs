/** 当前链接库存入口验收：真实 React/业务页面，接口只使用合成数据。 */
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
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);}
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/product-stock-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),close:()=>closeDialog()};`}));
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
 await page.goto(base+'/workbench/product-stock-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();

 const baseline=structuredClone(state);
 const check=async(selector,summary)=>{
  if(selector==='#inventory-check-open')await page.locator(selector).evaluate(button=>button.click());
  else await page.locator(selector).click();
  await page.waitForFunction(()=>document.querySelector('#stock-message')?.textContent.startsWith('检查完成'));
  assert.match(await page.locator('#stock-summary').innerText(),summary);
 };
 await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 assert.equal(await page.locator('#dialog-title').innerText(),'检查该链接库存');
 assert.match(await page.locator('#dialog-body > .hint').first().innerText(),/当前链接：隔离链接0/);
 assert.match(await page.locator('#dialog-body').innerText(),/本机最近一次 ERP 库存/);
 assert.deepEqual(await page.locator('[data-stock-locate]').evaluateAll(nodes=>nodes.map(n=>n.dataset.stockLocate)),['c0','c1']);
 await page.locator('#stock-scan').click();
 await page.waitForFunction(()=>!document.querySelector('#stock-scan').disabled);
 assert.match(await page.locator('#stock-summary').innerText(),/检查 1 个链接、2 套配置/);
 await page.locator('[data-stock-edit]').click();
 assert.deepEqual(await page.locator('[data-stock-link]').evaluateAll(nodes=>nodes.map(n=>n.value)),['p0']);
 await page.evaluate(()=>window.memoryProbe.close());
 await check('#inventory-check-open',/检查 2 个链接、4 套配置/);
 assert.equal(await page.locator('#dialog-title').innerText(),'检查链接库存');
 await page.evaluate(()=>window.memoryProbe.close());
 await page.locator('[data-product-toggle="p1"]').click();await page.locator('[data-id="c2"]').click();
 await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 assert.match(await page.locator('#dialog-body > .hint').first().innerText(),/当前链接：隔离链接1/);
 assert.deepEqual(await page.locator('[data-stock-locate]').evaluateAll(nodes=>nodes.map(n=>n.dataset.stockLocate)),['c2','c3']);
 for(const width of [1300,900]){
  await page.evaluate(()=>window.memoryProbe.close());await page.setViewportSize({width,height:900});
  await page.locator('#product-stock-check').scrollIntoViewIfNeeded();
  const box=await page.locator('#product-stock-check').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 }
 if(process.env.STOCK_CHECK_SCREENSHOT){await page.setViewportSize({width:1300,height:1000});await page.locator('#dialog').screenshot({path:process.env.STOCK_CHECK_SCREENSHOT});}
 assert.deepEqual(state,baseline);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',checks:['current link all configurations','rescan scope','replacement scope','global entry unchanged','switch link','1300/900px toolbar','workspace unchanged','no page errors']}));
}finally{await browser.close();}
