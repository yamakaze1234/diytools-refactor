/** 旧编辑器回归共用真实可见入口；只展开折叠菜单，不触发隐藏节点或修改业务模型。 */
export async function clickWorkbenchControl(page,selector){
 const control=page.locator(selector);
 // 最左分类导航是旧工具按钮的新可见入口；从菜单点击，由产品自己的转发控制器执行业务。
 const navigation={
  '#inventory-check-open':['库存','检查商品库存'],'#profit-check-open':['库存','一键检测利润'],
  '#price-changes-open':['库存','检查价格变化'],'#inventory-export-open':['库存','导出库存监控清单'],
  '#global-batch-open':['维护','批量修改配件 / 加购 / 导图'],'[data-nav="source"]':['维护','输出源维护'],
  '[data-nav="cost-source"]':['维护','三店共用成本价'],'[data-nav="templates"]':['图片','配置模板'],
  '#case-gallery-open':['图片','机箱图库'],'#logs-open':['记录'],
 }[selector];
 if(navigation&&!await control.isVisible()){
  await page.locator('.rail-navigation').getByRole('button',{name:navigation[0],exact:true}).click();
  if(navigation[1])await page.locator('#rail-tool-panel').getByRole('button',{name:navigation[1],exact:true}).click();
  return;
 }
 const ancestors=await control.locator('xpath=ancestor::details[not(@open)]').all();
 for(const details of ancestors.reverse())await details.locator(':scope > summary').click();
 await control.click();
}

/** 总表、加购福利、图片样式保持主入口；完整编辑能力从「更多操作」进入。 */
export async function openWorkbenchEditor(page,panel){
 if(['parts','perks','modules'].includes(panel))await page.locator('.main > .tabs [data-tab="'+panel+'"]').click();
 else await clickWorkbenchControl(page,'[data-editor-open="'+panel+'"]');
 if(panel==='parts')await page.locator('#continuous-workbench:visible [data-continuous-config]').first().waitFor();
 else await page.locator('#editor:visible [data-react-editor="'+(panel==='display'?'parts':panel)+'"]').waitFor();
}

/** 对话框关闭也使用可见按钮，避免绕过用户关闭时的业务保护。 */
export async function closeWorkbenchDialog(page){
 await page.locator('#dialog > form button[aria-label="关闭"]').click();
 await page.locator('#dialog').waitFor({state:'hidden'});
}

/** 通过实际主题按钮切换，等待主题状态落地后再做颜色和业务状态检查。 */
export async function setWorkbenchTheme(page,theme){
 if(await page.evaluate(()=>document.documentElement.dataset.workbenchTheme)!==theme)await page.locator('#workbench-theme-toggle').click();
 await page.waitForFunction(value=>document.documentElement.dataset.workbenchTheme===value,theme);
}
