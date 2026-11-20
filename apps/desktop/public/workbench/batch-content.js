/** 只复制本次选中的配置图内容。 */
import {clearPosterExtraTextOverride,editPosterExtra,insertPosterExtra,posterExtraRows,removePosterAddonCopy,removePosterExtra,setPosterExtraVisible} from './config-extras.js';
import {maintenanceShortName} from './short-name-poster.js';

export function posterAddonTextRows(config){
 return posterExtraRows(config,'addons').filter(row=>row.text?.trim()||row.note?.trim());
}

export function syncPosterAddonText(reference,target){
 const incoming=posterAddonTextRows(reference);
 const existing=posterExtraRows(target,'addons');
 if(incoming.length&&Array.isArray(target.modules)&&!target.modules.some(module=>module.type==='addons')){
  setPosterExtraVisible(target,'addons',true);
 }
 // 用底部文案本身定插入位置，避免 NAS 重读时派生的跟随组改变新增文案的行号。
 let insertAt=existing.length?existing.at(-1).index+1:0;
 for(let i=0;i<incoming.length;i++){
  const {text='',note=''}=incoming[i];
  if(i<existing.length){
   editPosterExtra(target,'addons',existing[i].index,'text',text);
   editPosterExtra(target,'addons',existing[i].index,'note',note);
  }else{
   insertPosterExtra(target,'addons',insertAt++,{text,note,items:[]});
  }
 }
 // 旧记录带有商品或价格时保留这些字段，即使底部文案被清空。
 for(const row of existing.slice(incoming.length).reverse())removePosterAddonCopy(target,row.index);
}

export function applyBatchContent(reference,target,{addons=false,benefits=false,version=false}={}){
 if(version){
  target.version=reference.version||'';
  if(target.shortNameAuto===true)target.shortName=maintenanceShortName(target);
 }
 if(addons)syncPosterAddonText(reference,target);
 if(benefits){
  const incoming=reference.benefits||[];
  for(let i=(target.benefits||[]).length-1;i>=0;i--){
   if(i>=incoming.length)removePosterExtra(target,'benefits',i);
  }
  target.benefits=structuredClone(incoming);
  for(const i of incoming.keys()){
   for(const field of ['text','note'])clearPosterExtraTextOverride(target,'benefits',i,field);
  }
 }
 return target;
}
