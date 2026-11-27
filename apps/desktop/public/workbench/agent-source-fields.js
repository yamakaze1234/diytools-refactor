/** Agent 只接受工作表的人工业务字段；真实版本、ERP 观察和保存正文均由工作台生成。 */
import {sharedSourceKeys,sharedSourceAddonKeys,sourceGoodsId,sourceFields,withSourceFields} from './shared-source-fields.js';
import {validateAddon,sourceAddon,choiceDescription} from './addon-data.js';
import {validateCapacities} from './component-capacity.js';
import {validateHardware} from './component-hardware.js';
import {excludedComponent} from './component-policy.js';
import {nasShopIds} from './nas-api-client.js';
export const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const version=v=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v);
export const nextVersion=v=>(BigInt(v??0)+1n).toString();
const valid=(condition,message)=>{if(!condition)fail('INVALID_PARAMS',message);};
const subset=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const own=(v,k)=>Object.hasOwn(v,k);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)&&!['.','..'].includes(v);
const validText=v=>typeof v==='string'&&v.length<=512;
const itemKeys=['goodsId','qty'],choiceKeys=['id','label','customText','enabled','goodsId','qty','priceCents','originalQty'];
const variantKeys=['variantId','text','note','goodsId','qty','priceCents','items','originalQty','showTogether','mode','choices'];
function validateStructuredAddon(value){
 valid(subset(value,sharedSourceAddonKeys),'加购字段无效');
 const a=sourceAddon(value);
 const check=entry=>{
  valid((entry.note==null||validText(entry.note))&&validText(entry.text),'加购文案无效');
  if(entry.items!==undefined)valid(Array.isArray(entry.items)&&entry.items.every(i=>subset(i,itemKeys)),'组合商品字段无效');
  if(entry.choices!==undefined)valid(Array.isArray(entry.choices)&&entry.choices.every(c=>subset(c,choiceKeys)&&validText(c.label)),'加购选项字段无效');
  validateAddon(entry);
 };
 check(a);
 if(a.variants!==undefined)for(const v of a.variants){valid(subset(v,variantKeys),'加购变体字段无效');check(v);}
}
export function validatedSourceRequest(r){
 valid(subset(r,['shopId','scope','action','sourceId','goodsId','fields','restoreFields','resumeTax','followConfigs']),'包含未知来源维护参数');
 valid(nasShopIds.includes(r.shopId)&&['shop','shared'].includes(r.scope),'请明确店铺和维护范围');
 valid(['edit','adopt_erp','create_special','archive','restore'].includes(r.action),'不支持的来源操作');
 for(const k of ['resumeTax','followConfigs'])valid(!own(r,k)||typeof r[k]==='boolean',k+' 必须为布尔值');
 if(['edit','archive','restore'].includes(r.action))valid(id(r.sourceId)&&!own(r,'goodsId'),'维护已有来源须精确指定 sourceId');
 if(r.action==='adopt_erp')valid(sourceGoodsId(r.goodsId)&&!own(r,'sourceId'),'ERP 建源须精确指定 goodsId');
 if(r.action==='create_special')valid(r.scope==='shared'&&!own(r,'sourceId')&&!own(r,'goodsId'),'无货号特殊配件只允许三店共用建源');
 const fields=r.fields??{},restore=r.restoreFields??[];
 valid(!own(r,'fields')||subset(r.fields,sharedSourceKeys),'仅允许显示名称、核算价、加购、硬件和容量覆盖');
 valid(!own(r,'restoreFields')||Array.isArray(r.restoreFields)&&r.scope==='shared'&&r.action==='edit'&&r.restoreFields.length>0,'恢复共用字段须指定共享维护与字段列表');
 valid(new Set(restore).size===restore.length&&restore.every(k=>sharedSourceKeys.includes(k)&&!own(fields,k)),'恢复字段无效或与设置字段重复');
 valid(!r.followConfigs||r.action==='edit','只有变更已有来源支持跟随配置');
 valid(!r.resumeTax||r.action==='edit'&&r.scope==='shop'&&!own(fields,'tax'),'恢复成本表价格仅适用于本店，不能同时手改核算价');
 if(['archive','restore'].includes(r.action))valid(r.scope==='shop'&&!own(r,'fields'),'软删除与恢复只允许操作本店来源');
 if(r.action==='edit')valid(Object.keys(fields).length||restore.length||r.resumeTax,'没有来源维护字段');
 if(r.action==='create_special')valid(Object.keys(fields).length===1&&own(fields,'name'),'特殊配件仅可维护名称，成本固定为零');
 if(r.action==='adopt_erp'&&r.scope==='shop')valid(Object.keys(fields).every(k=>['name','tax'].includes(k)),'单店 ERP 建源支持名称和核算价，其他资料建成后维护');
 try {
  for(const [k,v] of Object.entries(fields)){
   if(k==='name')valid(validText(v)&&v.trim()===v&&v.length>0&&!excludedComponent({name:v}),'显示名称为空、超长或带有星号');
   else if(k==='tax')valid(v===null||Number.isFinite(v)&&v>=0&&v<=100000000&&Math.abs(v*100-Math.round(v*100))<1e-6,'核算价须为非负金额，最多两位小数');
   else if(k==='addon')validateStructuredAddon(v);
   else if(v!==null){
    const [group,key]=k.split('.');
    if(group==='capacityOverrides') {valid(typeof v==='number','容量须为 GB 数值');validateCapacities({[key]:v});}
    else {const normalized=validateHardware({[key]:v});valid(normalized&&own(normalized,key),'无效的硬件覆盖值');}
   }
  }
 }catch(e){if(e.code)throw e;fail('INVALID_PARAMS',e.message);}
 return r;
}

/** 生成工作表会保存的业务值，预览中的原始请求仍保留调用方输入。 */
export function effectiveSourceFields(r){
 const fields=structuredClone(r.fields??{});
 // 只提供多选卡片时，与工作表一样生成展示文案；明确手填的文案继续保留。
 if(Array.isArray(fields.addon?.addonChoices)&&!own(fields.addon,'addonText'))fields.addon.addonText=choiceDescription(fields.addon.addonChoices);
 return fields;
}
/** 仅覆盖本次显式选中的字段；未选的历史厂商扩展继续保留。 */
export function patchSource(row,fields){
 const projected=withSourceFields(row,{...sourceFields(row),...fields}),next=structuredClone(row);
 for(const key of Object.keys(fields)){
  if(key==='addon'){
   for(const k of sharedSourceAddonKeys){
    if(own(projected,k))next[k]=structuredClone(projected[k]);else delete next[k];
   }
  }else if(key.includes('.')){
   const [group,field]=key.split('.');
   next[group]={...next[group]};
   if(fields[key]===null)delete next[group][field];else next[group][field]=structuredClone(fields[key]);
   if(!Object.keys(next[group]).length)delete next[group];
  }else next[key]=projected[key];
 }
 return next;
}
