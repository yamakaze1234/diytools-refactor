/** 输出源工作表只投影现有目录。保存时仍交给原目录接口校验权限、版本与回执。 */
import {slots,erpUnitCost} from './core.js';
import {componentStock} from './inventory-check-data.js';
import {excludedComponent} from './component-policy.js';
import {splitErpName} from './erp-part-description.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';
import {sourceFields,withSourceFields,sharedSourceKeys,sourceGoodsId} from './shared-source-fields.js';
import {fieldState,sharedScopeRow} from './shared-source-editor.js';
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {addonItems,choiceText,sourceAddonOptions} from './addon-data.js';

export const sourceSheetCategories=['全部配件','CPU','主板','显卡','内存','硬盘','散热','风扇','机箱','电源','线材/扩展','其他配件','特殊配件'];
export const sourceSheetFilters=[['active','全部在用'],['different','三店有差异'],['addons','有升级项'],['unavailable','缺货 / 停产'],['missing-tax','待填核算价'],['tax-high','核算价高于ERP'],['tax-low','核算价低于ERP'],['pending','待保存修改'],['deleted','已删除']];
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
const categoryPatterns=[
 // 附件名称常带适配的硬件型号，先识别商品本身。
 ['线材/扩展',/线材|模组线|延长线|转接线|显卡支架|转接|扩展|集线器|数据线|连接线|hub\b|riser|cable/i],
 ['散热',/散热|水冷|风冷|冷排|cooler|heatsink/i],
 ['风扇',/风扇|fan\b/i],
 ['机箱',/机箱|chassis|\bcase\b/i],
 ['电源',/电源|power supply|\bpsu\b|\b\d{3,4}\s*w\b/i],
 ['CPU',/cpu|处理器|酷睿|锐龙|奔腾|赛扬|epyc|xeon|ryzen|ultra\s*[3579]|\b[ir][3579][\s-]*\d{4,5}/i],
 ['主板',/主板|motherboard|\b[abhxyz]\d{3}[mi]?\b/i],
 ['显卡',/显卡|独显|geforce|radeon|\b(?:rtx|gtx|rx|arc)\s*[-a-z]?\s*\d{3,4}/i],
 ['内存',/内存|ddr\s*[345]|dimm|memory/i],
 ['硬盘',/硬盘|固态|机械盘|存储|ssd|nvme|\bhdd\b|硬碟/i],
];

/** 优先使用已有分类，其次采用真实引用槽位，最后才识别商品名称。 */
export function sourceSheetCategory(row,referenceSlots=[]){
 if(isSpecialComponent(row))return '特殊配件';
 const match=text=>categoryPatterns.find(([,pattern])=>pattern.test(normalize(text)))?.[0];
 const exact=sourceSheetCategories.slice(1,-2).find(name=>normalize(name)===normalize(row.erpCategory));
 const name=match([row.erpName,row.name,row.originalName,row.erpModel].join(' '));
 const slot=referenceSlots.find(value=>slots.includes(value)&&!value.startsWith('配件'));
 return exact||match(row.erpCategory)||slot||name||'其他配件';
}

const rowKey=row=>row.deletedAt?'deleted:'+row.sourceId:isSpecialComponent(row)?'special:'+row.sourceId:String(row.goodsId||row.sourceId);
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
  const targetRawName=target?.erpName||target?.name||'';
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
 for(const entry of entries){
  const stores=Object.fromEntries(Object.entries(entry.stores).filter(([id])=>shops.includes(id)));
  const scoped={...entry,stores};
  managedEntries.set(entry.id,scoped);
  for(const aliases of Object.values(stores))for(const alias of aliases)byAlias.set(alias.sourceId,entry.id);
 }
 const groups=Map.groupBy(usable,row=>row.deletedAt?rowKey(row):byAlias.get(row.sourceId)??baseKey(row));
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
  const erpName=cost?.erpName||cost?.name||base.erpName||base.originalName||base.name;
  if(excludedComponent({erpName}))continue;
  const actualEntry=base.deletedAt?null:managedEntries.get(id);
  const entry=actualEntry??localEntry(id,base,aliases);
  const refs=new Set(),referenceSlots=new Set();
  for(const ref of [goodsRefs.get(base.goodsId),...aliases.map(row=>sourceRefs.get(row.sourceId))]){
   for(const config of ref?.configs??[])refs.add(config);
   for(const slot of ref?.slots??[])referenceSlots.add(slot);
  }
  const stock=componentStock(base.goodsId,stockIndex);
  const unit=erpUnitCost({...base,...cost});
  const category=sourceSheetCategory({...base,erpCategory:cost?.erpCategory||base.erpCategory||base.slot,erpName},[...referenceSlots]);
  result.push({id,base,aliases,entry,managed:!!actualEntry,scopes,shop,category,erpName,
   stock,unavailable:stock.status==='out'||stopTags({...cost,...base,erpStatus:base.erpStatus??cost?.erpStatus,
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
 if((filter==='deleted')!==Boolean(row.base.deletedAt))return false;
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
 if(!item.scopes.includes(scope)||!sharedSourceKeys.includes(field)||item.base.deletedAt||
    isSpecialComponent(item.base)&&field!=='name')return draft;
 if(restore&&(scope==='shared'||!canInherit(field,fieldState(item.entry,'shared',field,item.base.sourceId,draft?.edits))))return draft;
 const edits=structuredClone(draft?.edits??{});
 const change=edits[scope]??={values:{},restore:[]};
 const original=fieldState(item.entry,scope,field,item.base.sourceId,scope==='shared'?{}:{shared:edits.shared});
 const hasOverride=fieldState(item.entry,'shared',field,item.base.sourceId).overrideShops.includes(scope);
 delete change.values[field];
 change.restore=change.restore.filter(key=>key!==field);
 if(restore){
  if(hasOverride)change.restore.push(field);
 }else if(!equal(original.value,value)||hasOverride&&scope==='shared')change.values[field]=value;
 for(const [key,next] of Object.entries(edits))if(!Object.keys(next.values).length&&!next.restore.length)delete edits[key];
 return draft?.created||Object.keys(edits).length?{...draft,edits}:undefined;
}

/** 只统一用户选中的字段，保留各店的其他独享设置。 */
export function promoteSourceSheetField(item,draft,field,value){
 if(!item.scopes.includes('shared')||!['name','tax'].includes(field)||!canInherit(field,{value,inherited:true}))return draft;
 let next=editSourceSheetField(item,draft,'shared',field,value);
 for(const scope of item.scopes)if(scope!=='shared'&&fieldState(item.entry,'shared',field,item.base.sourceId,next?.edits).overrideShops.includes(scope)){
  next=editSourceSheetField(item,next,scope,field,null,{restore:true});
 }
 return next;
}

/** ERP 观察留在草稿投影，实际创建按现有跨店接口提交人工字段和 ERP 原名。 */
export function createSourceSheetDraft(candidate,{shop,shops=[shop],managed=false,tax=null,sourceId=crypto.randomUUID(),special=false}={}){
 const goodsId=String(candidate?.goodsId??'');
 const erpName=String(candidate?.erpName||candidate?.name||'').trim();
 if(!special&&(!sourceGoodsId(goodsId)||!erpName||excludedComponent({erpName})))throw Error('该 ERP 商品不可加入输出源');
 const row=normalizeSpecialComponent({sourceId,shopId:shop,goodsId,name:special?'':splitErpName(erpName).main||erpName,
  specialComponent:special,erpName,erpCategory:candidate?.erpCategory,erpSpec:candidate?.erpSpec,erpModel:candidate?.erpModel,
  erp:candidate?.erp??null,stockAvailable:candidate?.stockAvailable??null,stockIncomingAvailable:candidate?.stockIncomingAvailable??null,
  tax:Number.isFinite(tax)&&tax>=0?Math.round(tax*100)/100:null});
 const [item]=buildSourceSheet({rows:[row],costs:special?[]:[row],shop,shops});
 item.id=special?'special:'+sourceId:goodsId;
 item.entry={...item.entry,id:item.id};
 item.managed=managed;
 return {item,draft:{created:true,edits:{}}};
}

/** 只覆盖实际修改的字段；同店的其他历史别名与特殊成本继续保留。 */
export function sourceSheetEffective(item,draft,row=item.base){
 if(!draft)return row;
 const fields=sourceFields(row),edits=draft.edits,store=edits[row.shopId];
 const alias=item.entry.stores[row.shopId]?.find(record=>record.sourceId===row.sourceId);
 for(const key of sharedSourceKeys){
  if(Object.hasOwn(store?.values??{},key))fields[key]=store.values[key];
  else if(store?.restore.includes(key)||Object.hasOwn(edits.shared?.values??{},key)&&!Object.hasOwn(alias?.fields??{},key))
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
 if(draft.created&&!scopeRow(defaultScope).name?.trim())throw Error('请先填写新增配件的展示名称');
 if(item.managed){
  if(draft.created){
   const values=sourceFields(scopeRow('shared'));
   const fields=isSpecialComponent(row)?['name']:['name','tax',...sharedSourceKeys.slice(2).filter(key=>
    values[key]!=null&&(key!=='addon'||Object.keys(values[key]).length))];
   edits.shared={values:Object.fromEntries(fields.map(key=>[key,values[key]])),restore:[]};
  }
  return [{before:draft.created?null:item.base,row,managed:{id:item.id,version:item.entry.version??null,edits,
   ...(draft.created&&row.erpName?{erpName:row.erpName}:{})}}];
 }
 if(draft.created)return [{before:null,row:{...row,shopId:item.shop}}];
 return item.aliases.flatMap(before=>{
  const after=sourceSheetEffective(item,draft,before);
  return equal(sourceFields(before),sourceFields(after))?[]:[{before,row:after}];
 });
}
