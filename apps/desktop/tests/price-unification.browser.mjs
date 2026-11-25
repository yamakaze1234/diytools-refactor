// 真实 React 工作台的合成业务回归：矩阵、服务端基线、根生命周期及 Excel 编辑交互。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const sources=[
 {sourceId:'cpu',shopId:'intel',slot:'CPU',goodsId:'1001',name:'合成 CPU',erp:500,tax:600,stockAvailable:-1,stockIncomingAvailable:120},
 {sourceId:'memory',shopId:'intel',slot:'内存',goodsId:'1002',name:'合成内存',erp:100,tax:120,stockAvailable:40,stockIncomingAvailable:142},
 {sourceId:'new-cpu',shopId:'intel',slot:'CPU',goodsId:'1003',name:'新款 CPU',erp:700,tax:800,stockAvailable:15},
];
const configs=[0,6,12,24].map((term,i)=>{
 const product={id:'p'+i,shopId:'intel',name:'合成链接'+i,spu:'900'+i,installment:term};
 const c=blankConfig(null,product,'配置'+(i+1));
 return {...c,id:'c'+i,skuId:'800'+i,shortName:'简称'+i,shortNameAuto:false,price:2999,overviewFeeRate:5.125,
  parts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}],
  actualParts:[...sources.slice(0,2).map(p=>({...p,qty:1})),{slot:'显卡',name:'特殊核显',specialComponent:true,qty:1}]};
});
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
 await page.route('**/workbench/unification-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:app+'\nwindow.p0Probe={snapshot:()=>structuredClone(state),history:()=>history.length,pending:()=>[...pendingImages],standard:()=>fullAction(openLocalStandardProduct)()};'}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,payload=request.method()==='POST'?request.postDataJSON():null;
  let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=saved;value={revision:saved.revision,updatedAt:saved.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:saved.revision,configs:saved.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&request.method()==='GET')value=saved;
  else if(path==='/api/state'&&request.method()==='POST'){saved={...saved,...payload,revision:saved.revision+1};value={...saved,state:structuredClone(saved)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){
   const configs=payload.changes.map(c=>structuredClone(c.after));saved.configs=saved.configs.map(c=>configs.find(s=>s.id===c.id)||c);saved.revision++;
   value={configs,revision:saved.revision,updatedAt:new Date().toISOString(),activityDelta:[]};
  }else if(path==='/api/session')value={defaultOperator:'合成验收'};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 const open=async()=>{await page.goto(base+'/workbench/unification-fixture');await page.waitForFunction(()=>window.workbenchReady);await page.getByRole('button',{name:'价格',exact:true}).click();await page.locator('#price-profit-title').waitFor();};
 await open();
 const cell=(id,key)=>page.locator(`[data-row-id="${id}"][data-pp-cell="${key}"]`),row=id=>page.locator(`[data-pp-row="${id}"]`);
 const card=id=>page.locator(`[data-pp-card="${id}"]`);
 const snapshot=()=>page.evaluate(()=>window.p0Probe.snapshot());
 const edit=async(locator,value)=>{await locator.fill(value);await locator.press('Enter');};
 const paste=async(id,key,text)=>{await cell(id,key).click();await page.evaluate(t=>navigator.clipboard.writeText(t),text);await page.keyboard.press('Control+v');};
 const find=(state,id)=>state.configs.find(c=>c.id===id);
 // 四个实际页面利润输入、NAS检测与追踪返回同一笔精确到分的利润。
 const consistency=await page.evaluate(async()=>{
  const {priceProfitRow}=await import('/workbench/price-profit-model.js'),{overviewTableTotals}=await import('/workbench/overview-table-model.js');
  const {buildNasProfitReport}=await import('/workbench/nas-profit-check.js'),{trackedProfit}=await import('/workbench/price-changes.js');
  return p0Probe.snapshot().configs.map(c=>{const settings=p0Probe.snapshot().shopSettings.intel,r=priceProfitRow(c,settings),o=overviewTableTotals(c,r.metrics,r.quote);
   return {id:c.id,price:r.metrics.taxProfitAfter,overview:o.taxProfit,nas:buildNasProfitReport({shopId:'intel',configIds:[c.id],configs:[c],settings}).results[0].profit_cents/100,tracked:trackedProfit(c,settings).tax/100};});
 });
 for(const r of consistency){assert.equal(r.price,r.overview);assert.equal(r.price,r.nas);assert.equal(r.price,r.tracked);assert.equal(await cell(r.id,'taxTarget').inputValue(),new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(r.price));assert.equal(Number(await cell(r.id,'taxTarget').getAttribute('data-pp-precise')),r.price);}
 assert.equal(await row('c0').locator('[data-pp-dirty]').count(),0);
 // Tab 和 Shift+Tab 都跳过只读售价，沿可编辑列顺序移动。
 await cell('c0','shortName').click();
 for(const [key,target] of [['Tab','price'],['Tab','rate'],['Shift+Tab','price'],['Shift+Tab','shortName']]){
  await page.keyboard.press(key);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.ppCell),target);
 }
 await cell('c0','price').click();assert.match(await page.locator('#pp-formula-hint').textContent(),/售价.*3,399/);
 assert.equal(await page.locator('.pp-fields th:visible').filter({hasText:/^售价$/}).count(),1);
 const firstRow=row('c0');
 assert.equal(await page.locator('.pp-fields th:visible').count(),16);
 assert.equal(await firstRow.locator('[data-pp-col="4"]').innerText(),'3,399');
 await firstRow.locator('[data-pp-col="4"]').click();
 assert.match(await page.locator('#pp-formula-value').inputValue(),/到手价.*店铺券/);
 assert.match(await firstRow.locator('[data-pp-col="4"]').getAttribute('title'),/到手价 \+ 店铺券.*400/);
 assert.equal(await page.locator('.pp-table > colgroup > col').nth(10).evaluate(el=>el.style.width),'68px');
 const stock=firstRow.locator('[data-pp-col="10"]');
 assert.match(await stock.innerText(),/^0\s*待入120$/);
 // 直接测量文字范围，确保三位数在途与现货一起落在 32px 行内。
 assert.equal(await stock.evaluate(td=>{
  const bounds=td.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(td);
  return bounds.height<=32&&Array.from(range.getClientRects()).every(r=>r.left>=bounds.left&&r.right<=bounds.right&&r.top>=bounds.top&&r.bottom<=bounds.bottom);
 }),true);
 await page.locator('#pp-more').click();
 assert.equal(await page.locator('.pp-fields th:visible').count(),21);
 assert.equal(await firstRow.locator('[data-pp-col="20"]').innerText(),'120');
 // 聚焦时还原原始精度，失焦且没有输入时不能制造草稿。
 for(const key of ['taxTarget','erpTarget']){
  const input=cell('c0',key),raw=await input.getAttribute('data-pp-precise');
  await input.click();assert.equal(await input.inputValue(),raw);
  await page.locator('.pp-grid').focus();
  assert.equal(await input.inputValue(),new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(Number(raw)));
 }
 assert.equal(await firstRow.locator('[data-pp-dirty]').count(),0);
 // 编辑中的旧单格文字不能在矩阵粘贴后反盖写，整个批次仅一个历史检查点。
 await cell('c0','spu').fill('1234');const before=await page.evaluate(()=>p0Probe.history());
 await page.evaluate(()=>navigator.clipboard.writeText('9100\t8100\t新简称甲\t忽略售价\t3100\t4\n9101\t8101\t新简称乙\t忽略售价\t3200\t6'));
 await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c1').price===3200);
 await page.locator('.pp-grid').focus();
 assert.equal(await page.evaluate(()=>p0Probe.history()),before+1);assert.equal(find(await snapshot(),'c0').spu,'9100');
 assert.ok(await row('c0').locator('[data-pp-dirty]').count()>=5);
 assert.match(await row('c0').locator('[data-pp-col="1"]').getAttribute('title'),/未保存：9000 → 9100/);
 await page.keyboard.press('Control+z');await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c1').price===2999);
 assert.equal(find(await snapshot(),'c0').spu,'9000');assert.equal(await row('c0').locator('[data-pp-dirty]').count(),0);
 await paste('c0','spu','9100\t8100\t新简称甲\t忽略售价\t3100\t4\n9101\t8101\t新简称乙\t忽略售价\t3200\t6');
 await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c1').price===3200);
 await page.locator('#pp-save').click();await page.waitForFunction(()=>document.querySelectorAll('[data-pp-dirty]').length===0);
 assert.equal(find(saved,'c0').shortName,'新简称甲');assert.equal(find(saved,'c0').name,'配置1');
 // 原子校验失败不应用首行，也保留正在输入的文字。
 await cell('c0','price').fill('3333');await page.evaluate(()=>navigator.clipboard.writeText('3500\n坏价格'));await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>document.querySelector('#pp-status').textContent.includes('有效到手价'));
 assert.equal(find(await snapshot(),'c0').price,3100);assert.equal(await cell('c0','price').inputValue(),'3333');await cell('c0','price').press('Escape');
 // 数据格拖选不选中文字；原地单击仍能编辑，已经聚焦的输入也能拖出框选。
 for(const key of ['price','sku','shortName']){
  const from=await cell('c0',key).boundingBox(),to=await cell('c1',key).boundingBox();
  await page.mouse.move(from.x+8,from.y+10);await page.mouse.down();await page.mouse.move(to.x+10,to.y+10,{steps:8});await page.mouse.up();
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');assert.ok(await page.locator('td[data-pp-range]').count()>=2);
  await cell('c0',key).click();assert.equal(await cell('c0',key).evaluate(el=>el===document.activeElement),true);
 }
 // 列宽拖动不改变排序，刷新仍沿用；双击边界恢复默认。
 const handle=page.locator('[data-pp-resize="5"]'),bounds=await handle.boundingBox(),order=await page.locator('[data-pp-row]').evaluateAll(nodes=>nodes.map(n=>n.dataset.ppRow));
 await page.mouse.move(bounds.x+3,bounds.y+12);await page.mouse.down();await page.mouse.move(bounds.x+65,bounds.y+12,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('diy-price-column-widths-v3'))[10]),68);
 const width=await page.locator('.pp-table > colgroup > col').nth(5).evaluate(el=>el.style.width);
 assert.deepEqual(await page.locator('[data-pp-row]').evaluateAll(nodes=>nodes.map(n=>n.dataset.ppRow)),order);
 await open();assert.equal(await page.locator('.pp-table > colgroup > col').nth(5).evaluate(el=>el.style.width),width);
 await page.locator('[data-pp-resize="5"]').dblclick();assert.equal(await page.locator('.pp-table > colgroup > col').nth(5).evaluate(el=>el.style.width),'79px');
 // 同一React卡片支持换件、独立税价、展示文字与Enter跳行；主表更新保留root/PartPicker焦点。
 await row('c0').locator('[data-pp-expand]').click();await card('c0').locator('.ov-table').waitFor();
 await page.evaluate(()=>window.savedCard=document.querySelector('[data-pp-card="c0"]'));
 await edit(card('c0').getByRole('textbox',{name:'配置1 CPU含税单价'}),'650');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='配置1 内存含税单价');
 assert.equal(await card('c0').getByRole('textbox',{name:'配置1 CPU含税单价'}).inputValue(),'650');
 assert.equal(find(await snapshot(),'c0').actualParts.find(p=>p.slot==='CPU').taxOverride.value,650);
 await edit(card('c0').getByRole('textbox',{name:'配置1 CPU实际数量'}),'2');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='配置1 内存实际数量');
 await card('c0').getByRole('textbox',{name:'配置1 内存实际数量'}).press('Shift+Enter');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='配置1 CPU实际数量');
 await card('c0').getByRole('textbox',{name:'CPU展示明细',exact:true}).fill('主图展示文案');await page.keyboard.press('Enter');
 assert.equal(find(await snapshot(),'c0').parts.find(p=>p.slot==='CPU').displayName,'主图展示文案');
 assert.ok((await page.evaluate(()=>p0Probe.pending())).includes('c0'));
 await card('c0').locator('[data-ov-cell="0"]').first().dblclick();
 const picker=card('c0').getByRole('combobox');await picker.fill('新款 CPU');await page.getByRole('option').filter({hasText:'新款 CPU'}).click();
 await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c0').actualParts.find(p=>p.slot==='CPU').goodsId==='1003');
 const config=find(await snapshot(),'c0');assert.equal(config.actualParts.find(p=>p.slot==='CPU').taxOverride,null);
 assert.equal((await snapshot()).costSource.find(p=>p.goodsId==='1001').tax,600);
 assert.equal(await page.evaluate(()=>savedCard===document.querySelector('[data-pp-card="c0"]')),true);
 await edit(cell('c0','price'),'3300');assert.equal(await page.evaluate(()=>cardRoots.size),1);
 await card('c0').locator('[data-ov-cell="0"]').first().focus();await page.keyboard.press('Control+z');
 await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c0').price===3100);
 await page.keyboard.press('Control+y');await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c0').price===3300);
 if(process.env.WORKBENCH_SCREENSHOTS){await fs.mkdir(process.env.WORKBENCH_SCREENSHOTS,{recursive:true});await page.locator('.pp-grid').evaluate(el=>el.scrollTop=0);await page.screenshot({path:process.env.WORKBENCH_SCREENSHOTS+'/price-unification.png'});}
 // 弹窗、搜索框不穿透撤销；过滤隐藏显式释放，重新展开再释放。
 const history=await page.evaluate(()=>p0Probe.history());await page.locator('#pp-search').fill('配置');await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>p0Probe.history()),history);
 await page.locator('#pp-search').fill('');await page.locator('#pp-alert').click();await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>p0Probe.history()),history);await page.locator('#dialog').press('Escape');
 await page.locator('#pp-search').fill('配置2');assert.equal(await page.evaluate(()=>cardRoots.size),0);
 await page.locator('#pp-search').fill('');await row('c0').locator('[data-pp-expand]').click();
 if(!await card('c0').count())await row('c0').locator('[data-pp-expand]').click();
 await page.locator('#pp-close-expanded').click();assert.equal(await page.evaluate(()=>cardRoots.size),0);
 // 通过正式商品同步弹窗导出、修改、再导入，验证简称和店铺券真实往返。
 await page.locator('#pp-back').evaluate(button=>button.click());
 if(!await page.locator('[data-id="c0"]').isVisible())await page.locator('[data-product-toggle="p0"] .link-arrow').click();
 await page.locator('[data-id="c0"]').click();
 await page.evaluate(()=>p0Probe.standard());await page.locator('#standard-export').waitFor();
 const [jsonDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#standard-export').click()]);
 const standard=JSON.parse(await fs.readFile(await jsonDownload.path(),'utf8'));
 assert.equal(standard.SKU['8100'].SKU名称,'新简称甲');assert.equal(standard.SKU['8100'].SKU价格,3700);
 standard.SKU['8100'].SKU名称='标准表更新的简称';standard.SKU['8100'].SKU价格=3900;
 await page.locator('#standard-json').fill(JSON.stringify(standard));await page.locator('#standard-import').click();
 await page.locator('#standard-prices').check();await page.locator('#standard-apply').click();
 await page.waitForFunction(()=>p0Probe.snapshot().configs.find(c=>c.id==='c0').shortName==='标准表更新的简称');
 assert.equal(find(await snapshot(),'c0').name,'配置1');assert.equal(find(await snapshot(),'c0').price,3500);
 assert.equal(find(await snapshot(),'c0').shortNameAuto,false);
 await page.locator('#image-export-kind').selectOption('long');
 const [posterDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
 assert.match(posterDownload.suggestedFilename(),/_配置1_/);assert.ok(!posterDownload.suggestedFilename().includes('标准表更新的简称'));
 assert.equal(await posterDownload.failure(),null);
 await page.locator('#renumber').evaluate(button=>button.click());await page.locator('#renumber-apply').waitFor();
 assert.equal(await page.locator('#renumber-apply').isDisabled(),true);await page.locator('#dialog').press('Escape');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,matrixUndoSave:true,failedPastePreserved:true,formulaTerms:4,rootLifecycle:true,columnWidths:true,selection:true,sharedCard:true}));
}finally{await browser.close();}
