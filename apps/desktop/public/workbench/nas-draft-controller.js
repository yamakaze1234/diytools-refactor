/** NAS 试验入口草稿：按服务和成员隔离，保留服务器版本、提交编号和完整原提交正文。 */
import {NasApiError,nasOperationsCapability,receiptNotFound,receiptLookupError,originalVersionRejected} from './nas-api-client.js';
const clone=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const knownRejection=new Set(['VALIDATION_FAILED','VERSION_CONFLICT','DEPENDENCY_CONFLICT','INVALID_DEPENDENCY',
 'OPERATION_REUSED','NOT_FOUND','CONFIGURATION_EXISTS','INVALID_CONFIGURATION_STATE','QUOTATION_REVIEW_REQUIRED','SKU_ALREADY_USED',
 'FORBIDDEN','UNAUTHENTICATED','WRITES_DISABLED','INVALID_REQUEST','INVALID_CONTENT_TYPE','PAYLOAD_TOO_LARGE']);
const dependencyParts=document=>{
 const parts=[...document.parts,...document.actualParts];
 const add=addon=>{
  for(const item of [addon,...(addon?.items||[]),...(addon?.choices||[])])if(typeof item?.goodsId==='string'&&item.goodsId)
   parts.push({goodsId:item.goodsId});
  for(const child of (addon?.variants||[]))if(child&&typeof child==='object')add(child);
 };
 for(const addon of document.addons)add(addon);
 for(const addon of document.addons)if(addon.followPolicy==='follow'&&addon.sourceId)parts.push({sourceId:addon.sourceId});
 return parts;
};
/** 已见依赖版本保留；只读取新引用，避免准备批处理时把已过时的版本换成新版本。 */
export async function nasDependencies(client,document,prior={sources:{},costs:{}},memo=new Map()){
 const result=clone(prior),parts=dependencyParts(document);
 for(const [type,field] of [['sources','sourceId'],['costs','goodsId']]){
  const known=result[type];
  for(const id of new Set(parts.map(x=>x[field]).filter(Boolean)))if(!Object.hasOwn(known,id)){
   const key=JSON.stringify([type,id]);
   if(!memo.has(key))memo.set(key,client.resource(type,id).catch(error=>{
    if(type==='costs'&&error.status===404)return null;
    throw error;
   }));
   const value=await memo.get(key);
   if(value)Object.defineProperty(known,id,{value:value.version,writable:true,enumerable:true,configurable:true});
  }
 }
 return result;
}

export function createNasDraftController({client,storage,endpointId,shopId='intel',uuid=()=>crypto.randomUUID()}){
 let owner=null,key=null,record=null,configurationId=null,remote=null,working=false;
 const read=()=>record?clone(record):null;
 const persist=value=>{
  if(!key)throw new NasApiError('UNAUTHENTICATED',401);
  try{if(value)storage.setItem(key,JSON.stringify(value));else storage.removeItem(key);}
  catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
  record=value;
 };
 async function verify(){
  const me=await client.me();
  const capability=nasOperationsCapability(me,shopId);
  if(!capability)
   throw new NasApiError('FORBIDDEN',403);
  const next=JSON.stringify([endpointId,me.workspace_id,me.uid]);
  if(owner&&owner!==next)throw new NasApiError('MEMBER_CHANGED',403);
  owner=next;client.bindIdentity?.(me.workspace_id,me.uid);
  // 旧顶层写能力仅表示英特尔；保存与原回执重试必须使用本店的最新授权。
  return {...me,configuration_writes:capability.configuration_writes===true};
 }
 function useKey(id){
  key=prefix()+JSON.stringify(id);
  configurationId=id;
  record=null;remote=null;
  try{
   const saved=JSON.parse(storage.getItem(key)||'null');
   if(saved&&saved.id===id&&saved.document?.id===id&&saved.document?.shopId===shopId&&saved.format===1)record=saved;
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 }
 const prefix=()=>'diy-nas-draft:'+owner+':';
 function drafts(){
  if(!owner)return [];
  const result=[];
  try{
   for(let i=0;i<storage.length;i++){
    const name=storage.key(i);
    if(!name?.startsWith(prefix()))continue;
    const value=JSON.parse(storage.getItem(name));
    if(value?.format===1&&value.id===value.document?.id&&value.document?.shopId===shopId)result.push({id:value.id,name:value.document.name,version:value.version,pending:!!value.pending});
   }
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
  return result;
 }
 // 回收站确认后，仅清本账号、本店且早于归档版本的草稿。保留待查回执及恢复后新建的草稿。
 function discardArchived(id,archivedVersion){
  if(!owner)return;
  const name=prefix()+JSON.stringify(id);
  try{
   const saved=JSON.parse(storage.getItem(name)||'null');
   if(saved?.format===1&&saved.id===id&&saved.document?.id===id&&saved.document.shopId===shopId&&
      !saved.pending&&/^[1-9]\d{0,18}$/.test(saved.version)&&BigInt(saved.version)<BigInt(archivedVersion))storage.removeItem(name);
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 }
 async function open(id,{archived=false}={}){
  if(working)throw new NasApiError('SAVE_IN_PROGRESS');
  await verify();useKey(id);
  try{
   const detail=await client.detail(id,{archived});
   if(detail?.document?.shopId!==shopId||detail?.document?.id!==id)throw new NasApiError('INVALID_API_RESPONSE');
   remote=detail;
   if(!record)record={format:1,id,version:remote.version,dependencies:remote.dependencies,base:remote.document,document:remote.document,pending:null};
  }catch(error){if(!record)throw error;}
  return {record:read(),remote:remote?clone(remote):null};
 }
 // 保存未打开的持久草稿只取该账号的本机原版本，不以远端详情覆盖草稿。
 async function resume(id){
  if(working)throw new NasApiError('SAVE_IN_PROGRESS');
  if(!owner)await verify();
  if(configurationId!==id||!record)useKey(id);
  return read();
 }
 async function create(document){
  if(document?.shopId!==shopId)throw new NasApiError('INVALID_DRAFT');
  await verify();useKey(document.id);
  if(record)throw new NasApiError('DRAFT_ALREADY_EXISTS');
  persist({format:1,id:document.id,version:null,base:null,dependencies:{sources:{},costs:{}},document:clone(document),pending:null});
  return read();
 }
 function edit(document){
  if(!record||record.pending||working||document?.id!==configurationId||document?.shopId!==shopId)throw new NasApiError('INVALID_DRAFT');
  const next={...record,document:clone(document)};
  if(next.version&&same(next.base,next.document)){persist(null);record=next;}
  else persist(next);
  return read();
 }
 async function compare(){
  await verify();
  if(!record||!record.version)throw new NasApiError('INVALID_DRAFT');
  const detail=await client.detail(record.id,{archived:remote?.archived===true});
  if(detail?.document?.shopId!==shopId||detail?.document?.id!==record.id)throw new NasApiError('INVALID_API_RESPONSE');
  remote=detail;
  return {base:clone(record.base),remote:clone(remote),draft:clone(record.document)};
 }
 function abandonForRemote(){
  if(working||record?.pending||!remote)throw new NasApiError('INVALID_DRAFT');
  const next={format:1,id:record.id,version:remote.version,dependencies:remote.dependencies,base:remote.document,document:remote.document,pending:null};
  persist(null);record=next;
  return read();
 }
 async function finish(receipt){
  if(receipt?.configuration_id!==record?.id||receipt?.shop_id!==shopId||
   receipt?.operation_id!==record?.pending?.body.operation_id||
   typeof receipt.version!=='string'||!/^[1-9]\d{0,18}$/.test(receipt.version)||
   receipt.archived!==(record.pending.action==='archive'))
   throw new NasApiError('SAVE_STATUS_UNKNOWN');
  // 已确认回执后先落本机检查点；详情回读中断也不能把已提交误判为未保存。
  const submitted=record.pending.body.document||record.document;
  const next={...record,version:receipt.version,dependencies:record.pending.body.dependencies||record.dependencies,base:submitted,document:submitted,pending:null};
  persist(null);record=next;
  return receipt;
 }
 async function submitPending(replay=false){
  const pending=record.pending;
  let receipt;
  try{receipt=await client.save(pending.action,record.id,pending.body);}
  catch(error){
   if(replay?originalVersionRejected(error):knownRejection.has(error.code)&&error.status>=400&&error.status<500)
    persist({...record,pending:null});
   throw error;
  }
  return finish(receipt);
 }
 async function save(action=record?.version?'replace':'create'){
  if(working||!record||record.pending)throw new NasApiError('SAVE_IN_PROGRESS');
  if(['archive','restore'].includes(action)&&!same(record.base,record.document))throw new NasApiError('UNSAVED_DRAFT');
  working=true;
  try{
   const member=await verify();
   if(!member.configuration_writes)throw new NasApiError('WRITES_DISABLED',405);
   if(action==='replace'&&same(record.base,record.document))throw new NasApiError('NO_CHANGES');
   const body={operation_id:uuid(),...(record.version?{expected_version:record.version}:{})};
   if(['create','replace'].includes(action)){
    body.document=clone(record.document);
    body.dependencies=await nasDependencies(client,body.document,record.dependencies);
   }
   persist({...record,pending:{action,body}});
   return await submitPending();
  }finally{working=false;}
 }
 async function receipt(){
  if(working||!record?.pending)throw new NasApiError('INVALID_DRAFT');
  working=true;
  try{await verify();return await finish(await client.receipt(record.pending.body.operation_id).catch(error=>{throw receiptLookupError(error);}));}
  finally{working=false;}
 }
 async function retry(){
  if(working||!record?.pending)throw new NasApiError('INVALID_DRAFT');
  working=true;
  try{
   const member=await verify();
   try{return await finish(await client.receipt(record.pending.body.operation_id));}
   catch(error){if(!receiptNotFound(error))throw error;}
   if(!member.configuration_writes)throw new NasApiError('WRITES_DISABLED',405);
   return await submitPending(true);
  }finally{working=false;}
 }
 return {verify,open,resume,create,edit,compare,abandonForRemote,save,receipt,retry,read,drafts,discardArchived};
}
