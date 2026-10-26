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
const colorStage=process.env.COLOR_STAGE||'final';
const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/25)}`,name:`隔离链接${Math.floor(i/25)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'验收CPU',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'验收内存',erp:220,tax:240}];
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:0}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);}
let host,callStore,storeDirectory;
if(process.env.REUI_REAL_STORE==='1'){
 const directory=fileURLToPath(new URL(`../../../sandbox/reui-acceptance-${Date.now()}/`,import.meta.url));
 storeDirectory=directory;await fs.mkdir(directory,{recursive:true});await fs.mkdir(directory+'/workbench-assets');
 const seed=new URL('../../../sandbox/migration-review/20261011/',import.meta.url);await fs.mkdir(seed,{recursive:true});
 assert.deepEqual(await page.evaluate(()=>window.memoryProbe.snapshot()),beforeThemeState);
 await fs.writeFile(new URL('source-state.json',seed),JSON.stringify(state),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 host=spawn(fileURLToPath(new URL('../src-tauri/target/debug/workbench-review-host.exe',import.meta.url)),[],{windowsHide:true,env:{...process.env,DIYTOOLS_REVIEW_DIRECTORY:directory},stdio:['pipe','pipe','inherit']});
 const pending=[];createInterface({input:host.stdout}).on('line',line=>{const item=pending.shift();if(item){try{const result=JSON.parse(line);if(result.status>=400)item.reject(Error(result.body));else item.resolve(JSON.parse(result.body));}catch(error){item.reject(error);}}});
 host.on('error',e=>{while(pending.length)pending.shift().reject(e);});host.on('exit',code=>{while(pending.length)pending.shift().reject(Error(`review host exited ${code}`));});
 callStore=(method,path,body)=>new Promise((resolve,reject)=>{pending.push({resolve,reject});host.stdin.write(JSON.stringify({method,path,body:body==null?null:JSON.stringify(body)})+'\n');});
 const empty=await callStore('GET','/api/state');await callStore('POST','/api/state',{...state,baseRevision:empty.revision});state=await callStore('GET','/api/state');
 console.log(JSON.stringify({isolatedRustStore:directory}));
}
let allowPriceFixtures=false;const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
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
  else if(path==='/api/price-changes/list')value={batches:allowPriceFixtures?[{revision:1,at:new Date().toISOString(),message:'隔离价格批次'}]:[]};
  else if(path==='/api/price-changes/detail')value={revision:1,at:new Date().toISOString(),message:'隔离价格批次',items:[{name:'验收CPU',goodsId:'1001',slots:['CPU'],configIds:[],before:{erp:80000,tax:85000},after:{erp:90000,tax:95000}}],configs:[],handled:[]};
  else if(path==='/api/profit/start')value={runId:'color-fixture'};
  else if(path==='/api/profit/status')value={run:{status:'completed'},results:[{id:'result-1',shop_id:'intel',config_id:'c0',metric:'accounting',valid:true,loss:true,changed:true,profit_cents:-40000,previous_delta_cents:20000,anchor_delta_cents:20000,snapshot:{product:'隔离链接',name:'配置1'}}]};
  else if(path==='/api/activity')value={page:0,pageSize:30,total:1,rows:[{message:'连续编辑配件',summary:'配置1 · 均衡游戏',operator:'本地操作员',origin:'local',at:new Date().toISOString()}]};
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

 const beforeThemeState=await page.evaluate(()=>window.memoryProbe.snapshot());
 await page.getByRole('checkbox',{name:'选择配置1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="选择配置1"]').getAttribute('aria-checked')==='true');
 const audits=[];const audit=async(name,root='body')=>{await topPage.mouse.move(0,0);await page.waitForTimeout(80);const result=await page.locator(root).evaluate(root=>{
 const rgb=s=>{const m=s.match(/[\d.]+/g);return m?m.slice(0,3).map(Number):[0,0,0]};const lum=c=>c.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
 const bg=n=>{for(let e=n;e;e=e.parentElement){const b=getComputedStyle(e).backgroundColor;if(b!=='rgba(0, 0, 0, 0)'&&b!=='transparent')return b;}return 'rgb(255, 255, 255)'};
 const bright=[],low=[];for(const n of [root,...root.querySelectorAll('*')]){if(!n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||!n.getClientRects().length||n.closest('canvas,#poster-stage,.cp-swatch,.color-field-trigger,.shop-brand,button:disabled,[disabled],[data-slot=checkbox],.source-item.active'))continue;const c=getComputedStyle(n),r=n.getBoundingClientRect();if(r.width<1||r.height<1)continue;const name=n.id?'#'+n.id:n.tagName.toLowerCase()+'.'+String(n.className).split(' ').slice(0,2).join('.');if(document.documentElement.dataset.workbenchTheme==='dark'&&r.width>60&&r.height>18&&lum(rgb(c.backgroundColor))>.5&&c.backgroundColor!=='rgba(0, 0, 0, 0)'&&!n.matches('button,.chip,[data-slot=badge]'))bright.push({name,bg:c.backgroundColor});const text=[...n.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();if(!text)continue;const background=bg(n),l=[lum(rgb(c.color)),lum(rgb(background))].sort((a,b)=>a-b),ratio=(l[1]+.05)/(l[0]+.05);if(ratio<4.5)low.push({name,text:text.slice(0,35),color:c.color,bg:background,ratio:+ratio.toFixed(2)});}
 return {bright:[...new Map(bright.map(x=>[x.name+':'+x.bg,x])).values()],low:[...new Map(low.map(x=>[x.name+':'+x.color+':'+x.bg,x])).values()]};});audits.push({name,...result});};
 for(const theme of ['dark','light']){
 await page.evaluate(t=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:t})),theme);
 if(await page.locator('#template-section-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#template-section-toggle').click();await audit(theme+'-template-sidebar','.template-library-section');if(theme==='dark')await page.locator('.template-library-section').screenshot({path:new URL('../../../../module-template-dark.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});await page.locator('#template-section-toggle').click();
 for(const tab of ['parts','display','actual','addons','modules','costs']){await page.locator('.tabs [data-tab="'+tab+'"]').click();await audit(theme+'-'+tab,tab==='parts'?'#continuous-workbench':'#editor');}
 for(const [name,selector,ready] of [['inventory','#inventory-check-open','#stock-message'],['history','#logs-open','#activity-list .list-card'],['profit','#profit-check-open','.profit-scope'],['erp','#erp-sync','.cloud-shop-card'],['templates','[data-nav="templates"]','#dialog-body'],['source','[data-nav="source"]','#source-list'],['cost-source','[data-nav="cost-source"]','#dialog-body'],['gallery','#case-gallery-open','#dialog-body'],['global','#global-batch-open','#dialog-body'],['link-parts','#link-parts','#link-part-scope'],['upgrade','#link-upgrades','#upgrade-batch-query'],['display-name','#link-display-names','#upgrade-batch-query'],['appearance','#batch-style','#style-scope'],['ids','#ids','#ids-spu'],['sync','#workspace-sync','#dialog-body'],['prices','#price-changes-open','.price-track'],['overview','#overview','.overview-dialog'],['product','#new-product','#wps-import-mount'],['deleted','#deleted-configs','#dialog-body'],['shop','#shop-settings','#dialog-body'],['template-new','#template-library-add','#dialog-body']]){
 try{allowPriceFixtures=name==='prices';if(name==='template-new'&&!await page.locator('#template-library-add').count())await page.locator('#template-section-toggle').click();await page.locator(selector).evaluate(n=>n.click());await page.locator('#dialog[open]').waitFor({timeout:8000});await page.locator(ready).first().waitFor({timeout:8000});await audit(theme+'-'+name,'#dialog');
 if(name==='profit'){await page.locator('.profit-link>summary').first().click();await audit(theme+'-profit-expanded','#dialog');await page.locator('#profit-start').click();await page.locator('.profit-result').waitFor();await audit(theme+'-profit-results','#dialog');}
 if(name==='product'){await page.locator('.wps-import>summary').click();await audit(theme+'-wps-import','#dialog');}
 if(name==='source'){await page.locator('#source-list .source-item').first().click();await audit(theme+'-source-detail','#dialog');}
 if(name==='inventory'){await page.locator('.stock-issue>summary').first().click();await audit(theme+'-inventory-expanded','#dialog');}
 if(['inventory','history'].includes(name)&&theme==='dark')await page.locator('#dialog').screenshot({path:new URL('../../../../module-'+name+'-dark.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});}catch(e){audits.push({name:theme+'-'+name,error:e.message.split('\n')[0],dialog:await page.locator('#dialog-title').textContent(),body:(await page.locator('#dialog-body').textContent()).slice(0,160)});}
 if(await page.locator('#dialog[open]').count())await page.evaluate(()=>window.memoryProbe.close());
 }
 }
 await fs.writeFile(new URL('../../../../module-color-'+colorStage+'.json',import.meta.url),JSON.stringify({audits,errors},null,2));if(colorStage==='final'){assert.ok(audits.every(a=>!a.error&&!a.bright.length&&!a.low.length),JSON.stringify(audits.filter(a=>a.error||a.bright?.length||a.low?.length)));assert.deepEqual(errors,[]);}console.log(JSON.stringify(audits.map(a=>({name:a.name,bright:a.bright?.length,low:a.low?.length,error:a.error}))));
}finally{await browser.close();host?.kill();}
