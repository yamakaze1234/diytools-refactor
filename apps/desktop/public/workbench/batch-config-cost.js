/** 配置独立成本批量编辑：按配件身份汇总目标，生成覆盖价预览。 */
import {actualParts,ensureActualParts} from './actual-parts.js';
import {setConfigCost} from './config-cost.js';
import {isSpecialComponent} from './special-components.js';
import {parseCostPrice} from './cost-paste.js';
import {validateReplacement} from './global-batch.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=p=>String(p.goodsId||'').trim()&&String(p.goodsId)!=='0'?`id:${p.goodsId}`:`name:${p.name}`;
/** 从配置内配件筛选可批量修改成本的候选项。 */
export function costCandidates(configs,query){
 const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean),found=new Map();
 if(!words.length)return [];
 for(const c of configs.filter(c=>!c.deletedAt))for(const p of actualParts(c)){
  if(isSpecialComponent(p)||!p.name||!words.every(w=>`${p.name} ${p.goodsId||''}`.toLowerCase().includes(w)))continue;
  const id=key(p);if(!found.has(id))found.set(id,{key:id,name:p.name,goodsId:p.goodsId,ids:new Set(),count:0});
  const row=found.get(id);row.ids.add(c.id);row.count++;
 }
 return [...found.values()].map(r=>({...r,configs:r.ids.size,ids:undefined}));
}
/** 生成指定配件的独立成本调整计划，不在预览阶段修改配置。 */
export function batchConfigCostPlan(configs,partKey,value){
 if(!partKey)throw Error('请搜索并选择要修改的配件');
 const price=parseCostPrice(value),changes=[],rows=[];
 for(const before of configs.filter(c=>!c.deletedAt)){
  const after=structuredClone(before);ensureActualParts(after);
  for(const [index,part] of after.actualParts.entries()){
   if(isSpecialComponent(part)||key(part)!==partKey)continue;
   const old=structuredClone(part);setConfigCost(part,price);
   if(JSON.stringify(old)!==JSON.stringify(part))rows.push({id:before.id,product:before.product,name:before.name,slot:part.slot,part:part.name,goodsId:part.goodsId,before:old.tax,after:price,qty:part.qty??1,index});
  }
  if(rows.some(r=>r.id===before.id))changes.push({id:before.id,name:before.name,product:before.product,before:structuredClone(before),after});
 }
 return {changes,rows,scopeIds:configs.filter(c=>!c.deletedAt).map(c=>c.id).sort()};
}

/** 绑定成本输入、目标选择和计划确认。 */
export function openBatchConfigCost(api){
 const $=s=>document.querySelector(s);let plan=null,busy=false;
 api.openDialog('批量修改含税单价',`<p class="hint">按配件名称或 ERP ID 搜索，选择配件后统一设置单独核算价。仅修改实际配置；共用成本源、展示配件和 ERP 单价保持不变。</p><label class="field">修改范围<select id="batch-cost-scope"><option value="selected">左侧勾选配置（本店，可跨链接）</option><option value="link">当前链接全部配置</option><option value="shop">本店全部配置</option></select></label><p id="batch-cost-scope-info" class="hint"></p><label class="field">搜索配件 / ERP ID<input id="batch-cost-query" type="search" placeholder="输入配件名称或 ERP ID"></label><label class="field">匹配配件<select id="batch-cost-match"><option value="">请先搜索配件</option></select></label><label class="field">新的含税单价（元 / 件）<input id="batch-cost-price" type="number" min="0" step="0.01" placeholder="可输入 0，最多两位小数"></label><div class="actions"><button id="batch-cost-preview">预览修改</button><button id="batch-cost-apply" class="primary" disabled>应用并保存</button></div><p id="batch-cost-status" role="status"></p><div id="batch-cost-diff" style="overflow:auto;max-height:45vh"></div>`);
 const dialog=$('#batch-cost-status').closest('dialog');
 const targets=()=>{const mode=$('#batch-cost-scope').value,selected=new Set(api.getSelectedIds());return api.getConfigs().filter(c=>!c.deletedAt&&(mode==='shop'||mode==='link'&&c.productId===api.productId||mode==='selected'&&selected.has(c.id)));};
 const invalidate=()=>{plan=null;$('#batch-cost-apply').disabled=true;$('#batch-cost-status').textContent='';$('#batch-cost-diff').textContent='';};
 const refresh=()=>{invalidate();const configs=targets();$('#batch-cost-scope-info').textContent=`范围内 ${configs.length} 套配置`;$('#batch-cost-match').innerHTML='<option value="">请选择配件</option>'+costCandidates(configs,$('#batch-cost-query').value).map(r=>`<option value="${esc(r.key)}">${esc(r.name)} · ERP ID ${esc(r.goodsId||'无')} · ${r.configs} 套 / ${r.count} 行</option>`).join('');};
 if(!api.getSelectedIds().length)$('#batch-cost-scope').value='link';
 $('#batch-cost-scope').onchange=refresh;$('#batch-cost-query').oninput=refresh;
 $('#batch-cost-match').onchange=invalidate;$('#batch-cost-price').oninput=invalidate;
 $('#batch-cost-preview').onclick=()=>{try{
  plan=batchConfigCostPlan(targets(),$('#batch-cost-match').value,$('#batch-cost-price').value);
  $('#batch-cost-status').textContent=`将修改 ${plan.changes.length} 套配置、${plan.rows.length} 行配件单价`;
  $('#batch-cost-diff').innerHTML=`<table class="cost-table"><thead><tr><th>链接 / 配置</th><th>配件 / ID</th><th>原单价</th><th>新单价</th><th>数量</th></tr></thead><tbody>${plan.rows.map(r=>`<tr><td>${esc(r.product)} / ${esc(r.name)}</td><td>${esc(r.slot)} · ${esc(r.part)}<br>${esc(r.goodsId)}</td><td>${r.before==null?'待填':'¥'+esc(r.before)}</td><td>¥${r.after}</td><td>${r.qty}</td></tr>`).join('')}</tbody></table>`;
  $('#batch-cost-apply').disabled=!plan.changes.length;
 }catch(e){invalidate();$('#batch-cost-status').textContent=e.message;}};
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('#batch-cost-apply').onclick=async()=>{if(!plan||busy)return;busy=true;const controls=[...dialog.querySelectorAll('button,input,select')].map(el=>[el,el.disabled]);controls.forEach(([el])=>el.disabled=true);try{
  if(JSON.stringify(targets().map(c=>c.id).sort())!==JSON.stringify(plan.scopeIds))throw Error('修改范围已变化，请重新预览');
  validateReplacement(plan,targets());const count=plan.changes.length;
  $('#batch-cost-status').textContent='正在保存…';await api.apply(plan);
  invalidate();$('#batch-cost-status').textContent=`已保存 ${count} 套配置的单独核算价`;api.toast('批量修改价格已保存');
 }catch(e){invalidate();$('#batch-cost-status').textContent=e.message;}finally{busy=false;controls.forEach(([el,disabled])=>{if(el.isConnected)el.disabled=disabled;});if(!plan)$('#batch-cost-apply').disabled=true;}};
 refresh();
}
