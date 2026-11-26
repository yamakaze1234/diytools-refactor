import {bindSortable} from './sortable-drag.js';
/** 链接级排序与副本：整条链接在列表中移动、跨草稿区/链接区移动，以及复制整条链接到草稿区。 */
const linkId=c=>c.productId||'legacy:'+String(c.spu||c.product||c.id);
const member=(shopId,id)=>c=>(c.shopId||'intel')===shopId&&linkId(c)===id;

/**
 * 本机工作区：把整条链接（含已删除行，保持同组）移到目标链接之前或之后，并按目标区设置草稿标记。
 * toId 为空时放到最后。没有变化返回 null。
 */
export function moveLink(configs,{shopId,fromId,toId=null,after=false,draft}){
 const inSource=member(shopId,fromId),source=configs.filter(inSource);
 if(!source.some(c=>!c.deletedAt)||fromId===toId)return null;
 const rest=configs.filter(c=>!inSource(c));
 let index=rest.length;
 if(toId){
  const inTarget=member(shopId,toId),positions=rest.map((c,i)=>inTarget(c)?i:-1).filter(i=>i>=0);
  if(!positions.length)return null;
  index=after?positions[positions.length-1]+1:positions[0];
 }
 const flagged=source.map(c=>{
  if(c.deletedAt||Boolean(c.productDraft)===Boolean(draft))return c;
  const next={...c};if(draft)next.productDraft=true;else delete next.productDraft;return next;
 });
 const result=[...rest.slice(0,index),...flagged,...rest.slice(index)];
 return result.every((c,i)=>c===configs[i])?null:result;
}

/**
 * NAS 工作区：列表按 workspaceOrder 排列，链接位置由其首套配置决定。
 * groups 为当前显示顺序的链接（每项含 configs），返回被移动链接各套配置的新排序值；位置不变返回 null。
 */
export function linkOrderValues(groups,fromId,toId=null,after=false){
 const source=groups.find(g=>g.id===fromId);
 if(!source||fromId===toId)return null;
 const rest=groups.filter(g=>g!==source);
 let index=rest.length;
 if(toId){const target=rest.findIndex(g=>g.id===toId);if(target<0)return null;index=target+(after?1:0);}
 if(groups.indexOf(source)===index)return null;
 const orders=g=>g.configs.map(c=>Number(c.workspaceOrder)).filter(Number.isFinite);
 const prev=rest[index-1],next=rest[index],count=source.configs.length;
 const prevOrders=prev?orders(prev):[],nextOrders=next?orders(next):[];
 if((prev&&!prevOrders.length)||(next&&!nextOrders.length))throw Error('链接排序值缺失，请先调整配置顺序');
 const hi=next?Math.min(...nextOrders):null;
 let lo=prev?Math.max(...prevOrders):null;
 if(lo!==null&&hi!==null&&lo>=hi)lo=Math.min(...prevOrders);
 let values;
 if(lo===null&&hi===null)values=source.configs.map((_,i)=>i);
 else if(hi===null)values=source.configs.map((_,i)=>lo+100*(i+1));
 else if(lo===null)values=source.configs.map((_,i)=>hi-100*(count-i));
 else values=source.configs.map((_,i)=>lo+(hi-lo)*(i+1)/(count+1));
 if(values.some((v,i)=>!Number.isFinite(v)||(i&&v<=values[i-1])||(lo!==null&&v<=lo)||(hi!==null&&v>=hi)))throw Error('链接排序间隔不足，请先调整配置顺序');
 return values;
}

/** 复制整条链接：新链接 ID、名称加「 · 副本」，清空平台 SPU、网址和 SKU，并放入草稿区。 */
export function duplicateLinkConfigs(rows,{productId,newId=()=>crypto.randomUUID()}){
 return rows.filter(c=>!c.deletedAt).map(c=>{
  const copy=structuredClone(c);
  copy.id=newId();copy.productId=productId;copy.product=(c.product||'未命名商品链接')+' · 副本';
  copy.spu='';copy.productUrl='';copy.skuId='';copy.productDraft=true;
  for(const key of ['quotation','published','final_price_cents','deletionSessionId','emptyLinkDraft'])delete copy[key];
  return copy;
 });
}

/** 绑定链接卡片拖动：可在同区上下移动，也可拖进另一区；其余卡片带动画避让。实际移动交给 onMove。 */
export function bindLinkDrag(list,onMove){
 const surface=list.querySelector('[data-react-list]');if(!surface)return;
 const isZone=n=>n.hasAttribute?.('data-zone-toggle');
 bindSortable(list,{
  peers:()=>[...surface.children],
  handleOf:n=>n.matches?.('section[data-list-product]')?n.firstElementChild:null,
  // 第一个分区标题（草稿区）之前不能放链接。
  minIndex:others=>others.findIndex(isZone)+1,
  onDrop:({dragged,prev,next,others,index})=>{
   let zone=null;for(let k=index-1;k>=0;k--)if(isZone(others[k])){zone=others[k].getAttribute('data-zone-toggle');break;}
   if(!zone)return;
   const link=n=>n?.matches?.('section[data-list-product]')?n.dataset.listProduct:null;
   const target=link(next)?{toId:link(next),after:false}:link(prev)?{toId:link(prev),after:true}:{toId:null,after:false};
   return onMove(dragged.dataset.listProduct,{...target,zone});
  }
 });
}
