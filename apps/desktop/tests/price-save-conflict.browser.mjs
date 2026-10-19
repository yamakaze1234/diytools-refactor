/** 真实工作台导入8套价格，模拟保存前版本推进，验证自动覆盖价格及独立字段合并。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const configs=Array.from({length:8},(_,i)=>{const c=blankConfig(null,{id:'p0',name:'隔离链接',shopId:'intel',configs:[]},'配置'+i);return {...c,id:'c'+i,shortName:'配置'+i,shortNameAuto:false,price:5000+i};});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
const posts=[],errors=[];let conflictSent=false;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/conflict-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+'\nwindow.priceConflictProbe={open:()=>openMaintenancePrices(),save:()=>save(),get:()=>({dirty,conflict,prices:state.configs.map(c=>c.price)})};'}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;let value={};
  if(url==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(url==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(url==='/api/state'&&req.method()==='GET')value=state;
  else if(['/api/state','/api/configs/patch','/api/configs/batch'].includes(url)&&payload){
   posts.push(payload);
   if(!conflictSent){conflictSent=true;state.configs.forEach(c=>c.price+=50);state.configs[0].name='并发更新的名称';state.revision++;await route.fulfill({status:409,json:{error:'同一价格字段已经变化'}});return;}
   assert.equal(payload.baseRevision,state.revision);
   state.configs=payload.configs||state.configs.map(c=>payload.changes.find(row=>row.id===c.id)?.after||c);state.revision++;state.updatedAt=new Date().toISOString();
   value=payload.configs?{state,...state}:{configs:payload.changes.map(c=>c.after),revision:state.revision,updatedAt:state.updatedAt,activityDelta:[]};
  }
  else if(url==='/api/session')value={defaultOperator:'隔离验收'};
  else if(url==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(url==='/api/derived/status')value={productFiles:false};
  await route.fulfill({json:value});
 });
 await page.goto((process.env.REACT_TEST_URL||'http://127.0.0.1:5194')+'/workbench/conflict-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();await page.locator('[data-config="name"]').waitFor();
 await page.evaluate(()=>window.priceConflictProbe.open());
 await page.locator('#price-import-text').fill(configs.map((c,i)=>`${c.shortName}\t有货\t${6000+i}`).join('\n'));
 await page.locator('#price-import-check').click();await page.locator('#price-import-apply').click();
 await page.evaluate(()=>window.priceConflictProbe.save());
 assert.deepEqual(state.configs.map(c=>c.price),configs.map((_,i)=>6000+i));assert.equal(state.configs[0].name,'并发更新的名称');
 const result=await page.evaluate(()=>({...window.priceConflictProbe.get(),dialogOpen:document.querySelector('#dialog').open}));
 assert.equal(result.conflict,false);assert.equal(result.dirty,false);assert.equal(result.dialogOpen,false);assert.equal(posts.length,2);assert.deepEqual(errors,[]);
 const out=new URL('../../../sandbox/price-save-conflict-20261019/',import.meta.url);await fs.mkdir(out,{recursive:true});await fs.writeFile(new URL('browser.json',out),JSON.stringify({passed:true,configs:8,posts:posts.length,independentNamePreserved:true,errors,...result},null,2));console.log(JSON.stringify({passed:true,configs:8,posts:posts.length,...result}));
}finally{await browser.close();}
