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
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5230';
const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/25)}`,name:`高性能主机 · 示例链接`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5299+i*200;c.shortName="245KF / 32G / 1T";return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
// 仅合成展示数据；不读取用户库或接入外部业务服务。
state.sourceCatalog=[['CPU','Intel Core Ultra 5 245KF 盒装',1399],['散热','360 一体式水冷 · 白色',299],['主板','B860M WIFI 主板',799],['内存','DDR5 6000 16GB × 2',499],['硬盘','NVMe PCIe 4.0 1TB',399],['显卡','16GB 独立显卡',1199],['电源','750W 金牌全模组',329],['机箱','全景侧透机箱 · 白色',259],['风扇','ARGB 风扇套装',89]].map(([slot,name,tax],i)=>({slot,name,tax,erp:tax-20,shopId:'intel',sourceId:'demo-'+i,goodsId:String(10001+i)}));
state.costSource=state.sourceCatalog.map((p,i)=>({...p,stockAvailable:i===7?3:20+i*2}));
for(const c of state.configs){c.parts=state.sourceCatalog.map(p=>({...p,qty:1,upgrade:p.slot==='内存'?'可选升级 64GB':''}));c.actualParts=structuredClone(c.parts);}
let host,callStore,storeDirectory;
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1800,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
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
 if(true){
  await topPage.route('**/workbench/reui-host',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><script src="/workbench/endfield-init.js"></script><link rel="stylesheet" href="/workbench/endfield/endfield.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"><script type="module" src="/workbench/endfield-theme.js"></script><style>body{margin:0}html,body,#root{height:100%;margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;window.isTauri=true;window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async(command)=>command==='cloud_native_json_request'?{status:200,body:JSON.stringify({configured:false})}:1};const {default:App}=await import('/src/App.tsx');window.installWorkbenchBridge=async()=>{};const host=document.createElement('div');host.id='root';document.body.append(host);createRoot(host).render(React.createElement(App));</script>`}));
  await topPage.goto(base+'/workbench/reui-host');await topPage.locator('iframe').waitFor();page=await topPage.locator('iframe').elementHandle().then(h=>h.contentFrame());
 }else await page.goto(base+'/workbench/renumber-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();
 await page.locator('[data-continuous-config="c3"]').waitFor();

 const screenshots=new URL('../../../docs/screenshots/',import.meta.url);await fs.mkdir(screenshots,{recursive:true});
 await page.waitForFunction(()=>document.querySelector('#poster-object-select').options.length>3);
 for(const theme of ['light','dark']){
  if(await page.evaluate(()=>document.documentElement.dataset.workbenchTheme)!==theme)await page.locator('#workbench-theme-toggle').click();
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-workbench-theme-changing'));await page.waitForTimeout(150);
  await topPage.screenshot({path:fileURLToPath(new URL('workbench-'+theme+'.png',screenshots))});
 }
 await page.locator('#preview-expand').click();await page.locator('.canvas-tools>summary').click();await page.locator('#poster-object-select').selectOption({index:2});await page.locator('#poster-text-content').waitFor();
 await topPage.screenshot({path:fileURLToPath(new URL('free-editor.png',screenshots))});
 assert.deepEqual(errors,[]);console.log('Three public UI examples captured from synthetic data.');
}finally{await browser.close();}
