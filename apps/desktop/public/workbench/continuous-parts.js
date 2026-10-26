/** Continuous editor projection and atomic row transfer; no persistence or source writes. */
import {slots} from './core.js';
import {actualParts} from './actual-parts.js';
import {sourcePart} from './source.js';

export const continuousSlots=Object.freeze(slots.slice(0,14));
const clone=value=>structuredClone(value);
const occupied=part=>part&&Boolean(part.sourceId||part.goodsId||String(part.name||part.displayName||'').trim());
const accessoryNumber=slot=>/^配件[1-9]\d*$/.test(slot)?Number(slot.slice(2)):0;
const blank=slot=>({slot,name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''});

/** 默认14栏，后续编号配件按序展示；空行也保留，便于保存后继续编辑。 */
export function continuousSlotsFor(config){
 const extras=new Set([...(config.parts||[]),...actualParts(config)].map(p=>p.slot).filter(slot=>Number.isSafeInteger(accessoryNumber(slot))&&accessoryNumber(slot)>5));
 return [...continuousSlots,...[...extras].sort((a,b)=>accessoryNumber(a)-accessoryNumber(b))];
}
export function appendAccessoryRow(config){
 const next=Math.max(5,...continuousSlotsFor(config).map(accessoryNumber))+1;
 if(!Number.isSafeInteger(next))throw Error('配件编号超出有效范围');
 const slot=`配件${next}`;
 // 先复制旧版实际配件回退值，保证展示与实际列仍独立。
 config.actualParts=clone(actualParts(config));config.parts??=[];
 config.parts.push(blank(slot));config.actualParts.push(blank(slot));return slot;
}

/** 删除展示和实际的当前行；共用输出源的加购仍保留，固定栏位回到空白占位。 */
export function planRemoveRow(config,slot){
 const row=projectedRows(config).find(row=>row.slot===slot);
 if(!row)throw Error('配件行已变化，请重新选择');
 const after=clone(config),sources=new Set([row.part?.sourceId,row.actual?.sourceId].filter(Boolean));
 after.actualParts=clone(actualParts(config));
 after.parts=(after.parts||[]).filter((_,i)=>i!==row.partIndex);
 after.actualParts=after.actualParts.filter((_,i)=>i!==row.actualIndex);
 const remaining=new Set([...after.parts,...after.actualParts].map(p=>p.sourceId).filter(Boolean));
 after.addons=(after.addons||[]).filter(a=>!sources.has(a.sourceId)||remaining.has(a.sourceId));
 return after;
}

/** Missing rows are view placeholders. Duplicate and extra slots remain in storage. */
export function projectedRows(config){
 const parts=config.parts||[],actual=actualParts(config),usedParts=new Set(),usedActual=new Set();
 const rows=continuousSlotsFor(config).map((slot,index)=>{
  const partIndex=parts.findIndex(p=>p.slot===slot),actualIndex=actual.findIndex(p=>p.slot===slot);
  if(partIndex>=0)usedParts.add(partIndex);if(actualIndex>=0)usedActual.add(actualIndex);
  return {slot,index,part:parts[partIndex]??null,actual:actual[actualIndex]??null,partIndex,actualIndex};
 });
 rows.extras={parts:parts.filter((_,i)=>!usedParts.has(i)),actualParts:actual.filter((_,i)=>!usedActual.has(i))};
 return rows;
}

export function copyRows(config,indexes){
 const projected=projectedRows(config);
 if(!Array.isArray(indexes)||!indexes.length||indexes.some(i=>!Number.isInteger(i)||i<0||i>=projected.length))throw Error('请选择有效的配件行');
 return clone({shopId:config.shopId,rows:[...new Set(indexes)].sort((a,b)=>a-b).map(index=>{
  const {part,actual}=projected[index],sources=new Set([part?.sourceId,actual?.sourceId].filter(Boolean));
  return {part,actual,addons:(config.addons||[]).filter(a=>sources.has(a.sourceId))};
 })});
}

function rebound(part,slot,shopId,catalog){
 if(!occupied(part))return null;
 const source=catalog.find(row=>row.sourceId===part.sourceId&&row.goodsId===part.goodsId&&row.shopId===shopId&&!row.deletedAt);
 if(!part.sourceId||!source)throw Error('复制的配件尚未绑定有效输出源或已删除，请重新选择配件');
 // sourcePart enforces the same excluded-component policy as the existing picker.
 const next={...clone(part),...sourcePart(source),slot};
 for(const key of ['qty','upgrade','displayName','sourceFollow','taxOverride','memoryUpgradeConfirmed'])if(Object.hasOwn(part,key))next[key]=clone(part[key]);
 if(part.sourceFollow?.name?.mode==='manual')next.name=part.name;
 if(part.taxOverride)next.tax=part.tax;
 return next;
}

/** Build a complete validated replacement; an exception never changes the input. */
export function planPasteRows(config,start,payload,catalog){
 if(!payload||payload.shopId!==config.shopId)throw Error('请先复制当前店铺的配件，不能跨店铺粘贴');
 if(!Array.isArray(payload.rows)||!payload.rows.length)throw Error('没有可粘贴的配件行');
 const targetSlots=continuousSlotsFor(config);
 if(!Number.isInteger(start)||start<0||start+payload.rows.length>targetSlots.length)throw Error('目标剩余行数不足，请先在底部新增配件；未粘贴任何配件');
 if(!Array.isArray(catalog))throw Error('输出源尚未加载');
 const after=clone(config),before=projectedRows(after);
 after.parts=after.parts||[];
 after.actualParts=clone(actualParts(after));
 after.addons=after.addons||[];
 const transfers=payload.rows.map((row,offset)=>{
  if(!row||typeof row!=='object'||!Array.isArray(row.addons))throw Error('复制内容无效');
  const slot=targetSlots[start+offset],extra=!continuousSlots.includes(slot),part=rebound(row.part,slot,after.shopId,catalog)||(extra?blank(slot):null),actual=rebound(row.actual,slot,after.shopId,catalog)||(extra?blank(slot):null);
  if(actual)delete actual.displayName;
  const sources=new Set([part?.sourceId,actual?.sourceId].filter(Boolean));
  if(row.addons.some(addon=>!addon||!sources.has(addon.sourceId)))throw Error('加购内容与复制配件不一致');
  return {part,actual,addons:clone(row.addons),target:before[start+offset]};
 });
 // Replace existing rows in place, then remove cleared rows by original index.
 const removedParts=new Set(),removedActual=new Set(),oldSources=new Set();
 for(const {part,actual,target} of transfers){
  for(const old of [target.part,target.actual])if(old?.sourceId)oldSources.add(old.sourceId);
  for(const [key,index,value,removed] of [['parts',target.partIndex,part,removedParts],['actualParts',target.actualIndex,actual,removedActual]]){
   if(index>=0){if(value)after[key][index]=value;else removed.add(index);}else if(value)after[key].push(value);
  }
 }
 after.parts=after.parts.filter((_,i)=>!removedParts.has(i));
 after.actualParts=after.actualParts.filter((_,i)=>!removedActual.has(i));
 const remainingSources=new Set([...after.parts,...after.actualParts].map(part=>part.sourceId).filter(Boolean));
 after.addons=after.addons.filter(addon=>!oldSources.has(addon.sourceId)||remainingSources.has(addon.sourceId));
 // Addons are source-scoped in the existing model, so shared sources stay one group.
 const incoming=new Map();
 for(const transfer of transfers)for(const part of [transfer.part,transfer.actual])if(part?.sourceId&&!incoming.has(part.sourceId))incoming.set(part.sourceId,transfer.addons.filter(addon=>addon.sourceId===part.sourceId));
 for(const [sourceId,addons] of incoming){after.addons=after.addons.filter(addon=>addon.sourceId!==sourceId);after.addons.push(...addons);}
 return after;
}
