/** 单独核算价统一按最新有效共用成本比较，明细身份只用于定位和批量恢复。 */
import {actualParts} from './actual-parts.js';
import {differentTax,overviewTaxDifferenceCount} from './overview-table-model.js';
import {moneyCents} from './pricing.js';

export const taxPartKey=part=>String(part.goodsId??'');
export const taxLineKey=(part,index)=>part.lineId||`${part.slot}:${index}`;
export function taxOverrideLines(config,costIndex){
 return actualParts(config).flatMap((part,index)=>{
  const shared=costIndex.get(taxPartKey(part));if(!differentTax(part,shared))return [];
  const base=shared?.tax??part.taxOverride.base,value=part.taxOverride.value;
  const baseCents=moneyCents(base),valueCents=moneyCents(value),qty=Number(part.qty);
  const unit=baseCents==null?null:(valueCents-baseCents)/100;
  return [{configId:config.id,configName:config.shortName||config.name,product:config.product,shopId:config.shopId,productId:config.productId,
   key:JSON.stringify([config.id,taxLineKey(part,index)]),lineKey:taxLineKey(part,index),goodsId:taxPartKey(part),slot:part.slot,name:shared?.name||part.erpName||part.name,
   base:baseCents==null?null:baseCents/100,value,qty,unit,delta:unit!=null&&Number.isInteger(qty)&&qty>0?Math.round(unit*qty*100)/100:null}];
 });
}
export function summarizeTaxOverrides(configs,costs){
 const index=costs instanceof Map?costs:new Map(costs.map(row=>[String(row.goodsId??''),row]));
 const active=configs.filter(c=>!c.deletedAt&&!c.emptyLinkDraft),lines=active.flatMap(c=>taxOverrideLines(c,index));
 const groups=new Map(),byConfig=new Map();
 for(const line of lines){
  if(!groups.has(line.goodsId))groups.set(line.goodsId,{goodsId:line.goodsId,name:line.name,slot:line.slot,lines:[],ids:new Set()});
  const group=groups.get(line.goodsId);group.lines.push(line);group.ids.add(line.configId);
  if(!byConfig.has(line.configId))byConfig.set(line.configId,[]);byConfig.get(line.configId).push(line);
 }
 return {lines,byConfig,groups:[...groups.values()].sort((a,b)=>b.ids.size-a.ids.size||a.name.localeCompare(b.name,'zh-CN')),
  count:overviewTaxDifferenceCount(active,index),itemCount:lines.length,partCount:groups.size,index};
}
export const taxDelta=lines=>lines.some(line=>line.delta==null)?null:Math.round(lines.reduce((sum,line)=>sum+line.delta,0)*100)/100;
