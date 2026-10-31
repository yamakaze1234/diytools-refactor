import {captureBatchRevert,batchRevertPlan} from './batch-revert.js';
import {imageFolderName,imageConfigFilename} from './image-export-order.js';
/** 跨链接批量配件维护：查询使用范围、预览替换及文案调整，并导出修改后的图片。 */
import {markSourceFieldManual} from './source-follow.js';
import {mountProductSearch} from './product-search.js';
import {clone,productGroups} from './core.js';
import {replaceSourcePart} from './source.js';
import {actualParts,syncActualParts} from './actual-parts.js';
import {startImageExportTask} from './image-export-tasks.js';

const key=p=>String(p.goodsId||'').trim()&&String(p.goodsId)!=='0'?`id:${p.goodsId}`:`name:${p.name}`;
/** 汇总配件在配置中的使用情况，供批量操作选择范围。 */
export function partUsageSummary(configs,query='',slot=''){
 const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean),groups=new Map();
 for(const c of configs.filter(c=>!c.deletedAt))for(const p of c.parts||[]){
  if(!p.name||slot&&p.slot!==slot)continue;
  const haystack=[p.name,p.goodsId,p.slot,c.product,c.spu,c.name].join(' ').toLowerCase();
  if(!tokens.every(token=>haystack.includes(token)))continue;
  const id=key(p);if(!groups.has(id))groups.set(id,{key:id,name:p.name,goodsId:p.goodsId,slots:new Set(),configs:new Set(),products:new Set(),occurrences:[]});
  const item=groups.get(id);item.slots.add(p.slot);item.configs.add(c.id);item.products.add(c.productId);item.occurrences.push({configId:c.id,slot:p.slot});
 }
 return [...groups.values()].map(item=>({key:item.key,name:item.name,goodsId:item.goodsId,slots:[...item.slots],count:item.configs.size,linkCount:item.products.size,occurrences:item.occurrences})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
}
const matchesUpgrade=(part,query)=>String(part.upgrade||'').toLowerCase().includes(query.trim().toLowerCase());
export function findPartUsage(configs,query,descriptionQuery='',slot='',showAll=false){
 const q=query.trim().toLowerCase(),found=new Map();if(!q&&!descriptionQuery.trim()&&!slot&&!showAll)return [];
 for(const c of configs.filter(c=>!c.deletedAt))for(const p of c.parts){if(!p.name||(slot&&p.slot!==slot)||![p.name,p.goodsId].some(v=>String(v||'').toLowerCase().includes(q))||!matchesUpgrade(p,descriptionQuery))continue;const k=key(p);if(!found.has(k))found.set(k,{key:k,goodsId:p.goodsId,name:p.name,ids:new Set()});found.get(k).ids.add(c.id);}
 return [...found.values()].map(r=>({...r,count:r.ids.size,ids:undefined}));
}
const selectedPart=(part,partKeys,slot='')=>(Array.isArray(partKeys)?partKeys:[partKeys]).includes(key(part))&&(!slot||part.slot===slot);
const inUsageScope=(config,part,occurrences)=>!occurrences||occurrences.some(item=>item.configId===config.id&&item.slot===part.slot);
export function usageGroups(configs,partKey,descriptionQuery='',occurrences=null,slot=''){return productGroups(configs.filter(c=>!c.deletedAt)).map(g=>({...g,matches:g.configs.filter(c=>c.parts.some(p=>selectedPart(p,partKey,slot)&&matchesUpgrade(p,descriptionQuery)&&inUsageScope(c,p,occurrences)))})).filter(g=>g.matches.length);}
/** 按所选链接及出现位置生成替换计划，预览阶段不修改原配置。 */
export function replacementPlan(configs,partKey,productIds,replacement,qty,occurrences=null){
 if(!replacement||replacement.deletedAt)throw Error('请选择新的配件');if(qty!==null&&(!Number.isInteger(qty)||qty<1))throw Error('数量必须是正整数，留空则保留原数量');
 const groups=usageGroups(configs,partKey,'',occurrences).filter(g=>productIds.includes(g.id)),changes=[];
 for(const g of groups)for(const c of g.matches){const after=clone(c);for(let i=0;i<after.parts.length;i++)if(key(after.parts[i])===partKey&&inUsageScope(c,after.parts[i],occurrences)){replaceSourcePart(after,i,replacement);if(qty!==null)after.parts[i].qty=qty;}syncActualParts(after,c.parts);if(JSON.stringify(c)!==JSON.stringify(after))changes.push({id:c.id,productId:g.id,name:c.name,product:g.name,before:clone(c),after});}
 return {changes,productIds:groups.map(g=>g.id),replacement:clone(replacement),partKey};
}
/** 应用前核验计划中的旧配件仍与当前配置一致。 */
export function validateReplacement(plan,configs){
 const byId=new Map(configs.map(c=>[c.id,c]));
 return plan.changes.map(change=>{const c=byId.get(change.id);if(!c||JSON.stringify(c)!==JSON.stringify(change.before))throw Error('配置已变化，请重新预览');return c;});
}
/** 仅修改已核验计划指向的配置和配件。 */
export function applyReplacement(plan,configs){
 const targets=validateReplacement(plan,configs);
 targets.forEach((c,i)=>Object.assign(c,clone(plan.changes[i].after)));return targets.map(c=>c.id);
}
export function upgradeDescriptionPlan(configs,partKey,productIds,description,descriptionQuery='',slot=''){
 if(!partKey||(Array.isArray(partKey)&&!partKey.length))throw Error('请选择原配件');
 const groups=usageGroups(configs,partKey,descriptionQuery,null,slot).filter(g=>productIds.includes(g.id)),changes=[];
 for(const g of groups)for(const c of g.matches){
  const after=clone(c);
  for(const part of after.parts)if(selectedPart(part,partKey,slot)&&matchesUpgrade(part,descriptionQuery)&&part.upgrade!==description){part.upgrade=description;markSourceFieldManual(part,'upgrade');}
  if(JSON.stringify(c)!==JSON.stringify(after))changes.push({id:c.id,productId:g.id,name:c.name,product:g.name,before:clone(c),after});
 }
 return {changes,partKey,productIds:groups.map(g=>g.id),description};
}
export function displayNamePlan(configs,partKey,productIds,displayName){
 if(!partKey)throw Error('请选择原配件');
 const name=displayName.trim();if(name.length>200)throw Error('展示名称不能超过 200 个字符');
 const groups=usageGroups(configs,partKey).filter(g=>productIds.includes(g.id)),changes=[];
 for(const g of groups)for(const c of g.matches){const after=clone(c);for(const part of after.parts)if(key(part)===partKey){const before=part.displayName||'';if(!name||name===part.name)delete part.displayName;else part.displayName=name;if(before!==(part.displayName||''))markSourceFieldManual(part,'name');}if(JSON.stringify(c)!==JSON.stringify(after))changes.push({id:c.id,productId:g.id,name:c.name,product:g.name,before:clone(c),after});}
 return {changes,partKey,productIds:groups.map(g=>g.id),displayName:name};
}
/** 各任务按同一份原始配置匹配，合并为一次保存，重叠目标不得写入不同文案。 */
export function upgradeDescriptionTasksPlan(configs,tasks){
 if(!tasks.length)throw Error('请先添加修改任务');
 const changes=new Map(),targets=new Map();
 for(const [index,task] of tasks.entries()){
  const label=`任务 ${index+1}`;
  if(!task.partKeys?.length)throw Error(`${label}：请选择原配件`);
  if(!task.productIds?.length)throw Error(`${label}：请选择影响的链接`);
  const configIds=task.configIds?new Set(task.configIds):null;
  const groups=usageGroups(configIds?configs.filter(c=>configIds.has(c.id)):configs,task.partKeys,task.descriptionQuery||'',null,task.slot||'').filter(g=>task.productIds.includes(g.id));
  if(!groups.length)throw Error(`${label}：当前范围没有匹配配置，请重新选择配件或链接`);
  for(const group of groups)for(const config of group.matches){
   if(!changes.has(config.id))changes.set(config.id,{id:config.id,productId:group.id,product:group.name,name:config.name,before:clone(config),after:clone(config)});
   const change=changes.get(config.id);
   for(const [partIndex,part] of config.parts.entries()){
    if(!selectedPart(part,task.partKeys,task.slot||'')||!matchesUpgrade(part,task.descriptionQuery||''))continue;
    const target=JSON.stringify([config.id,partIndex]),previous=targets.get(target);
    if(previous&&previous.description!==task.description)throw Error(`${previous.label} 与 ${label} 的描述冲突：${group.name} / ${config.name} / ${part.slot}，请保留一种描述`);
    targets.set(target,{label,description:task.description});
    if(part.upgrade!==task.description){const updated=change.after.parts[partIndex];updated.upgrade=task.description;markSourceFieldManual(updated,'upgrade');}
   }
  }
 }
 const rows=[...changes.values()].filter(c=>JSON.stringify(c.before)!==JSON.stringify(c.after));
 return {changes:rows,productIds:[...new Set(rows.map(c=>c.productId))],taskCount:tasks.length};
}
export function openUpgradeDescriptionBatch(api){
 const {openDialog,apply,esc}=api,isName=api.field==='displayName';
 const getConfigs=(scope=$('#upgrade-batch-scope')?.value)=>api.getConfigs().filter(c=>!c.deletedAt&&(!api.productId||(scope==='selected'?(api.getSelectedIds?.()||[]).includes(c.id):c.productId===api.productId)));
 const descriptionQuery=()=>isName?'':$('#upgrade-batch-description-query').value;
 openDialog(isName?'批量修改配件展示名称':api.productId?'批量修改加购描述':'批量修改全店加购说明',`${api.productId?'<label class="field">修改范围<select id="upgrade-batch-scope"><option value="link">当前链接全部配置</option><option value="selected">勾选配置（本店，可跨链接）</option></select></label>':''}<p class="hint">按配件或加购描述查找，只修改范围内符合搜索条件的逐项升级说明。手动添加的“加购与选配”、实际配置和输出源均保留。</p><label class="field">查找原配件<input id="upgrade-batch-query" placeholder="输入配件名称或 ERP ID"></label><label class="field">只搜索加购描述<input id="upgrade-batch-description-query" placeholder="输入逐项升级说明关键词，可单独搜索"></label><div id="upgrade-batch-candidates" class="global-list"></div><div id="upgrade-batch-work" class="hidden"><details open><summary>选择影响的链接</summary><label class="global-all"><input id="upgrade-batch-all" type="checkbox" checked> 全选关联链接</label><div id="upgrade-batch-links" class="global-list"></div></details><label class="field">新的配件加购描述<textarea id="upgrade-batch-text" rows="3" placeholder="留空可清除所选配件的说明"></textarea></label><label class="global-export"><input id="upgrade-batch-export" type="checkbox"> 保存后导出对应修改链接的配置清单图和 SKU 图</label><label class="field">导出范围<select id="upgrade-batch-export-scope"><option value="all">所选链接全部配置</option><option value="changed">仅本次有变动的配置</option></select></label><p class="hint">每套导出配置图和 SKU 图，保留各套主题；桌面版保存到文件夹，网页版下载 ZIP。</p><div class="actions"><button id="upgrade-batch-preview">预览修改</button><button id="upgrade-batch-apply" class="primary" disabled>应用修改</button></div><details id="upgrade-batch-diff-details"><summary>查看修改明细</summary><pre id="upgrade-batch-diff"></pre></details></div><p id="upgrade-batch-status" role="status"></p><button id="upgrade-batch-retry" class="hidden">导出刚修改的链接图片</button><button id="upgrade-batch-undo" class="hidden">一键还原本次修改</button>`);
 api.render?.({hasScope:Boolean(api.productId),multiTask:!isName});
 const $=s=>document.querySelector(s);
 if(isName){
 $('#upgrade-batch-description-query').closest('label').remove();
 ($('#upgrade-batch-hint')||$('#upgrade-batch-query').closest('label').previousElementSibling).textContent='按原配件名称或 ERP ID 查找，只修改所选配件的展示名称，用于配置图；留空恢复原配件名称。原配件、实际配置、加购描述和输出源均保留。';
 const input=$('#upgrade-batch-text');input.closest('label').firstChild.textContent='新的配件展示名称';input.placeholder='留空恢复原配件名称';input.maxLength=200;input.rows=2;
 }else if(api.openDisplayNames){const button=document.createElement('button');button.type='button';button.id='upgrade-batch-display-names';button.textContent='批量修改配件展示名称';button.onclick=api.openDisplayNames;const shortcuts=$('#upgrade-batch-shortcuts');if(shortcuts)shortcuts.append(button);else $('#upgrade-batch-query').closest('label').before(button);}
 let partKey='',selectedParts=new Set(),plan=null,busy=false,exportIds=null,changedConfigIds=null,undoRecords=null;
 let tasks=[{partKeys:[],productIds:[],description:'',query:'',descriptionQuery:'',slot:'',scope:'link',names:[]}],taskIndex=0;
 const root=$('#upgrade-batch-status'),dialog=root.closest('dialog'),status=text=>{if(root.isConnected)root.textContent=text;};dialog.classList.add('global-batch-dialog');
 const changedLinks=plan=>[...new Set(plan.changes.map(change=>change.productId))];
 let lockedControls=[];
 const lock=value=>{busy=value;if(value){lockedControls=[...dialog.querySelectorAll('input,textarea,select,button')].map(el=>({el,disabled:el.disabled}));lockedControls.forEach(({el})=>el.disabled=true);}else{lockedControls.forEach(({el,disabled})=>{if(el.isConnected)el.disabled=disabled;});lockedControls=[];}};
 const controller=new AbortController();dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();},{signal:controller.signal});dialog.addEventListener('close',()=>{controller.abort();dialog.classList.remove('global-batch-dialog');},{once:true,signal:controller.signal});
 const exportOptions=ids=>({configIds:$('#upgrade-batch-export-scope').value==='changed'?ids:null});
 const exportImages=()=>exportBatchImages(api,exportIds,status,exportOptions(changedConfigIds));
 const invalidate=()=>{plan=null;$('#upgrade-batch-apply').disabled=true;$('#upgrade-batch-diff').textContent='';};
 const updateAll=()=>{const rows=[...dialog.querySelectorAll('[data-upgrade-link]')],count=rows.filter(el=>el.checked).length;$('#upgrade-batch-all').checked=rows.length>0&&count===rows.length;$('#upgrade-batch-all').indeterminate=count>0&&count<rows.length;invalidate();};
 $('#upgrade-batch-all').onchange=()=>{dialog.querySelectorAll('[data-upgrade-link]').forEach(el=>el.checked=$('#upgrade-batch-all').checked);updateAll();};
 const slot=()=>isName?'':$('#upgrade-batch-slot').value;
 if(!isName){
  const slots=[...new Set(getConfigs().flatMap(c=>(c.parts||[]).map(p=>p.slot)).filter(Boolean))];
  $('#upgrade-batch-query').closest('label').before(Object.assign(document.createElement('label'),{className:'field',innerHTML:`配件类型<select id="upgrade-batch-slot"><option value="">全部配件类型</option>${slots.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>`}));
 }
 const renderLinks=()=>{
  const previous=[...dialog.querySelectorAll('[data-upgrade-link]')],unchecked=new Set(previous.filter(el=>!el.checked).map(el=>el.value));
  const groups=usageGroups(getConfigs(),isName?partKey:[...selectedParts],descriptionQuery(),null,slot());
  $('#upgrade-batch-links').innerHTML=groups.map(g=>`<label><input type="checkbox" data-upgrade-link value="${esc(g.id)}" ${unchecked.has(g.id)?'':'checked'}><span><strong>${esc(g.name)}</strong><small>SPU ${esc(g.spu||'未绑定')} · ${g.matches.length}/${g.configs.length} 套命中</small><details><summary>查看配置</summary>${g.matches.map(c=>`<small>${esc(c.shortName||c.name)}</small>`).join('')}</details></span></label>`).join('');
  $('#upgrade-batch-work').classList.toggle('hidden',!groups.length);
  dialog.querySelectorAll('[data-upgrade-link]').forEach(input=>input.onchange=updateAll);updateAll();
  status(isName?`已找到 ${groups.length} 个链接`:`任务 ${taskIndex+1}：已选择 ${selectedParts.size} 种配件，涉及 ${groups.length} 个链接`);
  if(!isName){captureTask();renderTasks();}
 };
 const listParts=(restored=null)=>{
  invalidate();selectedParts=new Set(restored?.partKeys||[]);partKey='';$('#upgrade-batch-links').innerHTML='';$('#upgrade-batch-work').classList.add('hidden');
  const rows=findPartUsage(getConfigs(),$('#upgrade-batch-query').value,descriptionQuery(),slot(),!isName);
  if(isName){
   $('#upgrade-batch-candidates').innerHTML=rows.slice(0,80).map((r,i)=>`<button data-upgrade-part="${i}"><strong>${esc(r.name)}</strong><small>ERP ID ${esc(r.goodsId||'无')} · ${r.count} 套配置</small></button>`).join('');
   dialog.querySelectorAll('[data-upgrade-part]').forEach(button=>button.onclick=()=>{const row=rows[Number(button.dataset.upgradePart)];partKey=row.key;$('#upgrade-batch-candidates').innerHTML=`<p class="hint">原配件：${esc(row.name)} · ${esc(row.goodsId||'无 ERP ID')}</p>`;renderLinks();});
  }else{
   // 不截断筛选结果，确保“全选”包含当前类型和搜索条件下的全部配件。
   $('#upgrade-batch-candidates').innerHTML=`<label class="global-all"><input id="upgrade-batch-parts-all" type="checkbox" ${rows.length?'':'disabled'}> 全选筛选结果（${rows.length} 种配件）</label><div style="max-height:280px;overflow:auto">${rows.map((r,i)=>`<label><input type="checkbox" data-upgrade-part="${i}" ${selectedParts.has(r.key)?'checked':''}><span><strong>${esc(r.name)}</strong><small>ERP ID ${esc(r.goodsId||'无')} · ${r.count} 套配置</small></span></label>`).join('')}</div>`;
   const updateParts=()=>{const all=$('#upgrade-batch-parts-all');all.checked=rows.length>0&&selectedParts.size===rows.length;all.indeterminate=selectedParts.size>0&&selectedParts.size<rows.length;renderLinks();};
   dialog.querySelectorAll('[data-upgrade-part]').forEach(input=>input.onchange=()=>{const key=rows[Number(input.dataset.upgradePart)].key;if(input.checked)selectedParts.add(key);else selectedParts.delete(key);updateParts();});
   $('#upgrade-batch-parts-all').onchange=event=>{selectedParts=new Set(event.target.checked?rows.map(r=>r.key):[]);dialog.querySelectorAll('[data-upgrade-part]').forEach(el=>el.checked=event.target.checked);updateParts();};
   if(restored){updateParts();dialog.querySelectorAll('[data-upgrade-link]').forEach(el=>el.checked=restored.productIds.includes(el.value));updateAll();}
  }
  status(rows.length?(isName?'选择要修改展示名称的原配件':`找到 ${rows.length} 种配件，可多选；切换筛选条件会清空本任务的选择`):'没有匹配配件');
  if(!isName&&!restored){captureTask();renderTasks();}
 };
 // 任务切换只保存弹窗草稿；预览和应用仍统一走原有保存与还原流程。
 function captureTask(){
  if(isName)return;
  tasks[taskIndex]={partKeys:[...selectedParts],productIds:[...dialog.querySelectorAll('[data-upgrade-link]:checked')].map(el=>el.value),description:$('#upgrade-batch-text').value,query:$('#upgrade-batch-query').value,descriptionQuery:descriptionQuery(),slot:slot(),scope:$('#upgrade-batch-scope')?.value||'link',names:[...dialog.querySelectorAll('[data-upgrade-part]:checked')].map(el=>el.closest('label').querySelector('strong')?.textContent||'')};
 }
 function renderTasks(){
  if(isName)return;
  $('#upgrade-batch-task-list').innerHTML=tasks.map((task,i)=>`<div class="upgrade-task"><button type="button" data-upgrade-task="${i}" aria-pressed="${i===taskIndex}"><strong>任务 ${i+1} · ${task.names[0]?esc(task.names[0]):'选择配件'}${task.partKeys.length>1?' 等 '+task.partKeys.length+' 种':''}${i===taskIndex?' · 编辑中':''}</strong><small>${task.partKeys.length?(task.description?esc(task.description):'清除加购描述'):'选择配件并填写对应描述'}</small></button><button type="button" data-upgrade-task-delete="${i}" aria-label="删除任务 ${i+1}" ${tasks.length===1?'disabled':''}>×</button></div>`).join('');
  dialog.querySelectorAll('[data-upgrade-task]').forEach(el=>el.onclick=()=>{if(busy)return;captureTask();loadTask(Number(el.dataset.upgradeTask));});
  dialog.querySelectorAll('[data-upgrade-task-delete]').forEach(el=>el.onclick=()=>{if(busy||tasks.length===1)return;captureTask();const index=Number(el.dataset.upgradeTaskDelete);tasks.splice(index,1);loadTask(Math.min(index<taskIndex?taskIndex-1:taskIndex,tasks.length-1));});
 }
 function loadTask(index){
  taskIndex=index;const draft=structuredClone(tasks[index]);
  $('#upgrade-batch-query').value=draft.query;$('#upgrade-batch-description-query').value=draft.descriptionQuery;$('#upgrade-batch-slot').value=draft.slot;$('#upgrade-batch-text').value=draft.description;
  if(api.productId)$('#upgrade-batch-scope').value=draft.scope;
  listParts(draft);captureTask();renderTasks();
 }
 if(!isName){
  let section=$('#upgrade-batch-tasks');
  if(!section){section=document.createElement('section');section.id='upgrade-batch-tasks';$('#upgrade-batch-query').closest('label').before(section);}
  section.innerHTML='<div class="actions"><strong>修改任务</strong><button type="button" id="upgrade-batch-add-task">＋ 添加修改任务</button></div><p class="hint">每条任务分别选择配件和填写描述，切换任务保留已填内容，最后统一预览与保存。空描述会清除对应加购说明。</p><div id="upgrade-batch-task-list"></div>';
  $('#upgrade-batch-add-task').onclick=()=>{if(busy)return;captureTask();tasks.push({partKeys:[],productIds:[],description:'',query:'',descriptionQuery:'',slot:'',scope:$('#upgrade-batch-scope')?.value||'link',names:[]});loadTask(tasks.length-1);};
  $('#upgrade-batch-preview').textContent='预览全部任务';$('#upgrade-batch-apply').textContent='应用全部修改';renderTasks();
 }
 $('#upgrade-batch-query').oninput=()=>listParts();
 if(!isName){$('#upgrade-batch-description-query').oninput=()=>listParts();$('#upgrade-batch-slot').onchange=()=>listParts();}
 if(api.productId)$('#upgrade-batch-scope').onchange=()=>listParts();
 $('#upgrade-batch-text').oninput=()=>{invalidate();if(!isName){captureTask();renderTasks();}};
 $('#upgrade-batch-export').onchange=invalidate;
 $('#upgrade-batch-export-scope').onchange=invalidate;
 $('#upgrade-batch-preview').onclick=()=>{try{
  $('#upgrade-batch-diff-details').open=true;
  if(isName)plan=displayNamePlan(getConfigs(),partKey,[...dialog.querySelectorAll('[data-upgrade-link]:checked')].map(input=>input.value),$('#upgrade-batch-text').value);
  else{captureTask();plan=upgradeDescriptionTasksPlan(api.getConfigs(),tasks.map(task=>({...task,configIds:getConfigs(task.scope).map(c=>c.id)})));}
  $('#upgrade-batch-diff').textContent=plan.changes.map(change=>{const lines=change.before.parts.flatMap((part,index)=>{const after=change.after.parts[index];return isName?(part.displayName||part.name)!==(after.displayName||after.name)?[`${part.slot}：${part.displayName||part.name} → ${after.displayName||after.name}`]:[]:part.upgrade!==after.upgrade?[`${part.slot} · ${part.name}：${part.upgrade||'（空）'} → ${after.upgrade||'（空）'}`]:[];});return `${change.product} / ${change.name}\n${lines.join('\n')}`;}).join('\n\n');
  $('#upgrade-batch-apply').disabled=!plan.changes.length;
  const count=$('#upgrade-batch-export').checked?exportEntries(api.getConfigs(),changedLinks(plan),'both',exportOptions(plan.changes.map(c=>c.id))).length:0;
  status(`${isName?'':tasks.length+' 条任务，'}将修改 ${plan.changes.length} 套配置${count?`，导出 ${changedLinks(plan).length} 个链接，共 ${count} 张图片`:''}`);
 }catch(e){invalidate();status(e.message);}};
 $('#upgrade-batch-apply').onclick=async()=>{
  if(!plan||busy)return;const approved=plan,auto=$('#upgrade-batch-export').checked;let saved=false;
  try{if(auto)exportEntries(api.getConfigs(),changedLinks(approved),'both',exportOptions(approved.changes.map(c=>c.id)));validateReplacement(approved,isName?getConfigs():api.getConfigs());lock(true);status(`正在保存 ${approved.changes.length} 套配置…`);await apply(approved);saved=true;exportIds=changedLinks(approved);changedConfigIds=approved.changes.map(c=>c.id);undoRecords=captureBatchRevert(approved,api.getConfigs());$('#upgrade-batch-undo').classList.remove('hidden');$('#upgrade-batch-undo').textContent='一键还原本次修改';plan=null;$('#upgrade-batch-retry').classList.remove('hidden');if(auto){lock(false);await exportImages();}else status(`已保存 ${approved.changes.length} 套配置，可继续修改、单次还原或导出图片。`);}
  catch(e){status((saved?'修改已保存，导出未完成：':'修改未完成：')+e.message);}
  finally{lock(false);if(root.isConnected){invalidate();$('#upgrade-batch-undo').disabled=!undoRecords;}}
 };
 $('#upgrade-batch-undo').onclick=async()=>{
  if(busy||!undoRecords)return;
  try{lock(true);const reversal=batchRevertPlan(undoRecords,api.getConfigs());if(reversal.changes.length)await apply(reversal);undoRecords=null;status('已还原本次批量修改并保存，可继续修改或导出图片。');$('#upgrade-batch-undo').textContent='本次修改已还原';}
  catch(error){status('还原未完成：'+error.message);}
  finally{lock(false);if(root.isConnected){invalidate();$('#upgrade-batch-undo').disabled=!undoRecords;}}
 };
 $('#upgrade-batch-retry').onclick=async()=>{if(busy||!exportIds)return;try{await exportImages();}catch(e){status('修改已保存，导出未完成：'+e.message);}finally{lock(false);if(root.isConnected)invalidate();}};

 if(!isName)listParts();
}
export function replacementDiff(plan){
 return plan.changes.map(change=>{
  const rows=[];
  for(const before of change.before.parts.filter(part=>key(part)===plan.partKey)){
   const after=change.after.parts.find(part=>part.slot===before.slot);
   if(JSON.stringify(before)===JSON.stringify(after))continue;
   rows.push(`展示配件 · ${before.slot}：${before.name} ×${before.qty} → ${after.name} ×${after.qty}`);
   const actualBefore=actualParts(change.before).find(part=>part.slot===before.slot);
   const actualAfter=actualParts(change.after).find(part=>part.slot===before.slot);
   if(JSON.stringify(actualBefore)!==JSON.stringify(actualAfter))rows.push(`实际配置 · ${before.slot}：${actualBefore?.name||'空'} ×${actualBefore?.qty||0} → ${actualAfter?.name||'空'} ×${actualAfter?.qty||0}`);
  }
  if(JSON.stringify(change.before.addons)!==JSON.stringify(change.after.addons))rows.push('关联加购：'+((change.before.addons||[]).map(a=>a.text).join('；')||'无')+' → '+((change.after.addons||[]).map(a=>a.text).join('；')||'无'));
  return `${change.product} / ${change.name}\n${rows.join('\n')}`;
 }).join('\n\n');
}
const safe=s=>String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,90)||'未命名';
/** 根据图片种类和链接范围列出导出任务，并按需处理重复文件名。 */
export function exportEntries(configs,productIds,imageKind='both',{configIds=null}={}){
 // 先按完整链接编号再筛选，增量导图与全量导图使用同一个文件名。
 const selected=configIds===null?null:new Set(configIds);
 const layouts=imageKind==='both'?['long','square']:['long','square'].includes(imageKind)?[imageKind]:null;
 if(!layouts)throw Error('请选择配置图、SKU 图或两者');
 const groups=productGroups(configs.filter(c=>!c.deletedAt)).filter(g=>productIds.includes(g.id)),entries=[],folders=new Set(),paths=new Set();
 for(const g of groups){if(g.configs.some(c=>(!selected||selected.has(c.id))&&!/^\d+$/.test(c.spu||'')))throw Error(`“${g.name}”缺少有效 SPU，请先补齐，或取消自动导出`);// 同名链接保留独立目录，比较时忽略大小写以符合 Windows 文件系统。
 let folder=safe(g.name).slice(0,80),base=folder,n=1;while(folders.has(folder.toLowerCase()))folder=`${base}_${++n}`;folders.add(folder.toLowerCase());
  g.configs.forEach((c,i)=>{if(selected&&!selected.has(c.id))return;for(const layout of layouts){const base=`${imageFolderName(folder,layout)}/${imageConfigFilename(c,i).slice(0,-4)}`;let name=base+'.png',duplicate=1;while(paths.has(name))name=base+'_'+(++duplicate)+'.png';paths.add(name);entries.push({name,config:{...clone(c),layout}});}});
 }return entries;
}

/** 串接范围选择、差异预览、应用保存和导出入口。 */
export function openGlobalBatch(api){
 const {openDialog,esc,toast,getConfigs,getCatalog,apply,save,download}=api;
 const slots=[...new Set(getConfigs().flatMap(c=>(c.parts||[]).map(p=>p.slot)).filter(Boolean))];
 openDialog('批量修改配件与导图',`<div class="global-entry-bar"><p class="hint">按配件汇总当前店铺。选择配件后，勾选要修改的链接并预览。</p><button id="global-addons">只修改加购描述</button></div><div class="global-search-bar"><input id="global-query" type="search" placeholder="搜索配件名称、ERP ID、链接或 SPU" aria-label="查找原配件"><select id="global-slot" aria-label="按配件部位筛选"><option value="">全部配件部位</option>${slots.map(slot=>`<option>${esc(slot)}</option>`).join('')}</select></div><div id="global-candidates" class="global-usage-list"></div><div id="global-work" class="hidden"><div class="global-entry-bar"><strong id="global-original"></strong><button id="global-back">返回配件汇总</button></div><details id="global-link-details" open><summary>选择影响的链接 <span id="global-summary"></span></summary><label class="global-all"><input id="global-all" type="checkbox" checked> 全选关联链接</label><div id="global-links" class="global-list"></div></details><div id="global-product-search"></div><label class="field">统一数量（留空保留原数量）<input id="global-qty" type="number" min="1" step="1" placeholder="保留原数量"></label><label class="global-export"><input id="global-export" type="checkbox"> 保存后导出配置清单图和 SKU 图</label><label class="field">导出范围<select id="global-export-scope"><option value="all">所选链接全部配置</option><option value="changed">仅本次有变动的配置</option></select></label><p class="hint">展示配件与实际配置的对应槽位同步替换。图片按链接及类型分文件夹；桌面版保存到文件夹，网页版下载 ZIP。</p><div class="actions"><button id="global-preview">预览修改</button><button id="global-apply" class="primary" disabled>应用修改</button></div><details id="global-diff-details"><summary>查看修改明细</summary><div id="global-diff" class="hint"></div></details></div><p id="global-status" role="status" class="hint"></p><button id="global-retry" class="hidden">导出刚修改的链接图片</button><button id="global-undo" class="hidden">一键还原本次修改</button>`);
 const $=selector=>document.querySelector(selector),root=$('#global-status'),dialog=root.closest('dialog');dialog.classList.add('global-batch-dialog');
 let partKey='',groups=[],plan=null,busy=false,exportIds=null,changedConfigIds=null,undoRecords=null,occurrences=null;
 const controller=new AbortController();dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();},{signal:controller.signal});dialog.addEventListener('close',()=>{controller.abort();dialog.classList.remove('global-batch-dialog');},{once:true,signal:controller.signal});
 const status=message=>{if(root.isConnected)root.textContent=message;};
 const invalidate=()=>{plan=null;$('#global-apply').disabled=true;$('#global-diff').textContent='';};
 const exportOptions=ids=>({configIds:$('#global-export-scope').value==='changed'?ids:null});
 const picked=()=>[...dialog.querySelectorAll('[data-global-link]:checked')].map(el=>el.value);
 const updateSummary=()=>{const chosen=groups.filter(group=>picked().includes(group.id));$('#global-summary').textContent=`${chosen.length} 个链接 · ${chosen.reduce((n,g)=>n+g.matches.length,0)} 套命中配置`;$('#global-all').checked=chosen.length===groups.length;$('#global-all').indeterminate=chosen.length>0&&chosen.length<groups.length;invalidate();};
 const selectPart=row=>{
  partKey=row.key;occurrences=row.occurrences;groups=usageGroups(getConfigs(),partKey,'',occurrences);$('#global-candidates').classList.add('hidden');$('#global-work').classList.remove('hidden');$('#global-original').textContent=row.name;
  $('#global-links').innerHTML=groups.map(g=>`<label><input type="checkbox" data-global-link value="${esc(g.id)}" checked><span><strong>${esc(g.name)}</strong><small>SPU ${esc(g.spu||'未填写')} · ${g.matches.length}/${g.configs.length} 套命中</small><details><summary>查看配置</summary>${g.matches.map(c=>`<small>${esc(c.shortName||c.name)}</small>`).join('')}</details></span></label>`).join('');
  dialog.querySelectorAll('[data-global-link]').forEach(el=>el.onchange=updateSummary);updateSummary();status('选择替换配件，核对预览后应用；保存成功后可继续操作。');
 };
 const listParts=()=>{
  if(busy)return;invalidate();$('#global-work').classList.add('hidden');$('#global-candidates').classList.remove('hidden');
  const rows=partUsageSummary(getConfigs(),$('#global-query').value,$('#global-slot').value);
  $('#global-candidates').innerHTML=`<div class="global-usage-head"><span>配件 / ERP ID</span><span>部位</span><span>链接</span><span>配置</span></div>`+rows.slice(0,100).map((row,i)=>`<button type="button" class="global-usage-row" data-global-part="${i}"><span><strong>${esc(row.name)}</strong><small>ERP ID ${esc(row.goodsId||'未绑定')}</small></span><span>${esc(row.slots.join('、'))}</span><span>${row.linkCount}</span><span>${row.count}</span></button>`).join('');
  dialog.querySelectorAll('[data-global-part]').forEach(button=>button.onclick=()=>selectPart(rows[Number(button.dataset.globalPart)]));status(rows.length?`共 ${rows.length} 种配件${rows.length>100?'，显示前 100 项，请搜索缩小范围':''}，点击一行选择影响的链接。`:'没有匹配配件');
 };
 $('#global-query').oninput=listParts;$('#global-slot').onchange=listParts;$('#global-back').onclick=listParts;
 $('#global-addons').onclick=()=>{dialog.classList.remove('global-batch-dialog');api.openUpgrades();};
 $('#global-all').onchange=event=>{dialog.querySelectorAll('[data-global-link]').forEach(el=>el.checked=event.target.checked);updateSummary();};
 const replacementPicker=mountProductSearch($('#global-product-search'),{getRows:getCatalog,idKey:'sourceId',label:'查找新配件',inputId:'global-new-query',describe:row=>'ERP ID '+row.goodsId+' · 核算 '+(row.tax??'待补'),onChange:invalidate});
 for(const id of ['global-qty','global-export','global-export-scope'])$('#'+id).onchange=invalidate;
 $('#global-preview').onclick=()=>{try{
  if(!picked().length)throw Error('请至少选择一个链接');
  plan=replacementPlan(getConfigs(),partKey,picked(),replacementPicker.row(),$('#global-qty').value===''?null:Number($('#global-qty').value),occurrences);
  if($('#global-export').checked)exportEntries(getConfigs(),plan.productIds,'both',exportOptions(plan.changes.map(c=>c.id)));
  $('#global-diff').textContent=replacementDiff(plan);$('#global-diff-details').open=true;$('#global-apply').disabled=!plan.changes.length;status(`将修改 ${plan.changes.length} 套配置${$('#global-export').checked?`，导出 ${exportEntries(getConfigs(),plan.productIds,'both',exportOptions(plan.changes.map(c=>c.id))).length} 张图片`:''}。请核对明细后应用。`);
 }catch(error){invalidate();status(error.message);}};
 const exportImages=()=>exportBatchImages(api,exportIds,status,exportOptions(changedConfigIds));
 let lockedControls=[];
 const lock=value=>{busy=value;if(value){lockedControls=[...dialog.querySelectorAll('input,select,button')].map(el=>({el,disabled:el.disabled}));lockedControls.forEach(({el})=>el.disabled=true);}else{lockedControls.forEach(({el,disabled})=>{if(el.isConnected)el.disabled=disabled;});lockedControls=[];}};
 $('#global-apply').onclick=async()=>{
  if(busy||!plan)return;const approved=plan,auto=$('#global-export').checked;let saved=false;
  try{
   if(JSON.stringify(replacementPicker.row())!==JSON.stringify(approved.replacement))throw Error('新配件资料已变化，请重新预览');
   if(auto)exportEntries(getConfigs(),approved.productIds,'both',exportOptions(approved.changes.map(c=>c.id)));validateReplacement(approved,getConfigs());lock(true);status(`正在保存 ${approved.changes.length} 套配置…`);
   await apply(approved);saved=true;exportIds=approved.productIds;changedConfigIds=approved.changes.map(c=>c.id);undoRecords=captureBatchRevert(approved,getConfigs());$('#global-undo').classList.remove('hidden');$('#global-undo').textContent='一键还原本次修改';plan=null;$('#global-retry').classList.remove('hidden');
   if(auto){lock(false);await exportImages();}else status(`已统一修改并保存 ${approved.changes.length} 套配置。可以继续修改，或导出刚修改的链接图片。`);
  }catch(error){status((saved?'修改已保存，导出未完成：':'修改未完成：')+error.message);toast(error.message);}
  finally{lock(false);if(root.isConnected){plan=null;$('#global-apply').disabled=true;$('#global-undo').disabled=!undoRecords;}}
 };
 // 还原也走同一事务保存和基线校验；成功后消耗此批次的还原机会。
 $('#global-undo').onclick=async()=>{
  if(busy||!undoRecords)return;
  try{lock(true);const reversal=batchRevertPlan(undoRecords,getConfigs());if(reversal.changes.length)await apply(reversal);undoRecords=null;plan=null;status('已还原本次批量修改并保存，可重新选择配件或导出图片。');$('#global-undo').textContent='本次修改已还原';}
  catch(error){status('还原未完成：'+error.message);toast(error.message);}
  finally{lock(false);if(root.isConnected){$('#global-undo').disabled=!undoRecords;invalidate();}}
 };
 $('#global-retry').onclick=async()=>{if(busy||!exportIds)return;try{await exportImages();}catch(error){status('修改已保存，导出未完成：'+error.message);}finally{lock(false);if(root.isConnected)invalidate();}};
 listParts();
}

/** 提交独立快照任务，业务弹窗只订阅文字进度；关闭后任务中心继续保留。 */
export async function exportBatchImages(api,exportIds,status=()=>{},options={}){
 const active=()=>{if(options.signal?.aborted)throw options.signal.reason||new DOMException('图片导出已取消','AbortError');};
 // 保存可能与继续编辑并行，先固定本次点击的完整输入。
 active();const snapshots=clone(options.snapshots||api.getConfigs());if(!options.snapshots)await api.save?.();active();
 const entries=exportEntries(snapshots,exportIds,options.imageKind||'both',{configIds:options.configIds??null});
 if(!entries.length)throw Error('本次没有可导出的链接配置');
 const directories=[...new Set(entries.map(entry=>entry.name.split('/')[0]))];
 const name=directories.length===1?directories[0]:`批量导出图片_${Date.now()}`;
 if(directories.length===1)for(const entry of entries)entry.name=entry.name.slice(name.length+1);
 const task=startImageExportTask({entries,name,title:'批量修改后导图',renderImage:api.renderImage,saveFolder:api.saveFolder,download:api.download,status,signal:options.signal});
 options.onTask?.(task);return task.done;
}
