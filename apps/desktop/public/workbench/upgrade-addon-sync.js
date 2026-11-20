/** 总表加购同步的纯数据规则：文案、商品、数量、替换数量、金额和选配项一起应用。 */
import {sourceAddon,sourceAddonFields,sourceAddonOptions,selectedSourceAddons,sourceAddonsForSync,validateAddon,addonSummary,choiceDescription} from './addon-data.js';
const copy=value=>structuredClone(value);
const shops=['intel','gigabyte','jonsbo'];
export function upgradeAddonDefinition(row){
 const addon=sourceAddon(row),text=selectedSourceAddons(row).map(value=>value.text.trim()).filter(Boolean).join('');
 // 只从维护字段取金额，不从用户手写的展示句子解析价格。
 validateAddon(addon,{required:!!text});
 return sourceAddonFields({...addon,text:addon.choices!==undefined?choiceDescription(addon.choices):addon.text});
}
export const upgradeAddonDescription=definition=>selectedSourceAddons(definition).map(a=>a.text.trim()).filter(Boolean).join('');
export const upgradeAddonSummary=definition=>sourceAddonOptions(definition).map(addonSummary).join('\n');
export function structuredUpgradeSourceDocument(source,definition){
 return {id:source.document.id,addon_sync:true,edits:{shared:{values:{addon:copy(definition)},restore:[]},
  ...Object.fromEntries(shops.map(shop=>[shop,{values:{},restore:['addon']}]))}};
}
export function applyStructuredUpgrade(document,reference,definition,{scope='link',sources=[],follow=false}={}){
 const doc=copy(document),field=scope==='all'?'goodsId':reference.sourceId?'sourceId':reference.goodsId?'goodsId':'name';
 const matched=doc.parts.filter(part=>String(part[field]??'')===String(reference[field]??''));
 for(const part of matched){
  let source=sources.find(row=>row.sourceId===part.sourceId&&!row.deletedAt&&row.goodsId===part.goodsId);
  if(!part.sourceId){
   const candidates=sources.filter(row=>!row.deletedAt&&(part.goodsId?row.goodsId===part.goodsId:row.name===part.name)),exact=candidates.filter(row=>row.name===part.name);
   source=exact.length===1?exact[0]:candidates.length===1?candidates[0]:null;
   if(source)part.sourceId=source.sourceId;
  }
  const owner=part.sourceId;
  if(!owner)throw Error((doc.name||'配置')+' 的 '+part.slot+' 未绑定输出源，请先选择来源配件再同步加购');
  const tracks=follow&&!!source,row={...copy(definition),sourceId:owner};
  part.upgrade=upgradeAddonDescription(definition);delete part.overviewAddonHidden;
  if(!part.sourceFollow||part.sourceFollow.sourceId!==owner)part.sourceFollow={sourceId:owner};
  part.sourceFollow.upgrade={mode:tracks?'follow':'manual',value:part.upgrade,...(tracks?{sourceValue:part.upgrade,structured:true}:{})};
  if(!doc.addons)doc.addons=[];
  // 同来源出现在多行只存一组，独立加购及其它来源的快照完整保留。
  if(matched.find(row=>row.sourceId===owner)!==part)continue;
  doc.addons=doc.addons.filter(addon=>addon.sourceId!==owner);
  doc.addons.push(...sourceAddonsForSync(row,{follow:tracks,keepEmpty:tracks}));
 }
 return doc;
}
