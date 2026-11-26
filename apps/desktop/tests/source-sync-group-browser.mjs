/** 当前输出源维护/待确认窗口验收：真实 React 和领域保存，后端只使用合成内存资料。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applySourceSync} from '../public/workbench/source-sync-data.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const out=process.env.SOURCE_SYNC_REGRESSION_OUTPUT||'D:/diytools/sandbox/workbench-regression-finish-20261120/source-sync-group';
await fs.mkdir(out,{recursive:true});
const clone=value=>structuredClone(value),errors=[],blocked=[],checks=[];
let backend,conflictNext=null,savedPlans=[];
const first={rows:[{sourceId:'source',shopId:'intel',goodsId:'123',name:'新名称',tax:200,addonText:'【+199元升级水冷】'}],
 configs:['a','b'].map((id,i)=>({id,shopId:'intel',productId:'p'+(i+1),product:'链接'+(i+1),name:'配置'+(i+1),
  parts:[{slot:'散热',sourceId:'source',goodsId:'123',name:'原名称',tax:100,qty:1,upgrade:'手动加购说明'}],
  actualParts:[{slot:'散热',goodsId:'actual',qty:7}],addons:[{text:'人工加购'}]}))};
const categoryRows=['CPU','内存','散热','扩展配件'].map((slot,i)=>({sourceId:'part'+i,shopId:'intel',goodsId:String(i+10),name:slot+'新名称',tax:200,addonText:''}));
const part=i=>({slot:['CPU','内存','散热','扩展配件'][i],sourceId:categoryRows[i].sourceId,goodsId:categoryRows[i].goodsId,name:'原名称',tax:100,qty:1,upgrade:''});
const categories={rows:categoryRows,configs:[
 {id:'a',shopId:'intel',productId:'p1',product:'链接1',name:'配置1',parts:[part(1),part(0),part(3)],actualParts:[],addons:[]},
 {id:'b',shopId:'intel',productId:'p1',product:'链接1',name:'配置2',parts:[part(0)],actualParts:[],addons:[]},
 {id:'c',shopId:'intel',productId:'p2',product:'链接2',name:'配置3',parts:[part(2)],actualParts:[],addons:[]}]};
const descriptionRows=[{sourceId:'ram-a',shopId:'intel',goodsId:'20',name:'【+200元升级64GB内存】',tax:200,upgrade:'【+200元升级64GB内存】'},
 {sourceId:'ram-b',shopId:'intel',goodsId:'21',name:'32GB 内存',tax:200,upgrade:'【+300元升级64GB内存】'}];
const descriptions={rows:descriptionRows,configs:['a','b','c','d','e'].map((id,i)=>({id,shopId:'intel',productId:i===0?'p1':'p2',product:i===0?'T700':'X400CG',name:'配置'+(i+1),
 parts:[{slot:'内存',sourceId:descriptionRows[i===2?1:0].sourceId,goodsId:descriptionRows[i===2?1:0].goodsId,
 name:i===4?'【+100元升级64GB内存】':descriptionRows[i===2?1:0].name,tax:200,qty:1,upgrade:i===3?'':'【+100元升级64GB内存】'}],actualParts:[],addons:[]}))};
const browser=await chromium.launch({channel:'msedge',headless:true});let page;
try{
 page=await browser.newPage({viewport:{width:1400,height:1050},bypassCSP:true});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==new URL(base).origin){blocked.push(url.origin);return route.abort();}return route.continue();});
 await page.route('**/api/source-sync-fixture',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:clone(backend)});
  const plan=route.request().postDataJSON();
  // 模拟另一台客户端在预览后保存；只改变隔离后端资料，不修改浏览器模型或跳过 UI。
  if(conflictNext==='config')backend.configs[0].name='预览后修改';
  if(conflictNext==='source')backend.rows[0].tax=201;
  conflictNext=null;
  try{applySourceSync(plan,backend.configs,backend.rows);savedPlans.push(clone(plan));await route.fulfill({json:clone(backend)});}
  catch(error){await route.fulfill({status:409,json:{error:error.message}});}
 });
 const html=`<!doctype html><html><head><meta charset="utf-8"><script src="/workbench/endfield-init.js"></script>${['endfield/endfield.css','endfield-workbench.css','style.css','workbench-ui.css','workbench-simple.css','desktop-layout.css','ui-polish.css','reui-layout.css','source-sheet.css'].map(file=>'<link rel="stylesheet" href="/workbench/'+file+'">').join('')}</head><body>
 <button id="fixture-open">打开输出源维护</button><dialog id="dialog"><form method="dialog"><div class="dialog-title"><h2 id="dialog-title"></h2><button class="close" aria-label="关闭">×</button></div></form><div id="dialog-body"></div></dialog>
 <script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');const {openSourceEditor}=await import('/workbench/source-editor.js');
 const renderer=createWorkbenchReactRenderer(),dialog=document.querySelector('#dialog'),body=document.querySelector('#dialog-body');let state=null,applied=[];
 const read=async()=>{const response=await fetch('/api/source-sync-fixture');state=await response.json();};await read();
 function openDialog(title,markup){renderer.release(body);body.innerHTML=markup;document.querySelector('#dialog-title').textContent=title;if(!dialog.open)dialog.showModal();}
 const api={openDialog,shopId:()=> 'intel',getRows:()=>state.rows,getAllRows:()=>state.rows,getCosts:()=>[],getConfigs:()=>state.configs,
  flush:read,download:()=>{throw Error('本用例未请求导出');},lookupProduct:async()=>{throw Error('禁止真实 ERP');},setDeleted:async()=>{throw Error('未请求删除');},applyBatch:async()=>{throw Error('未请求改源');},
  updateLinkCosts:async()=>{throw Error('未请求改成本');},validateImage:async()=>{},
  render:(container,model)=>renderer.dialog(container,'source-editor',model),renderDetail:(container,model)=>renderer.dialog(container,'source-editor-detail',model),release:container=>renderer.release(container),
  applySync:async plan=>{const response=await fetch('/api/source-sync-fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(plan)});const result=await response.json();if(!response.ok)throw Error(result.error);state=result;applied.push(structuredClone(plan));}};
 document.querySelector('#fixture-open').onclick=()=>openSourceEditor(api);
 window.fixture={snapshot:()=>structuredClone({...state,applied})};window.fixtureReady=true;
 </script></body></html>`;
 await page.route('**/workbench/source-sync-group-fixture*',route=>route.fulfill({contentType:'text/html',body:html}));
 const open=async seed=>{backend=clone(seed);savedPlans=[];conflictNext=null;await page.goto(base+'/workbench/source-sync-group-fixture');await page.waitForFunction(()=>window.fixtureReady);await page.locator('#fixture-open').click();await page.locator('#source-open-pending').click();await review().locator('[data-source-select]').first().waitFor({state:'attached'});await review().locator('[data-review-export]').uncheck();};
 const review=()=>page.getByRole('dialog',{name:'待确认差异',exact:true});
 const link=async id=>review().locator('[data-review-link]').selectOption(id||'');
 const category=async name=>review().locator('[data-review-slot]').selectOption(name||'');
 const snapshot=()=>page.evaluate(()=>window.fixture.snapshot());
 // 历史回归覆盖核算单价，先通过真实字段筛选显式启用，再等待异步差异刷新。
 const includeTax=async()=>{
  const fields=review().locator('.sd-fields');
  await fields.locator('summary').click();
  await fields.locator('[data-source-field=tax]').check();
  await fields.locator('summary').click();
  await review().locator('[data-source-select][value*=tax]').first().waitFor({state:'attached'});
 };
 const choose=async(id,field)=>{
  const inputs=review().locator('[data-source-select]'),values=await inputs.evaluateAll(els=>els.map(el=>el.value));
  const index=values.findIndex(value=>{const key=JSON.parse(value);return key[0]===id&&key.at(-1)===field;});assert.ok(index>=0,'missing visible-filter field '+id+'/'+field);
  const input=inputs.nth(index);
  if(!await input.isVisible())await input.locator('xpath=ancestor::*[@data-source-description-group][1]').locator('[data-toggle-group]').click();
  if(await input.isChecked())await input.uncheck();else await input.check();
 };
 const applied=async n=>{await page.waitForFunction(n=>window.fixture.snapshot().applied.length===n,n);await review().locator('#source-apply').waitFor();};

 await open(first);await includeTax();
 assert.equal(await review().locator('[data-source-select]:checked').count(),0,'默认不勾选字段');
 assert.equal(await review().locator('#source-apply').isDisabled(),true,'未选择字段不能保存');
 assert.equal(await review().locator('[data-review-link]').inputValue(),'');
 await link('p1');assert.equal(await review().locator('[data-source-select]').count(),3);assert.doesNotMatch(await review().locator('[data-source-groups]').textContent(),/配置2/);
 await choose('a','name');await link('p2');assert.equal(await review().locator('[data-source-select]:checked').count(),0);await choose('b','upgrade');
 await link('p1');assert.equal(await review().locator('[data-source-select]:checked').count(),1);
 await choose('a','tax');assert.match(await review().locator('[data-source-sync-message]').innerText(),/含核算单价，不能忽略/);
 // 新窗口的可见“保持已选内容”只处理手动文本；单独选核算价时必须禁用。
 await review().locator('[data-source-clear]').click();await choose('a','tax');assert.equal(await review().locator('#source-keep-all').isDisabled(),true);
 await choose('a','tax');await choose('a','name');await link('p2');await choose('b','upgrade');await link('p1');
 await page.screenshot({path:path.join(out,'manual-confirm-preview.png')});await review().locator('#source-apply').click();await applied(1);
 let result=await snapshot();assert.equal(result.applied[0].changes.reduce((n,c)=>n+c.details.length,0),2);
 assert.equal(result.configs[0].parts[0].name,'新名称');assert.equal(result.configs[0].parts[0].sourceFollow.name.mode,'follow');assert.equal(result.configs[0].parts[0].upgrade,'手动加购说明');
 assert.equal(result.configs[1].parts[0].name,'原名称');assert.equal(result.configs[1].parts[0].sourceFollow.upgrade.mode,'follow');assert.equal(result.configs[0].parts[0].tax,100);
 await link('p1');await choose('a','upgrade');await review().locator('#source-keep-all').click();await applied(2);await link('p1');
 result=await snapshot();assert.equal(result.configs[0].parts[0].upgrade,'手动加购说明');assert.equal(result.configs[0].parts[0].sourceFollow.upgrade.mode,'manual');assert.ok(result.configs[0].parts[0].sourceFollow.upgrade.ignoredSourceValue);
 assert.equal(await review().locator('[data-source-select]').count(),1,'忽略版本后的升级文案不再提醒，只剩核算价');
 await choose('a','tax');conflictNext='config';await review().locator('#source-apply').click();await review().locator('[data-source-sync-message]').filter({hasText:'配置已变化'}).waitFor();
 assert.equal(savedPlans.length,2);assert.equal((await snapshot()).configs[0].parts[0].tax,100);
 // 冲突后的刷新会清空旧预览并异步重挂复选框，先等待目标字段回到 DOM。
 await review().locator('#source-check').click();
 await review().locator('[data-source-select]').first().waitFor({state:'attached'});
 await choose('a','tax');conflictNext='source';await review().locator('#source-apply').click();await review().locator('[data-source-sync-message]').filter({hasText:'输出源已变化'}).waitFor();
 assert.equal(savedPlans.length,2);
 result=await snapshot();for(let i=0;i<2;i++){assert.deepEqual(result.configs[i].actualParts,first.configs[i].actualParts);assert.deepEqual(result.configs[i].addons,first.configs[i].addons);}
 checks.push('默认零选择','链接筛选保留隐藏选择','所选字段保存和恢复follow','保持可见手动文案并忽略本次源版本','核算价不能忽略','并发配置/来源改动拒绝且无部分保存','实际BOM和人工加购保留');

 await open(categories);await includeTax();await link('p1');
 assert.deepEqual(await review().locator('[data-review-slot] option').allTextContents(),['全部配件','CPU','散热','内存','扩展配件']);
 await category('CPU');assert.equal(await review().locator('[data-source-select]').count(),4);assert.match(await review().locator('[data-source-description-group]').first().textContent(),/2 套配置/);
 for(const group of await review().locator('[data-source-select-group]').all())await group.check();await category('内存');assert.equal(await review().locator('[data-source-select]:checked').count(),0);
 await choose('a','name');await category('CPU');assert.equal(await review().locator('[data-source-select]:checked').count(),4);for(const group of await review().locator('[data-source-select-group]').all())await group.uncheck();
 await category('散热');assert.equal(await review().locator('[data-source-select]').count(),0,'链接1不能显示链接2的散热差异');await link('p2');assert.equal(await review().locator('[data-source-select]').count(),2);await choose('c','name');
 await category('内存');await link('p1');assert.equal(await review().locator('[data-source-select]:checked').count(),1);assert.equal(await review().locator('[data-source-select-group]:checked').count(),1);
 await review().locator('[data-source-clear]').click();assert.equal(await review().locator('#source-apply').isDisabled(),true);
 await choose('a','name');await category('');await page.screenshot({path:path.join(out,'part-category-preview.png')});await review().locator('#source-apply').click();await applied(1);
 result=await snapshot();assert.equal(result.applied[0].changes[0].details.length,1);assert.equal(result.configs[0].parts[0].name,'内存新名称');assert.equal(result.configs[0].parts[1].name,'原名称');assert.equal(result.configs[0].parts[0].tax,100);assert.equal(result.configs[2].parts[0].name,'原名称');
 checks.push('配件顺序和组计数','链接与配件select交叉筛选','跨分类选择保留','当前页全选范围','清空也取消隐藏选择','分类保存只改选中项');

 await open(descriptions);await category('内存');
 const descriptionGroups=review().locator('[data-source-description-group]');assert.equal(await descriptionGroups.count(),4);
 const sharedGroup=descriptionGroups.filter({hasText:'逐项升级说明'}).filter({hasText:'3 套配置 · 2 个链接'});assert.equal(await sharedGroup.count(),1);assert.equal(await sharedGroup.locator('[data-source-description]').count(),1);assert.equal(await sharedGroup.locator('[data-source-select]').count(),3);
 assert.match(await descriptionGroups.filter({hasText:/（空）/}).textContent(),/输出源最新加购\s*【\+200元升级64GB内存】/);
 await choose('a','upgrade');assert.equal(await sharedGroup.locator('[data-source-select-group]').evaluate(el=>el.indeterminate),true);
 await sharedGroup.locator('[data-source-select-group]').check();assert.equal(await review().locator('[data-source-select]:checked').count(),3);assert.equal(await review().locator('#source-keep-all').isEnabled(),true);
 await link('p1');assert.equal(await review().locator('[data-source-select]:checked').count(),1);await review().locator('[data-source-select-group]').uncheck();
 await link('');assert.equal(await sharedGroup.locator('[data-source-select-group]').evaluate(el=>el.indeterminate),true);assert.equal(await review().locator('[data-source-select]:checked').count(),2);await sharedGroup.locator('[data-source-select-group]').check();
 await page.screenshot({path:path.join(out,'part-description-preview.png')});await page.setViewportSize({width:600,height:1050});await page.screenshot({path:path.join(out,'part-description-narrow.png')});await page.setViewportSize({width:1400,height:1050});
 await review().locator('#source-apply').click();await applied(1);result=await snapshot();
 assert.deepEqual(result.applied[0].changes.map(c=>c.id),['a','b','e']);assert.ok(result.applied[0].changes.every(c=>c.details.length===1&&c.details[0].field==='upgrade'));
 assert.equal(result.configs[2].parts[0].upgrade,'【+100元升级64GB内存】');assert.equal(result.configs[3].parts[0].upgrade,'');assert.equal(result.configs[4].parts[0].name,'【+100元升级64GB内存】');
 checks.push('同描述跨链接分组','不同原文/新文案/字段分离','组选择半选状态','链接筛选下组选择范围','组保存只改所选升级文案','窄窗口真实渲染');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 const report={passed:true,fixture:'真实React输出源维护/待确认窗口；Node内存后端应用真实source-sync领域计划',productionAccess:false,checks,errors,blocked,
 singleLinkDetails:true,defaultNoFields:true,crossLinkSelectionPreserved:true,selectedFieldsOnly:true,confirmedFieldsFollow:true,ignoredVersionHidden:true,taxBlocksIgnore:true,staleConfigRejected:true,staleSourceRejected:true,actualPartsAndAddonsPreserved:true,categoryCountsAndOrder:true,categoryFiltersLinks:true,crossCategorySelectionPreserved:true,selectAllOnlyVisibleCategory:true,clearIncludesHiddenSelections:true,categoryApplyOnlySelected:true,sameDescriptionGroupedAcrossLinks:true,differentBeforeAfterAndFieldSeparated:true,groupSelectionIndeterminate:true,groupSelectionRespectsLinkFilter:true,groupApplyOnlySelected:true};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,errors,blocked,checks},null,2));throw error;}
finally{await browser.close();}
