/** 按 NAS 服务、成员和资源保留原提交编号；只有显式重试才重放原请求。 */
import {NasApiError,receiptNotFound,receiptLookupError,originalVersionRejected,migrationNotInstalled} from './nas-api-client.js';
const known=new Set(['WRITES_DISABLED','FORBIDDEN','CATALOG_SHARED_READ_ONLY','INVALID_REQUEST','INVALID_IMAGE','INVALID_CONTENT_TYPE',
 'PAYLOAD_TOO_LARGE','VALIDATION_FAILED','CATALOG_EXISTS','NOT_FOUND','INVALID_CONFIGURATION_STATE','OPERATION_REUSED','VERSION_CONFLICT',
 'CATALOG_IN_USE','SHARED_SOURCE_VALUE_REQUIRED','SHARED_SOURCE_EDITOR_REQUIRED','IMAGE_UPLOAD_DISABLED','UNAUTHENTICATED','ERP_SOURCE_ARCHIVED']);
const pendingOp=(kind,id)=>JSON.stringify([kind,id]);
export function createNasCatalogController({client,storage,scope,shopId='intel',uuid=()=>crypto.randomUUID()}){
 const prefix='diy-nas-catalog:'+JSON.stringify(scope)+':',flights=new Map();
 const read=key=>{
  try{return JSON.parse(storage.getItem(prefix+key)||'null');}
  catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 };
 const persist=(key,operation)=>{
  try{if(operation)storage.setItem(prefix+key,JSON.stringify(operation));else storage.removeItem(prefix+key);}
  catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 };
 function pending(){
  const result=[];
  try{
   for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(key?.startsWith(prefix)){
     const row=read(key.slice(prefix.length));if(row?.operationId)result.push(row);
    }
   }
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
  return result;
 }
 function verify(result,op){
  if(result?.kind!==op.kind||result?.operation_id!==op.operationId||result?.resource_id!==op.resultId||
   result?.shop_id!==shopId||result?.archived!==(op.action==='archive')||typeof result.version!=='string'||!/^[1-9]\d{0,18}$/.test(result.version))
   throw new NasApiError('SAVE_STATUS_UNKNOWN');
  if(op.kind==='assets'&&(result.document?.sha256!==op.digest||result.document?.url!==op.resultId))
   throw new NasApiError('SAVE_STATUS_UNKNOWN');
  return result;
 }
 async function confirmReceipt(op){
  const key=pendingOp(op.kind,op.id);
  const result=verify(await client.catalogReceipt(op.operationId),op);
  if(read(key)?.operationId===op.operationId)persist(key,null);
  return result;
 }
 async function receipt(op){
  const key=pendingOp(op.kind,op.id);
  if(flights.has(key))throw new NasApiError('SAVE_IN_PROGRESS');
  const flight=confirmReceipt(op);flights.set(key,flight);
  try{return await flight;}catch(error){throw receiptLookupError(error);}finally{flights.delete(key);}
 }
 async function imageDetails(file){
  if(!file||!['image/png','image/jpeg'].includes(file.type)||file.size>24*1024*1024)throw new NasApiError('ORIGINAL_IMAGE_REQUIRED');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const sum=await crypto.subtle.digest('SHA-256',bytes);
  const digest=[...new Uint8Array(sum)].map(ch=>ch.toString(16).padStart(2,'0')).join('');
  return {bytes,digest,path:'/uploads/'+digest+(file.type==='image/png'?'.png':'.jpg')};
 }
 async function retry(op,file){
  const key=pendingOp(op.kind,op.id);
  if(flights.has(key))throw new NasApiError('SAVE_IN_PROGRESS');
  const original=read(key);
  if(original?.operationId!==op.operationId)throw new NasApiError('CATALOG_PENDING_RESOLVED');
  const flight=(async()=>{
   try{return await confirmReceipt(original);}catch(error){if(!receiptNotFound(error))throw error;}
   let result;
   try{
    if(original.kind==='assets'){
     // 浏览器只暂存上传摘要。用户重选同一文件，重新算字节摘要并以原编号发送。
     const {bytes,digest,path}=await imageDetails(file);
     if(digest!==original.digest||path!==original.resultId)throw new NasApiError('ORIGINAL_IMAGE_REQUIRED');
     let binary='';
     for(let i=0;i<bytes.length;i+=16*1024)binary+=String.fromCharCode(...bytes.subarray(i,i+16*1024));
     result=await client.uploadImage({mime:file.type,base64:btoa(binary),operationId:original.operationId});
    }else{
     if(!original.body)throw new NasApiError('INVALID_DRAFT');
     result=await client.saveCatalog(original.kind,original.id,original.action,{...original.body,operation_id:original.operationId});
    }
   }catch(error){if(originalVersionRejected(error)&&read(key)?.operationId===original.operationId)persist(key,null);throw error;}
   verify(result,original);if(read(key)?.operationId===original.operationId)persist(key,null);return result;
  })();
  flights.set(key,flight);
  try{return await flight;}finally{flights.delete(key);}
 }
 async function execute(op,send,sameDraft){
  const key=pendingOp(op.kind,op.id);
  if(flights.has(key))throw new NasApiError('SAVE_IN_PROGRESS');
  const prior=read(key);
  const flight=(async()=>{
   if(prior){
    const result=await confirmReceipt(prior).catch(error=>{throw receiptLookupError(error);});
    if(!sameDraft(prior))throw new NasApiError('CATALOG_PENDING_RESOLVED');
    return result;
   }
   persist(key,op);
   let result;
   try{result=await send();}
   catch(error){if(known.has(error.code)&&error.status>=400&&error.status<500||migrationNotInstalled(error))persist(key,null);throw error;}
   verify(result,op);persist(key,null);return result;
  })();
  flights.set(key,flight);
  try{return await flight;}finally{flights.delete(key);}
 }
 function save(kind,id,action,body){
  const operationId=uuid();
  const op={kind,id,operationId,action,body,resultId:action==='copy'?body.target_id:id};
  return execute(op,()=>client.saveCatalog(kind,id,action,{...body,operation_id:operationId}),
   previous=>previous.action===action&&JSON.stringify(previous.body)===JSON.stringify(body));
 }
 async function upload(file,base64){
  const {digest,path}=await imageDetails(file),operationId=uuid();
  const op={kind:'assets',id:path,resultId:path,operationId,digest,action:'upload'};
  return execute(op,()=>client.uploadImage({mime:file.type,base64,operationId}),prior=>prior.digest===digest);
 }
 return {list:(kind,id)=>client.catalog(kind,id),save,upload,pending,receipt,retry};
}
