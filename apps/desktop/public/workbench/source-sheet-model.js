/** 输出源工作表只投影现有目录。保存时仍交给原目录接口校验权限、版本与回执。 */
import {observedErpCategory,categoryFromName} from './component-category.js';
import {slots,erpUnitCost} from './core.js';
import {componentStock} from './inventory-check-data.js';
import {excludedComponent} from './component-policy.js';
import {erpCategoryFields} from './erp-sync.js';
import {latestErpName,splitErpName} from './erp-part-description.js';
import {validateHardware} from './component-hardware.js';
import {validateCapacities} from './component-capacity.js';
import {isSpecialComponent,normalizeSpecialComponent,isSpecialPresetId} from './special-components.js';
import {sourceFields,withSourceFields,sharedSourceKeys,sourceGoodsId} from './shared-source-fields.js';
import {fieldState,sharedScopeRow,sourceAliasOverrides} from './shared-source-editor.js';
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {addonItems,choiceText,sourceAddonOptions} from './addon-data.js';

export const sourceSheetCategories=['全部配件','CPU','主板','显卡','内存','硬盘','散热','风扇','机箱','电源','其他配件','特殊配件'];
export const sourceSheetFilters=[['active','全部在用'],['different','三店有差异'],['addons','有升级项'],['unavailable','缺货 / 停产'],['missing-tax','待填核算价'],['tax-high','核算价高于ERP'],['tax-low','核算价低于ERP'],['pending','待保存修改'],['deleted','已删除']];
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
// 成本分类、来源历史分类和真实引用依次判定；缺少资料才读名称。
export function sourceSheetCategory(row,referenceSlots=[],cost){
 if(isSpecialComponent(row))return '特殊配件';
 const explicit=observedErpCategory(cost?.erpCategory,row.erpCategory);
 const slot=[...referenceSlots,row.slot].find(value=>slots.includes(value)&&!value.startsWith('配件'));
 return explicit||slot||categoryFromName([row.erpName,row.name,row.originalName,row.erpModel].join(' '))||'其他配件';
}

function collectSourceIds(value,ids,found){
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){
  if((key==='sourceId'||key==='source_id')&&ids.has(child))found.add(child);
  else if(child&&typeof child==='object')collectSourceIds(child,ids,found);
 }
}

/** 配置撤销/重做里旧的配件与加购也可能重新引入已彻底删除的货源。 */
export function historyReferencesDeletedSource(entry,shop,ids){
 const found=new Set();
 for(const config of [...(entry.configs??[]),...(entry.baseline?.configs??[])]){
  if((config.shopId||'intel')===shop)collectSourceIds(config,ids,found);
  if(found.size)return true;
 }
 return false;
}

/** 本机整库按来源 ID 计数；同套配置的展示行、实际行及加购重复引用只记一次。 */
export function localDeletedSources(state,shop){
 const rows=(state.sourceCatalog??[]).filter(row=>(row.shopId||'intel')===shop&&row.deletedAt!=null);
 const counts=new Map(rows.map(row=>[row.sourceId,{configurations:0,templates:0}]));
 if(!counts.size)return [];
 // 归档配置与软删除模板均保留快照，恢复后仍需要原输出源。
 for(const config of state.configs??[]){
  if((config.shopId||'intel')!==shop)continue;
  const found=new Set();
  for(const part of [...(config.parts??[]),...(config.actualParts??[])]){
   if(counts.has(part.sourceId))found.add(part.sourceId);
  }
  collectSourceIds(config.addons,counts,found);
  for(const id of found)counts.get(id).configurations++;
 }
 for(const template of state.templates??[]){
  if((template.shopId||'intel')!==shop)continue;
  const found=new Set();
  collectSourceIds(template.configurations??template.configs??template.config,counts,found);
  for(const id of found)counts.get(id).templates++;
 }
 return rows.map(row=>({...row,references:counts.get(row.sourceId)}));
}

/** 旧版 NAS 可能没有引用统计。只有两个计数都有效时才允许按零引用清理。 */
export function deletedSourceUses(refs){
 if(!refs||![refs.configurations,refs.templates].every(value=>Number.isSafeInteger(value)&&value>=0))return null;
 return refs.configurations+refs.templates;
}

/** 写入前重读本店完整引用，批内任一项已恢复、重删或被引用则整批不变。 */
export function changeLocalDeletedSources(state,shop,targets,action){
 if(!['restore','purge'].includes(action))throw Error('无效的输出源操作');
 const current=new Map(localDeletedSources(state,shop).map(row=>[row.sourceId,row]));
 const ids=new Set();
 for(const target of targets){
  const row=current.get(target.sourceId);
  if(!row||row.deletedAt!==target.deletedAt)throw Error('输出源状态已变化，请刷新后重新选择');
  if(action==='purge'&&deletedSourceUses(row.references)>0)throw Error('输出源仍被 '+row.references.configurations+' 套配置、'+row.references.templates+' 个模板引用');
  ids.add(row.sourceId);
 }
 if(action==='restore'){
  for(const row of state.sourceCatalog)if((row.shopId||'intel')===shop&&ids.has(row.sourceId))delete row.deletedAt;
 }else{
  state.sourceCatalog=state.sourceCatalog.filter(row=>(row.shopId||'intel')!==shop||!ids.has(row.sourceId));
  // 内置特殊配件是虚拟候选，记录被删除的预设才不会在下次投影时重新补入。
  state.shopSettings??={};
  const settings=state.shopSettings[shop]??={coupon:0};
  const presets=[...ids].filter(id=>isSpecialPresetId(id,shop));
  if(presets.length)settings.purgedSourcePresets=[...new Set([...(settings.purgedSourcePresets??[]),...presets])];
  if(!state.sourceCatalog.length)settings.sourceCatalogEmptied=true;
 }
}

/** 30 天按停用的准确时刻计算；仍受保护的到期项继续保留。 */
export function deletedSourceTimestamp(deletedAt){
 if(typeof deletedAt!=='string'||!/^\d{4}-\d\d-\d\d(?:[Tt ].+)?$/.test(deletedAt))return NaN;
 const day=deletedAt.slice(0,10),calendar=new Date(day+'T00:00:00Z');
 // Date.parse 会把 2 月 31 日顺延到 3 月；服务端拒绝的历史日期也要在界面标为待核对。
 if(!Number.isFinite(calendar.valueOf())||calendar.toISOString().slice(0,10)!==day)return NaN;
 return Date.parse(deletedAt);
}
export function deletedSourceTime(deletedAt,now=Date.now(),autoCleanup=false){
 const timestamp=deletedSourceTimestamp(deletedAt);
 if(!Number.isFinite(timestamp))return {days:null,text:'停用时间待核对'};
 const days=Math.max(0,Math.ceil((timestamp+30*86400000-now)/86400000));
 const text=days===0?(autoCleanup?'已满 30 天 · 等待自动清理':'已满 30 天'):'剩余 '+days+' 天'+
  (days<=3?(autoCleanup?' · 即将自动清理':' · 即将到期'):'');
 return {days,text};
}

const rowKey=row=>row.deletedAt!=null?'deleted:'+row.sourceId:isSpecialComponent(row)?'special:'+row.sourceId:String(row.goodsId||row.sourceId);
const baseKey=row=>row.sharedSourceId||rowKey(row);
// ERP 名称前缀与商品状态都能标明停售，即使可销库存仍有结余。
function stopTags(row,tags=splitErpName(row?.erpName||row?.name).tags){
 const result=new Set(tags.filter(tag=>['缺货','停售','停产'].includes(tag)));
 const status=[row?.erpStatus,row?.saleStatus,row?.status].join(' ');
 if(row?.discontinued===true||status.includes('停产'))result.add('停产');
 if(row?.saleStopped===true||/下架|停售/.test(status))result.add('停售');
 return [...result];
}

export function sheetAddonItems(row,stockIndex){
 // 新旧格式共用同一个行情投影，展示字段不进入加购草稿。
 function item(goodsId,text,enabled){
  const addon={goodsId,text,enabled,unavailable:false};
  if(!goodsId)return addon;
  const target=stockIndex.get(goodsId)?.[0];
  const targetRawName=latestErpName(target);
  const {main,tags}=splitErpName(targetRawName);
  const unit=target&&erpUnitCost(target);
  const targetStock=componentStock(goodsId,stockIndex);
  const targetTags=stopTags(target,tags);
  return {...addon,targetRawName,targetName:main,targetErp:unit&&!unit.fallback?unit.cents:null,
   targetStock,targetTags,unavailable:targetStock.status==='out'||targetTags.length>0};
 }
 if(Array.isArray(row.addonChoices))return row.addonChoices.map(choice=>item(choice.goodsId,choiceText(choice),choice.enabled!==false));
 return sourceAddonOptions(row).filter(addon=>addon.text||addonItems(addon).length).flatMap(addon=>{
  const ids=addonItems(addon).map(part=>part.goodsId);
  return (ids.length?ids:['']).map(goodsId=>item(goodsId,addon.text,true));
 });
}

/** 本机模式从各店现有快照推导共用显示，差异继续写回原本店来源。 */
function localEntry(id,base,rows){
 const common=sourceFields(base),stores={};
 for(const row of rows){
  const observed=sourceFields(row);
  const fields=Object.fromEntries(sharedSourceKeys.filter(key=>!equal(common[key],observed[key])).map(key=>[key,observed[key]]));
  (stores[row.shopId]??=[]).push({sourceId:row.sourceId,fields,legacy:[]});
 }
 return {id,common,stores};
}

export function buildSourceSheet({rows=[],entries=[],costs=[],configs=[],shop='intel',shops=[shop]}={}){
 const scopes=shops.length>1?['shared',...shops]:shops;
 const stockIndex=Map.groupBy(costs,row=>row.goodsId);
 const sourceRefs=new Map(),goodsRefs=new Map();
 const note=(map,id,config,slot)=>{
  if(!id)return;
  const refs=map.get(id)??{configs:new Set(),slots:new Set()};
  refs.configs.add(config.id);
  if(slot)refs.slots.add(slot);
  map.set(id,refs);
 };
 for(const config of configs){
  if(config.deletedAt||!shops.includes(config.shopId||shop))continue;
  for(const part of [...(config.parts??[]),...(config.actualParts??[])]){
   note(sourceRefs,part.sourceId,config,part.slot);
   note(goodsRefs,part.goodsId,config,part.slot);
  }
 }
 const usable=rows.filter(row=>shops.includes(row.shopId)&&!excludedComponent(row)&&
  !stockIndex.get(row.goodsId)?.some(excludedComponent));
 const byAlias=new Map(),managedEntries=new Map();
 // 共用目录也可能保留本店已停用别名；合成在用行时须排除这些已知别名。
 const deletedAliases=new Set(rows.filter(row=>row.deletedAt!=null).map(row=>JSON.stringify([row.shopId,row.sourceId])));
 for(const entry of entries){
  const stores=Object.fromEntries(Object.entries(entry.stores).filter(([id])=>shops.includes(id)).map(([id,aliases])=>
   [id,aliases.filter(alias=>!deletedAliases.has(JSON.stringify([id,alias.sourceId])))]));
  const scoped={...entry,stores};
  managedEntries.set(entry.id,scoped);
  for(const aliases of Object.values(stores))for(const alias of aliases)byAlias.set(alias.sourceId,entry.id);
 }
 const groups=Map.groupBy(usable,row=>row.deletedAt!=null?rowKey(row):byAlias.get(row.sourceId)??baseKey(row));
 for(const [id,entry] of managedEntries){
  if(groups.has(id)||!Object.values(entry.stores).some(aliases=>aliases.length)||stockIndex.get(id)?.some(excludedComponent))continue;
  const store=Object.keys(entry.stores).find(key=>entry.stores[key].length);
  const alias=entry.stores[store][0];
  if(excludedComponent({name:entry.common.name,erpName:entry.erpName}))continue;
  // 某个授权店铺的条目可能只出现在共用目录，不能因当前店未建源而漏掉。
  groups.set(id,[normalizeSpecialComponent({sourceId:alias.sourceId,shopId:store,goodsId:sourceGoodsId(id)?id:'',
   specialComponent:!sourceGoodsId(id),name:alias.fields?.name??entry.common.name??'',erpName:entry.erpName??''})]);
 }
 const result=[];
 for(const [id,aliases] of groups){
  const base=aliases.find(row=>row.shopId===shop)??aliases[0];
  const cost=stockIndex.get(base.goodsId)?.[0];
  const erpName=latestErpName(cost,base.erpName||base.originalName||base.name);
  if(excludedComponent({erpName}))continue;
  const actualEntry=base.deletedAt!=null?null:managedEntries.get(id);
  const entry=actualEntry??localEntry(id,base,aliases);
  const refs=new Set(),referenceSlots=new Set();
  for(const ref of [goodsRefs.get(base.goodsId),...aliases.map(row=>sourceRefs.get(row.sourceId))]){
   for(const config of ref?.configs??[])refs.add(config);
   for(const slot of ref?.slots??[])referenceSlots.add(slot);
  }
  const stock=componentStock(base.goodsId,stockIndex);
  const unit=erpUnitCost({...base,...cost});
  const category=sourceSheetCategory({...base,erpName},[...referenceSlots],cost);
  result.push({id,base,aliases,entry,managed:!!actualEntry,scopes,shop,category,erpName,
   stock,unavailable:stock.status==='out'||stopTags({...cost,...base,erpName,erpStatus:base.erpStatus??cost?.erpStatus,
    discontinued:base.discontinued||cost?.discontinued,saleStopped:base.saleStopped||cost?.saleStopped}).length>0,
   references:refs.size,erp:unit.fallback?null:unit.cents,stockIndex,cost});
 }
 return result;
}

/** 核算价用元录入，ERP 用分比较；缺基准与差额为零分别表示。 */
export function sourceSheetTaxCompare(tax,erpCents){
 if(tax==null||String(tax).trim()===''||!Number.isFinite(Number(tax)))return {status:'missing',diffCents:0};
 if(!Number.isFinite(erpCents))return {status:'none',diffCents:0};
 const diffCents=Math.round(Number(tax)*100)-erpCents;
 return {status:diffCents>0?'high':diffCents<0?'low':'equal',diffCents};
}

export function sourceSheetView(item,draft,displayScope=item.scopes[0]){
 const edits=draft?.edits??{};
 const defaultScope=item.scopes[0];
 const scopeRows=new Map(item.scopes.map(scope=>[scope,
  sharedScopeRow(item.aliases.find(row=>row.shopId===scope)??item.base,item.entry,scope,edits)]));
 const common=scopeRows.get(displayScope);
 const overridden=new Map();
 if(defaultScope==='shared')for(const key of sharedSourceKeys){
  for(const scope of fieldState(item.entry,'shared',key,item.base.sourceId,edits).overrideShops){
   const fields=overridden.get(scope)??[];
   fields.push(key);overridden.set(scope,fields);
  }
 }
 const differences=item.scopes.filter(scope=>overridden.has(scope)).map(scope=>({scope,fields:overridden.get(scope),row:scopeRows.get(scope)}));
 const addons=new Map([...scopeRows].map(([scope,row])=>[scope,sheetAddonItems(row,item.stockIndex)]));
 const addonRows=[...addons.values()].flat();
 const names=[...scopeRows.values()].flatMap(row=>[row.name,row.erpSpec,row.erpModel,
  ...Object.values(row.hardwareOverrides??{}),...Object.values(row.capacityOverrides??{})]);
 const legacyNames=Object.values(item.entry.stores).flatMap(aliases=>aliases.map(alias=>alias.fields?.name));
 return {...item,common,scopeRows,differences,addons,draft,
  taxCompare:isSpecialComponent(item.base)?{status:'none',diffCents:0}:sourceSheetTaxCompare(common.tax,item.erp),
  unavailable:item.unavailable||addonRows.some(addon=>addon.enabled&&addon.unavailable),
  search:normalize([item.base.goodsId,item.erpName,item.category,item.cost?.erpSpec,item.cost?.erpModel,
   ...names,...legacyNames,...addonRows.flatMap(addon=>[addon.goodsId,addon.targetName,addon.text])].filter(Boolean).join(' '))};
}

const matchesCategory=(row,category)=>category==='全部配件'||row.category===category;
const matchesQuery=(row,terms)=>terms.every(term=>row.search.includes(term));
function matchesFilter(row,filter){
 if((filter==='deleted')!==(row.base.deletedAt!=null))return false;
 if(filter==='different')return row.differences.length>0;
 if(filter==='addons')return [...row.addons.values()].some(items=>items.length);
 if(filter==='unavailable')return row.unavailable;
 if(filter==='missing-tax')return row.taxCompare.status==='missing';
 if(filter==='tax-high')return row.taxCompare.status==='high';
 if(filter==='tax-low')return row.taxCompare.status==='low';
 if(filter==='pending')return !!row.draft;
 return true;
}

const matchesPrice=(row,priceFilter)=>priceFilter==='all'||row.taxCompare.status===priceFilter;
export function sourceSheetMatches(row,{category='全部配件',filter='active',priceFilter='all',query=''}={}){
 return matchesCategory(row,category)&&matchesQuery(row,normalize(query).split(/\s+/))&&matchesFilter(row,filter)&&matchesPrice(row,priceFilter);
}

/** 每组徽标忽略自身选项，保留另外两组条件和搜索词。 */
export function sourceSheetNavCounts(rows,{category='全部配件',filter='active',priceFilter='all',query=''}={}){
 const categories=new Map(sourceSheetCategories.map(name=>[name,0]));
 const filters=new Map(sourceSheetFilters.map(([id])=>[id,0]));
 const priceFilters=new Map([['all',0],['high',0],['low',0]]);
 const terms=normalize(query).split(/\s+/);
 for(const row of rows){
  if(!matchesQuery(row,terms))continue;
  const inCategory=matchesCategory(row,category),inFilter=matchesFilter(row,filter);
  if(inCategory&&inFilter){
   priceFilters.set('all',priceFilters.get('all')+1);
   const {status}=row.taxCompare;
   if(priceFilters.has(status))priceFilters.set(status,priceFilters.get(status)+1);
  }
  if(!matchesPrice(row,priceFilter))continue;
  if(inFilter){
   categories.set('全部配件',categories.get('全部配件')+1);
   categories.set(row.category,categories.get(row.category)+1);
  }
  if(inCategory)for(const [id,count] of filters)if(matchesFilter(row,id))filters.set(id,count+1);
 }
 return {categories,filters,priceFilters};
}

/** 基础信息显式设为自动识别也是共用基线；空名称与空价格不能覆盖独享值。 */
function canInherit(field,{value,inherited}){
 if(!inherited)return false;
 if(field==='tax')return Number.isFinite(value)&&value>=0;
 if(field==='name')return typeof value==='string'&&!!value.trim();
 return true;
}

export const sourceSheetCommonCanRestore=(row,field)=>canInherit(field,fieldState(row.entry,'shared',field,row.base.sourceId,row.draft?.edits));

export function sourceSheetRestorePlan(row,store){
 const targets=[],blocked=new Set(),common=new Map(),special=isSpecialComponent(row.base);
 for(const {scope,fields} of row.differences){
  if(store&&store!==scope)continue;
  for(const field of fields){
   if(special&&field!=='name')continue;
   if(!common.has(field))common.set(field,sourceSheetCommonCanRestore(row,field));
   if(common.get(field))targets.push({scope,field});
   else blocked.add(field);
  }
 }
 return {targets,blocked:[...blocked]};
}

export function sheetTaxInput(value){
 const text=String(value??'').trim();
 if(!text)return null;
 if(!/^\d+(\.\d{1,2})?$/.test(text)||Number(text)>100000000)throw Error('核算价须为非负金额，最多两位小数');
 return Number(text);
}

/** 一次编辑只写这一个字段。恢复时移除覆盖，独立成本仍由旧事务保护。 */
export function editSourceSheetField(item,draft,scope,field,value,{restore=false}={}){
 if(!item.scopes.includes(scope)||!sharedSourceKeys.includes(field)||item.base.deletedAt!=null||
    isSpecialComponent(item.base)&&field!=='name')return draft;
 if(restore&&(scope==='shared'||!canInherit(field,fieldState(item.entry,'shared',field,item.base.sourceId,draft?.edits))))return draft;
 const edits=structuredClone(draft?.edits??{});
 // 草稿里手填共用初价才开启手改保护，清空后仍可跟随成本表。
 const taxMode=draft?.created&&field==='tax'&&scope===item.scopes[0]&&!restore?
  (value==null?undefined:'manual'):draft?.taxMode;
 const change=edits[scope]??={values:{},restore:[]};
 const original=fieldState(item.entry,scope,field,item.base.sourceId,scope==='shared'?{}:{shared:edits.shared});
 const hasOverride=fieldState(item.entry,'shared',field,item.base.sourceId).overrideShops.includes(scope);
 delete change.values[field];
 change.restore=change.restore.filter(key=>key!==field);
 if(restore){
  if(hasOverride)change.restore.push(field);
 }else if(!equal(original.value,value)||hasOverride&&scope==='shared')change.values[field]=value;
 for(const [key,next] of Object.entries(edits))if(!Object.keys(next.values).length&&!next.restore.length)delete edits[key];
 return draft?.created||Object.keys(edits).length?{...draft,edits,...(draft?.created?{taxMode}:{})}:undefined;
}

/** 只统一用户选中的字段，保留各店的其他独享设置。 */
export function promoteSourceSheetField(item,draft,field,value){
 if(!item.scopes.includes('shared')||!['name','tax','addon'].includes(field)||!canInherit(field,{value,inherited:true}))return draft;
 let next=editSourceSheetField(item,draft,'shared',field,value);
 for(const scope of item.scopes)if(scope!=='shared'&&fieldState(item.entry,'shared',field,item.base.sourceId,next?.edits).overrideShops.includes(scope)){
  next=editSourceSheetField(item,next,scope,field,null,{restore:true});
 }
 return next;
}

/** 成本表存在有效价格时优先使用，零元也是有效观察值。 */
export function sourceSheetDefaultTax(tableTax,erp){
 const valid=value=>Number.isFinite(value)&&value>=0&&value<=100000000;
 if(valid(tableTax))return {tax:Math.round(tableTax*100)/100,taxMode:'default_table'};
 if(valid(erp))return {tax:Math.round(erp*100)/100,taxMode:'default_erp'};
 return {tax:null};
}

/** ERP 观察留在草稿投影，实际创建按现有跨店接口提交人工字段和 ERP 原名。 */
export function createSourceSheetDraft(candidate,{shop,shops=[shop],managed=false,tax=null,taxMode,sourceId=crypto.randomUUID(),special=false}={}){
 const goodsId=String(candidate?.goodsId??'');
 // ERP 原名只取查询观察值。手工展示名不会作为 ERP 观察回传。
 // 兼容旧 ERP 搜索结果：它用 name 存原名，并附带单价或库存观察。
 const legacyErp=candidate?.erpName===undefined&&candidate?.displayName===undefined&&
  (candidate?.erp!==undefined||candidate?.stockAvailable!==undefined);
 const erpName=String(legacyErp?candidate.name:candidate?.erpName??'').trim();
 const name=String(candidate?.displayName??(legacyErp?splitErpName(erpName).main:candidate?.name??splitErpName(erpName).main)).trim();
 if(!special&&(!sourceGoodsId(goodsId)||!name||name.length>512||erpName.length>512||excludedComponent({name,erpName})))throw Error('该配件不可加入输出源，请核对货号及名称');
 if(special&&(name.length>512||excludedComponent({name})))throw Error('请核对特殊配件的展示名称');
 // 只有手工填写的规格进入草稿；简称和容量的自动推断留给配置展示层。
 const row=normalizeSpecialComponent({sourceId,shopId:shop,goodsId,name,
  ...(special?{}:{hardwareOverrides:validateHardware(candidate?.hardwareOverrides),capacityOverrides:validateCapacities(candidate?.capacityOverrides)}),
  specialComponent:special,erpName,...erpCategoryFields(candidate??{}),erpSpec:candidate?.erpSpec,erpModel:candidate?.erpModel,
  erp:candidate?.erp??null,stockAvailable:candidate?.stockAvailable??null,stockIncomingAvailable:candidate?.stockIncomingAvailable??null,
  tax:Number.isFinite(tax)&&tax>=0?Math.round(tax*100)/100:null});
 const [item]=buildSourceSheet({rows:[row],costs:special?[]:[row],shop,shops});
 item.id=special?'special:'+sourceId:goodsId;
 item.erpName=erpName;
 item.entry={...item.entry,id:item.id};
 item.managed=managed;
 return {item,draft:{created:true,edits:{},...(!special&&row.tax!=null&&taxMode?{taxMode}:{})}};
}

/** 只覆盖实际修改的字段；同店的其他历史别名与特殊成本继续保留。 */
export function sourceSheetEffective(item,draft,row=item.base){
 if(!draft)return row;
 const fields=sourceFields(row),edits=draft.edits,store=edits[row.shopId];
 const alias=item.entry.stores[row.shopId]?.find(record=>record.sourceId===row.sourceId);
 for(const key of sharedSourceKeys){
  if(Object.hasOwn(store?.values??{},key))fields[key]=store.values[key];
  else if(store?.restore.includes(key)||Object.hasOwn(edits.shared?.values??{},key)&&!sourceAliasOverrides(item.entry,alias,key,edits))
   fields[key]=fieldState(item.entry,store?.restore.includes(key)?'shared':row.shopId,key,row.sourceId,edits).value;
 }
 return withSourceFields(row,fields);
}

export function sourceSheetChanges(item,draft){
 if(!draft)return [];
 const edits=structuredClone(draft.edits);
 const defaultScope=item.scopes[0];
 const scopeRow=scope=>sharedScopeRow(item.base,item.entry,scope,edits);
 const row=draft.created?scopeRow(item.shop):sourceSheetEffective(item,draft);
 const initialTaxMode=draft.created&&!isSpecialComponent(row)&&draft.taxMode?{taxMode:draft.taxMode}:{};
 if(draft.created&&!scopeRow(defaultScope).name?.trim())throw Error('请先填写新增配件的展示名称');
 if(item.managed){
  if(draft.created){
   const values=sourceFields(scopeRow('shared'));
   const fields=isSpecialComponent(row)?['name']:['name','tax',...sharedSourceKeys.slice(2).filter(key=>
    values[key]!=null&&(key!=='addon'||Object.keys(values[key]).length))];
   edits.shared={values:Object.fromEntries(fields.map(key=>[key,values[key]])),restore:[]};
  }
  return [{before:draft.created?null:item.base,row,managed:{id:item.id,version:item.entry.version??null,edits,...initialTaxMode,
   ...(draft.created&&row.erpName?{erpName:row.erpName}:{}),
   ...(draft.created&&!isSpecialComponent(row)&&row.erpCategory?.trim()?{erpCategory:row.erpCategory.trim()}:{})}}];
 }
 if(draft.created)return [{before:null,row:{...row,shopId:item.shop},...initialTaxMode}];
 return item.aliases.flatMap(before=>{
  const after=sourceSheetEffective(item,draft,before);
  return equal(sourceFields(before),sourceFields(after))?[]:[{before,row:after}];
 });
}
