/** 保存后的单次批量还原：只恢复该批次改动的字段，保留后续其他字段编辑。 */
import {sameValue} from './workspace-ui-merge.js';
const clone=value=>structuredClone(value);
export function captureBatchRevert(plan,configs,{onlyChanged=false}={}){
 const byId=new Map(configs.map(c=>[c.id,c]));
 return plan.changes.map(change=>{
  const saved=byId.get(change.id)||change.after,productId=change.productId||change.before.productId;
  if(!onlyChanged)return {id:change.id,productId,before:clone(change.before),saved:clone(saved)};
  const fields=[...new Set([...Object.keys(change.before),...Object.keys(change.after)])].filter(key=>!sameValue(change.before[key],change.after[key]));
  // 持久批次仅保存改动字段及目标身份，不为撤销再记录整份配置。
  const snapshot=row=>clone(Object.fromEntries(['productId','shopId',...fields].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])));
  return {id:change.id,productId,before:snapshot(change.before),saved:snapshot(saved),fields};
 });
}

export function confirmBatchRevert(records,configs,versions){
 const byId=new Map(configs.map(config=>[config.id,config]));
 return records.filter(row=>versions.has(row.id)&&byId.has(row.id)).map(row=>{
  const current=byId.get(row.id);
  const saved=Object.fromEntries(['productId','shopId',...row.fields].filter(key=>Object.hasOwn(current,key)).map(key=>[key,current[key]]));
  return {...row,saved:clone(saved)};
 });
}
export function batchRevertPlan(records,configs){
 const byId=new Map(configs.map(c=>[c.id,c])),changes=[];
 for(const record of records){
  const current=byId.get(record.id);
  if(!current||current.deletedAt||current.productId!==record.saved.productId||current.shopId!==record.saved.shopId)throw Error('本次配置已删除或移动，不能一键还原');
  const after=clone(current);
  for(const key of record.fields??new Set([...Object.keys(record.before),...Object.keys(record.saved)])){
   if(sameValue(record.before[key],record.saved[key]))continue;
   if(!sameValue(current[key],record.saved[key])&&!sameValue(current[key],record.before[key]))throw Error(`“${current.name}”的 ${key} 后来已修改，不能覆盖还原`);
   if(Object.hasOwn(record.before,key))after[key]=clone(record.before[key]);else delete after[key];
  }
  if(!sameValue(current,after))changes.push({id:current.id,productId:current.productId,name:current.name,product:current.product,before:clone(current),after});
 }
 return {undo:true,changes,productIds:[...new Set(records.map(r=>r.productId))]};
}
