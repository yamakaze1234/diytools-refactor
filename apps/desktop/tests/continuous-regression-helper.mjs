/** 本轮连续总表回归专用：只通过可见控件操作，快照探针仅用于断言。 */
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
// 回归产物由运行器指定，单独运行时写仓库sandbox，避免绑定某台电脑的任务目录。
export const artifactDirectory=process.env.CONTINUOUS_REGRESSION_OUTPUT||process.env.WORKBENCH_SCREENSHOTS||resolve('sandbox/continuous-regression');
await mkdir(artifactDirectory,{recursive:true});
export const artifact=name=>join(artifactDirectory,name);
export const configTable=(page,id)=>page.locator(`[data-continuous-config="${id}"]`);
export const displayText=(page,id,slot)=>configTable(page,id).getByRole('textbox',{name:slot+'展示明细',exact:true});
export async function actualPicker(page,id,slot){
 const cell=configTable(page,id).locator(`.ov-actual[aria-label$=" ${slot} 实际配件"]`);
 await cell.dblclick();const picker=cell.getByRole('combobox');await picker.waitFor();return picker;
}
export async function openAdvanced(page,tab){
 const action=page.locator(`[data-editor-open="${tab}"]`);
 const menu=page.locator('.page-heading .action-menu');
 if(!await menu.evaluate(node=>node.open))await menu.locator('summary').click();
 await action.click();await page.locator('#editor').waitFor({state:'visible'});
}
export async function mainTable(page){await page.locator('.tabs [data-tab="parts"]').click();await page.locator('#continuous-workbench').waitFor();}
export async function saveUi(page){await page.locator('#save').click();await page.waitForFunction(()=>!window.workbenchHasPendingChanges?.());}
/** 历史可能先补载详情，等只读历史戳变化后才进行下一步保存。 */
async function historyUi(page,id){const before=await page.evaluate(()=>window.memoryProbe.historyState());await page.locator(id).click();await page.waitForFunction(before=>JSON.stringify(window.memoryProbe.historyState())!==JSON.stringify(before),before);}
export const undoUi=page=>historyUi(page,'#undo');
export const redoUi=page=>historyUi(page,'#redo');
export const closeUi=page=>page.locator('#dialog .dialog-title button').first().click();
/** contenteditable 使用浏览器原生 Range，验证的是输入光标，不改业务状态。 */
export async function textSelection(locator,start,end=start){await locator.evaluate((node,{start,end})=>{const range=document.createRange();range.setStart(node.firstChild||node,start);range.setEnd(node.firstChild||node,end);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);},{start,end});}
export async function textOffsets(handle){return handle.evaluate(node=>{const selection=getSelection();return {connected:node.isConnected,active:node===node.ownerDocument.activeElement,start:selection?.anchorOffset,end:selection?.focusOffset};});}
