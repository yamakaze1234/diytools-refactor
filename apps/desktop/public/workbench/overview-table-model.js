import {actualParts} from './actual-parts.js';
import {hasConfigCost,resetConfigCost,setConfigCost} from './config-cost.js';
import {parseCostPrice} from './cost-paste.js';
import {chargeCents,moneyCents} from './pricing.js';
import {isSpecialComponent} from './special-components.js';

export const overviewFeeRate=config=>Number.isFinite(config.overviewFeeRate)&&config.overviewFeeRate>=0&&config.overviewFeeRate<=30?config.overviewFeeRate:4;
/** 多个费率并存时取众数，票数相同沿用工作表中先出现的值。 */
export function commonOverviewFeeRate(configs){
 const counts=new Map();
 for(const config of configs){
  const rate=overviewFeeRate(config);
  counts.set(rate,(counts.get(rate)||0)+1);
 }
 let rate=4,most=0;
 for(const [value,count] of counts)if(count>most){most=count;rate=value;}
 return {rate,mixed:counts.size>1};
}
export function readOverviewFeeRate(value){
 const text=String(value??'').trim(),rate=Number(text);
 if(!/^\d+(?:\.\d{1,4})?$/.test(text)||rate>30)throw Error('运营费率须为 0–30%，最多四位小数');
 return rate;
}

/** 全系统唯一利润口径：成本加运营费和100元，ERP固定扣2%，仅核算利润扣分期。 */
export const PROFIT_FORMULA_VERSION='overview-cost-rate-v1';
export function overviewTableTotals(config,raw,quote,overrides={}){
 const rate=overrides.rate??overviewFeeRate(config);
 const price=overrides.price===undefined?quote.priceCents:moneyCents(overrides.price);
 const tax=moneyCents(raw.tax),erp=moneyCents(raw.erp);
 const fee=tax==null?null:tax+chargeCents(tax,rate)+10000;
 const interest=price==null||quote.term==null?null:chargeCents(price,quote.term===24?10:quote.percent||0);
 const taxProfit=price==null||fee==null||interest==null?null:price-fee-interest;
 // 11-19：ERP 利润与 ERP 财审口径一致，不扣分期手续费；分期只在核算利润里扣。
 const erpProfit=price==null||erp==null?null:price-chargeCents(price,2)-erp;
 return {rate,erp:raw.erp,tax:raw.tax,fee:fee==null?null:fee/100,interest:interest==null?null:interest/100,
  taxProfit:taxProfit==null?null:taxProfit/100,erpProfit:erpProfit==null?null:erpProfit/100};
}

/** 以精确到分的共用价为基准；旧记录无基准时保留独立核算价提醒。 */
export function differentTax(part,shared){
 return !isSpecialComponent(part)&&hasConfigCost(part)&&moneyCents(part.taxOverride.value)!==moneyCents(shared?.tax??part.taxOverride.base);
}
export function overviewTaxDifferenceCount(configs,costIndex){
 return configs.filter(config=>actualParts(config).some(part=>differentTax(part,costIndex.get(String(part.goodsId??''))))).length;
}
export function changeOverviewTax(part,value,shared){
 const price=parseCostPrice(value),base=shared?.tax??(hasConfigCost(part)?part.taxOverride.base:part.tax);
 if(moneyCents(price)===moneyCents(base)){
  if(hasConfigCost(part))resetConfigCost(part,shared?[shared]:[]);
  return;
 }
 setConfigCost(part,price);
 if(shared?.tax!=null)part.taxOverride.base=shared.tax;
}
