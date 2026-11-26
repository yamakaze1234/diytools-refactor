import {componentStock} from './inventory-check-data.js';
import {isSpecialComponent} from './special-components.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** 快捷入口的原生表单与 React 外壳共用一份标记，保留编辑会话所需的字段 ID。 */
export function quickSourceFieldsHtml(row,{nas,shopName}){
 const special=isSpecialComponent(row);
 return `<section class="sq-identity" aria-label="商品身份">
   <div class="sq-identity-line">
    <strong data-quick-erp-name>${esc(special?row.name:row.erpName||'ERP 原名待同步')}</strong>
    <span class="sq-id">${special?'特殊配件':'#'+esc(row.goodsId)}</span>
    <input id="source-id" type="hidden" value="${esc(row.goodsId)}">
    <span class="sq-price" ${special?'hidden':''}>ERP <output id="source-erp-price" aria-label="ERP 单价"></output></span>
    <span id="source-stock"></span><button type="button" id="source-erp-refresh">查询 ERP</button>
   </div>
   <div class="sq-context"><span>${esc(shopName)}</span><span id="source-erp-status" role="status"></span></div>
  </section>
  <div class="sq-fields">
   <div><label class="field source-field-name" for="source-name"><span>本店产品显示名称</span>
    <textarea id="source-name" rows="1">${esc(row.name)}</textarea></label></div>
   <div><label class="field source-field-price" for="source-tax"><span class="sq-tax-caption">${nas?'本店':'三店共用'}含税核算单价<span data-quick-tax-delta aria-hidden="true">${special?'成本 ¥0':'待对比'}</span></span>
    <input id="source-tax" aria-label="${nas?'本店':'三店共用'}含税核算单价" type="number" min="0" step=".01" value="${esc(row.tax)}" ${special?'readonly':''} placeholder="留空待核算"></label></div>
  </div>`;
}

/** ERP 行情只显示实查/已同步的数据，未知的价格和数量都保留未知。 */
export function showQuickObservation(root,row,observed,stockRows){
 const title=root.querySelector('[data-quick-erp-name]');
 const original=observed?.erpName||(observed!==row&&observed?.name)||row.erpName||'ERP 原名待同步';
 title.textContent=original;
 title.title=original;
 const amount=observed?.erp;
 const price=root.querySelector('#source-erp-price');
 const known=amount!=null&&amount!==''&&!observed.erpMissing&&!observed.erpUnknown&&Number.isFinite(Number(amount))&&Number(amount)>=0;
 price.dataset.cents=known?String(Math.round(Number(amount)*100)):'';
 price.textContent=known?'¥'+Number(amount).toFixed(2):'待同步';
 const {value,incoming,status}=componentStock(row.goodsId,stockRows);
 // 与输出源工作表一致，只有待入可销超过现货时才展示蓝色提醒。
 const transit=incoming!=null&&incoming>(value??0)?` <span class="sq-badge" data-tone="transit">待入 ${incoming}</span>`:'';
 root.querySelector('#source-stock').innerHTML=`<span class="sq-badge" data-tone="${status}">现货 ${value??'未知'}</span>`+transit;
}

/** 仅对两种有效金额计算分差，空税价、缺失 ERP 价不会被解释成零。 */
export function updateQuickTaxDelta(root){
 const badge=root.querySelector('[data-quick-tax-delta]');
 if(!badge)return;
 const tax=root.querySelector('#source-tax').value;
 const cents=root.querySelector('#source-erp-price').dataset.cents;
 if(cents==null||cents===''||!/^\d+(\.\d{1,2})?$/.test(tax)){
  badge.dataset.tone='unknown';
  badge.textContent=root.querySelector('#source-special').checked?'成本 ¥0':'待对比';
  return;
 }
 const delta=Math.round(Number(tax)*100)-Number(cents);
 badge.dataset.tone=delta<0?'low':'ok';
 badge.textContent=delta===0?'与 ERP 持平':`${delta<0?'低于':'高于'} ERP ${delta<0?'−':'+'}¥${(Math.abs(delta)/100).toFixed(2)}`;
}
