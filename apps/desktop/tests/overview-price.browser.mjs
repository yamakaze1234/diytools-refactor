/** 真实工作台页面的隔离验收：双入口、整链核算差异与撤销。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {blankConfig,posterParts} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const screenshots=process.env.WORKBENCH_SCREENSHOTS;
const product={id:'p1',name:'隔离样例链接',shopId:'intel',spu:'3800000000000001234',installment:0,configs:[]};
const sources=[
 {shopId:'intel',sourceId:'s-cpu',goodsId:'1001',slot:'CPU',name:'样例 CPU',erp:800,tax:850,stockAvailable:12,upgrade:'测试加购'},
 {shopId:'intel',sourceId:'s-memory',goodsId:'1002',slot:'内存',name:'样例内存',erp:200,tax:220,stockAvailable:24},
];
const configs=Array.from({length:2},(_,index)=>{
 const c=blankConfig(null,product,'配置'+(index+1));c.id='c'+index;c.price=2000;c.skuId='340000000000000000'+index;
 c.parts=sources.map(p=>({...p,qty:1}));c.actualParts=structuredClone(c.parts);
 // 模拟旧测试版已选实际型号、展示行仍为空的配置。
 if(index===0)c.parts=c.parts.filter(part=>part.slot!=='CPU');
 return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.sourceCatalog=sources;
state.costSource=sources;
const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',"<script type=module>import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>");
const app=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
const errors=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},bypassCSP:true,permissions:['clipboard-read','clipboard-write']});
 page.on('pageerror',error=>errors.push(error.stack));
 await page.route('**/workbench/overview-price-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',route=>route.fulfill({contentType:'text/javascript',body:app+'\nwindow.overviewProbe={snapshot:()=>structuredClone(state),undo:()=>stepHistory(history,redoHistory,"撤销")};'}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;
  let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...payload,revision:state.revision+1};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:state.updatedAt,activityDelta:[]};}
  else if(path==='/api/session')value={defaultOperator:'隔离验收'};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/overview-price-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p1"] .link-arrow').click();await page.locator('[data-id="c0"]').click();
 const card=id=>page.locator('[data-continuous-config="'+id+'"]');
 const count=page.locator('.overview-tax-count');
 const waitCount=amount=>page.waitForFunction(amount=>document.querySelector('.overview-tax-count')?.textContent===amount+' 套配置核算价有差异',amount);
 const tax=(id,slot)=>card(id).getByRole('textbox',{name:new RegExp(slot+'含税单价$')});
 const edit=async(field,value)=>{await field.fill(value);await field.press('Enter');};
 await waitCount(0);
 for(const id of ['c0','c1'])assert.equal(await card(id).locator('.ov-config-badge:visible').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(243, 241, 52)');
 assert.equal(await page.locator('.maintenance-tools').evaluate(el=>el.open),true);
 await card('c0').locator('.ov-columns').waitFor();
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-overview.png')});
 // 加购福利作为独立入口显示，原有总表与图片样式顺序继续保持。
 assert.deepEqual(await page.locator('.tabs button:visible').allTextContents(),['配置总表','加购选配和福利','图片样式']);
 assert.deepEqual(await card('c0').locator('.ov-columns th').allTextContents(),['ERP 单价','含税单价','GoodID','库存','数量','配件','实际配件','展示明细']);
 assert.equal(await card('c0').locator('.ov-sum-labels th').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(211, 232, 196)');
 assert.equal(await card('c0').locator('.ov-sum-labels .ov-dark').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(24, 26, 24)');
 assert.ok(await card('c0').locator('.ov-columns th').evaluateAll(cells=>cells.every(cell=>cell.getBoundingClientRect().width>0))); // 新表头按固定金额位数留宽。
 assert.equal(await card('c0').locator('.ov-sum-values .ov-fee').textContent(),'1,213');
 await page.locator('[data-ov-preview="square"]').click();
 await page.waitForFunction(()=>{const canvas=document.querySelector('#poster');return canvas.width>0&&canvas.width===canvas.height;});
 assert.equal(await page.evaluate(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').layout),'long');
 await page.locator('[data-ov-preview="long"]').click();
 await edit(tax('c0','CPU'),'900');await waitCount(1);
 assert.equal(await tax('c0','CPU').locator('..').getAttribute('title'),'原含税单价 850');
 assert.equal(await card('c0').locator('.ov-tax-changed').count(),1);
 await edit(tax('c0','内存'),'230');await waitCount(1);
 await edit(tax('c1','CPU'),'910');await waitCount(2);
 await page.evaluate(()=>window.overviewProbe.undo());await waitCount(1);
 await edit(tax('c0','CPU'),'850');await waitCount(1);
 await edit(tax('c0','内存'),'220');await waitCount(0);
 await card('c0').locator('.ov-tax-changed').waitFor({state:'detached'});
 assert.equal(await card('c0').locator('.ov-tax-changed').count(),0);
 // 模拟 Excel 制表符文本和表格选区，验证写入实际配件及同一笔撤销、重做。
 const gridCell=(id,row,col)=>card(id).locator('[data-ov-row="'+row+'"][data-ov-cell="'+col+'"]');
 await gridCell('c0',0,0).dblclick();
 const cpuPicker=card('c0').getByRole('combobox',{name:'配置1 CPU 实际配件',exact:true});
 await cpuPicker.waitFor();await cpuPicker.press('Escape');
 await cpuPicker.waitFor({state:'detached'});
 await gridCell('c0',0,0).evaluate(cell=>{
  const clipboardData=new DataTransfer();
  clipboardData.setData('text/plain','1001\t3');
  cell.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
 });
 const waitQuantity=qty=>page.waitForFunction(qty=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].qty===qty,qty);
 await waitQuantity(3);
 const displayCPU=()=>page.evaluate(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').parts.find(p=>p.slot==='CPU'));
 assert.equal((await displayCPU()).name,'样例 CPU');
 assert.equal((await displayCPU()).qty,3);
 const gap=await card('c0').locator('.ov-display-name small:visible').first().evaluate(el=>{
  const range=document.createRange();range.selectNodeContents(el.previousElementSibling);
  return el.getBoundingClientRect().left-Array.from(range.getClientRects()).at(-1).right;
 });
 assert.ok(gap>=0&&gap<=8);
 await gridCell('c0',0,0).dispatchEvent('pointerdown',{button:0,buttons:1});
 await gridCell('c0',0,1).dispatchEvent('pointerdown',{button:0,buttons:1,shiftKey:true});
 await gridCell('c0',0,1).dispatchEvent('pointerup',{button:0});
 const copied=await gridCell('c0',0,1).evaluate(cell=>{
  const clipboardData=new DataTransfer();
  cell.dispatchEvent(new ClipboardEvent('copy',{clipboardData,bubbles:true,cancelable:true}));
  return clipboardData.getData('text/plain');
 });
 assert.equal(copied,'样例 CPU\t3');
 await gridCell('c0',0,0).press('Control+z');await waitQuantity(1);
 await page.locator('#redo').evaluate(button=>button.click());await waitQuantity(3);
 await page.locator('#undo').evaluate(button=>button.click());await waitQuantity(1);
 const display=card('c0').getByRole('textbox',{name:'CPU展示明细',exact:true});
 // 单元格粘贴与候选选择共用同一换件动作；名称覆盖与隐藏状态随撤销恢复。
 const pasteModel=async(value)=>gridCell('c0',0,0).evaluate((cell,text)=>{
  const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);
  cell.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
 },value);
 await pasteModel('1001');
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').parts.find(p=>p.slot==='CPU')?.name==='样例 CPU');
 await edit(display,'对客户显示的 CPU');
 assert.equal(await page.evaluate(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].name),'样例 CPU');
 const showCell=display.locator('..').locator('..');
 await showCell.getByRole('button',{name:'隐藏展示配件',exact:true}).click();
 const snapshot=await page.evaluate(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0'));
 assert.equal(posterParts(snapshot).some(p=>p.slot==='CPU'),false);
 assert.equal(snapshot.actualParts[0].qty,1);
 await pasteModel('1002');
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].goodsId==='1002');
 assert.equal((await displayCPU()).displayName,'对客户显示的 CPU');
 assert.equal((await displayCPU()).posterVisible,false);
 await page.locator('#undo').evaluate(button=>button.click());
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts[0].goodsId==='1001');
 await card('c0').getByRole('button',{name:'恢复展示',exact:true}).click();
 const addon=card('c0').getByRole('textbox',{name:'CPU加购',exact:true});
 const cpuDisplayCell=addon.locator('xpath=ancestor::td');
 // 删空后仍可在同槽位打开输入框，新描述会立即显示。
 await edit(addon,'');
 await addon.waitFor({state:'detached'});
 await display.locator('xpath=ancestor::td').getByRole('button',{name:'添加加购',exact:true}).click();
 assert.equal(await addon.evaluate(el=>el===document.activeElement),true);
 const addonText='【自定义加购】';
 await edit(addon,addonText);
 assert.equal(await addon.locator('..').textContent(),addonText);
 assert.equal(await cpuDisplayCell.getByRole('button',{name:'隐藏加购',exact:true}).isVisible(),true);
 // 清除型号也清除同槽位的自定义名称、加购和出图行，两列作为一次编辑撤销。
 const waitCpu=goodsId=>page.waitForFunction(id=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts.find(p=>p.slot==='CPU').goodsId===id,goodsId);
 const historyBar=page.locator('.ov-history');
 await gridCell('c0',0,0).dblclick();
 await cpuPicker.press('Control+a');
 await cpuPicker.press('Backspace');
 await waitCpu('');
 assert.equal(await cpuPicker.inputValue(),'');
 assert.equal((await displayCPU()).displayName,undefined);
 assert.equal((await displayCPU()).name,'');
 assert.equal((await displayCPU()).upgrade,'');
 assert.equal(posterParts(await page.evaluate(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0'))).some(p=>p.slot==='CPU'),false);
 await historyBar.getByText('撤销',{exact:true}).click();await waitCpu('1001');
 await cpuPicker.waitFor({state:'detached'});
 assert.equal((await displayCPU()).displayName,'对客户显示的 CPU');
 assert.equal((await displayCPU()).upgrade,addonText);
 await historyBar.getByRole('button',{name:'重做',exact:true}).click();await waitCpu('');
 assert.equal(await gridCell('c0',0,0).textContent(),'—');
 assert.equal(await display.textContent(),'');
 await historyBar.getByRole('button',{name:'撤销',exact:true}).click();await waitCpu('1001');
 await pasteModel('\t1');
 await waitCpu('');
 assert.equal((await displayCPU()).name,'');
 assert.equal((await displayCPU()).upgrade,'');
 await historyBar.getByRole('button',{name:'撤销',exact:true}).click();await waitCpu('1001');
 await edit(card('c0').getByRole('textbox',{name:'配置1运营费率'}),'2');
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] .ov-sum-values .ov-fee')?.textContent==='1,191');
 assert.equal(await card('c0').locator('.ov-sum-values .ov-fee').textContent(),'1,191');
 await card('c0').getByRole('button',{name:'应用全部'}).click();
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c1"] .ov-sum-values .ov-fee')?.textContent==='1,191');
 assert.equal(await card('c1').locator('.ov-sum-values .ov-fee').textContent(),'1,191');
 await page.getByRole('checkbox',{name:/整链分期/}).click();
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.every(c=>c.installment===24));
 await card('c1').locator('.ov-controls small:visible').waitFor();
 assert.match(await card('c1').locator('.ov-controls small:visible').textContent(),/200/);
 await page.locator('#price-profit-open').evaluate(button=>button.click());
 const sheet=page.locator('#price-profit-page');await sheet.waitFor();
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-price-closed.png')});
 assert.equal(await sheet.locator('[data-pp-row]').count(),2);
 assert.deepEqual(await sheet.locator('.pp-fields th:visible').allTextContents(),['序','SPU','SKU','简称','售价','到手价↕','核算利润↕','ERP 利润↕','核算利润率↕','可销','核算成本','ERP 成本','状态','机箱 / 颜色','尾数99']);
 assert.equal(await sheet.locator('.pp-fields th').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(38, 38, 38)');
 const expand=sheet.locator('[data-pp-expand="c0"]').first();
 assert.equal(await expand.getAttribute('aria-expanded'),'false');
 assert.equal(await sheet.locator('[data-pp-collapse]').first().getAttribute('aria-expanded'),'true');
 await expand.click();
 assert.equal(await sheet.getByRole('table',{name:'展开的实际配件'}).locator('tbody tr').count(),2);
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-price.png')});
 await edit(sheet.locator('[data-pp-config="c0"][data-pp-qty="CPU"]'),'2');
 await waitQuantity(2);
 await edit(sheet.locator('[data-row-id="c0"][data-pp-cell="shortName"]'),'测试简称');
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').shortName==='测试简称');
 await sheet.locator('[data-row-id="c0"][data-pp-cell="price"]').click();
 await edit(sheet.locator('#pp-formula-value'),'2149.25');
 await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').price===2149.25);
 // 用真实鼠标及 Ctrl+C 验证可编辑单元格上的扩选和复制。
 await expand.click();
 const matrixCell=(id,col)=>sheet.locator('[data-pp-row="'+id+'"] > [data-pp-col="'+col+'"]');
 const priceEditor=id=>matrixCell(id,5).locator('input');
 const clipboard=()=>page.evaluate(async()=> (await navigator.clipboard.readText()).replace(/\r\n/g,'\n'));
 const copyByKeyboard=async()=>{await page.keyboard.press('Control+c');return clipboard();};
 await priceEditor('c0').click();
 await priceEditor('c1').click({modifiers:['Shift']});
 assert.equal(await sheet.locator('td[data-pp-range]').count(),2);
 assert.equal(await copyByKeyboard(),'2149.25\n2000');
 await priceEditor('c1').hover();
 await page.mouse.down();
 await matrixCell('c0',2).locator('input').hover();
 await page.mouse.up();
 assert.equal(await sheet.locator('td[data-pp-range]').count(),8);
 const expected='3400000000000000000\t测试简称\t2149\t2149.25\n3400000000000000001\t配置2\t2000\t2000';
 assert.equal(await copyByKeyboard(),expected);
 await page.evaluate(()=>navigator.clipboard.writeText(''));
 await sheet.locator('#pp-copy-range').click();
 assert.equal(await clipboard(),expected);
 // 模拟 WebView 禁用异步写入，按钮仍可通过原生 copy 事件复制选区。
 await page.evaluate(async()=>{
  await navigator.clipboard.writeText('');
  const denied=()=>Promise.reject(new DOMException('测试禁用异步写入','NotAllowedError'));
  navigator.clipboard.writeText=denied;
  navigator.clipboard.write=denied;
 });
 await sheet.locator('#pp-copy-range').click();
 assert.equal(await clipboard(),expected);
 await page.evaluate(()=>{delete navigator.clipboard.writeText;delete navigator.clipboard.write;});
 await matrixCell('c0',4).click();
 assert.equal(await sheet.locator('td[data-pp-range]').count(),1);
 assert.equal(await copyByKeyboard(),'2149');
 await page.keyboard.press('Shift+ArrowRight');
 assert.equal(await copyByKeyboard(),'2149\t2149.25');
 await priceEditor('c0').click();
 await page.keyboard.press('Shift+ArrowDown');
 assert.equal(await copyByKeyboard(),'2149.25\n2000');
 await priceEditor('c0').click();
 await priceEditor('c0').evaluate(input=>input.setSelectionRange(0,0));
 assert.equal(await copyByKeyboard(),'2149.25');
 // Ctrl 拖动添加整块，再用 Shift 扩展最后一块，早先的选择仍然保留。
 const dragAcross=async(from,to)=>{
  await from.hover();await page.mouse.down();await to.hover();await page.mouse.up();
 };
 const selected=()=>sheet.locator('td[data-pp-range]');
 await dragAcross(priceEditor('c1'),priceEditor('c0'));
 await matrixCell('c1',2).locator('input').click({modifiers:['Control']});
 await matrixCell('c0',2).locator('input').click({modifiers:['Shift']});
 assert.equal(await selected().count(),4);
 const multiExpected='3400000000000000000\t2149.25\n3400000000000000001\t2000';
 assert.equal(await copyByKeyboard(),multiExpected);
 await priceEditor('c0').click({modifiers:['Control']});
 assert.equal(await selected().count(),3);
 assert.equal(await copyByKeyboard(),multiExpected);
 assert.match(await sheet.locator('#pp-status').textContent(),/行列未对齐/);
 await sheet.locator('#pp-copy-range').click();
 assert.equal(await clipboard(),multiExpected);
 await priceEditor('c0').click({modifiers:['Control']});
 assert.equal(await selected().count(),4);
 await page.keyboard.down('Control');
 await dragAcross(priceEditor('c0'),priceEditor('c1'));
 await page.keyboard.up('Control');
 assert.equal(await selected().count(),2);
 assert.equal(await copyByKeyboard(),'3400000000000000000\n3400000000000000001');
 await page.keyboard.down('Control');
 await dragAcross(priceEditor('c1'),priceEditor('c0'));
 await page.keyboard.up('Control');
 assert.equal(await selected().count(),4);
 await sheet.locator('#pp-copy-range').click();
 assert.equal(await clipboard(),multiExpected);
 await matrixCell('c0',4).click();
 assert.equal(await selected().count(),1);
 await matrixCell('c0',4).click({modifiers:['Control']});
 assert.equal(await selected().count(),0);
 assert.equal(await sheet.locator('#pp-copy-range').isEnabled(),false);
 const nameEditor=matrixCell('c0',3).locator('input');
 await nameEditor.click();
 await nameEditor.evaluate(input=>input.setSelectionRange(0,2));
 assert.equal(await copyByKeyboard(),'测试');
 await sheet.locator('#pp-part-filter').click();
 await sheet.locator('#pp-part-search').fill('1001');
 await sheet.getByRole('button',{name:/CPU 样例 CPU/}).click();
 assert.equal(await sheet.locator('[data-pp-row]').count(),2);
 await sheet.locator('#pp-part-search').fill('不存在的型号');
 assert.equal(await sheet.locator('#pp-part-choices button').count(),0);
 await sheet.locator('#pp-back').evaluate(button=>button.click());
 await page.setViewportSize({width:1000,height:820});
 await card('c0').locator('.ov-mobile-head').waitFor();
 assert.equal(await card('c0').locator('.ov-columns').isVisible(),false);
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-overview-narrow.png')});
 // 只勾展示配件，选齐后手动预览；实际 BOM 在保存回读后仍为原型号。
 await page.locator('#link-parts').evaluate(button=>button.click());
 await page.locator('#link-part-actual').uncheck();
 await page.locator('#link-part-query').fill('样例内存');
 await page.locator('#link-part-match').selectOption('id:1002');
 await page.locator('#link-part-new-query').fill('1001');
 await page.locator('#link-part-new [data-product-id="s-cpu"]').click();
 assert.equal(await page.locator('#link-part-apply').isEnabled(),false);
 await page.locator('#link-part-preview').click();
 assert.match(await page.locator('#link-part-status').innerText(),/将修改 2 套配置/);
 await page.locator('#link-part-apply').click();
 await page.locator('#link-part-export-panel').waitFor({state:'visible',timeout:10000});
 for(const c of state.configs){
  assert.equal(c.parts.find(p=>p.slot==='内存').goodsId,'1001');
  assert.equal(c.actualParts.find(p=>p.slot==='内存').goodsId,'1002');
 }
 assert.deepEqual(errors,[]);
 console.log('通过：双页签、表头合计、核算价醒目标记与整链去重计数、出图与实际分离、整链分期、价格明细、简称编辑与选区复制。');
}finally{await browser.close();}
