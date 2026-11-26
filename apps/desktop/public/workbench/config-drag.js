/** 配置拖拽排序：将拖放位置转换为配置移动，并保持分组约束。 */
import {bindSortable} from './sortable-drag.js';
const group=c=>JSON.stringify([c.shopId||'intel',c.productId||'legacy:'+String(c.spu||c.product||c.id)]);
/** 按目标前后位置移动配置，返回重新排序后的结果。 */
export function moveConfig(configs,from,to,after=false){
 const source=configs.find(c=>c.id===from),target=configs.find(c=>c.id===to);
 if(!source||!target||source===target||source.deletedAt||target.deletedAt||group(source)!==group(target))return null;
 const rows=configs.filter(c=>!c.deletedAt&&group(c)===group(source));
 const moved=rows.filter(c=>c!==source);moved.splice(moved.indexOf(target)+(after?1:0),0,source);
 if(moved.every((c,i)=>c===rows[i]))return null;
 const members=new Set(rows);let index=0;return configs.map(c=>members.has(c)?{...moved[index],workspaceOrder:index++}:c);
}
/** 绑定配置拖动：同一链接内按住拖动，其余配置带动画避让，实际排序交给 onMove。 */
export function bindConfigDrag(list,onMove){
 const items=[...list.querySelectorAll('.config-item')];
 for(const section of new Set(items.map(el=>el.closest('.product-group')).filter(Boolean)))bindSortable(list,{
  peers:()=>[...section.querySelectorAll('.config-item')],handleOf:el=>el,
  onDrop:({dragged:row,prev,next})=>next?onMove(row.dataset.id,next.dataset.id,false):prev?onMove(row.dataset.id,prev.dataset.id,true):undefined
 });
 for(const el of items){
  el.draggable=false;el.title='拖动调整同一商品链接内的配置顺序';
 }
}
