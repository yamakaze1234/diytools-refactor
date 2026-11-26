/** 当前链接库存入口验收：真实 React/业务页面，接口只使用合成数据。 */
import {clickWorkbenchControl,closeWorkbenchDialog} from './review-frontend-visible-ui.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5209';

const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/2)}`,name:i<2?'MF400 银色':'X400 白色',shopId:'intel',spu:i<2?'3798883899774468182':'3797540741002166472',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
// 同名链接 ID 可跨店重用，价格页检查范围必须跟随所选店铺。
configs.push({...structuredClone(configs[2]),id:'j0',shopId:'jonsbo'});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'技嘉 RTX 5060 Ti 冰猎鹰 16G 白色',erpCategory:'显卡',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'威刚 XPG 威龙 D300 6000 24G',erpCategory:'内存',erp:220,tax:240}];
// 库存时间、在途量和替代件来自同一组合成 ERP 快照。
state.sourceCatalog.push({shopId:'intel',sourceId:'new-gpu',goodsId:'2001',name:'技嘉 RTX 5060 Ti 雪鹰 OC 16G 白',erpCategory:'显卡',erp:3190,tax:3280});
state.costSource=state.sourceCatalog.map((p,i)=>({...p,stockAvailable:[0,3,36][i],stockIncomingAvailable:[18,3,50][i],stockUpdatedAt:'2026-11-26T15:40:00+08:00'}));
for(const c of state.configs){const item=state.sourceCatalog[c.productId==='p1'?1:0];const slot=c.productId==='p1'?3:5;Object.assign(c.parts[slot],item);Object.assign(c.actualParts[slot],item);}
// 单套负库存与两套共用的零库存次序不同，用于区分两种排序；未知件只能定位。
const fan={shopId:'intel',sourceId:'s-fan',goodsId:'1003',name:'利民 TL-C12 反叶风扇',erpCategory:'散热风扇',erp:25,tax:28};
state.sourceCatalog.push(fan);state.costSource.push({...fan,stockAvailable:-2,stockIncomingAvailable:0,stockUpdatedAt:state.costSource[0].stockUpdatedAt});
for(const parts of [state.configs[0].parts,state.configs[0].actualParts])parts.push({...fan,slot:'风扇',qty:1});
for(const parts of [state.configs[2].parts,state.configs[2].actualParts])Object.assign(parts[2],{name:'微星 PRO B760M-A WIFI DDR5',goodsId:'881204'});
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/product-stock-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),close:()=>closeDialog()};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({method:req.method(),path,ids:payload?.ids});let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,structuredClone(payload[key])])),revision:state.revision+1,updatedAt:new Date().toISOString()};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:new Date().toISOString(),activityDelta:[]};}
  else if(path==='/api/cost-sync/settings')value=state.costSync||{mode:'cloud',path:'',sheet:'库存数据',goodsColumn:54,taxColumn:67};
  else if(path==='/api/price-changes/list')value={batches:[]};
  else if(path==='/api/session')value={defaultOperator:'内存隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/product-stock-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"] .link-arrow').click();await page.locator('[data-id="c0"]').click();

 const baseline=structuredClone(state);
 const check=async(selector,summary)=>{
  if(selector==='#inventory-check-open')await clickWorkbenchControl(page,selector);
  else await page.locator(selector).click();
  await page.waitForFunction(()=>document.querySelector('#stock-message')?.textContent.startsWith('检查完成'));
  assert.match(await page.locator('#stock-summary').innerText(),summary);
 };
 await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 assert.equal(await page.locator('#stock-title').innerText(),'检查商品库存');
 assert.match(await page.locator('#stock-scope [aria-pressed=true]').innerText(),/当前链接：MF400 银色/);
 assert.match(await page.locator('#inventory-check-page').innerText(),/本机 ERP 库存时间：2026-11-26/);
 assert.deepEqual(await page.locator('[data-stock-locate]').evaluateAll(nodes=>nodes.map(n=>n.dataset.stockLocate)),['c0','c1']);
 await page.locator('#stock-scan').click();
 await page.waitForFunction(()=>!document.querySelector('#stock-scan').disabled);
 assert.match(await page.locator('#stock-summary').innerText(),/检查 1 个链接、2 套配置/);
 await page.locator('[data-stock-edit="1001"]').click();
 assert.deepEqual(await page.locator('[data-stock-link]').evaluateAll(nodes=>nodes.map(n=>n.value)),['p0']);
 await page.locator('#stock-back').click();
 await check('#inventory-check-open',/检查 2 个链接、4 套配置/);
 assert.equal(await page.locator('#stock-scope [aria-pressed=true]').getAttribute('data-scope-btn'),'shop');
 await page.locator('#stock-back').click();
 await page.locator('[data-product-toggle="p1"] .link-arrow').click();await page.locator('[data-id="c2"]').click();
 await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 assert.match(await page.locator('#stock-scope [aria-pressed=true]').innerText(),/当前链接：X400 白色/);
 assert.deepEqual(await page.locator('[data-stock-locate]').evaluateAll(nodes=>nodes.map(n=>n.dataset.stockLocate)),['c2','c3']);
 for(const width of [1300,900]){
  await page.locator('#stock-back').click();await page.setViewportSize({width,height:900});
  await page.locator('#product-stock-check').scrollIntoViewIfNeeded();
  const box=await page.locator('#product-stock-check').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  await check('#product-stock-check',/检查 1 个链接、2 套配置/);
 }
// 按实际宽度检查三栏、选中任务和展开明细，并在相同状态核对两套主题。
 await page.setViewportSize({width:1360,height:900});
 await page.locator('[data-scope-btn="shop"]').click();
 await page.locator('[data-stock-edit="1001"]').click();
 assert.equal(await page.locator('[data-stock-link]:checked').count(),1);
 assert.equal(await page.locator('#stock-picker :checked').getAttribute('data-product-id'),'new-gpu');
 assert.equal(await page.locator('#stock-kpis button').count(),4);
 assert.equal(await page.locator('[data-stock-cat]').count(),11);
 await page.locator('[data-stock-cat="主板"]').click();
 assert.equal(await page.locator('.stock-issue').count(),0);
 await page.locator('#stock-reset-cat').click();
 await page.locator('[data-stock-group="category"]').click();
 assert.deepEqual(await page.locator('.stock-group-title b').allTextContents(),['显卡','内存','风扇']);
 await page.locator('[data-stock-group="status"]').click();
 const outIds=()=>page.locator('.stock-group').first().locator('[data-stock-toggle]').evaluateAll(nodes=>nodes.map(n=>n.dataset.stockToggle));
 assert.deepEqual(await outIds(),['1001','1003']);
 await page.locator('#stock-sort').selectOption('stock');
 assert.deepEqual(await outIds(),['1003','1001']);
 await page.locator('#stock-sort').selectOption('impact');
 await page.locator('#stock-only-transit').check();
 assert.equal(await page.locator('.stock-issue').count(),1);
 await page.locator('#stock-only-transit').uncheck();
 await page.locator('[data-stock-group="status"]').click();
 await page.locator('[data-stock-kpi="low"]').click();
 assert.match(await page.locator('.stock-group-title').innerText(),/低库存/);
 await page.locator('[data-stock-kpi="issues"]').click();
 await page.locator('#stock-collapse-all').click();
 assert.equal(await page.locator('[data-stock-locate]').count(),0);
 await page.locator('[data-stock-toggle="1001"]').click();
 const inventory=page.locator('#inventory-check-page');
 for(const [theme,canvas] of [['dark','rgb(29, 30, 33)'],['light','rgb(244, 244, 241)']]){
  // 独立工作台页面接收与宿主主题按钮相同的主题事件。
  await page.evaluate(theme=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:theme})),theme);
  assert.equal(await inventory.evaluate(el=>getComputedStyle(el).backgroundColor),canvas);
  const colors=await inventory.evaluate(el=>['#stock-scan','[data-stock-kpi="out"]','[data-stock-kpi="low"]'].map(sel=>getComputedStyle(el.querySelector(sel)).backgroundColor));
  assert.deepEqual(colors,theme==='light'?['rgb(255, 250, 0)','rgb(253, 240, 240)','rgb(255, 246, 224)']:['rgb(255, 250, 0)','rgb(59, 32, 35)','rgb(55, 45, 24)']);
 }
 const layout=await inventory.evaluate(el=>{
  const box=sel=>el.querySelector(sel).getBoundingClientRect();
  return {left:box('.stock-filters').width,right:box('.stock-side').width,footer:box('#stock-task-actions').bottom,bottom:el.getBoundingClientRect().bottom,extraWidth:el.scrollWidth-el.clientWidth,extraHeight:el.scrollHeight-el.clientHeight};
 });
 assert.equal(layout.left,188);assert.equal(layout.right,360);
 assert.ok(layout.footer<=900&&Math.abs(layout.footer-layout.bottom)<=1,JSON.stringify(layout));
 assert.equal(layout.extraWidth,0);assert.equal(layout.extraHeight,0);
 if(process.env.STOCK_CHECK_SCREENSHOT)await inventory.screenshot({path:process.env.STOCK_CHECK_SCREENSHOT});

// 通过真实入口核对冗余按钮、回收站、价格角标以及返回时的筛选。
 await page.locator('#stock-back').click();
 assert.equal(await page.locator('#deleted-configs,#profit-check-open').count(),0);
 await page.locator('#link-recycle-shortcut').click();await page.locator('#dialog[open]').waitFor();
 assert.match(await page.locator('#dialog-title').innerText(),/已删除配置/);
 await closeWorkbenchDialog(page);
 await page.locator('.rail-navigation button[title="价格与利润"]').click();
 await page.locator('#pp-stock-check:visible').waitFor();
 assert.equal(await page.locator('#pp-stock-badge').innerText(),'缺2 · 低1 · 未知1');
 assert.equal(await page.locator('#pp-erp-match + #pp-stock-check + #pp-export-price-template').count(),1);
 assert.equal((await page.locator('#pp-stock-check').boundingBox()).height,(await page.locator('#pp-erp-match').boundingBox()).height);
 await page.locator('#pp-shop').selectOption('jonsbo');
 assert.equal(await page.locator('#pp-stock-badge').innerText(),'缺0 · 低1');
 await page.locator('#pp-stock-check').click();
 assert.match(await page.locator('#stock-summary').innerText(),/1 个链接、1 套配置/);
 await page.locator('#stock-back').click();
 assert.equal(await page.locator('#pp-shop').inputValue(),'jonsbo');
 await page.locator('#pp-shop').selectOption('intel');
 const link=await page.locator('#pp-product option').nth(1).getAttribute('value');
 await page.locator('#pp-product').selectOption(link);
 await page.locator('#pp-stock-check').click();
 assert.equal(await page.locator('#stock-scope [aria-pressed=true]').getAttribute('data-scope-btn'),'link');
 await page.locator('[data-scope-btn="shop"]').click();
 assert.match(await page.locator('#stock-summary').innerText(),/2 个链接、4 套配置/);
 await page.locator('#stock-threshold').fill('0');await page.locator('#stock-scan').click();
 await page.locator('[data-stock-status="unknown"]').click();
 assert.match(await page.locator('.stock-issue').innerText(),/仅支持定位核对/);
 assert.equal(await page.locator('[data-stock-edit]').count(),0);
 await page.locator('#stock-back').click();
 assert.equal(await page.locator('#pp-product').inputValue(),link);
 assert.equal(await page.locator('#pp-stock-badge').innerText(),'缺2 · 低0 · 未知1');
 await page.locator('#pp-stock-check').click();
 await page.locator('#stock-expand-all').click();
 await page.locator('[data-stock-locate="c1"]').click();
 assert.equal(await page.locator('#price-profit-page').isVisible(),false);
 assert.equal(await page.locator('#inventory-check-page').isVisible(),false);
 await page.locator('[data-continuous-config="c1"]').first().waitFor();

 assert.deepEqual(state,baseline);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',checks:['current link all configurations','rescan scope','replacement scope','global entry unchanged','price badge, shop and link restoration','direct recycle bin and removed controls','locate from price page','switch link','双主题和分组颜色','1360×900 三栏与固定底栏','影响数及库存排序','默认替代件和在途筛选','1300/900px toolbar','workspace unchanged','no page errors']}));
}finally{await browser.close();}
