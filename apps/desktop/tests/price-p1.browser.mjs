// 真实 React 工作台的合成业务回归：矩阵、服务端基线、根生命周期及 Excel 编辑交互。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const sources=[
 {sourceId:'cpu',shopId:'intel',slot:'CPU',goodsId:'1001',name:'合成 CPU',erp:500,tax:600,stockAvailable:20},
 {sourceId:'memory',shopId:'intel',slot:'内存',goodsId:'1002',name:'合成内存',erp:100,tax:120,stockAvailable:40},
 {sourceId:'new-cpu',shopId:'intel',slot:'CPU',goodsId:'1003',name:'新款 CPU',erp:700,tax:800,stockAvailable:15},
];
const configs=[0,6,12,24].map((term,i)=>{
 // 同链接两套已保存配置使用不同分期，基线和主行均应认作分期不一致。
 const link=i===3?2:i;
 const product={id:'p'+link,shopId:'intel',name:'合成链接'+link,spu:'900'+link,installment:term};
 const c=blankConfig(null,product,'配置'+(i+1));
 return {...c,id:'c'+i,skuId:'800'+i,shortName:'简称'+i,shortNameAuto:false,price:2999,overviewFeeRate:5.125,
  parts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}],
  actualParts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}]};
});
// 含税原价故意陈旧：提醒必须按最新 costSource 比较。
for(const c of configs){c.actualParts.forEach(p=>{p.lineId=c.id+'-'+p.slot;});}
configs[0].actualParts[1]={...configs[0].actualParts[1],qty:2,tax:130,taxOverride:{goodsId:'1002',value:130,base:5}};
configs[1].actualParts[1]={...configs[1].actualParts[1],tax:140,taxOverride:{goodsId:'1002',value:140,base:5}};
configs[2].actualParts[0]={...configs[2].actualParts[0],tax:650,taxOverride:{goodsId:'1001',value:650,base:5}};
for(const [goodsId,slot] of [['1004','机箱'],['1005','散热']]){sources.push({goodsId,slot,name:'聚合'+slot,tax:50,erp:30});configs[3].actualParts.push({goodsId,slot,lineId:slot,name:'聚合'+slot,qty:1,tax:60,taxOverride:{goodsId,value:60,base:5}});}
configs[0].actualParts[2].taxOverride={goodsId:'',value:20,base:0};
let saved=normalizeWorkspaceState({revision:1,dataVersion:3,configs,sourceCatalog:sources,costSource:sources,shopSettings:{intel:{coupon:400,pricingRule:{fee6:3.25,fee12:6.75}}},templates:[],caseGallery:[],logs:[]},[]);
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},bypassCSP:true,permissions:['clipboard-read','clipboard-write']});
 page.on('pageerror',e=>errors.push(e.stack));
 // 人工保存验收期间延长原有自动保存等待，避免测试操作间隔改变待保存状态。
 await page.addInitScript(()=>{const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===950?60000:ms,...args);});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
 window.cardRoots=new Set();window.cardReleases=0;
 window.createWorkbenchReactRenderer=()=>{const renderer=createWorkbenchReactRenderer();return {...renderer,
 configCard:(container,model)=>{cardRoots.add(container);renderer.configCard(container,model);},
 release:container=>{if(cardRoots.delete(container))cardReleases++;renderer.release(container);}};};
 await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 const app=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/p1-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:app+'\nwindow.p1Probe={snapshot:()=>structuredClone(state),history:()=>history.length,pending:()=>[...pendingImages],standard:()=>fullAction(openLocalStandardProduct)(),batch:()=>openUpgradeDescriptionsFull(false,"displayName"),directRestore:entries=>restoreOverviewTaxes(entries)};'}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,payload=request.method()==='POST'?request.postDataJSON():null;
  let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=saved;value={revision:saved.revision,updatedAt:saved.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:saved.revision,configs:saved.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&request.method()==='GET')value=saved;
  else if(path==='/api/state'&&request.method()==='POST'){
   // 正式保存接口仅持久化工作区字段，基线和操作人属于请求元数据。
   const fields=['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'];
   saved={...saved,...Object.fromEntries(fields.map(key=>[key,payload[key]])),revision:saved.revision+1};
   value={...saved,state:structuredClone(saved)};
  }
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){
   const configs=payload.changes.map(c=>structuredClone(c.after));saved.configs=saved.configs.map(c=>configs.find(s=>s.id===c.id)||c);saved.revision++;
   value={configs,revision:saved.revision,updatedAt:new Date().toISOString(),activityDelta:[]};
  }else if(path==='/api/session')value={defaultOperator:'合成验收'};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 const open=async()=>{await page.goto(base+'/workbench/p1-fixture');await page.waitForFunction(()=>window.workbenchReady);await page.getByRole('button',{name:'价格',exact:true}).click();await page.locator('#price-profit-title').waitFor();};
 await open();
 const cell=(id,key)=>page.locator(`[data-row-id="${id}"][data-pp-cell="${key}"]`),row=id=>page.locator(`[data-pp-row="${id}"]`);
 const card=id=>page.locator(`[data-pp-card="${id}"]`);
 const snapshot=()=>page.evaluate(()=>window.p1Probe.snapshot());
 const edit=async(locator,value)=>{await locator.fill(value);await locator.press('Enter');};
 const paste=async(id,key,text)=>{await cell(id,key).click();await page.evaluate(t=>navigator.clipboard.writeText(t),text);await page.keyboard.press('Control+v');};
 const find=(state,id)=>state.configs.find(c=>c.id===id);
 for(const id of ['c2','c3']){
  assert.equal(await row(id).locator('[data-pp-dirty]').count(),0);
  assert.equal(await cell(id,'taxTarget').inputValue(),'');
 }
 // 提醒固定单行，前三款聚合，特殊配件不计入提醒。
 const banner=page.locator('#pp-tax-banner');await banner.waitFor({state:'visible'});
 assert.match(await banner.innerText(),/单独核算价：4 套配置.*5 项.*4 款配件/s);
 assert.equal(await banner.locator('[data-tax-part]').count(),3);assert.match(await banner.innerText(),/\+1 款/);
 assert.equal(await banner.evaluate(el=>el.getBoundingClientRect().height),44);
 await banner.locator('[data-tax-hide]').click();assert.equal(await banner.isVisible(),false);
 await page.locator('#pp-tax-reopen').click();assert.equal(await banner.isVisible(),true);
 await banner.locator('[data-tax-part="1002"]').click();assert.equal(await page.locator('[data-pp-row]').count(),2);
 await banner.locator('[data-tax-only]').click();assert.equal(await page.locator('[data-pp-row]').count(),4);
 await row('c0').locator('.pp-tax-cost').click();await card('c0').locator('.ov-tax-reminder').waitFor();
 assert.match(await card('c0').locator('.ov-tax-reminder').innerText(),/共用 120/);assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'配置1 内存含税单价');
 // 检查真实单元格和展开卡片的最终渲染颜色，避免主题覆盖顺序回归。
 const dark=await page.evaluate(async()=>{
  const theme=document.documentElement.classList,wasDark=theme.contains('dark');
  theme.add('dark');
  try{
   const color=selector=>getComputedStyle(document.querySelector(selector));
   const selectors=['.pp-tax-banner','.pp-tax-banner button','.pp-tax-pill','.pp-tax-changed','.pp-tax-cost small','.ov-tax-reminder'];
   // 主题按钮的背景有过渡动画，应在浏览器完成过渡后读色。
   const elements=selectors.map(selector=>document.querySelector(selector));
   await Promise.all(elements.flatMap(el=>el.getAnimations()).filter(a=>a instanceof CSSTransition).map(a=>a.finished));
   const backgrounds=Object.fromEntries(selectors.map(selector=>[selector,color(selector).backgroundColor]));
   return {sale:color('td[data-pp-col="4"]').color,pill:color('.pp-tax-pill').color,backgrounds};
  }finally{theme.toggle('dark',wasDark);}
 });
 assert.equal(dark.sale,'rgb(255, 173, 174)');assert.equal(dark.pill,'rgb(240, 214, 157)');
 for(const [selector,bg] of Object.entries(dark.backgrounds))assert.ok(Number(bg.match(/\d+/)?.[0])<100,`${selector} 深色提醒背景：${bg}`);
 // 选择成本格查看 fx 明细，再从汇总跨链接一次恢复同一配件。
 await row('c0').locator('[data-pp-col="11"]').click();assert.match(await page.locator('#pp-formula-value').inputValue(),/单独价 130 vs 共用价 120/);
 await banner.getByRole('button',{name:'查看汇总 / 批量还原'}).click();await page.locator('#tax-summary-body').waitFor();
 const memory=page.locator('.pp-tax-summary-table tbody tr').filter({hasText:'1002'});
 assert.match(await memory.innerText(),/120.*130～140/s);
 // 取消确认后标签仍可操作，不能留下 disabled 的汇总弹窗。
 page.once('dialog',d=>d.dismiss());await memory.getByRole('button',{name:/还原此配件/}).click();await page.locator('[data-tax-tab="configs"]').click();await page.locator('[data-tax-tab="parts"]').click();
 const before=await page.evaluate(()=>p1Probe.history());
 page.once('dialog',d=>{assert.match(d.message(),/2 套配置的 2 项/);void d.accept();});
 await memory.getByRole('button',{name:/还原此配件/}).click();
 await page.waitForFunction(()=>!p1Probe.snapshot().configs[1].actualParts[1].taxOverride);
 assert.equal(await page.evaluate(()=>p1Probe.history()),before+1);
 assert.match(await banner.innerText(),/2 套配置/);
 await page.locator('.pp-grid').focus();await page.keyboard.press('Control+z');
 await page.waitForFunction(()=>p1Probe.snapshot().configs[1].actualParts[1].taxOverride?.value===140);
 assert.match(await banner.innerText(),/4 套配置/);
 await banner.getByRole('button',{name:'查看汇总 / 批量还原'}).click();await page.locator('[data-tax-tab="configs"]').click();
 await page.locator('#tax-summary-query').fill('简称0');assert.equal(await page.locator('[data-tax-select]').count(),1);
 await page.locator('[data-tax-select]').check();
 page.once('dialog',d=>d.accept());await page.locator('#tax-restore-selected').click();
 await page.waitForFunction(()=>!p1Probe.snapshot().configs[0].actualParts[1].taxOverride);
 // 保存后重新请求服务端基线，提醒不会复现。
 await page.locator('#pp-save').click();await page.waitForFunction(()=>document.querySelectorAll('[data-pp-dirty]').length===0);
 await open();assert.match(await banner.innerText(),/3 套配置.*4 项/s);
 assert.equal(find(await snapshot(),'c0').actualParts[1].taxOverride,undefined);
 // 缓存清理检查必须捕捉已提交到内存的编辑，明确放弃后才允许重新载入。
 await cell('c0','price').click();await cell('c0','price').fill('3333');await cell('c0','price').press('Enter');
 const status=await page.evaluate(()=>workbenchCacheStatus());assert.ok(status.count>0);
 const rejected=await page.evaluate(()=>workbenchPrepareCacheCleanup('check').then(()=>'',e=>e.message));assert.match(rejected,/未保存/);
 const cookies='session=keep';await page.evaluate(value=>{document.cookie=value;localStorage.setItem('private-runtime-sentinel','keep');},cookies);
 await page.evaluate(()=>workbenchPrepareCacheCleanup('discard'));assert.equal((await page.evaluate(()=>workbenchCacheStatus())).count,0);
 await page.evaluate(()=>workbenchReloadAfterCache());await page.waitForFunction(()=>window.workbenchReady);
 assert.equal(await page.evaluate(()=>localStorage.getItem('private-runtime-sentinel')),'keep');assert.match(await page.evaluate(()=>document.cookie),/session=keep/);
 await page.getByRole('button',{name:'价格',exact:true}).click();await page.locator('#price-profit-title').waitFor();assert.equal(find(await snapshot(),'c0').price,2999);
 if(process.env.P1_SCREENSHOT)await page.screenshot({path:process.env.P1_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,singleLine:true,sharedBaseline:true,specialExcluded:true,partRestoreUndo:true,detailRestorePersisted:true,cacheDraftProtection:true,sessionPreserved:true}));
}finally{await browser.close();}
