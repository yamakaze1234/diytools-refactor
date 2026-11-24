/** NAS 试验入口草稿：按服务和成员隔离，保留服务器版本、提交编号和完整原提交正文。 */
import {NasApiError,nasOperationsCapability,receiptNotFound,receiptLookupError,originalVersionRejected} from './nas-api-client.js';
import {effectiveNasAddons} from './addon-data.js';
const clone=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const knownRejection=new Set(['VALIDATION_FAILED','VERSION_CONFLICT','DEPENDENCY_CONFLICT','INVALID_DEPENDENCY',
 'OPERATION_REUSED','NOT_FOUND','CONFIGURATION_EXISTS','INVALID_CONFIGURATION_STATE','QUOTATION_REVIEW_REQUIRED','SKU_ALREADY_USED',
 'FORBIDDEN','UNAUTHENTICATED','WRITES_DISABLED','INVALID_REQUEST','INVALID_CONTENT_TYPE','PAYLOAD_TOO_LARGE']);
/** 补齐此前编辑产生的空行编号。对重复编号优先保留原来所属槽位的行。 */
export function ensureNasPartLineIds(document,base){
 for(const key of ['parts','actualParts']){
  if(!Array.isArray(document[key]))continue;
  const originalSlots=new Map((base?.[key]||[]).map(part=>[part.lineId,part.slot]));
  const owners=new Map();
  for(const part of document[key]){
   if(part.lineId&&(!owners.has(part.lineId)||owners.get(part.lineId).slot!==originalSlots.get(part.lineId)&&part.slot===originalSlots.get(part.lineId)))
    owners.set(part.lineId,part);
  }
  for(const part of document[key]){
   if(!part.lineId||owners.get(part.lineId)!==part)part.lineId=crypto.randomUUID();
  }
 }
 return document;
}
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
 // 跟随组的商品由来源实时展开，必须与服务端核算使用相同规则；404 来源交由保存接口判断是否有效。
 const resource=(type,id)=>{
  const key=JSON.stringify([type,id]);
  if(!memo.has(key))memo.set(key,client.resource(type,id).catch(error=>{
   if(error.status===404)return null;
   throw error;
  }));
  return memo.get(key);
 };
 const sources=new Map();
 for(const id of new Set(document.addons.filter(addon=>addon.followPolicy==='follow'&&addon.sourceId).map(addon=>addon.sourceId))){
  const value=await resource('sources',id);
  if(value)sources.set(id,value.document);
 }
 parts.push(...dependencyParts({parts:[],actualParts:[],addons:effectiveNasAddons(document.addons,sources).filter(row=>row.available).map(row=>row.addon)}));
 for(const [type,field] of [['sources','sourceId'],['costs','goodsId']]){
  const known=result[type];
  for(const id of new Set(parts.map(x=>x[field]).filter(Boolean)))if(!Object.hasOwn(known,id)){
   const value=await resource(type,id);
   // 原配件的归档来源可由详情提供权威版本；新选的无效来源仍交给服务端明确拒绝。
   if(!value&&type==='sources')throw new NasApiError('INVALID_DEPENDENCY',400,{field:'sources.sourceId'});
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
    // 只补新请求的正文。已经提交或待查回执的原请求保持原字节。
    body.document=ensureNasPartLineIds(clone(record.document),record.base);
    body.dependencies=await nasDependencies(client,body.document,record.dependencies);
   }
   for(let refreshed=0;;refreshed++){
    persist({...record,pending:{action,body:clone(body)}});
    try{
     const result=await submitPending();
     return refreshed?{...result,dependenciesRefreshed:true}:result;
    }catch(error){
     // 仅重建明确拒绝且已清除 pending 的请求；未知回执和 retry() 永远保留原编号、原正文。
     if(error.code!=='DEPENDENCY_CONFLICT'||error.status!==409||record.pending||refreshed>=2||
        !['create','replace'].includes(action))throw error;
     let freshBase={sources:{},costs:{}};
     if(action==='replace'){
      if(typeof record.version!=='string'||!/^[1-9]\d{0,18}$/.test(record.version))throw error;
      const detail=await client.detail(record.id,{archived:remote?.archived===true});
      if(detail?.document?.id!==record.id||detail.document.shopId!==shopId)throw new NasApiError('INVALID_API_RESPONSE');
      // 不推进配置基线；同一套配置被别人保存时必须转回人工处理。
      if(detail.version!==record.version)throw new NasApiError('VERSION_CONFLICT',409,{current_version:detail.version});
      freshBase=detail.dependencies;
     }else if(record.version!==null)throw error;
     body.dependencies=await nasDependencies(client,body.document,freshBase);
     persist({...record,dependencies:clone(body.dependencies)});
     body.operation_id=uuid();
    }
   }
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
 // 编号事务只推进名称基线，价格、数量和其它本机编辑继续保留。
 function persistConfirmedMetadata(name,before,next){
  try{
   const saved=JSON.parse(storage.getItem(name)||'null');
   // 其它窗口可能已经保存新的草稿或未知请求，只更新仍与当前基线一致的持久记录。
   if(saved&&same(saved,before)){
    if(same(next.base,next.document))storage.removeItem(name);else storage.setItem(name,JSON.stringify(next));
   }
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 }
 function acceptRenumber(row){
  if(!owner||working)return false;
  const loaded=record?.id===row.configuration_id,name=prefix()+JSON.stringify(row.configuration_id);
  let saved=loaded?record:null;
  if(!loaded)try{saved=JSON.parse(storage.getItem(name)||'null');}catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
  if(!saved||saved.format!==1||saved.id!==row.configuration_id||saved.document?.id!==saved.id||saved.document.shopId!==shopId||
     saved.pending||saved.version!==row.previous_version||saved.base?.name!==row.before)return false;
  const next=clone(saved);next.version=row.version;next.base.name=row.name;
  if(next.document.name===row.before)next.document.name=row.name;
  // 重开后尚未载入的草稿也接续确认版本，不读取远端来覆盖本机输入。
  persistConfirmedMetadata(name,saved,next);
  if(loaded)record=next;
  if(loaded&&remote?.version===row.previous_version)remote={...remote,version:row.version,document:{...remote.document,name:row.name}};
  return true;
 }
 // 明确同步输出源时只接续本次预览核实的来源依赖；配置版本、其它成本和本机输入保持原样。
 function acceptSourceVersions(versions){
  if(!record||record.pending||working)return false;
  if(Object.values(versions).some(value=>typeof value!=='string'||!/^[1-9]\d{0,18}$/.test(value)))throw new NasApiError('INVALID_API_RESPONSE');
  const next=clone(record);
  for(const [id,version] of Object.entries(versions))if(Object.hasOwn(next.dependencies.sources,id))next.dependencies.sources[id]=version;
  persistConfirmedMetadata(key,record,next);record=next;
  return true;
 }
 /** 本次来源保存后的已读投影只接续干净配置；草稿和未知请求仍保持原依赖。 */
 function acceptObservedDependencies(versions){
  if(!record||record.pending||working||!same(record.base,record.document))return false;
  for(const kind of ['sources','costs'])if(Object.values(versions[kind]||{}).some(value=>typeof value!=='string'||!/^[1-9]\d{0,18}$/.test(value)))throw new NasApiError('INVALID_API_RESPONSE');
  const next=clone(record);
  for(const kind of ['sources','costs'])for(const [id,version] of Object.entries(versions[kind]||{}))if(Object.hasOwn(next.dependencies[kind],id))next.dependencies[kind][id]=version;
  // 这里只接续当前窗口的已读基线，不清理其它窗口可能写入的同配置草稿。
  record=next;return true;
 }
 return {verify,open,resume,create,edit,compare,abandonForRemote,save,receipt,retry,read,drafts,discardArchived,acceptRenumber,acceptSourceVersions,acceptObservedDependencies};
}
