/** 配置独立成本：维护覆盖值与共享成本的关系，并提供行内及链接级成本编辑。 */
import {parseCostPrice} from './cost-paste.js';
import {isSpecialComponent} from './special-components.js';
import {actualParts} from './actual-parts.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const configCostCount=config=>actualParts(config).filter(hasConfigCost).length;
export function configCostNote(config){
 const count=configCostCount(config);
 return count?`<span class="config-cost-note">含 ${count} 项单独改价</span>`:'';
}
export function configCostLinksHtml(configs,shopId){
 const groups=new Map();
 for(const config of configs){
  if(config.deletedAt||(config.shopId||'intel')!==shopId||!configCostCount(config))continue;
  const key=config.productId||config.product||config.id;
  if(!groups.has(key))groups.set(key,{name:config.product||'未命名链接',spu:config.spu,configs:[]});
  groups.get(key).configs.push(config);
 }
 if(!groups.size)return '';
 return `<div class="source-cost-override-warning" role="status"><strong>本店 ${groups.size} 个链接存在单独核算价</strong><p>以下配置使用单独修改的含税单价；更新共用成本源后仍保留单独价，恢复共用价后才会跟随更新。</p><ul>${[...groups.values()].map(group=>`<li><details class="source-cost-link"><summary><strong>${esc(group.name)}</strong>${group.spu?` <span>（SPU ${esc(group.spu)}）</span>`:''} · ${group.configs.length} 套配置</summary><div class="source-cost-link-detail">${group.configs.map(config=>`${esc(config.name||'未命名配置')}（${actualParts(config).filter(hasConfigCost).map(part=>esc(part.slot)).join('、')}）`).join('；')}<p>按已保存的共用成本源更新本链接的单独核算价；无有效共用价的配件保留原价。</p><button type="button" data-update-link-cost="${esc(group.configs[0].id)}">一键更新价格</button></div></details></li>`).join('')}</ul></div>`;
}

export const hasConfigCost=part=>!isSpecialComponent(part)&&part.taxOverride?.goodsId===String(part.goodsId||'')&&Number.isFinite(part.taxOverride?.value)&&part.taxOverride.value>=0;
/** 给配件设置配置专属成本覆盖，避免修改公共成本源。 */
export function setConfigCost(part,value){
 if(isSpecialComponent(part))throw Error('特殊配件不参与成本核算');
 const price=parseCostPrice(value);
 part.taxOverride={goodsId:String(part.goodsId||''),value:price,base:hasConfigCost(part)?part.taxOverride.base:part.tax??null};
 part.tax=price;
}
/** 同步共享成本时保留已有独立覆盖规则。 */
export function syncConfigCost(part,value){
 if(hasConfigCost(part)){part.taxOverride.base=value;part.tax=part.taxOverride.value;}
 else{delete part.taxOverride;part.tax=value;}
}
/** 取消配件独立成本并恢复成本源提供的价格。 */
export function resetConfigCost(part,costs=[]){
 const shared=costs.find(row=>row.goodsId&&row.goodsId===part.goodsId);
 part.tax=shared?shared.tax??null:part.taxOverride?.base??null;
 delete part.taxOverride;
}
export function configCostCell(part,index,money){
 return `${part.tax==null?'待填':'¥'+money(part.tax)}${hasConfigCost(part)?'<span class="config-cost-note">已单独修改</span>':''}${isSpecialComponent(part)?'':` <button data-config-cost="${index}">修改价格</button>${hasConfigCost(part)?` <button data-config-cost-reset="${index}">恢复共用价</button>`:''}`}`;
}
/** 绑定当前配置成本输入，使用调用方接口记录变更。 */
export function bindConfigCosts(el,config,api){
 const parts=api.parts;
 el.querySelectorAll('[data-config-cost]').forEach(button=>button.onclick=()=>{
  const part=parts[Number(button.dataset.configCost)];
  api.openDialog('单独修改含税单价',`<p class="hint">仅修改当前配置该行的含税单价，保存后重新计算成本和利润。</p><label class="field">含税单价<input id="config-cost-value" type="number" min="0" step="0.01" value="${part.tax??''}"></label><p id="config-cost-error" class="danger" role="alert"></p><div class="actions"><button id="config-cost-save" class="primary">保存价格</button></div>`);
  const input=document.querySelector('#config-cost-value');input.focus();input.select();
  document.querySelector('#config-cost-save').onclick=()=>{
   try{const value=parseCostPrice(input.value);api.checkpoint();setConfigCost(part,value);config.taxUpdatedAt=new Date().toISOString();api.changed('单独修改含税单价');api.closeDialog();api.render();}
   catch(error){document.querySelector('#config-cost-error').textContent=error.message;}
  };
 });
 el.querySelectorAll('[data-config-cost-reset]').forEach(button=>button.onclick=()=>{
  api.checkpoint();resetConfigCost(parts[Number(button.dataset.configCostReset)],api.costs);config.taxUpdatedAt=new Date().toISOString();api.changed('恢复共用含税单价');api.render();
 });
}

/** 将链接内配置成本调整应用到符合店铺和链接范围的目标。 */
export function updateLinkConfigCosts(configs,shopId,anchorId,costs){
 const anchor=configs.find(c=>c.id===anchorId&&!c.deletedAt&&(c.shopId||'intel')===shopId);
 if(!anchor)throw Error('链接已变化，请重新打开输出源维护');
 const key=c=>c.productId||c.product||c.id,lookup=new Map(costs.filter(r=>r.goodsId).map(r=>[r.goodsId,r]));
 const ids=[];let count=0,skipped=0;
 for(const c of configs){
  if(c.deletedAt||(c.shopId||'intel')!==shopId||key(c)!==key(anchor))continue;
  let hit=false;
  for(const part of actualParts(c).filter(hasConfigCost)){
   const shared=lookup.get(part.goodsId);
   if(!shared||!Number.isFinite(shared.tax)||shared.tax<0){skipped++;continue;}
   part.tax=shared.tax;delete part.taxOverride;count++;hit=true;
  }
  if(hit){c.taxUpdatedAt=new Date().toISOString();ids.push(c.id);}
 }
 return {ids,count,skipped};
}
