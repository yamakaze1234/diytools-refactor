/** 跨批操作按原工作区、服务和账号持久保存；重试仅重放选中的原批次。 */
import {NasApiError,receiptNotFound,receiptLookupError,originalVersionRejected,migrationNotInstalled} from './nas-api-client.js';
const known=new Set(['INVALID_REQUEST','INVALID_CONTENT_TYPE','PAYLOAD_TOO_LARGE','VALIDATION_FAILED','PRODUCT_MEMBERS_CHANGED',
 'DEPENDENCY_CONFLICT','INVALID_DEPENDENCY','VERSION_CONFLICT','QUOTATION_REVIEW_REQUIRED','CONFIGURATION_EXISTS',
 'NOT_FOUND','INVALID_CONFIGURATION_STATE','OPERATION_REUSED','WRITES_DISABLED','FORBIDDEN','UNAUTHENTICATED','SKU_ALREADY_USED',
 'QUOTATION_NOT_AVAILABLE','QUOTATION_IDENTITY_MISMATCH']);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const maxBody=1024*1024;
// 只清已经确认的价格字段。相同基线下的新修改接续已确认版本，其他基线不自动更新。
export function acknowledgeNasPriceDraft(plan,drafts,equal=Object.is){
 const saved=new Map(plan.batches.filter(batch=>batch.status==='done').flatMap(batch=>
  batch.body.changes.map((change,i)=>[change.id,{change,version:batch.result.changes[i].version}])));
 return drafts.flatMap(row=>{
  const confirmed=saved.get(row.id);
  if(!confirmed||row.expected_version!==confirmed.change.expected_version)return [row];
  const fields=Object.fromEntries(Object.entries(row.fields).filter(([key,value])=>!equal(value,confirmed.change.document?.[key])));
  return Object.keys(fields).length?[{...row,fields,expected_version:confirmed.version}]:[];
 });
}
export function buildNasOperationPlan(kind,changes,{group=null,title='',uuid=()=>crypto.randomUUID()}={}){
 if(!changes.length)throw new NasApiError('NO_CHANGES');
 const batches=[],id=uuid();
 let items=[];
 const body=(changes,operation_id)=>({operation_id,changes,...(group?{group}:{})});
 const placeholder='0'.repeat(36);
 let bytes=size(body([],placeholder));
 for(const item of changes){
  const count=size(item);
  if(size(body([item],placeholder))>maxBody)throw new NasApiError('PLAN_ITEM_TOO_LARGE');
  if(items.length===100||bytes+count+1>maxBody){
   batches.push({status:'ready',body:body(items,uuid())});items=[];bytes=size(body([],placeholder));
  }
  bytes+=count+(items.length?1:0);items.push(item);
 }
 if(items.length)batches.push({status:'ready',body:body(items,uuid())});
 if(group&&batches.length!==1)throw new NasApiError('GROUP_PLAN_TOO_LARGE');
 return {id,kind,title,batches,total:changes.length};
}
/** IndexedDB 保存大型批次正文，不让全店操作挤占配置草稿的本机存储。 */
export function nasPlanStorage(driver=globalThis.indexedDB){
 let connected;
 const connect=()=>connected??=new Promise((resolve,reject)=>{
  if(!driver)return reject(new NasApiError('DRAFT_STORAGE_UNAVAILABLE'));
  const request=driver.open('diy-nas-operation-plans',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('plans');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(new NasApiError('DRAFT_STORAGE_UNAVAILABLE'));
 });
 const use=async(key,value,mode)=>{
  const db=await connect();
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('plans',mode),store=tx.objectStore('plans');
   const req=mode==='readonly'?store.get(key):value===null?store.delete(key):store.put(value,key);
   tx.oncomplete=()=>resolve(mode==='readonly'?req.result??null:undefined);
   tx.onerror=tx.onabort=()=>reject(new NasApiError('DRAFT_STORAGE_UNAVAILABLE'));
  });
 };
 return {get:key=>use(key,null,'readonly'),put:(key,value)=>use(key,value,'readwrite')};
}
export function createNasOperationQueue({client,storage,key,shopId='intel',lock=globalThis.navigator?.locks}){
 let busy=false;
 const read=()=>storage.get(key);
 const persist=record=>storage.put(key,record);
 const run=async action=>{
  if(busy)throw new NasApiError('SAVE_IN_PROGRESS');
  busy=true;
  try{return await (lock?lock.request('diy-nas-plan:'+key,action):action());}
  finally{busy=false;}
 };
 const verify=(plan,batch,value)=>{
  if(value?.shop_id!==shopId||value?.kind!==plan.kind||value?.operation_id!==batch.body.operation_id||
   !Array.isArray(value.changes)||value.changes.length!==batch.body.changes.length||
   !value.changes.every((row,i)=>{
    const expected=batch.body.changes[i];
    return (row.configuration_id??row.id)===expected.id&&typeof row.version==='string'&&/^[1-9]\d{0,18}$/.test(row.version)&&
     (plan.kind!=='configurations'||row.archived===(expected.action==='archive'));
   }))throw new NasApiError('SAVE_STATUS_UNKNOWN');
  return value;
 };
 async function finish(plan,batch,receipt){
  batch.result=verify(plan,batch,receipt);
  batch.status='done';
  // 编号会推进同链接剩余配置的版本，只接续尚未送出的批次；未知/被拒绝正文仍保持原样。
  if(plan.kind==='configurations')for(const row of batch.result.changes.flatMap(change=>change.reordered??[])){
   for(const later of plan.batches.filter(next=>next.status==='ready'))for(const change of later.body.changes){
    if(change.id!==row.configuration_id||change.expected_version!==row.previous_version)continue;
    change.expected_version=row.version;
    if(change.document?.name===row.before)change.document.name=row.name;
   }
  }
  await persist(plan);return batch.result;
 }
 function add(plan){return run(async()=>{
  if(await read())throw new NasApiError('WORKSPACE_PLAN_PENDING');
  await persist(plan);return plan;
 });}
 function submit(onProgress=()=>{}){return run(async()=>{
  const plan=await read();if(!plan)throw new NasApiError('NO_CHANGES');
  if(plan.batches.some(batch=>batch.status==='unknown'))throw new NasApiError('SAVE_STATUS_UNKNOWN');
  for(const batch of plan.batches){
   if(batch.status==='done')continue;
   if(batch.status==='rejected')break;
   // 写入未知检查点完成后才能发请求。关闭窗口也不能丢掉原操作号。
   batch.status='unknown';await persist(plan);
   let receipt;
   try{receipt=await client.workspaceWrite(plan.kind,batch.body);}
   catch(error){
    if(known.has(error?.code)&&error.status>=400&&error.status<500||migrationNotInstalled(error)){
     batch.status='rejected';batch.error={code:error.code,details:error.details};await persist(plan);
    }
    throw error;
   }
   await finish(plan,batch,receipt);await onProgress(plan);
  }
  return plan;
 });}
 function receipt(){return run(async()=>{
  const plan=await read(),batch=plan?.batches.find(row=>row.status==='unknown');
  if(!batch)throw new NasApiError('NO_CHANGES');
  await finish(plan,batch,await client.workspaceReceipt(batch.body.operation_id).catch(error=>{throw receiptLookupError(error);}));return plan;
 });}
 function retry(){return run(async()=>{
  const plan=await read(),batch=plan?.batches.find(row=>row.status==='unknown');
  if(!batch)throw new NasApiError('NO_CHANGES');
  let result;
  try{result=await client.workspaceReceipt(batch.body.operation_id);}
  catch(error){
   if(!receiptNotFound(error))throw error;
   // 保留原批号和正文；确认后其余批次仍留待用户继续。
   try{result=await client.workspaceWrite(plan.kind,batch.body);}
   catch(rejected){
    if(originalVersionRejected(rejected)){
     batch.status='rejected';batch.error={code:rejected.code,details:rejected.details};await persist(plan);
    }
    throw rejected;
   }
  }
  await finish(plan,batch,result);return plan;
 });}
 function clear(){return run(async()=>{
  const plan=await read();if(plan?.batches.some(row=>row.status==='unknown'))throw new NasApiError('SAVE_STATUS_UNKNOWN');
  await persist(null);
 });}
 return {read,add,submit,receipt,retry,clear};
}
