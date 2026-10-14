/** 首次迁移的纯转换：保留旧云端确认和提交身份，只接入可明确判定的本机保存修改。 */
import {applyWorkspace,projectWorkspace,mergeWorkspaceEdit} from './cloud-projection.js';
import {equal,recordKey,safeInteger,validateCloudRecord} from './cloud-protocol.js';
import {initializeActualParts} from './actual-parts.js';
import {normalizePosterDesign} from './poster-design.js';

const copy=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Error('旧版资料迁移未完成：'+message);};
// IPC 按 JSON 传输，投影中的可选 undefined 字段必须与实际落库形状一致。
const projection=state=>JSON.parse(JSON.stringify(projectWorkspace(state)));
const index=rows=>new Map(rows.map(row=>[recordKey(row.type,row.id),row]));
const mismatch=()=>fail('已保存内容与旧同步记录存在无法确定先后的修改，请先在旧版完成保存并处理同步冲突后重试；原资料没有更改');
const canonicalUpload=/^\/uploads\/[a-f0-9]{64}\.(?:png|jpg)$/;
const legacyUpload=/^\/uploads\/\d+-\d+-[a-f0-9]{16}\.(?:png|jpg)$/;
function hasLegacyUpload(value){
 if(typeof value==='string')return legacyUpload.test(value);
 return value!==null&&typeof value==='object'&&Object.values(value).some(hasLegacyUpload);
}
function replaceAssets(value,replacements){
 if(typeof value==='string')return Object.hasOwn(replacements,value)?replacements[value]:value;
 if(Array.isArray(value))return value.map(child=>replaceAssets(child,replacements));
 if(object(value))return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,replaceAssets(child,replacements)]));
 return value;
}
function checkAssets(value){
 if(typeof value==='string'&&value.startsWith('/uploads/')&&!canonicalUpload.test(value))fail('原图路径尚未完成校验，请重新选择旧版目录');
 if(value!==null&&typeof value==='object')Object.values(value).forEach(checkAssets);
}

function checkRecord(row){
 if(!object(row)||!safeInteger(row.version)||!Object.hasOwn(row,'base')||!Object.hasOwn(row,'draft')||!Object.hasOwn(row,'conflict'))fail('同步记录格式无效');
 validateCloudRecord(row.type,row.id,row.draft);
 if(row.base!==null)validateCloudRecord(row.type,row.id,row.base);
 if(row.version===0&&row.base!==null||row.version>0&&row.base===null)fail('同步记录版本与已确认内容不一致');
 if(row.conflict!==null){
  const conflict=row.conflict,remote=conflict?.remote;
  if(!object(conflict)||!object(remote)||!Array.isArray(conflict.fields)||!safeInteger(remote.version,1)||remote.type!==row.type||remote.id!==row.id)fail('旧同步冲突需先在旧版处理');
  validateCloudRecord(remote.type,remote.id,remote.data);
 }
}

function checkOutbox(requests,rows){
 const mutations=new Set(),entities=new Set();
 for(const request of requests){
  const p=request?.payload,key=recordKey(p?.entityType,p?.entityId);
  if(request?.protocolVersion!==2||request.action!=='sync.push'||typeof request.requestId!=='string'||!request.requestId||!object(p)||typeof p.mutationId!=='string'||p.mutationId.length<16||p.mutationId.length>100||typeof p.deviceId!=='string'||!p.deviceId||!safeInteger(p.baseVersion)||!rows.has(key)||mutations.has(p.mutationId)||entities.has(key))fail('待确认提交身份或格式无效');
  validateCloudRecord(p.entityType,p.entityId,p.after);
  mutations.add(p.mutationId);entities.add(key);
 }
}

/** prepared 由原生端只读捕获并持有 token；输出只供同一 token 的原子应用。 */
export function buildLegacyMigrationPlan(prepared){
 if(!object(prepared)||prepared.prepared!==true||typeof prepared.token!=='string'||!prepared.token||typeof prepared.sourceBound!=='boolean'||!object(prepared.state)||!Array.isArray(prepared.records)||!Array.isArray(prepared.outbox))fail('迁移准备结果无效，请重新选择旧版 data 目录');
 const state=prepared.state;
 for(const key of ['configs','templates','sourceCatalog','costSource','caseGallery'])if(!Array.isArray(state[key]))fail('旧版工作区内容不完整');
 if(!object(state.shopSettings)||!safeInteger(state.revision))fail('旧版工作区版本或店设置无效');
 const records=copy(prepared.records),old=index(records);
 if(old.size!==records.length)fail('同步记录身份重复');
 records.forEach(checkRecord);
 checkOutbox(prepared.outbox,old);
 const replacements=prepared.assetReplacements??{};
 if(!object(replacements)||Object.entries(replacements).some(([from,to])=>!legacyUpload.test(from)||typeof to!=='string'||!canonicalUpload.test(to)||from.split('.').at(-1)!==to.split('.').at(-1)))fail('原图转换清单无效');
 if(prepared.outbox.some(hasLegacyUpload)||records.some(row=>hasLegacyUpload(row.conflict)))fail('旧命名原图仍被待确认提交或同步冲突引用，请先在旧版处理后迁移；原提交身份保持不变');
 if(prepared.sourceBound&&!old.has(recordKey('workspace_meta','root')))fail('旧版首次云端下载尚未完成，请先在旧版完成同步');
 // 旧程序关闭云同步时也会把本机保存写成 base=null/version=0 的草稿；它们没有云端归属历史。
 if(!prepared.sourceBound&&(prepared.outbox.length||records.some(row=>row.version!==0||row.base!==null||row.conflict!==null)))fail('同步记录缺少原成员和工作区归属');

 const current=projection(state);
 for(const row of current)validateCloudRecord(row.type,row.id,row.data);
 const currentIndex=index(current);
 // Python 的 initializeMaterializedState 会补实际 BOM 和海报默认布局。
 // 这些派生默认值不应让迁移凭空产生全库上传；基线也不能直接等于 cloud base。
 const restored=initializeActualParts(applyWorkspace(copy(state),records));
 for(const config of restored.configs)normalizePosterDesign(config);
 const normalized=index(projection(restored));
 const costIds=state.costSource.map(row=>row.goodsId);
 for(const row of current){
  const key=recordKey(row.type,row.id),previous=old.get(key);
  if(!previous){
   records.push({type:row.type,id:row.id,version:0,base:null,draft:copy(row.data),conflict:null});
   continue;
  }
  if(equal(previous.draft,row.data))continue;
  const materialized=normalized.get(key)?.data;
  if(equal(materialized,row.data))continue;
  if(!materialized||previous.conflict)mismatch();
  // 只把已保存状态相对旧草稿物化结果的变化写入 draft，保留旧格式未存的默认字段。
  const candidate=copy(previous.draft);
  for(const field of new Set([...Object.keys(materialized),...Object.keys(row.data)])){
   if(equal(materialized[field],row.data[field]))continue;
   if(Object.hasOwn(row.data,field))candidate[field]=copy(row.data[field]);else delete candidate[field];
  }
  if(equal(candidate,previous.draft))continue;
  // 已确认 base 是唯一可追溯的共同基线。重叠编辑以及回退未确认修改均拒绝猜测。
  const merged=mergeWorkspaceEdit(row.type,previous.base,candidate,previous.draft,costIds);
  if(merged.fields.length||!equal(merged.value,candidate))mismatch();
  validateCloudRecord(row.type,row.id,candidate);
  previous.draft=candidate;
 }
 // 不因状态中缺少一个实体就推断删除；component 墓碑本来就不会物化为成本行。
 for(const row of records)if(row.type!=='workspace_meta'&&!currentIndex.has(recordKey(row.type,row.id))&&!row.draft.deletedAt)mismatch();
 // 原生验证过的摘要映射只作用于可编辑草稿和本机基线，绝不重写已确认 base、冲突或原始提交。
 for(const row of records){row.draft=replaceAssets(row.draft,replacements);checkAssets(row.draft);}
 const materializedProjection=replaceAssets(current,replacements);checkAssets(materializedProjection);
 return {token:prepared.token,materializedProjection,records};
}
