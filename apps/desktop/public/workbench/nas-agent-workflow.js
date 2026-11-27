/** NAS Agent 长任务只消费正式服务端文档；与人工前台共用权限和图片渲染。 */
import {buildAgentPlan} from './agent-changes.js';
import {exportAgentSnapshot} from './agent-export.js';
import {receiptNotFound} from './nas-api-client.js';
import {nasDependencies} from './nas-draft-controller.js';
import {checkInventory,inventoryCounts} from './inventory-check-data.js';
import {inventoryLinks} from './inventory-export.js';
import {ordinaryConfigs} from './template-library.js';
import {previewAgentDraft,applyAgentDraft} from './agent-drafts.js';
import {createAgentSources} from './agent-sources.js';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const stale=()=>fail('REVISION_CONFLICT','NAS 配置或工作区已变化，请重新查询、预览');
const goodVersion=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;

async function agentRevision(indexes){
 // 与管道只读查询使用同一摘要，保持 CLI 原有整数分页/导出合同。
 const encoded=new TextEncoder().encode(JSON.stringify(indexes.map(([shop,head])=>[shop,head.revision])));
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoded));
 return Number.parseInt([...digest.slice(0,7)].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,13),16);
}

async function readDocuments(client,shop,ids,head,project=row=>row){
 const summaries=new Map(head.summaries.map(row=>[row.id,row]));
 const rows=[];
 for(let i=0;i<ids.length;i+=6){
  rows.push(...await Promise.all(ids.slice(i,i+6).map(async id=>{
   if(!summaries.has(id))fail('NOT_FOUND','配置已删除或不属于该店');
   const row=await client.detail(id);
   if(row?.document?.id!==id||row.document.shopId!==shop||!goodVersion(row.version))
    fail('INVALID_API_RESPONSE','NAS 返回的配置身份或版本无效');
   const version=summaries.get(id).nasVersion;
   if(version&&version!==row.version)stale();
   return project(row);
  })));
 }
 return rows;
}

function linkMembers(head,ids){
 const products=new Set(head.summaries.filter(c=>ids.includes(c.id)).map(c=>c.productId));
 return [...new Set([...ids,...head.summaries.filter(c=>products.has(c.productId)).map(c=>c.id)])];
}

function verifiedReceipt(receipt,shop,operationId,changes){
 if(receipt?.shop_id!==shop||receipt.operation_id!==operationId||receipt.kind!=='configurations'||
    receipt.changes?.length!==changes.length||changes.some((change,i)=>{
     const row=receipt.changes[i];
     return row?.configuration_id!==change.id||row.shop_id!==shop||row.operation_id!==operationId||
      row.archived!==false||!goodVersion(row.version)||BigInt(row.version)!==BigInt(change.expected_version)+1n;
    }))fail('SAVE_UNCONFIRMED','NAS 保存回执与原计划不符，请按原 operationId 核对');
 return receipt;
}

export function createNasAgentWorkflow(api){
 const sources=createAgentSources(api);
 // 逐批读已保存的实际 BOM，不打开库存页，不把当前编辑器的草稿并入结果。
 async function inventory(params){
  const shop=params.shopId,{client}=await api.access(shop);
  const [head,catalog]=await Promise.all([client.workspaceIndex(),client.workspaceCatalog()]);
  const groups=inventoryLinks(ordinaryConfigs(head.summaries),shop);
  const selected=groups.filter(group=>!params.productId||params.productId===group.id).flatMap(group=>group.configs);
  // 海报和加购大字段不参与巡检，处理完一批详情即可释放。
  const configs=await readDocuments(client,shop,selected.map(c=>c.id),head,({document:c})=>({
   id:c.id,name:c.name,product:c.product,productId:c.productId,shopId:shop,spu:c.spu,actualParts:c.actualParts??c.parts
  }));
  if((await client.workspaceIndex()).revision!==head.revision)stale();
  const report=checkInventory(configs,catalog.costSource,shop,params.threshold??5,catalog.sourceCatalog);
  const items=report.issues.filter(row=>!params.status||row.status===params.status).map(({sources,...row})=>{
   const links=new Map(sources.map(s=>[s.productId,{id:s.productId,name:s.product}]));
   return {...row,affectedConfigCount:new Set(sources.map(s=>s.configId)).size,
    affectedLinkCount:links.size,affectedLinks:[...links.values()].slice(0,20),affectedLinksTruncated:links.size>20};
  });
  return {shopId:shop,threshold:report.threshold,checkedAt:report.checkedAt,linkCount:report.linkCount,configCount:report.configCount,
   counts:inventoryCounts(report.issues),total:items.length,items};
 }
 async function preview(params){
  const request=params.request,shop=request.shopId,{client,assertWritable,assertDrafts}=await api.access(shop);
  assertWritable();
  const ids=[...new Set(request.targets.map(row=>row.configId))];
  await assertDrafts(ids);
  const head=await client.workspaceIndex();
  const details=await readDocuments(client,shop,ids,head),versions=new Map(details.map(row=>[row.document.id,row]));
  const configs=head.summaries.map(row=>versions.get(row.id)?.document??{...row,__workbenchSummary:true});
  const catalog=request.action.type==='replace'?await client.workspaceCatalog():null;
  const revision=await agentRevision([[shop,head]]);
  let proposed;
  try{
   proposed=buildAgentPlan({revision,configs,sourceCatalog:catalog?.sourceCatalog,costSource:catalog?.costSource},request);
  }catch(error){fail('INVALID_PLAN',error.message);}
  const memo=new Map();
  const changes=await Promise.all(proposed.changes.map(async change=>{
   const original=versions.get(change.id);
   return {id:change.id,action:'replace',expected_version:original.version,document:change.after,
    dependencies:await nasDependencies(client,change.after,original.dependencies,memo)};
  }));
  if(size({operation_id:params.operationId,changes})>1024*1024)
   fail('PLAN_TOO_LARGE','单笔 NAS 修改超过 1 MiB，请缩小批次');
  // 冻结完整正文及原版本。同 operationId 回查失败后也只能显式重放原正文。
  return {plan:{shop,revision,ids,changes},summary:{...proposed.summary,shopId:shop,revision,
   configs:changes.map(change=>({id:change.id,nasVersion:change.expected_version}))}};
 }

 async function apply(job){
  const params=job.params;
  const {shop,revision,ids,changes}=params.plan;
  const {client,assertWritable,assertDrafts}=await api.access(shop);
  const operationId=params.operationId;
  let receipt=null;
  if(params.nasRetry&&changes.length){
   try{receipt=verifiedReceipt(await client.workspaceReceipt(operationId),shop,operationId,changes);}
   catch(error){if(!receiptNotFound(error))throw error;}
  }
  if(!receipt){
   assertWritable();
   await assertDrafts(ids);
   const head=await client.workspaceIndex();
   if(await agentRevision([[shop,head]])!==revision)stale();
   if(!changes.length)return {localSave:'unchanged',nasSave:'unchanged',revision,
    snapshot:{shopId:shop,revision,configIds:ids}};
   // 查已有回执不产生写入；只有确实需要发送新正文时才再向宿主核对这一领取标识。
   await api.native('preflight',{id:job.id,shopId:shop});
   receipt=verifiedReceipt(await client.workspaceWrite('configurations',{operation_id:operationId,changes}),shop,operationId,changes);
  }
  // 正式回执已经确认，刷新失败不能把一次成功写入谎报为可再次保存。
  let savedRevision=null,uiRefreshed=false;
  try{
   savedRevision=await agentRevision([[shop,await client.workspaceIndex()]]);
   uiRefreshed=await api.refresh(shop,receipt);
  }catch{/* 保存状态仍由已确认回执决定。 */}
  return {localSave:'unchanged',nasSave:'saved',revision:savedRevision,receipt,uiRefreshed,
   snapshot:{shopId:shop,revision:savedRevision??revision,configIds:changes.map(row=>row.id),
    versions:receipt.changes.map(({configuration_id,version})=>[configuration_id,version])}};
 }

 async function exportSaved(job){
  const opts=job.params,source=opts.snapshot;
  if(source?.shopId&&opts.shopId&&source.shopId!==opts.shopId)fail('INVALID_PARAMS','导出店铺与来源回执不一致');
  const shop=source?.shopId??opts.shopId??api.activeShop(),{client}=await api.access(shop);
  const ids=opts.configIds??source?.configIds;
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||
     (source&&ids.some(id=>!source.configIds.includes(id))))
   fail('INVALID_PARAMS','导出须选择唯一配置 ID，且须属于保存回执范围');
  const head=await client.workspaceIndex(),revision=await agentRevision([[shop,head]]);
  if(!source&&opts.revision!==revision){
   // 全店搜索版本也能导出单店所选项；调用方可用 shopId 消除配置 ID 歧义。
   const indexes=await api.indexes(shop,head);
   if(opts.revision!==await agentRevision(indexes))stale();
  }
  const versions=new Map(source?.versions??[]);
  if(source&&!versions.size&&source.revision!==revision)stale();
  const [rows,catalog]=await Promise.all([readDocuments(client,shop,linkMembers(head,ids),head),client.workspaceCatalog()]);
  if(rows.some(row=>versions.has(row.document.id)&&versions.get(row.document.id)!==row.version))stale();
  if((await client.workspaceIndex()).revision!==head.revision)stale();
  const configs=api.present(rows,catalog,shop);
  return exportAgentSnapshot({configs,revision,snapshotKind:'nasSaved',params:{...opts,configIds:ids},render:api.render,
   progress:p=>api.native('progress',{id:job.id,...p}),
   writeFile:file=>api.native('export.write',{jobId:job.id,shopId:shop,...file}),
   finish:value=>api.native('export.finish',{jobId:job.id,shopId:shop,...value})});
 }

 return async job=>{
  if(job.method==='inventory.check')return inventory(job.params);
  // 草稿与来源预览仅读取已保存快照。输出源工作表的人工修改可继续保留。
  if(job.method==='sources.preview')return sources.preview(job.params);
  if(job.method==='draft.preview')return previewAgentDraft(job.params,api);
  if(api.blocked(job.method))fail('UI_BUSY','当前正在编辑或执行任务，请关闭弹窗并等待编辑器就绪');
  const release=api.lock();
  try{
   switch(job.method){
    case 'draft.apply':return await applyAgentDraft(job,api);
    case 'sources.apply':return await sources.apply(job);
    case 'changes.preview':return await preview(job.params);
    case 'changes.apply':return await apply(job);
    case 'export.start':return await exportSaved(job);
    case 'sync.run':{
     const shop=api.activeShop();
     if(job.params.shopId&&job.params.shopId!==shop)fail('MEMBER_CHANGED','当前店铺已切换，请在目标店铺重新刷新');
     await api.access(shop);
     await api.native('preflight',{id:job.id,shopId:shop});
     await api.refresh(shop);
     return {localSave:'unchanged',nasRefresh:'completed',shopId:shop};
    }
    default:fail('METHOD_NOT_FOUND','不支持此 NAS Agent 任务');
   }
  }finally{release();}
 };
}
