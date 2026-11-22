/** 左栏显示模板卡片，配置选择和编辑在模板表内完成。 */
import {productGroups} from './core.js';
import {legacyTemplateConfigs} from './template-library.js';
import {partCapacity} from './component-capacity.js';
import {editTemplate,gpuChoices,insertTemplateRow,setTemplatePart,slotCandidates,templateDirty,templateHistory,templateIssues,templatePart,templateSelectionText,templateShort,templateSlots} from './host-template-model.js';

/** 主机模板和已保存快照沿用各自存储，共用附件的卡片与底部操作条。 */
export function mountTemplateArea({container,configs,savedTemplates=[],opened,templateView,canRename,draftFor,onToggle,onOpenGroup,onRename,onAddTemplate,onImportTemplate,onManage,esc,render}){
 const groups=productGroups(legacyTemplateConfigs(configs));
 const makeCard=(kind,group)=>{
  const draft=draftFor?.(kind,group.id);
  return {kind,id:group.id,name:draft?.data.name||group.name,
   platform:draft?.data.platform||group.platform||group.configs[0]?.templatePlatform||(/AMD|锐龙/i.test(group.name)?'amd':'intel'),
   color:draft?.data.color||group.color||group.configs[0]?.templateColor||(/白/.test(group.name)?'white':'black'),
   count:group.configs.length,dirty:!!draft&&templateDirty(draft),
   active:templateView?.kind===kind&&templateView.id===group.id};
 };
 const count=groups.length+savedTemplates.length;
 const cards=opened?[...groups.map(row=>makeCard('group',row)),...savedTemplates.map(row=>makeCard('saved',row))]:[];
 const canManage=!!templateView?.draft&&!templateView.busy;
 const editable=canManage&&canRename?.(templateView.kind);
 const actions=[['new','新建',!!canRename?.('saved')],['duplicate','复制',editable],['delete','删除',editable],
  ['export','导出',canManage],['import','导入',!!canRename?.('saved')]];
 if(!render?.({opened,count,cards,actions})){
  const list=cards.map(card=>`<button type="button" class="host-template-card" data-template-kind="${card.kind}" data-template-id="${esc(card.id)}"
  ${card.kind==='group'?'data-template-product-toggle':'data-template-snapshot'}="${esc(card.id)}" data-template-platform="${esc(card.platform)}"
  data-template-color="${esc(card.color)}" data-template-dirty="${card.dirty}" data-template-active="${card.active}">
  <span class="host-template-card-tags" aria-hidden="true"></span><strong title="${esc(card.name)}">${esc(card.name)}</strong><small>${card.count} 套</small></button>`).join('');
  const toolbar=actions.map(([id,label,enabled])=>`<button type="button" data-template-area-action="${id}" ${enabled?'':'disabled'}>${label}</button>`).join('');
  container.insertAdjacentHTML('afterbegin',`<section class="template-library-section"><button id="template-section-toggle" type="button" aria-expanded="${opened}"><span class="zone-arrow"></span><strong>主机模板</strong><small>${count} 张</small></button>
   ${opened?`<div class="template-library-content">${list||'<p class="hint">本店还没有主机模板</p>'}<div class="template-library-toolbar">${toolbar}</div></div>`:''}</section>`);
 }
 container.querySelector('#template-section-toggle').onclick=event=>onToggle(event);
 if(!opened)return;
 const commands={new:onAddTemplate,import:onImportTemplate};
 container.querySelectorAll('[data-template-area-action]').forEach(button=>{
  const action=button.dataset.templateAreaAction;
  button.onclick=()=>commands[action]?commands[action]():onManage(action);
 });
 for(const button of container.querySelectorAll('.host-template-card')){
  const {templateKind:kind,templateId:id}=button.dataset;
  button.onclick=()=>onOpenGroup(kind,id);
  const label=button.querySelector('strong');
  if(!label||!canRename?.(kind))continue;
  // 编辑框位于卡片之外，避免触发模板切换。回车和失焦共用提交处理。
  label.ondblclick=event=>{
   event.preventDefault();
   if(container.querySelector('.host-template-rename'))return;
   const input=document.createElement('input'),current=label.textContent;
   input.className='host-template-rename';input.maxLength=160;input.value=current;
   input.setAttribute('aria-label','模板名称');button.after(input);input.focus();input.select();
   const finish=save=>{
    if(!input.isConnected)return;
    const name=input.value.trim();input.onblur=null;input.remove();
    if(save&&name&&name!==current)onRename(kind,id,name);
   };
   input.onkeydown=key=>{
    if(key.isComposing||!['Enter','Escape'].includes(key.key))return;
    key.preventDefault();key.stopPropagation();finish(key.key==='Enter');
   };
   input.onblur=()=>finish(true);
  };
 }
}

const renderedSheets=new WeakMap();
/** 沿用附件的表格与右栏布局，表内操作作用于当前主机模板草稿。 */
export function renderTemplateSheet(root,options){
 const {view,esc,catalog,canEdit,canCreate,onClose,onEdit,onGenerate,onSave,onReload,onCopy,onManage,onChange,notice}=options;
 const {draft,appearance}=view,{data}=draft,rows=data.configs,dirty=templateDirty(draft);
 // 左栏和预览状态变化时复用同一模板表，保住右栏输入的焦点和滚动。
 const stamp=[view,data,draft.baseline,catalog,canEdit,canCreate,view.showIds,view.busy,view.stale,view.error,appearance.accessories.length];
 const previous=renderedSheets.get(root);
 if(previous&&root.firstElementChild?.classList.contains('host-template-center')&&stamp.every((value,index)=>value===previous[index]))return;
 renderedSheets.set(root,stamp);
 const redraw=()=>{onChange?.();renderTemplateSheet(root,options);};
 const field=(slot,item,index='')=>`<div class="host-template-field">
  <label>${esc(slot==='配件'?'配件 '+(Number(index)+1):slot)} <input type="text" data-exterior="${slot}" data-index="${index}"
   value="${esc(item.name)}" list="host-exterior-options" autocomplete="off" placeholder="输入型号或 GoodID"></label>
  ${['风扇','配件'].includes(slot)?`<input type="number" data-exterior-qty="${slot}" data-index="${index}" aria-label="${esc(slot)}数量" min="1" max="1000" value="${esc(item.qty)}">`:''}
 </div>`;
 const top=root.querySelector('.host-template-scroll')?.scrollTop??0,left=root.querySelector('.host-template-scroll')?.scrollLeft??0;
 const sideTop=root.querySelector('.host-template-appearance')?.scrollTop??0;
 // 首次插入就带上选中状态和按钮颜色对应的禁用属性。
 const selectionState=()=>{
  const picked=new Set(rows.filter(row=>!row.emptyLinkDraft&&view.picked.has(row.id)).map(row=>row.id));
  const count=picked.size,requiresAi=Boolean(appearance.changes.trim());
  return {picked,count,generate:count>0&&canCreate&&!requiresAi&&!view.busy,
   label:`生成到草稿区（${count} 套）`,
   hint:!count?'先勾选要生成的行':requiresAi?'有文字改动要求，请复制给 AI':'按模板所选配置和右侧外观生成',
   preview:templateSelectionText(data,picked,appearance)};
 };
 const initial=selectionState();
 root.innerHTML=`<div class="host-template-center">
 <div class="host-template-toolbar">
  <button type="button" class="host-template-platform" data-template-toggle="platform" data-platform="${data.platform}" ${!canEdit?'disabled':''}>${data.platform==='amd'?'AMD':'Intel'}</button>
  <button type="button" class="host-template-color" data-template-toggle="color" data-color="${data.color}" ${!canEdit?'disabled':''}>${data.color==='white'?'白色':'黑色'}</button>
  <h2>${esc(data.name)}</h2>
  <div class="host-template-choices" aria-label="模板选择">
   <button type="button" data-template-selection="all">全选</button>
   <button type="button" data-template-selection="clear">清空</button>
   <button type="button" data-template-selection="invert">反选</button>
  </div>
  <button type="button" id="host-template-save" ${!dirty||!canEdit||view.busy||view.stale?'disabled':''}>保存当前模板</button>
  <button type="button" id="host-template-revert" ${!dirty||!canEdit||view.busy?'disabled':''}>恢复到已保存</button>
  ${view.stale?'<button type="button" id="host-template-reload">读取最新模板</button>':''}
  <small class="host-template-state" data-dirty="${dirty}">${view.busy?'正在保存…':dirty?'未保存':'已保存'}</small>
  <label><input type="checkbox" id="host-template-good-id" ${view.showIds?'checked':''}> 显示 GoodID</label>
  <span class="host-template-picked" role="status">已选 <strong>${initial.count}</strong> 套</span>
  <details class="host-template-menu"><summary>更多</summary><div>
   ${canEdit?'<button type="button" data-template-action="rename">重命名</button><button type="button" data-template-action="duplicate">复制模板</button><button type="button" data-template-action="delete">删除模板</button>':''}
   <button type="button" data-template-action="export">导出模板</button>
   ${canEdit?'<button type="button" data-template-action="import">导入模板</button>':''}
   <button type="button" id="host-template-close">返回配置</button>
  </div></details>
 </div>
 <div class="host-template-scroll"><table aria-label="主机模板配置">
  <thead><tr><th scope="col">勾选</th><th scope="col">序号</th><th scope="col">短名称</th>${templateSlots.map(slot=>`<th scope="col">${slot}</th>`).join('')}<th scope="col">操作</th></tr></thead>
  <tbody>${rows.map((config,index)=>{
   const [cpu,gpu,ram,ssd]=templateShort(config),issues=templateIssues(config);
   const picked=initial.picked.has(config.id);
   return `<tr data-host-template-row="${index}"${picked?' class="is-picked"':''}>
   <td><input type="checkbox" data-host-template-pick="${esc(config.id)}" aria-label="勾选第 ${index+1} 套" ${picked?'checked':''} ${config.emptyLinkDraft?'disabled title="空白占位配置"':''}></td>
   <th scope="row">${index+1}</th>
   <td><strong>${esc(cpu+'+'+gpu)}</strong><small>${esc(ram+'+'+ssd)}</small>
   ${issues.map(issue=>`<small class="host-template-warning">⚠ ${esc(issue.message)}</small>`).join('')}</td>
   ${templateSlots.map(slot=>{
    const part=templatePart(config,slot),qty=part?.qty||1,total=partCapacity(part,'memoryGb')*qty;
    // 模板中的显卡规格可先占位，生成草稿时再选 ERP 货号。
    const partName=part?.name?.trim();
    const gpuPending=slot==='显卡'&&partName&&partName!=='无卡'&&!part.goodsId;
    return `<td class="${issues.some(issue=>issue.slots.includes(slot))?'host-template-invalid':''}">
     <div class="host-template-part-line"><button type="button" data-template-cell="${esc(slot)}" aria-label="第 ${index+1} 套${esc(slot)}" ${!canEdit||view.busy?'disabled':''}>${esc(part?.displayName||part?.name||'—')}</button>
     ${gpuPending?'<span class="host-template-gpu-pending">待选货号</span>':''}
     ${slot==='内存'&&part?`<input type="number" data-template-qty min="1" max="1000" value="${esc(qty)}" aria-label="第 ${index+1} 套内存根数" ${!canEdit||view.busy?'disabled':''}> 根${total?' <b>'+total+'G</b>':''}`:''}</div>
     ${view.showIds&&part?.goodsId?`<small>GoodID ${esc(part.goodsId)}</small>`:''}</td>`;
   }).join('')}
   <td class="host-template-row-actions">
    ${canEdit&&!view.busy?`<button type="button" data-template-row="insert" aria-label="第 ${index+1} 行后插入">＋</button>
    <button type="button" data-template-row="duplicate" aria-label="复制第 ${index+1} 行">⧉</button>
    <button type="button" data-template-row="delete" aria-label="删除第 ${index+1} 行">×</button>`:''}
    ${onEdit&&draft.baseline.configs.some(row=>row.id===config.id)?`<button type="button" data-host-template-edit="${esc(config.id)}" aria-label="打开第 ${index+1} 套完整编辑">编辑</button>`:''}
   </td></tr>`;
  }).join('')}</tbody>
 </table></div>
 ${view.error?`<p role="alert">${esc(view.error)}</p>`:''}
 ${canEdit&&!view.busy&&!rows.length?'<button type="button" id="host-template-first">＋ 加第一行</button>':''}
 </div>
 <aside class="host-template-appearance">
  <h2>这条链接的外观</h2>
  ${['机箱','散热','风扇'].map(slot=>field(slot,appearance[slot])).join('')}
  <div>${appearance.accessories.map((item,i)=>field('配件',item,String(i))).join('')}</div>
  ${appearance.accessories.length<4?'<button type="button" id="host-template-extra">＋ 加一个配件</button>':''}
  <label class="host-template-change">改动要求<textarea rows="3" id="host-template-change" placeholder="例如：全部内存换白色">${esc(appearance.changes)}</textarea></label>
  <pre class="host-template-copy-preview" aria-label="选号单">${esc(initial.preview)}</pre>
  <button type="button" id="host-template-create" ${canCreate?'':'hidden'} ${initial.generate?'':'disabled'}>${initial.label}</button>
  <small class="host-template-generate-hint">${initial.hint}</small>
  <button type="button" id="host-template-copy" ${initial.count?'':'disabled'}>复制给 AI</button>
  <datalist id="host-exterior-options"></datalist>
 </aside>`;
 const boxes=[...root.querySelectorAll('[data-host-template-pick]')],create=root.querySelector('#host-template-create'),copy=root.querySelector('#host-template-copy');
 const fieldItem=(slot,index)=>slot==='配件'?appearance.accessories[Number(index)]:appearance[slot];
 const partLabel=item=>item.templateLabel||item.name;
 const inputMatches=(items,query)=>{
  const parts=query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item=>parts.every(term=>(item.name+' '+item.goodsId).normalize('NFKC').toLowerCase().includes(term))).slice(0,60);
 };
 const optionsTo=(list,items)=>{
  list.replaceChildren(...items.map(item=>{
   const option=document.createElement('option');option.value=item.name;option.label=item.goodsId?'GoodID '+item.goodsId:item.name;return option;
  }));
 };
 const paint=({picked,count,generate,label,hint,preview}=selectionState())=>{
  for(const box of boxes){
   box.checked=picked.has(box.dataset.hostTemplatePick);
   box.closest('tr').classList.toggle('is-picked',box.checked);
  }
  root.querySelector('.host-template-picked strong').textContent=count;
  root.querySelector('.host-template-copy-preview').textContent=preview;
  create.textContent=label;
  create.disabled=!generate;
  copy.disabled=!count;
  root.querySelector('.host-template-generate-hint').textContent=hint;
 };
 function changePart(index,slot,source){
  editTemplate(draft,next=>setTemplatePart(next.configs[index],slot,source));redraw();
 }
 function openPartEditor(button,index,slot){
  const part=templatePart(data.configs[index],slot),cell=button.parentElement;
  const items=slot==='显卡'?gpuChoices(catalog):slotCandidates(catalog,slot,data.platform);
  if(slot==='CPU'||slot==='显卡'){
   const select=document.createElement('select');
   select.setAttribute('aria-label',button.getAttribute('aria-label'));
   const empty=new Option('（清空这一格）','clear');
   select.add(new Option(part?.name||'选择型号','current',true,true));select.add(empty);
   for(const label of new Set(items.map(item=>item.group||''))){
    const group=label?document.createElement('optgroup'):select;
    if(label){group.label=label;select.append(group);}
    items.forEach((item,i)=>{if((item.group||'')===label)group.append(new Option(partLabel(item),String(i)));});
   }
   select.onchange=()=>{if(select.value!=='current'){select.onblur=null;changePart(index,slot,items[Number(select.value)]);}};
   select.onblur=()=>{if(select.isConnected)select.replaceWith(button);};
   button.replaceWith(select);select.focus();try{select.showPicker();}catch{}
   return;
  }
  const input=document.createElement('input'),list=document.createElement('datalist');
  list.id='host-inline-options';input.setAttribute('list',list.id);input.autocomplete='off';
  input.className='host-template-inline';input.value=part?.name||'';input.setAttribute('aria-label',button.getAttribute('aria-label'));
  input.oninput=()=>optionsTo(list,input.value.trim()?inputMatches(items,input.value):[]);
  let cancelled=false;
  const finish=()=>{
   if(!input.isConnected)return;
   const value=input.value.trim();input.onblur=null;input.replaceWith(button);list.remove();
   if(cancelled||value===part?.name)return;
   const item=items.find(row=>row.name===value||row.goodsId===value);
   if(value&&!item){notice('请从当前店铺候选中选择配件');return;}
   changePart(index,slot,item);
  };
  input.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Escape'){event.stopPropagation();cancelled=true;finish();}if(event.key==='Enter'){event.preventDefault();finish();}};
  input.onblur=finish;button.replaceWith(input);cell.append(list);input.focus();input.select();
 }
 root.onclick=event=>{
  const button=event.target.closest('button');if(!button)return;
  const mode=button.dataset.templateSelection,row=button.closest('[data-host-template-row]'),index=Number(row?.dataset.hostTemplateRow);
  if(mode){
   for(const box of boxes){const id=box.dataset.hostTemplatePick;if(!box.disabled&&(mode==='all'||mode==='invert'&&!view.picked.has(id)))view.picked.add(id);else view.picked.delete(id);}
   paint();return;
  }
  if(button.dataset.templateCell){openPartEditor(button,index,button.dataset.templateCell);return;}
  if(button.dataset.templateRow){
   editTemplate(draft,next=>{
    const op=button.dataset.templateRow;
    if(op==='delete')next.configs.splice(index,1);
    else insertTemplateRow(next,index,view.shopId,op==='duplicate');
   });redraw();return;
  }
  if(button.dataset.templateToggle){
   const key=button.dataset.templateToggle;
   if(key==='platform'&&!confirm('切换平台筛选？已选配件会保留。'))return;
   editTemplate(draft,next=>{next[key]=key==='platform'?(next[key]==='amd'?'intel':'amd'):(next[key]==='white'?'black':'white');});redraw();return;
  }
  if(button.dataset.templateAction){onManage(button.dataset.templateAction);return;}
  if(button.dataset.hostTemplateEdit){onEdit(button.dataset.hostTemplateEdit);return;}
  if(button===copy){void onCopy(root.querySelector('.host-template-copy-preview').textContent);return;}
  if(button===create){onGenerate(boxes.filter(box=>box.checked).map(box=>box.dataset.hostTemplatePick));return;}
  if(button.id==='host-template-save'){if(confirm('保存当前模板的修改？'))void onSave();return;}
  if(button.id==='host-template-reload'){onReload();return;}
  if(button.id==='host-template-revert'){
   if(confirm('恢复到上次保存的模板？')){editTemplate(draft,next=>Object.assign(next,structuredClone(draft.baseline)));redraw();}
   return;
  }
  if(button.id==='host-template-first'){editTemplate(draft,next=>insertTemplateRow(next,-1,view.shopId));redraw();return;}
  if(button.id==='host-template-extra'){appearance.accessories.push({name:'',qty:1});redraw();return;}
  if(button.id==='host-template-close')onClose();
 };
 root.oninput=event=>{
  const input=event.target,slot=input.dataset.exterior;
  if(input.id==='host-template-change'){appearance.changes=input.value;paint();return;}
  if(slot){
   const items=slotCandidates(catalog,slot,data.platform),item=fieldItem(slot,input.dataset.index);
   const exact=items.find(row=>row.name===input.value.trim()||row.goodsId===input.value.trim());
   Object.assign(item,{name:exact?.name||input.value,goodsId:exact?.goodsId,sourceId:exact?.sourceId});
   optionsTo(root.querySelector('#host-exterior-options'),inputMatches(items,input.value));paint();
  }
 };
 root.onchange=event=>{
  const box=event.target;
  if(box.id==='host-template-good-id'){view.showIds=box.checked;redraw();root.querySelector('#host-template-good-id').focus();return;}
  if(box.dataset.hostTemplatePick){box.checked?view.picked.add(box.dataset.hostTemplatePick):view.picked.delete(box.dataset.hostTemplatePick);paint();return;}
  if(box.dataset.exterior){const item=fieldItem(box.dataset.exterior,box.dataset.index);box.value=item.name;return;}
  if(box.dataset.exteriorQty){fieldItem(box.dataset.exteriorQty,box.dataset.index).qty=Math.max(1,Math.min(1000,Math.trunc(Number(box.value)||1)));paint();return;}
  if(box.hasAttribute('data-template-qty')){
   const index=Number(box.closest('[data-host-template-row]').dataset.hostTemplateRow),qty=Math.max(1,Math.min(1000,Math.trunc(Number(box.value)||1)));
   editTemplate(draft,next=>{for(const rows of [next.configs[index].parts,next.configs[index].actualParts]){const part=rows.find(p=>p.slot==='内存');if(part)part.qty=qty;}});
   redraw();
  }
 };
 root.onkeydown=event=>{
  const target=event.target;
  if(event.isComposing||!canEdit||view.busy||target.matches('input,select,textarea'))return;
  if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){
   event.preventDefault();event.stopPropagation();templateHistory(draft,event.shiftKey||event.key.toLowerCase()==='y');redraw();
  }else if(target.dataset.templateCell&&['Delete','Backspace'].includes(event.key)){
   event.preventDefault();changePart(Number(target.closest('[data-host-template-row]').dataset.hostTemplateRow),target.dataset.templateCell,null);
  }
 };
 // 控件和文案已就绪后才恢复滚动，避免过程中触发一次错误样式计算。
 paint(initial);
 const scroll=root.querySelector('.host-template-scroll'),side=root.querySelector('.host-template-appearance');
 scroll.scrollTop=top;scroll.scrollLeft=left;side.scrollTop=sideTop;
}
