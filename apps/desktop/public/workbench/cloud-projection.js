/** 在完整工作区和云实体记录之间转换，保留本机 ERP 派生字段与配置顺序。 */
import {hasConfigCost,syncConfigCost} from './config-cost.js';
// 工作台状态与云端记录的双向投影。此处只变换数据，不访问数据库或网络；
// projectWorkspace 输出共享字段，applyWorkspace 从本机原状态恢复本地 ERP 派生字段。
import {normalizePosterDesign} from './poster-design.js';
import {allConfigParts} from './actual-parts.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';
import {stripLocalErp,localErpFields} from './cloud-erp-policy.js';
import {restoreConfigOrder} from './config-order.js';
import {sha256} from './cloud-sha256.js';
import {equal,recordKey,mergeRecord} from './cloud-protocol.js';
const copy=v=>structuredClone(v);
export const hash=v=>sha256(typeof v==='string'?v:JSON.stringify(v));
const derived=['erp','tax','stockAvailable','stockUpdatedAt','erpUpdatedAt','erpMissing','erpUnknown','taxUpdatedAt'];
const strip=row=>{const r=stripLocalErp(row);for(const k of derived)delete r[k];return r;};
const cents=v=>v==null?null:Math.round(v*100);
const configurationLocalFields=['deletionSessionId','updatedAt','taxUpdatedAt','erpImportedAt'];
// 网页版和旧记录可能带配件成本缓存。远端先投影到编辑基线的形状，
// 再按字段合并；仅规范化远端，避免把本地有意恢复的备用价格当作缓存删除。
export function mergeWorkspaceEdit(type,base,local,remote,sharedCostIds=[]){
 // No override is stored as null by replacement, but omitted when shared costs
 // materialize. They mean the same thing; keep real override objects distinct.
 if(type==='configuration'){
  [base,local,remote]=[base,local,remote].map(record=>{
   if(!record)return record;
   const value=copy(record);
   for(const field of ['parts','actualParts'])for(const part of value[field]||[]){
    if(part.taxOverride===null)delete part.taxOverride;
    // 空配件行加载后可能补 tax:null；它与未保存成本等价，不应阻塞删行或同组文案编辑。
    // 有商品、名称或特殊项的行及有效成本仍原样参与冲突判断。
    if(part.goodsId===''&&part.name===''&&!isSpecialComponent(part)&&part.tax===null)delete part.tax;
   }
   return value;
  });
 }
 const ids=new Set(sharedCostIds);let current=copy(remote);
 // 比较编辑器实际持久化的字段；updatedAt 等元数据不算并发业务编辑。
 if(current&&type==='configuration'){
  for(const key of configurationLocalFields)delete current[key];
  // 编辑器加载旧版布局时补默认值，比较前对齐这个投影。
  if(base?.posterDesignVersion===1&&current.posterDesignVersion==null)normalizePosterDesign(current);
 }
 if(current&&type==='configuration'&&!current.deletedAt){
  for(const field of ['parts','actualParts'])if(Array.isArray(current[field]))current[field]=current[field].map(p=>ids.has(p.goodsId)?strip(p):p);
 }else if(current&&type==='source'&&ids.has(current.goodsId))current=strip(current);
 return mergeRecord(base,local,current);
}
export function projectWorkspace(state,configurationOnly=false,selected=null){
 // 将配置、共享成本、输出源等投影为按 type/id 标识的记录；selected 只选目标 ID。
 // parts 是展示/选配数据，actualParts 是实际成本 BOM，addons 随配置保存；
 // costSource 的共享含税价进入 component，ERP 库存和本机字段经 stripLocalErp 排除。
 const records=[],scope=state.sharedCostScope||state.erpSync?.scope||'unbound',seen=new Set(),componentIds=new Set((state.costSource||[]).map(c=>c.goodsId));
 const independentCosts=['nas','cloud'].includes(state.costSync?.mode);
 const wanted=(type,id)=>!(independentCosts&&type==='component')&&(!selected||selected[type]===null||selected[type].has(id));
 const add=(type,id,data)=>{const key=recordKey(type,id);if(seen.has(key))throw Error('重复记录 ID：'+id);seen.add(key);const value=stripLocalErp(data);if(independentCosts){const clean=v=>{if(!v||typeof v!=='object')return;for(const child of Object.values(v))clean(child);if(v.taxOverride)delete v.taxOverride.base;if(typeof v.goodsId==='string'&&!isSpecialComponent(v)){delete v.tax;delete v.taxUpdatedAt;}};clean(value);}records.push({type,id,data:value});};
 // 产品分组会改变数组位置；保存 workspaceOrder 才能稳定比较并发编辑。
 for(const [index,c] of (state.configs||[]).entries()){if(!wanted('configuration',c.id))continue;const d=copy(c);d.workspaceOrder=Number.isFinite(c.workspaceOrder)?c.workspaceOrder:index;d.priceCents=cents(d.price);delete d.price;for(const k of configurationLocalFields)delete d[k];for(const field of ['parts',...(Array.isArray(d.actualParts)?['actualParts']:[])])d[field]=d[field].map((p,i)=>({...(!componentIds.has(p.goodsId)||c.deletedAt?copy(p):strip(p)),lineId:p.lineId||'line-'+hash(field==='parts'?[c.id,i,p.slot]:[c.id,field,i,p.slot]).slice(0,24)}));add('configuration',c.id,d);}
 if(configurationOnly)return records;
 for(const c of state.costSource||[])if(wanted('component',c.goodsId)&&(!c.localInventoryOnly||c.tax!=null))add('component',`${scope}|${c.goodsId}`,{erpScopeId:scope,goodsId:c.goodsId,name:c.name,taxCents:cents(c.tax)});
 for(const s of state.sourceCatalog||[])if(wanted('source',s.sourceId))add('source',s.sourceId,componentIds.has(s.goodsId)?strip(s):copy(s));
 for(const t of state.templates||[])if(wanted('template',t.id))add('template',t.id,copy(t));
 for(const [id,d] of Object.entries(state.shopSettings||{})){if(!wanted('settings',id))continue;const data={...copy(d),couponCents:cents(d.coupon)};delete data.coupon;add('settings',id,data);}
 for(const g of state.caseGallery||[])if(wanted('gallery',g.id))add('gallery',g.id,copy(g));
 return records;
}
export function applyWorkspace(template,records){
 // 以云端记录重建共享字段，并从 template 恢复未同步的 ERP 本机缓存。
 // 缺失商品成本保持 null；本地 ERP 字段不反向写入共享记录。
 const {configs:oldConfigs,templates:oldTemplates,sourceCatalog:oldSources,caseGallery:oldGallery,shopSettings:oldSettings,costSource:oldCosts,...metadata}=template;
 const next=copy(metadata),groups=new Map();for(const r of records){if(!groups.has(r.type))groups.set(r.type,[]);groups.get(r.type).push(r);}
 const values=type=>(groups.get(type)||[]).map(r=>stripLocalErp(r.draft??r.data));
 const localConfigs=new Map((oldConfigs||[]).map(c=>[c.id,c]));
 next.configs=values('configuration').map(d=>{d.price=d.priceCents/100;delete d.priceCents;
  // 更新时间属于本机成本缓存；云投影不携带，物化时也不能将其当作远端删除。
  const local=localConfigs.get(d.id);for(const key of ['taxUpdatedAt','erpImportedAt'])if(local&&Object.hasOwn(local,key))d[key]=copy(local[key]);return d;
 });
 const previous=new Map((template.configs||[]).map((c,i)=>[c.id,i]));next.configs.sort((a,b)=>(a.workspaceOrder??previous.get(a.id)??Number.MAX_SAFE_INTEGER)-(b.workspaceOrder??previous.get(b.id)??Number.MAX_SAFE_INTEGER));next.configs=restoreConfigOrder(next.configs);
 next.templates=values('template');next.sourceCatalog=values('source');next.caseGallery=values('gallery');next.shopSettings={};
 for(const r of groups.get('settings')||[]){const d=copy(r.draft??r.data);next.shopSettings[r.id]={...d,coupon:d.couponCents/100};delete next.shopSettings[r.id].couponCents;}
 const localRows=new Map();for(const r of [...(template.sourceCatalog||[]),...(template.configs||[]).flatMap(allConfigParts),...(template.costSource||[])])if(r.goodsId)localRows.set(r.goodsId,{...localRows.get(r.goodsId),...r});
 const components=values('component').filter(c=>!c.deletedAt),scope=components[0]?.erpScopeId;
 if(scope&&!template.costSync)next.sharedCostScope=scope;
 const inventory=new Map((template.costSource||[]).map(r=>[r.goodsId,copy(r)]));
 for(const c of (template.costSync?[]:components))inventory.set(c.goodsId,{...inventory.get(c.goodsId),goodsId:c.goodsId,name:c.name,tax:c.taxCents==null?null:c.taxCents/100});
 for(const c of (template.costSync?[]:values('component').filter(c=>c.deletedAt)))inventory.delete(c.goodsId);
 next.costSource=template.costSync?copy(template.costSource||[]):[...inventory.values()];
 const restore=value=>{if(!value||typeof value!=='object')return;for(const child of Object.values(value))if(child&&typeof child==='object')restore(child);if(isSpecialComponent(value)){Object.assign(value,normalizeSpecialComponent(value));return;}if(typeof value.goodsId==='string'&&('name' in value||'slot' in value)){const local=localRows.get(value.goodsId);for(const key of localErpFields){if(local&&key in local)value[key]=copy(local[key]);}value.erp=local?.erp??null;value.stockAvailable=local?.stockAvailable??null;}};
 restore(next.configs);restore(next.templates);restore(next.sourceCatalog);restore(next.costSource);
 const costs=new Map(next.costSource.map(c=>[c.goodsId,c]));
 const enrich=r=>{if(isSpecialComponent(r)){Object.assign(r,normalizeSpecialComponent(r));return;}const c=costs.get(r.goodsId);if(!c){if(template.costSync){const local=localRows.get(r.goodsId);syncConfigCost(r,hasConfigCost(local||{})?local.taxOverride.base??null:local?.tax??null);}return;}for(const k of derived)if(k in c){if(k==='tax')syncConfigCost(r,copy(c[k]));else r[k]=copy(c[k]);}};
 if(template.costSync){const visit=v=>{if(!v||typeof v!=='object')return;if(typeof v.goodsId==='string')enrich(v);for(const child of Object.values(v))visit(child);};visit(next.templates);}next.sourceCatalog.forEach(enrich);next.configs.forEach(c=>{if(!c.deletedAt)allConfigParts(c).forEach(enrich);});return next;
}
function changedProjectionIds(before,after){
 // 先找输入中变化的记录 ID，避免每次编辑都重投影全部 ERP 行。
 const changed=(oldRows,newRows,key,transform=row=>row)=>{
  const index=rows=>{const map=new Map();for(const [i,row] of (rows||[]).entries()){const id=row[key];if(map.has(id))throw Error('重复记录 ID：'+id);map.set(id,JSON.stringify(transform(row,i)));}return map;};
  const old=index(oldRows),fresh=index(newRows);
  return new Set([...new Set([...old.keys(),...fresh.keys()])].filter(id=>old.get(id)!==fresh.get(id)));
 };
 const settings=state=>Object.entries(state.shopSettings||{}).map(([id,data])=>({id,data}));
 const selected={configuration:changed(before.configs,after.configs,'id',(c,i)=>({...c,workspaceOrder:Number.isFinite(c.workspaceOrder)?c.workspaceOrder:i})),component:changed(before.costSource,after.costSource,'goodsId'),source:changed(before.sourceCatalog,after.sourceCatalog,'sourceId'),template:changed(before.templates,after.templates,'id'),settings:changed(settings(before),settings(after),'id'),gallery:changed(before.caseGallery,after.caseGallery,'id')};
 // 共享成本成员变化会改变配置和输出源的投影，必须连带重算。
 const oldIds=new Set((before.costSource||[]).map(c=>c.goodsId)),newIds=new Set((after.costSource||[]).map(c=>c.goodsId));
 if(oldIds.size!==newIds.size||[...oldIds].some(id=>!newIds.has(id))){selected.configuration=null;selected.source=null;}
 if((before.sharedCostScope||before.erpSync?.scope||'unbound')!==(after.sharedCostScope||after.erpSync?.scope||'unbound'))selected.component=null;
 return selected;
}
/** 只为输入中发生变化的实体构造云端差异，避免每次编辑重投影全库。 */
export function changesBetween(before,after){
 // 只改图库时跳过全部 ERP 行的投影；其他编辑按变化 ID 比较旧、新记录。
 if(['configs','costSource','sourceCatalog','templates','shopSettings','sharedCostScope'].every(key=>JSON.stringify(before[key])===JSON.stringify(after[key]))&&equal(before.erpSync?.scope,after.erpSync?.scope)){
  const galleryOnly=state=>({...state,configs:[],costSource:[],sourceCatalog:[],templates:[],shopSettings:{}});
  const old=new Map(projectWorkspace(galleryOnly(before)).map(r=>[recordKey(r.type,r.id),r])),changes=[];
  for(const r of projectWorkspace(galleryOnly(after))){const key=recordKey(r.type,r.id),prev=old.get(key);if(!prev||!equal(prev.data,r.data))changes.push({...r,expectedDraft:prev?.data});old.delete(key);}
  for(const r of old.values())changes.push({...r,data:{...r.data,deletedAt:new Date().toISOString()},expectedDraft:r.data});
  return changes;
 }
 const selected=changedProjectionIds(before,after);
 const old=new Map(projectWorkspace(before,false,selected).map(r=>[recordKey(r.type,r.id),r])),fresh=projectWorkspace(after,false,selected),changes=[];
 // 旧记录没有已保存的顺序；比较基线不能凭当前数组位置虚构一个远端改动。
 const legacyOrder=new Set((before.configs||[]).filter(c=>!Number.isFinite(c.workspaceOrder)).map(c=>c.id));
 for(const r of fresh){const prev=old.get(recordKey(r.type,r.id));if(!prev||!equal(prev.data,r.data))changes.push({...r,expectedDraft:prev?.data});old.delete(recordKey(r.type,r.id));}
 for(const r of old.values())if(!(after.costSync&&r.type==='component')&&!['erp_chunk','erp_snapshot'].includes(r.type))changes.push({...r,data:{...r.data,deletedAt:new Date().toISOString()},expectedDraft:r.data});
 for(const change of changes)if(change.type==='configuration'&&legacyOrder.has(change.id)&&change.expectedDraft)delete change.expectedDraft.workspaceOrder;
 return changes;
}
/** 汇总迁移状态中的业务记录规模，供接入预览展示。 */
export function migrationSummary(state){const records=projectWorkspace(state),roundtrip=applyWorkspace(state,records);const issues=[];
 // 发布前检查成本范围、缓存差异和元/分往返；返回预览 hash 供启用时复核。
 const costs=new Map((state.costSource||[]).map(c=>[c.goodsId,c]));
 for(const c of state.configs||[])for(const p of allConfigParts(c)){const shared=costs.get(p.goodsId);if(shared&&!hasConfigCost(p)&&cents(p.tax)!==cents(shared.tax))issues.push({code:'COST_DIFF',configId:c.id,goodsId:p.goodsId,message:'配置缓存成本与共享成本不同'});}
 if(records.some(r=>r.type==='component')&&!state.sharedCostScope&&!state.erpSync?.scope)issues.push({code:'SCOPE_MISSING',message:'请先确认成本对应的 ERP 账套/仓库来源'});
 const expected=new Map((state.configs||[]).map(c=>[c.id,cents(c.price)]));if(roundtrip.configs.some(c=>cents(c.price)!==expected.get(c.id)))issues.push({code:'PRICE_DIFF',message:'售价换算不一致'});
 return {hash:hash(records),counts:records.reduce((a,r)=>(a[r.type]=(a[r.type]||0)+1,a),{}),issues,records};
}
