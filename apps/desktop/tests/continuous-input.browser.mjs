/** ReUI 隔离验收：真实 React/业务页面，保存接口仅写合成样本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
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
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/renumber-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 let source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 source=source.replace('render:(container,model)=>reactWorkbench.continuous(container,model)', 'render:(container,model)=>{window.continuousDraws=(window.continuousDraws||0)+1;const t=performance.now();const result=reactWorkbench.continuous(container,model);(window.renderTimes??=[]).push(performance.now()-t);return result}');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),redraw:()=>continuousWorkbench.draw(),updateCatalog:()=>{state.sourceCatalog.find(r=>r.sourceId==='perf-42').name='更新后的配件';state.costSource.find(r=>r.goodsId==='50042').stockAvailable=0;continuousWorkbench.draw();},undo:()=>stepHistory(history,redoHistory,'撤销'),redo:()=>stepHistory(redoHistory,history,'重做'),close:()=>closeDialog(),save:()=>save()};`}));
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
  await topPage.route('**/workbench/reui-host',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><script src="/workbench/endfield-init.js"></script><link rel="stylesheet" href="/workbench/endfield/endfield.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"><script type="module" src="/workbench/endfield-theme.js"></script><style>body{margin:0}html,body,#root{height:100%;margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;window.isTauri=true;window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async(command)=>command==='cloud_native_json_request'?{status:200,body:JSON.stringify({configured:false})}:1};const {default:App}=await import('/src/App.tsx');window.installWorkbenchBridge=async()=>{};const host=document.createElement('div');host.id='root';document.body.append(host);createRoot(host).render(React.createElement(App));</script>`}));
  await topPage.goto(base+'/workbench/reui-host');await topPage.locator('iframe').waitFor();page=await topPage.locator('iframe').elementHandle().then(h=>h.contentFrame());
 }else await page.goto(base+'/workbench/renumber-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();
 await page.locator('[data-continuous-config="c3"]').waitFor();
 assert.equal(await page.locator('[data-row-slot]').count(),56);


 const editing=page.locator('[data-continuous-config="c0"] input[aria-label$="配置名称"]');
 await editing.focus();await page.evaluate(()=>{window.continuousDraws=0;window.renderTimes=[];window.perfEntries=[];new PerformanceObserver(list=>window.perfEntries.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});});
 const begin=Date.now();await editing.pressSequentially('test',{delay:30});await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').name==='配置1test');await page.waitForTimeout(100);
 const performanceResult={typingMs:Date.now()-begin,...await page.evaluate(()=>({draws:window.continuousDraws,longTasks:window.perfEntries}))};assert.equal(performanceResult.draws,4);
 const field=page.locator('[data-continuous-config="c0"] textarea[aria-label$="CPU 展示名称"]');
 await field.fill('');await field.focus();const original=await field.elementHandle();
 await field.pressSequentially('顺畅输入ABC',{delay:25});
 assert.equal(await field.inputValue(),'顺畅输入ABC');assert.ok(await original.evaluate(n=>n===document.activeElement&&n.isConnected));
 await field.evaluate(n=>{n.setSelectionRange(2,2);n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));});
 await page.evaluate(()=>window.memoryProbe.redraw());
 await page.waitForTimeout(100);
 assert.ok(await original.evaluate(n=>n===document.activeElement&&n.isConnected&&n.selectionStart===2));
 await field.evaluate(n=>n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'畅'})));
 await field.press('Tab');assert.equal(await field.inputValue(),'顺畅输入ABC');
 const price=page.locator('[data-continuous-config="c0"] input[aria-label$="到手价"]');await price.fill('6888');await price.press('Tab');assert.equal(await price.inputValue(),'6888');
 const picker=page.locator('[data-continuous-config="c0"] [data-slot="autocomplete-input"][aria-label$="CPU 实际配件"]');await picker.fill('50042');await page.getByRole('option').filter({hasText:'性能样本 CPU 42'}).click();
 await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].goodsId==='50042');
 await page.evaluate(()=>window.memoryProbe.save());assert.equal(state.configs.find(c=>c.id==='c0').price,6888);assert.equal(state.configs.find(c=>c.id==='c0').parts[0].displayName,'顺畅输入ABC');
 // Content versions must invalidate after in-place source and stock updates.
 await page.evaluate(()=>window.memoryProbe.updateCatalog());
 await picker.fill('50042');await page.getByRole('option').filter({hasText:'更新后的配件'}).waitFor();assert.match(await page.getByRole('option').filter({hasText:'更新后的配件'}).innerText(),/无库存/);await picker.press('Escape');
 await page.locator('#link-parts').click();await page.locator('[data-reui-link-parts]').waitFor();
 const layouts=[];
 for(const width of [1280,800,400]){await topPage.setViewportSize({width,height:900});await page.waitForTimeout(60);const layout=await page.evaluate(()=>{const d=document.querySelector('#dialog'),r=d.getBoundingClientRect();return{width:innerWidth,dialogWidth:r.width,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,fields:[...d.querySelectorAll('[data-rule-mode],[data-rule-query],[data-product-query],[data-rule-qty]')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x,right:r.right,y:r.y}})}});assert.ok(layout.scrollWidth<=layout.clientWidth+2);assert.ok(layout.fields.every(r=>r.x>=0&&r.right<=width));if(width===1280)assert.ok(layout.fields.every(r=>Math.abs(r.y-layout.fields[0].y)<2));layouts.push(layout);}
 await topPage.setViewportSize({width:1280,height:900});await page.evaluate(()=>document.documentElement.dataset.workbenchTheme='dark');await page.locator('#dialog').screenshot({path:new URL('../../../../batch-layout-dark.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 assert.deepEqual(errors,[]);
 const result={passed:true,catalogRows:5002,configs:4,performance:performanceResult,stableInputNode:true,compositionCaret:true,saveReadback:true,catalogStockInvalidation:true,layouts};
 await fs.writeFile(new URL('../../../../input-layout-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();host?.kill();}
