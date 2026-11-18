/** 将原主编辑器数据接到 NAS。保留原业务文档，显示兼容值不自动变成保存内容。 */
import {createNasApiClient,NasApiError,nasShopIds,nasOperationsCapability} from './nas-api-client.js';
import {createNasDraftController,ensureNasPartLineIds,nasDependencies} from './nas-draft-controller.js';
import {createNasCatalogController} from './nas-catalog-controller.js';
import {createNasOperationQueue,nasPlanStorage} from './nas-operation-plan.js';
const dup=value=>structuredClone(value);
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(o,k)=>Object.hasOwn(o,k);
const equal=(a,b)=>{
 if(Object.is(a,b))return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
 if(obj(a)&&obj(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>own(b,k)&&equal(a[k],b[k]));
 return false;
};
export const sameNasDocument=equal;
export const visibleNasAddons=(list,fallback)=>Array.isArray(list)&&list.length===fallback.length?list.map(row=>dup(row.addon)):fallback;
const itemId=value=>obj(value)?(value.lineId??value.id):undefined;
const keyed=array=>array.length>0&&array.every(x=>typeof itemId(x)==='string'&&itemId(x))&&new Set(array.map(itemId)).size===array.length;

/** 只写编辑器输入相对显示基线改变的节点；按行 ID 对齐 BOM、素材、模块，重排不丢未显示字段。 */
export function projectNasEdits(raw,visible,edited){
 if(equal(visible,edited))return dup(raw);
 if(obj(visible)&&obj(edited)){
  const next=obj(raw)?dup(raw):{};
  for(const key of new Set([...Object.keys(visible),...Object.keys(edited)])){
   if(['__proto__','prototype','constructor'].includes(key)||equal(visible[key],edited[key])&&own(visible,key)===own(edited,key))continue;
   if(!own(edited,key))delete next[key];
   else next[key]=own(visible,key)?projectNasEdits(raw?.[key],visible[key],edited[key]):dup(edited[key]);
  }
  return next;
 }
 if(Array.isArray(visible)&&Array.isArray(edited)){
  if(keyed(visible)&&(edited.length===0||keyed(edited))){
   const byId=new Map(visible.map(row=>[itemId(row),row])),byRaw=new Map((Array.isArray(raw)?raw:[]).map(row=>[itemId(row),row]));
   return edited.map(row=>byId.has(itemId(row))?projectNasEdits(byRaw.get(itemId(row)),byId.get(itemId(row)),row)??dup(row):dup(row));
  }
  if(visible.length===edited.length&&Array.isArray(raw)&&raw.length===visible.length)
   return edited.map((row,i)=>projectNasEdits(raw[i],visible[i],row));
 }
 return dup(edited);
}
const guard=(data,condition)=>{if(!condition)throw new NasApiError(data,503);};
export const nasMainMode=search=>new URLSearchParams(search).get('workspace')==='nas';
const versionNumber=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value);
export function nasTimeStamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;
}

// 每套独立确认。只读核验旧回执优先；有结果未知或全局失败时不再发送新正文。
const independentSaveRejections=new Set(['VERSION_CONFLICT','DEPENDENCY_CONFLICT','VALIDATION_FAILED',
 'INVALID_DEPENDENCY','NOT_FOUND','QUOTATION_REVIEW_REQUIRED','SKU_ALREADY_USED','PAYLOAD_TOO_LARGE']);
export async function submitNasDraftSet(rows,{submit,isPending,onProgress=()=>{}}){
 const ordered=[...rows.filter(row=>row.pending),...rows.filter(row=>!row.pending)];
 const results=[];let stopped=false;
 for(const row of ordered){
  let result;
  if(stopped)result={...row,status:'unsent'};
  else try{result={...row,status:'saved',receipt:await submit(row)};}
  catch(error){
   const pending=isPending(row.id)??row.pending;
   if(error.code==='NO_CHANGES'&&!pending)result={...row,status:'unchanged'};
   else{
    result={...row,status:pending?'pending':'failed',error};
    stopped=pending||!independentSaveRejections.has(error.code);
   }
  }
  results.push(result);
  // 进度呈现不参与回执确认，界面更新失败也不能改写本次逐项结果。
  try{onProgress(results.length);}catch{}
 }
 return results;
}

export function createNasMainWorkspace({nativeRequest,storage,createClient=createNasApiClient,planStorage=nasPlanStorage(),requestedShop=null}){
 let member=null,endpoint=null,catalogScope=null,identity=null,lookup=null,index=null,meta=null,closed=false,begin=null,catalogController=null;
 let queue=null,shopId=null,availableShops=[],capability=null;
 let client=createClient({nativeRequest});
 const controllers=new Map(),openings=new Map(),editors=new Map();
 const validate=()=>{if(closed)throw new NasApiError('MEMBER_CHANGED',403);};
 const ready=()=>{validate();if(!member)throw new NasApiError('UNAUTHENTICATED',401);return member;};
 async function initialize(){
  if(begin)return begin;
  begin=(async()=>{
   const response=await nativeRequest('/settings',{method:'GET'}),settings=await response.json();
   guard('NAS_NOT_CONFIGURED',response.ok&&settings.configured&&settings.main_editor&&typeof settings.endpoint_id==='string');
   const me=await client.me();validate();
   if(typeof settings.deployment_id==='string'&&me.deployment_id!==settings.deployment_id)
    throw new NasApiError('NAS_DEPLOYMENT_MISMATCH',409);
   availableShops=nasShopIds.filter(shop=>nasOperationsCapability(me,shop));
   guard('FORBIDDEN',typeof me.uid==='string'&&me.uid&&typeof me.workspace_id==='string'&&me.workspace_id&&availableShops.length);
   // 已撤销的店铺不发送业务请求；切回第一个仍获授权的店铺。
   shopId=availableShops.includes(requestedShop)?requestedShop:availableShops[0];
   capability=nasOperationsCapability(me,shopId);
   if(shopId!=='intel')client=createClient({nativeRequest,shopId});
   // 保留原英特尔的持久草稿键；新店采用各自键，重叠 ID 不会串店。
   catalogScope=settings.endpoint_id;
   endpoint=settings.endpoint_id+':main'+(shopId==='intel'?'':':'+shopId);
   identity=JSON.stringify([me.workspace_id,me.uid]);
   member=me;client.bindIdentity(me.workspace_id,me.uid);
   lookup=createNasDraftController({client:owned,storage,endpointId:endpoint,shopId});
   catalogController=createNasCatalogController({client:owned,storage,scope:[endpoint,me.workspace_id,me.uid],shopId});
   queue=createNasOperationQueue({client:owned,storage:planStorage,key:JSON.stringify([endpoint,me.workspace_id,me.uid]),shopId});
   await lookup.verify();
   return member;
  })().catch(error=>{begin=null;throw error;});
  return begin;
 }
 async function call(fn){
  ready();
  try{const value=await fn();validate();return value;}
  catch(error){if(error.code==='MEMBER_CHANGED'||error.code==='UNAUTHENTICATED')closed=true;throw error;}
 }
 // 原生桥接在实际送出每个请求前核对预期成员；此处禁止活跃主工作台重新绑定到另一成员。
 // 同一批并发详情共享正在进行的身份查询，完成即失效，下一批仍重新核权。
 let memberFlight=null;
 const owned={
  me:()=>memberFlight??=(async()=>{
   const verified=await call(()=>client.me());
   if(JSON.stringify([verified.workspace_id,verified.uid])!==identity){closed=true;throw new NasApiError('MEMBER_CHANGED',403);}
   if(!nasOperationsCapability(verified,shopId))throw new NasApiError('FORBIDDEN',403);
   return verified;
  })().finally(()=>{memberFlight=null;}),
  bindIdentity:()=>{},
  detail:(...args)=>call(()=>client.detail(...args)),
  resource:(...args)=>call(()=>client.resource(...args)),
  receipt:(...args)=>call(()=>client.receipt(...args)),
  save:(...args)=>call(()=>client.save(...args)),
  catalog:(...args)=>call(()=>client.catalog(...args)),
  saveCatalog:(...args)=>call(()=>client.saveCatalog(...args)),
  catalogReceipt:(...args)=>call(()=>client.catalogReceipt(...args)),
  workspaceWrite:(...args)=>call(()=>client.workspaceWrite(...args)),
  workspaceReceipt:(...args)=>call(()=>client.workspaceReceipt(...args)),
  uploadImage:(...args)=>call(()=>client.uploadImage(...args))
 };
 const controller=id=>{
  if(!controllers.has(id))controllers.set(id,createNasDraftController({client:owned,storage,endpointId:endpoint,shopId}));
  return controllers.get(id);
 };
 async function open(id){
  ready();
  if(openings.has(id))return openings.get(id);
  const ctrl=controller(id);
  const load=ctrl.open(id).then(({record,remote})=>{
   validate();
   const document=record?.document;
   guard('INVALID_API_RESPONSE',document?.id===id&&document.shopId===shopId&&Array.isArray(document.parts)&&Array.isArray(document.actualParts)&&Array.isArray(document.addons));
   // 被淘汰后再次加载可以收到不同原文；本次归一化必须建立自己的显示基线。
   const effective=remote&&equal(remote.document,document)?remote.effective_addons:null;
   editors.set(id,{raw:dup(document),visible:null,remoteVersion:remote?.version??null,effective});
   return dup(document);
  }).finally(()=>openings.delete(id));
  openings.set(id,load);return load;
 }
 async function refresh(){
  await initialize();
  const [head,catalog]=await Promise.all([call(()=>client.workspaceIndex()),call(()=>client.workspaceCatalog())]);
  guard('INVALID_API_RESPONSE',typeof head?.revision==='string'&&Array.isArray(head.summaries)&&
    head.summaries.every(c=>c?.shopId===shopId&&typeof c.id==='string'&&Array.isArray(c.parts))&&
    new Set(head.summaries.map(row=>row.id)).size===head.summaries.length&&catalog?.shopSettings?.[shopId]&&
    Array.isArray(catalog?.sourceCatalog)&&Array.isArray(catalog?.costSource));
  index=head;meta={...catalog,dataVersion:3};return {...head,metadata:meta};
 }
 async function request(path,options={}){
  if(path==='/api/workspace/index')return refresh();
  if(path==='/catalog.json')return [];
  if(path==='/api/session'){
   const user=await initialize();return {defaultOperator:user.uid,configured:true};
  }
  if(path==='/api/configs/load'&&options.method==='POST'){
   const {ids,revision}=JSON.parse(options.body);
   guard('INVALID_API_RESPONSE',index&&revision===index.revision&&Array.isArray(ids)&&ids.length<=64&&ids.every(id=>index.summaries.some(row=>row.id===id)));
   const result=[];
   // 连续编辑的同一链接可加载多套；分组限制并发原生网络与链接压力。
   for(let i=0;i<ids.length;i+=6)result.push(...await Promise.all(ids.slice(i,i+6).map(open)));
   validate();return {revision,configs:result};
  }
  throw new NasApiError('NAS_FEATURE_UNAVAILABLE',403);
 }
 function attach(config){
  const row=editors.get(config.id);if(row&&!row.visible)row.visible=dup(config);
 }
 // 店铺显示偏好不是逐套重写文档；同时调整编辑投影基线，避免下次改名误提交显示值。
 function applyPresentation(config,transform){
  const row=editors.get(config.id);if(row?.visible)transform(row.visible);transform(config);
 }
 function stage(config){
  ready();
  const row=editors.get(config.id),ctrl=controllers.get(config.id);
  if(!row?.visible||!ctrl||config.shopId!==shopId)throw new NasApiError('INVALID_DRAFT');
  const proposed=projectNasEdits(row.raw,row.visible,config);
  if(!equal(proposed,ctrl.read().document))ctrl.edit(proposed);
  return ctrl.read();
 }
 function pendingState(id){const record=controllers.get(id)?.read();return record?!!record.pending:null;}
 const pending=id=>pendingState(id)===true;
 function serverVersion(id){
  // 配置原文里的 version 是业务版号，草稿基线也可能落后；显示值只取服务端观测。
  const details=editors.get(id)?.remoteVersion;
  const summary=index?.summaries.find(row=>row.id===id)?.nasVersion;
  if(!versionNumber(details))return versionNumber(summary)?summary:null;
  if(!versionNumber(summary))return details;
  return BigInt(details)>=BigInt(summary)?details:summary;
 }
 async function serverDataTime(){
  const activity=await call(()=>client.activity());
  guard('INVALID_API_RESPONSE',Array.isArray(activity));
  // 审计首条覆盖同工作区所有运营的已入库写入；仅在成功确认没有操作时才采用导入时间。
  const firstImport=activity.length===0;
  const updatedAt=nasTimeStamp(firstImport?index?.updatedAt:activity[0]?.created_at);
  guard('INVALID_API_RESPONSE',firstImport||updatedAt!==null);
  return {updatedAt,firstImport:Boolean(updatedAt&&firstImport)};
 }
 function conflict(id){
  const row=editors.get(id),rec=controllers.get(id)?.read();
  return Boolean(row?.remoteVersion&&rec&&row.remoteVersion!==rec.version);
 }
 async function submitDraft(id,{config=null,retry=false}={}){
  ready();
  if(openings.has(id))await openings.get(id);
  const ctrl=controller(id);
  let current=ctrl.read()||await ctrl.resume(id);
  // 仅允许完整详情的已登记显示态参与投影；未载入的草稿直接使用持久原文。
  if(!editors.get(id)?.visible)config=null;
  const matches=document=>document?.id===id&&document.shopId===shopId&&
   ['parts','actualParts','addons'].every(key=>Array.isArray(document[key]));
  guard('INVALID_DRAFT',typeof id==='string'&&id&&current?.id===id&&matches(current.document)&&versionNumber(current.version)&&
   (!config||matches(config))&&(!retry||current.pending)&&
   (!current.pending||current.pending.action==='replace'&&matches(current.pending.body?.document)&&
    typeof current.pending.body.operation_id==='string'&&current.pending.body.expected_version===current.version));
  if(!current.pending&&config)current=stage(config);
  const submittedVisible=config&&dup(config);
  let result;
  try{result=current.pending?await (retry?ctrl.retry():ctrl.receipt()):await ctrl.save();}
  catch(error){
   if(error.code==='VERSION_CONFLICT'&&error.details?.current_version&&editors.has(id))editors.get(id).remoteVersion=error.details.current_version;
   throw error;
  }
  // 保存回执已确认后再更新编辑器兼容投影的基线；未知状态保留原基线。
  if(editors.has(id))editors.set(id,{raw:ctrl.read().document,visible:submittedVisible,remoteVersion:result.version});
  if(config&&!equal(submittedVisible,config))stage(config);
  return result;
 }
 const submit=(config,{retry=false}={})=>submitDraft(config.id,{config,retry});
 async function compare(id){
  const ctrl=controllers.get(id);
  if(!ctrl)throw new NasApiError('INVALID_DRAFT');
  const result=await ctrl.compare();
  if(editors.has(id))editors.get(id).remoteVersion=result.remote.version;
  return result;
 }
 function useServer(id){
  const ctrl=controllers.get(id);if(!ctrl)throw new NasApiError('INVALID_DRAFT');
  const rec=ctrl.abandonForRemote();
  editors.set(id,{raw:dup(rec.document),visible:null,remoteVersion:rec.version});
  return dup(rec.document);
 }
 const drafts=()=>lookup?.drafts()||[];
 const release=id=>{if(!openings.has(id)){editors.delete(id);controllers.delete(id);}};
 const close=()=>{closed=true;editors.clear();controllers.clear();openings.clear();};
 function documentFor(config){
  const row=editors.get(config.id);
  if(!row?.visible)throw new NasApiError('INVALID_DRAFT');
  return projectNasEdits(row.raw,row.visible,config);
 }
 function editorAddons(id,fallback){
  return visibleNasAddons(editors.get(id)?.effective,fallback);
 }
 async function configurationChanges(rows){
  const memo=new Map();
  const resolved=[];
  for(const row of rows){
   const {id,action}=row,record=controllers.get(id)?.read();
   if(action==='archive'||action==='replace'){
    // 删除只提交原服务端版本，不提交草稿；若已有保存请求在途，仍需先核实结果。
    if(action==='archive'&&record?.pending)throw new NasApiError('ARCHIVE_SAVE_PENDING');
    if(!record||action==='replace'&&(record.pending||!equal(record.base,record.document)))throw new NasApiError('UNSAVED_DRAFT');
    if(row.expected_version!=null&&record.version!==row.expected_version)throw new NasApiError('VERSION_CONFLICT',409);
   }
   if(action==='restore'||action==='archive'){
    resolved.push({id,action,expected_version:row.expected_version||record?.version});continue;
   }
   const document=action==='create'?dup(row.document):documentFor(row.document);
   guard('INVALID_DRAFT',document?.shopId===shopId);
   ensureNasPartLineIds(document,record?.base);
   const prior=record?.dependencies||{sources:{},costs:{}};
   // 仅接受本次已确认维护回执中关联来源/成本的新版本；其余依赖保持录入时版本。
   const known=row.dependencyOverrides?Object.fromEntries(['sources','costs'].map(kind=>
    [kind,{...prior[kind],...Object.fromEntries(Object.entries(row.dependencyOverrides[kind]).filter(([id])=>Object.hasOwn(prior[kind],id)))}])):prior;
   const dependencies=await nasDependencies(owned,document,known,memo);
   resolved.push({id,action,document,dependencies,...(action==='create'?{}:{expected_version:record.version})});
  }
  return resolved;
 }
 async function archived(){
  const result=[];
  for(let offset=0;;offset+=100){
   const page=await call(()=>client.list({archived:true,limit:100,offset}));
   if(!Array.isArray(page))throw new NasApiError('INVALID_API_RESPONSE');
   result.push(...page);if(page.length<100)return result;
  }
 }
 function priceDraft(next,scope=endpoint){
  ready();
  const key='diy-nas-price-draft:'+JSON.stringify([scope,identity]);
  try{
   if(next!==undefined){if(next.length)storage.setItem(key,JSON.stringify(next));else storage.removeItem(key);}
   const rows=JSON.parse(storage.getItem(key)||'[]');
   if(!Array.isArray(rows))throw Error('invalid');
   return rows;
  }catch{throw new NasApiError('DRAFT_STORAGE_UNAVAILABLE');}
 }
 function canMergePriceDraft({id,expected_version,fields}){
  const record=controllers.get(id)?.read();
  return Boolean(record&&!record.pending&&record.version===expected_version&&fields&&Object.keys(fields).length&&
   Object.entries(fields).every(([key,value])=>['price','skuId','spu','priceUpdatedAt','priceImportedAt'].includes(key)&&
    (equal(record.base[key],record.document[key])||equal(value,record.document[key]))));
 }
 function discardArchivedDrafts(changes){
  if(!changes.length)return;
  const archived=new Map(changes.map(({configuration_id,version})=>[configuration_id,version]));
  for(const [id,version] of archived)lookup.discardArchived(id,version);
  const oldPrices=priceDraft(),remaining=oldPrices.filter(({id,expected_version})=>
   !archived.has(id)||!versionNumber(expected_version)||BigInt(expected_version)>=BigInt(archived.get(id)));
  if(remaining.length!==oldPrices.length)priceDraft(remaining);
 }
 // Agent 使用当前页面的部署和身份；跨店仍重新核对 NAS 授权，并使用各店原有草稿键。
 async function agentAccess(shop){
  const verified=await owned.me(),permissions=nasOperationsCapability(verified,shop);
  if(!permissions)throw new NasApiError('FORBIDDEN',403);
  const reader=shop===shopId?client:createClient({nativeRequest,shopId:shop});
  if(reader!==client)reader.bindIdentity(member.workspace_id,member.uid);
  const scope=catalogScope+':main'+(shop==='intel'?'':':'+shop);
  return {client:reader,assertWritable(){
   if(permissions.workspace_writes!==true||permissions.configuration_writes!==true)throw new NasApiError('WRITES_DISABLED',405);
  },async assertDrafts(ids){
   const draft=shop===shopId?lookup:createNasDraftController({client:reader,storage,endpointId:scope,shopId:shop});
   if(draft!==lookup)await draft.verify();
   if([...draft.drafts(),...priceDraft(undefined,scope)].some(row=>ids.includes(row.id)))
    throw new NasApiError('UNSAVED_DRAFT',409);
   const plans=shop===shopId?queue:createNasOperationQueue({client:reader,storage:planStorage,key:JSON.stringify([scope,member.workspace_id,member.uid]),shopId:shop});
   if(await plans.read())throw new NasApiError('WORKSPACE_PLAN_PENDING',409);
  }};
 }
 async function agentIndexes(shop,head){
  const verified=await owned.me();
  return Promise.all(nasShopIds.filter(id=>nasOperationsCapability(verified,id)).map(async id=>{
   if(id===shop)return [id,head];
   const reader=createClient({nativeRequest,shopId:id});
   reader.bindIdentity(member.workspace_id,member.uid);
   return [id,await call(()=>reader.workspaceIndex())];
  }));
 }
 return {initialize,request,attach,applyPresentation,stage,pending,pendingState,conflict,submit,submitDraft,compare,useServer,drafts,release,close,documentFor,
  agentAccess,agentIndexes,agentActor:()=>closed||!member?null:[member.workspace_id,member.uid],
  shop:()=>shopId,shops:()=>[...availableShops],serverVersion,serverDataTime,serverDisplayScope:()=>JSON.stringify([endpoint,identity]),
  editorAddons,configurationVersion:id=>controllers.get(id)?.read()?.version,
  configurationChanges,archived,canMergePriceDraft,discardArchivedDrafts,checkImportImages:images=>call(()=>client.importPreview(images)),
  async readErp(kind,goodsIds=[],connection){
   return call(async()=>{
    const r=await nativeRequest('/erp-read',{method:'POST',headers:{'Content-Type':'application/json','x-workbench-nas-owner':encodeURIComponent(identity)},
     body:JSON.stringify({kind,goodsIds,shopId,...(connection?{connection}:{})})});
    const data=await r.json();if(!r.ok||!data.ok)throw Error(data.error||'ERP 只读查询失败');
    return data;
   });
  },
  costVersion:id=>meta?.costVersions?.[id]??null,settingsVersion:()=>meta?.settingsVersion??null,
  priceDraft,
  quotation:id=>call(()=>client.quotation(id)),activity:()=>call(()=>client.activity()),activityPage:query=>call(()=>client.activityPage(query)),
  profit:(action,input)=>call(()=>client.profit(action,input)),
  sourceUsage:(sources,goods)=>call(()=>client.sourceUsage(sources,goods)),
  priceHistory:(action,input)=>call(()=>client.priceHistory(action,input)),
  queue:()=>{ready();return queue;},canPlan:()=>Boolean(capability?.workspace_writes===true),
  hasSharedSources:()=>capability?.shared_sources===true,
  sharedPreviewScope:()=>JSON.stringify([catalogScope,identity]),
  sharedPreviewSnapshot:async()=>Object.fromEntries(await Promise.all(availableShops.map(async shop=>{
   const reader=shop===shopId?client:createClient({nativeRequest,shopId:shop});
   if(reader!==client)reader.bindIdentity(member.workspace_id,member.uid);
   return [shop,await call(()=>reader.workspaceCatalog())];
  }))),
  catalog:()=>{ready();return catalogController;},canManage:()=>Boolean(capability?.catalog_writes===true),canUpload:()=>Boolean(capability?.image_upload===true),
  canWrite:()=>!closed&&Boolean(capability?.configuration_writes===true)};
}

export const nasErrorText=error=>{
 const field=error?.details?.field;
 if(error?.code==='VALIDATION_FAILED'&&typeof field==='string'&&/^[A-Za-z][A-Za-z0-9._/]{0,119}$/.test(field))
  return '配置内容未通过校验（'+field+'）。';
 return ({
 MEMBER_CHANGED:'账号已切换。请重新登录；原账号草稿仍保留在本机。',UNAUTHENTICATED:'请重新登录工作台账号，草稿仍保留。',
 FORBIDDEN:'此账号没有该店铺的 NAS 运营权限。',NAS_NOT_CONFIGURED:'请检查 NAS 工作区的可信 HTTPS 地址。',
 NAS_FEATURE_UNAVAILABLE:'此功能暂未接入 NAS 工作区。',WRITES_DISABLED:'当前 NAS 接口只读。',
 NAS_DEPLOYMENT_MISMATCH:'NAS 部署标识不匹配，请使用对应的独立工作台。原草稿仍保留。',
 VERSION_CONFLICT:'服务器版本已更新，草稿已保留。请比较服务器版本后再处理。',
 PROFIT_RESULT_STALE:'配置、成本或更新的检测结果已变化，请重新检测后重设基准。',
 NAS_PROFIT_NOT_INSTALLED:'服务器尚未启用利润检测历史。',
 NAS_PRICE_HISTORY_NOT_INSTALLED:'服务器尚未启用价格变化记录。',
 DEPENDENCY_CONFLICT:'关联配件来源或成本已更新，草稿已保留。',SAVE_STATUS_UNKNOWN:'尚未确认服务器是否保存，请查询提交结果。',
 RECEIPT_NOT_FOUND:'暂未查到回执。请求可能仍在途中；可以稍后查询，或使用原编号重试。',
 NO_CHANGES:'当前配置没有需要提交的修改。',INVALID_DRAFT:'这份本机草稿无法按原版本提交，请保留后核对。',
 NOT_FOUND:'服务器上找不到这套配置或关联资料，草稿已保留。',PAYLOAD_TOO_LARGE:'这套配置超出服务端的提交大小上限，草稿已保留。',
 DRAFT_STORAGE_UNAVAILABLE:'本机草稿未能写入，请保留窗口并重试。',
 REQUEST_TIMEOUT:'连接 NAS 超时，本机草稿仍保留。',NETWORK_OR_RESPONSE_ERROR:'暂时无法连接 NAS，本机草稿仍保留。',
 QUOTATION_REVIEW_REQUIRED:'修改已有维护表报价的 SPU 或 SKU 前，请先重新核价。',
 INVALID_DEPENDENCY:'选择的配件来源不可用。',VALIDATION_FAILED:'请检查要保存的配置内容。',
 CATALOG_SHARED_READ_ONLY:'此资料为共享或其他店铺所有，当前账号只能查看。',
 SHARED_SOURCE_VALUE_REQUIRED:'该字段还没有三店共用值。请先维护共用值。',
 SHARED_SOURCE_EDITOR_REQUIRED:'请使用新版输出源维护窗口。',
 CATALOG_IN_USE:'资料仍被配置或模板引用，不能移入回收站。',
 CATALOG_PENDING_RESOLVED:'原提交已确认，请查看最新资料后再提交这次更改。',
 INVALID_IMAGE:'图片无法解码，或超过支持的尺寸。',
 IMAGE_UPLOAD_DISABLED:'当前 NAS 服务没有开放图片上传。',
 ORIGINAL_IMAGE_REQUIRED:'要重试上传，请选择最初提交的同一张 PNG 或 JPG 原图。',
 UNSAVED_DRAFT:'操作范围含未保存的配置草稿。请先保存或放弃这些草稿。',
 ARCHIVE_SAVE_PENDING:'所选配置有未确认的保存请求，请先查询保存结果，再移入回收站。',
 PRODUCT_MEMBERS_CHANGED:'商品链接的配置范围已变化，请刷新后重新核对。',
 WORKSPACE_PLAN_PENDING:'先处理上一项 NAS 批量操作，再建立新计划。',
 PLAN_ITEM_TOO_LARGE:'存在单项数据超过 1 MiB 的安全提交上限，请缩小该项后重试。',
 GROUP_PLAN_TOO_LARGE:'商品链接超出单笔原子变更上限，请缩小操作范围。',
 SKU_ALREADY_USED:'同一 SPU 下该 SKU 已有在用配置，请核对准确对应关系。',
 QUOTATION_NOT_AVAILABLE:'未确认维护表到手价，或缺少准确的 SPU/SKU。未发布给销售。',
 QUOTATION_IDENTITY_MISMATCH:'维护表行的 SPU / SKU 和当前配置不一致。',
 })[error?.code]||error?.message||'操作未完成。';
};
