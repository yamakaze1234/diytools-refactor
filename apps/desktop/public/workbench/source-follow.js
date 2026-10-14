/** 来源字段跟随规则：区分自动跟随与手工覆盖，避免更新输出源时覆盖配置自定义内容。 */
import {sourceUpgradeDescription} from './source.js';
import {selectableComponents} from './component-policy.js';

const copy=value=>structuredClone(value);
const effective=(part,field)=>String(field==='name'?(part.displayName||part.name||''):(part.upgrade??''));
const sourceValue=(config,row,field)=>field==='name'?String(row.name||''):sourceUpgradeDescription(row,config.addons?.filter(addon=>addon.sourceId===row.sourceId)||[]);
const catalog=rows=>new Map(selectableComponents(rows).filter(row=>!row.deletedAt).map(row=>[JSON.stringify([row.shopId||'intel',row.sourceId]),row]));
function observe(record,value){if(record.sourceValue!==value)delete record.ignoredSourceValue;record.sourceValue=value;}
function sourceFor(index,config,part){
 const row=index.get(JSON.stringify([config.shopId||'intel',part.sourceId]));
 return row&&row.sourceId&&String(row.goodsId??'')===String(part.goodsId??'')?row:null;
}
function initializePart(config,part,row){
 // 未绑定输出源的空白配件也允许手工编辑，先建立跟随记录。
 if(!part.sourceFollow||part.sourceFollow.sourceId!==part.sourceId)part.sourceFollow={sourceId:part.sourceId};
 for(const field of ['name','upgrade']){
  const value=effective(part,field),target=sourceValue(config,row,field),previous=part.sourceFollow[field];
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
 part.sourceFollow[field]={mode:'follow',value,sourceValue:value};
}
/** 比较来源前后值，只更新仍符合跟随条件的配置字段。 */
export function followSourceChanges(configs,beforeRows,afterRows){
 const beforeIndex=catalog(beforeRows),afterIndex=catalog(afterRows),configIds=new Set();let count=0;
 for(const config of configs){
  if(config.deletedAt)continue;
  for(const part of config.parts||[]){
   const before=sourceFor(beforeIndex,config,part),after=sourceFor(afterIndex,config,part);if(!before||!after)continue;
   if(['name','upgrade'].every(field=>sourceValue(config,before,field)===sourceValue(config,after,field)))continue;
   const previousPart=JSON.stringify(part),tracking=initializePart(config,part,before);
   for(const field of ['name','upgrade']){
    const oldSource=sourceValue(config,before,field),target=sourceValue(config,after,field),record=tracking[field];
    if(oldSource!==target&&record.mode==='follow'){
     if(effective(part,field)!==target){count++;configIds.add(config.id);}
     writeFollow(part,field,target);
    }else observe(record,target);
   }
   // Keep the search/model name current without changing a manual picture label.
   if(part.name!==after.name){
    const label=effective(part,'name');
    if(tracking.name.mode==='manual')part.displayName=label;
    part.name=after.name;configIds.add(config.id);
   }
   if(JSON.stringify(part)!==previousPart)configIds.add(config.id);
  }
 }
 return {configIds:[...configIds],count};
}
export const sourceFollowKey=(configId,sourceId,partIndex,slot,field)=>JSON.stringify([configId,sourceId,partIndex,slot,field]);
/** 按店铺与字段范围生成来源跟随预览。 */
export function sourceFollowPlan(configs,rows,fields,shopId,options={}){
 fields=[...new Set(fields.map(field=>field==='addon'?'upgrade':field))].filter(field=>['name','upgrade','tax'].includes(field));
 if(!fields.length)throw Error('请至少勾选一个同步字段');
 const index=catalog(rows),sources=new Map(),changes=[],keys=options.keys?new Set(options.keys):null;
 for(const config of configs){
  if(config.deletedAt||(config.shopId||'intel')!==shopId||options.productIds&&!options.productIds.includes(config.productId))continue;
  const after=copy(config),details=[];
  for(const [partIndex,part] of (after.parts||[]).entries()){
   const row=sourceFor(index,after,part);if(!row)continue;
   initializePart(after,part,row);
   for(const field of fields){
    const key=sourceFollowKey(config.id,part.sourceId,partIndex,part.slot,field);if(keys&&!keys.has(key))continue;
    const target=field==='tax'?row.tax:sourceValue(after,row,field),current=field==='tax'?part.tax:effective(part,field),record=part.sourceFollow[field];
    if((current??'')===(target??''))continue;
    if(field!=='tax'&&(record.mode!=='manual'||Object.hasOwn(record,'ignoredSourceValue')&&record.ignoredSourceValue===target))continue;
    if(field==='tax'&&options.action==='ignore')continue;
    details.push({key,slot:part.slot,partIndex,sourceId:part.sourceId,field,before:current??'',after:target??'',manual:field!=='tax',action:options.action==='ignore'?'ignore':'update'});
    if(field==='tax'){part.tax=target;after.taxUpdatedAt=new Date().toISOString();}
    else if(options.action==='ignore'){record.ignoredSourceValue=target;record.mode='manual';}
    else writeFollow(part,field,target);
    sources.set(row.sourceId,copy(row));
   }
  }
  if(details.length)changes.push({id:config.id,product:config.product,name:config.name,before:copy(config),after,details});
 }
 return {shopId,fields,action:options.action==='ignore'?'ignore':'update',sources:[...sources.values()],changes};
}
