/** 正式页面与 CSP 下的工作表操作。只连接隔离 PGlite，并用合成 ERP 商品。 */
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 NAS fixture 目录');
const origin=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const root=await mkdtemp(join(tmpdir(),'diy-source-sheet-'));
const api=await startSourceAcceptance({fixture:resolve(fixture),root,
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
// 三组隔离样例分别覆盖缺共用价、缺共用名称和只有基础信息独享。
await api.db.exec(`
 UPDATE workbench_sources.entries SET fields=(fields-'tax')||'{"hardwareOverrides.gpuName":"LongGPUModelName1234567890LongGPUModelName1234567890LongGPUModelName1234567890"}'::jsonb WHERE id='9900011';
 UPDATE workbench_sources.aliases SET fields=CASE shop_id
  WHEN 'intel' THEN '{"tax":1400}'::jsonb WHEN 'jonsbo' THEN '{"tax":1398}'::jsonb ELSE '{}'::jsonb END
 WHERE entry_id='9900011';
 UPDATE workbench_sources.entries SET fields=fields-'name' WHERE id='100001';
 UPDATE workbench_sources.aliases SET fields=CASE WHEN shop_id='intel' THEN '{"name":"英特尔独享 CPU"}'::jsonb ELSE '{}'::jsonb END
 WHERE entry_id='100001';
 UPDATE workbench_sources.entries SET fields=fields||'{"hardwareOverrides.color":"黑"}'::jsonb WHERE id='9900012';
 UPDATE workbench_sources.aliases SET fields=CASE WHEN shop_id='intel' THEN '{"hardwareOverrides.color":"白"}'::jsonb ELSE '{}'::jsonb END
 WHERE entry_id='9900012';
 UPDATE workbench_sources.entries SET fields=jsonb_set(fields,'{addon,addonChoices}',
  (fields#>'{addon,addonChoices}')||'[{"id":"fixture-disabled-part","goodsId":"9900013","label":"未展示的缺货升级","enabled":false,"qty":1,"originalQty":1,"priceCents":100}]'::jsonb)
 WHERE id='9900012';
`);
// 一条缺货且未展示的选项，与已有的现货加购和纯文案共用同一行。
for(const shop of ['intel','gigabyte','jonsbo'])await api.db.exec(
 `UPDATE ${shop}_live.costs SET attrs=attrs||'{"erpName":"停产 验收内存（长规格）","stockAvailable":0,"stockIncomingAvailable":8}' WHERE goodsid='9900013'`);
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],verified=[];
const product={goodsId:'9900931',name:'缺货 WD 合成 NVMe SSD (2TB)',erp:458,stockAvailable:0,stockIncomingAvailable:4,sku:'SYNTHETIC-SSD'};
const excluded={goodsId:'9900932',name:'排除商品 NVMe *!',erp:414,stockAvailable:9};
const single={goodsId:'9900933',name:'仅本店合成 SSD',erp:153,stockAvailable:6};
const headers={'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'};
async function settings(page,{singleShop=false}={}){
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
 page.on('dialog',dialog=>dialog.accept());
 page.setDefaultTimeout(14000);
 await page.exposeFunction('sheetFixtureInvoke',async(command,args)=>{
  const result=(data,status=200)=>({status,body:JSON.stringify(data)});
  if(command==='nas_identity_request')return result({session:{configured:true,authenticated:true,
   member:{uid:fixtureActor,workspaceId:fixtureWorkspace}}});
  if(command==='nas_native_request'&&args.route==='/settings')return result({
   configured:true,main_editor:true,endpoint_id:'isolated-source-sheet',deployment_id:fixtureDeployment,acceptance:true});
  if(command==='nas_native_request'){
   const res=await fetch(api.url+args.route,{method:args.method,headers,body:args.body??undefined});
   return {status:res.status,body:await res.text()};
  }
  if(command==='nas_erp_read'){
   const rows=singleShop?[single]:[product,excluded];
   if(args.kind==='erp-catalog')return result({ok:true,total:rows.length,complete:true,rows});
   if(args.kind==='tax-current')return result({ok:true,rows:[{goods_id:product.goodsId,tax:488.13},{goods_id:single.goodsId,tax:183.24}]});
   return result({ok:true,rows:[]});
  }
  return 1;
 });
 await page.addInitScript(()=>{
  window.isTauri=true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:()=>location.origin,
   invoke:(command,args)=>window.sheetFixtureInvoke(command,args)};
 });
 await page.goto(origin);
 const frame=page.frameLocator('.legacy-workbench-frame');
 await frame.locator('#shop-picker').evaluate(async()=>{while(!window.workbenchReady)await new Promise(resolve=>setTimeout(resolve,30));});
 return frame;
}
async function openSheet(frame){
 await frame.getByRole('button',{name:'维护',exact:true}).click();
 await frame.getByRole('button',{name:'输出源维护',exact:true}).click();
 const sheet=frame.locator('#source-sheet-page');
 await sheet.waitFor();
 return sheet;
}
const button=(node,name)=>node.locator('[data-sheet-action="'+name+'"]');
const row=(node,id)=>node.locator('[data-sheet-row="'+id+'"]');
const card=(node,shop)=>node.locator('[data-sheet-action="store-override"][data-scope="'+shop+'"]');
const quick=(node,id)=>node.locator('[data-sheet-action="filter"][data-filter="'+id+'"]');
const count=(node,id)=>quick(node,id).locator('small').innerText();
async function checkAddonTags(sheet,dark,scopeCount){
 const upgrades=row(sheet,'9900012').locator('.ss-upgrades');
 assert.equal(await upgrades.count(),scopeCount);
 assert.equal(await sheet.locator('.ss-grid').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'小窗口下整表不横向溢出');
 for(const cell of await upgrades.all()){
  const note=cell.locator('.ss-addon.is-note'),part=cell.locator('.ss-addon.is-part:not(.is-alert)'),alert=cell.locator('.ss-addon.is-part.is-alert');
  assert.equal(await note.locator('.is-note').textContent(),'仅文案');
  assert.equal(await note.locator('.ss-addon-copy').textContent(),'可咨询客服升级');
  assert.equal(await note.locator('.ss-addon-tag').evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
  assert.equal(await part.locator('.ss-addon-tag').textContent(),'配件');
  assert.equal(await part.locator('.ss-addon-erp').textContent(),'测试 CPU');
  assert.equal(await part.locator('.ss-addon-meta').textContent(),'¥12 · 现货 20 · #100001');
  assert.equal(await part.locator('.ss-addon-copy').textContent(),'【+99元升级测试配件】');
  assert.equal(await part.evaluate(el=>getComputedStyle(el).backgroundColor),dark?'rgb(32, 42, 54)':'rgb(244, 248, 253)');
  assert.deepEqual(await alert.locator('.ss-addon-tag').allTextContents(),['缺货','不展示']);
  assert.equal(await alert.locator('.ss-addon-erp').textContent(),'验收内存');
  assert.equal(await alert.getAttribute('title'),'ERP ID 9900013 · 停产 验收内存（长规格）');
  assert.equal(await alert.locator('.ss-addon-meta').textContent(),'¥314.25 · 停产 · 待入 8 · #9900013');
  assert.equal(await alert.locator('.ss-addon-copy').textContent(),'【+1元未展示的缺货升级】');
  assert.match(await alert.locator('.ss-addon-copy').evaluate(el=>getComputedStyle(el).textDecorationLine),/line-through/);
  const layout=await cell.evaluate(el=>{
   const td=el.closest('td'),box=td.getBoundingClientRect(),range=document.createRange();
   range.selectNodeContents(el);
   return {
    cellOverflow:Math.max(0,td.scrollWidth-td.clientWidth-1),
    buttonOverflow:Math.max(0,el.scrollWidth-el.clientWidth-1),
    textOutside:[...range.getClientRects()].filter(r=>r.width>0&&(r.left<box.left-1||r.right>box.right+1)).map(r=>[r.left-box.left,r.right-box.right]),
    overlap:[...el.querySelectorAll('.ss-addon-head')].filter(head=>head.getBoundingClientRect().bottom>head.nextElementSibling.getBoundingClientRect().top+1).length,
   };
  });
  assert.deepEqual(layout,{cellOverflow:0,buttonOverflow:0,textOutside:[],overlap:0},'行情与海报文案分行且都在本列内');
 }
}
const readSource=async(id,shop='intel')=>{
 const response=await fetch(api.url+'/api/v1/operations/catalog/shared-sources/'+id+'?shop_id='+shop,{headers});
 assert.equal(response.status,200);
 return (await response.json()).data.document;
};
try{
 const page=await browser.newPage({viewport:{width:1540,height:940}});
 const frame=await settings(page);
 const sheet=await openSheet(frame),filter=sheet.getByRole('searchbox',{name:'筛选已有输出源'});
 assert.equal(await sheet.locator('table').getAttribute('data-view'),'common');
 assert.equal(await sheet.locator('thead th').count(),6);
 assert.equal(await sheet.locator('[data-category]').count()>13,true);
 assert.equal(await frame.locator('.workspace > .sidebar').isVisible(),false);
 assert.equal(await frame.locator('.reui-rail').isVisible(),true);
 assert.equal(await sheet.locator('[onclick]').count(),0);
 await sheet.locator('[data-category="显卡"]').first().click();
 assert.equal(await sheet.locator('[data-category="显卡"]').first().getAttribute('aria-pressed'),'true');
 assert.deepEqual(await sheet.locator('[data-sheet-filters] small').allTextContents(),['1','1','0','0','1','0','0','0','0']);
 await sheet.locator('[data-category="全部配件"]').click();
 await filter.fill('9900011');
 const target=row(sheet,'9900011');
 await target.waitFor();
 assert.equal(await sheet.locator('tr[data-sheet-row]').count(),1);
 const title=target.getByRole('textbox',{name:'三店共用展示名称'});
 const drawer=sheet.getByRole('complementary',{name:'编辑输出源'}),pane=drawer.locator('.ss-drawer-pane:visible');
 const original=await title.inputValue();
 assert.equal(await target.getByRole('textbox',{name:'核算价'}).inputValue(),'');
 assert.equal(await button(target,'restore-all').isDisabled(),true,'欠缺共用核算价时应明确阻止恢复');
 assert.match(await target.innerText(),/先填写共用核算价/);
 assert.match(await target.locator('.ss-override-card[data-scope="intel"] span').getAttribute('title'),/¥1400/);
 assert.match(await target.locator('.ss-override-card[data-scope="jonsbo"]').innerText(),/¥1398/);
 await card(target,'intel').click();
 assert.equal(await pane.locator('[data-sheet-drawer-tax]').innerText(),'¥1400');
 assert.equal(await button(pane,'drawer-restore-tax').isDisabled(),true);
 await button(pane,'drawer-promote-tax').click();
 await button(drawer,'apply-drawer').click();
 assert.equal(await target.getByRole('textbox',{name:'核算价'}).inputValue(),'1400');
 await target.getByText('三店一致',{exact:true}).waitFor();
 await button(target,'reset-row').click();
 assert.equal(await target.getByRole('textbox',{name:'核算价'}).inputValue(),'');

 // 鼠标点同一行的旧差异卡片后，失焦刷新也不会吞掉打开抽屉的点击。
 const tax=target.getByRole('textbox',{name:'核算价'});
 const price=id=>sheet.locator('[data-price-filter="'+id+'"]');
 const priceCounts=()=>sheet.locator('[data-price-filter] small').allTextContents();
 assert.deepEqual(await priceCounts(),['1','0','0']);
 await tax.fill('215.50');await tax.press('Enter');
 assert.equal(await target.locator('.ss-tax.is-low small').innerText(),'↓ 低于 -¥2.50');
 await price('low').click();await quick(sheet,'tax-low').click();
 assert.deepEqual(await priceCounts(),['1','0','1']);
 assert.equal(await target.count(),1);
 // 仍在同一行编辑；改价后立即退出低价交集，两个筛选独立保留。
 await tax.fill('219');await tax.press('Enter');
 assert.equal(await target.count(),0);
 await price('all').click();await quick(sheet,'tax-high').click();await price('high').click();
 assert.equal(await target.locator('.ss-tax.is-high small').innerText(),'↑ 高于 +¥1');
 assert.deepEqual(await priceCounts(),['1','1','0']);
 await quick(sheet,'active').click();await price('all').click();
 const rowNode=await target.elementHandle();
 await tax.fill('218');await tax.press('Enter');
 assert.equal(await target.locator('.ss-tax.is-equal small').innerText(),'= 持平');
 assert.equal(await rowNode.evaluate(el=>el.isConnected),true);
 await button(target,'reset-row').click();
 await tax.fill('1400');
 await card(target,'intel').click();
 await drawer.getByRole('heading',{name:'升级项与单店覆盖'}).waitFor();
 await button(drawer,'close-drawer').click();
 assert.equal(await target.locator('.ss-override-card').count(),2);
 assert.doesNotMatch(await target.innerText(),/先填写共用核算价/);
 await button(target,'restore-all').click();
 await target.getByText('三店一致',{exact:true}).waitFor();
 assert.equal(await rowNode.evaluate(element=>element.isConnected),true);
 assert.equal(await button(target,'restore-all').count(),0);
 assert.doesNotMatch(await target.innerText(),/先填写共用核算价/);
 assert.deepEqual(await sheet.locator('[data-sheet-filters] small').allTextContents(),['1','0','0','0','0','1','0','1','0']);
 await button(target,'reset-row').click();
 await button(sheet,'stores').click();
 assert.equal(await target.locator('.ss-store-cell.is-override').count(),2);
 await tax.fill('1400');await tax.press('Enter');
 assert.equal(await target.locator('.ss-store-cell.is-override').count(),2);
 assert.equal(await target.locator('.ss-override-tag').count(),2);
 const intelCell=target.locator('.ss-store-cell').first();
 assert.equal(await intelCell.locator('.ss-name-scopes').isVisible(),false);
 assert.equal(await intelCell.locator('.ss-tax-chip').innerText(),'¥1400 (+¥1182)');
 await intelCell.locator('.ss-tax-chip').click();
 assert.equal(await pane.locator('[data-sheet-drawer-tax]').innerText(),'¥1400');
 await button(drawer,'close-drawer').click();
 await intelCell.locator('textarea').focus();
 assert.equal(await intelCell.locator('.ss-name-scopes').isVisible(),true);
 assert.equal(await intelCell.locator('.ss-ov-head').isVisible(),false);
 await tax.focus();
 await button(intelCell,'restore-store').click();
 assert.deepEqual(await sheet.locator('[data-store-count]').allTextContents(),['全部共用','全部共用','独享 1']);
 await button(target,'restore-all').click();
 assert.equal(await target.locator('.ss-store-cell.is-override').count(),0);
 assert.deepEqual(await sheet.locator('[data-store-count]').allTextContents(),['全部共用','全部共用','全部共用']);
 await button(target,'reset-row').click();
 const storeRestore=button(intelCell,'restore-store');
 assert.equal(await storeRestore.isDisabled(),true);
 assert.match(await storeRestore.getAttribute('title'),/先填写共用核算价/);
 await tax.fill('217.99');
 assert.equal(await storeRestore.isEnabled(),true);
 await storeRestore.click();
 assert.equal(await target.locator('.ss-tax.is-low small').innerText(),'↓ 低于 -¥0.01');
 assert.deepEqual(await sheet.locator('[data-store-count]').allTextContents(),['全部共用','全部共用','独享 1']);
 assert.deepEqual(await button(target,'restore-name').allTextContents(),['恢复共用名','恢复共用名','恢复共用名']);
 await button(target,'reset-row').click();
 await button(sheet,'common').click();

 await quick(sheet,'different').click();
 await tax.fill('abc');
 assert.equal(await button(target,'restore-all').isDisabled(),true);
 await tax.fill('1400');
 assert.equal(await button(target,'restore-all').isEnabled(),true);
 assert.equal(await tax.evaluate(el=>el===document.activeElement),true);
 assert.match(await card(target,'jonsbo').innerText(),/¥1398/);
 await button(target,'restore-all').click();
 await target.waitFor({state:'detached'});
 assert.equal(await count(sheet,'different'),'0');
 await quick(sheet,'pending').click();
 await button(target,'reset-row').click();
 await target.waitFor({state:'detached'});
 assert.equal(await count(sheet,'pending'),'0');
 await quick(sheet,'active').click();
 await target.waitFor();
 verified.push('独享核算价预览及提升，失焦和回车单行更新，筛选计数同步');

 await filter.fill('');
 const cpu=row(sheet,'100001'),cpuName=cpu.getByRole('textbox',{name:'三店共用展示名称'});
 await card(cpu,'intel').click();
 assert.equal(await button(pane,'drawer-restore-name').isDisabled(),true);
 assert.match(await pane.locator('[data-restore-hint]').innerText(),/先填写共用显示名称/);
 assert.equal(await pane.locator('[data-sheet-drawer-name]').inputValue(),'英特尔独享 CPU');
 await button(pane,'drawer-promote-name').click();
 await drawer.locator('[data-sheet-action="close-drawer"]').click();
 const resume=button(sheet,'resume-drawer');
 await resume.waitFor();
 assert.match(await resume.getAttribute('title'),/100001/);
 await button(target,'details').click();
 assert.equal(await drawer.isVisible(),false);
 await resume.click();
 await button(drawer,'apply-drawer').click();
 assert.equal(await cpuName.inputValue(),'英特尔独享 CPU');
 await cpu.getByText('三店一致',{exact:true}).waitFor();
 const otherBeforeReset=await target.elementHandle();
 await button(cpu,'reset-row').click();
 assert.equal(await otherBeforeReset.evaluate(element=>element.isConnected),true);
 await cpuName.fill('三店 CPU 共用名称');await cpuName.press('Enter');
 await card(cpu,'intel').click();
 assert.equal(await button(pane,'drawer-restore-name').isEnabled(),true);
 await button(pane,'drawer-restore-name').click();
 assert.equal(await pane.locator('[data-sheet-drawer-name]').inputValue(),'三店 CPU 共用名称');
 assert.match(await pane.locator('[data-restore-hint]').innerText(),/待恢复共用/);
 await button(drawer,'apply-drawer').click();
 await cpu.getByText('三店一致',{exact:true}).waitFor();
 await button(cpu,'reset-row').click();
 verified.push('空共用名保护独享名称，草稿共用名称可恢复，关闭抽屉后显式返回');

 const details=row(sheet,'9900012');
 assert.match(await card(details,'intel').innerText(),/配件颜色 白/);
 await card(details,'intel').click();
 await drawer.getByRole('heading',{name:'基础信息'}).waitFor();
 await drawer.getByRole('tab',{name:/英特尔/}).waitFor();
 assert.equal(await drawer.getByRole('tab',{name:/英特尔/}).getAttribute('aria-selected'),'true');
 assert.equal(await pane.locator('#source-hardware-color').inputValue(),'白');
 await button(pane,'drawer-restore-details').click();
 assert.equal(await pane.locator('#source-hardware-color').inputValue(),'黑');
 await button(drawer,'apply-drawer').click();
 await details.getByText('三店一致',{exact:true}).waitFor();
 await button(sheet,'save').click();
 await sheet.locator('[data-sheet-message]').getByText(/已保存 1 条/).waitFor();
 assert.equal(Object.hasOwn((await readSource('9900012')).stores.intel[0].fields,'hardwareOverrides.color'),false);
 verified.push('只有基础信息独享时打开该店的基础信息，恢复并回读');

 // 新增草稿行还原时只移除自己和空分类标题。
 await button(sheet,'special').click();
 await sheet.locator('button[data-sheet-action="category"][data-category="全部配件"]').click();
 const newSpecial=sheet.locator('tr[data-sheet-row].is-marked.is-pending');
 const remaining=await target.elementHandle();
 await button(newSpecial,'reset-row').click();
 assert.equal(await remaining.evaluate(el=>el.isConnected),true);
 assert.equal(await newSpecial.count(),0);
 assert.equal(await sheet.locator('[data-sheet-group="特殊配件"]').count(),0);
 assert.equal(await count(sheet,'pending'),'0');

 await filter.fill('9900011');
 await title.fill('按 Escape 取消');await title.press('Escape');assert.equal(await title.inputValue(),original);
 await title.fill('合成工作表共用显卡');await title.press('Enter');
 await tax.fill('252.5');await tax.press('Enter');
 assert.match(await sheet.locator('[data-sheet-pending]').innerText(),/1 条待保存/);
 await button(sheet,'back').click();assert.equal(await sheet.isVisible(),true);
 assert.match(await sheet.locator('[data-sheet-message]').innerText(),/保存全部/);
 await sheet.locator('#source-sheet-shop').selectOption('gigabyte');
 assert.equal(await sheet.locator('#source-sheet-shop').inputValue(),'intel');
 const quit=await sheet.evaluate(()=>window.workbenchBeforeQuit().then(()=>null,error=>error.message));
 assert.match(quit,/工作表的未保存/);
 await frame.locator('#price-profit-open').evaluate(element=>element.click());
 assert.equal(await frame.locator('#price-profit-page').isVisible(),false);
 await button(sheet,'audit').click();
 await frame.locator('.addon-audit').waitFor();
 await frame.getByRole('button',{name:'返回输出源维护'}).click();
 assert.match(await sheet.locator('[data-sheet-pending]').innerText(),/1 条待保存/);
 await button(sheet,'differences').click();
 await frame.locator('#dialog [data-review-pane="pending"]').waitFor();
 await frame.locator('#dialog .dialog-title button').click();
 assert.equal(await title.inputValue(),'合成工作表共用显卡');
 verified.push('全屏、分类、行内编辑、未保存拦截、子弹窗保留草稿');

 await button(target,'addons').click();
 await drawer.getByRole('tab',{name:/技嘉/}).click();
 await pane.locator('[data-sheet-drawer-name]').fill('技嘉合成独享展示');
 await drawer.getByRole('tab',{name:'三店共用',exact:true}).click();
 await pane.locator('[data-choice-add]').click();
 const choice=pane.locator('[data-choice]').last(),lookup=choice.locator('[data-product-query]');
 await lookup.fill('100001');
 await lookup.press('Enter');
 await choice.locator('[data-product-picked]').getByText(/100001/).waitFor();
 await choice.locator('[data-product-reselect]').click();
 await lookup.fill('9900012');
 await lookup.press('Escape');
 await choice.locator('[data-product-picked]').getByText(/100001/).waitFor();
 await choice.locator('[data-choice-price]').fill('88');
 await choice.locator('[data-choice-label]').fill('合成升级文案 VeryLongUpgradeModelNumber1234567890VeryLongUpgradeModelNumber1234567890');
 await drawer.getByRole('tab',{name:/技嘉/}).click();
 assert.equal(await pane.locator('[data-sheet-drawer-name]').inputValue(),'技嘉合成独享展示');
 await button(drawer,'apply-drawer').click();await drawer.waitFor({state:'hidden'});
 await button(sheet,'stores').click();
 assert.equal(await sheet.locator('thead th').count(),6);
 assert.equal(await target.getByRole('textbox',{name:'技嘉展示名称'}).inputValue(),'技嘉合成独享展示');
 await button(sheet,'common').click();
 await button(sheet,'save').click();
 await sheet.locator('[data-sheet-message]').getByText(/已保存 1 条/).waitFor();
 const saved=await readSource('9900011');
 assert.equal(saved.common.tax,252.5);
 assert.equal(saved.stores.intel[0].fields.tax,1400);
 assert.equal(saved.stores.jonsbo[0].fields.tax,1398);
 assert.equal(saved.common.name,'合成工作表共用显卡');
 assert.equal(saved.stores.gigabyte[0].fields.name,'技嘉合成独享展示');
 assert.equal(saved.common.addon.addonChoices.at(-1).goodsId,'100001');
 // 用真实多行升级文案及连续型号检查按钮、文本行和单元格边界。
 for(const size of [{width:1180,height:760},{width:1280,height:720}]){
  await page.setViewportSize(size);
  for(const selector of ['.ss-upgrades','[data-sheet-action="details"]']){
   const bounds=await target.locator(selector).evaluate(button=>{
    const cell=button.closest('td'),box=cell.getBoundingClientRect();
    const range=document.createRange();range.selectNodeContents(button);
    const lines=[...range.getClientRects()].filter(rect=>rect.width);
    return {fits:button.scrollWidth<=button.clientWidth+1&&cell.scrollWidth<=cell.clientWidth+1,
     wrapped:new Set(lines.map(rect=>Math.round(rect.top))).size>1,
     inside:lines.every(rect=>rect.left>=box.left-1&&rect.right<=box.right+1)};
   });
   assert.deepEqual(bounds,{fits:true,wrapped:true,inside:true},selector+' @ '+size.width);
  }
  assert.equal(await sheet.locator('.ss-grid').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
 }
 await page.setViewportSize({width:1540,height:940});
 await filter.fill('');
 await sheet.locator('button[data-sheet-action="category"][data-category="全部配件"]').click();
 const otherRow=await row(sheet,'100001').elementHandle();
 await button(target,'restore-all').click();
 assert.equal(await otherRow.evaluate(element=>element.isConnected),true,'恢复一行时其余行应留在表格中');
 await sheet.locator('[data-sheet-message]').getByText(/已加入恢复共用草稿/).waitFor();
 assert.equal((await readSource('9900011')).stores.gigabyte[0].fields.name,'技嘉合成独享展示');
 await button(sheet,'save').click();
 await sheet.locator('[data-sheet-message]').getByText(/已保存 1 条/).waitFor();
 const unified=await readSource('9900011');
 assert.equal(Object.hasOwn(unified.stores.gigabyte[0].fields,'name'),false);
 assert.equal(unified.common.tax,252.5);
 for(const shop of ['intel','gigabyte','jonsbo'])assert.ok(unified.stores[shop].every(alias=>!Object.hasOwn(alias.fields,'tax')));
 verified.push('缺失共用价明确提示，有效恢复仅更新本行并在保存后生效');
 verified.push('抽屉各范围草稿、目标搜索、三店并排、实际共用保存');

 const erp=sheet.getByRole('combobox',{name:'ERP 搜索配件'});
 await erp.fill('9900011');await erp.press('Enter');
 assert.equal(await target.evaluate(el=>el.classList.contains('is-marked')),true);
 await erp.fill('NVMe');
 const candidate=sheet.getByRole('option').filter({hasText:product.goodsId});
 await candidate.waitFor();
 assert.equal(await sheet.getByRole('option').filter({hasText:excluded.goodsId}).count(),0);
 await candidate.click();
 const added=row(sheet,product.goodsId);await added.waitFor();
 await added.getByText('新增 · 待保存').waitFor();
 assert.equal(await added.getByRole('textbox',{name:'核算价'}).inputValue(),'488.13');
 assert.equal(await added.getByRole('textbox',{name:'三店共用展示名称'}).inputValue(),'WD 合成 NVMe SSD');
 assert.match(await added.innerText(),/ERP ¥458\.00.*缺货.*待入 4/);
 await button(sheet,'save').click();
 await sheet.locator('[data-sheet-message]').getByText(/已保存 1 条/).waitFor();
 const created=await readSource(product.goodsId);
 assert.deepEqual(Object.keys(created.stores).sort(),['gigabyte','intel','jonsbo']);
 assert.equal(created.common.tax,488.13);
 await button(sheet,'details').first().click();
 await drawer.getByRole('heading',{name:'基础信息'}).waitFor();
 assert.equal(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth+2),true);
 await page.keyboard.press('Escape');
 await drawer.waitFor({state:'hidden'});
 await sheet.locator('[data-category="全部配件"]').click();
 const theme=frame.locator('#workbench-theme-toggle');
 await page.setViewportSize({width:1180,height:760});
 await checkAddonTags(sheet,false,1);
 await button(sheet,'stores').click();
 await checkAddonTags(sheet,false,3);
 await button(sheet,'common').click();
 await theme.click();
 await checkAddonTags(sheet,true,1);
 assert.equal(await sheet.evaluate(el=>getComputedStyle(el).colorScheme),'dark');
 assert.equal(await sheet.evaluate(el=>getComputedStyle(el).getPropertyValue('--ss-focus').trim()),'#fffa00');
 assert.equal(await sheet.locator('th[scope="col"]').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(42, 44, 50)');
 const darkCard=card(cpu,'intel');
 assert.match(await darkCard.evaluate(el=>getComputedStyle(el).backgroundImage),/linear-gradient/);
 assert.equal(await darkCard.evaluate(el=>getComputedStyle(el).borderLeftWidth),'3px');
 assert.equal(await darkCard.locator('strong').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 250, 0)');
 assert.equal(await darkCard.locator('span').evaluate(el=>getComputedStyle(el).webkitLineClamp),'2');
 await button(sheet,'stores').click();
 const storeCell=cpu.locator('.ss-store-cell.is-override');
 await checkAddonTags(sheet,true,3);
 assert.equal(await storeCell.evaluate(el=>getComputedStyle(el).borderLeftWidth),'3px');
 assert.equal(await storeCell.locator('.ss-override-tag').evaluate(el=>getComputedStyle(el).color),'rgb(20, 21, 23)');
 await button(sheet,'common').click();
 await page.setViewportSize({width:1540,height:940});
 assert.equal(await sheet.locator('#source-sheet-erp').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(44, 45, 50)');
 assert.equal(await sheet.locator('#source-sheet-title').evaluate(el=>getComputedStyle(el).color),'rgb(236, 238, 241)');
 assert.equal(await button(sheet,'common').evaluate(el=>getComputedStyle(el).color),'rgb(255, 250, 0)');
 if(process.env.SOURCE_SHEET_CAPTURE)await page.screenshot({path:join(process.env.SOURCE_SHEET_CAPTURE,'source-sheet-dark.png')});
 await theme.click();
 assert.notEqual(await sheet.evaluate(el=>getComputedStyle(el).colorScheme),'dark');
 if(process.env.SOURCE_SHEET_CAPTURE)await page.screenshot({path:join(process.env.SOURCE_SHEET_CAPTURE,'source-sheet-light.png')});
 verified.push('ERP 定位、星号筛除、三店新品、基础信息及深浅色');
 const newName=added.getByRole('textbox',{name:'三店共用展示名称'});
 await newName.fill('并发期间保留这条草稿');await newName.press('Enter');
 await api.db.exec("UPDATE workbench_sources.entries SET version=version+1 WHERE id='9900931'");
 await button(sheet,'save').click();
 await sheet.locator('[data-sheet-message]').getByText(/保存未完成，草稿已保留/).waitFor();
 assert.equal(await newName.inputValue(),'并发期间保留这条草稿');
 assert.equal((await readSource(product.goodsId)).common.name,'WD 合成 NVMe SSD');
 await button(sheet,'discard').click();
 await button(sheet,'back').click();
 assert.equal(await sheet.isVisible(),false);
 const configuration=frame.locator('[data-id="fixture-overlap"]');
 if(!await configuration.isVisible())await frame.locator('[data-product-toggle="fixture-link"] .link-arrow').click();
 await configuration.click();
 await frame.locator('#continuous-workbench .ov-edit-source').first().click();
 await frame.locator('#dialog.source-quick-dialog').waitFor();
 assert.equal(await frame.locator('#dialog-title').innerText(),'修改输出源');
 assert.equal(await sheet.isVisible(),false);
 verified.push('冲突保留草稿，配置总表入口保持快捷弹窗');
 await page.close();

 // 删除的只是合成库中另两店的测试授权。以 HTTP 与实际库回读核对单店建源。
 await api.db.exec("DELETE FROM nas_business.operation_group_shops WHERE group_code='dou-intel-operations' AND shop_id<>'intel'");
 const member=await (await fetch(api.url+'/api/v1/me',{headers})).json();
 assert.deepEqual(member.shops.map(role=>role.shop_id),['intel']);
 const onePage=await browser.newPage({viewport:{width:1300,height:820}});
 const oneFrame=await settings(onePage,{singleShop:true}),oneSheet=await openSheet(oneFrame);
 assert.equal(await oneSheet.locator('#source-sheet-shop option').count(),1);
 await button(oneSheet,'stores').click();
 assert.equal(await oneSheet.locator('thead th').count(),4);
 const oneSearch=oneSheet.getByRole('combobox',{name:'ERP 搜索配件'});
 await oneSearch.fill(single.goodsId);
 await oneSheet.getByRole('option').filter({hasText:single.goodsId}).click();
 await row(oneSheet,single.goodsId).waitFor();
 assert.equal(await button(oneSheet,'save').isDisabled(),true);
 const counts=await api.db.query("SELECT (SELECT count(*)::int FROM intel_live.sources WHERE goodsid='9900933') AS intel,(SELECT count(*)::int FROM gigabyte_live.sources WHERE goodsid='9900933') AS gigabyte,(SELECT count(*)::int FROM jonsbo_live.sources WHERE goodsid='9900933') AS jonsbo");
 assert.deepEqual(counts.rows[0],{intel:1,gigabyte:0,jonsbo:0});
 verified.push('单店权限只展本店，adopt_erp 仅建到当前店');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',verified,root}));
}finally{await browser.close();await api.close();}
