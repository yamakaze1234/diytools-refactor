/** 输出源计划只使用已保存 NAS 资料，单步收据由原生任务日志记录。 */
import {nasShopIds,nasOperationsCapability,receiptNotFound} from './nas-api-client.js';
import {sourceSheetEffective,sourceSheetDefaultTax} from './source-sheet-model.js';
import {sourceFields} from './shared-source-fields.js';
import {excludedComponent} from './component-policy.js';
import {erpCategoryFields,validateSnapshot} from './erp-sync.js';
import {splitErpName} from './erp-part-description.js';
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {validatedSourceRequest,effectiveSourceFields,patchSource,fail,version,nextVersion} from './agent-source-fields.js';
import {planSourceFollow,sourceStepSummary} from './agent-source-follow.js';

const own=(v,k)=>Object.hasOwn(v,k);
const catalogStep=(shopId,catalogKind,resourceId,action,body)=>({kind:'catalog',shopId,catalogKind,resourceId,action,body});
const byteSize=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const stale=()=>fail('REVISION_CONFLICT','来源、价格或依赖版本已变化，请重新预览');
const denied=()=>fail('FORBIDDEN','当前账号没有目标店铺所需的 NAS 运营写权限');
function checkRow(wrapper,shop,id){
 const doc=wrapper?.document;
 if(!doc||wrapper.id!==id||doc.sourceId!==id||!version(wrapper.version))fail('INVALID_API_RESPONSE','来源身份或版本无效');
 if(doc.shopId===shop)return doc;
 // 老目录的文档可能未写 shopId。只有服务端证明本店独占时才能补齐身份。
 if((doc.shopId==null||doc.shopId==='')&&wrapper.owner_shop===shop&&wrapper.shared===false)return {...doc,shopId:shop};
 fail('INVALID_API_RESPONSE','输出源店铺身份与目标不符');
}
function manualSource(wrapper,shop){
 // 跨店可见的旧共享行不能冒充本店独享来源；普通本店修改走已有目录授权。
 if(wrapper.owner_shop!==shop||wrapper.shared!==false||wrapper.editable!==true)denied();
}
function checkCapability(me,request,shop,kind){
 const ids=request.scope==='shared'?nasShopIds:[request.shopId];
 for(const id of ids){
  const cap=nasOperationsCapability(me,id);
  if(!cap?.catalog_writes||(request.scope==='shared'||request.action==='adopt_erp')&&!cap.shared_sources)denied();
 }
 const cap=nasOperationsCapability(me,shop);
 if(!cap||kind==='costs'&&!cap.workspace_writes||request.action==='adopt_erp'&&request.scope==='shop'&&!cap.workspace_writes||
   kind==='configurations'&&!(request.followConfigs&&cap.workspace_writes&&cap.configuration_writes))denied();
 return cap;
}
async function observedErp(api,request){
 let rows;
 try{rows=validateSnapshot(await api.readErp('erp-catalog',undefined,request.shopId));}
 catch(error){
  if(['FORBIDDEN','MEMBER_CHANGED','UNAUTHENTICATED'].includes(error.code))throw error;
  fail('ERP_UNAVAILABLE','ERP 商品目录暂不可用，无法核验建源货号');
 }
 const row=rows.find(row=>row.goodsId===request.goodsId);
 if(!row)fail('NOT_FOUND','ERP 未找到精确货号');
 if(excludedComponent(row))fail('SOURCE_EXCLUDED','带星号的 ERP 商品不能建源');
 return row;
}
async function tableTax(api,goods,shop,required){
 let result;
 try{result=await api.readErp('tax-current',[goods],shop);}
 catch(e){
  if(['FORBIDDEN','UNAUTHENTICATED','MEMBER_CHANGED'].includes(e.code))throw e;
  if(required)fail('ERP_UNAVAILABLE','成本表暂不可用，已保留手工核算价');
  return null;
 }
 if(!Array.isArray(result?.rows))fail('INVALID_API_RESPONSE','成本表查询结果无效');
 const rows=result.rows.filter(row=>row.goods_id===goods);
 if(rows.length>1||rows.length===1&&(!Number.isFinite(rows[0].tax)||rows[0].tax<0))fail('INVALID_API_RESPONSE','成本表价格重复或无效');
 if(!rows.length&&required)fail('NOT_FOUND','成本表中没有有效核算价，已保留手工核算价');
 return rows[0]?.tax??null;
}
async function createStep(api,r,client){
 const shop=r.shopId,fields=effectiveSourceFields(r);
 if(r.action==='create_special'){
  if((await client.catalog('shared-sources')).some(x=>x.id?.startsWith('special:')&&x.document?.common?.name===fields.name))
   fail('CATALOG_EXISTS','三店已有相同名称的特殊来源');
  const id='special:'+crypto.randomUUID();
  return catalogStep(shop,'shared-sources',id,'create',{document:{id,edits:{shared:{values:{name:fields.name},restore:[]}}}});
 }
 const erp=await observedErp(api,r),id=r.goodsId;
 const sources=await client.catalog('sources');
 if(sources.some(x=>x.document?.shopId===shop&&x.document.goodsId===id&&!x.document.deletedAt))fail('CATALOG_EXISTS','本店已有该货号来源，请按 sourceId 编辑');
 if(sources.some(x=>x.id==='erp:'+shop+':'+id&&x.document.deletedAt))fail('ERP_SOURCE_ARCHIVED','原 ERP 来源已停用，请使用恢复');
 const name=fields.name??splitErpName(erp.name).main;
 const explicit=own(fields,'tax');
 const defaults=explicit?{tax:fields.tax,taxMode:'manual'}:sourceSheetDefaultTax(await tableTax(api,id,shop,false),erp.erp);
 let document;
 if(r.scope==='shared'){
  const existing=await client.catalog('shared-sources');
  if(existing.some(x=>x.id===id))fail('CATALOG_EXISTS','已有该货号的共用目录，请维护原来源');
  document={id,erpName:erp.name,...erpCategoryFields(erp),...(defaults.taxMode?{taxMode:defaults.taxMode}:{}),
   edits:{shared:{values:{...fields,name,tax:defaults.tax},restore:[]}}};
 }else{
  document={id,name,erpAdoption:{name:erp.name,erp:erp.erp,sku:erp.sku??'',stockAvailable:erp.stockAvailable,
   stockIncomingAvailable:erp.stockIncomingAvailable??null,...erpCategoryFields(erp),
   ...(defaults.taxMode==='default_table'?{tableTax:defaults.tax}:{}),...(explicit||defaults.tax==null?{taxOverride:defaults.tax}:{})}};
 }
 return catalogStep(shop,'shared-sources',id,'create',{document});
}
function containsId(value,id){
 return typeof value==='string'?value===id:!!value&&typeof value==='object'&&Object.values(value).some(v=>containsId(v,id));
}
async function lifecycleStep(client,r,wrapper){
 const shop=r.shopId;
 manualSource(wrapper,shop);
 if(!!wrapper.document.deletedAt!==(r.action==='restore'))fail('INVALID_CATALOG_STATE','输出源的当前停用状态与请求不符');
 if(r.action==='archive'){
  const [uses,templates]=await Promise.all([client.sourceUsage([r.sourceId],[]),client.catalog('templates')]);
  if(!Array.isArray(uses)||!Array.isArray(templates))fail('INVALID_API_RESPONSE','来源引用查询结果无效');
  if(uses.length||templates.some(t=>containsId(t.document?.configs??t.document?.configurations,r.sourceId)))
   fail('CATALOG_IN_USE','已有配置或模板引用此来源，无法停用');
 }
 const prior=wrapper.document.shopId===shop?[]:[catalogStep(shop,'sources',r.sourceId,'replace',{
  expected_version:wrapper.version,document:checkRow(wrapper,shop,r.sourceId)})];
 // 旧目录的归档/恢复端点原样校验文档，不能给已归档行直接补 shopId。
 if(prior.length&&r.action==='restore')fail('LEGACY_SOURCE_SHOP_MISSING','该已停用旧来源缺少店铺字段，当前 NAS 恢复端点无法确认，请核对目录记录');
 return [...prior,catalogStep(shop,'sources',r.sourceId,r.action,{expected_version:prior.length?nextVersion(wrapper.version):wrapper.version})];
}
// 已确认的收费模式只在当前店价格记录变化时递增。配置引用使用这次来源事务之后的版本。
function managedCostVersion(cost,v,values,mode){
 const unique=[...new Set(values.map(x=>JSON.stringify(x)))];
 if(unique.length!==1||values[0]===undefined||(!cost&&values[0]===null))return v;
 const tax=values[0],changed=cost?.tax!==tax||mode!==undefined&&
  (cost?.nasManualTax!==mode||cost?.nasTaxOverride!==true||own(cost??{},'nasProvisionalTax'));
 return changed?nextVersion(v):v;
}
async function editedSource(api,r,ctx,cap,wrapper){
 const shop=r.shopId,doc=checkRow(wrapper,r.shopId,r.sourceId),steps=[],projections=new Map();
 const fields=effectiveSourceFields(r),restore=r.restoreFields??[];
 if(doc.deletedAt)fail('INVALID_CATALOG_STATE','已停用来源须先恢复');
 if(doc.specialComponent&&(Object.keys(fields).some(k=>k!=='name')||restore.some(k=>k!=='name')||r.resumeTax))fail('INVALID_PARAMS','特殊配件仅支持编辑名称');
 if(excludedComponent(doc))fail('SOURCE_EXCLUDED','带星号的来源不可维护');
 const managed=cap.shared_sources?(await ctx.client.catalog('shared-sources')).find(x=>x.document?.stores?.[shop]?.some(a=>a.sourceId===doc.sourceId)):null;
 if(doc.sharedSourceId&&!managed)fail('SHARED_SOURCE_UNAVAILABLE','来源已绑定共用目录，请核对共用目录能力和成员权限');
 if(!managed&&r.scope==='shared')fail('SHARED_SOURCE_UNAVAILABLE','此历史来源尚未关联三店共用条目');
 const defaultTax=r.resumeTax?await tableTax(api,doc.goodsId,shop,true):null;
 let resumeBaseline=null;
 if(managed){
  if(!version(managed.version)||managed.document?.id!==managed.id)fail('INVALID_API_RESPONSE','共用目录身份或版本无效');
  const edits={};
  if(Object.keys(fields).length)edits[r.scope==='shared'?'shared':shop]={values:fields,restore:[]};
  if(restore.length){
   if(restore.some(k=>!own(managed.document.common,k)))fail('SHARED_SOURCE_VALUE_REQUIRED','所选字段还没有共用基准值');
   edits[shop]={values:{},restore};
  }
  if(Object.keys(edits).length)steps.push(catalogStep(shop,'shared-sources',managed.id,'replace',{expected_version:managed.version,document:{id:managed.id,edits}}));
  if(!r.followConfigs&&!r.resumeTax)return {steps,projections};
  const affected=own(edits,'shared')?nasShopIds:[shop];
  for(const target of affected){
   const client=target===shop?ctx.client:(await api.access(target)).client;
   const aliases=managed.document.stores[target]??[];
   const relevant=[];
   for(let i=0;i<aliases.length;i+=6)relevant.push(...await Promise.all(aliases.slice(i,i+6).map(a=>client.catalog('sources',a.sourceId))));
   const catalog=await client.workspaceCatalog(),cost=catalog.costSource.find(c=>c.goodsId===doc.goodsId);
   let priceVersion=catalog.costVersions?.[doc.goodsId]??null;
   const rows=relevant.map((w,i)=>{
    const before=checkRow(w,target,aliases[i].sourceId);
    if(target===shop&&w.id===wrapper.id&&w.version!==wrapper.version)stale();
    const effective=sourceSheetEffective({entry:managed.document,base:before},{edits},before);
    const baseline=sourceFields(before);
    const changed=Object.fromEntries(Object.entries(sourceFields(effective)).filter(([k,v])=>!equal(baseline[k],v)));
    const after=patchSource(before,changed);
    return {before,after,sourceVersion:equal(before,after)?w.version:nextVersion(w.version)};
   });
   if(Object.keys(edits).length){
    const explicitTax=own(fields,'tax')&&(r.scope==='shop'||!aliases.some(a=>own(a.fields,'tax')));
    const mode=explicitTax?fields.tax!==null:undefined;
    priceVersion=managedCostVersion(cost,priceVersion,rows.map(p=>p.after.tax),mode);
   }
   if(target===shop&&r.resumeTax){
    if(cost?.nasManualTax!==true)fail('INVALID_PARAMS','当前配件没有可恢复的手工核算价');
    resumeBaseline=priceVersion;
    for(const p of rows){
     if(p.after.tax!==defaultTax&&cost.tax!==defaultTax){
      p.after={...p.after,tax:defaultTax};p.sourceVersion=nextVersion(p.sourceVersion);
     }
    }
    priceVersion=nextVersion(priceVersion);
   }
   projections.set(target,rows.filter(p=>!p.before.deletedAt).map(p=>({...p,costVersion:priceVersion})));
  }
 }else{
  manualSource(wrapper,shop);
  const catalog=await ctx.client.workspaceCatalog(),cost=catalog.costSource.find(c=>c.goodsId===doc.goodsId);
  if(r.resumeTax&&cost?.nasManualTax!==true)fail('INVALID_PARAMS','当前配件没有可恢复的手工核算价');
  const values={...fields,...(r.resumeTax?{tax:defaultTax}:{})};
  const after=patchSource(doc,values);
  const save=!equal(wrapper.document,after);
  if(save)steps.push(catalogStep(shop,'sources',doc.sourceId,'replace',{expected_version:wrapper.version,document:{...after,updatedAt:new Date().toISOString()}}));
  resumeBaseline=catalog.costVersions?.[doc.goodsId]??null;
  let priceVersion=resumeBaseline;
  if(own(values,'tax')&&(r.resumeTax||cost?.tax!==values.tax||cost?.nasManualTax!==true)){
   priceVersion=nextVersion(priceVersion);
   if(!r.resumeTax)steps.push({kind:'costs',shopId:shop,action:'tax_edit',resourceId:doc.goodsId,body:{changes:[{
    id:doc.goodsId,action:'tax_edit',expected_version:resumeBaseline,fields:{tax:values.tax,taxUpdatedAt:new Date().toISOString()}}]}});
  }
  projections.set(shop,[{before:doc,after,sourceVersion:save?nextVersion(wrapper.version):wrapper.version,costVersion:priceVersion}]);
 }
 if(r.resumeTax)steps.push({kind:'costs',shopId:shop,action:'tax_resume',resourceId:doc.goodsId,body:{changes:[{id:doc.goodsId,
  action:'tax_resume',expected_version:resumeBaseline,fields:{tax:defaultTax,taxUpdatedAt:new Date().toISOString()}}]}});
 return {steps,projections};
}

/** 所有回执先核对店铺、业务种类、操作编号和每一项预期版本，仅向任务日志交付必要字段。 */
function verifyReceipt(step,op,value){
 const invalid=()=>fail('SAVE_UNCONFIRMED','NAS 回执与冻结步骤不一致，请按原编号核对');
 const kind=step.catalogKind??step.kind;
 if(value?.operation_id!==op||value.shop_id!==step.shopId||value.kind!==kind)invalid();
 const out={operation_id:op,shop_id:step.shopId,kind};
 if(step.kind==='catalog'){
  if(value.resource_id!==step.resourceId||!version(value.version)||value.archived!==(step.action==='archive')||
    step.body.expected_version&&value.version!==nextVersion(step.body.expected_version))invalid();
  if(step.body.document?.erpAdoption&&(!value.document?.sourceId||value.document.id!==step.resourceId||value.document.version!==value.version))invalid();
  if(step.catalogKind==='sources'&&step.action==='replace'&&!equal(value.document,step.body.document))invalid();
  if(step.catalogKind==='shared-sources'&&value.document?.id!==step.resourceId)invalid();
  return {...out,resource_id:value.resource_id,version:value.version,archived:value.archived,
   ...(value.document?.sourceId?{sourceId:value.document.sourceId}:{})};
 }
 const key=step.kind==='configurations'?'configuration_id':'id';
 if(!Array.isArray(value.changes)||value.changes.length!==step.body.changes.length)invalid();
 const changes=value.changes.map((row,i)=>{
  const frozen=step.body.changes[i];
  if(row?.[key]!==frozen.id||row.version!==nextVersion(frozen.expected_version)||
    step.kind==='configurations'&&(row.operation_id!==op||row.shop_id!==step.shopId||row.archived!==false))invalid();
  return {[key]:frozen.id,version:row.version};
 });
 return {...out,changes};
}
export function createAgentSources(api){
 async function preview(params){
  const r=validatedSourceRequest(params.request),ctx=await api.access(r.shopId),me=await ctx.client.me();
  const cap=checkCapability(me,r,r.shopId,'catalog');
  const steps=[],follow=[];
  if(['adopt_erp','create_special'].includes(r.action))steps.push(await createStep(api,r,ctx.client));
  else{
   const wrapper=await ctx.client.catalog('sources',r.sourceId);
   checkRow(wrapper,r.shopId,r.sourceId);
   if(r.action==='edit'){
    const edited=await editedSource(api,r,ctx,cap,wrapper);
    steps.push(...edited.steps);
    if(r.followConfigs){
     for(const [shop,projections] of edited.projections){
      checkCapability(me,r,shop,'configurations');
      const client=shop===r.shopId?ctx.client:(await api.access(shop)).client;
      const linked=await planSourceFollow(client,shop,projections);
      steps.push(...linked.steps);follow.push(linked.summary);
     }
    }
   }else steps.push(...await lifecycleStep(ctx.client,r,wrapper));
  }
  for(const s of steps){
   checkCapability(me,r,s.shopId,s.kind);
   if(byteSize(s.body)+100>1024*1024)fail('PLAN_TOO_LARGE','单步来源维护正文超过 NAS 限制');
  }
  return {plan:{shop:r.shopId,request:structuredClone(r),steps},summary:{shopId:r.shopId,scope:r.scope,action:r.action,
   workbenchSourceHasPending:!!api.sourceHasPending(),steps:steps.map(s=>sourceStepSummary(s,r)),follow}};
 }
 async function checkDrafts(steps){
  if(api.sourceHasPending())fail('UNSAVED_DRAFT','输出源工作表仍有未保存修改，请先保存或放弃');
  const ids=new Map();
  for(const s of steps)if(s.kind==='configurations')ids.set(s.shopId,[...(ids.get(s.shopId)??[]),...s.body.changes.map(c=>c.id)]);
  for(const [shop,configIds] of ids)await (await api.access(shop)).assertDrafts(configIds);
 }
 async function apply(job){
  const {plan,stepStates}=job.params,r=validatedSourceRequest(plan.request);
  if(plan.shop!==r.shopId||!Array.isArray(stepStates)||stepStates.length!==plan.steps.length)fail('INVALID_PLAN','缺少来源步骤日志');
  const receipts=[];let checked=false;
  for(const [index,step] of plan.steps.entries()){
   const state=stepStates[index];
   if(state.index!==index||!state.operationId||!['confirmed','submitted','pending'].includes(state.state))fail('INVALID_PLAN','来源步骤状态无效');
   if(state.state==='confirmed'){receipts.push(state.receipt);continue;}
   const ctx=await api.access(step.shopId),client=ctx.client,op=state.operationId;
   let receipt;
   if(state.state==='submitted'){
    try{receipt=verifyReceipt(step,op,step.kind==='catalog'?await client.catalogReceipt(op):await client.workspaceReceipt(op));}
    catch(e){if(!receiptNotFound(e))throw e;}
   }
   if(!receipt){
    checkCapability(await client.me(),r,step.shopId,step.kind);
    if(!checked){await checkDrafts(plan.steps);checked=true;}
    if(api.sourceHasPending())fail('UNSAVED_DRAFT','输出源工作表仍有未保存修改');
    if(step.kind==='configurations')await ctx.assertDrafts(step.body.changes.map(c=>c.id));
    if(r.action==='adopt_erp')await observedErp(api,r);
    // 提交前重新核权并记录“已发送”；同一冻结正文始终配合同一个子编号。
    await api.native('preflight',{id:job.id,shopId:step.shopId,stepIndex:index});
    const body={...step.body,operation_id:op};
    const result=step.kind==='catalog'?await client.saveCatalog(step.catalogKind,step.resourceId,step.action,body):await client.workspaceWrite(step.kind,body);
    receipt=verifyReceipt(step,op,result);
   }
   await api.native('step.confirm',{id:job.id,stepIndex:index,receipt});
   receipts.push(receipt);
  }
  let uiRefreshed=false;
  const active=api.activeShop?.()??plan.shop;
  // 共用目录的改动也可出现在另一店正打开的工作表中；只重读前台店铺。
  if(plan.steps.some(s=>s.shopId===active||s.catalogKind==='shared-sources')){
   try{uiRefreshed=await api.refresh(active,undefined,{sources:true});}catch{/* 界面重载不改变已确认收据。 */}
  }
  return {shopId:plan.shop,nasSave:receipts.length?'saved':'unchanged',partialSuccess:false,receipts,uiRefreshed};
 }
 return {preview,apply};
}
