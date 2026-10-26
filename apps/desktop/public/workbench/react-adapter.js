/** 宿主不存在时保留独立网页入口；桌面宿主在 iframe 启动前安装 React 接管函数。 */
export function createReactWorkbenchAdapter(host,document){
 const renderer=host?.createWorkbenchReactRenderer?.();
 if(renderer)document.defaultView.addEventListener('pagehide',()=>renderer.dispose(),{once:true});
 return {
  continuousAvailable:Boolean(renderer?.continuous),
  continuous:(container,model)=>{if(!renderer?.continuous)return false;renderer.continuous(container,model);return true;},
  editor:(container,model)=>{if(!renderer)return false;renderer.editor(container,model);return true;},
  templates:(container,model)=>{if(!renderer)return false;renderer.templates(container,model);return true;},
  dialog:(container,kind,model)=>{if(!renderer)return false;renderer.dialog(container,kind,model);return true;},
  status:(container,model)=>{if(!renderer)return false;renderer.status(container,model);return true;},
  release:container=>renderer?.release(container),
  list:(container,markup)=>{if(renderer)renderer.list(container,markup);else container.innerHTML=markup;},
  fields:(config,checkpoint,edit)=>{if(renderer)renderer.fields(document,config,checkpoint,edit);else document.querySelectorAll('[data-config]').forEach(input=>{if(document.activeElement!==input)input.value=config[input.dataset.config]||'';});},
 };
}
