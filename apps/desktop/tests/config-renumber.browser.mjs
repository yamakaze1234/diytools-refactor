/** 重新编号隔离验收：真实 React 页面，保存接口仅写合成样本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5194';
const configs=Array.from({length:250},(_,i)=>{
 const product={id:`p${Math.floor(i/25)}`,name:`隔离链接${Math.floor(i/25)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs[0].name='配置1';state.configs[1].name='颜值升级包';state.configs[2].name='配置五：16G / 1T';state.configs[3].name='配置9 · 32G';
const original=structuredClone(state);
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.on('pageerror',e=>errors.push(e.message));
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/renumber-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={undo:()=>stepHistory(history,redoHistory,'撤销'),redo:()=>stepHistory(redoHistory,history,'重做'),close:()=>closeDialog(),save:()=>save()};`}));
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
 await page.goto(base+'/workbench/renumber-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();
 await page.locator('.maintenance-tools summary').click();
 await page.locator('#search').fill('配置1');
 await page.locator('#renumber').click();await page.locator('#renumber-apply').waitFor();
 assert.match(await page.locator('#dialog-body').innerText(),/配置2：16G \/ 1T/);
 assert.match(await page.locator('#dialog-body').innerText(),/颜值升级包（跳过）/);
 await page.locator('#renumber-apply').click();await page.evaluate(()=>window.memoryProbe.save());
 assert.equal(state.configs[2].name,'配置2：16G / 1T');assert.equal(state.configs[3].name,'配置3 · 32G');
 assert.equal(state.configs[1].name,'颜值升级包');assert.equal(state.configs[24].name,'配置24');
 assert.deepEqual(state.configs.slice(25),original.configs.slice(25));
 assert.deepEqual(state.configs.map(c=>c.id),original.configs.map(c=>c.id));
 await page.evaluate(()=>window.memoryProbe.undo());await page.evaluate(()=>window.memoryProbe.save());
 assert.deepEqual(state.configs.map(c=>c.name),original.configs.map(c=>c.name));
 await page.evaluate(()=>window.memoryProbe.redo());await page.evaluate(()=>window.memoryProbe.save());
 assert.equal(state.configs[2].name,'配置2：16G / 1T');
 await page.locator('#renumber').click();assert.equal(await page.locator('#renumber-apply').isDisabled(),true);
 await page.evaluate(()=>window.memoryProbe.close());
 await page.reload();await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c2"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-config="name"]')?.value==='配置2：16G / 1T');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',filteredWholeLink:true,suffixPreserved:true,specialSkipped:true,otherLinksUnchanged:true,orderPreserved:true,saveUndoRedoReload:true,noOpDisabled:true,errors}));
}catch(error){console.error(JSON.stringify({errors,requests:requests.slice(-8)}));throw error;}finally{await browser.close();}
