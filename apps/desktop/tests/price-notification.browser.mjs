/** 价格通知隔离浏览器验收：导入完成一次提示，受阻及慢请求不在后续操作补弹。 */
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
let waitForList=null,listStarted=null,releaseList=()=>{};
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/memory-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={erp:async result=>{const accepted=await receiveErpForPrices(result);if(accepted!==false)await checkPriceChanges();return accepted;},check:()=>checkPriceChanges(),open:()=>openOverview(),rawOpen:openDialog,close:()=>closeDialog(),save:()=>save()};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({path,ids:payload?.ids});let value={};
  if(path==='/api/price-changes/list'){if(waitForList){listStarted();await waitForList;}value={batches};}
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
 await page.locator('.maintenance-tools > summary').click();
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
 // 本次ERP成功但其他功能仍打开：关闭后再点击配件功能，不应留下延期通知。
 await page.evaluate(()=>window.memoryProbe.open());state.revision=3;batches=[{revision:3,seen:false},...batches];
 await page.evaluate(()=>window.memoryProbe.erp({ok:true,revision:3}));
 assert.equal(await page.locator('#dialog-title').textContent(),'配置总览');
 await page.evaluate(()=>window.memoryProbe.close());await page.locator('#link-parts').click();
 await page.waitForFunction(()=>document.querySelector('#dialog-title').textContent==='链接内配件批量修改');
 await page.evaluate(()=>window.memoryProbe.close());await page.waitForTimeout(2700);
 assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 // 查询还未返回时已经点击并关闭其他功能，旧查询也不能在空闲时补弹。
 waitForList=new Promise(resolve=>releaseList=resolve);
 const started=new Promise(resolve=>listStarted=resolve);state.revision=4;batches=[{revision:4,seen:false},...batches];
 await page.evaluate(()=>{window.pendingErp=window.memoryProbe.erp({ok:true,revision:4});});await started;
 await page.locator('#link-parts').click();await page.waitForFunction(()=>document.querySelector('#dialog').open&&document.querySelector('#dialog-title').textContent==='链接内配件批量修改');
 await page.evaluate(()=>window.memoryProbe.close());releaseList();waitForList=null;
 await page.evaluate(()=>window.pendingErp);await page.waitForTimeout(2700);
 assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 // 隐藏菜单里的既有手动按钮仍可调用。
 await page.locator('#price-changes-open').evaluate(n=>n.click());await page.waitForFunction(()=>document.querySelector('#dialog-title').textContent==='检查价格变化');
 await page.locator('#pc-close').click();await page.evaluate(()=>window.memoryProbe.check());assert.equal(await page.locator('#dialog').evaluate(n=>n.open),false);
 // 关闭与处理回执发生在同一轮事件中：旧DOM尚未清理时也不能重新打开弹窗。
 const staysClosed=await page.evaluate(async config=>{
  const {openPriceChanges}=await import('/workbench/price-changes-ui.js');let finish;
  const detail={revision:4,at:new Date().toISOString(),items:[{goodsId:'115213',name:'隔离配件',slots:['CPU'],before:{tax:100,erp:100},after:{tax:200,erp:200},configIds:[config.id]}],configs:[{before:config,after:config}],handled:[]};
  await openPriceChanges({openDialog:window.memoryProbe.rawOpen,configs:()=>[config],request:async path=>path.endsWith('/list')?{batches:[{revision:4}]}:path.endsWith('/detail')?detail:path.endsWith('/handle')?new Promise(resolve=>finish=resolve):{ok:true},toast(){}});
  document.querySelector('[data-tab="links"]').click();document.querySelector('#pc-handle').click();
  document.querySelector('#dialog').close();finish({ok:true});await Promise.resolve();await Promise.resolve();
  return !document.querySelector('#dialog').open;
 },configs[0]);assert.equal(staysClosed,true);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',oldUnreadIgnored:true,otherButtonsUnaffected:true,erpReceiptPopupOnce:true,blockedImportNeverReopens:true,slowQueryNeverInterrupts:true,closedReceiptNeverReopens:true,manualEntry:true,errors},null,2));
}finally{releaseList();await browser.close();}
