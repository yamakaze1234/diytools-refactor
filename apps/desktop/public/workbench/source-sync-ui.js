/** 输出源差异按配件与描述分组，保留字段选择与手动内容保护。 */
import {sourceExportEntries,sourceComparisonHtml} from './source-sync-data.js';
import {captureBatchRevert,batchRevertPlan} from './batch-revert.js';
import {startImageExportTask} from './image-export-tasks.js';
import {sourceFollowPlan} from './source-follow.js';
import {slots} from './core.js';
import {mountAutomaticSourceChanges} from './source-auto-follow-view.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'显示名称',tax:'含税核算单价',upgrade:'逐项升级说明'};
export function mountSourceSync(root,api){
 root.classList.add('source-sync-panel');
 root.classList.add('source-review');
 root.innerHTML=`<header class="source-review-heading"><h3>输出源变动</h3><p class="hint">查看更新内容，决定是否采用。</p></header><nav class="source-review-tabs" aria-label="变动状态"><button type="button" data-review-tab="automatic" aria-pressed="false">本次变动 <span data-auto-count>0</span></button><button type="button" data-review-tab="pending" aria-pressed="true">待确认 <span data-pending-count>0</span></button></nav><section data-review-pane="automatic" hidden><section data-source-automatic></section><p data-auto-empty class="hint">本次还没有保存的变动。保存输出源后，未手改内容的变化会显示在这里。</p></section><section data-review-pane="pending"><p class="hint">手动修改过的内容，由你决定是否更新。</p><div class="source-review-filter"><input type="search" data-review-search placeholder="搜索链接、配置或内容" aria-label="搜索待确认差异"><select data-review-link aria-label="链接"><option value="">全部链接</option></select><select data-review-slot aria-label="配件"><option value="">全部配件</option></select><details class="source-review-more"><summary>更多筛选</summary><div class="source-fields">${Object.entries(labels).map(([key,name])=>`<label><input type="checkbox" data-source-field="${key}" checked>${name}</label>`).join('')}</div><p class="hint">保持内容只忽略本次源版本，下一次变化仍会提醒。核算单价需单独确认。</p></details><button id="source-check" type="button">刷新</button></div><div id="source-diff"></div><div class="source-review-pagination" data-review-pagination></div><footer class="source-review-footer"><div><strong data-review-selected>已选 0 项</strong><div class="source-review-options"><label><input type="checkbox" data-review-export>更新后导出图片</label><label class="source-export-inline" title="导出配置图和 SKU 图，导出时选择保存位置">范围<select id="source-export-scope"><option value="changed" selected>仅已选变动配置</option><option value="all">相关链接全部配置</option></select></label><button id="source-undo" hidden>撤销上次操作</button><button id="source-export-retry" hidden>重新导出</button></div></div><div class="source-review-buttons"><button id="source-keep-all" disabled>保持全部手动差异</button><button id="source-apply" class="primary" disabled>采用新内容</button></div><span hidden><input type="radio" name="source-export" value="no" checked><input type="radio" name="source-export" value="yes"><button id="source-ignore" disabled>保持已选内容</button></span></footer></section><p data-source-sync-message class="hint source-review-message" role="status"></p>`;

 const $=s=>root.querySelector(s);let preview=null,plan=null,busy=false,exportBatch=null,undoRecords=null,locked=[],activeLink=null,activeSlot=null,allLinks=true,descriptionGroups=[],selected=new Set(),generation=0;
 let automatic,search='',resultPage=0;const pageSize=8;
 function switchTab(tab){root.querySelectorAll('[data-review-tab]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.reviewTab===tab)));root.querySelectorAll('[data-review-pane]').forEach(el=>el.hidden=el.dataset.reviewPane!==tab);}
 root.querySelectorAll('[data-review-tab]').forEach(el=>el.onclick=()=>switchTab(el.dataset.reviewTab));
 $('[data-review-export]').onchange=e=>{$(`input[name=source-export][value=${e.target.checked?'yes':'no'}]`).checked=true;selection();};
 $('[data-review-search]').oninput=e=>{search=e.target.value.trim().toLocaleLowerCase();resultPage=0;if(preview)renderDetails();};
 $('[data-review-link]').onchange=e=>{activeLink=e.target.value||null;allLinks=!activeLink;resultPage=0;if(preview)renderDetails();};
 $('[data-review-slot]').onchange=e=>{activeSlot=e.target.value||null;resultPage=0;if(preview)renderDetails();};
 const message=text=>{$('[data-source-sync-message]').textContent=text;api.message(text);};
 function invalidate(){generation++;resultPage=0;preview=null;plan=null;activeLink=null;activeSlot=null;allLinks=true;descriptionGroups=[];selected.clear();$('#source-apply').disabled=true;$('#source-ignore').disabled=true;$('#source-keep-all').disabled=true;$('#source-diff').innerHTML='';}
 const dialog=root.closest('dialog')||root,cancelGuard=e=>{if(root.isConnected&&busy)e.preventDefault();};dialog.addEventListener('cancel',cancelGuard);
 // Captured controls may belong to a retained, detached source draft after a
 // conflict replaces the shared dialog; restore their state before reopening.
 function lock(value){busy=value;if(value){locked=[...dialog.querySelectorAll('input,textarea,select,button')].map(el=>[el,el.disabled]);for(const [el] of locked)el.disabled=true;}else for(const [el,disabled] of locked)el.disabled=disabled;}
 const autoExport=()=>$('input[name=source-export]:checked').value==='yes';
 const category=detail=>detail.slot||'未分类';
 const visibleDetails=config=>config.details.filter(detail=>activeSlot===null||category(detail)===activeSlot);
 const orderedCategories=categories=>[...categories].sort((a,b)=>{const ai=slots.indexOf(a),bi=slots.indexOf(b);return (ai<0?slots.length:ai)-(bi<0?slots.length:bi)||a.localeCompare(b,'zh-CN',{numeric:true});});
 const currentItems=()=>preview?preview.changes.filter(c=>allLinks||c.before.productId===activeLink).flatMap(config=>visibleDetails(config).filter(detail=>!search||[config.product,config.name,config.before.spu,detail.before,detail.after].join(' ').toLocaleLowerCase().includes(search)).map(detail=>({config,detail}))):[];
 const manualKeys=()=>preview?preview.changes.flatMap(c=>c.details.filter(d=>d.field!=='tax').map(d=>d.key)):[];
 function buildPlan(action='update',keys=[...selected]){return sourceFollowPlan(preview.changes.map(c=>c.before),preview.sources,preview.fields,preview.shopId,{keys,action});}
 function selection(){
  if(!preview)return;
  plan=buildPlan();const count=plan.changes.reduce((n,c)=>n+c.details.length,0),hasTax=preview.changes.some(c=>c.details.some(d=>selected.has(d.key)&&d.field==='tax'));
  const manualCount=manualKeys().filter(key=>!selected.size||selected.has(key)).length;$('#source-keep-all').disabled=busy||!manualCount;$('#source-keep-all').textContent=`${selected.size?'保持已选内容':'保持全部手动差异'}${manualCount?`（${manualCount} 项）`:''}`;
  $('#source-apply').disabled=busy||!count;$('#source-ignore').disabled=busy||!count||hasTax;
  const all=$('[data-source-select-all]'),items=descriptionGroups.flatMap(g=>g.items);if(all){const n=items.filter(i=>selected.has(i.detail.key)).length;all.checked=items.length>0&&n===items.length;all.indeterminate=n>0&&n<items.length;}
  root.querySelectorAll('[data-source-select-group]').forEach(el=>{const group=descriptionGroups[Number(el.dataset.sourceSelectGroup)],n=group.items.filter(i=>selected.has(i.detail.key)).length;el.checked=n===group.items.length;el.indeterminate=n>0&&n<group.items.length;});
  $('[data-review-selected]').textContent=`已选 ${count} 项 · 涉及 ${plan.changes.length} 套配置`;
  root.querySelectorAll('[data-source-description-group]').forEach(el=>{el.classList.toggle('is-selected',el.querySelector('[data-source-select-group]').checked);});
  const hidden=count-items.filter(i=>selected.has(i.detail.key)).length;
  message(`已选择 ${count} 项，涉及 ${plan.changes.length} 套配置。${hidden?`其中 ${hidden} 项在其他链接或配件分类中。`:''}${hasTax?'含核算单价，不能忽略源版本。':'未勾选的内容继续保留。'}${count&&autoExport()?`确认更新后生成并导出 ${sourceExportEntries(api.getConfigs(),plan.changes,preview.shopId,$('#source-export-scope').value).length} 张图片。`:''}`);
 }
 function renderDetails(){
  const items=currentItems(),groups=new Map();
  for(const item of items){const d=item.detail,slot=category(d),key=JSON.stringify([slot,d.field,d.before,d.after]);if(!groups.has(key))groups.set(key,{slot,detail:d,items:[]});groups.get(key).items.push(item);}
  const groupList=[...groups.values()],pages=Math.max(1,Math.ceil(groupList.length/pageSize));resultPage=Math.min(resultPage,pages-1);descriptionGroups=groupList.slice(resultPage*pageSize,(resultPage+1)*pageSize);
  const categories=orderedCategories(new Set(items.map(i=>category(i.detail))));
  const value=v=>esc(v===''||v==null?'（空）':v);
  const scope=allLinks?'全部链接':'当前链接';
  $('[data-source-groups]').innerHTML=items.length?`<div class="source-selection-actions"><label><input type="checkbox" data-source-select-all>全选当前页</label><button data-source-clear>清空选择</button></div>${categories.map(slot=>{
   const grouped=descriptionGroups.map((group,index)=>({...group,index})).filter(group=>group.slot===slot);
   return `<section class="source-part-group" data-source-part-group="${esc(slot)}"><h5>${esc(slot)} <small>（${grouped.length} 组描述 · ${grouped.reduce((n,g)=>n+g.items.length,0)} 项）</small></h5>${grouped.map(({detail:d,items:members,index})=>`<section class="source-description-group" data-source-description-group><label class="source-description-heading"><input type="checkbox" data-source-select-group="${index}"><strong>${esc(slot)} · ${esc(labels[d.field]||d.field)}</strong><span>${members.length} 项 · ${new Set(members.map(i=>i.config.before.productId)).size} 个链接 · ${new Set(members.map(i=>i.config.id)).size} 套配置</span></label><div class="source-option-change" data-source-description>${sourceComparisonHtml(d.before,d.after)}</div><details class="source-review-members"><summary>查看 ${new Set(members.map(i=>i.config.id)).size} 套配置</summary><div class="source-description-members">${members.map(({config,detail})=>`<label><input type="checkbox" data-source-select value="${esc(detail.key)}" ${selected.has(detail.key)?'checked':''}>${esc(config.product)} · ${esc(config.name)} · ${esc(detail.slot)}（第 ${detail.partIndex+1} 项）</label>`).join('')}</div></details></section>`).join('')}</section>`;
  }).join('')}`:'<p class="hint">当前筛选下没有待确认差异。</p>';
  root.querySelectorAll('[data-source-select]').forEach(el=>{el.onclick=e=>e.stopPropagation();el.onchange=e=>{e.stopPropagation();el.checked?selected.add(el.value):selected.delete(el.value);selection();};});
  root.querySelectorAll('[data-source-select-group]').forEach(el=>{el.onclick=e=>e.stopPropagation();el.onchange=e=>{e.stopPropagation();for(const {detail} of descriptionGroups[Number(el.dataset.sourceSelectGroup)].items)el.checked?selected.add(detail.key):selected.delete(detail.key);root.querySelectorAll('[data-source-select]').forEach(input=>{input.checked=selected.has(input.value);});selection();};});
  const all=$('[data-source-select-all]');if(all){all.onclick=e=>e.stopPropagation();all.onchange=e=>{e.stopPropagation();for(const {detail} of descriptionGroups.flatMap(g=>g.items))all.checked?selected.add(detail.key):selected.delete(detail.key);renderDetails();};}
  $('[data-review-pagination]').innerHTML=`<span>共 ${groupList.length} 组 · 每页 ${pageSize} 组</span><button type="button" data-review-prev ${resultPage===0?'disabled':''}>上一页</button><span>${resultPage+1} / ${pages}</span><button type="button" data-review-next ${resultPage+1===pages?'disabled':''}>下一页</button>`;
  $('[data-review-prev]').onclick=()=>{resultPage--;renderDetails();$('#source-diff').scrollTop=0;};$('[data-review-next]').onclick=()=>{resultPage++;renderDetails();$('#source-diff').scrollTop=0;};
  const clear=$('[data-source-clear]');if(clear)clear.onclick=e=>{e.stopPropagation();selected.clear();renderDetails();};selection();
 }
 function renderScope(){
  const links=new Map(),categories=new Set();let total=0;
  for(const c of preview.changes){links.set(c.before.productId,c.product);for(const d of c.details){categories.add(category(d));total++;}}
  $('[data-pending-count]').textContent=total;
  $('[data-review-link]').innerHTML='<option value="">全部链接</option>'+[...links].map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
  $('[data-review-slot]').innerHTML='<option value="">全部配件</option>'+orderedCategories(categories).map(slot=>`<option>${esc(slot)}</option>`).join('');
  $('[data-review-link]').value=activeLink||'';$('[data-review-slot]').value=activeSlot||'';
  $('#source-diff').innerHTML='<div data-source-groups></div>';renderDetails();
 }
 async function refresh(){
  if(busy)return;invalidate();const token=generation;
  try{if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再查看差异。');await api.flush();if(token!==generation)return;if(api.isEdited())throw Error('输出源有新修改，请先保存。');
   const fields=[...root.querySelectorAll('[data-source-field]:checked')].map(el=>el.dataset.sourceField);
   preview=sourceFollowPlan(api.getConfigs(),api.getRows(),fields,api.shopId());
   renderScope();
   if(!preview.changes.length)message('本店没有需要确认的差异。');
  }catch(e){if(token!==generation)return;invalidate();message(e.message);}
 }
 root.querySelectorAll('[data-source-field]').forEach(el=>el.onchange=()=>refresh());
 root.querySelectorAll('input[name=source-export]').forEach(el=>el.onchange=()=>selection());
 $('#source-check').onclick=()=>refresh();
 $('#source-export-scope').onchange=()=>selection();
 async function exportAll(){
  await api.flush();
  const entries=sourceExportEntries(api.getConfigs(),exportBatch.changes,exportBatch.shopId,$('#source-export-scope').value);
  const task=startImageExportTask({entries,name:`本店输出源更新图片_${Date.now()}`,title:'输出源更新后导图',renderImage:api.renderImage,saveFolder:api.saveFolder,download:api.download,status:text=>message('修改已保存。'+text)});
  return task.done;
 }
 // 自动跟随已完成保存，导出只读取当前配置，不再调用更新接口。
 async function exportAutomatic(changes,{scope,images}){
  if(busy)return;
  try{
   if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再导出图片。');
   lock(true);await api.flush();
   const entries=sourceExportEntries(api.getConfigs(),changes,api.shopId(),scope).filter(e=>images==='both'||e.config.layout===images);
   const task=startImageExportTask({entries,name:`本次变动配置图片_${Date.now()}`,title:'本次变动配置导图',renderImage:api.renderImage,saveFolder:api.saveFolder,download:api.download,status:message});
   await task.done;
  }catch(e){message('导出未完成：'+e.message);}finally{lock(false);}
 }
 async function applySelected(action,{keepAll=false}={}){
  if(busy||!preview||(!keepAll&&!plan?.changes.length))return;
  // 保持全部手动差异直接使用预览字段范围，不依赖已勾选项或当前分类。
  const approved=buildPlan(action,keepAll?manualKeys():[...selected]),auto=action!=='ignore'&&autoExport();if(!approved.changes.length)return;let applied=false;
  try{if(api.isEdited())throw Error('输出源有新修改，请先保存并重新预览');lock(true);await api.apply(approved);applied=true;
   undoRecords=captureBatchRevert(approved,api.getConfigs());$('#source-undo').hidden=false;$('#source-undo').textContent='还原本次修改（一次）';
   exportBatch=action==='ignore'?null:{shopId:approved.shopId,changes:approved.changes.map(c=>({id:c.id,before:{shopId:c.before.shopId,productId:c.before.productId,product:c.before.product,spu:c.before.spu}}))};
   $('#source-export-retry').hidden=!exportBatch;
   if(auto)await exportAll();else message(action==='ignore'?`已保留 ${approved.changes.length} 套配置的${keepAll?'全部待确认':'所选'}手动内容，本次源版本不再提醒。可还原本次修改一次。`:`已更新 ${approved.changes.length} 套配置，所选名称和说明恢复自动跟随，未生成或导出图片。可还原本次修改一次。`);
  }catch(e){message((applied?'修改已保存，导出未完成：':'操作未完成：')+e.message);}finally{const result=$('[data-source-sync-message]').textContent;lock(false);$('#source-undo').disabled=!undoRecords;invalidate();if(applied)await refresh();message(result);}
 }
 $('#source-undo').onclick=async()=>{
  if(busy||!undoRecords)return;
  try{
   if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再还原');
   lock(true);await api.flush();const reversal=batchRevertPlan(undoRecords,api.getConfigs());
   if(reversal.changes.length)await api.apply({...reversal,shopId:undoRecords[0].saved.shopId,sources:[],action:'restore'});
   undoRecords=null;exportBatch=null;$('#source-undo').textContent='本次修改已还原';$('#source-export-retry').hidden=true;
   message('已还原本次修改并保存。已导出的图片保留，需要时请重新生成。');
  }catch(e){message('还原未完成：'+e.message);}finally{const result=$('[data-source-sync-message]').textContent;lock(false);$('#source-undo').disabled=!undoRecords;invalidate();await refresh();message(result);}
 };
 $('#source-apply').onclick=e=>{e.stopPropagation();return applySelected('update');};
 $('#source-keep-all').onclick=e=>{e.stopPropagation();if(!$('#source-keep-all').disabled)return applySelected('ignore',{keepAll:selected.size===0});};
 $('#source-ignore').onclick=e=>{e.stopPropagation();if(!$('#source-ignore').disabled)return applySelected('ignore');};
 $('#source-export-retry').onclick=async()=>{if(busy||!exportBatch)return;try{lock(true);await exportAll();}catch(e){message(e.message);}finally{lock(false);invalidate();}};
 if(api.view){root.classList.add('source-review-standalone');root.querySelector('.source-review-heading h3').textContent=api.view==='automatic'?'本次变动':'待确认差异';switchTab(api.view);}
 if(!api.deferRefresh)queueMicrotask(()=>{if(!api.isEdited())refresh();});
 return {invalidate,refresh,isBusy:()=>busy,showAutomaticChanges:records=>{if(records.length||automatic)(automatic??=mountAutomaticSourceChanges($('[data-source-automatic]'),{shopId:api.shopId,onExport:exportAutomatic})).show(records);const local=records.filter(c=>(c.before.shopId||'intel')===api.shopId());$('[data-auto-count]').textContent=local.reduce((n,c)=>n+c.details.length,0);$('[data-auto-empty]').hidden=local.length>0;if(local.length)switchTab('automatic');},dispose:()=>dialog.removeEventListener('cancel',cancelGuard)};
}
