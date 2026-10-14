/** 输出源同步计划：逐字段展示配置差异，核验后应用，并提取受影响的图片导出任务。 */
import {numberedImageEntries} from './image-export-order.js';
import {sourceDiff,syncSource} from './source.js';
import {createConfigPartIndex} from './component-index.js';
import {selectableComponents} from './component-policy.js';
// 全店输出源同步先生成纯数据预览，应用前逐项比对原输出源与配置快照；过期即整批拒绝。
// 预览只改 parts 的展示字段，actualParts 与人工 addons 留在原配置中。
export const sourceChangeKey=(configId,sourceId,slot,field)=>JSON.stringify([configId,sourceId,slot,field]);
/** 根据店铺、字段和选项生成可审查的来源同步计划。 */
export function sourceSyncPlan(configs,rows,fields,shopId,options={}){
 fields=[...new Set(fields.map(field=>field==='addon'?'upgrade':field))];
 if(!fields.length)throw Error('请至少勾选一个同步字段');
 const catalog=selectableComponents(rows).filter(r=>!r.deletedAt&&r.shopId===shopId),byId=new Map(catalog.map(r=>[r.sourceId,r])),used=new Map(),changes=[];
 const retained=new Set(options.retained||[]);
 for(const c of configs.filter(c=>!c.deletedAt&&c.shopId===shopId&&(!options.productIds||options.productIds.includes(c.productId)))){
  const after=structuredClone(c),details=[];
  // 配件多时，为同一配置的各输出源复用引用索引；小配置直接扫描展示行更省建索引成本。
  // 此预览只改 name/tax/upgrade，不改关联字段，因此本次预览结束前索引无需失效。
  const partIndex=after.parts.length>=32?createConfigPartIndex([after],{includeGoods:false,includeActual:false}):undefined;
  for(const id of new Set(c.parts.map(p=>p.sourceId))){
   const row=byId.get(id);if(!row)continue;
   const selectedFields=fields.filter(f=>f!=='addon'||!retained.has(sourceChangeKey(c.id,id,'加购',f)));
   const diffs=sourceDiff([after],row,selectedFields,partIndex);if(!diffs.length)continue;
   const selected=diffs[0].changes.map(d=>({...d,key:sourceChangeKey(c.id,id,d.slot,d.field)})).filter(d=>!retained.has(d.key));
   if(!selected.length)continue;
   const before=structuredClone(after);syncSource([after],row,selectedFields,partIndex);
   after.parts.forEach((p,i)=>{if(p.sourceId===id)for(const field of ['name','tax','upgrade'])if(retained.has(sourceChangeKey(c.id,id,p.slot,field))){if(Object.hasOwn(before.parts[i],field))p[field]=before.parts[i][field];else delete p[field];}});
   if(!selected.some(d=>d.field==='tax')){if(Object.hasOwn(before,'taxUpdatedAt'))after.taxUpdatedAt=before.taxUpdatedAt;else delete after.taxUpdatedAt;}
   details.push(...selected);used.set(id,structuredClone(row));
  }
  if(details.length)changes.push({id:c.id,product:c.product,name:c.name,before:structuredClone(c),after,details});
 }
 return {shopId,fields:[...fields],sources:[...used.values()],changes};
}
/** 将确认计划应用到目标配件和来源记录。 */
export function applySourceSync(plan,configs,rows){
 for(const before of plan.sources){const current=rows.find(r=>r.sourceId===before.sourceId);if(JSON.stringify(current)!==JSON.stringify(before))throw Error('输出源已变化，请重新预览');}
 const targets=plan.changes.map(change=>{const c=configs.find(c=>c.id===change.id);if(!c||c.shopId!==plan.shopId||JSON.stringify(c)!==JSON.stringify(change.before))throw Error('配置已变化，请重新预览');return c;});
 targets.forEach((c,i)=>Object.assign(c,structuredClone(plan.changes[i].after)));return targets.map(c=>c.id);
}
const safe=v=>String(v||'未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,65);
/** 从目标配置构造图片导出条目。 */
export function sourceImageEntries(configs){
 const groups=new Map(),folders=new Set();
 for(const c of configs){const key=JSON.stringify([c.shopId,c.productId||c.product||c.spu||'']);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 return [...groups.values()].flatMap(rows=>{const first=rows[0],base=`${safe(first.spu||first.productId)}_${safe(first.product)}`;let folder=base,n=2;while(folders.has(folder))folder=base+'_'+n++;folders.add(folder);return numberedImageEntries(rows).flatMap(({config:c,name})=>['long','square'].map(layout=>({name:`${folder}/${layout==='long'?'配置清单图':'SKU图'}/${name}`,config:{...structuredClone(c),layout}})));});
}
