/** 工作台面板尺寸交互：拖拽调整各区域大小，并维护布局约束。 */
// Only local window layout is persisted; these widths are not business data.
/** 绑定工作台分隔条与尺寸恢复，返回界面需要的布局控制。 */
export function mountWorkspaceResize(workspace){
 const sidebar=workspace.querySelector('.sidebar'),preview=workspace.querySelector('.preview-side');
 const storageKey='diy-workspace-widths-v1',minimum={left:200,main:420,right:320};
 let saved=null,drag=null,frame=null,pendingX=null;
 try{const value=JSON.parse(localStorage.getItem(storageKey));if(value&&Number.isFinite(value.left)&&Number.isFinite(value.right))saved=value;}catch{}
 const handles=['left','right'].map(side=>{const el=document.createElement('div');el.className='workspace-resizer';el.dataset.resizeColumn=side;el.tabIndex=0;el.setAttribute('role','separator');el.setAttribute('aria-orientation','vertical');el.setAttribute('aria-label',side==='left'?'调整商品列表与编辑区宽度':'调整编辑区与图片预览宽度');el.title='左右拖动调整宽度；双击恢复默认';workspace.append(el);return el;});
 const enabled=()=>innerWidth>1180&&!preview.classList.contains('hidden')&&!preview.classList.contains('preview-expanded');
 function fit(value){
  const width=workspace.clientWidth;
  const left=Math.max(minimum.left,Math.min(value.left,width-minimum.main-minimum.right));
  const right=Math.max(minimum.right,Math.min(value.right,width-minimum.main-left));
  return{left,right};
 }
 function apply(value){const widths=fit(value);workspace.style.gridTemplateColumns=`${widths.left}px minmax(${minimum.main}px,1fr) ${widths.right}px`;return widths;}
 function measure(){return{left:sidebar.getBoundingClientRect().width,right:preview.getBoundingClientRect().width};}
 function flushMove(){
  if(!drag||pendingX===null)return;
  const delta=pendingX-drag.x,width=workspace.clientWidth;pendingX=null;
  apply(drag.el.dataset.resizeColumn==='left'?{left:Math.max(minimum.left,Math.min(drag.left+delta,width-drag.right-minimum.main)),right:drag.right}:{left:drag.left,right:Math.max(minimum.right,Math.min(drag.right-delta,width-drag.left-minimum.main))});
 }
 function layout(){
  frame=null;flushMove();const active=enabled();handles.forEach(el=>el.hidden=!active);
  if(!active){if(!drag)workspace.style.removeProperty('grid-template-columns');return;}
  if(!drag){if(saved)apply(saved);else workspace.style.removeProperty('grid-template-columns');}
  const bounds=workspace.getBoundingClientRect();
  for(const el of handles){const left=el.dataset.resizeColumn==='left',rect=(left?sidebar:preview).getBoundingClientRect();el.style.left=`${(left?rect.right:rect.left)-bounds.left}px`;el.setAttribute('aria-valuemin',String(left?minimum.left:minimum.right));el.setAttribute('aria-valuemax',String(workspace.clientWidth-minimum.main-(left?preview:sidebar).getBoundingClientRect().width));el.setAttribute('aria-valuenow',String(Math.round(rect.width)));}
 }
 const schedule=()=>{if(frame===null)frame=requestAnimationFrame(layout);};
 function persist(value){saved=value;try{saved?localStorage.setItem(storageKey,JSON.stringify(saved)):localStorage.removeItem(storageKey);}catch{}}
 function finish(cancel=false){if(!drag)return;if(frame!==null){cancelAnimationFrame(frame);frame=null;}if(!cancel)flushMove();pendingX=null;const previous=drag;drag=null;workspace.classList.remove('resizing-columns');if(cancel){saved=previous.saved;layout();}else{persist(measure());layout();}if(previous.el.hasPointerCapture(previous.pointer))previous.el.releasePointerCapture(previous.pointer);}
 function reset(){finish(true);persist(null);layout();}
 for(const el of handles){
  el.onpointerdown=event=>{if(event.button!==0||!enabled())return;event.preventDefault();drag={el,pointer:event.pointerId,x:event.clientX,...measure(),saved};el.setPointerCapture(event.pointerId);workspace.classList.add('resizing-columns');};
  el.onpointermove=event=>{if(!drag||drag.el!==el||drag.pointer!==event.pointerId)return;pendingX=event.clientX;schedule();};
  el.onpointerup=()=>finish();el.onpointercancel=()=>finish(true);el.onlostpointercapture=()=>finish(true);el.ondblclick=reset;
  el.onkeydown=event=>{if(!enabled())return;if(event.key==='Home'){event.preventDefault();reset();return;}if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const widths=measure(),delta=(event.key==='ArrowRight'?1:-1)*20,width=workspace.clientWidth;if(el.dataset.resizeColumn==='left')widths.left=Math.min(widths.left+delta,width-widths.right-minimum.main);else widths.right=Math.min(widths.right-delta,width-widths.left-minimum.main);persist(apply(widths));layout();};
 }
 window.addEventListener('blur',()=>finish(true));window.addEventListener('resize',()=>{finish(true);schedule();});
 new ResizeObserver(schedule).observe(workspace);new MutationObserver(schedule).observe(preview,{attributes:true,attributeFilter:['class']});
 layout();return{reset};
}
