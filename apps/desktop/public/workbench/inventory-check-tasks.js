import {componentStock,inventoryCategory} from './inventory-check-data.js';
import {categoryFromErp} from './component-category.js';
import {actualParts} from './actual-parts.js';
import {stockBadge} from './inventory-check-view.js';

// 任务按异常配件标识复用。勾选的链接、替代件、搜索和自定义展示名均保存在各自草稿。
export function stockTaskEditor({$,esc,getCatalog,getCosts,getConfigs,shop,invalidate,drawReport}){
 const drafts=[];
 let active=null,candidates=[],links=new Map();
 function filtered(task){
  const query=task.query.trim().toLowerCase();
  return candidates.filter(c=>(!task.same||c.category===task.row.category)&&(!task.available||c.stock.value>0)&&
   (!query||[c.name,c.erpName,c.goodsId].some(v=>String(v??'').toLowerCase().includes(query))));
 }
 function tabs(){
  $('#stock-task-count').textContent=`${drafts.length} 条任务`;
  $('#stock-task-tabs').innerHTML=drafts.map((t,i)=>`<span class="task-tab ${active===t?'active':''}"><button data-stock-task="${i}" aria-pressed="${active===t}">任务${i+1} · ${esc(t.row.category)}${t.productIds.length&&t.sourceId?' ✓':''}</button><button data-stock-task-delete="${i}" aria-label="移除任务 ${i+1}">×</button></span>`).join('');
  $('#stock-preview').disabled=!drafts.length||drafts.some(t=>!t.sourceId||!t.productIds.length);
 }
 function drawLinks(){
  $('#stock-links-title').textContent=`1. 勾选要替换的链接 (${active.productIds.length}/${links.size})`;
  $('#stock-links').innerHTML=[...links].map(([id,rows])=>{
   const names=new Map(rows.map(s=>[s.configId,s.config]));
   return `<label><input type="checkbox" data-stock-link value="${esc(id)}" ${active.productIds.includes(id)?'checked':''}><span><b>${esc(rows[0].product)}</b><small>影响 ${names.size} 套：${esc([...names.values()].join('、'))}</small></span></label>`;
  }).join('');
 }
 function drawPicker(){
  const rows=filtered(active);
  $('#stock-picker').innerHTML=rows.map(c=>`<label class="${c.sourceId===active.sourceId?'selected':''}"><input type="radio" name="stock-replacement" data-product-id="${esc(c.sourceId)}" ${c.sourceId===active.sourceId?'checked':''}>
   <span><b>${esc(c.name)}</b><span class="candidate-meta">${stockBadge(c.stock)}
   ${c.stock.incoming!==null&&c.stock.incoming>(c.stock.value??0)?`<span class="badge badge-transit">待入 ${c.stock.incoming}</span>`:''}
   <small>${esc(c.category)} · ID ${esc(c.goodsId||'—')}</small><small>ERP ${esc(c.erp??'—')} / 核算 ${esc(c.tax??'—')}</small></span></span></label>`).join('')||'<small>没有符合条件的替代件。</small>';
  const selected=candidates.find(c=>c.sourceId===active.sourceId);
  $('#stock-name-editor').hidden=!selected;
  $('#stock-display-name').value=active.displayName;
  $('#stock-display-name').placeholder=selected?.name||'';
 }
 function render(){
  tabs();$('#stock-empty').hidden=!!active;$('#stock-work').hidden=!active;
  if(!active)return;
  const row=active.row;
  $('#stock-original').innerHTML=`<div>${stockBadge(row)} <span class="badge badge-cat">${esc(row.category)}</span></div><b>${esc(row.name)}</b><small>GoodID ${esc(row.goodsId)}</small>`;
  links=Map.groupBy(row.sources,s=>s.productId);
  $('#stock-same').checked=active.same;$('#stock-available').checked=active.available;$('#stock-new-query').value=active.query;
  drawLinks();drawPicker();
 }
 function reset(threshold){
  drafts.length=0;active=null;invalidate();
  const costs=Map.groupBy(getCosts(),c=>c.goodsId);
  // 历史来源可能没有大类；只有本店实际用过的部位一致时，才用该部位辅助识别。
  const slots=new Map();
  for(const config of getConfigs()){
   if((config.shopId||'intel')!==shop.id||config.deletedAt||config.emptyLinkDraft)continue;
   for(const part of actualParts(config)){
    const slot=categoryFromErp(part.slot);
    if(!part.goodsId||!slot)continue;
    if(!slots.has(part.goodsId))slots.set(part.goodsId,slot);
    else if(slots.get(part.goodsId)!==slot)slots.set(part.goodsId,null);
   }
  }
  candidates=getCatalog().filter(r=>!r.deletedAt&&r.shopId===shop.id).map(r=>{
   const hits=costs.get(r.goodsId),cost=hits?.length===1?hits[0]:null;
   const category=inventoryCategory({...r,slot:r.slot||slots.get(r.goodsId)},cost);
   return {...r,category,stock:componentStock(r.goodsId,costs,threshold),erpName:r.erpName||cost?.erpName||cost?.name||r.originalName};
  });
  render();
 }
 function open(row){
  active=drafts.find(t=>t.issueKey===row.key);
  if(!active){
   active={row,issueKey:row.key,productIds:[...new Set(row.sources.map(s=>s.productId))],sourceId:'',displayName:'',same:true,available:true,query:''};
   active.sourceId=filtered(active).find(c=>c.goodsId!==row.goodsId)?.sourceId||'';
   drafts.push(active);invalidate();
  }
  render();drawReport();$('.stock-editor').scrollTop=0;
 }
 $('#stock-task-tabs').onclick=e=>{
  const remove=e.target.closest('[data-stock-task-delete]'),tab=e.target.closest('[data-stock-task]');
  if(remove){
   const [removed]=drafts.splice(Number(remove.dataset.stockTaskDelete),1);
   if(removed===active)active=drafts[0]||null;
   invalidate();
  }else if(tab)active=drafts[Number(tab.dataset.stockTask)];else return;
  render();drawReport();$('.stock-editor').scrollTop=0;
 };
 const changed=()=>{invalidate();tabs();};
 const selectLinks=ids=>{active.productIds=ids;drawLinks();changed();};
 $('#stock-select-all').onclick=()=>selectLinks([...links.keys()]);
 $('#stock-select-none').onclick=()=>selectLinks([]);
 $('#stock-links').onchange=()=>{
  active.productIds=[...$('#stock-links').querySelectorAll(':checked')].map(el=>el.value);
  $('#stock-links-title').textContent=`1. 勾选要替换的链接 (${active.productIds.length}/${links.size})`;changed();
 };
 function filter(){
  active.same=$('#stock-same').checked;active.available=$('#stock-available').checked;active.query=$('#stock-new-query').value;
  if(!filtered(active).some(c=>c.sourceId===active.sourceId)){active.sourceId='';active.displayName='';}
  drawPicker();changed();
 }
 $('#stock-same').onchange=filter;$('#stock-available').onchange=filter;$('#stock-new-query').oninput=filter;
 $('#stock-picker').onchange=e=>{
  if(!e.target.matches('[data-product-id]'))return;
  active.sourceId=e.target.dataset.productId;active.displayName='';drawPicker();changed();
 };
 $('#stock-display-name').oninput=e=>{active.displayName=e.target.value;changed();};
 $('#stock-default-name').onclick=()=>{active.displayName='';$('#stock-display-name').value='';changed();};
 return {drafts,get active(){return active;},open,reset};
}
