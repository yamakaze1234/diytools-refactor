/** 价格通知隔离浏览器验收：旧未读不弹，本次ERP回执一次，手动入口可用。 */
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
let batches=[{revision:1,seen:false}];
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.on('pageerror',e=>errors.push(e.message));
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/memory-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={erp:result=>receiveErp(result),check:()=>checkPriceChanges(),open:()=>openOverview(),close:()=>closeDialog(),save:()=>save(),info:()=>({full:fullWorkspace,details:state.configs.length,base:acceptedState.configs.length,index:lazyWorkspace.index().summaries.length,dirty,history:history.map(h=>({scope:h.historyScope,count:h.configs.length}))})};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({path,ids:payload?.ids});let value={};
  if(path==='/api/price-changes/list')value={batches};
  else if(path==='/api/price-changes/detail')value={revision:payload.revision,at:new Date().toISOString(),message:'隔离同步价格变化',items:[],configs:[],handled:[]};
  else if(path==='/api/price-changes/seen'){batches=batches.map(b=>b.revision===payload.revision?{...b,seen:true}:b);value={ok:true};}
  else if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:new Date().toISOString(),activityDelta:[]};}
  else if(path==='/api/session')value={defaultOperator:'内存隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/memory-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();
 await page.locator('[data-config="name"]').waitFor();
 // 存在历史未读，等待真实计时器并操作其他按钮也不会扫描价格记录。
 await page.waitForTimeout(2700);await page.evaluate(()=>window.memoryProbe.check());
 assert.equal(requests.filter(r=>r.path==='/api/price-changes/list').length,0);
 await page.evaluate(()=>window.memoryProbe.open());assert.equal(await page.locator('#dialog-title').textContent(),'配置总览');
 await page.evaluate(()=>window.memoryProbe.close());await page.waitForFunction(()=>!document.querySelector('#dialog').open);
 await page.evaluate(()=>window.memoryProbe.check());assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 state.revision=2;batches=[{revision:2,seen:false},...batches];
 await page.evaluate(()=>window.memoryProbe.erp({ok:true,revision:2}));await page.evaluate(()=>window.memoryProbe.check());
 await page.waitForFunction(()=>document.querySelector('#dialog-title').textContent==='本次价格变动');
 await page.locator('#pc-close').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);
 await page.evaluate(()=>window.memoryProbe.check());assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 // 隐藏菜单里的既有手动按钮仍可调用。
 await page.locator('#price-changes-open').evaluate(n=>n.click());await page.waitForFunction(()=>document.querySelector('#dialog-title').textContent==='检查价格变化');
 await page.locator('#pc-close').click();await page.evaluate(()=>window.memoryProbe.check());assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',oldUnreadIgnored:true,otherButtonsUnaffected:true,erpReceiptPopupOnce:true,manualEntry:true,errors},null,2));
}finally{await browser.close();}
