/** 按需配置加载：启动持有摘要索引，详情按 ID 获取；已编辑配置可固定在缓存中。 */
import {restoreConfigOrder} from './config-order.js';

const partialStates=new WeakSet();
const loadedRecords=new WeakSet();
/** 标记只有部分详情的工作区，避免摘要被误当成完整业务状态保存。 */
export const markPartialWorkspace=state=>(partialStates.add(state),state);
/** 完整保存和备份前拒绝仍只含部分详情的状态。 */
export function assertCompleteWorkspace(state){if(partialStates.has(state))throw Error('工作区详情尚未全部载入，不能执行完整保存或备份');}
/** 增量保存只接受由详情接口登记的基线，且每批限制为 1 至 64 套。 */
export function assertLoadedChanges(changes){
 if(!Array.isArray(changes)||!changes.length||changes.length>64)throw Error('单次保存须包含 1 至 64 套完整配置');
 for(const change of changes)if(!loadedRecords.has(change.base)||change.base.id!==change.id||change.after?.id!==change.id||!Array.isArray(change.after.parts)||!Array.isArray(change.after.actualParts)||!Array.isArray(change.after.modules))throw Error('配置详情尚未载入，已阻止保存摘要');
}
/** 用远端完整列表补齐局部基线与草稿中尚未加载的配置。 */
export function completeWorkspaceViews(base,local,remote){
 const combine=rows=>{const byId=new Map(rows.map(c=>[c.id,c])),seen=new Set(remote.configs.map(c=>c.id));return [...remote.configs.map(c=>byId.get(c.id)||c),...rows.filter(c=>!seen.has(c.id))];};
 return {base:{...base,configs:combine(base.configs)},local:{...local,configs:combine(local.configs)}};
}

// Index records are never editable documents. Only configs/load replies enter
// the detail cache, and generation/revision fences reject late replies.
/** 维护摘要、详情缓存和正在请求的批次；版本或代次改变后拒绝旧响应。 */
export function createLazyWorkspace({request,limit=16}){
 let index=null,generation=0,known=new Set();const cache=new Map(),pending=new Map();
 const install=value=>{if(!value||!Array.isArray(value.summaries)||!value.metadata)throw Error('工作区索引格式无效');generation++;cache.clear();pending.clear();index={...value,summaries:restoreConfigOrder(value.summaries)};known=new Set(index.summaries.map(row=>row.id));return index;};
 async function refresh(){return install(await request('/api/workspace/index'));}
 /** 已有详情直接复用；同一 ID 的并发点击共享请求，完整响应校验通过后才进入缓存。 */
 async function load(ids,{cacheResults=true}={}){
  if(!index)throw Error('工作区尚未载入');
  const token=generation,revision=index.revision,unique=[...new Set(ids)],result=new Map();
  if(unique.some(id=>!known.has(id)))throw Error('配置已变化，请刷新列表后重试');
  for(const id of unique)if(cache.has(id)){const value=cache.get(id);cache.delete(id);cache.set(id,value);result.set(id,value);}
  const missing=unique.filter(id=>!result.has(id));
  for(let offset=0;offset<missing.length;offset+=64){
   const chunk=missing.slice(offset,offset+64),batch=chunk.filter(id=>!pending.has(id));
   if(batch.length){
    // Register before awaiting so repeated clicks share one request. Each
    // pending batch belongs to a single revision/generation, never a new index.
    const flight=Promise.resolve().then(()=>request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:batch,revision})})).then(reply=>{
     if(token!==generation||reply.revision!==revision)throw Object.assign(Error('载入期间版本已变化，请重试'),{status:409});
     if(!Array.isArray(reply.configs)||reply.configs.length!==batch.length||new Set(reply.configs.map(c=>c.id)).size!==batch.length||reply.configs.some(c=>!batch.includes(c.id)))throw Error('配置详情不完整，未应用本次载入');
     const rows=new Map();for(const row of reply.configs){loadedRecords.add(row);rows.set(row.id,row);}return rows;
    }).finally(()=>{for(const id of batch)if(pending.get(id)===flight)pending.delete(id);});
    for(const id of batch)pending.set(id,flight);
   }
   const flights=chunk.map(id=>pending.get(id));
   for(const [i,rows] of (await Promise.all(flights)).entries())result.set(chunk[i],rows.get(chunk[i]));
   if(token!==generation)throw Object.assign(Error('载入期间版本已变化，请重试'),{status:409});
  }
  if(token!==generation)throw Object.assign(Error('载入期间版本已变化，请重试'),{status:409});
  if(cacheResults)for(const id of unique){cache.delete(id);cache.set(id,result.get(id));}
  return unique.map(id=>result.get(id));
 }
 /** 按缓存顺序淘汰未固定项，当前编辑配置由 pinned 保护。 */
 function prune(pinned=[]){const protectedIds=new Set(pinned);for(const id of [...cache.keys()]){if(cache.size<=limit)break;if(!protectedIds.has(id))cache.delete(id);}return new Set(cache.keys());}
 /** 保存成功后推进索引版本并更新已保存详情，失效旧请求但保留可继续编辑的数据。 */
 function confirm(revision,updatedAt,configs){generation++;pending.clear();index={...index,revision,updatedAt};const updated=new Map(configs.map(c=>[c.id,c]));index.summaries=index.summaries.map(summary=>updated.has(summary.id)?summaryOf(updated.get(summary.id)):summary);for(const row of configs){loadedRecords.add(row);cache.delete(row.id);cache.set(row.id,row);}}
 /** 为确实需要全量的操作分批读取详情，不把全库永久塞入交互缓存。 */
 async function full(){const configs=await load(index.summaries.map(c=>c.id),{cacheResults:false});return{...index.metadata,revision:index.revision,updatedAt:index.updatedAt,configs};}
 return{refresh,install,load,prune,confirm,full,index:()=>index,cachedIds:()=>[...cache.keys()]};
}

/** 只提取列表展示与定位需要的字段，摘要不能代替详情参与保存。 */
export function summaryOf(config){
 const row={};for(const key of ['id','shopId','shop','productId','product','productUrl','spu','productCategory','productCardColor','name','version','shortName','skuId','installment','deletedAt','workspaceOrder','emptyLinkDraft','price','updatedAt','isTemplate','templateId'])if(Object.hasOwn(config,key))row[key]=config[key];
 row.parts=(config.parts||[]).map(({slot,name,qty,goodsId})=>({slot,name,qty,goodsId}));
 if(config.wpsImport?.lineStart!=null)row.wpsImport={lineStart:config.wpsImport.lineStart};return row;
}
