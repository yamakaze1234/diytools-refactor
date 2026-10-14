/** 界面反馈修正：观察错误容器变化，清理空错误提示占位。 */
// Error containers may be filled asynchronously; whitespace is not an error.
/** 为指定容器安装观察器，避免空错误节点长期占用界面空间。 */
export function observeEmptyErrors(root){
 const update=nodes=>{
  for(const node of nodes){
   if(!root.contains(node)||!node.matches('.error'))continue;
   const empty=!node.textContent.trim()&&!node.querySelector('input,button,a,img');
   if(node.classList.contains('is-empty-error')!==empty)node.classList.toggle('is-empty-error',empty);
  }
 };
 const observer=new MutationObserver(records=>{
  const nodes=new Set();
  const collect=node=>{if(node.nodeType!==1)return;if(node.matches('.error'))nodes.add(node);node.querySelectorAll('.error').forEach(error=>nodes.add(error));};
  for(const record of records){
   const target=record.target.nodeType===1?record.target:record.target.parentElement;
   // Text changes only affect enclosing error containers, not the entire page.
   for(let error=target?.closest('.error');error;error=error.parentElement?.closest('.error'))nodes.add(error);
   if(record.type==='childList')record.addedNodes.forEach(collect);
  }
  update(nodes);
 });
 observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});
 update(root.querySelectorAll('.error'));return ()=>observer.disconnect();
}
