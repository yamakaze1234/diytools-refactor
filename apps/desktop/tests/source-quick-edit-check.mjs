import assert from 'node:assert/strict';
import {join} from 'node:path';

/** 从配置清单打开的真实快捷弹窗，核对行情、弃稿和本店保存的结果。 */
export async function verifyQuickSource({page,frame,readSource}){
 await page.setViewportSize({width:1360,height:900});
 const dialog=frame.locator('#dialog.source-quick-dialog');
 const name=dialog.locator('#source-name'),tax=dialog.locator('#source-tax');
 const goodsId=await dialog.locator('#source-id').inputValue(),previousName=await name.inputValue();
 const before=await readSource(goodsId);
 const identity=dialog.locator('.sq-identity');
 assert.ok(await identity.locator('[data-quick-erp-name]').innerText());
 assert.equal(await identity.locator('.sq-id').innerText(),'#'+goodsId);
 const priceText=await identity.locator('#source-erp-price').innerText();
 assert.match(priceText,/^¥\d+\.\d{2}$/);
 const stock=identity.locator('#source-stock');
 assert.match(await stock.innerText(),/^现货 (?:\d+|未知)$/);
 assert.equal(await stock.locator('[data-tone=transit]').count(),0,'本条合成商品没有额外的待入库存');
 // 验证等于、低于、未知及超过现货的边界，不动已打开编辑器的数据或草稿。
 const samples=await stock.evaluate(async()=>{
  const {showQuickObservation}=await import('/workbench/source-quick-fields.js');
  const host=document.createElement('div');
  host.innerHTML='<b data-quick-erp-name></b><output id="source-erp-price"></output><span id="source-stock"></span>';
  return [[4,4],[4,2],[4,null],[null,null],[null,3],[4,5]].map(([available,incoming])=>{
   const row={goodsId:'1',name:'合成配件',stockAvailable:available,stockIncomingAvailable:incoming};
   showQuickObservation(host,row,row,[row]);
   return [...host.querySelectorAll('.sq-badge')].map(el=>el.textContent);
  });
 });
 assert.deepEqual(samples,[['现货 4'],['现货 4'],['现货 4'],['现货 未知'],['现货 未知','待入 3'],['现货 4','待入 5']]);
 const [nameRect,taxRect]=await Promise.all([name.boundingBox(),tax.boundingBox()]);
 assert.ok(nameRect&&taxRect&&Math.abs(nameRect.y-taxRect.y)<2&&nameRect.x+nameRect.width<=taxRect.x,'名称和核算价应在同一行');
 const maintenance=dialog.locator('#source-maintenance-fields');
 await maintenance.locator('summary').click();
 assert.ok(await maintenance.evaluate(el=>el.open));
 await maintenance.locator('summary').click();
 const delta=dialog.locator('[data-quick-tax-delta]');
 await tax.fill(String(Number(priceText.slice(1))+2));
 assert.match(await delta.innerText(),/高于 ERP \+¥2\.00/);
 await name.fill('仅用于验收放弃修改');
 await dialog.getByRole('button',{name:'放弃修改',exact:true}).click();
 assert.equal(await name.inputValue(),previousName);
 assert.equal((await readSource(goodsId)).version,before.version);

 // 选择另一件合成商品，核对快捷定价、双口径差价和本店加购写入。
 const addon=dialog.locator('[data-shared-choices]');
 await addon.locator('[data-choice-add]').click();
 const choice=addon.locator('[data-choice]').last();
 await choice.locator('[data-product-query]').fill('9900013');
 await choice.locator('[data-product-id="9900013"]').click();
 await choice.locator('[data-quick-price]').first().click();
 const copy='升级验收配件';
 await choice.locator('[data-choice-label]').fill(copy);
 assert.ok((await addon.locator('[data-choice-preview]').innerText()).includes(copy));
 const updatedName=previousName+'（快捷编辑验收）';
 await name.fill(updatedName);
 if(process.env.SOURCE_SHEET_REDESIGN_CAPTURE){
  await dialog.locator('#source-detail').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:join(process.env.SOURCE_SHEET_REDESIGN_CAPTURE,'quick.png')});
 }
 await dialog.getByRole('button',{name:'保存输出源',exact:true}).click();
 await dialog.locator('#source-message').getByText(/已保存 1 条/).waitFor();
 const after=await readSource(goodsId);
 assert.deepEqual(after.common,before.common);
 assert.ok(after.stores.intel.some(alias=>alias.fields.name===updatedName&&alias.fields.addon?.addonChoices?.some(item=>item.label===copy)));
}
