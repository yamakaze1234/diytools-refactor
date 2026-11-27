/** 共用来源沿用目录版本、操作编号和回执；真正的跨店写入由数据库事务完成。 */
import {validErpCategory} from './cost-sync.mjs';
import {Fault,requireValue} from './config.mjs';
import {
 sharedSourceKeys, sharedSourceAddonKeys, sourceGoodsId, sharedSpecialKey,
} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {sourceAddon,validateAddon} from '../../../apps/desktop/public/workbench/addon-data.js';
import {validateCapacities} from '../../../apps/desktop/public/workbench/component-capacity.js';
import {hardwareColors,validateHardware} from '../../../apps/desktop/public/workbench/component-hardware.js';
import {excludedComponent} from '../../../apps/desktop/public/workbench/component-policy.js';

const scopes = ['shared','intel','gigabyte','jonsbo'];
const keys = new Set(sharedSourceKeys);
const taxModes = new Set(['default_table','default_erp','manual']);
const validTax = value => value === null || typeof value === 'number' && value >= 0 && value <= 100000000 &&
 Math.abs(value*100 - Math.round(value*100)) < 1e-6;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = (condition, field) => {
 if (!condition) throw new Fault('VALIDATION_FAILED',400,{field});
};

/** 目录新增依旧使用原操作编号；ERP 观察仅作为本店建源和缺价的初值。 */
export function validateErpAdoption(id,document){
 const row=document.erpAdoption;
 const name=text=>typeof text==='string'&&text===text.trim()&&text.length>0&&text.length<=512&&!excludedComponent({name:text});
 valid(sourceGoodsId(id)&&document.id===id&&Object.keys(document).every(k=>['id','name','erpAdoption'].includes(k))&&name(document.name),'document');
 valid(plain(row)&&Object.keys(row).every(k=>['name','erp','stockAvailable','stockIncomingAvailable','erpCategory','sku','tableTax','taxOverride'].includes(k))&&name(row.name)&&
  (row.erp===null||Number.isFinite(row.erp)&&row.erp>=0&&row.erp<=100000000)&&
  (!Object.hasOwn(row,'tableTax')||Number.isFinite(row.tableTax)&&row.tableTax>=0&&row.tableTax<=100000000)&&
  (!Object.hasOwn(row,'taxOverride')||!Object.hasOwn(row,'tableTax')&&validTax(row.taxOverride))&&
  (row.stockAvailable===null||Number.isFinite(row.stockAvailable)&&Math.abs(row.stockAvailable)<=Number.MAX_SAFE_INTEGER)&&
  (!Object.hasOwn(row,'stockIncomingAvailable')||row.stockIncomingAvailable===null||Number.isFinite(row.stockIncomingAvailable)&&Math.abs(row.stockIncomingAvailable)<=Number.MAX_SAFE_INTEGER)&&
  (!Object.hasOwn(row,'erpCategory')||validErpCategory(row.erpCategory))&&
  typeof row.sku==='string'&&row.sku.length<=512,'document.erpAdoption');
}

// 两条建源路径都在回执前回读分类，旧库忽略观察字段时由外层事务撤销本次创建。
async function checkCreatedCategory(db,sourceId,category){
 const {rows:[source]}=await db.query('SELECT attrs FROM intel_live.sources WHERE source_id=$1',[sourceId]);
 if(source?.attrs?.erpCategory!==category)throw new Fault('NAS_COST_SYNC_NOT_INSTALLED',503);
}

// 共用与单店创建都按落库值核验，旧库忽略扩展参数或投影不完整时整笔回滚。
function checkCreatedTax(value,tax,{manual=false,provisional=false}={}){
 if(!value||value.tax!==tax||value.nasManualTax!==manual||
   (provisional?value.nasProvisionalTax!==true:Object.hasOwn(value,'nasProvisionalTax')))
  throw new Fault('NAS_SOURCE_CREATION_NOT_INSTALLED',503);
}

export async function adoptErpSource(db,member,shop,id,document){
 try{
  const {rows:[row]}=await db.query('SELECT workbench_sources.adopt_erp($1,$2,$3,$4,$5,$6::jsonb) AS result',
   [shop,member.workspaceId,member.uid,id,document.name,JSON.stringify(document.erpAdoption)]);
  if(!row.result.reused&&Object.hasOwn(document.erpAdoption,'erpCategory')){
   await checkCreatedCategory(db,row.result.sourceId,document.erpAdoption.erpCategory);
  }
  if(!row.result.reused&&Object.hasOwn(document.erpAdoption,'taxOverride')){
   const tax=document.erpAdoption.taxOverride;
   const {rows:[cost]}=await db.query('SELECT document FROM intel_live.intel_cost_overrides WHERE goodsid=$1',[id]);
   checkCreatedTax(cost?.document,tax,{manual:tax!==null});
  }
  return row.result;
 }catch(error){
  if(error.code==='42883')throw new Fault('NAS_ERP_ADOPTION_NOT_INSTALLED',503);
  if(error.code==='P0001'&&['FORBIDDEN','VALIDATION_FAILED','ERP_SOURCE_ARCHIVED'].includes(error.message))
   throw new Fault(error.message,{FORBIDDEN:403,VALIDATION_FAILED:400,ERP_SOURCE_ARCHIVED:409}[error.message]);
  throw error;
 }
}

function validateFields(fields, special, scope) {
 const capacity = {}, hardware = {};
 for (const [key,value] of Object.entries(fields)) {
  valid(keys.has(key) && (!special || key === 'name'), key);
  if (key === 'name') {
   valid(typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 &&
    !excludedComponent({name:value}),key);
  } else if (key === 'tax') {
   valid(validTax(value),key);
  } else if (key === 'addon') {
   valid(plain(value) && Object.keys(value).every(key=>sharedSourceAddonKeys.includes(key)),key);
   try { validateAddon(sourceAddon(Object.fromEntries(Object.entries(value).filter(([,v])=>v!=null)))); }
   catch { valid(false,key); }
  } else if (key === 'hardwareOverrides.color') {
   valid(value === null || hardwareColors.includes(value),key);
  } else if (value !== null) {
   const [group,field] = key.split('.');
   (group === 'capacityOverrides' ? capacity : hardware)[field] = value;
  }
 }
 try { validateCapacities(capacity); validateHardware(hardware); }
 catch { valid(false,scope+'.fields'); }
}

export function validateSharedSourceEdit(id,document,create) {
 const special=sharedSpecialKey(id);
 valid(sourceGoodsId(id) || special,'document.id');
 valid(document.id===id && Object.keys(document).every(key=>['id','edits','erpName','erpCategory','taxMode','alias_edits','addon_sync'].includes(key)),'document');
 valid(!Object.hasOwn(document,'erpName') || create && !special && typeof document.erpName==='string' &&
  document.erpName.length<=512 && !excludedComponent({erpName:document.erpName}),'document.erpName');
 valid(!Object.hasOwn(document,'erpCategory')||create&&!special&&validErpCategory(document.erpCategory),'document.erpCategory');
 const {edits,taxMode} = document;
 valid(!Object.hasOwn(document,'taxMode')||create&&!special&&taxModes.has(taxMode),'document.taxMode');
 valid(plain(edits) && Object.keys(edits).length>0,'document.edits');
 for (const [scope,change] of Object.entries(edits)) {
  valid(scopes.includes(scope) && plain(change) && Object.keys(change).every(key=>['values','restore'].includes(key)),scope);
  const {values,restore} = change;
  valid(plain(values) && Array.isArray(restore) && new Set(restore).size===restore.length &&
   restore.every(key=>keys.has(key) && (!special || key==='name') && !Object.hasOwn(values,key)) &&
   (scope!=='shared' || restore.length===0) && (Object.keys(values).length>0 || restore.length>0),scope);
  validateFields(values,special,scope);
 }
 // 新建仍要求共用名称；已有数据库事务同时验证权限并保存各店差异，避免拆成两次提交。
 if (create) valid(!!edits.shared?.values?.name,'document.name');
 // 完整三店同步只改加购公共值并解除各店该字段覆盖，禁止顺带改名称、成本等资料。
 if(Object.hasOwn(document,'addon_sync')){
  valid(document.addon_sync===true&&!create&&!Object.hasOwn(document,'alias_edits')&&Object.keys(edits).length===4,'document.addon_sync');
  valid(Object.keys(edits.shared?.values??{}).join(',')==='addon'&&edits.shared.restore.length===0,'document.addon_sync.shared');
  for(const shop of scopes.slice(1))valid(edits[shop]&&Object.keys(edits[shop].values).length===0&&JSON.stringify(edits[shop].restore)==='["addon"]','document.addon_sync.'+shop);
  try{validateAddon(sourceAddon(edits.shared.values.addon),{required:!!sourceAddon(edits.shared.values.addon).text});}catch{valid(false,'document.addon_sync.addon');}
 }
 // 全局文案修改按每条来源保留商品、数量和选配规则，不把同店第一条来源覆盖给其它别名。
 if (Object.hasOwn(document,'alias_edits')) {
  valid(!create && plain(document.alias_edits) && !!edits.shared,'document.alias_edits');
  for(const [shop,aliases] of Object.entries(document.alias_edits)) {
   valid(scopes.includes(shop)&&shop!=='shared'&&plain(aliases),'document.alias_edits.shop');
   for(const [sourceId,fields] of Object.entries(aliases)) {
    valid(sourceId.length>0&&sourceId.length<=256&&plain(fields)&&Object.keys(fields).length===1&&plain(fields.addon),'document.alias_edits.source');
    validateFields(fields,false,shop);
   }
  }
 }
}

export async function listSharedSources(db,member,shop,id) {
 const {rows} = await db.query('SELECT * FROM workbench_sources.list($1,$2,$3,$4)',[shop,member.workspaceId,member.uid,id]);
 if (!id) return rows;
 requireValue(rows.length,'NOT_FOUND',404);
 return rows[0];
}

export async function writeSharedSource(db,member,shop,id,expected,document) {
 try {
  const aliasEdit=Object.hasOwn(document,'alias_edits');
  if(aliasEdit||document.addon_sync){
   // 021 是两种全局加购事务的共同前置，写入前检查并给出明确的未安装错误。
   const {rows:[installed]}=await db.query("SELECT to_regprocedure('workbench_sources.source_versions(text,text,text,text)') IS NOT NULL AS versions, to_regprocedure('workbench_sources.save_aliases(text,text,text,text,bigint,jsonb,jsonb)') IS NOT NULL AS aliases");
   if(!installed?.versions||aliasEdit&&!installed.aliases)throw new Fault('NAS_GLOBAL_UPGRADE_NOT_INSTALLED',503);
  }
  // 三店建源保留原来的店铺草稿。分类是首次建源的 ERP 观察值，只能从专用字段传入。
  const hasCategory=Object.hasOwn(document,'erpCategory');
  const defaultMode=Object.hasOwn(document.edits.shared?.values??{},'tax')&&
   (document.taxMode==='default_table'||document.taxMode==='default_erp');
  const edits=hasCategory||defaultMode?{...document.edits,shared:{...document.edits.shared,
   values:{...document.edits.shared.values,...(hasCategory?{erpCategory:document.erpCategory}:{}),
    ...(defaultMode?{__creationTaxMode:document.taxMode}:{})}}}:document.edits;
  const {rows:[row]} = await db.query(aliasEdit?
   'SELECT workbench_sources.save_aliases($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) AS version':
   'SELECT workbench_sources.save($1,$2,$3,$4,$5,$6,$7) AS version',
   [shop,member.workspaceId,member.uid,id,expected,JSON.stringify(edits),aliasEdit?JSON.stringify(document.alias_edits):document.erpName??null]);
  if(hasCategory)await checkCreatedCategory(db,'shared-src:'+id,document.erpCategory);
  if(defaultMode){
   // 只读取本次商品的三条成本投影，连同请求店的显式覆盖一起在回执前验证。
   let rows;
   try{
    ({rows}=await db.query('SELECT * FROM workbench_sources.created_tax_modes($1,$2,$3,$4)',[shop,member.workspaceId,member.uid,id]));
   }catch(error){
    if(error.code==='42883')throw new Fault('NAS_SOURCE_CREATION_NOT_INSTALLED',503);
    throw error;
   }
   for(const target of scopes.slice(1)){
    const local=edits[target]?.values??{},overridden=Object.hasOwn(local,'tax');
    const tax=overridden?local.tax:edits.shared.values.tax;
    checkCreatedTax(rows.find(row=>row.shop_id===target)?.document,tax,{
     manual:overridden&&tax!==null,provisional:!overridden&&tax!==null&&document.taxMode==='default_erp',
    });
   }
  }
  return row.version;
 } catch (err) {
  if (err.code==='42883'&&Object.hasOwn(document,'alias_edits')) throw new Fault('NAS_GLOBAL_UPGRADE_NOT_INSTALLED',503);
  if (err.code!=='P0001') throw err;
  if (err.message==='FORBIDDEN') throw new Fault('FORBIDDEN',403);
  if (['CATALOG_EXISTS','VERSION_CONFLICT','SHARED_SOURCE_VALUE_REQUIRED'].includes(err.message)) throw new Fault(err.message,409);
  throw err;
 }
}

/** 与来源提交同事务回读的版本，供后续配置只接续这次保存，不能吞掉其他人稍后的修改。 */
export async function sharedSourceVersions(db,member,shop,id){
 try{
  const {rows:[row]}=await db.query('SELECT workbench_sources.source_versions($1,$2,$3,$4) AS versions',[shop,member.workspaceId,member.uid,id]);
  return row.versions;
 }catch(error){if(error.code==='42883')throw new Fault('NAS_GLOBAL_UPGRADE_NOT_INSTALLED',503);throw error;}
}
