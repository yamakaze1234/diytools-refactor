/** AI 草稿只创建新的 NAS 链接。预览冻结来源版本、整批配置 ID 和保存正文。 */
import {blankConfig} from './core.js';
import {preferredSourceRows,sourcePart,replaceSourcePart} from './source.js';
import {selectableComponents} from './component-policy.js';
import {categoryFromErp,categoryFromName} from './component-category.js';
import {configHardwareIssues} from './component-hardware.js';
import {nasDependencies,ensureNasPartLineIds} from './nas-draft-controller.js';
import {nasShopIds,receiptNotFound} from './nas-api-client.js';
import {isSpecialPresetId} from './special-components.js';

function fail(code,message){throw Object.assign(Error(message),{code});}
function fields(value,allowed){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))){
  fail('INVALID_PARAMS','草稿请求包含未知字段或对象格式无效');
 }
}
function label(value,max,field){
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail('INVALID_PARAMS',field+'无效');
 return value.trim();
}
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
function sourceIds(request){
 fields(request,['shopId','mode','productName','configs']);
 if(!nasShopIds.includes(request.shopId)||request.mode!=='new_draft_link')fail('INVALID_PARAMS','仅支持在指定店铺新建草稿链接');
 label(request.productName,200,'链接名称');
 if(!Array.isArray(request.configs)||request.configs.length<1||request.configs.length>16)fail('INVALID_PARAMS','一条草稿链接需包含 1 至 16 套配置');
 if(bytes(request)>1048576)fail('PLAN_TOO_LARGE','草稿请求超过 1 MiB');
 const ids=new Set();
 for(const config of request.configs){
  fields(config,['name','parts','actualParts','price']);
  label(config.name,200,'配置名称');
  if(config.price!=null&&(!Number.isFinite(config.price)||config.price<0||config.price>Number.MAX_SAFE_INTEGER/100||
    Math.abs(config.price*100-Math.round(config.price*100))>=0.00001))fail('INVALID_PARAMS','售价必须是非负金额，最多两位小数');
  for(const key of ['parts',...(Object.hasOwn(config,'actualParts')?['actualParts']:[])]){
   const parts=config[key];
   if(!Array.isArray(parts)||!parts.length||parts.length>500)fail('INVALID_PARAMS','每组配件需包含 1 至 500 行');
   for(const part of parts){
    fields(part,['sourceId','slot','qty']);
    label(part.slot,256,'部位');label(part.sourceId,256,'来源 ID');
    if(Object.hasOwn(part,'qty')&&(!Number.isSafeInteger(part.qty)||part.qty<1||part.qty>2147483647))fail('INVALID_PARAMS','配件数量必须为正整数');
    ids.add(part.sourceId);
   }
  }
 }
 return [...ids];
}

function resolvePart(input,sources){
 const source=sources.get(input.sourceId);
 if(!source||source.deletedAt||!source.name||(!source.specialComponent&&!/^[1-9]\d*$/.test(source.goodsId)))fail('INVALID_DEPENDENCY','输出源已删除、被排除或缺少可用货号：'+input.sourceId);
 const slot=input.slot.trim();
 // 防止已知主板或机箱被放到其他部位，跳过板型匹配。
 const category=categoryFromErp(source.erpCategory)||
  (source.hardwareOverrides?.boardType||source.hardwareFacts?.boardType?'主板':
   source.hardwareOverrides?.caseBoards||source.hardwareFacts?.caseType?'机箱':categoryFromName(source.erpName||source.name));
 if((category==='主板'||category==='机箱')&&slot!==category)fail('INVALID_PARAMS',source.name+' 应放在'+category+'部位');
 return {source,part:{...sourcePart(source),slot,qty:input.qty??1}};
}

function checkHardware(document){
 const warnings=[];
 // 配置允许多个同类配件；逐对调用与编辑器一致的板型规则，避免只检查第一件。
 for(const [key,title] of [['parts','展示配件'],['actualParts','实际配件']]){
  const distinct=new Map(document[key].map(p=>[JSON.stringify([p.slot,p.sourceId]),p]));
  const rows=[...distinct.values()],boards=rows.filter(p=>p.slot==='主板'&&p.goodsId),cases=rows.filter(p=>p.slot==='机箱'&&p.goodsId);
  let warning=null;
  for(const board of boards)for(const box of cases){
   const [issue]=configHardwareIssues({[key]:[board,box]});
   if(!issue)continue;
   if(issue.status==='error')fail('INCOMPATIBLE_HARDWARE',document.name+' · '+title+'：'+issue.message);
   // 按配置及展示/实际分组汇总资料不足的组合，长清单也能在一次回执里读完。
   warning??={configId:document.id,name:document.name,group:title,board:board.sourceId,case:box.sourceId,message:issue.message,unknownPairCount:0};
   warning.unknownPairCount++;
  }
  if(warning)warnings.push(warning);
 }
 return warnings;
}

function missingSource(id,shop){
 if(isSpecialPresetId(id,shop))fail('UNSAVED_SOURCE','特殊配件预设尚未保存到 NAS 输出源：'+id);
 fail('INVALID_DEPENDENCY','未找到本店有效输出源：'+id);
}

export async function previewAgentDraft(params,api){
 const {request,operationId}=params,ids=sourceIds(request),shop=request.shopId;
 const {client,assertWritable}=await api.access(shop);
 assertWritable();
 const [catalog,index]=await Promise.all([client.workspaceCatalog(),client.workspaceIndex()]);
 const active=new Set(catalog.sourceCatalog.filter(row=>!row.deletedAt).map(row=>row.sourceId));
 const lastOrder=index.summaries.reduce((max,row)=>Math.max(max,Number(row.workspaceOrder)||0),0);
 const memo=new Map(),selected=[];
 for(let i=0;i<ids.length;i+=6){
  const batch=ids.slice(i,i+6);
  selected.push(...await Promise.all(batch.map(async id=>{
   if(!active.has(id))missingSource(id,shop);
   const entry=await client.resource('sources',id);
   const row=entry.document;
   if(entry.id!==id||row?.sourceId!==id||row.deletedAt||row.shopId&&row.shopId!=='shared'&&row.shopId!==shop)missingSource(id,shop);
   if(typeof entry.version!=='string'||!(/^[1-9]\d{0,18}$/).test(entry.version))fail('INVALID_API_RESPONSE','NAS 来源版本无效');
   // 同一份正式来源回读既构造配件也提供提交版本，防止在两次读之间混用新旧数据。
   memo.set(JSON.stringify(['sources',id]),Promise.resolve(entry));
   return row;
  })));
 }
 const effective=preferredSourceRows(selectableComponents(selected,catalog.costSource),catalog.costSource);
 const sources=new Map(effective.map(row=>[row.sourceId,row]));
 const product={id:crypto.randomUUID(),name:request.productName.trim(),shopId:shop,configs:[],installment:0};
 const changes=[],hardwareWarnings=[];
 for(const [index,input] of request.configs.entries()){
  const doc=blankConfig(null,product,input.name.trim());
  doc.workspaceOrder=lastOrder+(index+1)*100;doc.productDraft=true;doc.price=input.price??null;
  const display=input.parts.map(p=>resolvePart(p,sources));
  doc.parts=display.map(({part})=>part);
  display.forEach(({source},i)=>replaceSourcePart(doc,i,source));
  doc.actualParts=input.actualParts?input.actualParts.map(p=>resolvePart(p,sources).part):structuredClone(doc.parts);
  ensureNasPartLineIds(doc);
  hardwareWarnings.push(...checkHardware(doc));
  const dependencies=await nasDependencies(client,doc,undefined,memo);
  for(const id of new Set([...doc.parts,...doc.actualParts].map(p=>p.goodsId).filter(Boolean))){
   if((catalog.costVersions?.[id]??null)!==(dependencies.costs[id]??null))fail('REVISION_CONFLICT','成本资料已变化，请重新预览');
  }
  changes.push({id:doc.id,action:'create',document:doc,dependencies});
 }
 if(bytes({operation_id:operationId,changes})>1048576)fail('PLAN_TOO_LARGE','生成的 NAS 草稿保存正文超过 1 MiB，请缩小批次');
 const describe=({slot,sourceId,goodsId,name,qty})=>({slot,sourceId,goodsId,name,qty});
 return {plan:{shop,request,steps:[{kind:'configurations',shopId:shop,changes}]},summary:{
  shopId:shop,mode:request.mode,productId:product.id,productName:product.name,hardwareWarnings,
  configs:changes.map(({id,document:d})=>({id,name:d.name,price:d.price,displayParts:d.parts.length,actualParts:d.actualParts.length,
   parts:d.parts.map(describe),actualBom:d.actualParts.map(describe)}))
 }};
}

function verifyReceipt(receipt,shop,id,changes){
 const rows=receipt?.changes;
 if(receipt?.kind!=='configurations'||receipt.shop_id!==shop||receipt.operation_id!==id||!Array.isArray(rows)||
    rows.length!==changes.length||changes.some((change,i)=>rows[i]?.configuration_id!==change.id||rows[i].operation_id!==id||
     rows[i].shop_id!==shop||rows[i].version!=='1'||rows[i].archived!==false))fail('SAVE_UNCONFIRMED','草稿正式回执与新建计划不符，请按原操作编号核对');
 return receipt;
}

export async function applyAgentDraft(job,api){
 const {plan,operationId,stepStates}=job.params,{shop}=plan,[step]=plan.steps,[state]=stepStates;
 const {client,assertWritable,assertDrafts}=await api.access(shop);
 let receipt=state.state==='confirmed'?verifyReceipt(state.receipt,shop,operationId,step.changes):null;
 if(state.state==='submitted'){
  try{receipt=verifyReceipt(await client.workspaceReceipt(operationId),shop,operationId,step.changes);}
  catch(error){if(!receiptNotFound(error))throw error;}
 }
 if(!receipt){
  assertWritable();
  await assertDrafts(step.changes.map(change=>change.id));
  // 预览后的其他链接可正常更新；若有人已占用本次生成的链接或配置 ID，禁止并入既有链接。
  const existing=await client.workspaceIndex(),ids=new Set(step.changes.map(change=>change.id));
  if(existing.summaries.some(row=>row.productId===step.changes[0].document.productId||ids.has(row.id))){
   fail('REVISION_CONFLICT','本次草稿标识已存在，请核对原回执或重新预览');
  }
  // 初次及未知结果重试始终沿用原正文和操作编号。权限撤回时只允许回读已经发出的提交。
  await api.native('preflight',{id:job.id,stepIndex:0,shopId:shop});
  receipt=verifyReceipt(await client.workspaceWrite('configurations',{operation_id:operationId,changes:step.changes}),shop,operationId,step.changes);
 }
 if(state.state!=='confirmed')await api.native('step.confirm',{id:job.id,stepIndex:0,receipt});
 let uiRefreshed=false;
 try{uiRefreshed=await api.refresh(shop,receipt);}catch{/* 正式保存回执优先于界面刷新结果。 */}
 return {localSave:'unchanged',nasSave:'saved',productId:step.changes[0].document.productId,configIds:step.changes.map(c=>c.id),receipt,uiRefreshed};
}
