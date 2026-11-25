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
const quantitySources=[
 {shopId:'intel',sourceId:'s-unit-20',goodsId:'1020',slot:'CPU',name:'两位单价布局样例',erp:20,tax:20,stockAvailable:12},
 {shopId:'intel',sourceId:'s-unit-1520',goodsId:'1520',slot:'CPU',name:'四位单价布局样例',erp:1520,tax:1520,stockAvailable:12},
];
const configs=Array.from({length:2},(_,index)=>{
 const c=blankConfig(null,product,'配置'+(index+1));c.id='c'+index;c.price=2000;c.skuId='340000000000000000'+index;
 c.parts=sources.map(p=>({...p,qty:1}));c.actualParts=structuredClone(c.parts);
 // 模拟旧测试版已选实际型号、展示行仍为空的配置。
 if(index===0)c.parts=c.parts.filter(part=>part.slot!=='CPU');
 if(index===1)c.skuExportMode='dedicated';
 return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.sourceCatalog=[...sources,...quantitySources];
state.costSource=[...sources,...quantitySources];
const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',"<script type=module>import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>");
const app=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
const errors=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},bypassCSP:true,permissions:['clipboard-read','clipboard-write']});
 page.on('pageerror',error=>errors.push(error.stack));
 await page.route('**/workbench/overview-price-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',route=>route.fulfill({contentType:'text/javascript',body:app+'\nwindow.overviewProbe={snapshot:()=>structuredClone(state),previewId:()=>previewConfigId,undo:()=>stepHistory(history,redoHistory,"撤销")};'}));
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
 // 右栏三种画布和导出选择联动，切换方案时保留显式选项。
 const previews=page.locator('.ov-preview-modes');
 const previewButton=mode=>previews.locator('[data-ov-preview="'+mode+'"]');
 const kind=page.locator('#image-export-kind'),sku=page.locator('#image-export-sku-mode');
 const labels={long:'紧凑详情图',padded:'1:1 详情补白',dedicated:'1:1 专用 SKU'};
 const waitPreview=async(mode,id='c0',expanded=false)=>{
  await page.waitForFunction(({label,id})=>window.overviewProbe.previewId()===id&&
   document.querySelector('#dimensions').textContent.endsWith(label),{label:labels[mode],id});
  if(!expanded)assert.deepEqual(await previews.locator('[aria-pressed="true"]').evaluateAll(buttons=>buttons.map(button=>button.dataset.ovPreview)),[mode]);
  const canvas=page.locator('#poster');
  assert.ok(await canvas.evaluate((el,square)=>el.width>0&&el.height>0&&(!square||el.width===el.height),mode!=='long'));
  assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false);
  assert.equal(await page.evaluate(()=>window.workbenchHasPendingChanges()),false);
  return canvas.evaluate(async el=>{
   const pixels=el.getContext('2d').getImageData(0,0,el.width,el.height).data;
   return [...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].join(',');
  });
 };
 const activate=async id=>{
  await page.locator('[data-id="'+id+'"]').click();
  await card(id).filter({has:page.locator('.ov-columns')}).waitFor();
 };
 // 先载入和归一化两个配置，再记录切换预览前的配置内容。
 await activate('c1');await waitPreview('long','c1');
 await activate('c0');
 const detail=await waitPreview('long');
 const beforePreview=await page.evaluate(()=>window.overviewProbe.snapshot().configs);
 const revisionBeforePreview=state.revision;
 let dialogCount=0;
 page.on('dialog',async dialog=>{dialogCount++;await dialog.dismiss();});
 assert.deepEqual(await previews.getByRole('button').allTextContents(),['清单图','SKU 补白','SKU 专用']);

 await previewButton('padded').click();
 const padded=await waitPreview('padded');
 assert.equal(await sku.inputValue(),'padded');
 await previewButton('dedicated').click();
 const dedicated=await waitPreview('dedicated');
 assert.equal(await sku.inputValue(),'dedicated');
 assert.equal(new Set([detail,padded,dedicated]).size,3);
 await activate('c1');
 assert.notEqual(await waitPreview('dedicated','c1'),dedicated);
 assert.equal(await sku.inputValue(),'dedicated');
 await activate('c0');
 assert.equal(await waitPreview('dedicated'),dedicated);

 await sku.selectOption('padded');
 assert.equal(await waitPreview('padded'),padded);
 await sku.selectOption('dedicated');
 assert.equal(await waitPreview('dedicated'),dedicated);
 await sku.selectOption('saved');
 assert.equal(await waitPreview('padded'),padded);
 await activate('c1');await waitPreview('dedicated','c1');
 assert.equal(await sku.inputValue(),'saved');
 await activate('c0');await waitPreview('padded');
 await previewButton('dedicated').click();await waitPreview('dedicated');
 await previewButton('long').click();await waitPreview('long');
 assert.equal(await sku.inputValue(),'dedicated');
 assert.equal(await kind.inputValue(),'both');
 await kind.selectOption('square');await waitPreview('dedicated');
 await kind.selectOption('long');await waitPreview('long');
 assert.equal(await page.locator('#image-export-sku-choice').isVisible(),false);
 await previewButton('padded').click();await waitPreview('padded');
 assert.equal(await kind.inputValue(),'square');
 assert.equal(await page.locator('#image-export-sku-choice').isVisible(),true);
 await page.locator('#preview-expand').click();
 assert.equal(await previews.isVisible(),false);
 await sku.selectOption('dedicated');await waitPreview('long','c0',true);
 await page.keyboard.press('Escape');await waitPreview('dedicated');
 await previewButton('padded').click();await waitPreview('padded');

 // 深浅主题和两种栏宽下，三颗按钮保持单行，选中态不同于未选按钮的悬停态。
 const background=button=>button.evaluate(el=>getComputedStyle(el).backgroundColor);
 for(const [theme,width] of [['light',350],['dark',300]]){
  await page.evaluate(({theme,width})=>{
   document.querySelector('.workspace').style.setProperty('--preview-w',width+'px');
   window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:theme}));
  },{theme,width});
  await page.waitForFunction(theme=>document.documentElement.dataset.workbenchTheme===theme,theme);
  assert.equal(await previews.getByRole('button').evaluateAll(buttons=>buttons.every(button=>
   button.getBoundingClientRect().top===buttons[0].getBoundingClientRect().top&&
   getComputedStyle(button).whiteSpace==='nowrap'&&button.scrollWidth<=button.clientWidth)),true);
  const selected=previewButton('padded'),idle=previewButton('dedicated');
  const normal=await background(idle);
  await idle.hover();
  await page.waitForFunction(normal=>getComputedStyle(document.querySelector('[data-ov-preview="dedicated"]')).backgroundColor!==normal,normal);
  assert.notEqual(await background(idle),await background(selected));
  assert.equal(await selected.evaluate(el=>getComputedStyle(el).color),'rgb(243, 241, 52)');
  await selected.hover();
  assert.equal(await background(selected),'rgb(24, 26, 25)');
 }
 await page.evaluate(()=>{
  document.querySelector('.workspace').style.removeProperty('--preview-w');
  window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:'light'}));
 });
 await kind.selectOption('both');
 await previewButton('long').click();await waitPreview('long');
 await sku.selectOption('saved');await waitPreview('long');
 assert.equal(dialogCount,0);
 assert.equal(state.revision,revisionBeforePreview);
 assert.deepEqual(await page.evaluate(()=>window.overviewProbe.snapshot().configs),beforePreview);
 await edit(tax('c0','CPU'),'900');await waitCount(1);
 assert.equal(await tax('c0','CPU').evaluate(input=>input.closest('td').title),'原含税单价 850');
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
 // 分别验收两位和四位单价。两列的乘数要对齐，焦点态和单件价格仍可正常编辑。
 const cpuRow=card('c0').locator('tr').filter({has:page.getByRole('button',{name:'CPU',exact:true})});
 const taxUnit=tax('c0','CPU');
 async function assertCenteredTotals(withActions=false){
  const metrics=await cpuRow.evaluate(row=>{
   const cells=[...row.querySelectorAll('td.ov-number')].slice(0,2);
   const rect=element=>element.getBoundingClientRect();
   const actions=row.querySelector('.ov-tax-actions');
   return cells.map(cell=>{
    const {top,bottom,height,left,right}=rect(cell);
    const total=rect(cell.querySelector('.ov-line-total'));
    const calc=rect(cell.querySelector('.ov-line-calc'));
    const actionRect=actions&&rect(actions);
    const buttons=actions?[...actions.querySelectorAll('button')].map(rect):[];
    return {alignment:getComputedStyle(cell).verticalAlign,height,totalTop:total.top,calcTop:calc.top,
     centerOffset:(total.top+(actionRect?.bottom??calc.bottom)-top-bottom)/2,
     actionsFit:actionRect!==null && buttons.every(button=>button.top>=actionRect.top&&button.bottom<=actionRect.bottom&&
      button.left>=actionRect.left&&button.right<=actionRect.right),
     buttonCenter:buttons.length?(buttons[0].left+buttons.at(-1).right-left-right)/2:null,
    };
   });
  });
  const [erp,tax]=metrics;
  assert.ok(metrics.every(cell=>cell.alignment==='middle'&&cell.height>=120&&Math.abs(cell.centerOffset)<1),JSON.stringify(metrics));
  assert.ok(Math.abs(erp.totalTop-tax.totalTop)<1&&Math.abs(erp.calcTop-tax.calcTop)<1);
  if(withActions)assert.ok(tax.actionsFit&&Math.abs(tax.buttonCenter)<1,JSON.stringify(metrics));
 }
 async function pasteQuantity(goodsId,qty){
  await pasteModel(goodsId+'\t'+qty);
  await page.waitForFunction(({goodsId,qty})=>{
   const part=window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts.find(p=>p.slot==='CPU');
   return part?.goodsId===goodsId&&part.qty===qty;
  },{goodsId,qty});
 }
 for(const [goodsId,unit,formatted] of [['1020',20,'20'],['1520',1520,'1,520']]){
  await pasteQuantity(goodsId,1);
  assert.equal(await cpuRow.locator('.ov-line-calc').count(),0);
  // 配件写入先完成，React 卡片随后提交显示值。
  await page.waitForFunction(({selector,value})=>document.querySelector(selector)?.value===value,{selector:'[data-continuous-config="c0"] [aria-label="配置1 CPU含税单价"]',value:formatted});
  assert.equal(await taxUnit.inputValue(),formatted);
  assert.equal(await taxUnit.evaluate(input=>input.getBoundingClientRect().width<=input.closest('td').clientWidth),true);
  await pasteQuantity(goodsId,5);
  // 模拟展示明细多行时的高行，避免只有最小行高而测不出顶对齐。
  await cpuRow.locator('.ov-display').evaluate(cell=>{cell.style.height='120px';});
  await assertCenteredTotals();
  const measure=()=>cpuRow.evaluate(row=>{
   const rect=el=>el.getBoundingClientRect();
   return [...row.querySelectorAll('.ov-line-calc')].map(line=>{
    const unit=line.firstElementChild,multiplier=line.lastElementChild,cell=rect(line.closest('td'));
    const r=rect(line),u=rect(unit),m=rect(multiplier),style=getComputedStyle(unit.querySelector('input')||unit);
    return {top:r.top,height:r.height,multiplierTop:m.top,multiplier:multiplier.textContent,gap:m.left-u.right,width:m.right-u.left,
     centerOffset:(u.left+m.right-cell.left-cell.right)/2,inside:u.left>cell.left&&m.right<cell.right,
     fontSize:style.fontSize,unitText:unit.querySelector('input')?.value??unit.textContent};
   });
  });
  const [erp,taxLine]=await measure();
  assert.equal(erp.unitText,formatted);
  assert.equal(taxLine.unitText,formatted);
  assert.equal(erp.multiplier,'× 5');
  assert.equal(taxLine.multiplier,erp.multiplier);
  assert.equal(erp.fontSize,taxLine.fontSize);
  assert.equal(erp.height,18);
  assert.equal(taxLine.height,erp.height);
  assert.ok(Math.abs(taxLine.top-erp.top)<1&&Math.abs(taxLine.multiplierTop-erp.multiplierTop)<1);
  assert.ok(Math.abs(taxLine.gap-erp.gap)<1&&Math.abs(taxLine.width-erp.width)<2);
  assert.ok([erp,taxLine].every(line=>line.inside&&Math.abs(line.centerOffset)<1));
  await taxUnit.focus();
  assert.equal(await taxUnit.inputValue(),String(unit));
  assert.equal(await taxUnit.evaluate(input=>getComputedStyle(input).outlineStyle),'solid');
  assert.ok((await measure()).every(line=>line.inside));
  await taxUnit.press('Escape');
  assert.equal(await taxUnit.inputValue(),formatted);
  // 修改含税单价时，操作按钮居中，ERP 与含税的两行金额仍齐平。
  await taxUnit.fill(String(unit+1));
  const actions=cpuRow.locator('.ov-tax-actions');
  await actions.getByRole('button',{name:'恢复',exact:true}).waitFor();
  assert.deepEqual(await actions.getByRole('button').allTextContents(),['全局','恢复']);
  await assertCenteredTotals(true);
  await taxUnit.press('Escape');
  await actions.waitFor({state:'detached'});
  await assertCenteredTotals();
  await cpuRow.locator('.ov-display').evaluate(cell=>{cell.style.removeProperty('height');});
  await page.locator('#undo').evaluate(button=>button.click());
  await waitQuantity(1);
  await page.locator('#undo').evaluate(button=>button.click());
  await page.waitForFunction(()=>window.overviewProbe.snapshot().configs.find(c=>c.id==='c0').actualParts.find(p=>p.slot==='CPU')?.goodsId==='1001');
 }
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
 assert.deepEqual(await sheet.locator('.pp-fields th:visible').allTextContents(),['序','SPU','SKU','SKU 名称 / 简称','售价','到手价↕','运营费率','核算利润↕','ERP 利润↕','核算利润率↕','可销','含税成本','ERP 成本','状态','机箱 / 颜色','费率成本']);
 assert.equal(await sheet.locator('.pp-fields th').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(38, 38, 38)');
 const expand=sheet.locator('[data-pp-expand="c0"]').first();
 assert.equal(await expand.getAttribute('aria-expanded'),'false');
 assert.equal(await sheet.locator('[data-pp-collapse]').first().getAttribute('aria-expanded'),'true');
 await expand.click();
 assert.equal(await sheet.locator('[data-continuous-config="c0"] .ov-table tbody tr').count(),9);
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-price.png')});
 await edit(sheet.locator('[data-continuous-config="c0"]').getByRole('textbox',{name:'配置1 CPU实际数量'}),'2');
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
 console.log('通过：三种纯预览、导出联动、深浅主题按钮、双页签、表头合计、两侧单价乘数对齐、核算价醒目标记与整链去重计数、出图与实际分离、整链分期、价格明细、简称编辑与选区复制。');
}finally{await browser.close();}
