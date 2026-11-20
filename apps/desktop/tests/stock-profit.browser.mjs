/** ReUI 隔离验收：真实 React/业务页面，保存接口仅写合成样本。 */
import assert from 'node:assert/strict';
import {artifact,configTable,displayText,actualPicker,openAdvanced,mainTable,saveUi,undoUi,redoUi,closeUi,textSelection,textOffsets} from './continuous-regression-helper.mjs';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
process.env.REUI_IFRAME??='1';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/25)}`,name:`隔离链接${Math.floor(i/25)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'验收CPU',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'验收内存',erp:220,tax:240}];
state.sourceCatalog.push(...Array.from({length:5000},(_,i)=>({shopId:'intel',sourceId:'perf-'+i,goodsId:String(50000+i),name:'性能样本 CPU '+i,erp:100,tax:120})));
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:12}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);}
let host,callStore,storeDirectory;
if(process.env.REUI_REAL_STORE==='1'){
 const directory=fileURLToPath(new URL(`../../../sandbox/reui-acceptance-${Date.now()}/`,import.meta.url));
 storeDirectory=directory;await fs.mkdir(directory,{recursive:true});await fs.mkdir(directory+'/workbench-assets');
 const seed=new URL('../../../sandbox/migration-review/20261011/',import.meta.url);await fs.mkdir(seed,{recursive:true});
 await fs.writeFile(new URL('source-state.json',seed),JSON.stringify(state),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 host=spawn(fileURLToPath(new URL('../src-tauri/target/debug/workbench-review-host.exe',import.meta.url)),[],{windowsHide:true,env:{...process.env,DIYTOOLS_REVIEW_DIRECTORY:directory},stdio:['pipe','pipe','inherit']});
 const pending=[];createInterface({input:host.stdout}).on('line',line=>{const item=pending.shift();if(item){try{const result=JSON.parse(line);if(result.status>=400)item.reject(Error(result.body));else item.resolve(JSON.parse(result.body));}catch(error){item.reject(error);}}});
 host.on('error',e=>{while(pending.length)pending.shift().reject(e);});host.on('exit',code=>{while(pending.length)pending.shift().reject(Error(`review host exited ${code}`));});
 callStore=(method,path,body)=>new Promise((resolve,reject)=>{pending.push({resolve,reject});host.stdin.write(JSON.stringify({method,path,body:body==null?null:JSON.stringify(body)})+'\n');});
 const empty=await callStore('GET','/api/state');await callStore('POST','/api/state',{...state,baseRevision:empty.revision});state=await callStore('GET','/api/state');
 console.log(JSON.stringify({isolatedRustStore:directory}));
}
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.setDefaultTimeout(12000);page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/renumber-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 let source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 source=source.replace('render:(container,model)=>reactWorkbench.continuous(container,model)', 'render:(container,model)=>{window.continuousDraws=(window.continuousDraws||0)+1;const t=performance.now();const result=reactWorkbench.continuous(container,model);(window.renderTimes??=[]).push(performance.now()-t);return result}');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={historyState:()=>({undo:history.length,redo:redoHistory.length,counter:changeCounter}),snapshot:()=>structuredClone(state)};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({method:req.method(),path,ids:payload?.ids});let value={};
  if(callStore&&(/^\/api\/(workspace|configs|state|cost-sync)/.test(path))){value=await callStore(req.method(),path+new URL(req.url()).search,payload);if(req.method()==='POST')state=await callStore('GET','/api/state');await route.fulfill({json:value});return;}
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
 if(process.env.REUI_IFRAME==='1'){
  await topPage.route('**/workbench/reui-host',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><script src="/workbench/endfield-init.js"></script><link rel="stylesheet" href="/workbench/endfield/endfield.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"><script type="module" src="/workbench/endfield-theme.js"></script><style>body{margin:0}html,body,#root{height:100%;margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;/* 宿主先核对启动模式，隔离桩明确使用本机模式。 */window.isTauri=true;window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async(command)=>command==='nas_native_request'?{status:200,body:JSON.stringify({main_editor:false})}:command==='cloud_native_json_request'?{status:200,body:JSON.stringify({configured:false})}:1};const {default:App}=await import('/src/App.tsx');window.installWorkbenchBridge=async()=>{};const host=document.createElement('div');host.id='root';document.body.append(host);createRoot(host).render(React.createElement(App));</script>`}));
  await topPage.goto(base+'/workbench/reui-host');await topPage.locator('iframe').waitFor();page=await topPage.locator('iframe').elementHandle().then(h=>h.contentFrame());
 }else await page.goto(base+'/workbench/renumber-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"] .link-arrow').click();await page.locator('[data-id="c0"]').click();
 await page.locator('[data-continuous-config="c3"]').waitFor();
 // 默认九个基础槽位，空扩展配件不再占据总表行。
 assert.equal(await page.locator('[data-row-slot]').count(),36);
 // Link metadata edits must remain scoped; loading the full workspace freezes large shops.
 const fullReads=requests.filter(r=>r.path==='/api/state'&&r.method==='GET').length;
 await page.locator('[data-link-menu="p0"]').click();
 const swatch=page.locator('[data-card-color="#e7f0ff"]');
 assert.equal(await swatch.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(231, 240, 255)');
 await swatch.click();
 await page.waitForFunction(()=>document.querySelector('[data-list-product="p0"]')?.hasAttribute('data-link-colored'));
 await saveUi(page);
 assert.equal(requests.filter(r=>r.path==='/api/state'&&r.method==='GET').length,fullReads);
 assert.ok(state.configs.every(c=>c.productCardColor==='#e7f0ff'));
 await undoUi(page);
 await saveUi(page);
 assert.ok(state.configs.every(c=>!c.productCardColor));
 const headingGeometry=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const title=r('.side-title'),button=r('#new-product'),count=r('#count'),box=r('.sidebar-list-heading');return {separateRows:button.top>=title.bottom,countInside:count.right<=box.right,titleHeight:title.height};});
 assert.ok(headingGeometry.separateRows&&headingGeometry.countInside&&headingGeometry.titleHeight<30,JSON.stringify(headingGeometry));




 const config=configTable(page,'c0');
 // 边界值只写本进程的合成 HTTP 夹具，再真实重载；不注入应用内业务修改。
 const scenario=async({profit=1,term=0,stock=12,special=false,actualId='1001'}={})=>{
  for(const c of state.configs){c.price=1000;c.installment=term;const fee=term===12?60:term===24?100:0;c.parts=[{slot:'CPU',...state.sourceCatalog[0],qty:1}];c.actualParts=[{...c.parts[0],goodsId:actualId,erp:980-fee-profit,tax:860-fee-profit,specialComponent:special}];}
  state.costSource.find(p=>p.goodsId==='1001').stockAvailable=stock;state.revision++;await topPage.reload();if(process.env.REUI_IFRAME==='1'){await topPage.locator('iframe').waitFor();page=await topPage.locator('iframe').elementHandle().then(h=>h.contentFrame());}await page.waitForFunction(()=>window.workbenchReady);if(!await page.locator('.config-item[data-id="c0"]').isVisible())await page.locator('[data-product-toggle="p0"] .link-arrow').click();await page.locator('.config-item[data-id="c0"]').click();await configTable(page,'c0').waitFor();
 };
 const results=[];
 for(const theme of ['light','dark']){
  if(await page.evaluate(()=>document.documentElement.dataset.workbenchTheme)!==theme)await page.locator('#workbench-theme-toggle').click();
  const colors=[];
  for(const [profit,tone] of [[1,'positive'],[0,'neutral'],[-.01,'negative'],[-100,'negative'],[-100.01,'loss']]){
   await scenario({profit});
   // 总表使用已确认的成本加费口径，旧四档颜色在成本核算和总览继续验收。
   const table=configTable(page,'c0'),tableTax=Number((await table.locator('input[aria-label="配置1核算利润"]:visible').inputValue()).replaceAll(',','')),tableErp=Number((await table.locator('input[aria-label="配置1ERP利润"]:visible').inputValue()).replaceAll(',',''));assert.ok(Math.abs(tableTax-(1000-(860-profit)*1.04-100))<=.51);assert.ok(Math.abs(tableErp-profit)<=.5);
   await openAdvanced(page,'costs');const summary=page.locator('#editor .summary-grid');await summary.locator('[data-profit-tone="'+tone+'"]').first().waitFor();assert.equal(await summary.locator('strong[data-profit-tone="'+tone+'"]').count(),2);assert.ok(Math.abs(Number((await summary.locator('strong[data-profit-tone]').first().innerText()).replace(/[¥,]/g,''))-profit)<=.5);colors.push({profit,tone,color:await summary.locator('strong[data-profit-tone]').first().evaluate(n=>getComputedStyle(n).color)});
  }
  assert.equal(new Set(colors.map(c=>c.color)).size,4);
  // 总表保留精简库存值，高级实际配件页保留偏低/缺货/未知等说明。
  for(const [stock,status,text] of [[12,'ok','12'],[5,'low','5·库存偏低'],[0,'out','0·无库存'],[-2,'out','-2·无库存'],[null,'unknown','未知']]){
   await scenario({stock});const cell=configTable(page,'c0').locator('tbody [data-metric="库存"]').first();assert.match(await cell.innerText(),stock==null?/未知/:new RegExp('^'+stock+'$'));assert.equal(await cell.evaluate(n=>n.classList.contains('ov-stock-out')),status==='out');await openAdvanced(page,'actual');const value=page.locator('#editor .component-stock.stock-'+status).first();await value.waitFor();assert.ok((await value.innerText()).replace(/\s/g,'').includes(text),JSON.stringify({stock,status,text,actual:await value.innerText()}));
  }
  await scenario({special:true});assert.equal(await configTable(page,'c0').locator('tbody [data-metric="库存"]').first().innerText(),'—');await openAdvanced(page,'actual');await page.locator('#editor .component-stock.stock-special').waitFor();
  await scenario({actualId:'999999'});await openAdvanced(page,'actual');await page.locator('#editor .component-stock.stock-unknown').waitFor();
  for(const term of [0,12,24]){
   await scenario({term});if(term){assert.match(await configTable(page,'c0').locator('.ov-controls').first().innerText(),term===12?/−60/:/−100/);assert.match(await page.locator('#product-panel').innerText(),new RegExp(term+'\\s*期分期'));}else assert.equal(await configTable(page,'c0').locator('.ov-controls small').count(),0);await openAdvanced(page,'costs');const label=await page.locator('#installment-label').innerText();assert.match(label,term?new RegExp(term+'\\s*期'):/不分期/);if(term){assert.match(label,term===12?/6%/:/10%/);assert.match(await page.locator('#installment-fee').innerText(),term===12?/60(?:\.00)?/:/100(?:\.00)?/);assert.match(await page.locator('#erp-profit span').innerText(),/分期后实际.*¥1(?:\.00)?/);assert.match(await page.locator('#editor .summary-grid').innerText(),/分期后实际.*¥1(?:\.00)?/);}
  }
  await mainTable(page);const maintenance=page.locator('.maintenance-tools');if(await maintenance.evaluate(n=>n.open))await maintenance.locator('summary').click();const menu=page.locator('.page-heading .action-menu');await menu.locator('summary').click();await page.waitForTimeout(260);const hit=await menu.locator('#delete-current').evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.ok(hit,'menu must be hit-testable above tabs');await menu.locator('summary').click();
  await scenario({profit:-100.01,term:24});await openAdvanced(page,'costs');assert.equal(await page.locator('#erp-profit').getAttribute('data-profit-tone'),'negative');assert.equal(await page.locator('#erp-profit span').getAttribute('data-profit-tone'),'loss');assert.equal(await page.locator('#editor .summary-grid [data-profit-tone=loss]').count(),2);await page.locator('#overview').click();await page.locator('.overview-profit').first().waitFor();assert.equal(await page.locator('.overview-row').first().locator('.overview-profit').nth(1).getAttribute('data-profit-tone'),'negative');const after=page.locator('.overview-row').first().locator('.overview-installment');assert.equal(await after.getAttribute('data-profit-tone'),'loss');await page.locator('.overview-row').first().hover();assert.equal(await after.evaluate(n=>getComputedStyle(n).color),colors.at(-1).color);await closeUi(page);await mainTable(page);results.push({theme,colors,menuVisible:hit,stockStates:7,installments:[0,12,24],summaryAndOverview:true});
 }
 // 当前总表合并汇总行：各尺寸保持可读，可通过同一横向滚动到全部价格字段。
 const financeLayouts=[];for(const width of [1800,1280,800]){await topPage.setViewportSize({width,height:1000});await page.waitForTimeout(100);const layout=await configTable(page,'c0').evaluate(n=>{const sum=[...n.querySelectorAll('.ov-mobile-sums,.ov-sum-values')].find(e=>e.getBoundingClientRect().height);return {width:sum.getBoundingClientRect().width,font:getComputedStyle(sum.querySelector('input')).fontSize,fields:[...sum.querySelectorAll('input')].length,sheetWidth:document.querySelector('.ov-sheet-scroll').clientWidth,bodyWidth:document.documentElement.scrollWidth};});assert.equal(layout.fields,3);assert.ok(parseFloat(layout.font)>=12);assert.ok(layout.bodyWidth<=width);financeLayouts.push({viewport:width,...layout});}
 await topPage.setViewportSize({width:1800,height:1000});const tax=configTable(page,'c0').locator('.ov-tax-input').first();await tax.fill('169.75');await tax.press('Tab');await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].tax===169.75);assert.equal(await tax.inputValue(),'170');assert.equal((await page.evaluate(()=>window.memoryProbe.snapshot())).configs.find(c=>c.id==='c0').actualParts[0].tax,169.75);await page.locator('.ov-sheet-scroll').evaluate(el=>el.scrollTop=200);const sticky=await configTable(page,'c0').locator('thead').evaluate(el=>getComputedStyle(el).position);assert.equal(sticky,'static','表头随配置滚动，不遮挡输入行');
 // 方图和补白通过真实图片设置入口，缩放只调整查看方式。
 if(await page.locator('#preview-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#preview-toggle').click();await page.locator('#preview-expand').click();await page.locator('.image-settings summary').click();await page.locator('#layout').selectOption('square');await page.locator('#sku-mode').selectOption('padded');await page.waitForFunction(()=>document.querySelector('#poster-stage').style.overflow==='hidden');await page.locator('#preview-expand').click();await saveUi(page);await page.locator('#preview-expand').click();const previewBefore=await page.evaluate(()=>window.memoryProbe.snapshot());await page.locator('[data-preview-fit="fit"]').click();assert.equal(await page.locator('#poster-stage').evaluate(e=>e.style.overflow),'');await page.locator('[data-preview-fit="content"]').click();const enlarged=await page.locator('#poster-stage').evaluate(e=>({width:e.clientWidth,canvasWidth:document.querySelector('#poster').getBoundingClientRect().width,overflow:e.style.overflow}));assert.equal(enlarged.overflow,'hidden');assert.ok(enlarged.canvasWidth>=enlarged.width);assert.deepEqual(await page.evaluate(()=>window.memoryProbe.snapshot()),previewBefore);assert.deepEqual(errors,[]);await fs.writeFile(artifact('stock-profit-result.json'),JSON.stringify({passed:true,results,financeLayouts,headingGeometry,sticky,enlarged,scopedColorSaveUndo:true,integerTaxKeepsPrecision:true},null,2));console.log(JSON.stringify({passed:true,results,financeLayouts}));
}finally{await browser.close();host?.kill();}
