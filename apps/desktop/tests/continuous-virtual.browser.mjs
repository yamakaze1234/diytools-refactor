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
process.env.REUI_IFRAME??='1';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const configs=Array.from({length:40},(_,i)=>{
 const product={id:`p${0}`,name:`隔离链接${0}`,shopId:'intel',spu:'',configs:[]};
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
 await page.locator('[data-continuous-config="c0"]').waitFor();
 await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.length===40);assert.ok(await page.locator('[data-continuous-config]').count()<=5);



 const locate=async id=>{await page.locator('.config-item[data-id="'+id+'"]').click();await page.locator('[data-continuous-config="'+id+'"]').waitFor();await page.waitForFunction(id=>{const s=document.querySelector('.continuous-sheet').getBoundingClientRect(),r=document.querySelector('[data-continuous-config="'+id+'"]')?.getBoundingClientRect();return r&&r.top<s.bottom&&r.bottom>s.top;},id);};
 const field=page.locator('[data-continuous-config="c0"] textarea[aria-label$="CPU 展示名称"]');await field.focus();await field.pressSequentially('持续输入测试ABC',{delay:25});const handle=await field.elementHandle();await field.evaluate(n=>n.setSelectionRange(2,4));
 // 虚拟表按实际行高更新总高度，持续滚到测量后的底部。
 await page.waitForFunction(()=>{const sheet=document.querySelector('.continuous-sheet');sheet.scrollTop=sheet.scrollHeight;return !!document.querySelector('[data-continuous-config="c39"]');});await page.locator('[data-continuous-config="c39"]').waitFor();assert.ok(await handle.evaluate(n=>n.isConnected&&n.ownerDocument.activeElement===n&&n.selectionStart===2&&n.selectionEnd===4));
 await page.getByLabel('筛选当前链接配置').focus();await page.waitForFunction(()=>!document.querySelector('[data-continuous-config="c0"]'));
 await locate('c39');const copyButton=page.locator('[data-continuous-config="c39"] [data-row-slot="0"]');await copyButton.click();
 const copied=await copyButton.evaluate(n=>{const d=new DataTransfer();n.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:d}));return d.getData('application/x-diy-workbench-rows');});assert.ok(copied);
 await locate('c0');const pasteButton=page.locator('[data-continuous-config="c0"] [data-row-slot="3"]');await pasteButton.click();await pasteButton.evaluate((n,raw)=>{const d=new DataTransfer();d.setData('application/x-diy-workbench-rows',raw);n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));},copied);
 assert.equal(await page.evaluate(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').parts.find(p=>p.slot==='内存').goodsId),'1001');
 await page.evaluate(()=>window.memoryProbe.undo());assert.notEqual(await page.evaluate(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').parts.find(p=>p.slot==='内存')?.goodsId),'1001');
 await locate('c39');assert.equal(await page.locator('[data-continuous-config="c39"] [data-row-slot="0"]').getAttribute('aria-pressed'),'true');
 await page.getByLabel('筛选当前链接配置').fill('配置40');await page.waitForFunction(()=>document.querySelectorAll('[data-continuous-config]').length===1);assert.ok(await page.locator('[data-continuous-config="c39"]').isVisible());
 await locate('c20');assert.equal(await page.getByLabel('筛选当前链接配置').inputValue(),'');
 for(const width of [1000,1920,1500]){await topPage.setViewportSize({width,height:1000});await locate('c39');await locate('c0');}
 const picker=page.locator('[data-continuous-config="c0"] [data-slot="autocomplete-input"][aria-label$="CPU 实际配件"]');await picker.fill('50042');await page.getByRole('option').filter({hasText:'性能样本 CPU 42'}).click();assert.equal(await page.evaluate(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].goodsId),'50042');
 await page.evaluate(()=>window.memoryProbe.save());assert.equal(state.configs.find(c=>c.id==='c0').actualParts[0].goodsId,'50042');

 // 新增行沿用配件选择、复制、撤销和保存；滚动中的表头不得遮挡上一行。
 await locate('c0');const add=page.getByRole('button',{name:'配置1 新增配件',exact:true});
 for(const n of [6,7,8]){await add.click();await page.getByLabel('配置1 配件'+n+' 展示配件',{exact:true}).waitFor();}
 const extraPicker=page.getByLabel('配置1 配件8 展示配件',{exact:true});await extraPicker.fill('1002');await page.getByRole('option').filter({hasText:'验收内存'}).click();
 const extraText=page.getByLabel('配置1 配件8 展示名称',{exact:true});await extraText.fill('新增配件显示');await page.evaluate(()=>window.memoryProbe.save());
 assert.equal(state.configs.find(c=>c.id==='c0').parts.find(p=>p.slot==='配件8').displayName,'新增配件显示');
 await page.getByRole('button',{name:'仅看差异',exact:false}).click();await locate('c0');await add.click();await page.getByLabel('配置1 配件9 展示配件',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'仅看差异',exact:false}).getAttribute('aria-pressed'),'false');await page.evaluate(()=>window.memoryProbe.undo());await page.waitForFunction(()=>!document.querySelector('[aria-label="配置1 配件9 展示配件"]'));
 // 删除中间空行与有内容的行，撤销恢复原编号和内容；保存后删除仍生效。
 await page.getByRole('button',{name:'配置1 删除配件8',exact:true}).click();await page.getByLabel('配置1 配件8 展示配件',{exact:true}).waitFor({state:'detached'});assert.equal(await page.getByLabel('配置1 配件8 展示配件',{exact:true}).count(),0);
 await page.evaluate(()=>window.memoryProbe.undo());await page.getByLabel('配置1 配件8 展示名称',{exact:true}).waitFor();assert.equal(await page.getByLabel('配置1 配件8 展示名称',{exact:true}).inputValue(),'新增配件显示');
 await page.locator('[data-continuous-config="c0"] [data-row-slot="16"]').click();await page.getByRole('button',{name:'配置1 删除配件6',exact:true}).click();await page.getByLabel('配置1 配件6 展示配件',{exact:true}).waitFor({state:'detached'});
 assert.equal(await page.getByLabel('配置1 配件6 展示配件',{exact:true}).count(),0);assert.equal(await page.getByLabel('配置1 配件7 展示配件',{exact:true}).count(),1);
 assert.equal(await page.locator('[data-continuous-config="c0"] [data-row-slot][aria-pressed="true"]').count(),0);
 const header=page.locator('[data-continuous-config="c0"] thead');assert.equal(await header.evaluate(n=>getComputedStyle(n).position),'static');
 await page.locator('.continuous-sheet').evaluate(n=>n.scrollTop=100);await page.waitForTimeout(100);const offset=await header.evaluate(n=>({top:n.getBoundingClientRect().top,scroll:document.querySelector('.continuous-sheet').scrollTop}));await page.locator('.continuous-sheet').evaluate(n=>n.scrollTop+=80);await page.waitForTimeout(100);const moved=await header.evaluate(n=>({top:n.getBoundingClientRect().top,scroll:document.querySelector('.continuous-sheet').scrollTop}));assert.ok(Math.abs(moved.top-offset.top+moved.scroll-offset.scroll)<3,JSON.stringify({offset,moved}));
 await page.evaluate(()=>window.memoryProbe.save());await locate('c39');await locate('c0');assert.equal(await page.getByLabel('配置1 配件8 展示名称',{exact:true}).inputValue(),'新增配件显示');
 const cdp=await topPage.context().newCDPSession(topPage);await cdp.send('HeapProfiler.collectGarbage');const before=await cdp.send('Runtime.getHeapUsage');
 for(let i=0;i<8;i++){await locate('c39');await locate('c0');}await cdp.send('HeapProfiler.collectGarbage');const after=await cdp.send('Runtime.getHeapUsage');
 await topPage.evaluate(()=>{window.framesMeasured=[];new PerformanceObserver(l=>window.framesMeasured.push(...l.getEntries().map(e=>e.duration))).observe({type:'long-animation-frame'});});
 for(let i=0;i<6;i++){await page.locator('#workbench-theme-toggle').click();await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-workbench-theme-changing'));}
 const result={passed:true,configs:40,mounted:await page.locator('[data-continuous-config]').count(),dom:await cdp.send('Memory.getDOMCounters'),heapBefore:before.usedSize,heapAfter:after.usedSize,extraRowsDeleteSaveUndo:true,extraRowsAddEditSaveUndo:true,nonOverlappingHeaders:true,focusAndSelectionPreserved:true,offscreenUnmount:true,selectionRestored:true,copyPasteUndo:true,filterAndLocate:true,responsive:true,pickerAndSave:true,themeFrames:await topPage.evaluate(()=>window.framesMeasured),errors};assert.deepEqual(errors,[]);assert.ok(result.mounted<=6);assert.ok(result.dom.nodes<15000);await topPage.reload();await topPage.locator('iframe').waitFor();page=await topPage.locator('iframe').elementHandle().then(h=>h.contentFrame());await page.waitForFunction(()=>window.workbenchReady);await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();await page.getByLabel('配置1 配件8 展示名称',{exact:true}).waitFor();assert.equal(await page.getByLabel('配置1 配件8 展示名称',{exact:true}).inputValue(),'新增配件显示');assert.equal(await page.getByLabel('配置1 配件9 展示配件',{exact:true}).count(),0);await page.getByLabel('配置1 配件8 展示名称',{exact:true}).scrollIntoViewIfNeeded();await page.locator('.continuous-sheet').screenshot({path:new URL('../../../../expanded-parts-browser.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1')});assert.equal(await page.getByLabel('配置1 配件6 展示配件',{exact:true}).count(),0);result.extraRowsReload=true;console.log(JSON.stringify(result));await fs.writeFile(process.env.PERF_OUTPUT||new URL('../../../../virtual-performance-result.json',import.meta.url),JSON.stringify(result,null,2));
}finally{await browser.close();host?.kill();}
