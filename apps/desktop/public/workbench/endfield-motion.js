// 局部旧画面淡出叠合新画面；业务渲染同步完成，不延迟选择或草稿校验。
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let current = null;
function cancel() { current?.(); current = null; }
export function capturePanelTransition(panel) {
  cancel();
  if (document.documentElement.dataset.workbenchDesign !== 'endfield' || reduced.matches || !panel || !panel.getClientRects().length || !panel.children.length) return () => {};
  const rect = panel.getBoundingClientRect();
  // 仅复制当前详情，不复制配置总表、不挂载控制器，结束即释放。
  const ghost = panel.cloneNode(true);
  ghost.querySelectorAll('.workbench-detail-ghost').forEach(n => n.remove());
  for (const node of [ghost,...ghost.querySelectorAll('*')]) { node.removeAttribute('id'); node.removeAttribute('autofocus'); }
  ghost.classList.add('workbench-detail-ghost');
  ghost.inert = true; ghost.setAttribute('aria-hidden','true');
  Object.assign(ghost.style,{position:'absolute',inset:'0 auto auto 0',width:rect.width+'px',height:rect.height+'px',margin:'0',pointerEvents:'none',zIndex:'2',background:getComputedStyle(panel).backgroundColor === 'rgba(0, 0, 0, 0)' ? 'var(--ef-panel)' : getComputedStyle(panel).backgroundColor});
  return () => {
    if (!panel.isConnected || reduced.matches) return;
    ghost.style.height=Math.max(rect.height,panel.getBoundingClientRect().height)+'px';
    const position=panel.style.position;panel.style.position='relative';panel.append(ghost);
    const animation=ghost.animate([{opacity:1},{opacity:0}],{duration:320,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});
    const release=()=>{animation.cancel();ghost.remove();panel.style.position=position;if(current===release)current=null;};
    current=release;animation.finished.then(release,()=>{});
  };
}
function transition(event) {
  if(reduced.matches)return;
  const target=event.target instanceof Element?event.target.closest('.tabs [data-tab]'):null;if(!target)return;
  const panel=document.querySelector(target.dataset.tab==='parts'?'#continuous-workbench':'#editor');if(!panel||panel.hidden)return;
  cancel();const animation=panel.animate([{opacity:0},{opacity:1}],{duration:240,easing:'cubic-bezier(.4,0,.2,1)'});
  const release=()=>{animation.cancel();if(current===release)current=null;};current=release;animation.finished.then(release,()=>{});
}
document.addEventListener('click',transition);
reduced.addEventListener('change',cancel);
addEventListener('pagehide',()=>{cancel();document.removeEventListener('click',transition);reduced.removeEventListener('change',cancel);},{once:true});
