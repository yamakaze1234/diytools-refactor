/** 库存展示适配：区分未知库存与有效数量，供配件行和商品选择器共用。 */
import {componentStock} from './inventory-check-data.js';
import {isSpecialComponent} from './special-components.js';

/** 从配件和成本源解析库存状态，缺失资料不能当作零库存。 */
export function componentStockView(part,costs){
 if(isSpecialComponent(part))return {status:'special',label:'特殊配件 · 不核算库存',detail:''};
 const stock=componentStock(part.goodsId,costs);
 const label=stock.value===null?'ERP 可销库存：未知':`ERP 可销库存：${stock.value.toLocaleString('zh-CN',{maximumFractionDigits:6})}${stock.status==='out'?' · 无库存':stock.status==='low'?' · 库存偏低':''}`;
 const time=stock.updatedAt?new Date(stock.updatedAt):null;
 const detail=stock.value===null?stock.reason:time&&!Number.isNaN(time.getTime())?'最近同步：'+time.toLocaleString('zh-CN'):'本机最近一次 ERP 库存快照';
 return {...stock,label,detail};
}

const escStock=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** 将库存状态转为经过转义的界面片段。 */
export function componentStockHtml(part,costs){
 const stock=componentStockView(part,costs);
 return `<small class="component-stock stock-${stock.status}" title="${escStock(stock.detail)}">${escStock(stock.label)}${stock.status==='unknown'?`<span>${escStock(stock.detail)}</span>`:''}</small>`;
}
