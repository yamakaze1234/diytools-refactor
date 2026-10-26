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



 const results=[];const close=()=>page.evaluate(()=>window.memoryProbe.close());
 for(const theme of ['light','dark']){
  await page.evaluate(t=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:t})),theme);
  await topPage.setViewportSize({width:1280,height:900});
  for(const [name,button] of [['upgrade','#link-upgrades'],['display-name','#link-display-names'],['appearance','#batch-style'],['ids','#ids'],['global','#global-batch-open']]){
   console.log('checking',theme,name);if(await page.locator('[data-continuous-config="c0"] [role=checkbox]').getAttribute('aria-checked')!=='true')await page.locator('[data-continuous-config="c0"] [role=checkbox]').click();await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] [role=checkbox]')?.getAttribute('aria-checked')==='true');
   await page.locator(button).evaluate(n=>n.click());await page.locator('#dialog[open]').waitFor();
   if(name==='upgrade')await page.locator('#upgrade-batch-candidates [data-upgrade-part]').first().check();
   if(name==='display-name'){await page.locator('#upgrade-batch-query').fill('验收CPU');await page.locator('#upgrade-batch-candidates [data-upgrade-part]').first().click();assert.match(await page.locator('#upgrade-batch-hint').innerText(),/展示名称/);}
   if(name==='global')await page.locator('[data-global-part]').first().click();
   for(const width of [1280,720,400]){
    await topPage.setViewportSize({width,height:900});await page.waitForTimeout(80);
    const layout=await page.locator('#dialog').evaluate(n=>{const body=n.querySelector('#dialog-body'),r=n.getBoundingClientRect();return {width:innerWidth,x:r.x,right:r.right,height:r.height,scrollWidth:body.scrollWidth,clientWidth:body.clientWidth,fields:[...n.querySelectorAll('input:not([type=checkbox]),select,textarea')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{const r=e.getBoundingClientRect();return {id:e.id,x:r.x,right:r.right}})};});
    assert.ok(layout.scrollWidth<=layout.clientWidth+2,name+' overflow at '+width);assert.ok(layout.fields.every(r=>r.x>=0&&r.right<=width),name+' fields at '+width);
    if(width===1280&&name==='upgrade'){const columns=await page.locator('.batch-description-body').evaluate(n=>[...n.children].map(e=>e.getBoundingClientRect().y));assert.equal(columns[0],columns[1]);}
    results.push({theme,name,width,height:layout.height,noOverflow:true});
   }
   await topPage.setViewportSize({width:1280,height:900});
   if(name==='upgrade'&&theme==='light'){
    const before=await page.evaluate(()=>window.memoryProbe.snapshot().configs);
    await page.locator('#upgrade-batch-text').fill('测试加购说明');await page.locator('#upgrade-batch-preview').click();await page.waitForFunction(()=>!document.querySelector('#upgrade-batch-apply').disabled);await page.locator('#upgrade-batch-apply').click();await page.waitForFunction(()=>document.querySelector('#upgrade-batch-status').textContent.startsWith('已保存'));
    assert.equal(state.configs.filter(c=>c.parts[0].upgrade==='测试加购说明').length,4);assert.deepEqual(state.configs.map(c=>c.actualParts),before.map(c=>c.actualParts));
    await page.locator('#upgrade-batch-undo').click();await page.waitForFunction(()=>document.querySelector('#upgrade-batch-status').textContent.startsWith('已还原'));assert.deepEqual(state.configs.map(c=>c.parts),before.map(c=>c.parts));
   }
   await close();
  }
 }
 assert.deepEqual(errors,[]);await fs.writeFile(new URL('../../../../compact-tools-result.json',import.meta.url),JSON.stringify({passed:true,results,descriptionSaveAndRevert:true},null,2));console.log(JSON.stringify({passed:true,results,descriptionSaveAndRevert:true}));
}finally{await browser.close();host?.kill();}
