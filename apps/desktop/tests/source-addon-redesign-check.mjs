/** 在实际抽屉中检查方案顺序、实时海报、独立滚动和快捷定价，最后还原原始草稿。 */
import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function verifyAddonChoices({page,drawer,pane}){
 const rows=pane.locator('[data-choice]'),preview=drawer.locator('[data-addon-merged]:visible');
 const source=rows.last(),originalId=await source.getAttribute('data-choice');
 const originalCount=await rows.count(),originalText=await preview.locator('[data-choice-preview]').innerText();
 const originalLabel=await source.locator('[data-choice-label]').inputValue();
 const viewport=page.viewportSize();
 await page.setViewportSize({width:1360,height:900});
 await source.locator('[data-choice-duplicate]').click();
 const copyId=await rows.last().getAttribute('data-choice');
 assert.notEqual(copyId,originalId);
 const copy=pane.locator(`[data-choice="${copyId}"]`),sourceCard=pane.locator(`[data-choice="${originalId}"]`);
 await copy.locator('[data-choice-label]').fill('排序预览样例');
 await copy.locator('[data-choice-up]').click();
 assert.equal(await rows.last().getAttribute('data-choice'),originalId);
 assert.ok((await preview.locator('[data-choice-preview]').innerText()).indexOf('排序预览样例')<(await preview.locator('[data-choice-preview]').innerText()).indexOf(originalLabel));
 await copy.locator('[data-choice-down]').click();
 assert.equal(await rows.last().getAttribute('data-choice'),copyId);
 await copy.locator('[data-choice-enabled]').uncheck();
 assert.equal(await preview.locator('[data-choice-preview]').innerText(),originalText);
 await copy.locator('[data-choice-enabled]').check();
 // 加大替换目标数量制造 ERP 负差价；快捷价应使用两个数量的总额。
 await copy.locator('[data-choice-qty]').fill('90000');
 await copy.locator('[data-choice-price]').fill('0');
 const erpMargin=copy.locator('[data-choice-check] .ac-margin').last();
 assert.match(await erpMargin.innerText(),/负差价/);
 assert.match(await pane.locator('[data-choice-risks]').innerText(),/负差价/);
 const chip=copy.locator('[data-quick-price]').nth(1);
 const suggestion=await chip.getAttribute('data-quick-price');
 await chip.click();
 assert.equal(await copy.locator('[data-choice-price]').inputValue(),suggestion);
 assert.match(await erpMargin.innerText(),/正差价/);
 await copy.locator('[data-choice-qty]').fill('1');
 await copy.locator('[data-choice-toggle]').click();
 assert.equal(await copy.locator('.ac-summary').isVisible(),true);
 await copy.locator('.ac-summary').click();
 await pane.locator('[data-choice-collapse-all]').click();
 assert.equal(await pane.locator('.ac-body:visible').count(),0);
 await pane.locator('[data-choice-collapse-all]').click();
 assert.equal(await pane.locator('.ac-body:visible').count(),originalCount+1);
 const y=await preview.evaluate(el=>el.getBoundingClientRect().y);
 const scrolled=await drawer.locator('.ss-drawer-content').evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollTop;});
 assert.ok(scrolled>0);
 assert.ok(Math.abs(await preview.evaluate(el=>el.getBoundingClientRect().y)-y)<1);
 await drawer.locator('.ss-drawer-content').evaluate(el=>{el.scrollTop=0;});
 if(process.env.SOURCE_SHEET_REDESIGN_CAPTURE){
  // 截图使用简短文案和实际可读的金额，随后恢复验收的超长名称。
  await copy.locator('[data-choice-price]').fill('99');
  await copy.locator('[data-choice-label]').fill('备选升级方案');
  await sourceCard.locator('[data-choice-label]').fill('升级测试 CPU');
  await copy.locator('[data-choice-toggle]').click();
  await drawer.locator('.ss-drawer-content').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:join(process.env.SOURCE_SHEET_REDESIGN_CAPTURE,'drawer.png')});
  await sourceCard.locator('[data-choice-label]').fill(originalLabel);
 }
 await copy.locator('[data-choice-remove]').click();
 assert.equal(await rows.count(),originalCount);
 assert.equal(await preview.locator('[data-choice-preview]').innerText(),originalText);
 // 历史完整文案保留全角加号与原有空格；仅替换金额，且不丢数量和身份。
 const historical=await pane.evaluate(async()=>{
  const {mountAddonChoices}=await import('/workbench/addon-choices-ui.js');
  const fixture=document.createElement('div');
  const editor=mountAddonChoices(fixture,{initial:[{id:'legacy',goodsId:'2',qty:2,originalQty:1,priceCents:4999,customText:true,label:'【＋49.99 元 升级内存】',enabled:true}],sourceId:'source',getOriginals:()=>[{sourceId:'source',erp:50,tax:45}],getCosts:()=>[{goodsId:'2',name:'测试内存',erp:60,tax:55,stockAvailable:0,stockIncomingAvailable:8}]});
  const hasRisks=fixture.querySelector('[data-choice-risks]').textContent;
  fixture.querySelector('[data-quick-price]').click();
  return {hasRisks,row:editor.read()[0],preview:fixture.querySelector('[data-choice-preview]').textContent};
 });
 assert.match(historical.hasRisks,/含 1 项缺货/);
 assert.match(historical.hasRisks,/含 1 项负差价/);
 assert.equal(historical.row.priceCents,7000);
 assert.equal(historical.row.label,'【＋70 元 升级内存】');
 assert.equal(historical.preview,historical.row.label);
 // 一个历史方案可能含多个商品。只查看或修改备注仍沿用原始组合和海报文案。
 const legacy=await pane.evaluate(async()=>{
  const {mountSharedAddons}=await import('/workbench/shared-source-editor.js');
  const host=document.createElement('div'),row={sourceId:'legacy-set',goodsId:'1',name:'合成机箱',addonText:'【+299元升级套装】',addonItems:[{goodsId:'2',qty:1},{goodsId:'3',qty:1}],addonPriceCents:29900};
  const editor=mountSharedAddons(host,{row,getCosts:()=>[],getOriginal:()=>row,onChange:()=>{}});
  host.querySelector('[data-shared-addon-note]').value='只修改内部备注';
  const data=editor.read();
  return {preview:host.querySelector('[data-choice-preview]').textContent,count:host.querySelector('[data-choice-count]').textContent,data};
 });
 assert.equal(legacy.preview,'【+299元升级套装】');
 assert.equal(legacy.count,'1 个方案 · 1 项展示');
 assert.equal(legacy.data.choices,undefined);assert.equal(legacy.data.items.length,2);
 await page.setViewportSize(viewport);
}
