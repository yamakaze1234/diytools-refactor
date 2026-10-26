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
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),undo:()=>stepHistory(history,redoHistory,'撤销'),redo:()=>stepHistory(redoHistory,history,'重做'),close:()=>closeDialog(),save:()=>save()};`}));
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
 assert.equal(await page.locator('.maintenance-tools').getAttribute('open'),'');
 // UI theme must never invoke the existing poster [data-theme] business actions.
 if(process.env.REUI_IFRAME==='1'){
  const beforeTheme=await page.evaluate(()=>({state:window.memoryProbe.snapshot(),dirty:window.workbenchHasPendingChanges?.()}));
  const writesBefore=requests.filter(r=>r.method==='POST').length;
  await page.locator('#workbench-theme-toggle').click();
  await page.waitForFunction(()=>document.documentElement.dataset.workbenchTheme==='dark');
  assert.equal(await topPage.evaluate(()=>document.documentElement.dataset.workbenchTheme),'dark');
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme')),false);
  assert.equal(await page.locator('.main').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(25, 25, 25)');
  assert.deepEqual(await page.evaluate(()=>({state:window.memoryProbe.snapshot(),dirty:window.workbenchHasPendingChanges?.()})),beforeTheme);
  await topPage.screenshot({path:new URL('../../../../endfield-dark.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('#workbench-theme-toggle').click();
  await page.waitForFunction(()=>document.documentElement.dataset.workbenchTheme==='light');
  assert.deepEqual(await page.evaluate(()=>({state:window.memoryProbe.snapshot(),dirty:window.workbenchHasPendingChanges?.()})),beforeTheme);
  assert.equal(requests.filter(r=>r.method==='POST').length,writesBefore);
 }
 await page.getByLabel('配置1 CPU 展示配件',{exact:true}).fill('验收内存');
 await page.getByRole('option').filter({hasText:'验收内存'}).click();
 await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').parts[0].goodsId==='1002');
 const stateAfter=await page.evaluate(()=>window.memoryProbe.snapshot());
 assert.equal(stateAfter.configs.find(c=>c.id==='c0').actualParts[0].goodsId,'1002');
 await page.evaluate(()=>window.memoryProbe.undo());
 await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').parts[0].goodsId==='1001');
 await page.getByLabel('配置1 CPU 实际配件',{exact:true}).fill('验收内存');
 await page.getByLabel('配置1 CPU 实际配件',{exact:true}).press('ArrowDown');await page.getByLabel('配置1 CPU 实际配件',{exact:true}).press('Enter');
 await page.waitForFunction(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].goodsId==='1002');
 assert.equal((await page.evaluate(()=>window.memoryProbe.snapshot())).configs.find(c=>c.id==='c0').parts[0].goodsId,'1001');
 await page.locator('[data-continuous-config="c0"] [data-row-slot="0"]').click();
 const copied=await page.locator('[data-continuous-config="c0"] [data-row-slot="0"]').evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('application/x-diy-workbench-rows');});
 assert.equal(JSON.parse(copied).rows.length,1);
 await page.locator('[data-continuous-config="c1"] [data-row-slot="9"]').click();
 await page.locator('[data-continuous-config="c1"] [data-row-slot="9"]').evaluate((node,value)=>{const data=new DataTransfer();data.setData('application/x-diy-workbench-rows',value);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},copied);
 const pasted=(await page.evaluate(()=>window.memoryProbe.snapshot())).configs.find(c=>c.id==='c1');
 if(!pasted.parts.find(p=>p.slot==='配件1'))console.error(JSON.stringify({toast:await page.locator('#toast').innerText(),copied,parts:pasted.parts}));
 assert.equal(pasted.parts.find(p=>p.slot==='配件1').goodsId,'1001');assert.equal(pasted.actualParts.find(p=>p.slot==='配件1').goodsId,'1002');
 await page.evaluate(()=>window.memoryProbe.undo());
 assert.ok(!(await page.evaluate(()=>window.memoryProbe.snapshot())).configs.find(c=>c.id==='c1').parts.find(p=>p.slot==='配件1')?.goodsId);
 await page.locator('[data-continuous-config="c0"] [data-row-slot="0"]').click();
 await page.locator('[data-continuous-config="c0"] [data-row-slot="13"]').click({modifiers:['Shift']});
 const block=await page.locator('[data-continuous-config="c0"] [data-row-slot="13"]').evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('application/x-diy-workbench-rows');});
 assert.equal(JSON.parse(block).rows.length,14);
 await page.locator('[data-continuous-config="c1"] [data-row-slot="1"]').click();
 const beforeOverflow=await page.evaluate(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c1'));
 await page.locator('[data-continuous-config="c1"] [data-row-slot="1"]').evaluate((node,value)=>{const data=new DataTransfer();data.setData('application/x-diy-workbench-rows',value);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},block);
 assert.match(await page.locator('#toast').innerText(),/剩余行数不足/);assert.deepEqual(await page.evaluate(()=>window.memoryProbe.snapshot().configs.find(c=>c.id==='c1')),beforeOverflow);
 const price=page.getByRole('spinbutton',{name:'配置2 到手价',exact:true});await price.fill('5999');await price.press('Tab');
 await page.evaluate(()=>window.memoryProbe.save());assert.equal(state.configs.find(c=>c.id==='c1').price,5999);
 await page.getByRole('checkbox',{name:'选择配置1',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="选择配置1"]').getAttribute('aria-checked')==='true');
 for(const [id,heading] of [['link-parts','配件'],['link-upgrades','加购'],['link-display-names','名称'],['batch-style','样式'],['ids','平台 ID']]){await page.locator('#'+id).click();await page.locator('#dialog[open]').waitFor();assert.match(await page.locator('#dialog-title').innerText(),new RegExp(heading));await page.evaluate(()=>window.memoryProbe.close());}
 await page.locator('#link-display-names').click();await page.locator('#upgrade-batch-query').fill('验收CPU');await page.locator('[data-upgrade-part]').first().click();
 await page.locator('#upgrade-batch-text').fill('隔离批量展示名称');await page.locator('#upgrade-batch-preview').click();await page.locator('#upgrade-batch-apply').click();
 await page.locator('#upgrade-batch-undo').waitFor({state:'visible'});
 assert.equal(state.configs.filter(c=>c.parts.some(p=>p.displayName==='隔离批量展示名称')).length,4);
 assert.ok(state.configs.every(c=>c.actualParts.every(p=>p.name!=='隔离批量展示名称')));
 await page.locator('#upgrade-batch-undo').click();await page.waitForFunction(()=>!window.memoryProbe.snapshot().configs.some(c=>c.parts.some(p=>p.displayName==='隔离批量展示名称')));
 await page.evaluate(()=>window.memoryProbe.close());
 await page.locator('#ids').click();await page.locator('#ids-spu').fill('12345678901234567890');await page.locator('#ids-values').fill('98765432109876543210');await page.locator('#ids-apply').click();await page.evaluate(()=>window.memoryProbe.save());
 assert.equal(state.configs.find(c=>c.id==='c0').skuId,'98765432109876543210');assert.equal(state.configs.find(c=>c.id==='c0').spu,'12345678901234567890');
 await page.getByLabel('配置2 版本',{exact:true}).fill('隔离版本批量');await page.getByLabel('配置2 版本',{exact:true}).press('Tab');await page.evaluate(()=>window.memoryProbe.save());
 await page.locator('#batch-style').click();assert.equal(await page.locator('#style-scope').inputValue(),'selected');await page.locator('#style-colors').uncheck();await page.locator('#style-format').uncheck();await page.locator('#style-images').uncheck();await page.locator('#style-version').check();await page.locator('#style-apply').click();await page.evaluate(()=>window.memoryProbe.save());
 assert.equal(state.configs.find(c=>c.id==='c0').version,'隔离版本批量');assert.equal(state.configs.find(c=>c.id==='c0').skuId,'98765432109876543210');assert.equal(state.configs.find(c=>c.id==='c1').price,5999);
 const beforeBatch=structuredClone(state.configs);
 await page.locator('#link-parts').click();await page.locator('[data-reui-link-parts]').waitFor();
 await page.locator('#link-part-scope').selectOption('selected');await page.locator('#link-part-actual').uncheck();
 await page.locator('#link-part-query').fill('验收CPU');
 const oldPart=await page.locator('#link-part-match option').evaluateAll(nodes=>nodes.find(n=>n.textContent.includes('验收CPU'))?.value);
 assert.ok(oldPart);await page.locator('#link-part-match').selectOption(oldPart);
 await page.locator('#link-part-new-query').fill('验收内存');await page.locator('[data-product-id="s-memory"]').click();
 await page.locator('#link-part-add-new').click();assert.equal(await page.locator('.link-part-rule').count(),2);
 await page.locator('#link-part-new-query-2').fill('验收内存');await page.locator('[data-rule="1"] [data-product-id="s-memory"]').click();await page.locator('#link-part-slot-2').selectOption('配件5');
 await page.locator('#link-part-preview').click();assert.equal(await page.locator('#link-part-apply').isEnabled(),true);
 await page.locator('#link-part-qty-2').fill('2');assert.equal(await page.locator('#link-part-apply').isEnabled(),false);
 await page.locator('#link-part-preview').click();await topPage.screenshot({path:new URL('../../../../batch-parts.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 await page.locator('#link-part-apply').click();await page.locator('#link-part-export-panel').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#link-part-status').textContent.startsWith('已保存'));
 const edited=state.configs.find(c=>c.id==='c0');assert.equal(edited.parts[0].goodsId,'1002');assert.equal(edited.parts.find(p=>p.slot==='配件5').qty,2);assert.deepEqual(edited.actualParts,beforeBatch.find(c=>c.id==='c0').actualParts);
 assert.deepEqual(state.configs.filter(c=>c.id!=='c0'),beforeBatch.filter(c=>c.id!=='c0'));
 await page.locator('#link-part-export-scope').selectOption('all');await page.locator('#link-part-export-kind').selectOption('square');assert.match(await page.locator('#link-part-export-summary').innerText(),/4 套，共 4 张/);
 await page.locator('[data-rule="1"] [data-rule-remove]').click();assert.equal(await page.locator('.link-part-rule').count(),1);
 await page.evaluate(()=>window.memoryProbe.close());await page.evaluate(()=>window.memoryProbe.undo());await page.evaluate(()=>window.memoryProbe.save());
 assert.deepEqual(state.configs.find(c=>c.id==='c0').parts,beforeBatch.find(c=>c.id==='c0').parts);
 await page.locator('#link-parts').click();await page.locator('[data-reui-link-parts]').waitFor();assert.equal(await page.locator('.link-part-rule').count(),1);await page.evaluate(()=>window.memoryProbe.close());
 for(const tab of ['display','actual','addons','modules','costs']){await page.locator(`.tabs [data-tab="${tab}"]`).click();await page.locator('#editor').waitFor({state:'visible'});assert.ok((await page.locator('#editor').innerText()).length>5);}
 await page.locator('.tabs [data-tab="parts"]').click();
 // Check modal placement and actual application hooks, beyond isolated panels.
 for(const selector of ['[data-nav="source"]','[data-nav="gallery"]','#workspace-sync']){
  await page.evaluate(selector=>document.querySelector(selector).click(),selector);
  await page.locator('#dialog[open]').waitFor();
  if(selector.includes('source'))await page.locator('#source-name[data-slot="textarea"]').waitFor();
  if(selector.includes('gallery'))await page.locator('[data-reui-gallery]').waitFor();
  if(selector==='#workspace-sync')await page.locator('#cloud-close[data-slot="button"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('#dialog').getAnimations().every(a=>a.playState!=='running'));
  const modal=await page.locator('#dialog').evaluate(d=>{const r=d.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});
  assert.ok(Math.abs(modal.x-(modal.w-modal.right))<2,JSON.stringify(modal));
  assert.ok(Math.abs(modal.y-(modal.h-modal.bottom))<2,JSON.stringify(modal));
  await page.evaluate(()=>window.memoryProbe.close());
  await page.waitForFunction(()=>!document.querySelector('#dialog').open);
 }
 await page.getByLabel('筛选当前链接配置').fill('配置1');assert.equal(await page.locator('[data-continuous-config]').count(),1);
 await page.locator('.config-item[data-id="c3"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-continuous-config]').length===4);
 await page.waitForFunction(()=>{const s=document.querySelector('.continuous-sheet'),c=document.querySelector('[data-continuous-config="c3"]');return Math.abs(s.getBoundingClientRect().top-c.getBoundingClientRect().top)<5;});
 const geometry=[];
 for(const width of [1024,1180,1280,1440,1920]){
  await topPage.setViewportSize({width,height:900});
  await page.locator('.continuous-sheet').evaluate(n=>n.scrollTo(0,0));
  await page.waitForFunction(()=>document.querySelector('.continuous-sheet').clientHeight>200);
  const measured=await page.evaluate(()=>{
   const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
   return {viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth,heading:rect('.product-heading'),main:rect('.main'),sidebar:rect('.sidebar'),preview:rect('.preview-side'),sheet:rect('.continuous-sheet'),table:rect('[data-continuous-config="c0"] table'),row:rect('[data-continuous-config="c0"] tbody tr'),header:rect('.topbar'),collapsed:document.body.classList.contains('preview-collapsed')};
  });
  geometry.push(measured);
  assert.ok(measured.bodyWidth<=width,JSON.stringify(measured));
  assert.equal(measured.header.y,0);assert.equal(measured.main.y,62);assert.equal(measured.sidebar.y,62);
  assert.ok(measured.sheet.height>=280,JSON.stringify(measured));assert.ok(measured.sheet.y<490,JSON.stringify(measured));
  assert.ok(measured.table.width<=1400,JSON.stringify(measured));assert.ok(measured.row.height<=55,JSON.stringify(measured));
  assert.equal(measured.collapsed,width<1280);
  if(width>=1280){assert.equal(measured.preview.y,62);assert.ok(Math.abs(measured.preview.x-measured.main.right)<2);}
  if(process.env.REUI_IFRAME==='1'){assert.equal(await topPage.locator('.app-shell > .app-header').count(),0);assert.equal(await page.locator('#desktop-host-actions .app-more').count(),1);}
  await topPage.screenshot({path:new URL(`../../../../layout-${width}.png`,import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 }
 await topPage.setViewportSize({width:1024,height:900});await page.locator('#preview-toggle').click();
 assert.equal(await page.locator('#preview-toggle').getAttribute('aria-expanded'),'true');
 assert.ok(await page.locator('#poster').isVisible());
 await page.locator('#preview-expand').click();assert.ok(await page.locator('.preview-expanded').isVisible());
 await page.locator('#preview-expand').click();await page.locator('#preview-close').click();
 await topPage.setViewportSize({width:1500,height:1000});await page.locator('.continuous-sheet').evaluate(n=>n.scrollTo(0,0));
 // Every configuration shares one horizontal viewport; edit columns remain reachable.
 await page.locator('.continuous-sheet').evaluate(n=>n.scrollLeft=n.scrollWidth);
 const lastCell=await page.getByLabel('配置1 CPU 加购描述',{exact:true}).boundingBox();
 assert.ok(lastCell.x+lastCell.width<=(await page.locator('.continuous-sheet').boundingBox()).x+(await page.locator('.continuous-sheet').boundingBox()).width+1);
 await page.locator('.continuous-sheet').evaluate(n=>n.scrollTo(0,0));
 await fs.writeFile(new URL('../../../../layout-geometry.json',import.meta.url),JSON.stringify(geometry,null,2));
 await topPage.screenshot({path:new URL('../../../../reui-acceptance.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
 assert.deepEqual(errors,[]);const result={passed:true,store:callStore?'real-rust-sqlite':'in-memory-fixture',storeDirectory,iframe:process.env.REUI_IFRAME==='1',layoutViewports:geometry.map(g=>g.viewport),singleNativeToolbar:true,themePreservesBusinessState:true,batchPartsSelectedSaveUndo:true,fixed14Selection:true,overflowAtomicRejection:true,batchDisplayNameSaveAndRevert:true,rows:56,realSourceReplacement:true,independentActual:true,clipboardAcrossConfigs:true,undo:true,saveReadback:true,fiveExistingBatchDialogs:true,legacyEditorTabs:true,errors};await fs.writeFile(new URL(callStore?'../../../../rust-browser-result.json':'../../../../browser-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();host?.stdin.end();}
