/** 统一计价参数：百分点最多四位小数；所有费用各自舍入到分后再相减。 */
export const INSTALLMENT_TERMS=[0,6,12,24];
export const DEFAULT_PRICING_RULE=Object.freeze({erpRate:2,taxRate:4,erpFixed:0,taxFixed:100,fee6:3.8,fee12:6,fee24:10});
export const DEFAULT_PROFIT_ALERT=Object.freeze({mode:'amount',loss:0,target:100});

// 按十进制字符舍入，避免 .005 等金额被二进制浮点截错一分。
export function nonnegativeScaled(value,digits=2){
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const text=String(value).trim();
 if(text.length>64)return null;
 const match=/^\+?(\d*\.?\d*)(?:e([+-]?\d{1,2}))?$/i.exec(text);
 if(!match||!/[0-9]/.test(match[1]))return null;
 const [whole,fraction='']=match[1].split('.'),power=Number(match[2]||0);
 if(Math.abs(power)>30)return null;
 const n=BigInt(whole+fraction),shift=digits+power-fraction.length;
 const scale=10n**BigInt(Math.abs(shift)),scaled=shift>=0?n*scale:(n+scale/2n)/scale;
 return scaled<=BigInt(Number.MAX_SAFE_INTEGER)?Number(scaled):null;
}
export const moneyCents=value=>nonnegativeScaled(value);
const rateUnits=value=>nonnegativeScaled(value,4);
const isFixed=key=>key.endsWith('Fixed');
const keys=Object.keys(DEFAULT_PRICING_RULE);
function parseRule(raw,partial){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const out={...DEFAULT_PRICING_RULE};
 for(const key of keys){
  if(partial&&!Object.hasOwn(raw,key))continue;
  const value=raw[key],scale=isFixed(key)?100:10000,units=isFixed(key)?moneyCents(value):rateUnits(value);
  if(units==null||Number(value)!==units/scale||units>(isFixed(key)?100000000:990000))return null;
  out[key]=units/scale;
 }
 if(Math.max(rateUnits(out.erpRate),rateUnits(out.taxRate))+Math.max(...[6,12,24].map(n=>rateUnits(out['fee'+n])))>=1000000)return null;
 return out;
}
export const normalizePricingRule=rule=>parseRule(rule,true);
export function validatePricingRule(raw){
 const rule=parseRule(raw,false);
 if(!rule)throw Error('请填写有效费用；扣点与任一分期息点之和必须低于 100%。固定费用最多两位小数，费率最多四位小数。');
 return rule;
}
export const effectivePricingRule=(config,settings={})=>normalizePricingRule(config.pricingRule)||normalizePricingRule(settings.pricingRule)||DEFAULT_PRICING_RULE;

export function normalizeProfitAlert(value){
 if(!value||!['amount','rate'].includes(value.mode))return null;
 const {mode,loss,target}=value,absLimit=mode==='rate'?100:1000000;
 if(typeof loss!=='number'||typeof target!=='number'||!Number.isFinite(loss)||!Number.isFinite(target)||loss< -absLimit||target<0||target>absLimit||loss>target)return null;
 return {mode,loss,target};
}
export const PROFIT_ALERT_BASES=Object.freeze(['erp','tax']);

/** 保留检测勾选及各自阈值；旧共用阈值同时继承给两项，避免升级丢失设置。 */
export function normalizeProfitAlerts(value){
 const shared=normalizeProfitAlert(value),erp=normalizeProfitAlert(value?.erpProfit),tax=normalizeProfitAlert(value?.taxProfit);
 if(!shared&&!erp&&!tax)return null;
 const bases=PROFIT_ALERT_BASES.filter(key=>Array.isArray(value.bases)&&value.bases.includes(key));
 return {bases:bases.length?bases:[...PROFIT_ALERT_BASES],erpProfit:erp??shared??DEFAULT_PROFIT_ALERT,taxProfit:tax??shared??DEFAULT_PROFIT_ALERT};
}

export function readInstallment(config){
 if(config.installment===undefined)return 0;
 if(![0,6,12,24,'0','6','12','24'].includes(config.installment))return null;
 return Number(config.installment);
}
export function chargeCents(amountCents,percent){
 if(amountCents==null||percent==null)return null;
 const rate=rateUnits(percent),product=amountCents*rate;
 return Number.isSafeInteger(product+500000)?Math.floor((product+500000)/1000000):Number((BigInt(amountCents)*BigInt(rate)+500000n)/1000000n);
}
/** 到手价为空时定价、扣点与分期费保持未知；历史未设置分期时视为不分期。 */
export function pricing(config,settings={}){
 const priceCents=moneyCents(config.price),couponCents=moneyCents(settings.coupon??0),term=settings.linkInstallment===null?null:readInstallment(config),rule=effectivePricingRule(config,settings);
 const percent=term==null?null:term?rule['fee'+term]:0;
 const feeCents=chargeCents(priceCents,percent);
 return {arrival:priceCents==null?null:priceCents/100,priceCents,coupon:couponCents==null?null:couponCents/100,listPrice:priceCents==null||couponCents==null?null:(priceCents+couponCents)/100,term,rate:percent==null?null:percent/100,percent,fee:feeCents==null?null:feeCents/100,feeCents,rule};
}
export function pricingColumn(configs,settings){
 if(!configs.length)throw Error('请先勾选配置');
 return configs.map(c=>{const {listPrice}=pricing(c,settings);if(listPrice==null)throw Error(`${c.name||'配置'} 的到手价或优惠券无效`);return Math.round(listPrice).toString();}).join('\r\n');
}
export const deletedWithinRetention=(configs,at=Date.now())=>configs.filter(c=>c.deletedAt&&Date.parse(c.deletedAt)>at-3*86400000);

export function productInstallment(configs=[]){
 const terms=new Set(configs.filter(c=>!c.deletedAt).map(readInstallment));
 return terms.size===0?0:terms.size===1?[...terms][0]:null;
}
/** 将确认的分期方案统一应用到指定链接配置。 */
export function applyProductInstallment(configs,product,term){
 if(!INSTALLMENT_TERMS.includes(term))throw Error('请选择不分期、6 期、12 期或 24 期');
 const ids=[];
 for(const c of configs)if(!c.deletedAt&&c.shopId===product.shopId&&c.productId===product.id){c.installment=term;ids.push(c.id);}
 return ids;
}
