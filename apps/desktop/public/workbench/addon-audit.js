/** 加购检查只读视图；沿用原有差价规则，支持状态与配件组合筛选。 */
import {slots} from './core.js';
import {addonCheck,addonChecks,sourceAddonOptions} from './addon-data.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const auditStatuses=[['all','全部'],['danger','需要调整'],['warning','核算负差价'],['pending','核算待补充'],['ok','核算正常']];
const statusName=key=>auditStatuses.find(s=>s[0]===key)?.[1]||key;
const money=cents=>cents==null?'待补充':`${cents<0?'−':''}¥${(Math.abs(cents)/100).toFixed(2)}`;
const order=category=>{const i=slots.indexOf(category);return i<0?slots.length:i;};

export function buildAddonAudit(rows,costs,configs){
 const sourceSlots=new Map(),goodsSlots=new Map();
 const add=(map,key,slot)=>{if(!key||!slot)return;if(!map.has(key))map.set(key,new Set());map.get(key).add(slot);};
 for(const config of configs.filter(c=>!c.deletedAt))for(const part of config.parts||[]){
  add(sourceSlots,part.sourceId,part.slot);if(part.goodsId)add(goodsSlots,JSON.stringify([config.shopId,String(part.goodsId)]),part.slot);
 }
 return rows.filter(row=>!row.deletedAt).flatMap(row=>{
  const found=sourceSlots.get(row.sourceId)||goodsSlots.get(JSON.stringify([row.shopId,String(row.goodsId)]));
  const categories=found?.size?[...found]:[row.slot||'未分类'];
  return sourceAddonOptions(row).flatMap(addonChecks).filter(a=>a.text?.trim()).map(addon=>({row,addon,categories,result:addonCheck(addon,costs,[row])}));
 }).sort((a,b)=>auditStatuses.findIndex(s=>s[0]===a.result.severity)-auditStatuses.findIndex(s=>s[0]===b.result.severity));
}

export function filterAddonAudit(checks,{status='all',category=null,query=''}={}){
 const q=query.trim().toLowerCase();
 return checks.filter(c=>(status==='all'||c.result.severity===status)&&(!category||c.categories.includes(category))&&[c.row.name,c.row.goodsId,c.addon.text,c.addon.goodsId,c.result.name,...c.categories].join(' ').toLowerCase().includes(q));
}

function detailHtml({addon,result}){
 const quoted=/^[+＋]\s*(\d+(?:\.\d{1,2})?)\s*元/.exec(addon.text||'');
 const mismatch=(addon.qty??1)===1&&addon.priceCents!=null&&quoted&&Math.round(Number(quoted[1])*100)!==addon.priceCents;
 return `<p class="hint">新配件：${esc(result.name||result.reason)}${addon.goodsId?' · ERP ID '+esc(addon.goodsId):''}</p><div class="addon-audit-table-wrap"><table class="addon-audit-table"><thead><tr><th scope="col">价格依据</th><th scope="col">原配件</th><th scope="col">＋ 加购价</th><th scope="col">− 新配件成本</th><th scope="col">＝ 差价</th></tr></thead><tbody>${[...result.fields].sort((a,b)=>Number(b.key==='tax')-Number(a.key==='tax')).map(f=>`<tr><th scope="row">${esc(f.label)}</th><td>${money(f.originalPriceCents)}</td><td>${money(addon.priceCents)}</td><td>${money(f.costCents)}</td><td class="addon-${f.severity}">${money(f.diffCents)}</td></tr>`).join('')}</tbody></table></div>${result.needsAdjustment?'<p class="addon-danger">ERP 与核算差价均达到红色阈值，需要重新调整加购描述。</p>':''}${result.reason?`<p class="hint">${esc(result.reason)}</p>`:''}${mismatch?'<p class="addon-warning">描述中的金额与设置的加购价不同，请一并核对描述。</p>':''}`;
}

export function mountAddonAudit(root,api){
 let checks=[],status='danger',category=null;
 root.innerHTML=`<section class="addon-audit"><header class="addon-audit-heading"><div><h3>加购差价检查</h3><p class="hint">按检查结果和配件分类查看，编辑后统一保存。</p></div><button type="button" data-audit-close>返回输出源维护</button></header><div class="addon-audit-controls"><div class="addon-audit-search"><input type="search" data-audit-search aria-label="搜索加购检查结果" placeholder="搜索配件名称、ERP ID 或加购文案"><button type="button" data-audit-refresh>重新检查</button></div><div data-audit-status class="addon-audit-filters" role="group" aria-label="检查结果分类"></div><div data-audit-category class="addon-audit-filters" role="group" aria-label="加购配件分类"></div><p class="hint" data-audit-count role="status" aria-live="polite"></p></div><div data-audit-results class="addon-audit-results"></div><p class="hint addon-audit-note">需要调整：ERP 与核算差价均 ≤ −¥50；核算负差价：核算差价为负，但未同时达到红色阈值。未分类表示尚无明确配件槽位。</p></section>`;
 const $=s=>root.querySelector(s);
 function render(){
  const query=$('[data-audit-search]').value,visible=filterAddonAudit(checks,{status,category,query});
  const categories=[...new Set(checks.flatMap(c=>c.categories))].sort((a,b)=>order(a)-order(b)||a.localeCompare(b,'zh-CN',{numeric:true}));
  $('[data-audit-status]').innerHTML=auditStatuses.map(([key,label])=>`<button type="button" data-audit-status-key="${key}" class="audit-status-${key}" aria-pressed="${status===key}">${label}<span>${filterAddonAudit(checks,{status:key,category,query}).length}</span></button>`).join('');
  const scope=filterAddonAudit(checks,{status,query});
  $('[data-audit-category]').innerHTML='<strong>配件分类</strong>'+[null,...categories].map((key,i)=>`<button type="button" data-audit-category-index="${i}" aria-pressed="${category===key}">${esc(key||'全部配件')}<span>${key?scope.filter(c=>c.categories.includes(key)).length:scope.length}</span></button>`).join('');
  $('[data-audit-count]').textContent=`共检查 ${checks.length} 项加购 · 当前：${statusName(status)} / ${category||'全部配件'} · 显示 ${visible.length} 项`;
  // Each audit item appears once even when a source is used in several slots.
  const groups=new Map();for(const check of visible){const key=category||check.categories[0];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(check);}
  $('[data-audit-results]').innerHTML=[...groups].sort(([a],[b])=>order(a)-order(b)||a.localeCompare(b,'zh-CN',{numeric:true})).map(([slot,items])=>`<details class="addon-audit-group" open><summary>${esc(slot)} · ${items.length} 项</summary>${items.map(c=>`<article class="addon-audit-row audit-row-${c.result.severity}"><div class="addon-audit-row-heading"><strong>${esc(c.row.name)}</strong><span class="addon-audit-badge audit-status-${c.result.severity}">${statusName(c.result.severity)}</span><button type="button" data-addon-source="${esc(c.row.sourceId)}">编辑此加购</button></div><p class="addon-audit-copy">${esc(c.addon.text)}</p>${detailHtml(c)}</article>`).join('')}</details>`).join('')||'<p class="addon-audit-empty">当前条件下没有加购项目，可切换分类或清空搜索。</p>';
  root.querySelectorAll('[data-audit-status-key]').forEach(b=>b.onclick=()=>{status=b.dataset.auditStatusKey;render();});
  root.querySelectorAll('[data-audit-category-index]').forEach(b=>b.onclick=()=>{category=[null,...categories][Number(b.dataset.auditCategoryIndex)];render();});
  root.querySelectorAll('[data-addon-source]').forEach(b=>b.onclick=()=>api.edit(b.dataset.addonSource));
 }
 function refresh(){if(!api.stage())return;checks=buildAddonAudit(api.getRows(),api.getCosts(),api.getConfigs());if(category&&!checks.some(c=>c.categories.includes(category)))category=null;render();}
 $('[data-audit-search]').oninput=render;
 $('[data-audit-refresh]').onclick=refresh;
 $('[data-audit-close]').onclick=()=>api.close();
 refresh();return {refresh};
}
