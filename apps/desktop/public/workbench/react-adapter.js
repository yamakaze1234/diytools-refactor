/** 宿主不存在时保留独立网页入口；桌面宿主在 iframe 启动前安装 React 接管函数。 */
export function createReactWorkbenchAdapter(host,document){
 const renderer=host?.createWorkbenchReactRenderer?.();
 if(renderer)document.defaultView.addEventListener('pagehide',()=>renderer.dispose(),{once:true});
 return {
  list:(container,markup)=>{if(renderer)renderer.list(container,markup);else container.innerHTML=markup;},
  fields:(config,checkpoint,edit)=>{if(renderer)renderer.fields(document,config,checkpoint,edit);else document.querySelectorAll('[data-config]').forEach(input=>{if(document.activeElement!==input)input.value=config[input.dataset.config]||'';});},
 };
}
