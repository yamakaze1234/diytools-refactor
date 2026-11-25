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
const other=structuredClone(configs[1]);Object.assign(other,{id:'other',productId:'p2',product:'另一条链接',spu:'',skuId:''});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs:[...configs,other],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
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
 // 按用户资料核验导航：首次点开只打开，箭头和重复点击才展开，不置顶。
 const link=page.locator('[data-product-toggle="p1"]');
 await link.click();await page.locator('[data-continuous-config="c0"]').waitFor();
 assert.equal(await link.getAttribute('aria-expanded'),'false');
 await link.click();await page.waitForFunction(()=>document.querySelector('[data-product-toggle="p1"]').getAttribute('aria-expanded')==='true');
 assert.deepEqual(await page.locator('[data-zone-toggle] .zone-title').allTextContents(),['草稿区','链接区']);
 const card=id=>page.locator('[data-continuous-config="'+id+'"]');
 const config=id=>page.evaluate(id=>window.overviewProbe.snapshot().configs.find(c=>c.id===id),id);
 const edit=async(field,value)=>{await field.fill(value);await field.press('Enter');};
 await card('c0').locator('.ov-columns').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] tbody').rows.length===9);assert.equal(await card('c0').locator('tbody tr').count(),9);
 await card('c0').getByRole('button',{name:'配置1 新增配件',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] tbody').rows.length===10);assert.equal(await card('c0').locator('tbody tr').count(),10);
 await card('c0').getByRole('button',{name:'－ 减少配件',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] tbody').rows.length===9);assert.equal(await card('c0').locator('tbody tr').count(),9);
 // 两套成本相同，ERP利润不受分期影响；目标利润按元四舍五入。
 const erpBefore=await card('c0').getByRole('textbox',{name:'配置1ERP利润',exact:true}).inputValue();
 const widths=()=>card('c0').locator('.ov-sum-values td').evaluateAll(cells=>cells.map(c=>Math.round(c.getBoundingClientRect().width)));
 const beforeWidths=await widths();
 await page.getByRole('checkbox',{name:/整链分期/}).click();
 assert.equal(await card('c0').getByRole('textbox',{name:'配置1ERP利润',exact:true}).inputValue(),erpBefore);
 await edit(card('c0').getByRole('textbox',{name:'配置1核算利润',exact:true}),'100');
 assert.equal((await config('c0')).price,1459);
 await edit(card('c0').getByRole('textbox',{name:'配置1ERP利润',exact:true}),'100');
 assert.equal((await config('c0')).price,1122);
 await card('c0').getByRole('button',{name:'配置1到手价增加100',exact:true}).click();
 assert.equal((await config('c0')).price,1222);
 await page.getByRole('checkbox',{name:'整链取 99',exact:true}).click();
 assert.equal((await config('c0')).price,1199);
 assert.equal((await config('c1')).overviewPrice99,true);
 await page.getByRole('checkbox',{name:'整链取 99',exact:true}).click();
 assert.equal((await config('c0')).overviewPrice99,false);
 assert.deepEqual(await widths(),beforeWidths);
 // 鼠标拖过数量/配件/实际型号三列，中间列也参与，并带精确来源的剪贴板。
 const cell=(id,col)=>card(id).locator('[data-ov-row="0"][data-ov-cell="'+col+'"]');
 await cell('c0',1).dispatchEvent('pointerdown',{button:0,buttons:1});
 await cell('c0',0).dispatchEvent('pointermove',{button:0,buttons:1});await cell('c0',0).dispatchEvent('pointerup',{button:0});
 assert.equal(await card('c0').locator('tbody [data-ov-selected]').count(),3);
 const clip=await cell('c0',0).evaluate(el=>{const clipboardData=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData,bubbles:true,cancelable:true}));return {plain:clipboardData.getData('text/plain'),cells:clipboardData.getData('application/x-diy-workbench-cells')};});
 assert.ok(JSON.parse(clip.cells).sourceText.startsWith('s-cpu'));
 assert.equal(await card('c0').locator('[data-cp]').count(),3);
 await cell('c1',0).evaluate((el,clip)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',clip.plain);clipboardData.setData('application/x-diy-workbench-cells',clip.cells);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));},clip);
 assert.equal((await config('c1')).actualParts[0].sourceId,'s-cpu');
 await page.keyboard.press('Escape');assert.equal(await card('c0').locator('[data-cp]').count(),0);
 // 改单套核算价后能预览三店全局/恢复；字体偏好和分区保留。
 await edit(card('c0').getByRole('textbox',{name:'配置1 CPU含税单价',exact:true}),'900');
 await card('c0').getByRole('button',{name:'全局',exact:true}).waitFor();assert.equal(await card('c0').getByRole('button',{name:'全局',exact:true}).count(),1);
 await card('c0').getByRole('button',{name:'恢复',exact:true}).click();
 assert.equal((await config('c0')).actualParts[0].tax,850);
 await page.locator('#ui-font-choice').selectOption('system');assert.equal(await page.evaluate(()=>localStorage.getItem('diy-ui-font')),'system');
 await page.locator('[data-zone-toggle="draft"] .zone-title').click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('diy-list-zone')),'draft');
 await page.locator('#batch-profit-price').click();await page.locator('#bpp-target').fill('100');
 await page.locator('#bpp-rows tr').first().waitFor();
 assert.equal(await page.locator('#bpp-rows tr').count(),2);
 await page.locator('#bpp-apply').click();
 await page.waitForFunction(()=>document.querySelector('#dialog').open===false);
 await page.locator('.ov-sheet-scroll').focus();await page.keyboard.press('Control+z');await page.keyboard.press('Control+y');
 assert.ok((await config('c0')).price>0);
 // 只勾一套时，整链开关的其他配置也必须在预览中出现。
 if(!await card('c0').getByRole('checkbox',{name:'选择配置1',exact:true}).isChecked())await card('c0').getByRole('checkbox',{name:'选择配置1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"] input[aria-label="选择配置1"]').checked);
 if(await card('c1').getByRole('checkbox',{name:'选择配置2',exact:true}).isChecked())await card('c1').getByRole('checkbox',{name:'选择配置2',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-continuous-config="c1"] input[aria-label="选择配置2"]').checked);
 await page.locator('#batch-profit-price').click();await page.locator('input[name="bpp-scope"][value="selected"]').check();await page.locator('#bpp-target').fill('100');await page.locator('#bpp-99').selectOption('on');
 await page.locator('#bpp-rows tr').first().waitFor();
 assert.equal(await page.locator('#bpp-rows tr').count(),2);assert.match(await page.locator('#bpp-rows').textContent(),/整链设置/);await page.locator('#bpp-apply').click();
 assert.equal((await config('c1')).price%100,99);assert.equal((await config('c1')).overviewPrice99,true);
 // 另一条链接展开时切到首套，收起不切换；滚到底后左栏与编辑项一同跟随。
 const otherLink=page.locator('[data-product-toggle="p2"]');
 await otherLink.locator('.link-arrow').click();
 await card('other').waitFor();
 assert.equal(await card('other').getAttribute('data-active'),'true');
 await otherLink.locator('.link-arrow').click();
 assert.equal(await card('other').getAttribute('data-active'),'true');
 if(await link.getAttribute('aria-expanded')==='false')await link.locator('.link-arrow').click();
 await page.locator('#config-list [data-id="c0"]').click();
 await card('c0').waitFor();
 assert.equal(await card('c0').getAttribute('data-active'),'true');
 const qty=card('c0').getByRole('textbox',{name:'配置1 CPU实际数量',exact:true});
 await qty.focus();await edit(qty,'3');
 await card('c0').locator('td[data-metric="ERP 单价"] .ov-line-total').first().waitFor();
 // 单价和乘数分列对齐，文字节点本身可以省略布局用空格。
 const erpCell=card('c0').locator('td[data-metric="ERP 单价"]').first();
 assert.equal(await erpCell.locator('.ov-line-total').textContent(),'2,400');
 assert.match(await erpCell.locator('.ov-line-calc').textContent(),/^800\s*×\s*3$/);
 await cell('c0',1).dispatchEvent('pointerdown',{button:0,buttons:1});
 await cell('c0',0).dispatchEvent('pointermove',{button:0,buttons:1});
 await cell('c0',0).dispatchEvent('pointerup',{button:0});
 await cell('c0',0).press('Delete');
 assert.equal((await config('c0')).actualParts[0].goodsId,'');
 assert.equal((await config('c0')).actualParts[0].qty,1);
 await page.evaluate(()=>window.overviewProbe.undo());
 assert.equal((await config('c0')).actualParts[0].goodsId,'1001');
 assert.equal((await config('c0')).actualParts[0].qty,3);
 await cell('c0',0).press('F2');
 const picker=card('c0').getByRole('combobox');
 await picker.fill('');assert.equal(await picker.evaluate(node=>node===document.activeElement),true);
 await picker.press('Escape');
 await page.locator('.ov-sheet-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c1"]').dataset.active==='true');
 assert.equal(await page.locator('#config-list [data-id="c1"]').getAttribute('aria-current'),'true');
 // 快速切换同店配置时旧图保留至新图就绪，预览画布中间不应清零。
 await page.waitForFunction(()=>document.querySelector('#poster').width>0&&!document.querySelector('#poster-stage').inert);
 await page.evaluate(()=>{
  const canvas=document.querySelector('#poster');
  window.previewWasCleared=false;
  new MutationObserver(records=>{
   if(!canvas.width||!canvas.height||records.some(record=>record.oldValue==='0'))window.previewWasCleared=true;
  }).observe(canvas,{attributes:true,attributeOldValue:true,attributeFilter:['width','height']});
 });
 for(const id of ['c0','c1','c0'])await page.locator('#config-list [data-id="'+id+'"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-continuous-config="c0"]').dataset.active==='true'&&!document.querySelector('#poster-stage').inert);
 assert.equal(await page.evaluate(()=>window.previewWasCleared),false);
 if(screenshots)await page.screenshot({path:join(screenshots,'workbench-1119.png')});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,navigation:true,profitInverse:true,erpExcludesInstallment:true,price99False:true,stableWidths:true,sourceClipboard:true,selectionAndAnts:true,batchPricing:true,quantitySubtotal:true,deleteUndo:true,emptySearchFocus:true,scrollFollowLast:true,previewKeepsFrame:true}));
}finally{await browser.close();}
