import {updateMaintenanceVisibility} from './source-maintenance-view.js';
import {hardwareFieldsHtml,readHardwareFields,updateHardwareHints} from './source-hardware-ui.js';
import {capturePanelTransition} from './endfield-motion.js';
import {capacityFieldsHtml,readCapacityFields,updateCapacityHints} from './source-capacity-ui.js';
/** 输出源编辑弹窗：维护商品绑定、展示内容、加购及同步预览，统一提交草稿。 */
import {configCostLinksHtml} from './config-cost.js';
import {mountSourceProductLookup} from './source-product-lookup.js';
import {componentStockHtml} from './component-stock-view.js';
import {sourceExportRows,sourceExportWorkbook} from './source-export.js';
import {shopById,shops} from './shops.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';
import {mountSourceSync} from './source-sync-ui.js';
import {mountShopAddons} from './shop-addon-ui.js';
import {excludedComponent} from './component-policy.js';
import {clone,erpUnitCost} from './core.js';
import {sourceAddon,sourceAddonFields,selectedSourceAddons,validateAddon} from './addon-data.js';
import {mountAddonAudit} from './addon-audit.js';
import {mountSharedAddons,mountSharedScope,sharedScopeRow,newSharedScopeRow,sourceFieldPatch,applySharedTaxEdit} from './shared-source-editor.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'显示名称',tax:'含税核算单价',addon:'加购文案'};

/** 构建来源编辑会话，使用实时业务 API 获取数据并处理保存。 */
export function openSourceEditor(liveApi){
 const previous=window.workbenchSourceEditor;
 if(previous?.hasPending()){previous.restore();return;}
 previous?.dispose();
 const pending=new Map();
 const overlay=rows=>{const result=rows.map(r=>pending.has(r.sourceId)?clone(pending.get(r.sourceId).row):r);for(const {row} of pending.values())if(!result.some(r=>r.sourceId===row.sourceId)&&row.shopId===liveApi.shopId())result.push(clone(row));return result;};
 const api={...liveApi,getRows:()=>overlay(liveApi.getRows()).filter(r=>r.shopId===liveApi.shopId()),getAllRows:()=>overlay(liveApi.getAllRows())};
 let selectionBaseline=new Map(),productLookup,formBaseline=null,managed=null;
 const shared=api.sharedSources;
 const title=api.quickEdit?'修改输出源':shared?'输出源维护':'本店输出源维护';

 let selectedId=null,page=0,draft=null,preview=null,busy=false,showDeleted=false,specialOnly=false,addonFields,sourceSync;
 api.openDialog(title,`
 <section id="source-cost-overrides"></section>
 <div class="source-window-intro"><details><summary>维护说明</summary><p class="hint">名称和加购可按店维护，核算单价三店共用。切换配件保留草稿，底部统一保存。加购不计入整机成本。</p></details><span id="source-context"></span></div>
 <div class="source-change-entry"><button type="button" id="source-open-changes">本次变动 <span data-source-change-count>0</span></button><button type="button" id="source-open-pending">待确认差异</button></div>
 <div class="source-toolbar"><input id="source-search" type="search" placeholder="搜索名称、ERP ID 或加购文案" aria-label="搜索输出源"><button type="button" id="source-export" title="导出本店全部在用输出源，包含当前未保存内容">导出本店表格</button><button type="button" id="source-addon-check">检查加购差价</button><button type="button" id="source-new" class="primary">＋ 新增配件</button></div>
 <div id="source-addon-report"></div>
 <div class="source-workspace"><div class="source-list-panel"><div class="source-list-heading"><div id="source-count" class="hint"></div><div class="source-list-filters"><button type="button" id="source-special-list">特殊配件</button><button type="button" id="source-deleted">已删除</button></div></div><div id="source-list"></div><div class="source-pagination"><button type="button" id="source-prev">上一页</button><span id="source-page"></span><button type="button" id="source-next">下一页</button></div></div><div id="source-detail"><p class="hint">从左侧选择需要维护的配件。</p></div></div>
 <div id="source-quick-preview" class="source-quick-preview"><span>合并展示预览</span><p></p></div>
 <footer class="source-batch-bar"><div class="source-footer-status"><strong id="source-pending">暂无待保存修改</strong><p class="hint">切换商品会保留修改；全部编辑完成后统一保存到本机。</p></div><button type="button" id="source-discard-all">放弃全部更改</button><button type="button" id="source-save-all" class="primary">保存全部更改</button></footer>
 <div id="source-message" role="status" class="hint"></div>`);
 // The shared dialog can be replaced by a save-conflict panel. Keep this
 // editor's inputs together so retries/quit save the original draft, never the
 // replacement panel or a different editor with the same field IDs.
 const dialog=document.querySelector('#dialog'),body=document.querySelector('#dialog-body');
 const root=document.createElement('div');root.className='source-editor-root';
 root.append(...body.childNodes);body.append(root);
 api.render?.(root,{nas:api.nas,shared:!!shared,preview:!!shared?.preview,quickEdit:!!api.quickEdit});
 const $=s=>root.querySelector(s),$$=s=>[...root.querySelectorAll(s)];
 dialog.classList.add('source-dialog');
 dialog.classList.toggle('source-quick-dialog',!!api.quickEdit);
 // 两种窗口共用原保存入口，快速编辑只改变按钮文字和只读预览。
 if(api.quickEdit){$('#source-save-all').textContent='保存输出源';$('#source-discard-all').textContent='放弃修改';}
 const message=text=>$('#source-message').textContent=text;
 $('#source-cost-overrides').onclick=async event=>{
  const button=event.target.closest('[data-update-link-cost]');if(!button||busy)return;
  busy=true;button.disabled=true;message('正在更新本链接核算价…');
  try{const result=await api.updateLinkCosts(button.dataset.updateLinkCost);list();sourceSync?.invalidate();message(`已更新 ${result.ids.length} 套配置、${result.count} 项核算价。${result.skipped?'另有 '+result.skipped+' 项无有效共用价，保留单独价。':''}`);}
  catch(error){message('更新未完成：'+error.message);}
  finally{busy=false;button.disabled=false;}
 };
 // 两个独立弹窗复用同一业务组件，各自保留筛选、分页和选择状态。
 const changeWindows=[];
 const createChangeWindow=view=>{
  const modal=document.createElement('dialog');modal.className='source-changes-dialog';modal.setAttribute('aria-label',view==='automatic'?'本次变动':'待确认差异');
  const close=document.createElement('button');close.type='button';close.className='source-changes-close';close.textContent='×';close.setAttribute('aria-label','关闭');
  const host=document.createElement('section');modal.append(close,host);document.body.append(modal);
  const sync=mountSourceSync(host,{getRows:api.getRows,getConfigs:api.getConfigs,shopId:api.shopId,isEdited:()=>pending.size>0||!!draft&&isEdited(),flush:api.flush,saveSkuMode:api.saveSkuMode,apply:api.applySync,validateImage:api.validateImage,download:api.download,message,view,deferRefresh:true});
  close.onclick=()=>{if(!sync.isBusy())modal.close();};
  const entry={modal,sync,open:async()=>{if(busy)return;modal.showModal();if(view==='pending')await sync.refresh();}};changeWindows.push(entry);return entry;
 };
 const automaticWindow=createChangeWindow('automatic'),pendingWindow=createChangeWindow('pending');
 $('#source-open-changes').onclick=()=>automaticWindow.open();$('#source-open-pending').onclick=()=>pendingWindow.open();
 sourceSync={invalidate:()=>pendingWindow.sync.invalidate(),refresh:()=>pendingWindow.modal.open?pendingWindow.sync.refresh():Promise.resolve(),showAutomaticChanges:records=>{automaticWindow.sync.showAutomaticChanges(records);$('[data-source-change-count]').textContent=records.filter(c=>(c.before.shopId||'intel')===api.shopId()).length;},dispose:()=>changeWindows.forEach(({modal,sync})=>{sync.dispose();modal.close();modal.remove();})};

 const filtered=()=>{const q=$('#source-search').value.trim().toLowerCase();const rows=api.getRows().filter(r=>!!r.deletedAt===showDeleted&&(!specialOnly||isSpecialComponent(r))&&[r.name,r.goodsId,r.addonText,...(shared?.searchNames(r)||[])].join(' ').toLowerCase().includes(q));
  return showDeleted||!shared?rows:shared.dedupe(rows);
 };
 function list(){$('#source-cost-overrides').innerHTML=configCostLinksHtml(api.getConfigs(),api.shopId());const rows=filtered(),pages=Math.max(1,Math.ceil(rows.length/24));page=Math.min(page,pages-1);$('#source-count').textContent=`共 ${api.getRows().filter(r=>!r.deletedAt).length} 条在用，匹配 ${rows.length} 条`;$('#source-list').innerHTML=rows.slice(page*24,page*24+24).map(r=>`<button class="source-item ${r.sourceId===selectedId?'active':''}" data-source-id="${esc(r.sourceId)}"><strong>${esc(r.name)}${pending.has(r.sourceId)?' · 待保存':''}</strong><small>${isSpecialComponent(r)?'特殊配件 · 无 goodsId':'ID '+esc(r.goodsId)} · 核算 ${r.tax==null?'待填':'¥'+Number(r.tax).toFixed(2)}</small>${componentStockHtml(r,api.getCosts())}</button>`).join('')||'<p class="hint">没有匹配项。</p>';$('#source-page').textContent=`${page+1} / ${pages}`;$('#source-prev').disabled=page===0;$('#source-next').disabled=page===pages-1;$$('[data-source-id]').forEach(b=>b.onclick=()=>{if(busy)return;if(!stageCurrent())return;select(api.getRows().find(r=>r.sourceId===b.dataset.sourceId));});}
 function isEdited(){try{return draft&&!draft.deletedAt&&(managed?.taxEdited||$('#source-new-shops')&&pending.has(draft.sourceId)&&JSON.stringify($$('[data-source-new-shop]:checked').map(input=>input.dataset.sourceNewShop))!==JSON.stringify(pending.get(draft.sourceId).targetShopIds)||addonFields.isDirty()||JSON.stringify(read(false))!==(formBaseline??JSON.stringify(draft)));}catch{return true;}}
 function updatePending(){
  const n=pending.size+(draft&&isEdited()&&!pending.has(draft.sourceId)?1:0);
  $('#source-pending').textContent=n?`待保存 ${n} 条输出源（含勾选店铺）`:'暂无待保存修改';
  root.classList.toggle('has-source-pending',n>0);
  const target=$('#source-quick-preview p');
  if(target&&addonFields){try{target.textContent=selectedSourceAddons(sourceAddonFields(addonFields.read(false))).map(addon=>addon.text?.trim()).filter(Boolean).join(' ')||'暂不展示加购';}catch(error){target.textContent=error.message;}}
 }
 function invalidate(){preview=null;sourceSync?.invalidate();if(draft&&addonFields)updatePending();}
 function stageCurrent(){
  if(productLookup?.isPending()){message('正在读取 ERP 名称和单价，请查询完成后再保存或切换。');return false;}
  if(!draft||!isEdited())return true;
  try{
   if(managed){stageManaged(read());updatePending();return true;}
   const visible={...read(),shopId:api.shopId()},related=addonFields.changes();
   const saved=selectionBaseline.get(visible.sourceId);
   if(saved&&api.canEdit&&!api.canEdit(saved))throw Error('此来源为共享或其他店铺所有，当前账号只读');
   const raw=pending.get(visible.sourceId)?.row||saved;
   const row=api.project&&raw&&formBaseline?api.project(raw,JSON.parse(formBaseline),visible):visible;
   const put=value=>{const existing=pending.get(value.sourceId),before=existing?existing.before:selectionBaseline.get(value.sourceId)||null;pending.set(value.sourceId,{before:clone(before),row:clone(value)});};
   put(row);
   if(api.nas)pending.get(row.sourceId).targetShopIds=[api.shopId()];
   else if($('#source-new-shops'))pending.get(row.sourceId).targetShopIds=$$('[data-source-new-shop]:checked').map(input=>input.dataset.sourceNewShop);
   if(!api.nas)for(const change of related){if(change.sourceId===row.sourceId)continue;const original=api.getAllRows().find(r=>r.sourceId===change.sourceId);put({...original,...sourceAddonFields(change.addon)});}
   updatePending();return true;
  }catch(e){message(e.message+'；请修正当前商品后再切换或保存。');return false;}
 }
 // 范围切换先记录本范围的改动；同一 ERP ID 的多个范围作为一条事务提交。
 function stageManaged(value,fieldChange=null){
  const {base,entry,scope}=managed;
  const previous=pending.get(base.sourceId)?.managed;
  const edits=clone(previous?.edits||{});
  // 新建共用资料与店铺差异一起暂存，切换范围不把当前店内容当成新的共用基线。
  const creationBase=!entry?{...clone(base),shopId:base.shopId||api.shopId(),goodsId:value.goodsId,specialComponent:isSpecialComponent(value),...(value.erpName?{erpName:value.erpName}:{})}:null;
  if(creationBase&&!edits.shared)edits.shared={values:sourceFieldPatch(null,creationBase),restore:[]};
  const change=edits[scope]??={values:{},restore:[]};
  const patch=sourceFieldPatch(formBaseline?JSON.parse(formBaseline):null,value);
  const put=(key,value,restore=false)=>{
   change.restore=change.restore.filter(item=>item!==key);
   if(restore){delete change.values[key];change.restore.push(key);}
   else change.values[key]=value;
  };
  for(const [key,content] of Object.entries(patch))put(key,content);
  // 店铺原价覆盖不能遮住本次明确设置的共用核算价；名称、加购和配置独立价不受影响。
  if(entry&&scope==='shared'&&(Object.hasOwn(patch,'tax')||managed.taxEdited))applySharedTaxEdit(edits,value.tax);
  if(fieldChange)put(...fieldChange);
  const raw=selectionBaseline.get(base.sourceId);
  if(!Object.keys(change.values).length&&!change.restore.length)delete edits[scope];
  if(creationBase&&isSpecialComponent(value))for(const [scope,edit]of Object.entries(edits)){
   edit.values=Object.fromEntries(Object.entries(edit.values).filter(([key])=>key==='name'));edit.restore=edit.restore.filter(key=>key==='name');
   if(!Object.keys(edit.values).length&&!edit.restore.length)delete edits[scope];
  }
  if(!Object.keys(edits).length)return;
  const effective=entry?sharedScopeRow(base,entry,api.shopId(),edits):newSharedScopeRow(creationBase,api.shopId(),edits);
  const id=entry?.id??(isSpecialComponent(value)?'special:'+base.sourceId:value.goodsId);
  pending.set(base.sourceId,{before:raw||null,row:effective,...(creationBase?{creationBase}:{}),managed:{id,version:entry?.version??null,edits,
   ...(!entry&&value.erpName?{erpName:value.erpName}:{})}});
 }
 async function saveAll(){
  if(busy)throw Error('正在保存，请完成后再关闭。');
  if(!stageCurrent())throw Error('当前商品尚未通过校验');
  if(!pending.size){message('没有待保存修改。');return;}
  for(const {managed}of pending.values())if(managed&&!managed.version&&!managed.edits.shared?.values?.name){message('新配件请先填写三店共用的产品显示名称；各店输入仍保留。');throw Error('缺少新配件共用名称');}
  busy=true;$('#source-save-all').disabled=true;const detail=$('#source-detail');detail.inert=true;
  message(`正在保存 ${pending.size} 条输出源及加购修改，请稍候…`);
  try{
   await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
   const result=await liveApi.applyBatch([...pending.values()].map(clone));
   pending.clear();if(!$('#source-detail'))return;
   const savedId=result.sourceIds?.[draft?.sourceId]??draft?.sourceId;
   const selected=api.getRows().find(r=>r.sourceId===savedId);if(selected)select(selected);else list();
   sourceSync?.showAutomaticChanges?.(result.autoChanges||[]);
   updatePending();
   await sourceSync?.refresh();
   if(shared){message(`已保存 ${result.count} 条输出源及加购修改${shared.preview?'到本机验收资料':''}。`);return;}
   message(`已一次保存 ${result.count} 条输出源及加购修改${result.skipped?'，'+result.skipped+' 家店铺已有该配件，已保留原资料':''}${result.configIds.length?'，并更新 '+result.configIds.length+' 套配置':''}。自动跟随更新 ${result.autoUpdatedFields||0} 项名称或加购说明；手动内容已保留，可在上方选择链接后确认。`);
  }catch(e){if($('#source-message'))message('保存失败，修改仍保留：'+e.message);throw e;}
  finally{busy=false;detail.inert=false;if($('#source-save-all'))$('#source-save-all').disabled=false;}
 }

 function read(validate=true){const addon=addonFields.read(validate&&!!managed);let row={...clone(draft),...productLookup?.observation(),...sourceAddonFields(addon),specialComponent:$('#source-special').checked,goodsId:$('#source-id').value.trim(),name:$('#source-name').value.trim(),tax:$('#source-tax').value===''?null:Number($('#source-tax').value)};row.capacityOverrides=readCapacityFields(root,validate);row.hardwareOverrides=readHardwareFields(root,validate);row=normalizeSpecialComponent(row);if(validate){if(!managed&&!isSpecialComponent(row)&&addon.text.trim())validateAddon(addon,{required:true,costs:api.getCosts()});if(!isSpecialComponent(row)&&!/^\d+$/.test(row.goodsId))throw Error('请填写准确的数字 ERP ID');if(!row.name&&(!managed?.entry||JSON.parse(formBaseline||'{}').name))throw Error('请填写产品显示名称');if(excludedComponent(row)||api.getCosts().some(r=>r.goodsId===row.goodsId&&excludedComponent(r)))throw Error('带 * 或 *! 标记的配件不可加入输出源');if(row.tax!==null&&(!Number.isFinite(row.tax)||row.tax<0||!/^\d+(\.\d{1,2})?$/.test($('#source-tax').value)))throw Error('核算单价须为非负金额，最多两位小数');if(!isSpecialComponent(row)&&!selectedId&&api.getRows().some(r=>r.goodsId===row.goodsId&&r.sourceId!==row.sourceId))throw Error('该 ERP ID 已存在，请搜索后编辑对应记录');}return row;}
 function select(row,scope=shared?.defaultScope){const finish = selectedId && selectedId !== row.sourceId ? capturePanelTransition($('#source-detail')) : ()=>{};try{formBaseline=null;renderSelection(row,scope);
  // 以控件初始化后的值判断编辑，避免空容量、默认字段等格式归一造成幽灵草稿。
  // selectionBaseline 仍保留原始资料，供保存时校验冲突；无效输入仍按待修改处理。
  if(!row.deletedAt){try{formBaseline=JSON.stringify(read(false));}catch{formBaseline=null;}}
  updatePending();
 }finally{finish();}}
 function renderSelection(row,scope){api.release?.($('#source-detail'));productLookup?.dispose();productLookup=null;addonFields=null;selectionBaseline=new Map([...liveApi.getAllRows(),...liveApi.getRows()].map(r=>[r.sourceId,clone(r)]));selectedId=selectionBaseline.has(row.sourceId)?row.sourceId:null;
 const context=$('#source-context'),unitLabel=value=>value==null?'待核对':'¥'+Number(value).toFixed(2);
 if(context)context.textContent=api.quickEdit?`原配件核算 ${unitLabel(row.tax)} · ERP ${unitLabel(erpUnitCost(row).cents===null?null:erpUnitCost(row).cents/100)}`:shops.find(shop=>shop.id===api.shopId())?.name||'当前店铺';
 const entry=shared?.record(row),isNew=!selectionBaseline.has(row.sourceId),edits=pending.get(row.sourceId)?.managed?.edits||{};
 const base=shared&&!entry&&isNew?{...clone(pending.get(row.sourceId)?.creationBase||row),goodsId:row.goodsId,specialComponent:isSpecialComponent(row)}:row;
 managed=shared&&(entry||isNew)&&!row.deletedAt?{base,entry,scope}:null;
 if(entry&&managed)row=sharedScopeRow(row,entry,scope,edits);
 else if(managed)row=newSharedScopeRow(base,scope,edits);
 draft=normalizeSpecialComponent({...clone(row),goodsId:row.goodsId||'',name:row.name||'',tax:row.tax??null,upgrade:row.upgrade||'',specialComponent:isSpecialComponent(row),...sourceAddonFields(sourceAddon(row))});invalidate();if(row.deletedAt){$('#source-detail').innerHTML=`<h3>${esc(row.name)}</h3><p class="hint">此输出源已删除。已有配置和成本源保留，恢复后可重新选用。</p><button id="source-restore" class="primary">恢复输出源</button>`;api.renderDetail?.($('#source-detail'),{row});$('#source-restore').onclick=()=>toggleDeleted(row,false);list();return;}const targetShops=pending.get(row.sourceId)?.targetShopIds||shops.map(shop=>shop.id);const references=api.getConfigs().filter(c=>!c.deletedAt&&c.parts.some(p=>p.sourceId===row.sourceId)).length,unit=erpUnitCost(row);
 $('#source-detail').innerHTML=`<div class="source-detail-heading"><h3>${selectedId?'编辑配件资料':'新增输出源配件'}</h3><span>${references} 套本店配置引用</span></div>${managed?'<div id="source-shared-scope"></div>':''}${isNew&&!managed?`<fieldset id="source-new-shops" class="source-new-shops"><legend>新增到店铺</legend>${shops.map(shop=>`<label><input type="checkbox" data-source-new-shop="${shop.id}" ${targetShops.includes(shop.id)?'checked':''} ${shop.id===api.shopId()?'disabled':''}>${esc(shop.shortName)}${shop.id===api.shopId()?'（当前）':''}</label>`).join('')}<small>默认新增到三店；已有相同 ERP ID 的店铺保留原资料。</small></fieldset>`:''}<label class="field source-special-field"><span><input id="source-special" type="checkbox" ${isSpecialComponent(row)?'checked':''} ${selectedId?'disabled':''}>特殊配件（无 goodsId，成本及维护表导出为 0）</span></label><section class="source-erp-block"><div class="source-erp-query"><label class="field">ERP ID<input id="source-id" value="${esc(row.goodsId)}" ${selectedId||isSpecialComponent(row)?'readonly':''} inputmode="numeric"></label><button type="button" id="source-erp-refresh">查询 ERP</button></div><div class="source-erp-reference"><label class="field">ERP 单价（只读）<input id="source-erp-price" readonly value="${unit.cents===null?'暂无':(unit.cents/100).toFixed(2)}"></label><div id="source-stock">${componentStockHtml(row,api.getCosts())}</div><div class="hint" id="source-erp-status" role="status">当前为已同步价格</div></div></section><label class="field">本店产品显示名称<textarea id="source-name" rows="1">${esc(row.name)}</textarea></label><label class="field">三店共用含税核算单价<input id="source-tax" ${isSpecialComponent(row)?'readonly':''} type="number" min="0" step=".01" value="${row.tax??''}" placeholder="留空表示待核算"></label>${managed?'<details id="source-maintenance-fields" '+(isSpecialComponent(row)?'hidden':'')+'><summary>容量、硬件简称维护</summary>':''}${capacityFieldsHtml(row)}${hardwareFieldsHtml(row)}${managed?'</details>':''}<section class="source-addon-editor" ${isSpecialComponent(row)?'hidden':''}><h4>${managed?'多选加购':'三店加购'}</h4><div id="source-addon-fields"></div></section>${managed?'<section id="source-shared-preview"></section>':''}<small class="hint">更新时间：${row.updatedAt?new Date(row.updatedAt).toLocaleString():'尚未人工维护'}</small><div class="source-save-actions"><button id="source-reset">重置修改</button><button id="source-save" class="primary">保存全部更改</button></div><div class="source-bottom-actions"><button id="source-delete" class="danger" ${selectedId?'':'disabled'}>删除输出源</button></div>`;
 api.renderDetail?.($('#source-detail'),{row,selectedId,isNew,targetShops,quickEdit:api.quickEdit,shared:!!managed,shops:api.nas?shops.filter(s=>s.id===api.shopId()):shops,nas:api.nas,shopId:api.shopId(),references,special:isSpecialComponent(row),erpPrice:unit.cents===null?'暂无':(unit.cents/100).toFixed(2),stockHtml:componentStockHtml(row,api.getCosts()),capacityHtml:capacityFieldsHtml(row)+hardwareFieldsHtml(row)});
 const getOriginal=()=>({...draft,goodsId:$('#source-id').value.trim(),tax:$('#source-tax').value===''?null:Number($('#source-tax').value)});
 addonFields=isSpecialComponent(row)?{read:()=>sourceAddon(draft),isDirty:()=>false,changes:()=>[],refresh:()=>{}}:managed?mountSharedAddons($('#source-addon-fields'),{row:draft,getCosts:api.getCosts,getOriginal,onChange:invalidate}):mountShopAddons($('#source-addon-fields'),{original:{...draft,shopId:draft.shopId||api.shopId()},getRows:api.getAllRows,getCosts:api.getCosts,getOriginal:()=>({...draft,goodsId:$('#source-id').value.trim(),tax:$('#source-tax').value===''?null:Number($('#source-tax').value)}),onChange:invalidate,...(api.nas?{availableShops:shops.filter(s=>s.id===api.shopId())}:{})});
 if(managed)mountSharedScope($('#source-detail'),{row,entry,scope,scopes:shared.scopes,edits,
  onScope:target=>{
   if(busy)return;
   // 新建时可以先选范围再填写身份，只有保存或离开配件时才进行完整校验。
   if(!entry){
    if(productLookup?.isPending()){message('正在读取 ERP 名称和单价，请查询完成后再切换范围。');return;}
    try{if(isEdited())stageManaged(read(false));select(pending.get(base.sourceId)?.creationBase||base,target);}catch(error){message(error.message);}
   }else if(stageCurrent())select(base,target);
  },
  onField:(key,value,restore)=>{
   if(busy||!stageCurrent())return;
   stageManaged(read(false),[key,value,restore]);select(base,scope);
   if(key.startsWith('capacityOverrides.')||key.startsWith('hardwareOverrides.'))$('#source-maintenance-fields').open=true;
  }});
 $$('[data-source-new-shop]').forEach(input=>input.onchange=invalidate);
 $('#source-special').onchange=()=>{const value=read(false);if(!isSpecialComponent(value)){value.erp=null;value.tax=null;}select(value);};
 if(!api.setDeleted)$('#source-delete').hidden=true;
 $('#source-delete').onclick=()=>{if(confirm(`删除“${row.name}”？已有配置和成本源保留，可以从“已删除”中恢复。`))return toggleDeleted(row,true);};
 $('#source-save').onclick=()=>saveAll().catch(()=>{});
 $('#source-name').closest('label').classList.add('source-field-name');
 $('#source-reset').onclick=()=>{if(api.quickEdit)pending.clear();select(selectedId?api.getRows().find(r=>r.sourceId===selectedId):{sourceId:crypto.randomUUID(),goodsId:'',name:'',specialComponent:specialOnly,erp:specialOnly?0:null,tax:specialOnly?0:null,upgrade:'',addonText:'',addonNote:''});message(api.quickEdit?'已放弃未保存的修改':'已重置未保存的修改');};
 if(api.quickEdit){$('#source-reset').textContent='放弃修改';$('#source-save').textContent='保存输出源';}
 const editable=!api.canEdit||api.canEdit(row);
 const refreshFields=event=>{
  if(event?.target?.id==='source-tax'&&managed?.scope==='shared')managed.taxEdited=true;
  invalidate();
  const visible={...draft,name:$('#source-name').value,goodsId:$('#source-id').value.trim()};
  updateCapacityHints(root,visible.name);updateHardwareHints(root,visible);
  updateMaintenanceVisibility(root,visible,api.getConfigs(),api.getCosts(),{isNew});addonFields.refresh();
 };
 $$('#source-detail input[id^="source-"],#source-detail textarea[id^="source-"],#source-detail select[id^="source-"]').forEach(el=>el.oninput=refreshFields);
 if(!isSpecialComponent(row)){
  productLookup=mountSourceProductLookup($('#source-detail'),{draft,getCosts:api.getCosts,nas:api.nas,isNew,
   lookupProduct:editable?api.lookupProduct:undefined,onChange:refreshFields});
 }else{$('#source-erp-refresh').hidden=true;$('#source-erp-status').textContent='特殊配件 · 成本为 0';}
 if(api.nas){
  if($('#source-new-shops'))$('#source-new-shops').hidden=true;
  if(!editable){
   $('#source-detail').querySelectorAll('input,textarea,select,button').forEach(control=>control.disabled=true);
   const note=document.createElement('p');note.className='hint';note.textContent='此共享资料未授予当前账号维护权限。';$('#source-detail').prepend(note);
  }
 }
 updateCapacityHints(root,$('#source-name').value);updateHardwareHints(root,{...draft,name:$('#source-name').value});updateMaintenanceVisibility(root,{...draft,name:$('#source-name').value,goodsId:$('#source-id').value.trim()},api.getConfigs(),api.getCosts(),{isNew});
 // 新建直接展开维护区；已有配件继续保留折叠阅读方式。
 if(isNew&&$('#source-maintenance-fields'))$('#source-maintenance-fields').open=!isSpecialComponent(row);
 list();updatePending();}
 async function toggleDeleted(row,deleted){if(busy)return;if(pending.size||isEdited()){message('请先保存全部更改或放弃全部更改，再删除或恢复输出源。');return;}busy=true;try{await api.setDeleted(row.sourceId,deleted);if(!$('#source-detail'))return;draft=null;selectedId=null;showDeleted=false;$('#source-deleted').textContent='已删除';const first=filtered()[0];if(first)select(first);else{api.release?.($('#source-detail'));$('#source-detail').innerHTML='<p class="hint">暂无输出源，可新增或从“已删除”恢复。</p>';list();}message(deleted?'输出源已删除，已有配置保留。':'输出源已恢复。');}catch(e){if($('#source-message'))message(e.message);}finally{busy=false;}}
 $('#source-export').onclick=()=>{
  if(busy)return;
  if(shared&&!stageCurrent())return;
  const button=$('#source-export');button.disabled=true;
  try{
   const rows=api.getRows().map(clone);
   // Read the visible editor as a draft without saving or validating unrelated cost/addon fields.
   if(draft&&!showDeleted&&!managed){const row={...clone(draft),...sourceAddonFields(addonFields.read(false)),shopId:api.shopId(),goodsId:$('#source-id')?.value.trim()??draft.goodsId,name:$('#source-name')?.value??draft.name,specialComponent:$('#source-special')?.checked??draft.specialComponent};const index=rows.findIndex(r=>r.sourceId===row.sourceId);if(index>=0)rows[index]=row;else if(row.name?.trim()||row.goodsId?.trim())rows.push(row);}
   const values=sourceExportRows(rows,api.getCosts(),api.shopId());if(!values.length)throw Error('本店没有可导出的在用输出源');
   const now=new Date(),stamp=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('')+'_'+[now.getHours(),now.getMinutes(),now.getSeconds()].map(v=>String(v).padStart(2,'0')).join('');
   api.download(sourceExportWorkbook(values),`${shopById(api.shopId()).name}_输出源_${stamp}.xlsx`);
   message(`已导出本店全部 ${values.length} 条在用输出源，列顺序：goodsid（ERP ID）、ERP名称、展示名称、升级项（本店加购描述）。${pending.size||draft&&isEdited()?'包含当前未保存内容，导出不会自动保存更改。':''}`);
  }catch(e){message('导出失败：'+e.message);}finally{button.disabled=false;}
 };
 const closeAudit=()=>{$('#source-addon-report').innerHTML='';root.classList.remove('source-audit-open');};
 $('#source-addon-check').onclick=()=>{
  if(busy||!stageCurrent())return;
  root.classList.add('source-audit-open');
  mountAddonAudit($('#source-addon-report'),{getRows:api.getRows,getCosts:api.getCosts,getConfigs:api.getConfigs,stage:()=>!busy&&stageCurrent(),close:closeAudit,edit:id=>{
   if(busy||!stageCurrent())return;
   const row=api.getRows().find(r=>r.sourceId===id&&!r.deletedAt);
   if(!row){message('该输出源已变化，请重新检查。');return;}
   closeAudit();showDeleted=false;specialOnly=false;page=0;$('#source-search').value='';$('#source-deleted').textContent='已删除';$('#source-special-list').textContent='特殊配件';select(row);$('#source-detail').scrollIntoView({block:'start'});
  }});
  dialog.scrollTop=0;
 };
 $('#source-deleted').onclick=()=>{if(busy)return;if(!stageCurrent())return;showDeleted=!showDeleted;page=0;draft=null;selectedId=null;$('#source-deleted').textContent=showDeleted?'返回在用':'已删除';const first=filtered()[0];if(first)select(first);else{api.release?.($('#source-detail'));$('#source-detail').innerHTML='<p class="hint">没有记录。</p>';list();}};
 $('#source-special-list').onclick=()=>{if(busy)return;if(!stageCurrent())return;specialOnly=!specialOnly;$('#source-special-list').textContent=specialOnly?'全部配件':'特殊配件';$('#source-search').value='';page=0;draft=null;selectedId=null;const first=filtered()[0];if(first)select(first);else{api.release?.($('#source-detail'));$('#source-detail').innerHTML='<p class="hint">点击新增配件，创建特殊配件。</p>';list();}};
 $('#source-search').oninput=()=>{page=0;list();};$('#source-prev').onclick=()=>{page--;list();};$('#source-next').onclick=()=>{page++;list();};$('#source-new').onclick=()=>{if(busy)return;if(!stageCurrent())return;showDeleted=false;$('#source-deleted').textContent='已删除';select({sourceId:crypto.randomUUID(),goodsId:'',name:'',specialComponent:specialOnly,erp:specialOnly?0:null,tax:specialOnly?0:null,upgrade:'',addonText:'',addonNote:''});};
 $('#source-save-all').onclick=()=>saveAll().catch(()=>{});
 $('#source-discard-all').onclick=()=>{if(busy)return;if(api.quickEdit){$('#source-reset')?.onclick();return;}if((pending.size||draft&&isEdited())&&!confirm('放弃本次所有尚未保存的输出源和加购修改？'))return;pending.clear();draft=null;selectedId=null;addonFields=null;const first=filtered()[0];if(first)select(first);else{api.release?.($('#source-detail'));$('#source-detail').innerHTML='<p class="hint">从左侧选择配件。</p>';list();updatePending();}message('已放弃本次未保存修改。');};
 const controller=new AbortController(),options={signal:controller.signal};
 const hasPending=()=>busy||pending.size>0||!!draft&&isEdited();
 const guard=e=>{if(root.isConnected&&(busy||hasPending())){e.preventDefault();message(busy?'正在保存，请稍候。':api.quickEdit?'还有未保存修改，请先保存输出源，或点击“放弃修改”。':'还有未保存修改，请先“保存全部更改”，或选择“放弃全部更改”。');}};
 dialog.addEventListener('cancel',guard,options);dialog.querySelector('form').addEventListener('submit',guard,options);
 const dispose=()=>{productLookup?.dispose();sourceSync?.dispose?.();controller.abort();api.release?.(root);root.remove();if(window.workbenchSourceEditor===editor)delete window.workbenchSourceEditor;};
 const restore=()=>{root.remove();api.openDialog(title,'');document.querySelector('#dialog-body').append(root);dialog.classList.add('source-dialog');dialog.classList.toggle('source-quick-dialog',!!api.quickEdit);};
 // 替换共享弹窗前先移走有草稿的独立根，防止宿主释放 React 节点后丢失原输入。
 const detachForDialog=()=>{if(hasPending())root.remove();else dispose();};
 const editor={hasPending,save:saveAll,restore,dispose,detachForDialog};window.workbenchSourceEditor=editor;
 // Closing a conflict panel must not discard the still-unsaved source form.
 dialog.addEventListener('close',()=>{if(!hasPending())dispose();},options);
 if(api.nas){
  if(!api.applySync)root.querySelector('.source-change-entry')?.setAttribute('hidden','');
  if(!api.updateLinkCosts)root.querySelector('#source-cost-overrides')?.setAttribute('hidden','');
  const notes=root.querySelectorAll('.source-batch-bar p');
  if(notes.length)notes[0].textContent=shared?.preview?'保存后可在本机继续验收。':'切换商品会保留未提交的修改；点击保存后才提交 NAS。';
  if(shared?.preview)$('#source-deleted').hidden=true;
  if(api.openStoreOnly){
   const button=document.createElement('button');button.type='button';button.textContent='本店正式维护';
   button.onclick=()=>{if(!hasPending())api.openStoreOnly();else message('请先保存或放弃当前修改。');};
   $('#source-export').after(button);
  }
  if(!api.canManage||shared&&!shared.canCreate)$('#source-new').hidden=true;

 }
 // 指定配件必须精确定位到原来源，不能被共用目录去重后跳到另一条别名。
 list();const first=api.focusSourceId?api.getRows().find(row=>row.sourceId===api.focusSourceId&&!row.deletedAt):filtered()[0];
 if(first)select(first,api.quickEdit?api.shopId():undefined);
 else if(api.focusSourceId)message('对应输出源不存在或已删除，请重新选择配件。');
}
