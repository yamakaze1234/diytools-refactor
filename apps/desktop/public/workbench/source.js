import {attachAddonHardware} from './hardware-upgrade.js';
import {copyHardware} from './component-hardware.js';
import {copyCapacity} from './component-capacity.js';
/** 输出源与配置配件绑定：统一替换、名称对齐、差异计算和来源删除规则。 */
import {allConfigParts} from './actual-parts.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';
import {excludedComponent} from './component-policy.js';
import {clone} from './core.js';
import {selectedSourceAddons,sourceAddonsForSync} from './addon-data.js';
import {createSourceIndex} from './component-index.js';

// 输出源绑定与展示字段同步的纯规则入口；此模块不持有缓存，不执行保存或网络请求。
// sourceCatalog 是店铺显示资料，成本来源和 actualParts 的字段归属由调用方分别管理。
export function sourceCatalog(rows){return rows.map((r,i)=>({...clone(r),sourceId:r.sourceId||`catalog-${i}`,shopId:r.shopId||'intel',originalName:r.originalName||r.name,addonText:r.addonText||'',addonNote:r.addonNote||''}));}
/** 通过可复用来源索引给配置配件补来源绑定，避免重复扫描整个来源表。 */
export function bindSources(configs,catalog,index=createSourceIndex(catalog)){
 for(const c of configs)attachAddonHardware(c,catalog);
 for(const c of configs)for(const p of allConfigParts(c)){
  const shopId=c.shopId||'intel';
  // 已有 sourceId 在本店存在时不重绑；重名或重复 goodsId 无法唯一消歧时保持未绑定。
  if(p.sourceId&&index.bySourceId(shopId,p.sourceId).length){const row=index.bySourceId(shopId,p.sourceId).at(-1);if(row.goodsId===p.goodsId){copyCapacity(row,p);copyHardware(row,p);}continue;}
  const ids=index.byGoodsId(shopId,p.goodsId);
  const exact=ids.filter(r=>r.name===p.name||r.originalName===p.name);
  const row=exact.length===1?exact[0]:ids.length===1?ids[0]:null;
  if(row){p.sourceId=row.sourceId;copyCapacity(row,p);copyHardware(row,p);}
 }
}
/** 利用同一来源索引对齐展示名称，保留各配置的业务绑定。 */
export function alignDisplaySourceNames(configs,catalog,index=createSourceIndex(catalog)){
 for(const config of configs)for(const part of config.parts||[]){
  const rows=index.bySourceId(config.shopId||'intel',part.sourceId),source=rows.at(-1);
  if(!source||source.goodsId!==part.goodsId||!source.name||part.name===source.name)continue;
  if(!part.displayName&&part.name)part.displayName=part.name;
  part.name=source.name;
 }
}
export function sourcePart(row){row=normalizeSpecialComponent(row);if(excludedComponent(row))throw Error('带 * 或 *! 标记的配件不可选用');if(row.deletedAt)throw Error('该输出源已删除，请先恢复');const {sourceId,goodsId,name,erp,tax}=row;return{sourceId,goodsId,name,erp,tax,hardwareOverrides:row.hardwareOverrides?clone(row.hardwareOverrides):undefined,hardwareFacts:row.hardwareFacts?clone(row.hardwareFacts):undefined,erpSpec:row.erpSpec,erpModel:row.erpModel,erpCategory:row.erpCategory,capacityOverrides:row.capacityOverrides?clone(row.capacityOverrides):undefined,taxOverride:null,upgrade:'',sourceFollow:{sourceId,name:{mode:'follow',value:name,sourceValue:name},upgrade:{mode:'follow',value:'',sourceValue:sourceUpgradeDescription(row)}},specialComponent:isSpecialComponent(row),stockAvailable:row.stockAvailable??null,stockIncomingAvailable:row.stockIncomingAvailable??null,stockUpdatedAt:row.stockUpdatedAt??null,stockSource:row.stockSource??null,erpUpdatedAt:row.erpUpdatedAt??null,erpMissing:row.erpMissing??false,erpUnknown:row.erpUnknown??(erp==null),erpName:row.erpName||row.originalName||name};}
export function sourceUpgradeDescription(row,previous=[]){
 const text=selectedSourceAddons(row,previous).map(a=>a.text?.trim()).filter(Boolean).join('');
 // 明确清空或关闭展示也是有效设置，不能再取回旧 upgrade 文案。
 return text||(hasDescriptionSetting(row)?'':String(row.upgrade||'').trim());
}
/** 双侧换件和批量任务都按最终展示清单核对来源，保留仍被引用的加购和独立服务。 */
export function syncReplacementAddons(config,previous,replacements){
 const used=new Set(config.parts.map(part=>part.sourceId));
 config.addons=config.addons.filter(addon=>{
  if(replacements.has(addon.sourceId))return false;
  if(!previous.has(addon.sourceId)||used.has(addon.sourceId))return true;
  // 换到本地来源或特殊件时只撤掉孤立的跟随组，保留旧版人工选定的加购快照。
  return !previous.get(addon.sourceId)&&addon.followPolicy!=='follow';
 });
 for(const row of replacements.values())config.addons.push(...sourceAddonsForSync(row,{follow:true,keepEmpty:true}));
}
/** 在指定配件位置应用新来源，并处理加购及升级描述关联。 */
export function replaceSourcePart(config,index,row,{syncAddons=true}={}){
 const previous=config.parts[index].sourceId;
 const description=sourceUpgradeDescription(row,row.sharedSourceId?[]:config.addons?.filter(a=>a.sourceId===row.sourceId)||[]);
 delete config.parts[index].displayName;
 Object.assign(config.parts[index],sourcePart(row),{upgrade:description});
 config.parts[index].sourceFollow.upgrade={mode:'follow',value:description,sourceValue:description};
 // NAS 共用来源的新选择同时建立真实加购组，避免新配置只有文案而销售读不到商品和金额。
 if(Array.isArray(config.addons)){
  if(syncAddons&&(row.sharedSourceId||previous&&previous!==row.sourceId)){
   const previousSources=new Map(previous?[[previous,Boolean(row.sharedSourceId)]]:[]);
   syncReplacementAddons(config,previousSources,new Map(row.sharedSourceId?[[row.sourceId,row]]:[]));
  }
  if(row.sharedSourceId)config.parts[index].sourceFollow.upgrade.structured=true;
 }
}
const hasDescriptionSetting=row=>row.addonChoices!==undefined||row.addonShowTogether!==undefined||(row.addonVariants||[]).some(v=>v.showTogether!==undefined);
const descriptionFields=fields=>[...new Set(fields.map(field=>field==='addon'?'upgrade':field))];
function sourceRefs(configs,row,index){
 if(index)return row.shopId==null?index.bySourceIdAny(row.sourceId):index.bySourceId(row.shopId,row.sourceId);
 // 单次或小配置查询直接扫描展示行，省去建索引；整批多来源调用传入操作内索引。
 return configs.flatMap(config=>row.shopId!=null&&(config.shopId||'intel')!==row.shopId?[]:(config.parts||[]).filter(part=>part.sourceId===row.sourceId).map(part=>({config,part})));
}
function sourceDifferences(refs,row,fields){
 const grouped=new Map();
 for(const {config,part} of refs){
  if(config.deletedAt)continue;
  const description=fields.includes('upgrade')?sourceUpgradeDescription(row,config.addons?.filter(a=>a.sourceId===row.sourceId)||[]):'';
  const changes=[];
  for(const key of ['name','tax','upgrade']){
   if(!fields.includes(key))continue;
   const target=key==='upgrade'?description:row[key];
   if(key==='upgrade'&&(!String(part.upgrade??'').trim()||!target&&!hasDescriptionSetting(row)))continue;
   if((part[key]??'')!==(target??''))changes.push({slot:part.slot,field:key,before:part[key]??'',after:target??''});
  }
  if(changes.length){if(!grouped.has(config))grouped.set(config,[]);grouped.get(config).push(...changes);}
 }
 return grouped;
}
// 第四参数是本次操作创建的引用索引；只有 name/tax/upgrade 变化时可以复用，关联字段变化后须重建。
// 预览仅检查展示配件 parts；实际核算配件 actualParts 不受输出源显示资料同步影响。
/** 比较来源字段与所有相关配置配件，生成同步差异。 */
export function sourceDiff(configs,row,fields,index){
 const grouped=sourceDifferences(sourceRefs(configs,row,index),row,descriptionFields(fields));
 return [...grouped].map(([config,changes])=>({configId:config.id,product:config.product,name:config.name,changes}));
}
/** 仅同步明确选定的来源字段到其引用配置。 */
export function syncSource(configs,row,fields,index){
 fields=descriptionFields(fields);
 const grouped=sourceDifferences(sourceRefs(configs,row,index),row,fields);
 for(const {config,part} of sourceRefs(configs,row,index)){
  if(!grouped.has(config))continue;
  for(const key of ['name','tax','upgrade'])if(fields.includes(key)){
   if(key==='upgrade'&&!String(part.upgrade??'').trim())continue;
   const target=key==='upgrade'?sourceUpgradeDescription(row,config.addons?.filter(a=>a.sourceId===row.sourceId)||[]):row[key];
   if(key!=='upgrade'||target||hasDescriptionSetting(row))part[key]=target;
  }
 }
 for(const [config,changes] of grouped)if(changes.some(change=>change.field==='tax'))config.taxUpdatedAt=new Date().toISOString();
 return [...grouped].map(([config,changes])=>({configId:config.id,product:config.product,name:config.name,changes}));
}

/** 维护来源软删除状态，保留历史引用需要的记录。 */
export function setSourceDeleted(rows,id,deleted=true,at=new Date().toISOString()){const row=rows.find(r=>r.sourceId===id);if(!row)throw Error('输出源不存在');if(deleted)row.deletedAt=at;else delete row.deletedAt;return row;}

// 展示描述来自店铺输出源；ERP 名称只是搜索别名，成本字段不由展示名称决定。
/** 结合成本资料返回适合供用户选择的来源行。 */
export function preferredSourceRows(rows,costs=[]){
 const byId=new Map(costs.map(r=>[r.goodsId,r]));
 return rows.map(r=>{
  if(isSpecialComponent(r))return normalizeSpecialComponent(r);
  const cost=byId.get(r.goodsId);
  const name=String(r.name||'').trim()||r.originalName||cost?.name||'';
  if(!cost)return {...r,name};
  // 老快照省略字段时保留来源大类，明确的 null 原样传给换件候选。
  return {...r,name,...(cost.erpCategory!==undefined?{erpCategory:cost.erpCategory}:{}),
   erp:cost.erp??null,tax:cost.tax??r.tax,stockAvailable:cost.stockAvailable??null,
   stockIncomingAvailable:cost.stockIncomingAvailable??null,stockUpdatedAt:cost.stockUpdatedAt??null,stockSource:cost.stockSource??null,
   erpMissing:cost.erpMissing??false,erpUnknown:cost.erpUnknown??(cost.erp==null),erpName:cost.name||r.erpName||r.originalName||r.name};
 }).sort((a,b)=>Number(!!b.name&&!!(b.originalName||byId.get(b.goodsId)?.name)&&b.name!==(b.originalName||byId.get(b.goodsId)?.name))-Number(!!a.name&&!!(a.originalName||byId.get(a.goodsId)?.name)&&a.name!==(a.originalName||byId.get(a.goodsId)?.name)));
}
