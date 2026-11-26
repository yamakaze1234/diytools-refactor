/** 全屏输出源维护与通用弹窗分离。编辑草稿、子弹窗和批量回执都属于当前工作表会话。 */
import {shopById} from './shops.js';
import {isSpecialComponent} from './special-components.js';
import {mountAddPart} from './source-sheet-add.js';
import {mountDeletedSources} from './source-deleted-ui.js';
import {splitErpName} from './erp-part-description.js';
import {excludedComponent} from './component-policy.js';
import {sourceAddonFields} from './addon-data.js';
import {mountSharedAddons} from './shared-source-editor.js';
import {sourceFields,sharedSourceLabels,sharedSourceKeys} from './shared-source-fields.js';
import {destroyProductSearch} from './product-search.js';
import {capacityFieldsHtml,readCapacityFields,updateCapacityHints} from './source-capacity-ui.js';
import {hardwareFieldsHtml,readHardwareFields,updateHardwareHints} from './source-hardware-ui.js';
import {autoCapacity} from './component-capacity.js';
import {boardType,caseSupport} from './component-hardware.js';
import {updateMaintenanceVisibility} from './source-maintenance-view.js';
import {sourceExportRows,sourceExportWorkbook} from './source-export.js';
import {mountAddonAudit} from './addon-audit.js';
import {mountSourceSync} from './source-sync-ui.js';
import {SourceChangeSession} from './source-sync-data.js';
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {sourceSheetCategories,sourceSheetFilters,buildSourceSheet,sourceSheetView,sourceSheetMatches,
 sourceSheetNavCounts,sourceSheetTaxCompare,sheetTaxInput,editSourceSheetField,createSourceSheetDraft,sourceSheetChanges,sourceSheetEffective,
 sourceSheetRestorePlan,sourceSheetCommonCanRestore,promoteSourceSheetField} from './source-sheet-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scopeName=id=>id==='shared'?'三店共用':shopById(id).shortName;
const money=cents=>cents==null?'—':'¥'+(cents/100).toFixed(2);
const chunk=64;
const action=(name,label,attributes='')=>`<button type="button" data-sheet-action="${name}" ${attributes}>${label}</button>`;
const controls=host=>host.querySelectorAll('.product-search');
const releaseSearch=host=>controls(host).forEach(destroyProductSearch);
const restoreHint=fields=>'先填写'+fields.map(field=>'共用'+(field==='tax'?'核算价':sharedSourceLabels[field])).join('、')+'，再恢复对应独享设置';
const detailKeys=sharedSourceKeys.slice(3);
const detailControls={
 'capacityOverrides.memoryGb':'[data-capacity="memoryGb"]',
 'capacityOverrides.vramGb':'[data-capacity="vramGb"]',
 'capacityOverrides.storageGb':'[data-capacity="storageGb"]',
 'hardwareOverrides.cpuName':'#source-hardware-cpu',
 'hardwareOverrides.gpuName':'#source-hardware-gpu',
 'hardwareOverrides.boardType':'#source-hardware-board',
 'hardwareOverrides.caseBoards':'[data-case-board]',
 'hardwareOverrides.color':'#source-hardware-color',
};
const storeFields=(row,id)=>row.differences.find(diff=>diff.scope===id)?.fields??[];
const restorableFields=(row,id)=>new Set(sourceSheetRestorePlan(row).targets.filter(target=>target.scope===id).map(target=>target.field));
const taxLabel=value=>value==null?'待填':'¥'+value;
const signedMoney=cents=>(cents<0?'-':'+')+money(Math.abs(cents)).replace(/\.00$/,'');
const priceOptions=[['all','全部'],['high','高于ERP'],['low','低于ERP']];
const restoreLabel=plan=>plan.targets.length&&plan.blocked.length?'恢复可用共用值':'全部恢复共用';

export function openSourceSheet(root,api){
 const previous=globalThis.workbenchSourceEditor;
 if(previous?.hasPending()){previous.restore();return previous;}
 previous?.dispose();
 const controller=new AbortController(),events={signal:controller.signal};
 const workspace=root.closest('.workspace'),shop=api.shopId(),shopIds=api.shopIds;
 const scope=api.sharedSources?.defaultScope??(shopIds.length>1?'shared':shop);
 const drawerScopes=api.sharedSources?.scopes??(scope==='shared'?['shared',...shopIds]:shopIds);
 const pending=new Map(),created=new Map(),collapsed=new Set();
 let base=new Map(),views=new Map(),category='全部配件',filter='active',priceFilter='all',query='',mode='common';
 let display=[],cursor=0,groupAt='',marked='',busy=false,disposed=false,drawer=null,sideScopes=new Map(),editing=null;
 let comboTimer=0,comboSerial=0,comboItems=[],comboIndex=-1,comboActive=false;
 let deletedCount=0;
 const automatic=api.automatic??new SourceChangeSession(shop);
 let sync=null;
 const adoptOnly=!!api.adoptErp&&!api.sharedSources?.canCreate;
 const canAddPart=api.canManage!==false&&(!api.nas||api.sharedSources?.canCreate||adoptOnly);

 root.innerHTML=`<header class="ss-header">
  ${action('back','← 返回配置','class="ss-back"')}<h1 id="source-sheet-title">输出源维护</h1>
  <span class="ss-sync-state">${api.nas?(api.sharedSources?.preview?'本机预览':'已连接 NAS'):'本机工作区'}</span>
  <div class="ss-header-actions">
   <label class="ss-shop"><span>店铺</span><select id="source-sheet-shop" aria-label="切换店铺">${shopIds.map(id=>`<option value="${esc(id)}"${id===shop?' selected':''}>${esc(shopById(id).shortName)}</option>`).join('')}</select></label>
   ${action('export','导出表格')}${action('audit','检查加购差价')}
   ${api.applySync?action('automatic','本次变动 <span data-auto-badge class="badge badge-cat" hidden></span>')+action('differences','<span>待确认差异</span><span data-diff-badge class="badge badge-unk">0</span>'):''}
  </div>
 </header>
 <div class="ss-body">
  <aside class="ss-nav" aria-label="输出源筛选"><h2>配件分类</h2><div data-sheet-categories></div><h2>快捷筛选</h2><div data-sheet-filters></div></aside>
  <section class="ss-main" aria-label="输出源工作表">
   <div class="ss-tools">
    <label class="ss-search"><span>筛选输出源</span><input id="source-sheet-filter" type="search" aria-label="筛选已有输出源" placeholder="ERP ID、名称、规格或升级项"></label>
    <div class="ss-combo"><label class="ss-search"><span>ERP 搜索</span><input id="source-sheet-erp" type="search" role="combobox" aria-label="ERP 搜索配件" aria-autocomplete="list" aria-controls="source-sheet-options" aria-expanded="false" autocomplete="off" placeholder="输入货号或配件名称"></label><div id="source-sheet-options" role="listbox" hidden></div></div>
    ${action('add-part','＋ 添加配件',`class="wb-btn wb-btn-primary wb-cut primary" ${canAddPart?'':'disabled'}`)}
    <div class="ss-price-filter" role="group" aria-label="核算价对比"><span>核算价对比</span>
     ${priceOptions.map(([id,label])=>action('price-filter',`${label} (<small>0</small>)`,`data-price-filter="${id}"`)).join('')}</div>
    <div class="ss-segments" role="group" aria-label="表格视图">${action('common','共用精简','aria-pressed="true"')}${action('stores','三店并排','aria-pressed="false"')}</div>
   </div>
   <div class="ss-grid" data-sheet-grid tabindex="0" aria-label="输出源数据表">
    <table><colgroup></colgroup><thead></thead><tbody></tbody></table>
    <div class="ss-more" data-sheet-more>${action('more','加载更多')}</div>
   </div>
   <div class="ss-deleted" data-deleted-view hidden></div>
  </section>
 </div>
  <footer class="ss-footer"><span data-sheet-count></span><span data-sheet-message role="status" aria-live="polite"></span><strong data-sheet-pending></strong>${action('resume-drawer','回到未应用抽屉','hidden')}${action('discard','放弃更改')}${action('save','保存全部更改','class="primary"')}</footer>
 <div class="ss-shade" data-sheet-action="close-drawer" hidden></div><aside class="ss-drawer" aria-label="编辑输出源" hidden></aside>`;

 const $=selector=>root.querySelector(selector);
 const grid=$('[data-sheet-grid]'),table=grid.querySelector('table'),body=table.tBodies[0],drawerHost=$('.ss-drawer'),shade=$('.ss-shade');
 const combo=$('#source-sheet-erp'),options=$('#source-sheet-options'),message=text=>{
  $('[data-sheet-message]').textContent=text;
  const drawerStatus=drawerHost.querySelector('[data-sheet-drawer-message]');
  if(drawerStatus)drawerStatus.textContent=text;
 };
 const editable=item=>api.canManage!==false&&item.base.deletedAt==null&&(created.has(item.id)||api.canEdit?.(item.base)!==false);
 const deletedHost=$('[data-deleted-view]');
 const deleted=mountDeletedSources(deletedHost,{
  nas:api.nas,shop,
  read:api.getDeletedSources??(()=>api.getAllRows().filter(row=>row.shopId===shop&&row.deletedAt!=null)),
  canEdit:row=>api.canManage!==false&&row.editable!==false&&api.canEdit?.(row)!==false,
  change:api.changeDeletedSources,
  blocked:()=>{if(!hasPending())return false;message('请先保存或放弃待保存修改');return true;},
  busy:value=>{busy=value;updateStatus();},
  count:value=>{deletedCount=value;$('[data-filter=deleted] small').textContent=value;},
  changed:()=>{readRows();refreshTable();},
  notify:text=>{message(text);api.toast?.(text);},
 });
 const rowSelector=id=>`[data-sheet-row="${CSS.escape(id)}"]`;
 const groups=new Map(sourceSheetCategories.map((name,index)=>[name,index]));
 const itemById=id=>created.get(id)??base.get(id);
 const project=(item,draft)=>sourceSheetView(item,draft,scope);

 function readRows(){
  const rows=api.getAllRows();
  deletedCount=rows.filter(row=>row.deletedAt!=null&&(api.nas||row.shopId===shop)).length;
  base=new Map(buildSourceSheet({rows,entries:api.sharedSources?.entries?.()??[],costs:api.getCosts(),
   configs:(api.getSheetConfigs??api.getConfigs)(),shop,shops:shopIds}).map(item=>[item.id,item]));
  views=new Map([...base,...created].map(([id,item])=>[id,project(item,pending.get(id))]));
 }
 function panelDirty(panel){try{return panel.dirty();}catch{return true;}}
 function dirtyDrawer(){return drawer&&[...drawer.panels.values()].some(panelDirty);}
 function hasPending(){return busy||pending.size>0||!!editing&&editing.field.value!==editing.value||!!dirtyDrawer();}
 function updateStatus(){
  $('[data-sheet-count]').textContent=filter==='deleted'?'已删除输出源':`共 ${views.size} 条 · 当前 ${display.length} 条`;
  const draftIds=new Set(pending.keys());
  const drawerPending=dirtyDrawer();
  if(drawerPending)draftIds.add(drawer.id);
  if(editing&&editing.field.value!==editing.value)draftIds.add(editing.id);
  const count=draftIds.size;
  $('[data-sheet-pending]').textContent=count?`${count} 条待保存`:'无待保存修改';
  const resume=$('[data-sheet-action="resume-drawer"]');
  resume.hidden=!drawerPending||!drawerHost.hidden;
  resume.title=drawerPending?drawer.label:'';
  for(const name of ['save','discard'])$('[data-sheet-action="'+name+'"]').disabled=busy||!count;
 }
 function setDraft(item,next){
  if(next)pending.set(item.id,next);else pending.delete(item.id);
  views.set(item.id,project(item,next));
  refreshRow(item.id);
 }
 function changeField(item,target,field,value,restoring=false){
  const next=editSourceSheetField(item,pending.get(item.id),target,field,value,{restore:restoring});
  setDraft(item,next);
 }

 $('[data-sheet-categories]').innerHTML=sourceSheetCategories.map(name=>action('category',
  `<span>${esc(name)}</span><small>0</small>`,`data-category="${esc(name)}"`)).join('');
 $('[data-sheet-filters]').innerHTML=sourceSheetFilters.map(([id,label])=>action('filter',
  `<span>${esc(label)}</span><small>0</small>`,`data-filter="${id}"${id==='different'&&shopIds.length<2?' hidden':''}`)).join('');
 function nav(){
  const counts=sourceSheetNavCounts(views.values(),{category,filter,priceFilter,query});
  for(const button of root.querySelectorAll('[data-price-filter]')){
   const key=button.dataset.priceFilter;
   button.setAttribute('aria-pressed',String(key===priceFilter));
   button.querySelector('small').textContent=counts.priceFilters.get(key);
  }
  for(const button of $('[data-sheet-categories]').children){
   const key=button.dataset.category;
   button.setAttribute('aria-pressed',String(key===category));
   button.lastElementChild.textContent=counts.categories.get(key);
  }
  for(const button of $('[data-sheet-filters]').children){
   const key=button.dataset.filter,count=key==='deleted'?deletedCount:counts.filters.get(key);
   button.setAttribute('aria-pressed',String(key===filter));
   button.toggleAttribute('data-has-count',count>0);
   button.lastElementChild.textContent=count;
  }
 }
 // 行情只描述绑定配件，海报文案按原样单独显示。
 function addonHtml(addon){
  const disabled=addon.enabled?'':' is-disabled';
  const off=addon.enabled?'':'<span class="ss-addon-tag is-off">不展示</span>';
  const copy=`<span class="ss-addon-copy">${esc(addon.text)}</span>`;
  if(!addon.goodsId)return `<span class="ss-addon is-note${disabled}"><span class="ss-addon-tag is-note">仅文案</span>${off}${copy}</span>`;
  const {value,incoming}=addon.targetStock;
  const price=addon.targetErp==null?'价未知':money(addon.targetErp).replace(/\.00$/,'');
  const status=addon.targetTags.join(' / ')||(addon.unavailable?'缺货':value==null?'库存未知':'现货 '+value);
  const stockClass=addon.unavailable?'ss-stock-alert':value!=null?'ss-stock-available':'';
  const meta=[price,`<span class="${stockClass}">${esc(status)}</span>`];
  if(incoming!=null&&incoming>(value??0))meta.push(`<span class="ss-stock-incoming">待入 ${esc(incoming)}</span>`);
  meta.push('#'+esc(addon.goodsId));
  const alert=addon.unavailable;
  return `<span class="ss-addon is-part${alert?' is-alert':''}${disabled}" title="ERP ID ${esc(addon.goodsId)} · ${esc(addon.targetRawName||'未匹配 ERP')}">
   <span class="ss-addon-head"><span class="ss-addon-tag ${alert?'is-alert':'is-part'}">${alert?'缺货':'配件'}</span>${off}
    <span class="ss-addon-erp">${esc(addon.targetName||'未匹配 ERP')}</span><span class="ss-addon-meta">${meta.join(' · ')}</span></span>${copy}</span>`;
 }
 function rowAddons(row,target){
  if(isSpecialComponent(row.base))return '<span class="ss-muted">—</span>';
  const items=row.addons.get(target)??[];
  return action('addons',items.length?items.map(addonHtml).join(''):'<span class="ss-muted">＋ 设置升级项</span>',
   `data-scope="${target}" class="ss-cell-action ss-upgrades${items.length?'':' is-empty'}" aria-label="编辑升级项"`);
 }
 function nameField(row,target,displayStore){
  const shown=row.scopeRows.get(displayStore??target)?.name??'';
  return `<textarea data-sheet-field="name" data-scope="${esc(target)}"${displayStore?` data-display-store="${esc(displayStore)}"`:''}
   aria-label="${esc(scopeName(displayStore??target))}展示名称" rows="1" placeholder="待填展示名称"${editable(row)?'':' readonly'}>${esc(shown)}</textarea>`;
 }
 function stockText(row){
  if(isSpecialComponent(row.base))return '成本固定为 0';
  const current=row.stock.value,incoming=row.stock.incoming;
  const stopped=splitErpName(row.erpName).tags.find(tag=>['停售','停产','缺货'].includes(tag));
  return [stopped||(current===null?'库存未知':current<=0?'缺货':'现货 '+current),
   incoming!==null&&incoming>(current??0)?'待入 '+incoming:''].filter(Boolean).join(' · ');
 }
 function baseInfo(row){
  const facts=row.common.hardwareOverrides??{};
  const automatic=row.base.hardwareFacts??{},raw=splitErpName(row.erpName);
  const sizes=Object.values(row.common.capacityOverrides??{});
  if(!sizes.length&&['内存','硬盘','显卡'].includes(row.category)){
   const capacity=autoCapacity(row.base.erpSpec||raw.spec||row.erpName);
   if(capacity!=null)sizes.push(capacity);
  }
  const power=row.category==='电源'?row.erpName?.match(/\b\d{3,4}\s*w\b/i)?.[0]:'';
  const supported=row.category==='机箱'?caseSupport(row.common):null;
  const aliases=Object.values(row.entry.stores).reduce((max,items)=>Math.max(max,items.length),0);
  return [...new Set([facts.cpuName||automatic.cpuName,facts.gpuName||automatic.gpuName,...sizes.map(value=>value+' GB'),power,
   facts.color||automatic.color,facts.boardType||(row.category==='主板'?boardType(row.common):''),
   ...(facts.caseBoards??supported?.exact??(supported?.type?[supported.type]:[])),row.base.erpSpec||row.cost?.erpSpec||raw.spec,
   aliases>1?`历史别名 ×${aliases}`:''].filter(Boolean))].join(' · ');
 }
 function overrideHead(row,id,fields,restore){
  if(!fields.length)return '';
  const short={name:'名称',addon:'升级',tax:'价'};
  const types=fields.map(field=>short[field]||sharedSourceLabels[field]).join('+');
  const value=row.scopeRows.get(id).tax,cmp=sourceSheetTaxCompare(value,row.erp);
  const delta=cmp.diffCents?` (${signedMoney(cmp.diffCents)})`:cmp.status==='equal'?' (= 持平)':'';
  const tax=fields.includes('tax')?action('store-addons',esc(taxLabel(value)+delta),
   `class="ss-tax-chip is-${cmp.status}" data-scope="${esc(id)}" title="查看本店独享核算价"`):'';
  const canRestore=restore.targets.some(target=>target.scope===id);
  const blocked=fields.filter(field=>restore.blocked.includes(field));
  return `<div class="ss-ov-head"><span class="ss-override-tag">独享·${esc(types)}</span>${tax}
   ${action('restore-store','恢复共用',`data-scope="${esc(id)}"${canRestore&&editable(row)?'':' disabled'} title="${esc(blocked.length?restoreHint(blocked):'恢复本店可用的共用设置')}"`)}</div>`;
 }
 function scopeCell(row,id,restore){
  const active=sideScopes.get(JSON.stringify([row.id,id]))??(scope==='shared'?scope:id);
  const fields=storeFields(row,id),canRestore=restore.targets.some(target=>target.scope===id&&target.field==='name');
  return `<td class="ss-store-cell ${fields.length?'is-override':''}">
   ${scope==='shared'?`<div class="ss-name-scopes" role="group" aria-label="名称编辑范围" data-store="${id}">
    ${action('name-scope','三店共用',`data-scope="shared" aria-pressed="${active==='shared'}"`)}
    ${action('name-scope',`仅改${scopeName(id)}`,`data-scope="${id}" aria-pressed="${active===id}"`)}
    ${action('restore-name','恢复共用名',`data-scope="${id}"${canRestore&&editable(row)?'':' disabled'}${fields.includes('name')&&!canRestore?` title="${esc(restoreHint(['name']))}"`:''}`)}
   </div>`:''}
   ${overrideHead(row,id,fields,restore)}
   ${nameField(row,active,id)}${rowAddons(row,id)}</td>`;
 }
 function overrideCard(row,{scope:id,fields,row:store}){
  const values=sourceFields(store);
  const summary=fields.map(field=>{
   const value=values[field];
   const shown=field==='tax'?taxLabel(value):field==='addon'?row.addons.get(id).map(addon=>addon.text||addon.goodsId).join(' · ')||'无升级项':
    field.startsWith('capacityOverrides.')&&value!=null?value+' GB':Array.isArray(value)?value.join('、'):value??'自动识别';
   return sharedSourceLabels[field]+' '+shown;
  }).join('；');
  return action('store-override',`<strong>${esc(scopeName(id))} · 独享</strong><span title="${esc(summary)}">${esc(summary)}</span>`,
   `data-scope="${id}" class="ss-override-card"`);
 }
 function rowHtml(row){
  const special=isSpecialComponent(row.base),isMarked=row.id===marked;
  const stock=stockText(row);
  const identity=`<td class="ss-frozen"><div class="ss-identity"><strong title="${esc(row.erpName)}">${esc(splitErpName(row.erpName).main||row.common.name||'新增配件')}</strong>
   <small>${special?'特殊配件':esc(row.base.goodsId)} · ${esc(row.category)} · 引用 ${row.references} 套</small>
   <small>${special?'成本固定为 0':`ERP ${money(row.erp)} · <span class="${/缺货|停售|停产/.test(stock)?'ss-stock-alert':''}">${esc(stock)}</span>`}</small>
   <span class="ss-draft-flag">${row.draft?.created?'新增 · 待保存':'待保存'}</span></div></td>`;
  const {status,diffCents}=row.taxCompare;
  const delta=diffCents?(diffCents>0?'↑ 高于 ':'↓ 低于 ')+`<span>${signedMoney(diffCents)}</span>`:status==='equal'?'= 持平':'';
  const tax=`<td class="ss-tax is-${status}"><input type="text" inputmode="decimal" data-sheet-field="tax" data-scope="${scope}" aria-label="核算价" value="${esc(special?0:row.common.tax)}" placeholder="待填"${special||!editable(row)?' readonly':''}>${delta?`<small class="ss-tax-delta">${delta}</small>`:''}</td>`;
  const restore=sourceSheetRestorePlan(row);
  const restoreControls=row.differences.length?action('restore-all',restoreLabel(restore),editable(row)&&restore.targets.length?'':'disabled')+
   `<small class="ss-muted" data-sheet-restore-hint${restore.blocked.length?'':' hidden'}>${restore.blocked.length?esc(restoreHint(restore.blocked)):''}</small>`:'';
  const diff=shopIds.length<2?'<span class="ss-muted">本店可见</span>':row.differences.length?
   row.differences.map(diff=>overrideCard(row,diff)).join('')+restoreControls:
   '<span class="ss-muted">三店一致</span>'+action('store-addons','＋ 单店设置',`data-scope="${shop}"`);
  const middle=mode==='common'?`<td>${nameField(row,scope)}</td><td>${rowAddons(row,scope)}</td><td class="ss-differences">${diff}</td>`:shopIds.map(id=>scopeCell(row,id,restore)).join('');
  return `<tr data-sheet-row="${esc(row.id)}" tabindex="-1" class="${isMarked?'is-marked ':''}${row.draft?'is-pending':''}">
   ${identity}${tax}${middle}<td>${action('details',esc(baseInfo(row)||'查看基础信息'),'class="ss-cell-action"')}
   ${mode==='stores'?restoreControls:''}
   ${action('reset-row','↺ 还原此行','class="ss-reset-row"')}</td></tr>`;
 }
 const columnCount=()=>mode==='common'?6:3+shopIds.length;
 const groupSelector=name=>`[data-sheet-group="${CSS.escape(name)}"]`;
 const rowHidden=row=>category==='全部配件'&&collapsed.has(row.category);
 const emptyRow=()=>`<tr><td colspan="${columnCount()}" class="ss-empty">没有匹配的输出源</td></tr>`;
 function groupHeading(name){
  return `<tr class="ss-group" data-sheet-group="${esc(name)}"><th colspan="${columnCount()}" scope="rowgroup">${action('toggle-group',
   `${collapsed.has(name)?'▸':'▾'} ${esc(name)}`,`data-category="${esc(name)}" aria-expanded="${!collapsed.has(name)}"`)}</th></tr>`;
 }
 function appendRows(){
  const slice=display.slice(cursor,cursor+chunk);
  if(!slice.length){$('[data-sheet-more]').hidden=true;return;}
  body.insertAdjacentHTML('beforeend',slice.map(row=>{
   let heading='';
   if(category==='全部配件'&&row.category!==groupAt){
    groupAt=row.category;
    heading=groupHeading(groupAt);
   }
   return heading+(rowHidden(row)?'':rowHtml(row));
  }).join(''));
  cursor+=slice.length;$('[data-sheet-more]').hidden=cursor>=display.length;
 }
 function patchRow(current,row){
  const focused=document.activeElement;
  const template=document.createElement('template');
  template.innerHTML=rowHtml(row);
  const updated=template.content.firstElementChild;
  current.className=updated.className;
  for(const [index,cell] of [...current.cells].entries()){
   const next=updated.cells[index];
   cell.className=next.className;
   const field=cell.querySelector('[data-sheet-field]');
   if(!field){
    if(cell.innerHTML!==next.innerHTML)cell.replaceChildren(...next.childNodes);
    continue;
   }
   // 保留输入框节点，只同步值和周围的覆盖角标、按钮与范围。
   const nextField=next.querySelector('[data-sheet-field]');
   field.dataset.scope=nextField.dataset.scope;
   if(editing?.field!==field)field.value=nextField.value;
   const before=[],after=[];
   let siblings=before;
   for(const child of next.children){
    if(child===nextField)siblings=after;
    else siblings.push(child);
   }
   const updateSiblings=(nodes,replacements,edge)=>{
    if(nodes.length===replacements.length&&nodes.every((node,i)=>node.isEqualNode(replacements[i])))return;
    for(const node of nodes)node.remove();
    field[edge](...replacements);
   };
   const children=[...cell.children],position=children.indexOf(field);
   updateSiblings(children.slice(0,position),before,'before');
   updateSiblings(children.slice(position+1),after,'after');
  }
  if(focused&&!focused.isConnected)current.focus({preventScroll:true});
 }
 function refreshRow(id){
  const row=views.get(id),index=display.findIndex(entry=>entry.id===id),current=body.querySelector(rowSelector(id));
  const matches=row&&sourceSheetMatches(row,{category,filter,priceFilter,query});
  if(matches&&index>=0){
   display[index]=row;
   if(current)patchRow(current,row);
  }else if(index>=0){
   const removed=display[index],focused=current?.contains(document.activeElement);
   display.splice(index,1);
   if(index<cursor)cursor--;
   current?.remove();
   if(!display.slice(0,cursor).some(entry=>entry.category===removed.category))body.querySelector(groupSelector(removed.category))?.remove();
   if(!display.length)body.insertAdjacentHTML('beforeend',emptyRow());
   if(focused)grid.focus({preventScroll:true});
  }else if(matches){
   // 抽屉草稿可能让已筛掉的行重新可见，按原位置插回已加载的区段。
   const order=new Map([...views.keys()].map((key,i)=>[key,i]));
   const compared=display.findIndex(entry=>groups.get(entry.category)>groups.get(row.category)||
    entry.category===row.category&&(Number(!!entry.draft?.created)<Number(!!row.draft?.created)||
    !!entry.draft?.created===!!row.draft?.created&&order.get(entry.id)>order.get(id)));
   const insertion=compared<0?display.length:compared,render=insertion<cursor||cursor===display.length;
   const next=display[insertion];
   display.splice(insertion,0,row);
   if(render){
    body.querySelector('.ss-empty')?.closest('tr').remove();
    const existingGroup=body.querySelector(groupSelector(row.category));
    const anchor=next&&insertion<cursor?
     (next.category!==row.category?body.querySelector(groupSelector(next.category)):body.querySelector(rowSelector(next.id))):null;
    const html=(category==='全部配件'&&!existingGroup?groupHeading(row.category):'')+(rowHidden(row)?'':rowHtml(row));
    if(anchor)anchor.insertAdjacentHTML('beforebegin',html);else body.insertAdjacentHTML('beforeend',html);
    cursor++;
   }
  }
  groupAt=display[cursor-1]?.category??'';
  $('[data-sheet-more]').hidden=cursor>=display.length;
  nav();updateStoreCounts();updateStatus();
 }
 // 按整个筛选结果统计，包含尚未滚动加载或折叠的行。
 function updateStoreCounts(){
  for(const badge of table.tHead.querySelectorAll('[data-store-count]')){
   const count=display.filter(row=>storeFields(row,badge.dataset.storeCount).length).length;
   badge.textContent=count?'独享 '+count:'全部共用';
  }
 }
 function refreshTable(reset=false){
  nav();
  const inDeleted=filter==='deleted';
  $('.ss-tools').hidden=grid.hidden=inDeleted;deletedHost.hidden=!inDeleted;
  if(inDeleted){display=[];cursor=0;deleted.show(category);updateStatus();return;}
  deleted.hide();
  display=[...views.values()].filter(row=>sourceSheetMatches(row,{category,filter,priceFilter,query}))
   .sort((a,b)=>groups.get(a.category)-groups.get(b.category)||Number(!!b.draft?.created)-Number(!!a.draft?.created));
  const before=reset?0:cursor;
  const target=before&&display.length>chunk?before:chunk;
  const names=mode==='common'?['ERP 配件','核算价',scope==='shared'?'共用展示名称':'本店展示名称',scope==='shared'?'共用升级项':'本店升级项','三店差异覆盖','基础信息']:
   ['ERP 配件','核算价',...shopIds.map(scopeName),'基础信息'];
  table.dataset.view=mode;
  table.querySelector('colgroup').innerHTML=names.map((_,index)=>`<col class="ss-col-${index}">`).join('');
  table.tHead.innerHTML=`<tr>${names.map((name,index)=>{
   const store=mode==='stores'&&index>=2?shopIds[index-2]:null;
   const label=store?`<span class="ss-store-title" data-shop="${esc(store)}">${esc(name)} <small data-store-count="${esc(store)}"></small></span>`:esc(name);
   return `<th scope="col"${index?'':' class="ss-frozen"'}>${label}</th>`;
  }).join('')}</tr>`;
  updateStoreCounts();
  body.replaceChildren();cursor=0;groupAt='';
  if(!display.length)body.innerHTML=emptyRow();
  while(cursor<Math.min(target,display.length))appendRows();
  $('[data-sheet-more]').hidden=cursor>=display.length;
  if(reset)grid.scrollTop=0;
  updateStatus();
 }
 function locate(id,{focusName=false}={}){
  const row=views.get(id)??[...views.values()].find(item=>item.aliases.some(alias=>alias.sourceId===id)||item.base.goodsId===id);
  if(!row)return false;
  category=row.category;priceFilter='all';filter=row.base.deletedAt!=null?'deleted':'active';query='';$('#source-sheet-filter').value='';
  collapsed.delete(row.category);marked=row.id;refreshTable(true);
  const index=display.findIndex(item=>item.id===row.id);
  while(cursor<=index&&cursor<display.length)appendRows();
  const target=body.querySelector(`[data-sheet-row="${CSS.escape(row.id)}"]`);
  target?.scrollIntoView({block:'nearest',inline:'nearest'});
  if(focusName){const field=target?.querySelector('[data-sheet-field="name"]');field?.focus();field?.select();}
  else target?.focus({preventScroll:true});
  return true;
 }

 function startEditing(field){
  const id=field.closest('[data-sheet-row]')?.dataset.sheetRow;
  if(!id||field.readOnly)return;
  if(field.dataset.displayStore)field.value=views.get(id).scopeRows.get(field.dataset.scope)?.name??'';
  editing={id,field,value:field.value};
 }
 // 输入时仅预览恢复按钮；按下按钮后先提交共用价，再按最新草稿解除覆盖。
 function previewTaxRestore(field){
  if(field.dataset.sheetField!=='tax'||field.dataset.scope!=='shared'||field.readOnly)return;
  const tr=field.closest('[data-sheet-row]'),button=tr?.querySelector('[data-sheet-action="restore-all"]');
  if(!button)return;
  const item=itemById(tr.dataset.sheetRow),hint=tr.querySelector('[data-sheet-restore-hint]');
  const storeButtons=tr.querySelectorAll('[data-sheet-action="restore-store"]');
  let tax;
  try{tax=sheetTaxInput(field.value);}catch(error){
   button.disabled=true;hint.hidden=false;hint.textContent=error.message;
   for(const control of storeButtons){control.disabled=true;control.title=error.message;}
   return;
  }
  const draft=editSourceSheetField(item,pending.get(item.id),'shared','tax',tax);
  const row={...views.get(item.id),draft},plan=sourceSheetRestorePlan(row);
  for(const control of storeButtons){
   const store=control.dataset.scope;
   control.disabled=!editable(item)||!plan.targets.some(target=>target.scope===store);
   const blocked=storeFields(row,store).filter(field=>plan.blocked.includes(field));
   control.title=blocked.length?restoreHint(blocked):'恢复本店可用的共用设置';
  }
  button.disabled=!editable(item)||!plan.targets.length;
  button.textContent=restoreLabel(plan);
  hint.hidden=!plan.blocked.length;
  hint.textContent=plan.blocked.length?restoreHint(plan.blocked):'';
 }
 function finishEditing(field,cancel=false){
  if(!editing||editing.field!==field)return;
  const {id,value}=editing;editing=null;
  const showValue=next=>{field.value=field.dataset.displayStore?views.get(id).scopeRows.get(field.dataset.displayStore)?.name??'':next??'';};
  if(cancel){showValue(value);previewTaxRestore(field);updateStatus();return;}
  if(value===field.value){showValue(value);updateStatus();return;}
  try{
   const type=field.dataset.sheetField;
   const next=type==='tax'?sheetTaxInput(field.value):field.value.trim();
   if(type==='name'&&!next)throw Error('请填写展示名称');
   changeField(itemById(id),field.dataset.scope,type,next);
   showValue(next);
   message('');
  }catch(error){showValue(value);previewTaxRestore(field);message(error.message);updateStatus();}
 }

 function closeCombo(){
  clearTimeout(comboTimer);comboSerial++;comboActive=false;comboItems=[];comboIndex=-1;
  options.hidden=true;options.replaceChildren();combo.setAttribute('aria-expanded','false');combo.removeAttribute('aria-activedescendant');
 }
 function comboResults(items,searching=false,error=''){
  comboItems=items;comboIndex=items.length?0:-1;
  options.hidden=false;combo.setAttribute('aria-expanded','true');
  options.innerHTML=items.map((entry,index)=>`<button type="button" id="source-sheet-option-${index}" tabindex="-1" role="option" aria-selected="${index===comboIndex}" data-sheet-action="erp-pick" data-index="${index}"><strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small></button>`).join('')+
   (searching||error||!items.length?`<p role="status">${esc(error||(searching?'正在查询 ERP…':'没有匹配的配件'))}</p>`:'');
  if(comboIndex>=0)combo.setAttribute('aria-activedescendant','source-sheet-option-'+comboIndex);
  else combo.removeAttribute('aria-activedescendant');
 }
 function comboSearch(){
  clearTimeout(comboTimer);
  const text=combo.value.trim(),serial=++comboSerial;
  if(text.length<2){closeCombo();return;}
  comboActive=true;
  const local=[...views.values()].filter(row=>sourceSheetMatches(row,{query:text})).slice(0,10)
   .map(row=>({id:row.id,name:row.common.name||row.erpName,description:`已有输出源 · ${row.base.goodsId||'特殊配件'} · ${row.category}`}));
  comboResults(local,!!api.erpSearch);
  if(!api.erpSearch)return;
  comboTimer=setTimeout(async()=>{
   try{
    const results=await api.erpSearch(text,new Set([...views.values()].map(row=>row.base.goodsId).filter(Boolean)));
    if(disposed||!comboActive||serial!==comboSerial)return;
    const existing=new Set([...views.values()].map(row=>row.base.goodsId));
    const erp=results.filter(candidate=>!existing.has(candidate.goodsId)&&!excludedComponent(candidate)).slice(0,12).map(candidate=>{
     const unit=Number.isFinite(candidate.erp)?money(Math.round(candidate.erp*100)):'价格未知';
     const stock=candidate.stockAvailable==null?'库存未知':'库存 '+candidate.stockAvailable;
     return {candidate,name:splitErpName(candidate.name).main,description:`加入输出源 · ${candidate.goodsId} · ERP ${unit} · ${stock}`};
    });
    comboResults([...local,...erp]);
   }catch(error){if(!disposed&&comboActive&&serial===comboSerial)comboResults(local,false,error.message||String(error));}
  },250);
 }
 async function selectErp(index){
  const entry=comboItems[index];if(!entry||busy)return;
  combo.value='';closeCombo();
  if(entry.id)return locate(entry.id);
  if(api.canManage===false)return message('当前账号只能查看输出源');
  const candidate=entry.candidate;
  const existing=[...views.values()].find(row=>row.base.goodsId===candidate.goodsId);
  if(existing)return locate(existing.id);
  busy=true;message('正在读取 ERP 参考核算价');updateStatus();
  try{
   const tax=await api.readTaxCurrent?.(candidate.goodsId);
   // ERP 搜索返回的 name 是原名，表单的 name 则可以是人工展示名。
   const erpName=candidate.erpName||candidate.name;
   const added=await addPart({...candidate,erpName,displayName:splitErpName(erpName).main},tax);
   locate(added.id,{focusName:true});message(added.notice);
  }catch(error){message(error.message||String(error));}
  finally{busy=false;updateStatus();}
 }
 // 工具栏与弹窗共用建源逻辑。单店建源收到回执后读取版本，再暂存本店人工规格。
 async function addPart(candidate,tax,special=false){
  if(adoptOnly){
   const sourceId=await api.adoptErp(candidate,tax);
   try{await api.sharedSources?.refresh?.();}
   catch(error){throw Error('已加入当前店铺，但目录版本读取失败。请重试以接续维护：'+error.message);}
   readRows();
   const item=[...base.values()].find(item=>item.aliases.some(alias=>alias.sourceId===sourceId));
   if(!item)throw Error('已加入当前店铺，尚未读回新增记录。请重试以接续维护。');
   const values=sourceFields(candidate),fields=detailKeys.filter(key=>values[key]!=null);
   let draft=pending.get(item.id);
   for(const key of fields)draft=editSourceSheetField(item,draft,shop,key,values[key]);
   if(draft)setDraft(item,draft);
   return {id:item.id,notice:draft?'已加入当前店铺，硬件资料已加入草稿，请点击「保存全部更改」':'已加入当前店铺输出源'};
  }
  const {item,draft}=createSourceSheetDraft(candidate,{shop,shops:shopIds,managed:!!api.sharedSources,special,tax});
  created.set(item.id,item);setDraft(item,draft);
  return {id:item.id,notice:'已加入待保存草稿，请核对后点击右下角「保存全部更改」'};
 }

 function openAddPart(){
  if(busy||!canAddPart)return;
  const host=childDialog('添加配件'),dialog=host.closest('dialog'),shared=!!api.sharedSources?.canCreate;
  const isCurrent=()=>!disposed&&dialog.open&&host.isConnected;
  mountAddPart(host,{api,adoptOnly,shared,shops:(shared?shopIds:[shop]).map(scopeName),isCurrent,
   findExisting:goodsId=>{
    const rows=[...views.values()].filter(row=>row.base.goodsId===goodsId);
    return rows.find(row=>row.base.deletedAt==null)??rows[0];
   },
   locate:id=>locate(id,{focusName:true}),
   submit:async(candidate,tax,special,openAddons)=>{
    if(busy)return;
    busy=true;updateStatus();
    let result;
    try{result=await addPart(candidate,tax,special);}
    finally{busy=false;updateStatus();}
    if(isCurrent())api.closeDialog();
    if(disposed)return;
    locate(result.id,{focusName:true});
    if(openAddons)showDrawer(itemById(result.id),'addons');
    message(result.notice);
   }
  });
 }

 function clearDrawer(){
  releaseSearch(drawerHost);drawer=null;drawerHost.replaceChildren();drawerHost.hidden=true;shade.hidden=true;
 }
 function closeDrawer(){
  if(!drawer)return;
  if(!dirtyDrawer())clearDrawer();
  else {
   drawerHost.hidden=true;shade.hidden=true;
   message('「'+drawer.label+'」有未应用修改，可从底部返回抽屉');
  }
  updateStatus();
 }
 function drawerRestores(pane,item,id,restore,keys,onRestore,currentOverrides=()=>storeFields(views.get(item.id),id)){
  const buttons=[...pane.querySelectorAll('[data-restore-fields]')],hint=pane.querySelector('[data-restore-hint]');
  const available=button=>{
   const row=views.get(item.id),allowed=new Set(currentOverrides().filter(key=>sourceSheetCommonCanRestore(row,key)));
   return button.dataset.restoreFields.split(' ').filter(field=>allowed.has(field)&&!restore.has(field));
  };
  const refresh=()=>{
   const row=views.get(item.id),overrides=currentOverrides().filter(field=>keys.includes(field));
   const blocked=overrides.filter(field=>!sourceSheetCommonCanRestore(row,field));
   for(const button of buttons)button.disabled=!editable(item)||!available(button).length;
   if(hint)hint.textContent=[
    blocked.length?restoreHint(blocked):'',
    restore.size?'待恢复共用：'+[...restore].map(field=>sharedSourceLabels[field]).join('、'):'',
   ].filter(Boolean).join('。');
  };
  for(const button of buttons)button.onclick=()=>{
   const fields=available(button);
   if(!editable(item)||!fields.length)return;
   for(const field of fields)restore.add(field);
   onRestore(fields);updateStatus();
  };
  return refresh;
 }
function makeAddonPanel(host,item,id){
  const row=views.get(item.id),original=row.scopeRows.get(id),shared=row.common;
  const special=isSpecialComponent(original),edited=editable(item),store=id!=='shared';
  const restore=new Set(),pane=document.createElement('section');
  pane.className='ss-drawer-pane';
  pane.innerHTML=`${store?`<div class="ss-store-fields"><label>${esc(scopeName(id))}展示名称
   <input class="wb-input" data-sheet-drawer-name value="${esc(original.name)}"></label>
   <label>本店核算价<div class="ss-store-price"><strong data-sheet-drawer-tax></strong><span class="badge" data-price-state></span></div></label></div>`:''}
   <div data-sheet-addon-fields></div>`;
  host.append(pane);
  // 每个范围保留独立的控件和预览；切换标签时继续编辑原先的输入。
  const preview=document.createElement('div'),bar=document.createElement('div');
  drawerHost.querySelector('[data-drawer-previews]').append(preview);
  drawerHost.querySelector('[data-drawer-overrides]').append(bar);
  bar.className='ss-store-override';
  bar.innerHTML=`<span class="badge badge-sel">单店独享中</span><span data-override-label></span><div>
   ${action('drawer-promote-store','用本店统一三店','class="wb-btn wb-btn-sm"')}
   ${action('drawer-restore-store','恢复三店共用','class="wb-btn wb-btn-sm" data-restore-fields="name tax addon"')}</div>
   <small data-restore-hint></small>`;
  const name=pane.querySelector('[data-sheet-drawer-name]'),fields=pane.querySelector('[data-sheet-addon-fields]');
  let editor;
  function mountAddon(source){
   releaseSearch(fields);preview.replaceChildren();
   editor=edited&&!special?mountSharedAddons(fields,{row:source,getCosts:api.getCosts,getOriginal:()=>({...source,erp:row.erp==null?null:row.erp/100}),preserveSelection:true,previewHost:preview,
    onChange:()=>{clearIntent('addon');refresh();updateStatus();}}):null;
   if(!editor)fields.textContent=special?'特殊配件没有升级项':'当前账号只能查看此输出源';
  }
  function clearIntent(field){
   restore.delete(field);
   if(drawer.promotions.get(field)?.id===id)drawer.promotions.delete(field);
  }
  const refreshRestore=drawerRestores(bar,item,id,restore,['name','tax','addon'],keys=>{
   for(const key of keys)if(drawer.promotions.get(key)?.id===id)drawer.promotions.delete(key);
   if(keys.includes('name'))name.value=shared.name;
   if(keys.includes('addon'))mountAddon(shared);
   refresh();
  },overriddenFields);
  // 尚在抽屉中的新覆盖也可直接提升或恢复，无需先退出再打开。
  function overriddenFields(){
   const current=new Set(storeFields(row,id).filter(key=>['name','tax','addon'].includes(key)));
   if(name&&name.value.trim()!==original.name)current.add('name');
   if(store&&editor?.isDirty())current.add('addon');
   return [...current];
  }
  const promote=bar.querySelector('[data-sheet-action=drawer-promote-store]');
  function value(field,validate=false){
   if(field==='name')return name.value.trim();
   if(field==='tax')return original.tax;
   return editor?.isDirty()?sourceFields(sourceAddonFields(editor.read(validate))).addon:sourceFields(original).addon;
  }
  const valid=(key,val)=>key==='name'?!!val:key==='tax'?Number.isFinite(val)&&val>=0:!!val;
  function refresh(){
   const active=drawer.scope===id,overrides=overriddenFields(),eligible=overrides.filter(key=>!restore.has(key));
   bar.hidden=!active||!store||scope!=='shared'||!overrides.length;preview.hidden=!active;
   if(!active)return;
   const tax=restore.has('tax')?shared.tax:original.tax;
   drawerHost.querySelector('[data-original-tax]').textContent=money(tax==null?null:Math.round(tax*100));
   if(!store)return;
   pane.querySelector('[data-sheet-drawer-tax]').textContent=taxLabel(tax);
   const badge=pane.querySelector('[data-price-state]'),exclusive=eligible.includes('tax');
   badge.className='badge '+(exclusive?'badge-low':'badge-cat');badge.textContent=exclusive?'独享':'共用';
   bar.querySelector('[data-override-label]').textContent=scopeName(id)+'已单独覆盖'+overrides.map(key=>'「'+sharedSourceLabels[key]+'」').join('');
   refreshRestore();
   promote.disabled=!edited||!eligible.some(key=>key==='addon'||valid(key,value(key)));
   const promoted=[...drawer.promotions].filter(([,entry])=>entry.id===id).map(([key])=>sharedSourceLabels[key]);
   if(promoted.length)bar.querySelector('[data-restore-hint]').textContent=promoted.join('、')+'将在应用草稿时统一到三店';
  }
  promote.onclick=()=>{
   try{
    const changes=overriddenFields().filter(key=>!restore.has(key)).map(key=>[key,value(key,true)]);
    for(const [key,val] of changes)if(valid(key,val))drawer.promotions.set(key,{id,value:val});
    refresh();updateStatus();
   }catch(error){message(error.message);}
  };
  mountAddon(original);
  if(name){name.readOnly=!edited;name.oninput=()=>{clearIntent('name');refresh();updateStatus();};}
  const dirty=()=>restore.size>0||!!name&&name.value!==original.name||!!editor?.isDirty()||
   [...drawer.promotions.values()].some(entry=>entry.id===id);
  return {pane,preview,bar,dirty,refresh,read(){
   const values={};
   if(name&&!restore.has('name')&&name.value.trim()!==original.name){
    if(!name.value.trim())throw Error('请填写展示名称，或使用恢复共用');
    values.name=name.value.trim();
   }
   if(editor?.isDirty()&&!restore.has('addon'))values.addon=value('addon',true);
   return {id,values,restore:[...restore]};
  }};
 }
 function makeDetailsPanel(host,item,id){
  const row=views.get(item.id).scopeRows.get(id),pane=document.createElement('section');
  const restore=new Set();
  pane.className='ss-drawer-pane';
  pane.innerHTML=`<div class="ss-details-preview"><dl>${[...views.get(item.id).scopeRows].map(([target,actual])=>
   `<dt>${esc(scopeName(target))}</dt><dd>${esc(actual.name||'待设共用名称')} · ${actual.tax==null?'待填核算价':esc(actual.tax)} · ${esc(baseInfo({...views.get(item.id),common:actual}))}</dd>`).join('')}</dl></div>
   ${Object.entries(item.entry.stores).filter(([,aliases])=>aliases.length>1).map(([store,aliases])=>`<label class="field">${esc(scopeName(store))}历史别名<select data-sheet-alias="${store}"><option value="">查看历史记录</option>${aliases.map(alias=>
   `<option value="${esc(alias.sourceId)}">${esc(alias.fields.name||alias.sourceId)}</option>`).join('')}</select></label><p data-sheet-alias-preview="${store}" class="ss-muted"></p>`).join('')}
   ${capacityFieldsHtml(row)}${hardwareFieldsHtml(row)}
   ${scope==='shared'&&id!=='shared'?`<div class="ss-drawer-actions" data-detail-restore hidden>
    ${action('drawer-restore-details','恢复本店基础信息为共用',`data-restore-fields="${detailKeys.join(' ')}"`)}
    <small class="ss-muted" data-restore-hint></small></div>`:''}
   ${api.setDeleted&&!created.has(item.id)&&api.canManage!==false?action('archive',item.base.deletedAt!=null?'恢复输出源':'停用输出源','class="ss-archive"'):''}`;
  host.append(pane);
  updateMaintenanceVisibility(pane,row,api.getConfigs(),api.getCosts(),{isNew:created.has(item.id)});
  updateCapacityHints(pane,row.erpName||row.name);
  updateHardwareHints(pane,row);
  const starting=sourceFields(row);
  const read=validate=>{
   const next=sourceFields({...row,capacityOverrides:readCapacityFields(pane,validate),hardwareOverrides:readHardwareFields(pane)});
   return Object.fromEntries(detailKeys.filter(key=>!restore.has(key)&&!equal(starting[key],next[key])).map(key=>[key,next[key]]));
  };
  const hints=()=>{updateCapacityHints(pane,row.erpName||row.name);updateHardwareHints(pane,row);};
  const refreshRestore=drawerRestores(pane,item,id,restore,detailKeys,refresh);
  function refresh(){
   const row=views.get(item.id);
   const actions=pane.querySelector('[data-detail-restore]');
   if(actions)actions.hidden=!storeFields(row,id).some(field=>detailKeys.includes(field))&&!restore.size;
   const common=sourceFields(row.common);
   for(const field of restore){
    for(const input of pane.querySelectorAll(detailControls[field])){
     if(input.type==='checkbox')input.checked=common[field]?.includes(input.dataset.caseBoard)??false;
     else input.value=common[field]??'';
    }
   }
   if(restore.size)hints();
   refreshRestore();
  }
  pane.querySelectorAll('fieldset input,fieldset select').forEach(input=>{input.disabled=!editable(item);});
  pane.oninput=event=>{
   const field=detailKeys.find(key=>event.target.matches(detailControls[key]));
   if(field){restore.delete(field);hints();refresh();updateStatus();}
  };
  for(const select of pane.querySelectorAll('[data-sheet-alias]'))select.onchange=()=>{
   const store=select.dataset.sheetAlias,alias=item.entry.stores[store].find(record=>record.sourceId===select.value);
   pane.querySelector(`[data-sheet-alias-preview="${store}"]`).textContent=alias?
    Object.entries(alias.fields).map(([key,value])=>sharedSourceLabels[key]+' '+(typeof value==='object'?JSON.stringify(value):String(value??'待填'))).join(' · '):'';
  };
  return {pane,refresh,dirty:()=>restore.size>0||Object.keys(read(false)).length>0,read:()=>({id,values:read(true),restore:[...restore]})};
 }
 function showDrawer(item,panel,requested=scope){
  if(!item||busy)return;
  const id=drawerScopes.includes(requested)?requested:scope;
  if(drawer&&(drawer.id!==item.id||drawer.kind!==panel)){
   if(dirtyDrawer()){
    message('「'+drawer.label+'」有未应用修改，请从底部回到未应用抽屉');return;
   }
   clearDrawer();
  }
  if(!drawer){
   const label=(item.erpName||views.get(item.id).common.name||'特殊配件')+' · '+(item.base.goodsId||item.category);
   drawer={id:item.id,kind:panel,label,panels:new Map(),promotions:new Map()};
const row=views.get(item.id),addons=panel==='addons';
   drawerHost.dataset.kind=panel;
   const tabs=`<div class="ss-drawer-tabs" role="tablist" aria-label="维护范围">${drawerScopes.map(target=>
    action('drawer-scope',esc(scopeName(target))+(row.differences.some(diff=>diff.scope===target)?'<i class="dot-override" aria-label="有独享设置"></i>':''),
     `class="scope-tab" data-scope="${esc(target)}" role="tab"`)).join('')}</div>`;
   const close=action('close-drawer','✕','class="wb-btn wb-btn-sm" aria-label="关闭编辑抽屉"');
   drawerHost.innerHTML=(addons?`<header class="ss-addon-header"><div class="ss-addon-identity"><div>
    <div class="ss-addon-title"><h2>升级项与单店覆盖</h2><span class="badge badge-cat">${esc(row.category)}</span><small>#${esc(item.base.goodsId||'—')}</small></div>
    <p>原配件：<strong>${esc(item.erpName||row.common.name)}</strong></p></div>
    <div class="ss-original-cost"><div>ERP <b>${money(row.erp)}</b></div><div>核算 <b data-original-tax></b></div></div>${close}</div>
    <div class="ss-scope-line">${tabs}${action('drawer-help','填写说明 ▾','class="wb-btn wb-btn-sm" aria-expanded="false"')}</div>
    <div data-drawer-help hidden>每个方案独立核算差价：<strong>原配件成本 × 原替换数量 + 加购价 − 新配件成本 × 新配件数量</strong>。例如内存 1 根升 2 根，原替换数量填 1，新数量填 2。纯文字说明不参与差价核算。</div>
    <div data-drawer-overrides></div></header><div data-drawer-previews></div>`:
    `<header><div><h2>基础信息</h2><p>${esc(label)}</p></div>${close}</header>${tabs}`)+
    `<div class="ss-drawer-content"></div><footer><span data-sheet-drawer-message role="status">${addons?'改动先应用到输出源草稿，最后点主表右下角统一保存':''}</span>
    ${action('discard-drawer','放弃修改','class="wb-btn"')}${action('apply-drawer','应用到草稿','class="wb-btn wb-btn-primary wb-cut primary"')}</footer>`;
   const help=drawerHost.querySelector('[data-sheet-action=drawer-help]');
   if(help)help.onclick=()=>{
    const tip=drawerHost.querySelector('[data-drawer-help]');tip.hidden=!tip.hidden;
    help.setAttribute('aria-expanded',String(!tip.hidden));help.textContent='填写说明 '+(tip.hidden?'▾':'▴');
   };
  }
  drawerHost.hidden=false;shade.hidden=false;drawer.scope=id;
  if(!drawer.panels.has(id)){
   const container=drawerHost.querySelector('.ss-drawer-content');
   drawer.panels.set(id,panel==='details'?makeDetailsPanel(container,item,id):makeAddonPanel(container,item,id));
  }
  for(const [target,current] of drawer.panels){current.pane.hidden=target!==id;if(target!==id&&current.bar){current.bar.hidden=true;current.preview.hidden=true;}}
  drawer.panels.get(id).refresh();
  drawerHost.querySelectorAll('[role="tab"]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.scope===id)));
  updateStatus();
 }
 function applyDrawer(){
  if(!drawer||busy)return false;
  const item=itemById(drawer.id);
  if(!editable(item)){clearDrawer();updateStatus();return true;}
  try{
   const before=pending.get(item.id);
   let next=before;
   const changes=[...drawer.panels.values()].filter(panelDirty).map(panel=>panel.read()).sort((a,b)=>Number(b.id==='shared')-Number(a.id==='shared'));
   for(const {id,values,restore} of changes){
    for(const field of restore){
     const row=project(item,next);
     if(!storeFields(row,id).includes(field))continue;
     if(!sourceSheetCommonCanRestore(row,field))throw Error(restoreHint([field]));
     next=editSourceSheetField(item,next,id,field,null,{restore:true});
    }
    for(const [field,value] of Object.entries(values))next=editSourceSheetField(item,next,id,field,value);
   }
   for(const [field,{value}] of drawer.promotions)next=promoteSourceSheetField(item,next,field,value);
   clearDrawer();setDraft(item,next);message(equal(before,next)?'没有需要应用的修改':'已应用到草稿');return true;
  }catch(error){message(error.message);return false;}
 }
 async function toggleArchive(){
  if(!drawer||!api.setDeleted||busy)return;
  if(hasPending()){message('请先保存或放弃待保存修改');return;}
  const item=itemById(drawer.id),row=item.aliases.find(alias=>alias.shopId===shop);
  if(!row||api.canEdit?.(row)===false){message('当前店没有可停用或恢复的输出源');return;}
  const deleting=row.deletedAt==null;
  if(!confirm(deleting?'停用这条本店输出源？已有配置会保留。':'恢复这条本店输出源？'))return;
  busy=true;updateStatus();
  try{await api.setDeleted(row.sourceId,deleting);clearDrawer();readRows();refreshTable();message(deleting?'已停用本店输出源':'已恢复本店输出源');}
  catch(error){message(error.message);}
  finally{busy=false;updateStatus();}
 }

 async function save(){
  if(busy)throw Error('正在保存，请稍候');
  if(editing)finishEditing(editing.field);
  if(dirtyDrawer()){drawerHost.hidden=false;shade.hidden=false;message('请先将抽屉修改应用到草稿');throw Error('抽屉修改尚未应用');}
  if(!pending.size)return;
  busy=true;message(`正在保存 ${pending.size} 条输出源修改`);updateStatus();root.classList.add('ss-saving');
  try{
   const changes=[...pending].flatMap(([id,draft])=>sourceSheetChanges(itemById(id),draft));
   let confirmedSource;
   if(changes.length){
    const result=await api.applyBatch(changes);automatic.record(result.autoChanges);
    if(marked)confirmedSource=result.sourceIds?.[itemById(marked)?.base.sourceId];
   }
   message(`已保存 ${pending.size} 条输出源修改`);pending.clear();created.clear();clearDrawer();readRows();
   if(confirmedSource&&!views.has(marked))marked=[...views.values()].find(row=>row.aliases.some(alias=>alias.sourceId===confirmedSource))?.id??'';
   refreshTable();
  }catch(error){message('保存未完成，草稿已保留。'+(error.message||error));throw error;}
  finally{busy=false;root.classList.remove('ss-saving');updateStatus();}
 }
 function discard(){
  if(!hasPending()||busy||!confirm('放弃本次尚未保存的输出源修改？'))return;
  if(editing)finishEditing(editing.field,true);
  pending.clear();created.clear();clearDrawer();readRows();refreshTable();message('已放弃未保存修改');
 }
 function sheetRows(){
  return [...views.values()].flatMap(item=>item.aliases.filter(alias=>alias.shopId===shop).map(row=>sourceSheetEffective(item,item.draft,row)));
 }
 function exportRows(){
  try{
   const rows=sourceExportRows(sheetRows(),api.getCosts(),shop);
   if(!rows.length)throw Error('本店没有可导出的在用输出源');
   const stamp=new Date().toLocaleDateString('sv-SE');api.download(sourceExportWorkbook(rows),`${shopById(shop).name}_输出源_${stamp}.xlsx`);
   message(`已开始导出本店 ${rows.length} 条输出源`);
  }catch(error){message(error.message);}
 }
 function childDialog(title){
  sync?.dispose();sync=null;
  api.openDialog(title,'<section data-sheet-child></section>');
  return document.querySelector('[data-sheet-child]');
 }
 function audit(){
  const host=childDialog('检查加购差价');
  mountAddonAudit(host,{getRows:sheetRows,getCosts:api.getCosts,getConfigs:api.getConfigs,
   stage:()=>!busy,close:api.closeDialog,edit:id=>{
    api.closeDialog();locate(id);
    const row=[...views.values()].find(candidate=>candidate.aliases.some(alias=>alias.sourceId===id));
    showDrawer(row,'addons');
   }});
 }
 function review(view){
  const host=childDialog(view==='automatic'?'本次变动':'待确认差异');
  let firstRead=true;
  sync=mountSourceSync(host,{getRows:api.getReviewRows??sheetRows,getConfigs:api.getConfigs,shopId:api.shopId,isEdited:hasPending,
   flush:async()=>{await api.flush();if(firstRead){await api.refreshAlerts?.();firstRead=false;}},
   saveSkuMode:api.saveSkuMode,apply:api.applySync,validateImage:api.validateImage,download:api.download,
   prepareExport:api.prepareExport,onChanged:api.refreshAlerts,message,view,deferRefresh:true});
  if(view==='automatic')sync.showAutomaticChanges(automatic.records);
  else void sync.refresh();
 }
 function restoreAll(item,store){
  if(!item||!editable(item))return;
  const {targets,blocked}=sourceSheetRestorePlan(views.get(item.id),store);
  if(!targets.length)return;
  let next=pending.get(item.id);
  for(const {scope,field} of targets)next=editSourceSheetField(item,next,scope,field,null,{restore:true});
  setDraft(item,next);
  message('已加入恢复共用草稿，保存后生效'+(blocked.length?'。'+restoreHint(blocked):''));
 }
 function leave(){
  if(hasPending()){message('请先保存全部更改或放弃更改');api.toast?.('请先处理输出源未保存修改');return false;}
  dispose();return true;
 }
 function dispose(){
  if(disposed)return;
  disposed=true;deleted.hide();closeCombo();controller.abort();observer.disconnect();sync?.dispose();clearDrawer();root.replaceChildren();
  workspace.classList.remove('source-sheet-active');root.hidden=true;
  if(globalThis.workbenchSourceEditor===editor)delete globalThis.workbenchSourceEditor;
  api.onClose?.();
 }
 const editor={sheet:true,hasPending,save,leave,locate,dispose,restore:()=>{root.hidden=false;workspace.classList.add('source-sheet-active');},
  // 通用弹窗打开和回收时，只释放弹窗内节点。工作表与抽屉始终独立。
  detachForDialog(){}};
 globalThis.workbenchSourceEditor=editor;
 const observer=new IntersectionObserver(records=>{if(records.some(record=>record.isIntersecting)&&cursor<display.length)appendRows();},{root:grid,rootMargin:'420px'});
 observer.observe($('[data-sheet-more]'));
 root.addEventListener('input',event=>{
  if(event.target.id==='source-sheet-filter'){query=event.target.value;refreshTable(true);}
  else if(event.target===combo)comboSearch();
  else if(event.target.matches('[data-sheet-field]')){previewTaxRestore(event.target);updateStatus();}
 },events);
 root.addEventListener('change',event=>{
  if(event.target.id!=='source-sheet-shop')return;
  const id=event.target.value;
  if(id===shop)return;
  event.target.value=shop;
  if(leave())api.changeShop?.(id);
 },events);
 root.addEventListener('focusin',event=>{if(event.target.matches('[data-sheet-field]'))startEditing(event.target);},events);
 root.addEventListener('focusout',event=>{
  if(event.target.matches('[data-sheet-field]'))finishEditing(event.target);
  if(event.target===combo&&!options.contains(event.relatedTarget))closeCombo();
 },events);
 // 同行按钮先接收 click，再提交编辑。即使提交后差异消失或行退出筛选，这次点击也能打开抽屉。
 body.addEventListener('pointerdown',event=>{
  const button=event.target.closest('button[data-sheet-action]');
  if(event.button===0&&button&&!button.disabled&&editing&&button.closest('[data-sheet-row]')?.dataset.sheetRow===editing.id)event.preventDefault();
 },events);
 options.addEventListener('pointerdown',event=>{if(event.target.closest('[role="option"]'))event.preventDefault();},events);
 document.addEventListener('keydown',event=>{
  if(event.isComposing||document.querySelector('#dialog')?.open||!root.contains(event.target)&&event.key!=='Escape')return;
  if(event.target===combo&&!options.hidden&&['ArrowUp','ArrowDown','Enter'].includes(event.key)){
   event.preventDefault();if(!comboItems.length)return;
   if(event.key==='Enter'){void selectErp(comboIndex);return;}
   comboIndex=(comboIndex+(event.key==='ArrowDown'?1:-1)+comboItems.length)%comboItems.length;
   options.querySelectorAll('[role="option"]').forEach((option,index)=>option.setAttribute('aria-selected',String(index===comboIndex)));
   const selected=options.children[comboIndex];combo.setAttribute('aria-activedescendant',selected.id);selected.scrollIntoView({block:'nearest'});return;
  }
  if(event.defaultPrevented)return;
  if(event.key==='Escape'&&!options.hidden){event.preventDefault();closeCombo();return;}
  if(event.target.matches('[data-sheet-field]')&&['Enter','Escape'].includes(event.key)){
   event.preventDefault();finishEditing(event.target,event.key==='Escape');event.target.blur();return;
  }
  if(event.key==='Escape'&&!drawerHost.hidden){
   const picker=event.target.closest('.product-search');
   if(picker&&picker.querySelector('input[aria-expanded="true"]'))return;
   event.preventDefault();closeDrawer();
  }
 },events);
 root.addEventListener('click',event=>{
  const button=event.target.closest('[data-sheet-action]');if(!button||button.disabled)return;
  const name=button.dataset.sheetAction,id=button.closest('[data-sheet-row]')?.dataset.sheetRow,item=itemById(id);
  if(busy&&name!=='more')return;
  const cellStore=button.closest('[data-store]')?.dataset.store;
  if(editing&&id===editing.id){
   const field=editing.field;
   finishEditing(field);field.blur();
  }
  switch(name){
   case 'back':leave();break;
   case 'category':category=button.dataset.category;refreshTable(true);break;
   case 'price-filter':priceFilter=button.dataset.priceFilter;refreshTable(true);break;
   case 'filter':filter=button.dataset.filter;if(filter==='deleted')category='全部配件';refreshTable(true);break;
   case 'toggle-group':{const key=button.dataset.category;collapsed.has(key)?collapsed.delete(key):collapsed.add(key);refreshTable();break;}
   case 'common':case 'stores':mode=name;root.querySelectorAll('.ss-segments button').forEach(control=>control.setAttribute('aria-pressed',String(control===button)));refreshTable(true);break;
   case 'name-scope':{
    const target=button.dataset.scope,store=cellStore;
    sideScopes.set(JSON.stringify([id,store]),target);refreshRow(id);
    body.querySelector(`${rowSelector(id)} [data-display-store="${store}"]`)?.focus();break;
   }
   case 'restore-name':
    if(restorableFields(views.get(id),button.dataset.scope).has('name'))changeField(item,button.dataset.scope,'name',null,true);
    break;
   case 'restore-store':restoreAll(item,button.dataset.scope);break;
   case 'restore-all':restoreAll(item);break;
   case 'reset-row':
    if(drawer?.id===id)clearDrawer();
    if(created.has(id)){
     created.delete(id);pending.delete(id);views.delete(id);
     if(marked===id)marked='';
     refreshRow(id);
    }
    else setDraft(item,undefined);break;
   case 'addons':showDrawer(item,'addons',button.dataset.scope);break;
   case 'store-addons':showDrawer(item,'addons',button.dataset.scope);break;
   case 'store-override':{
    const target=button.dataset.scope,fields=storeFields(views.get(id),target);
    showDrawer(item,fields.length&&fields.every(field=>detailKeys.includes(field))?'details':'addons',target);break;
   }
   case 'details':showDrawer(item,'details');break;
   case 'drawer-scope':if(drawer)showDrawer(itemById(drawer.id),drawer.kind,button.dataset.scope);break;
   case 'resume-drawer':if(drawer)showDrawer(itemById(drawer.id),drawer.kind,drawer.scope);break;
   case 'close-drawer':closeDrawer();break;
   case 'discard-drawer':clearDrawer();updateStatus();break;
   case 'apply-drawer':applyDrawer();break;
   case 'archive':void toggleArchive();break;
   case 'erp-pick':void selectErp(Number(button.dataset.index));break;
   case 'add-part':openAddPart();break;
   case 'more':appendRows();break;
   case 'export':exportRows();break;
   case 'audit':audit();break;
   case 'differences':review('pending');break;
   case 'automatic':review('automatic');break;
   case 'save':void save().catch(()=>{});break;
   case 'discard':discard();break;
  }
 },events);
 document.addEventListener('pointerdown',event=>{if(!event.target.closest('.ss-combo')&&!options.hidden)closeCombo();},events);
 // 顶栏、左侧导航与浮层显示同一份本店计数。
 function updateDiffBadge(){
  const badge=$('[data-diff-badge]');if(!badge)return;
  const data=document.body.dataset,count=data.sourceDiffShop===shop?Number(data.sourceDiffCount)||0:0;
  badge.textContent=String(count);badge.className='badge '+(count?'badge-out':'badge-unk');
  badge.parentElement.classList.toggle('has-source-diffs',count>0);
 }
 document.addEventListener('source-diff-change',updateDiffBadge,events);
 updateDiffBadge();
 const autoBadge=$('[data-auto-badge]');
 if(autoBadge){
  const updateCount=()=>{autoBadge.hidden=automatic.count===0;autoBadge.textContent=String(automatic.count);};
  automatic.addEventListener('change',updateCount,events);updateCount();
 }
 document.querySelector('#dialog')?.addEventListener('close',event=>{
  if(!event.target.open){sync?.dispose();sync=null;}
 },events);
 editor.restore();readRows();refreshTable(true);
 if(api.focusSourceId)locate(api.focusSourceId);
 else $('#source-sheet-filter').focus();
 return editor;
}
