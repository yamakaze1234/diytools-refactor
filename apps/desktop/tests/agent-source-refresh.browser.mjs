/** 验证收到 AI 保存回执时，已打开的输出源工作表能读回新值并保留人工输入。 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const origin=process.env.REACT_TEST_URL||'http://127.0.0.1:5289';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();
 const url=origin+'/agent-source-sheet';
 await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<main class="workspace"><section></section></main><dialog id="dialog"></dialog>'}));
 await page.goto(url);
 await page.evaluate(async()=>{
  const {openSourceSheet}=await import('/workbench/source-sheet-ui.js');
  const saved={sourceId:'source-99902',shopId:'intel',goodsId:'99902',name:'原名称'};
  window.changeSaved=fields=>Object.assign(saved,fields);
  openSourceSheet(document.querySelector('section'),{shopId:()=>'intel',shopIds:['intel'],canManage:true,
   getAllRows:()=>[structuredClone(saved)],getCosts:()=>[],getConfigs:()=>[]});
 });
 const externalName=page.locator('[data-sheet-row="99902"] [data-sheet-field=name]').first();
 assert.equal(await externalName.inputValue(),'原名称');
 await externalName.fill('人工输入保留');
 const refresh=()=>page.evaluate(()=>window.workbenchSourceEditor.refreshSaved());
 await page.evaluate(()=>window.changeSaved({name:'已保存的新名称'}));
 assert.equal(await refresh(),false);
 assert.equal(await externalName.inputValue(),'人工输入保留');
 await externalName.press('Escape');
 assert.equal(await refresh(),true);
 assert.equal(await externalName.inputValue(),'已保存的新名称');
 await page.locator('[data-sheet-action=filter][data-filter=deleted]').click();
 await page.evaluate(()=>window.changeSaved({deletedAt:new Date().toISOString()}));
 assert.equal(await refresh(),true);
 assert.equal(await page.locator('[data-deleted-row="source-99902"] b').innerText(),'已保存的新名称');
 console.log('工作表已读回外部保存，保留人工输入，并刷新已删除列表');
}finally{await browser.close();}
