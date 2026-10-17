/** 输出源差异按配件与描述分组，保留字段选择与手动内容保护。 */
import {sourceExportEntries} from './source-sync-data.js';
import {captureBatchRevert,batchRevertPlan} from './batch-revert.js';
import {startImageExportTask} from './image-export-tasks.js';
import {sourceFollowPlan} from './source-follow.js';
import {slots} from './core.js';
import {mountAutomaticSourceChanges} from './source-auto-follow-view.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'显示名称',tax:'含税核算单价',upgrade:'逐项升级说明'};
export function mountSourceSync(root,api){
 root.classList.add('source-sync-panel');
 root.innerHTML=`<h4>输出源更新与手动内容确认</h4><section class="source-auto-follow-panel" data-source-automatic hidden></section><div class="source-fields">${Object.entries(labels).map(([key,name])=>`<label><input type="checkbox" data-source-field="${key}" checked>${name}</label>`).join('')}</div><p class="hint">保存输出源后，未手改的显示名称和逐项加购说明自动更新；手改内容与无法判断的旧内容保留在此待确认。按配件分类查看，相同字段、当前内容和新内容合为一组，可整组或逐项勾选，也可按链接筛选。含税核算单价仍需手动确认。人工“加购与选配”不变。</p><p class="hint">确认更新后，所选名称和说明恢复自动跟随；再次手改会重新保护。保留手动内容会忽略本次源版本，下次源内容变化再提醒。</p><div class="source-export-choice"><span>更新后生成图片并导出？</span><label><input type="radio" name="source-export" value="no" checked> 否，仅更新配置数据</label><label><input type="radio" name="source-export" value="yes"> 是，生成并导出图片</label></div><div class="source-export-choice"><label>导出范围<select id="source-export-scope"><option value="all">所选链接全部配置图</option><option value="changed" selected>仅本次有变动的配置图</option></select></label><span>含配置清单图和 SKU 图；图片生成后选择保存路径。</span></div><p class="hint">本窗口内可还原最近一次修改一次；已经导出的图片保留。</p><div class="source-sync-actions"><button id="source-check">刷新待确认差异</button><button id="source-apply" class="primary" disabled>确认更新所选项</button><button id="source-ignore" disabled>保留手动内容，忽略本次源版本</button><button id="source-export-retry" hidden>重新保存并导出</button><button id="source-undo" hidden>还原本次修改（一次）</button></div><div id="source-diff"></div><p data-source-sync-message class="hint" role="status"></p>`;
 const $=s=>root.querySelector(s);let preview=null,plan=null,busy=false,exportBatch=null,undoRecords=null,locked=[],activeLink=null,activeSlot=null,allLinks=false,descriptionGroups=[],selected=new Set(),generation=0;
 let automatic;
 const message=text=>{$('[data-source-sync-message]').textContent=text;api.message(text);};
 function invalidate(){generation++;preview=null;plan=null;activeLink=null;activeSlot=null;allLinks=false;descriptionGroups=[];selected.clear();$('#source-apply').disabled=true;$('#source-ignore').disabled=true;$('#source-diff').innerHTML='';}
 const dialog=root.closest('dialog')||root,cancelGuard=e=>{if(root.isConnected&&busy)e.preventDefault();};dialog.addEventListener('cancel',cancelGuard);
 // Captured controls may belong to a retained, detached source draft after a
 // conflict replaces the shared dialog; restore their state before reopening.
 function lock(value){busy=value;if(value){locked=[...dialog.querySelectorAll('input,textarea,select,button')].map(el=>[el,el.disabled]);for(const [el] of locked)el.disabled=true;}else for(const [el,disabled] of locked)el.disabled=disabled;}
 const autoExport=()=>$('input[name=source-export]:checked').value==='yes';
 const category=detail=>detail.slot||'未分类';
 const visibleDetails=config=>config.details.filter(detail=>activeSlot===null||category(detail)===activeSlot);
 const orderedCategories=categories=>[...categories].sort((a,b)=>{const ai=slots.indexOf(a),bi=slots.indexOf(b);return (ai<0?slots.length:ai)-(bi<0?slots.length:bi)||a.localeCompare(b,'zh-CN',{numeric:true});});
 const currentItems=()=>preview?preview.changes.filter(c=>allLinks||c.before.productId===activeLink).flatMap(config=>visibleDetails(config).map(detail=>({config,detail}))):[];
 function buildPlan(action='update'){return sourceFollowPlan(preview.changes.map(c=>c.before),preview.sources,preview.fields,preview.shopId,{keys:[...selected],action});}
 function selection(){
  if(!preview)return;
  plan=buildPlan();const count=plan.changes.reduce((n,c)=>n+c.details.length,0),hasTax=preview.changes.some(c=>c.details.some(d=>selected.has(d.key)&&d.field==='tax'));
  $('#source-apply').disabled=busy||!count;$('#source-ignore').disabled=busy||!count||hasTax;
  const all=$('[data-source-select-all]'),items=currentItems();if(all){const n=items.filter(i=>selected.has(i.detail.key)).length;all.checked=items.length>0&&n===items.length;all.indeterminate=n>0&&n<items.length;}
  root.querySelectorAll('[data-source-select-group]').forEach(el=>{const group=descriptionGroups[Number(el.dataset.sourceSelectGroup)],n=group.items.filter(i=>selected.has(i.detail.key)).length;el.checked=n===group.items.length;el.indeterminate=n>0&&n<group.items.length;});
  const hidden=count-items.filter(i=>selected.has(i.detail.key)).length;
  message(`已选择 ${count} 项，涉及 ${plan.changes.length} 套配置。${hidden?`其中 ${hidden} 项在其他链接或配件分类中。`:''}${hasTax?'含核算单价，不能忽略源版本。':'未勾选的内容继续保留。'}${count&&autoExport()?`确认更新后生成并导出 ${sourceExportEntries(api.getConfigs(),plan.changes,preview.shopId,$('#source-export-scope').value).length} 张图片。`:''}`);
 }
 function renderDetails(){
  const items=currentItems(),groups=new Map();
  for(const item of items){const d=item.detail,slot=category(d),key=JSON.stringify([slot,d.field,d.before,d.after]);if(!groups.has(key))groups.set(key,{slot,detail:d,items:[]});groups.get(key).items.push(item);}
  descriptionGroups=[...groups.values()];
  const categories=orderedCategories(new Set(items.map(i=>category(i.detail))));
  root.querySelectorAll('[data-source-link]').forEach(el=>{const active=!allLinks&&el.dataset.sourceLink===String(activeLink);el.setAttribute('aria-pressed',String(active));el.classList.toggle('primary',active);});
  const allButton=$('[data-source-all-links]');allButton.setAttribute('aria-pressed',String(allLinks));allButton.classList.toggle('primary',allLinks);
  const value=v=>esc(v===''||v==null?'（空）':v);
  const scope=allLinks?'全部链接':'当前链接';
  $('[data-source-groups]').innerHTML=items.length?`<div class="source-selection-actions"><label><input type="checkbox" data-source-select-all>选择${scope}${activeSlot===null?'全部字段':'此分类全部字段'}</label><button data-source-clear>取消全部字段选择</button></div>${categories.map(slot=>{
   const grouped=descriptionGroups.map((group,index)=>({...group,index})).filter(group=>group.slot===slot);
   return `<section class="source-part-group" data-source-part-group="${esc(slot)}"><h5>${esc(slot)} <small>（${grouped.length} 组描述 · ${grouped.reduce((n,g)=>n+g.items.length,0)} 项）</small></h5>${grouped.map(({detail:d,items:members,index})=>`<section class="source-description-group" data-source-description-group><label class="source-description-heading"><input type="checkbox" data-source-select-group="${index}"><strong>${esc(labels[d.field]||d.field)}</strong><span>选择本组（${members.length} 项 · ${new Set(members.map(i=>i.config.before.productId)).size} 个链接 · ${new Set(members.map(i=>i.config.id)).size} 套配置）</span></label><div class="source-option-change" data-source-description><span>当前内容：${value(d.before)}</span><span>输出源新内容：${value(d.after)}</span></div><div class="source-description-members">${members.map(({config,detail})=>`<label><input type="checkbox" data-source-select value="${esc(detail.key)}" ${selected.has(detail.key)?'checked':''}>${esc(config.product)} · ${esc(config.name)} · ${esc(detail.slot)}（第 ${detail.partIndex+1} 项）</label>`).join('')}</div></section>`).join('')}</section>`;
  }).join('')}`:'<p class="hint">点击配件分类或链接查看描述分组；字段默认不选中。</p>';
  root.querySelectorAll('[data-source-select]').forEach(el=>{el.onclick=e=>e.stopPropagation();el.onchange=e=>{e.stopPropagation();el.checked?selected.add(el.value):selected.delete(el.value);selection();};});
  root.querySelectorAll('[data-source-select-group]').forEach(el=>{el.onclick=e=>e.stopPropagation();el.onchange=e=>{e.stopPropagation();for(const {detail} of descriptionGroups[Number(el.dataset.sourceSelectGroup)].items)el.checked?selected.add(detail.key):selected.delete(detail.key);root.querySelectorAll('[data-source-select]').forEach(input=>{input.checked=selected.has(input.value);});selection();};});
  const all=$('[data-source-select-all]');if(all){all.onclick=e=>e.stopPropagation();all.onchange=e=>{e.stopPropagation();for(const {detail} of currentItems())all.checked?selected.add(detail.key):selected.delete(detail.key);renderDetails();};}
  const clear=$('[data-source-clear]');if(clear)clear.onclick=e=>{e.stopPropagation();selected.clear();renderDetails();};selection();
 }
 function renderScope(){
  const counts=new Map(),links=new Map();let total=0;
  for(const c of preview.changes){
   for(const d of c.details){const slot=category(d);counts.set(slot,(counts.get(slot)||0)+1);total++;}
   const details=visibleDetails(c);if(!details.length)continue;
   const id=c.before.productId;if(!links.has(id))links.set(id,{name:c.product,count:0});links.get(id).count+=details.length;
  }
  if(!links.has(activeLink))activeLink=null;
  const categories=[null,...orderedCategories(counts.keys())];
  $('#source-diff').innerHTML=`<div class="source-category-filter" role="group" aria-label="按配件分类"><strong>配件分类</strong><div class="source-category-buttons">${categories.map((slot,index)=>`<button type="button" data-source-category="${index}" aria-pressed="${slot===activeSlot}" class="${slot===activeSlot?'primary':''}">${esc(slot??'全部配件')}（${slot===null?total:counts.get(slot)} 项）</button>`).join('')}</div></div><p class="hint">${activeSlot===null?'全部配件':esc(activeSlot)}：${links.size} 个链接有待确认差异，按相同描述分组，可按链接缩小范围。</p><div class="source-scope-links"><button type="button" data-source-all-links aria-pressed="false">全部链接（${[...links.values()].reduce((n,link)=>n+link.count,0)} 项）</button>${[...links].map(([id,link])=>`<button type="button" data-source-link="${esc(id)}" aria-pressed="false">${esc(link.name)}（${link.count} 项）</button>`).join('')}</div><div data-source-groups></div>`;
  root.querySelectorAll('[data-source-category]').forEach(el=>el.onclick=e=>{e.stopPropagation();activeSlot=categories[Number(el.dataset.sourceCategory)];allLinks=true;activeLink=null;renderScope();});
  $('[data-source-all-links]').onclick=e=>{e.stopPropagation();allLinks=true;activeLink=null;renderDetails();};
  root.querySelectorAll('[data-source-link]').forEach(el=>el.onclick=e=>{e.stopPropagation();allLinks=false;activeLink=[...links.keys()].find(id=>String(id)===el.dataset.sourceLink);renderDetails();});renderDetails();
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
 async function applySelected(action){
  if(busy||!preview||!plan?.changes.length)return;
  const approved=buildPlan(action),auto=action!=='ignore'&&autoExport();if(!approved.changes.length)return;let applied=false;
  try{if(api.isEdited())throw Error('输出源有新修改，请先保存并重新预览');lock(true);await api.apply(approved);applied=true;
   undoRecords=captureBatchRevert(approved,api.getConfigs());$('#source-undo').hidden=false;$('#source-undo').textContent='还原本次修改（一次）';
   exportBatch=action==='ignore'?null:{shopId:approved.shopId,changes:approved.changes.map(c=>({id:c.id,before:{shopId:c.before.shopId,productId:c.before.productId,product:c.before.product,spu:c.before.spu}}))};
   $('#source-export-retry').hidden=!exportBatch;
   if(auto)await exportAll();else message(action==='ignore'?`已保留 ${approved.changes.length} 套配置的所选手动内容，本次源版本不再提醒。可还原本次修改一次。`:`已更新 ${approved.changes.length} 套配置，所选名称和说明恢复自动跟随，未生成或导出图片。可还原本次修改一次。`);
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
 $('#source-ignore').onclick=e=>{e.stopPropagation();if(!$('#source-ignore').disabled)return applySelected('ignore');};
 $('#source-export-retry').onclick=async()=>{if(busy||!exportBatch)return;try{lock(true);await exportAll();}catch(e){message(e.message);}finally{lock(false);invalidate();}};
 queueMicrotask(()=>{if(!api.isEdited())refresh();});
 return {invalidate,refresh,showAutomaticChanges:records=>{if(records.length||automatic)(automatic??=mountAutomaticSourceChanges($('[data-source-automatic]'),{shopId:api.shopId})).show(records);},dispose:()=>dialog.removeEventListener('cancel',cancelGuard)};
}
