/** 本次保存的自动跟随回执：只读展示已应用的差异，不参与待确认字段选择。 */
import {slots} from './core.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'显示名称',upgrade:'逐项升级说明'};
const order=slot=>slots.includes(slot)?slots.indexOf(slot):slots.length;
export function mountAutomaticSourceChanges(root,{shopId}){
 let changes=[],activeSlot=null;
 function render(){
  const items=changes.flatMap(config=>config.details.map(detail=>({config,detail}))),categories=[...new Set(items.map(({detail})=>detail.slot||'未分类'))].sort((a,b)=>order(a)-order(b)||a.localeCompare(b,'zh-CN'));
  root.hidden=!items.length;if(!items.length){root.innerHTML='';return;}
  const visible=items.filter(({detail})=>!activeSlot||(detail.slot||'未分类')===activeSlot),groups=new Map();
  for(const item of visible){const d=item.detail,key=JSON.stringify([d.slot,d.field,d.before,d.after]);if(!groups.has(key))groups.set(key,{detail:d,items:[]});groups.get(key).items.push(item);}
  const text=value=>esc(value===''||value==null?'（空）':value);
  root.innerHTML=`<h4>本次保存已自动更新 <span>${items.length} 项 · ${changes.length} 套配置</span></h4><p class="hint">以下内容已更新到配置图，无需再次勾选确认。手动修改过的内容仍在下方待确认差异中；此处显示最近一次保存的自动更新。</p><div class="source-category-filter" role="group" aria-label="本次自动更新配件分类"><strong>配件分类</strong><div class="source-category-buttons">${[null,...categories].map((slot,i)=>`<button type="button" data-auto-source-category="${i}" aria-pressed="${activeSlot===slot}" class="${activeSlot===slot?'primary':''}">${esc(slot||'全部配件')}（${slot?items.filter(({detail})=>(detail.slot||'未分类')===slot).length:items.length} 项）</button>`).join('')}</div></div><div class="source-auto-follow-results">${categories.filter(slot=>!activeSlot||activeSlot===slot).map(slot=>`<section class="source-part-group" data-auto-source-slot="${esc(slot)}"><h5>${esc(slot)}</h5>${[...groups.values()].filter(g=>(g.detail.slot||'未分类')===slot).map(({detail:d,items:members})=>`<section class="source-description-group" data-auto-source-group><div class="source-description-heading"><strong>${esc(labels[d.field]||d.field)}</strong><span>已自动更新 · ${members.length} 项 · ${new Set(members.map(m=>m.config.before.productId)).size} 个链接</span></div><div class="source-option-change"><span>更新前：${text(d.before)}</span><span>已更新为：${text(d.after)}</span></div><div class="source-description-members">${members.map(({config,detail})=>`<p>${esc(config.product)} · ${esc(config.name)} · ${esc(detail.slot)}（第 ${detail.partIndex+1} 项）</p>`).join('')}</div></section>`).join('')}</section>`).join('')}</div>`;
  root.querySelectorAll('[data-auto-source-category]').forEach(button=>button.onclick=e=>{e.stopPropagation();activeSlot=[null,...categories][Number(button.dataset.autoSourceCategory)];render();});
 }
 return {show(records){changes=structuredClone(records.filter(c=>(c.before.shopId||'intel')===shopId()));activeSlot=null;render();if(!root.hidden)root.scrollIntoView({block:'start'});}};
}
