/** 锁定人工编辑但保留「更多 → AI 接口权限」及其宿主对话框，长任务运行中可随时撤权。 */
export function lockAgentEditor(blockSync,workbench=window){
 const disabled=new Set();
 function disable(element){
  if(!element.inert){element.inert=true;disabled.add(element);}
 }
 function preservePath(element){
  for(let node=element;node?.parentElement;node=node.parentElement){
   for(const sibling of node.parentElement.children){
    const menuToggle=node.parentElement.matches('details.app-more')&&sibling.matches('summary');
    if(sibling!==node&&!menuToggle&&!sibling.matches('dialog.agent-permission-dialog'))disable(sibling);
   }
  }
 }
 const entry=workbench.document.querySelector('#desktop-host-actions .agent-permission-entry');
 if(entry&&workbench.frameElement){preservePath(entry);preservePath(workbench.frameElement);}
 else{disable(workbench.document.documentElement);disable(workbench.parent.document.documentElement);}
 workbench.workbenchAgentBusy=blockSync;
 return ()=>{
  // 界面原有的只读区域不在集合中，释放任务后仍保持原态。
  for(const el of disabled)el.inert=false;
  workbench.workbenchAgentBusy=false;
 };
}
