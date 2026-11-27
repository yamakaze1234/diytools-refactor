/** 输出源差异只保存显式选择的字段；单独导图不触碰配置。 */
import {sourceComparisonHtml} from './source-sync-data.js';
import {captureBatchRevert,batchRevertPlan} from './batch-revert.js';
import {sourceFollowPlan,sourceAlertFields,ignoreDaysLeft,IGNORED_RETENTION_MS} from './source-follow.js';
import {slots} from './core.js';
import {shopById} from './shops.js';
import {mountAutomaticSourceChanges} from './source-auto-follow-view.js';
import {exportOptionsHtml,readExportOptions,exportSourceImages} from './source-sync-export.js';
export {openSavedAddonDecision} from './source-saved-addon-dialog.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={upgrade:'逐项升级说明',name:'显示名称',tax:'含税核算单价'};
const tabs=[['all','全部待确认','cat'],['follow','跟随输出源 · 待同步','blue'],['manual','人工特殊文案 · 需确认','amber'],['ignored','已处理 / 已忽略 (7天清理)','grey']];
const slotOrder=value=>slots.includes(value)?slots.indexOf(value):slots.length;
const slotOf=d=>d.slot||'未分类';
const linkKey=c=>c.before.productId||c.product||c.before.spu||'';
const countConfigs=items=>new Set(items.map(item=>item.config.id)).size;
const timeOf=value=>Date.parse(value)||0;
function changedTime(value){
 if(!timeOf(value))return '';
 const date=new Date(value),two=n=>String(n).padStart(2,'0');
 return `${two(date.getMonth()+1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 按来源、字段和前后值分组；同槽位的不同来源不能共用一次确认。 */
function grouped(items){
 const groups=new Map();
 for(const item of items){
  const d=item.detail,key=JSON.stringify([d.sourceId,d.kind,d.slot,d.field,d.before,d.after]);
  if(!groups.has(key))groups.set(key,{key,d,items:[]});
  groups.get(key).items.push(item);
 }
 return [...groups.values()].sort((a,b)=>timeOf(b.d.changedAt)-timeOf(a.d.changedAt)||slotOrder(a.d.slot)-slotOrder(b.d.slot));
}

function memberHtml({config,detail},ignored){
 const key=esc(detail.key),spu=config.before.spu;
 return `<div class="sd-member"><label>${ignored?'':`<input type="checkbox" data-source-select value="${key}">`}<strong title="${esc(config.product)}">${esc(config.product)}</strong><span title="${esc(config.name)}">· ${esc(config.name)}</span></label>
 ${ignored?`<span class="sd-badge sd-grey">还剩 ${detail.daysLeft} 天清理</span><button type="button" data-restore-item="${key}">恢复</button>`:spu?`<small title="${esc(spu)}">SPU …${esc(String(spu).slice(-6))}</small>`:''}</div>`;
}
function groupHtml(group,index,ignored,expanded){
 const {d,items}=group,follow=d.kind==='follow',count=countConfigs(items),time=changedTime(d.changedAt);
 const latest=d.field==='upgrade'?'加购':labels[d.field];
 const oldLabel=d.field==='upgrade'?(follow?'配置当前旧加购':'配置当前人工特殊文案'):'配置当前'+labels[d.field];
 return `<article data-source-description-group data-source-part-group="${esc(slotOf(d))}" class="sd-group ${follow?'sd-follow':'sd-manual'}">
 <div class="sd-group-head"><div>${ignored?'':`<input type="checkbox" aria-label="选择此组" data-source-select-group="${index}">`}
 <span class="sd-badge sd-${ignored?'grey':follow?'blue':'amber'}">${ignored?'已处理 / 已忽略':follow?'跟随输出源 · 待同步':'人工特殊文案 · 不强制替换'}</span>
 <strong>${esc(slotOf(d))} · ${esc(labels[d.field])}</strong><span class="sd-badge sd-cat">${esc(d.sourceName||d.sourceId)}</span>
 ${time?`<span class="sd-badge sd-grey" title="${esc(d.changedAt)}">变动 ${time}</span>`:''}<small>${count} 套配置 · ${new Set(items.map(item=>linkKey(item.config))).size} 个链接</small></div>
 <div><button type="button" ${ignored?`data-restore-group="${index}"`:`data-ignore-group="${index}" ${d.field==='tax'?'disabled title="核算单价不可忽略"':''}`}>${ignored?'恢复整组待确认':'忽略此组'}</button><button type="button" data-toggle-group="${index}" aria-expanded="${expanded}">${expanded?'收起 ▲':`展开 ${count} 套 ▼`}</button></div></div>
 <div class="sd-compare" data-source-description>${sourceComparisonHtml(d.before,d.after,oldLabel,'输出源最新'+latest)}</div>
 <div class="sd-members" ${expanded?'':'hidden'}>${items.map(item=>memberHtml(item,ignored)).join('')}</div></article>`;
}

function reviewHtml(shop){
 return `<header class="sd-header"><div><strong>待确认差异</strong><span class="sd-badge sd-cat">${esc(shopById(shop).shortName)}</span><small>所有修改均不强制替换人工特殊文案；已处理 / 已忽略记录满 7 天自动清理。</small></div><button type="button" data-close aria-label="关闭">✕</button></header>
 <section class="sd-toolbar"><div class="sd-tabbar"><div data-diff-tabs>${tabs.map(([id,label,tone])=>`<button type="button" data-diff-tab="${id}" aria-pressed="${id==='all'}"><span>${label}</span><span class="sd-badge sd-${tone}" data-count="${id}">0</span></button>`).join('')}</div><small data-diff-summary></small></div>
 <div class="sd-filters"><input type="search" data-review-search aria-label="搜索差异" placeholder="搜索链接、配置、配件或加购文案…"><select data-review-link aria-label="链接"><option value="">全部链接</option></select><select data-review-slot aria-label="配件类别"><option value="">全部配件</option></select>
 <button id="diff-select-follow" type="button">一键全选「跟随待同步」</button><button type="button" data-source-clear>清空勾选</button>
 <details class="sd-fields"><summary aria-label="字段筛选">字段筛选 ▾</summary><div>${Object.entries(labels).map(([key,label])=>`<label><input type="checkbox" data-source-field="${key}"${sourceAlertFields.includes(key)?' checked':''}>${label}</label>`).join('')}</div></details><button id="source-check" type="button">刷新</button></div></section>
 <div class="sd-list" id="source-diff" data-source-groups></div><nav class="sd-pagination" data-review-pagination aria-label="差异分组分页" hidden></nav>
 <footer class="sd-footer"><div class="sd-export-row"><div class="sd-footer-settings">
 <label><input type="checkbox" data-review-export checked>导出图片</label><div class="sd-footer-options">${exportOptionsHtml()}</div></div>
 <div class="sd-footnote"><small role="status" data-source-sync-message></small><button type="button" id="source-export-retry" hidden>重新导出</button><button type="button" id="source-undo" hidden>还原本次修改（一次）</button></div></div>
 <div class="sd-actions"><strong data-review-selected>已选 0 项</strong><div class="sd-action-buttons"><button id="source-keep-all" type="button" disabled>标记已处理 / 忽略本次</button><button id="diff-export-only-btn" type="button" disabled>仅导出所选配置图片</button><button id="source-apply" type="button" class="sd-primary" disabled>采用新内容并导出图片</button></div></div></footer>`;
}

export function mountSourceSync(root,api){
 const errorText=error=>api.errorText?.(error)??error.message;
 const $=selector=>root.querySelector(selector),all=selector=>[...root.querySelectorAll(selector)];
 const dialog=root.closest('dialog')||root;
 let busy=false,locked=[],generation=0,preview=null,undo=null,lastExport=null,expiryTimer=null,groups=[],tab='all',items=[],visible=[],filtered=[];
 let page=0;const pageSize=12;
 const selected=new Set(),expanded=new Set();
 const guard=event=>{if(busy&&root.isConnected)event.preventDefault();};
 dialog.addEventListener('cancel',guard);
 const dispose=()=>{generation++;clearTimeout(expiryTimer);dialog.removeEventListener('cancel',guard);};
 function lock(value){
  busy=value;
  if(value){locked=[...dialog.querySelectorAll('input,textarea,select,button')].map(el=>[el,el.disabled]);for(const [el] of locked)el.disabled=true;}
  else{for(const [el,disabled] of locked)el.disabled=disabled;locked=[];}
 }
 // 长回执在宽屏底栏只占一行，悬停仍可读取完整提示。
 const setStatus=text=>{const status=$('[data-source-sync-message]');if(status){status.textContent=text;status.title=text;}};
 const message=text=>{setStatus(text);api.message?.(text);};
 if(api.view==='automatic'){
  root.classList.add('source-review-standalone');
  root.innerHTML='<h3>本次变动</h3><div data-source-automatic></div><p data-auto-empty>本次还没有保存的变动。</p><small data-source-sync-message role="status"></small>';
  let automatic;
  return {invalidate(){},refresh:async()=>{},isBusy:()=>busy,dispose,showAutomaticChanges(records){
   if(!records.length&&!automatic)return;
   automatic??=mountAutomaticSourceChanges($('[data-source-automatic]'),{shopId:api.shopId,onExport:async(changes,{scope,images,skuMode})=>{
    if(busy)return;
    try{if(api.isEdited())throw Error('请先保存或重置当前输出源修改。');lock(true);await api.flush();
     await exportSourceImages(api,changes,api.shopId(),{scope,layouts:images==='both'?['long','square']:[images],skuMode},message);
    }catch(error){message('导出未完成：'+error.message);}finally{lock(false);}
   }});
   automatic.show(records);$('[data-auto-empty]').hidden=records.some(c=>(c.before.shopId||'intel')===api.shopId());
  }};
 }
 root.classList.add('sd-modal','sd-review');
 root.innerHTML=reviewHtml(api.shopId());
 $('[data-close]').onclick=()=>{if(!busy)dialog.close?.();};
 function invalidate(){
  generation++;clearTimeout(expiryTimer);preview=null;groups=[];items=[];filtered=[];visible=[];page=0;selected.clear();
  render();
 }
 function matches({config,detail},query,link,slot){
  return (!link||linkKey(config)===link)&&(!slot||slot===slotOf(detail))&&(!query||[config.product,config.name,config.before.spu,detail.slot,detail.sourceName,detail.before,detail.after].join(' ').toLowerCase().includes(query));
 }
 function updateSelection(){
  const chosen=tab==='ignored'?[]:items.filter(item=>selected.has(item.detail.key)&&!item.detail.ignored);
  const follow=chosen.filter(item=>item.detail.kind==='follow'),count=chosen.length,ignorable=chosen.filter(item=>item.detail.field!=='tax').length,hasTax=ignorable<count;
  const layouts=readExportOptions(root).layouts,auto=$('[data-review-export]').checked&&layouts.length>0;
  $('#source-apply').disabled=busy||!count;$('#diff-export-only-btn').disabled=busy||!count||!layouts.length;
  $('#source-undo').disabled=busy||!undo;
  $('#source-keep-all').disabled=busy||!ignorable;
  $('#source-keep-all').title=hasTax?'含核算单价，不能忽略源版本。':'';
  $('#source-keep-all').textContent='标记已处理 / 忽略本次'+(ignorable?' ('+ignorable+')':'');
  $('#source-apply').textContent=(auto?'采用新内容并导出图片':'采用新内容')+(count?' ('+count+')':'');
  $('.sd-footer-options').classList.toggle('sd-muted-options',!$('[data-review-export]').checked);
  const label=$('[data-review-selected]');
  // visible 包括筛选命中的全部明细，不受分页或分组展开状态影响。
  if(tab==='ignored')label.textContent=`已处理 / 已忽略 ${visible.length} 项（满 7 天自动清理）`;
  else label.textContent=chosen.length?`已选 ${countConfigs(chosen)} 套（跟随 ${countConfigs(follow)} · 人工 ${countConfigs(chosen.filter(item=>item.detail.kind==='manual'))}）`:'已选 0 项';
  for(const el of all('[data-source-select]'))el.checked=selected.has(el.value);
  for(const el of all('[data-source-select-group]')){
   const group=groups[Number(el.dataset.sourceSelectGroup)],n=group.items.filter(item=>selected.has(item.detail.key)).length;
   el.checked=n===group.items.length;el.indeterminate=n>0&&n<group.items.length;el.closest('[data-source-description-group]').classList.toggle('is-selected',n>0);
  }
  const hidden=count-visible.filter(item=>selected.has(item.detail.key)).length;
  const notes=[];
  if(hasTax)notes.push('含核算单价，不能忽略源版本。');
  if(hidden>0)notes.push(`其中 ${hidden} 项在其他链接或配件分类中。`);
  if(count&&auto&&$('[data-export-scope]').value==='changed')notes.push(`确认更新后导出 ${countConfigs(chosen)*layouts.length} 张图片。`);
  setStatus(notes.join('')||'勾选「跟随待同步」可更新或仅导图；人工特殊文案默认不勾选，可按需替换或忽略本次。');
 }
 function render(){
  const query=$('[data-review-search]').value.trim().toLowerCase(),link=$('[data-review-link]').value,slot=$('[data-review-slot]').value;
  filtered=items.filter(item=>matches(item,query,link,slot));
  const counts={all:0,follow:0,manual:0,ignored:0};
  for(const {detail:d} of filtered){if(d.ignored)counts.ignored++;else{counts.all++;counts[d.kind]++;}}
  for(const el of all('[data-count]'))el.textContent=counts[el.dataset.count];
  for(const el of all('[data-diff-tab]'))el.setAttribute('aria-pressed',String(el.dataset.diffTab===tab));
  $('[data-diff-summary]').textContent=`待同步跟随 ${counts.follow} · 人工待确认 ${counts.manual} · 已忽略 ${counts.ignored}`;
  const ignored=tab==='ignored';
  visible=filtered.filter(({detail:d})=>ignored?d.ignored:!d.ignored&&(tab==='all'||tab===d.kind));
  const found=grouped(visible),pages=Math.max(1,Math.ceil(found.length/pageSize));
  page=Math.min(page,pages-1);groups=found.slice(page*pageSize,(page+1)*pageSize);
  const pagination=$('[data-review-pagination]');pagination.hidden=pages===1;
  pagination.innerHTML=pages>1?`<button type="button" data-review-prev ${page===0?'disabled':''}>上一页</button><span>${page+1} / ${pages} · 共 ${found.length} 组</span><button type="button" data-review-next ${page===pages-1?'disabled':''}>下一页</button>`:'';
  if(pages>1){
   const turn=n=>{page+=n;render();$('[data-source-groups]').scrollTop=0;};
   $('[data-review-prev]').onclick=()=>turn(-1);$('[data-review-next]').onclick=()=>turn(1);
  }
  $('[data-source-groups]').innerHTML=groups.map((g,i)=>groupHtml(g,i,ignored,expanded.has(g.key))).join('')||`<p class="sd-empty">${ignored?'暂无 7 天内已处理 / 已忽略记录。':'当前筛选下没有待确认差异。'}</p>`;
  for(const el of all('[data-source-select]'))el.onchange=()=>{if(el.checked)selected.add(el.value);else selected.delete(el.value);updateSelection();};
  for(const el of all('[data-source-select-group]'))el.onchange=()=>{
   for(const {detail} of groups[Number(el.dataset.sourceSelectGroup)].items){if(el.checked)selected.add(detail.key);else selected.delete(detail.key);}
   updateSelection();
  };
  for(const el of all('[data-toggle-group]'))el.onclick=()=>{
   const g=groups[Number(el.dataset.toggleGroup)];if(expanded.has(g.key))expanded.delete(g.key);else expanded.add(g.key);render();
  };
  for(const el of all('[data-ignore-group]'))el.onclick=()=>applySelected('ignore',groups[Number(el.dataset.ignoreGroup)].items.map(i=>i.detail.key));
  for(const el of all('[data-restore-group]'))el.onclick=()=>applySelected('unignore',groups[Number(el.dataset.restoreGroup)].items.map(i=>i.detail.key));
  for(const el of all('[data-restore-item]'))el.onclick=()=>applySelected('unignore',[el.dataset.restoreItem]);
  updateSelection();
 }
 function updateFilters(){
  for(const [selector,empty,options] of [
   ['[data-review-link]','全部链接',new Map(items.map(({config})=>[linkKey(config),config.product]))],
   ['[data-review-slot]','全部配件',new Map([...new Set(items.map(({detail})=>slotOf(detail)))].sort((a,b)=>slotOrder(a)-slotOrder(b)).map(slot=>[slot,slot]))]
  ]){
   const el=$(selector),last=el.value;
   el.innerHTML=`<option value="">${empty}</option>`+[...options].map(([key,text])=>`<option value="${esc(key)}">${esc(text)}</option>`).join('');
   el.value=options.has(last)?last:'';
  }
 }
 function scheduleRetention(){
  // 已忽略项按其实际忽略时刻跨日。只调整列表副本，不重读工作区或丢弃选择。
  clearTimeout(expiryTimer);
  const now=Date.now(),day=86400000;
  let delay=Infinity;
  for(const {detail:d} of items)if(d.ignored){
   const remaining=Date.parse(d.ignoredAt)+IGNORED_RETENTION_MS-now;
   if(Number.isFinite(remaining))delay=Math.min(delay,remaining<=0?1:remaining-(Math.ceil(remaining/day)-1)*day+1);
  }
  if(Number.isFinite(delay))expiryTimer=setTimeout(()=>{
   if(!root.isConnected||!dialog.open)return;
   if(busy){expiryTimer=setTimeout(scheduleRetention,1000);return;}
   const clock=Date.now();
   items=items.filter(({detail:d})=>!d.ignored||(d.daysLeft=ignoreDaysLeft(d.ignoredAt,clock))>0);
   updateFilters();render();scheduleRetention();
  },delay);
 }
 async function refresh(){
  if(busy)return;
  invalidate();const token=generation;
  $('[data-source-groups]').innerHTML='<p class="sd-empty">正在读取本店差异…</p>';
  try{
   if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再查看差异。');
   await api.flush();if(token!==generation)return;
   if(api.isEdited())throw Error('输出源有新修改，请先保存。');
   const fields=all('[data-source-field]:checked').map(el=>el.dataset.sourceField);
   if(fields.length){
    preview=sourceFollowPlan(api.getConfigs(),api.getRows(),fields,api.shopId(),{includeIgnored:true});
    items=preview.changes.flatMap(config=>config.details.map(detail=>({config,detail})));
   }
   updateFilters();render();
   scheduleRetention();
  }catch(error){if(token===generation){render();message(errorText(error));}}
 }
 async function applySelected(action,keys=[...selected]){
  if(busy||!preview||!keys.length)return;
  let saved=false,result='';
  try{
   if(api.isEdited())throw Error('输出源有新修改，请先保存并重新预览。');
   const approved=sourceFollowPlan(preview.changes.map(c=>c.before),preview.sources,preview.fields,preview.shopId,{keys,action});
   if(!approved.changes.length)return;
   const options=readExportOptions(root),auto=action==='update'&&$('[data-review-export]').checked&&options.layouts.length;
   lock(true);await api.apply(approved);saved=true;
   undo=captureBatchRevert(approved,api.getConfigs());$('#source-undo').hidden=false;
   // 保留上次更新范围。重新导出使用最新渲染内容，不重新提交同步计划。
   lastExport=action==='update'?{shop:approved.shopId,changes:approved.changes.map(c=>({id:c.id,before:{shopId:approved.shopId,productId:c.before.productId,product:c.product,spu:c.before.spu}}))}:null;
   $('#source-export-retry').hidden=!lastExport;
   await api.onChanged?.();
   if(auto){
    const task=await exportSourceImages(api,approved.changes,approved.shopId,options,message);
    result='配置已更新。'+task.message;
   }else result=action==='ignore'?'已忽略本次输出源内容，配置文案已保留。':action==='unignore'?'已恢复待确认。':`已更新 ${approved.changes.length} 套配置。`;
  }catch(error){result=(saved?'配置已保存，后续操作未完成：':'操作未完成：')+errorText(error);}
  finally{lock(false);if(saved)await refresh();else invalidate();message(result);}
 }
 $('#source-apply').onclick=()=>applySelected('update');
 $('#source-keep-all').onclick=()=>applySelected('ignore');
 $('#diff-export-only-btn').onclick=async()=>{
  if(busy||!preview)return;
  const chosen=preview.changes.filter(c=>c.details.some(d=>!d.ignored&&selected.has(d.key)));
  if(!chosen.length)return;
  try{if(api.isEdited())throw Error('输出源有新修改，请先保存。');lock(true);await exportSourceImages(api,chosen,preview.shopId,readExportOptions(root),message);}
  catch(error){message('导出未完成：'+error.message);}finally{lock(false);}
 };
 $('#source-undo').onclick=async()=>{
  if(busy||!undo)return;
  let status='';
  try{
   if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再还原。');
   lock(true);await api.flush();const reversal=batchRevertPlan(undo,api.getConfigs());
   if(reversal.changes.length)await api.apply({...reversal,shopId:api.shopId(),sources:[],action:'restore'});
   undo=null;lastExport=null;$('#source-undo').hidden=true;$('#source-export-retry').hidden=true;await api.onChanged?.();status='已还原本次修改并保存。';
  }catch(error){status='还原未完成：'+errorText(error);}finally{lock(false);await refresh();message(status);}
 };
 $('#source-export-retry').onclick=async()=>{
  if(busy||!lastExport)return;
  try{
   if(api.isEdited())throw Error('输出源有新修改，请先保存。');
   const options=readExportOptions(root);
   if(!options.layouts.length)throw Error('请至少选择一种图片。');
   lock(true);await exportSourceImages(api,lastExport.changes,lastExport.shop,options,message);
  }catch(error){message('导出未完成：'+error.message);}finally{lock(false);}
 };
 $('#source-check').onclick=refresh;
 const filterChanged=()=>{page=0;render();};
 for(const el of all('[data-diff-tab]'))el.onclick=()=>{tab=el.dataset.diffTab;filterChanged();};
 $('[data-review-search]').oninput=filterChanged;
 for(const el of all('[data-review-link],[data-review-slot]'))el.onchange=filterChanged;
 for(const el of all('[data-review-export],[data-layout],[data-export-scope]'))el.onchange=updateSelection;
 for(const el of all('[data-source-field]'))el.onchange=refresh;
 $('#diff-select-follow').onclick=()=>{
  if(busy)return;selected.clear();
  for(const {detail} of filtered)if(!detail.ignored&&detail.kind==='follow')selected.add(detail.key);
  if(tab==='ignored'||tab==='manual')tab='all';
  render();
 };
 $('[data-source-clear]').onclick=()=>{selected.clear();updateSelection();};
 if(!api.deferRefresh)queueMicrotask(()=>{if(!api.isEdited())void refresh();});
 return {invalidate,refresh,isBusy:()=>busy,showAutomaticChanges(){},dispose};
}
