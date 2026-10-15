/** 保存后的单次批量还原：只恢复该批次改动的字段，保留后续其他字段编辑。 */
import {sameValue} from './workspace-ui-merge.js';
const clone=value=>structuredClone(value);
export function captureBatchRevert(plan,configs){
 const byId=new Map(configs.map(c=>[c.id,c]));
 return plan.changes.map(change=>({id:change.id,productId:change.productId,before:clone(change.before),saved:clone(byId.get(change.id)||change.after)}));
}
export function batchRevertPlan(records,configs){
 const byId=new Map(configs.map(c=>[c.id,c])),changes=[];
 for(const record of records){
  const current=byId.get(record.id);
  if(!current||current.deletedAt||current.productId!==record.saved.productId||current.shopId!==record.saved.shopId)throw Error('本次配置已删除或移动，不能一键还原');
  const after=clone(current);
  for(const key of new Set([...Object.keys(record.before),...Object.keys(record.saved)])){
   if(sameValue(record.before[key],record.saved[key]))continue;
   if(!sameValue(current[key],record.saved[key])&&!sameValue(current[key],record.before[key]))throw Error(`“${current.name}”的 ${key} 后来已修改，不能覆盖还原`);
   if(Object.hasOwn(record.before,key))after[key]=clone(record.before[key]);else delete after[key];
  }
  if(!sameValue(current,after))changes.push({id:current.id,productId:current.productId,name:current.name,product:current.product,before:clone(current),after});
 }
 return {undo:true,changes,productIds:[...new Set(records.map(r=>r.productId))]};
}
