/** 编辑状态三方合并：比较业务字段，处理配置列表和全局数据，并为保存回执重设基线。 */
import {finishStateWork,finishStateWorkAsync} from './state-work.js';
const clone=v=>structuredClone(v);
// JSON receipts may reorder object keys; that is not a business edit.
const same=(a,b)=>{
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
 const keys=o=>Object.keys(o).filter(k=>o[k]!==undefined);
 return keys(a).length===keys(b).length&&keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
};
// 增量选择与回执重基共用相同相等语义：对象键顺序无关，数组顺序有意义，undefined 等同缺字段。
export const sameValue=same;
const withoutNewLineId=(base,row)=>{const value={...row};if(base.lineId==null)delete value.lineId;return value;};
const collections={configs:'id',templates:'id',sourceCatalog:'sourceId',costSource:'goodsId',caseGallery:'id'};
/** 比较编辑业务状态，排除不代表用户修改的元数据差异。 */
export function sameEditingState(a,b){return [...Object.keys(collections),'shopSettings'].every(key=>same(a[key],b[key]));}
function* sameEditingWork(a,b){
 for(const key of [...Object.keys(collections),'shopSettings']){
  if(a[key]===b[key])continue;
  if(Array.isArray(a[key])&&Array.isArray(b[key])){if(a[key].length!==b[key].length)return false;for(let i=0;i<a[key].length;i++){if(!same(a[key][i],b[key][i]))return false;yield;}}
  else {if(!same(a[key],b[key]))return false;yield;}
 }
 return true;
}
export const sameEditingStateAsync=(a,b,options)=>finishStateWorkAsync(sameEditingWork(a,b),options);
/** 将各业务根的三方合并拆成工作步骤，同时记录真实字段冲突。 */
function* editingStateWork(base,local,remote,{ownLocalRows=false}={}){
 // Collections are constructed below. Cloning them here as well doubled the
 // receipt's allocation and blocked input before any row could be processed.
 const result={};let conflict=false;
 for(const key of Object.keys(remote))if(!Object.hasOwn(collections,key)&&key!=='shopSettings'){result[key]=clone(remote[key]);yield;}
 const merge=(b,l,r)=>{
  // Materialization fills unknown stock on new part rows. Missing and null
  // mean the same thing; neither is a concurrent edit during first save.
  if([b,l,r].every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&'goodsId' in v)&&[b,l,r].some(v=>'stockAvailable' in v)){
   [b,l,r]=[b,l,r].map(v=>({...v,stockAvailable:v.stockAvailable??null}));
  }
  if(same(l,b))return clone(r);if(same(r,b)||same(l,r))return clone(l);
  if(b&&l&&r&&typeof b==='object'&&typeof l==='object'&&typeof r==='object'&&!Array.isArray(l)&&!Array.isArray(r)){
   if('goodsId' in b&&(l.goodsId!==b.goodsId||r.goodsId!==b.goodsId)&&!same(withoutNewLineId(b,l),withoutNewLineId(b,b))&&!same(withoutNewLineId(b,r),withoutNewLineId(b,b))){conflict=true;return clone(l);}
   const v={};for(const k of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){const value=merge(b[k],l[k],r[k]);if(value!==undefined)v[k]=value;}return v;
  }
  if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)){
   const key=['id','lineId','slot','sourceId','goodsId'].find(k=>[b,l,r].every(rows=>rows.every(row=>row&&typeof row==='object'&&row[k]!=null)&&new Set(rows.map(row=>row[k])).size===rows.length));
   if(key){const bm=new Map(b.map(v=>[v[key],v])),lm=new Map(l.map(v=>[v[key],v])),rm=new Map(r.map(v=>[v[key],v]));return [...new Set([...rm.keys(),...lm.keys(),...bm.keys()])].map(id=>merge(bm.get(id),lm.get(id),rm.get(id))).filter(Boolean);}
  }
  conflict=true;return clone(l);
 };
 // 配置级时间由多个配件更新汇总而来。不同商品同时改价不应仅因更新时间不同而冲突；
 // 成本行与配件的实际价格仍使用上面的逐字段三方比较。
 const mergeConfig=(b,l,r)=>{
  if(!b||!l||!r)return merge(b,l,r);
  const fields=['taxUpdatedAt','erpImportedAt'],rows=[b,l,r].map(row=>({...row}));
  for(const row of rows)for(const field of fields)delete row[field];
  const result=merge(...rows);
  for(const field of fields){
   const present=[b,l,r].filter(row=>Object.hasOwn(row,field));if(!present.length)continue;
   const dated=present.map(row=>({value:row[field],time:typeof row[field]==='string'?Date.parse(row[field]):NaN})).filter(item=>Number.isFinite(item.time));
   result[field]=clone(dated.length?dated.reduce((latest,item)=>item.time>latest.time?item:latest).value:Object.hasOwn(l,field)?l[field]:Object.hasOwn(r,field)?r[field]:b[field]);
  }
  return result;
 };
 for(const [name,key] of Object.entries(collections)){
  const maps=[];for(const state of [base,local,remote]){const map=new Map();for(const row of state[name]||[]){map.set(row[key],row);yield;}maps.push(map);}
  const [b,l,r]=maps;result[name]=[];
  for(const id of new Set([...r.keys(),...l.keys(),...b.keys()])){
   const before=b.get(id),draft=l.get(id),receipt=r.get(id);
   // Only the live editor opts in: its rows are independent of every immutable
   // accepted/sent/history value. A remote-unchanged row can retain the live
   // object, including edits made during the request, without copying it.
   const row=ownLocalRows&&draft&&draft!==before&&draft!==receipt&&same(before,receipt)?draft:(name==='configs'?mergeConfig:merge)(before,draft,receipt);
   if(row)result[name].push(row);yield;
  }
 }
 result.shopSettings=merge(base.shopSettings,local.shopSettings,remote.shopSettings);return {state:result,conflict};
}
/** 同步完成基线、本地和远端的业务合并。 */
export const mergeEditingState=(base,local,remote)=>finishStateWork(editingStateWork(base,local,remote));
/** 分片运行同一合并规则，使大工作区更新不长时间阻塞输入。 */
export const mergeEditingStateAsync=(base,local,remote,options)=>finishStateWorkAsync(editingStateWork(base,local,remote,options),options);
// A successful save receipt has already passed the server's concurrency check.
// Differences introduced by normalization on that receipt are not a second
// editor. Keep keystrokes made while the request was in flight.
/** 以已发送快照为基准，把保存期间的新编辑保留到回执状态上。 */
export function rebaseSavedReceipt(sent,current,receipt){
 return mergeEditingState(sent,current,receipt).state;
}
