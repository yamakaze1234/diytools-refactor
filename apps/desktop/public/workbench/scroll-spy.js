// 总表只报告当前链接内滚动到的配置；编辑页和等待换链渲染期间沿用实际编辑项。
let current=null,raf=0;
let editingId=null,editingProductId=null;
let follow=null,followTimer=0,targetId=null,scrollDriven=false;
export function bindScrollPreview(activate){follow=activate;}
function activeSheet(){
 const sheet=document.querySelector('#continuous-workbench:not([hidden]) .ov-sheet-scroll');
 return sheet?.offsetParent&&sheet.dataset.productId===editingProductId?sheet:null;
}
export function syncScrollHighlight(config){
 const id=config?.id??null,productId=config?.productId??null;
 const moved=id!==editingId||productId!==editingProductId;
 editingId=id;editingProductId=productId;
 if(moved){clearTimeout(followTimer);targetId=null;}
 mark(moved||!activeSheet()?id:current??id);
}
function pick(){
 raf=0;
 const scroll=scrollDriven;scrollDriven=false;
 const sheet=activeSheet();
 if(!sheet){clearTimeout(followTimer);targetId=null;mark(editingId);return;}
 const r0=sheet.getBoundingClientRect(),box={top:Math.max(r0.top,0),bottom:Math.min(r0.bottom,innerHeight)};box.height=box.bottom-box.top;const line=box.top+Math.min(160,box.height*0.3);
 let hit=null;
 for(const el of sheet.querySelectorAll('[data-continuous-config]')){const r=el.getBoundingClientRect();if(r.bottom<=box.top||r.top>=box.bottom)continue;if(r.top<=line)hit=el;else{hit??=el;break;}}
 // 较短的末套可能永远够不到判定线，滚到底后按可见末套定位。
 if(sheet.scrollHeight>sheet.clientHeight+4&&sheet.scrollHeight-sheet.scrollTop-sheet.clientHeight<4){
  const last=[...sheet.querySelectorAll('[data-continuous-config]')].find(el=>el.dataset.continuousConfig===sheet.dataset.lastConfiguration);
  if(last){const rect=last.getBoundingClientRect();if(rect.top<box.bottom&&rect.bottom>box.top)hit=last;}
 }
 const seen=hit?.dataset.continuousConfig||editingId;
 mark(seen);
 // 同一套的惯性滚动不重复计时；离开总表或手动切换时取消旧目标。
 if(seen===editingId){clearTimeout(followTimer);targetId=null;return;}
 if(!scroll||!follow||seen===targetId)return;
 clearTimeout(followTimer);targetId=seen;
 followTimer=setTimeout(()=>{
  const candidate=targetId;targetId=null;
  if(candidate&&current===candidate&&activeSheet()===sheet)follow(candidate,editingProductId);
 },250);
}
function paint(el,bg,shadow){
 // 主题 CSS 在 @layer 里带 !important，类名样式压不过，只能用行内 !important。
 // 「正在编辑」除了灰底还有一条 3px 黑色左边线，也一并压成透明，只留黄色高亮自己的竖条。
 const key=bg+'|'+shadow;if(el.dataset.spyPaint===key)return;el.dataset.spyPaint=key;
 if(bg){el.style.setProperty('background',bg,'important');el.style.setProperty('box-shadow',shadow,'important');el.style.setProperty('border-left','2px solid transparent','important');}
 else{el.style.removeProperty('background');el.style.removeProperty('box-shadow');el.style.removeProperty('border-left');}
}
function mark(id){
 const changedTarget=id!==current;current=id;const list=document.querySelector('#config-list');if(!list)return;
 // 注意：classList.add 即使类名已存在也会触发 MutationObserver，所以先判断再改，避免死循环。
 // 列表是原地更新（节点复用、只换 class），所以每次把每一行都重新涂一遍：
 // 看到的那套 = 黄色；原来灰色的「正在编辑」不再单独显示，统一只用黄色。
 let item=null;
 for(const el of list.querySelectorAll('.config-item')){
  if(id&&(el.dataset.id||el.dataset.templateConfigId)===id){item=el;if(!el.classList.contains('scroll-spy'))el.classList.add('scroll-spy');paint(el,'#f3f134','inset 4px 0 0 #181a19');}
  else{if(el.classList.contains('scroll-spy'))el.classList.remove('scroll-spy');if(el.classList.contains('active'))paint(el,'transparent','none');else paint(el,'','');}
 }
 if(!item||!changedTarget)return;
 // 只在左侧列表内部滚动，让高亮项保持可见，页面本身不动。
 const lr=list.getBoundingClientRect(),ir=item.getBoundingClientRect();
 if(ir.top<lr.top+40)list.scrollTop-=lr.top+40-ir.top;else if(ir.bottom>lr.bottom-20)list.scrollTop+=ir.bottom-(lr.bottom-20);
}
document.addEventListener('scroll',e=>{const t=e.target;if(t instanceof Element&&t.closest('#config-list'))return;if(t===activeSheet())scrollDriven=true;if(!raf)raf=requestAnimationFrame(pick);},true);
// 左侧列表重绘后补回高亮（只盯 #config-list 自己的子节点）。
let watched=null;const watcher=new MutationObserver(()=>mark(current));
setInterval(()=>{const list=document.querySelector('#config-list');if(list&&list!==watched){watcher.disconnect();watcher.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});watched=list;}pick();},500);
