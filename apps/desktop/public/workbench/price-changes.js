/** 价格追踪展示规则：记录金额为分，利润复用现有实际 BOM 口径。 */
import {totals} from './core.js';
export function priceMovement(row,metric='erp'){
 const before=row.before[metric],after=row.after[metric];
 if(before==null&&after!=null)return{kind:'first',delta:null,percent:null,label:'首次采集'};
 if(after==null)return{kind:'missing',delta:null,percent:null,label:'价格缺失'};
 const delta=after-before,percent=before>0?delta/before*100:null;
 return{kind:delta>0?(percent==null||percent>=5?'high':'up'):delta<0?'down':'same',delta,percent,label:delta===0?'未变化':null};
}
export function trackedProfit(config,settings){
 if(!config)return null;
 if(!config.actualParts&&!config.parts&&config.loggedProfit)return config.loggedProfit;
 const t=totals(config,settings??{pricingRule:config.shopPricingRule});
 const cents=v=>v==null?null:Math.round(v*100);
 return {tax:cents(t.taxProfitAfter),erp:cents(t.erpProfitAfter),fallback:t.erpFallback>0};
}
export const money=cents=>cents==null?'待补齐':`${cents<0?'−':''}¥${(Math.abs(cents)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const linkKey=c=>JSON.stringify([c.shopId,c.productId||c.id]);
export function filterPriceItems(items,{metric='erp',band='',slot='',search=''}={}){
 const needle=search.trim().toLowerCase();return items.filter(r=>(!band||priceMovement(r,metric).kind===band)&&(!slot||(r.slots||[]).includes(slot))&&(!needle||`${r.name} ${r.goodsId}`.toLowerCase().includes(needle))).sort((a,b)=>Math.abs(priceMovement(b,metric).delta||0)-Math.abs(priceMovement(a,metric).delta||0));
}
