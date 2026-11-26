/** 避让式拖动排序：按住拖动时卡片跟随指针，其余卡片带动画让出位置，松手后滑入空位再提交顺序。 */
const DURATION=180;
const lifted=new WeakSet();

/** 清除上一次拖动留下的位移样式（列表重绘后节点可能被复用）。 */
export function resetSortable(elements){
 for(const el of elements){
  if(!el.style)continue;
  el.style.transition='';el.style.transform='';el.style.zIndex='';el.style.position='';
  el.classList.remove('sortable-lifted');lifted.delete(el);
 }
}

/**
 * peers()：参与排序的全部节点（按显示顺序，含分区标题等不可拖动的占位节点）。
 * handleOf(el)：可拖动节点的拖动手柄；返回 null 表示该节点不可拖动。
 * minIndex(others)：插入位置下限（例如不能拖到第一个分区标题之前）。
 * onDrop({dragged,prev,next,others,index})：位置有变化时调用，可返回 Promise。
 */
export function bindSortable(list,{peers,handleOf,minIndex=()=>0,onDrop,ignore='input,button[data-link-menu],.link-card-more'}){
 const all=peers();resetSortable(all);
 for(const el of all){
  const handle=handleOf(el);if(!handle)continue;
  handle.draggable=false;handle.classList.add('sortable-handle');
  handle.onpointerdown=down=>{
   if(down.button!==0||down.target.closest?.(ignore))return;
   const startX=down.clientX,startY=down.clientY;let session=null;
   const move=e=>{
    if(!session){if(Math.hypot(e.clientX-startX,e.clientY-startY)<5)return;session=begin(el,startY);if(!session){cleanup();return;}}
    e.preventDefault();session.pointer(e.clientY);
   };
   const up=e=>{cleanup();if(!session)return;
    // 拖动结束后吞掉紧随的 click，避免误触展开或切换配置。
    const swallow=ev=>{ev.stopPropagation();ev.preventDefault();};window.addEventListener('click',swallow,true);setTimeout(()=>window.removeEventListener('click',swallow,true),0);
    session.finish(e.type==='pointercancel');};
   const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);};
   window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
  };
 }
 function begin(dragged,startClientY){
  const nodes=peers().filter(n=>n.offsetParent!==null||n===dragged),origin=nodes.indexOf(dragged);
  if(origin<0)return null;
  const box=list.getBoundingClientRect(),scroll0=list.scrollTop;
  const top=n=>n.getBoundingClientRect().top-box.top+scroll0;
  const tops=nodes.map(top),slot=i=>i+1<nodes.length?tops[i+1]-tops[i]:nodes[i].getBoundingClientRect().height;
  const slots=nodes.map((_,i)=>slot(i)),size=slots[origin];
  const others=nodes.filter(n=>n!==dragged),otherIndex=others.map(n=>nodes.indexOf(n));
  const floor=Math.max(0,minIndex(others));
  const mids=otherIndex.map(i=>tops[i]+slots[i]/2);
  const content=y=>y-list.getBoundingClientRect().top+list.scrollTop;
  const start=content(startClientY),home=origin;
  let index=home,lastY=startClientY,frame=0,done=false;
  list.classList.add('sortable-active');dragged.classList.add('sortable-lifted');lifted.add(dragged);
  dragged.style.position='relative';dragged.style.zIndex='5';dragged.style.transition='box-shadow .15s';
  for(const n of others)n.style.transition=`transform ${DURATION}ms cubic-bezier(.2,.7,.3,1)`;
  const layout=()=>{
   others.forEach((n,k)=>{const i=otherIndex[k];let shift=0;if(i>origin&&k<index)shift=-size;else if(i<origin&&k>=index)shift=size;n.style.transform=shift?`translateY(${shift}px)`:'';});
  };
  const pointer=y=>{
   lastY=y;const dy=content(y)-start;dragged.style.transform=`translateY(${dy}px)`;
   // 以指针位置决定落点：指针越过哪张卡片的中线，就插到它的另一侧。
   const center=content(y);let k=mids.filter(m=>m<center).length;k=Math.max(floor,k);
   if(k!==index){index=k;layout();}
   if(!frame)frame=requestAnimationFrame(autoscroll);
  };
  const autoscroll=()=>{frame=0;if(done)return;const b=list.getBoundingClientRect();let step=0;
   if(lastY<b.top+48)step=-Math.ceil((b.top+48-lastY)/4);else if(lastY>b.bottom-48)step=Math.ceil((lastY-(b.bottom-48))/4);
   if(step){const before=list.scrollTop;list.scrollTop+=step;if(list.scrollTop!==before)pointer(lastY);}};
  const finish=cancelled=>{
   done=true;if(frame)cancelAnimationFrame(frame);
   if(cancelled)index=home;
   // 落点位移 = 被越过的卡片高度之和。
   let target=0;others.forEach((n,k)=>{const i=otherIndex[k];if(i>origin&&k<index)target+=slots[i];else if(i<origin&&k>=index)target-=slots[i];});
   layout();dragged.style.transition=`transform ${DURATION}ms cubic-bezier(.2,.7,.3,1)`;dragged.style.transform=target?`translateY(${target}px)`:'';
   dragged.classList.remove('sortable-lifted');list.classList.remove('sortable-active');
   setTimeout(async()=>{
    const settle=()=>{if(lifted.has(dragged)||dragged.style.transform||others.some(n=>n.style.transform))resetSortable([dragged,...others]);};
    if(index===home){settle();return;}
    try{await onDrop({dragged,prev:others[index-1]||null,next:others[index]||null,others,index});}finally{settle();}
   },DURATION);
  };
  return {pointer,finish};
 }
}
