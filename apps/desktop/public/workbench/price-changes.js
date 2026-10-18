/** 价格追踪展示规则：记录金额为分，利润复用现有实际 BOM 口径。 */
import {totals} from './core.js';
import {pricing} from './pricing.js';
import {actualParts} from './actual-parts.js';
import {isSpecialComponent} from './special-components.js';
export function priceMovement(row,metric='erp'){
 const before=row.before[metric],after=row.after[metric];
 if(before==null&&after!=null)return{kind:'first',delta:null,percent:null,label:'首次采集'};
 if(after==null)return{kind:'missing',delta:null,percent:null,label:'价格缺失'};
 const delta=after-before,percent=before>0?delta/before*100:null;
 return{kind:delta>0?(percent==null||percent>=5?'high':'up'):delta<0?'down':'same',delta,percent,label:delta===0?'未变化':null};
}
export function trackedProfit(config){
 if(!config)return null;
 const parts=actualParts(config).filter(p=>!isSpecialComponent(p)&&(p.name||p.goodsId));
 const valid=parts.length>0&&config.price!==null&&config.price!==''&&Number.isFinite(Number(config.price))&&Number(config.price)>=0&&parts.every(p=>Number.isInteger(Number(p.qty))&&Number(p.qty)>0);
 if(!valid)return{tax:null,erp:null,fallback:false};
 try{const t=totals(config),fee=pricing({...config,installment:config.installment??0}).fee;
 return{tax:parts.every(p=>p.tax!==null&&p.tax!==undefined&&p.tax!==''&&Number.isFinite(Number(p.tax))&&Number(p.tax)>=0)?Math.round((t.taxProfit-fee)*100):null,erp:t.erpProfit==null?null:Math.round((t.erpProfit-fee)*100),fallback:t.erpFallback>0};
 }catch{return{tax:null,erp:null,fallback:false};}
}
export const money=cents=>cents==null?'待补齐':`${cents<0?'−':''}¥${(Math.abs(cents)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const linkKey=c=>JSON.stringify([c.shopId,c.productId||c.id]);
export function filterPriceItems(items,{metric='erp',band='',slot='',search=''}={}){
 const needle=search.trim().toLowerCase();return items.filter(r=>(!band||priceMovement(r,metric).kind===band)&&(!slot||(r.slots||[]).includes(slot))&&(!needle||`${r.name} ${r.goodsId}`.toLowerCase().includes(needle))).sort((a,b)=>Math.abs(priceMovement(b,metric).delta||0)-Math.abs(priceMovement(a,metric).delta||0));
}
