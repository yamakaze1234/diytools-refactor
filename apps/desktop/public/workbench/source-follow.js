/** 来源字段跟随规则：区分自动跟随与手工覆盖，避免更新输出源时覆盖配置自定义内容。 */
import {sourceUpgradeDescription} from './source.js';
import {selectableComponents} from './component-policy.js';

const copy=value=>structuredClone(value);
const effective=(part,field)=>String(field==='name'?(part.displayName||part.name||''):(part.upgrade??''));
// textOnly 属于配置展示字段，不改变来源的加购选配、商品或计价。
const sourceValue=(config,row,field,part)=>field==='name'?String(row.name||''):part?.sourceFollow?.upgrade?.textOnly===true?
 String(row.addonText??''):sourceUpgradeDescription(row,config.addons?.filter(addon=>addon.sourceId===row.sourceId)||[]);
const catalog=rows=>new Map(selectableComponents(rows).filter(row=>!row.deletedAt).map(row=>[JSON.stringify([row.shopId||'intel',row.sourceId]),row]));
const DAY_MS=86400000;
export const IGNORED_RETENTION_MS=7*DAY_MS;
function clearIgnore(record){
 delete record.ignoredSourceValue;
 delete record.ignoredAt;
}
function observe(record,value){
 // 忽略绑定到本次来源内容；下个不同版本重新提醒，已过期的同值仍保持静默。
 if(Object.hasOwn(record,'ignoredSourceValue')&&record.ignoredSourceValue!==value)clearIgnore(record);
 record.sourceValue=value;
}
function sourceFor(index,config,part){
 const row=index.get(JSON.stringify([config.shopId||'intel',part.sourceId]));
 return row&&row.sourceId&&String(row.goodsId??'')===String(part.goodsId??'')?row:null;
}
function initializePart(config,part,row){
 // 未绑定输出源的空白配件也允许手工编辑，先建立跟随记录。
 if(!part.sourceFollow||part.sourceFollow.sourceId!==part.sourceId)part.sourceFollow={sourceId:part.sourceId};
 for(const field of ['name','upgrade']){
  const value=effective(part,field),target=sourceValue(config,row,field,part),previous=part.sourceFollow[field];
  if(!previous||!['follow','manual'].includes(previous.mode))part.sourceFollow[field]={mode:value===target?'follow':'manual',value,sourceValue:target};
  else if(previous.value!==value){part.sourceFollow[field]={mode:'manual',value,sourceValue:target};}
  else observe(previous,target);
 }
 return part.sourceFollow;
}
/** 为旧配置建立来源字段跟随状态，供后续增量同步判断。 */
export function initializeSourceFollow(configs,rows){
 const index=catalog(rows);
 for(const config of configs){if(config.deletedAt)continue;for(const part of config.parts||[]){const row=sourceFor(index,config,part);if(row)initializePart(config,part,row);}}
 return configs;
}
/** 用户手工编辑字段后明确解除该字段的自动跟随。 */
export function markSourceFieldManual(part,field){
 if(!['name','upgrade'].includes(field))return;
 // 未绑定输出源的空白配件也允许手工编辑，先建立跟随记录。
 if(!part.sourceFollow||part.sourceFollow.sourceId!==part.sourceId)part.sourceFollow={sourceId:part.sourceId};
 const previous=part.sourceFollow[field];
 part.sourceFollow[field]={mode:'manual',value:effective(part,field),...(previous&&Object.hasOwn(previous,'sourceValue')?{sourceValue:previous.sourceValue}:{})};
}
function writeFollow(part,field,value){
 if(field==='name'){part.name=value;delete part.displayName;}else part.upgrade=value;
 const textOnly=field==='upgrade'&&part.sourceFollow[field]?.textOnly===true;
 const structured=field==='upgrade'&&part.sourceFollow[field]?.structured===true;
 part.sourceFollow[field]={mode:'follow',value,sourceValue:value,...(textOnly?{textOnly:true}:{}),...(structured?{structured:true}:{})};
}
/** 比较来源前后值，只更新仍符合跟随条件的配置字段。 */
export function followSourceChanges(configs,beforeRows,afterRows,{captureChanges=false,deferUpgrade=false,deferText=false}={}){
 const beforeIndex=catalog(beforeRows),afterIndex=catalog(afterRows),configIds=new Set();let count=0;
 const automatic=new Map();
 for(const config of configs){
  if(config.deletedAt)continue;
  for(const [partIndex,part] of (config.parts||[]).entries()){
   const before=sourceFor(beforeIndex,config,part),after=sourceFor(afterIndex,config,part);if(!before||!after)continue;
   if(['name','upgrade'].every(field=>sourceValue(config,before,field,part)===sourceValue(config,after,field,part)))continue;
   const previousPart=JSON.stringify(part),tracking=initializePart(config,part,before);
   for(const field of ['name','upgrade']){
    const oldSource=sourceValue(config,before,field,part),target=sourceValue(config,after,field,part),record=tracking[field];
    if(oldSource!==target&&record.mode==='follow'&&!deferText&&!(deferUpgrade&&field==='upgrade')){
     if(effective(part,field)!==target){
      count++;configIds.add(config.id);
      if(captureChanges){
       if(!automatic.has(config.id))automatic.set(config.id,{id:config.id,product:config.product,name:config.name,before:{shopId:config.shopId||'intel',productId:config.productId},details:[]});
       automatic.get(config.id).details.push({key:sourceFollowKey(config.id,part.sourceId,partIndex,part.slot,field),slot:part.slot,partIndex,sourceId:part.sourceId,field,before:effective(part,field),after:target});
      }
     }
     writeFollow(part,field,target);
    }else observe(record,target);
   }
   // 需要决策时连搜索用名称也先保留，避免绕过展示名称的跟随状态。
   if(!deferText&&part.name!==after.name){
    const label=effective(part,'name');
    if(tracking.name.mode==='manual')part.displayName=label;
    part.name=after.name;configIds.add(config.id);
   }
   if(JSON.stringify(part)!==previousPart)configIds.add(config.id);
  }
 }
 return {configIds:[...configIds],count,...(captureChanges?{autoChanges:[...automatic.values()]}:{})};
}
export const sourceFollowKey=(configId,sourceId,partIndex,slot,field)=>JSON.stringify([configId,sourceId,partIndex,slot,field]);
// 时间缺失的旧忽略记录继续有效，无法确定剩余天数时不进入七天回看列表。
export function ignoreDaysLeft(ignoredAt,now){
 const remaining=Date.parse(ignoredAt)+IGNORED_RETENTION_MS-now;
 return remaining>0?Math.max(1,Math.ceil(remaining/DAY_MS)):0;
}
// 角标、复核和保存后提示共用一个差异判据。只有真正构造保存计划时复制配置正文。
function* differences(configs,rows,fields,shopId,options){
 const action=options.action??'update',now=new Date(options.now??Date.now());
 const sourceIds=options.sourceIds?new Set(options.sourceIds):null;
 const index=catalog(sourceIds?rows.filter(row=>sourceIds.has(row.sourceId)):rows);
 const keys=options.keys?new Set(options.keys):null;
 for(const config of configs){
  if(config.deletedAt||(config.shopId||'intel')!==shopId||options.productIds&&!options.productIds.includes(config.productId))continue;
  for(const [partIndex,part] of (config.parts||[]).entries()){
   const row=sourceFor(index,config,part);if(!row)continue;
   // 在副本上识别旧数据的跟随状态；只把明确选中的字段写入计划正文。
   const working={...part,sourceFollow:copy(part.sourceFollow)};
   const previous=options.previousSources?.get(row.sourceId);
   if(previous)initializePart(config,working,previous);
   const tracking=initializePart(config,working,row);
   for(const field of fields){
    if(options.fieldsBySource&&!options.fieldsBySource.get(row.sourceId)?.includes(field))continue;
    const key=sourceFollowKey(config.id,part.sourceId,partIndex,part.slot,field);if(keys&&!keys.has(key))continue;
    const target=field==='tax'?row.tax:tracking[field].sourceValue,current=field==='tax'?part.tax:effective(part,field),record=tracking[field];
    if((current??'')===(target??''))continue;
    // 核算价始终需要人工确认，且不能忽略。
    const kind=field==='tax'?'manual':record.mode;
    const ignored=field!=='tax'&&Object.hasOwn(record,'ignoredSourceValue')&&record.ignoredSourceValue===target;
    const ignoredAt=ignored?record.ignoredAt??null:null;
    const daysLeft=ignored?ignoreDaysLeft(ignoredAt,now):0;
    if(ignored&&(!daysLeft||!options.includeIgnored&&action!=='unignore'))continue;
    if(action==='unignore'&&!ignored)continue;
    if(action==='ignore'&&(field==='tax'||ignored))continue;
    if(options.kind&&options.kind!==kind)continue;
    const detail={key,slot:part.slot,partIndex,sourceId:part.sourceId,field,before:current??'',after:target??'',
     kind,manual:kind==='manual'&&field!=='tax',sourceName:row.name||row.erpName||row.originalName||'',
     changedAt:row.updatedAt||null,ignored,ignoredAt,daysLeft,action};
    yield {config,row,detail,record,target};
   }
  }
 }
}

/** 按店铺与字段范围生成可核验的计划，未选择的字段（包括人工记录）原样保留。 */
export function sourceFollowPlan(configs,rows,fields,shopId,options={}){
 fields=[...new Set(fields.map(field=>field==='addon'?'upgrade':field))].filter(field=>['name','upgrade','tax'].includes(field));
 if(!fields.length)throw Error('请至少勾选一个同步字段');
 const sources=new Map(),changes=new Map(),action=options.action??'update',now=options.now??Date.now();
 const at=new Date(now).toISOString();
 for(const {config,row,detail,record,target} of differences(configs,rows,fields,shopId,{...options,now})){
  if(!sources.has(row.sourceId))sources.set(row.sourceId,copy(row));
  if(!changes.has(config.id))changes.set(config.id,{id:config.id,product:config.product,name:config.name,before:copy(config),after:copy(config),details:[]});
  const change=changes.get(config.id),{field,sourceId,partIndex}=detail;
  change.details.push(detail);
  const edited=change.after.parts[partIndex];
  if(field==='tax'){edited.tax=target;change.after.taxUpdatedAt=at;continue;}
  if(detail.ignored&&action!=='unignore')continue;
  if(!edited.sourceFollow||edited.sourceFollow.sourceId!==sourceId)edited.sourceFollow={sourceId};
  edited.sourceFollow[field]=record;
  if(action==='ignore'){record.ignoredSourceValue=target;record.ignoredAt=at;}
  else if(action==='unignore')clearIgnore(record);
  else writeFollow(edited,field,target);
 }
 return {shopId,fields,action,sources:[...sources.values()],changes:[...changes.values()]};
}

// 导航提醒和弹窗首次打开使用同一组文案字段。核算单价可在差异窗内单独核对。
export const sourceAlertFields=Object.freeze(['upgrade','name']);
/** 轻量统计本店待确认明细，不复制完整配置或图片资料。 */
export function sourceFollowSummary(configs,rows,shopId,{fields=sourceAlertFields,sourceIds,now}={}){
 let count=0,latestChangedAt=null,latestTime=-Infinity;
 for(const {detail} of differences(configs,rows,fields,shopId,{sourceIds,now})){
  count++;
  const time=Date.parse(detail.changedAt);
  if(time>latestTime){latestTime=time;latestChangedAt=detail.changedAt;}
 }
 return {count,latestChangedAt};
}

/** 保存后的决策窗只处理本店刚变动来源的跟随文案，人工文案仅计数。 */
export function followPendingSourcePlan(configs,rows,shopId,{fieldsBySource,previousRows=[]}){
 const edited=new Set([...fieldsBySource.values()].flat());
 const fields=['name','upgrade'].filter(field=>edited.has(field));
 const options={sourceIds:[...fieldsBySource.keys()],fieldsBySource,previousSources:new Map(previousRows.map(row=>[row.sourceId,row]))};
 const plan=fields.length?sourceFollowPlan(configs,rows,fields,shopId,{...options,kind:'follow'}):
  {shopId,fields,action:'update',sources:[],changes:[]};
 const linkKey=c=>c.productId||c.product||c.spu||c.id;
 const manualIds=new Set(),manualLinks=new Set();
 for(const {config} of differences(configs,rows,fields,shopId,{...options,kind:'manual'})){
  manualIds.add(config.id);manualLinks.add(linkKey(config));
 }
 return {...plan,followConfigCount:plan.changes.length,followLinkCount:new Set(plan.changes.map(c=>linkKey(c.before))).size,
  manualConfigCount:manualIds.size,manualLinkCount:manualLinks.size};
}
