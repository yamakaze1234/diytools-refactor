import {profitTone} from './profit-tone.js';
import {DEFAULT_PROFIT_ALERT,DEFAULT_PRICING_RULE,normalizeProfitAlert,normalizeProfitAlerts,validatePricingRule,productInstallment} from './pricing.js';
import {flagsFor,linkKey,parseArrival,parseIdPaste,planIdEdit,planPriceBatch,priceProfitRow} from './price-profit-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amountFormat=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const money=value=>value==null?'—':(value<0?'−¥':'¥')+amountFormat.format(Math.abs(value));
const percent=value=>value==null?'—':amountFormat.format(value)+'%';
const ruleFields={erpRate:'ERP 扣点',taxRate:'核算扣点',erpFixed:'ERP 固定费用',taxFixed:'核算固定费用',fee6:'6 期息点',fee12:'12 期息点',fee24:'24 期息点'};
const fieldNames={spu:'SPU',sku:'SKU',price:'到手价'};
const fields=Object.keys(fieldNames);
const filters=[['all','全部配置'],['loss','亏损预警'],['target','低于目标'],['missing','资料缺失'],['fallback','ERP 成本代入']];
const statusChoices=[['erp-loss','ERP 利润亏损预警'],['tax-loss','核算利润亏损预警'],['erp-target','ERP 利润低于目标'],['tax-target','核算利润低于目标'],['missing','资料缺失'],['fallback','ERP 成本代入'],['normal','正常']];
/** 筛选精确对应可见标签：亏损标签不同时算作“低于目标”标签。 */
function statusKeys(flags){
 const result=flags.hits.target.map(key=>key+(flags.hits.loss.includes(key)?'-loss':'-target'));
 if(flags.missing)result.push('missing');
 if(flags.fallback)result.push('fallback');
 return result.length?result:['normal'];
}
const field=(id,label,value,step,max)=>'<label class="field">'+label+'<input id="'+id+'" type="number" step="'+step+'" min="0" max="'+max+'" value="'+esc(value)+'" required></label>';

export function pricingRuleFields(prefix,rule=DEFAULT_PRICING_RULE){
 return '<div class="pp-rule-fields">'+Object.entries(ruleFields).map(([key,label])=>{
  const fixed=key.endsWith('Fixed');
  return field(prefix+'-'+key,label+(fixed?'（元）':'（%）'),rule[key],fixed?'.01':'.0001',fixed?1000000:99);
 }).join('')+'</div>';
}
export function readPricingRuleFields(prefix,root=document){
 return validatePricingRule(Object.fromEntries(Object.keys(ruleFields).map(key=>[key,root.querySelector('#'+prefix+'-'+key).value])));
}

/** 表格的编辑计划先全部验证，再交给工作台保存和历史管理。 */
export function mountPriceProfit(root,api){
 const workspace=root.closest('.workspace');
 let shop=api.activeShop(),product='',basis='erp',filter='all',sort='order',grouped=true;
 let statusFilter=new Set();
 let initialGroups=false;
 let chosen=new Set(),collapsed=new Set(),rendering=false,pointerDown=false,deferredDraw=false,renderTimer=0,drawnIds=[];
 const $=selector=>root.querySelector(selector);
 const dialog=()=>document.querySelector('#dialog-body');
 const visible=()=>!root.hidden;
 const shopName=id=>api.shops.find(s=>s.id===id)?.name||id;
 const options=(entries,active)=>entries.map(([v,n])=>'<option value="'+esc(v)+'"'+(v===active?' selected':'')+'>'+esc(n)+'</option>').join('');
 const groupedConfigs=()=>{
  const groups=new Map();
  for(const c of api.links()){const key=linkKey(c);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
  return groups;
 };
 const rows=(groups=groupedConfigs())=>{
  const terms=new Map(Array.from(groups,([key,list])=>[key,productInstallment(list)]));
  return api.rows().filter(config=>shop==='all'||config.shopId===shop).map(config=>priceProfitRow(config,{...api.settings(config.shopId),linkInstallment:terms.get(linkKey(config))}));
 };
 const match=(row,needle)=>[row.config.name,row.config.shortName,row.config.product,row.config.productUrl,row.config.spu,row.config.skuId,shopName(row.config.shopId)].some(v=>String(v??'').toLowerCase().includes(needle));
 const currentPriceRow=id=>{const c=api.rows().find(c=>c.id===id);return c?priceProfitRow(c,{...api.settings(c.shopId),linkInstallment:productInstallment(api.links().filter(link=>linkKey(link)===linkKey(c)))}):null;};

 root.innerHTML='<header class="pp-header"><div><button id="pp-back" type="button" class="text-button">← 返回配置</button><h1 id="price-profit-title">价格与利润</h1><p>按实际 BOM 查看各店铺成本和利润，直接编辑编号与到手价。</p></div><div class="pp-actions"><button id="pp-shop-settings">店铺设置</button><button id="pp-alert">预警规则</button><button id="pp-new-link" class="primary">＋ 新建链接</button></div></header>'+
 '<div id="pp-summary" class="pp-summary" aria-label="价格利润筛选"></div>'+
 '<div class="pp-toolbar"><label>店铺<select id="pp-shop"></select></label><label>商品链接<select id="pp-product"></select></label><label class="pp-search">搜索<input id="pp-search" type="search" placeholder="链接、配置、SPU、SKU" autocomplete="off"></label><div class="pp-status-control"><span>状态</span><button id="pp-status-filter" type="button" aria-label="筛选状态">全部状态 ▾</button></div><label>排序 / 调价口径<select id="pp-basis"><option value="erp">ERP 利润</option><option value="tax">核算利润</option></select></label><label>排序<select id="pp-sort">'+options([['order','配置顺序'],['profit','利润从低到高'],['margin','利润率从低到高'],['asc','到手价从低到高'],['desc','到手价从高到低'],['name','配置名称']],sort)+'</select></label><div class="segmented" aria-label="表格视图"><button id="pp-grouped" aria-pressed="true">按链接</button><button id="pp-flat" aria-pressed="false">平铺</button></div><span id="pp-result-count" class="pp-result-count" role="status" aria-live="polite"></span></div>'+
 '<div class="pp-grid" tabindex="0" aria-label="价格与利润表格区域"><table class="pp-table"><thead><tr><th><input type="checkbox" id="pp-select-all" aria-label="全选可见配置"></th><th>配置 / 链接</th><th>SPU</th><th>SKU</th><th>定价</th><th>到手价</th><th>ERP 成本</th><th>核算成本</th><th>ERP 利润</th><th>核算利润</th><th>ERP 利润率</th><th>核算利润率</th><th>ERP 扣点</th><th>核算扣点</th><th>分期费</th><th>状态</th></tr></thead><tbody id="pp-rows"></tbody></table></div>'+
 '<footer class="pp-footer"><div><strong id="pp-selection"></strong><span class="pp-help">选中编号格可直接粘贴一列；Enter 换行，Tab 换列。</span></div><div class="pp-actions"><button id="pp-batch" disabled>批量调价</button><button id="pp-undo" disabled>撤销</button><button id="pp-redo" disabled>重做</button><button id="pp-save" class="primary">保存到本机</button></div></footer><span id="pp-status" class="pp-sr" role="status"></span>';
 const body=$('#pp-rows');
 const selectAll=$('#pp-select-all');
 const announce=message=>{$('#pp-status').textContent=message;api.toast(message);};
 const inputFor=(id,key)=>id==null?null:body.querySelector('[data-pp-cell="'+key+'"][data-row-id="'+CSS.escape(id)+'"]');
 const focusCell=(id,key)=>{const el=inputFor(id,key);if(el){el.focus({preventScroll:true});el.select();el.scrollIntoView({block:'nearest',inline:'nearest'});}return !!el;};
 const isEdited=el=>el?.matches('[data-pp-cell]')&&el.value!==el.defaultValue;

 function refresh({force=false}={}){
  if(!visible()||rendering||!force&&(isEdited(document.activeElement)||pointerDown))return;
  const existingFocus=document.activeElement,focused=body.contains(existingFocus)&&existingFocus.matches('[data-pp-cell]')?[existingFocus.dataset.rowId,existingFocus.dataset.ppCell]:null;
  const activeSummary=existingFocus?.dataset.ppFilter;
  rendering=true;
  try{
   const groups=groupedConfigs(),inShop=rows(groups);
   const links=new Map(inShop.map(row=>[linkKey(row.config),row.config]));
   // 空链接有编辑入口；没有实际配置的草稿不计入利润与批量选择。
   const linkChoices=api.links().filter(c=>shop==='all'||c.shopId===shop);
   for(const c of linkChoices)if(!links.has(linkKey(c)))links.set(linkKey(c),c);
   if(!links.has(product))product='';
   $('#pp-shop').innerHTML=options([['all','全部店铺'],...api.shops.map(s=>[s.id,s.name])],shop);
   $('#pp-product').innerHTML=options([['','全部链接'],...Array.from(links,([key,c])=>[key,(shop==='all'?shopName(c.shopId)+' · ':'')+(c.product||'未命名链接')])],product);
   $('#pp-shop-settings').disabled=shop==='all';
   $('#pp-alert').disabled=shop==='all';
   $('#pp-shop-settings').title=shop==='all'?'请选择需要修改的店铺':'';
   $('#pp-alert').title=shop==='all'?'请选择需要修改的店铺':'';
   const needle=$('#pp-search').value.trim().toLowerCase();
   const scope=inShop.filter(r=>(!product||product===linkKey(r.config))&&match(r,needle));
   const flagged=scope.map(r=>({...r,flags:flagsFor(r)}));
   const counts=Object.fromEntries(filters.map(([key])=>[key,key==='all'?scope.length:flagged.filter(r=>r.flags[key]).length]));
   $('#pp-summary').innerHTML=filters.map(([key,label])=>'<button type="button" data-pp-filter="'+key+'" aria-pressed="'+String(filter===key)+'"><span>'+label+'</span><strong>'+counts[key]+'</strong></button>').join('');
   if(activeSummary)$('#pp-summary').querySelector('[data-pp-filter="'+activeSummary+'"]')?.focus({preventScroll:true});
   const filtered=flagged.filter(r=>(filter==='all'||r.flags[filter])&&(!statusFilter.size||statusKeys(r.flags).some(key=>statusFilter.has(key))));
   $('#pp-status-filter').textContent=(statusFilter.size?'已选 '+statusFilter.size+' 项':'全部状态')+' ▾';
   // 结果数量包含折叠组中的匹配配置；底部可见数量仍表示可操作行。
   $('#pp-result-count').textContent='筛选结果：'+filtered.length+' 套配置';
   const sortValue=r=>sort==='profit'?r.metrics[basis+'ProfitAfter']:sort==='margin'?r.metrics[basis+'Margin']:r.quote.arrival;
   if(sort==='name')filtered.sort((a,b)=>String(a.config.name??'').localeCompare(String(b.config.name??''),'zh-CN'));
   else if(sort!=='order')filtered.sort((a,b)=>{const x=sortValue(a),y=sortValue(b);return x==null?+(y!=null):y==null?-1:(sort==='desc'?y-x:x-y);});
   const displayLinks=new Map();
   for(const row of filtered){const key=linkKey(row.config);if(!displayLinks.has(key))displayLinks.set(key,[]);displayLinks.get(key).push(row);}
   if(grouped&&filter==='all'&&!needle&&!statusFilter.size)for(const [key] of links)if((!product||key===product)&&!displayLinks.has(key)&&linkChoices.some(c=>linkKey(c)===key&&c.emptyLinkDraft))displayLinks.set(key,[]);
   const rowHTML=row=>{
    const {config:c,quote:p,metrics:t,flags:f}=row;
    const status=[...f.hits.target.map(key=>[f.hits.loss.includes(key)?'destructive':'warning',(key==='erp'?'ERP 利润':'核算利润')+(f.hits.loss.includes(key)?'亏损预警':'低于目标')]),f.missing?['muted','资料缺失']:null,f.fallback?['warning','ERP 成本代入']:null].filter(Boolean);
    if(!status.length)status.push(['success','正常']);
    const id=esc(c.id),picked=chosen.has(c.id);
    const editor=(key,value)=>'<td><input class="pp-cell '+(key==='price'?'pp-price-cell':'pp-id-cell')+'" aria-label="'+esc(c.name)+' '+fieldNames[key]+'" data-row-id="'+id+'" data-pp-cell="'+key+'" inputmode="'+(key==='price'?'decimal':'numeric')+'" autocomplete="off" spellcheck="false" value="'+esc(value)+'"></td>';
    const num=(value,kind='money',tone=false)=>'<td class="pp-number"'+(tone?' data-profit-tone="'+profitTone(value)+'"':'')+'>'+(kind==='percent'?percent(value):money(value))+'</td>';
    return '<tr data-pp-row="'+id+'"'+(picked?' data-selected':'')+'><td><input type="checkbox" data-pp-pick="'+id+'" aria-label="勾选 '+esc(c.name)+'"'+(picked?' checked':'')+'></td><th scope="row"><button class="pp-config-link text-button" type="button" data-pp-details="'+id+'">'+esc(c.name)+'</button><small>'+esc(grouped?c.shortName||'':shopName(c.shopId)+' · '+(c.product||'未命名链接'))+'</small></th>'+
      editor('spu',c.spu)+editor('sku',c.skuId)+num(p.listPrice)+editor('price',p.arrival)+
      num(t.erp)+num(t.tax)+num(t.erpProfitAfter,'money',true)+num(t.taxProfitAfter,'money',true)+num(t.erpMargin,'percent',true)+num(t.taxMargin,'percent',true)+num(t.erpDeduction)+num(t.taxDeduction)+num(p.fee)+
      '<td class="pp-status-cell">'+status.map(([tone,label])=>'<span class="pp-badge" data-variant="'+tone+'">'+label+'</span>').join('')+'</td></tr>';
   };
   const shown=[];
   if(grouped){
    body.innerHTML=Array.from(displayLinks,([key,group])=>{
     const c=links.get(key),hidden=collapsed.has(key),k=esc(key);
     if(!hidden)shown.push(...group);
     const term=productInstallment(groups.get(key)),hint=(c.pricingRule?'独立核算':'跟随店铺')+' · '+(term===null?'分期设置不一致':term?term+' 期免息':'不分期');
     return '<tr class="pp-link-group"><td colspan="16"><div><button type="button" data-pp-collapse="'+k+'" aria-expanded="'+String(!hidden)+'">'+(hidden?'▸':'▾')+' '+esc(c.product||'未命名链接')+'</button><span>'+esc(shopName(c.shopId))+' · '+group.length+' 套配置</span><button type="button" class="text-button" data-pp-edit-link="'+k+'">'+esc(hint)+' · 链接设置</button></div></td></tr>'+
       (hidden?'':group.length?group.map(rowHTML).join(''):'<tr><td colspan="16" class="pp-empty">此链接尚无配置价格，可在配置页继续编辑。</td></tr>');
    }).join('');
   }else{shown.push(...filtered);body.innerHTML=shown.map(rowHTML).join('');}
   if(!body.childElementCount)body.innerHTML='<tr><td colspan="16" class="pp-empty">没有符合条件的配置。</td></tr>';
   drawnIds=shown.map(r=>r.config.id);
   chosen=new Set(drawnIds.filter(id=>chosen.has(id)));
   syncSelection();historyButtons();
   if(focused)focusCell(...focused);
  }finally{rendering=false;}
 }
 function historyButtons(){
  const [undo,redo]=api.history();
  $('#pp-undo').disabled=!undo;$('#pp-redo').disabled=!redo;
 }
 function syncSelection(){
  selectAll.disabled=!drawnIds.length;
  selectAll.checked=!!drawnIds.length&&chosen.size===drawnIds.length;
  selectAll.indeterminate=!!chosen.size&&!selectAll.checked;
  $('#pp-selection').textContent='可见 '+drawnIds.length+' 套 · 已选 '+chosen.size+' 套';
  $('#pp-batch').disabled=!chosen.size;
  for(const tr of body.querySelectorAll('[data-pp-row]')){
   const checked=chosen.has(tr.dataset.ppRow);
   tr.toggleAttribute('data-selected',checked);tr.querySelector('[data-pp-pick]').checked=checked;
  }
 }
 function commitInput(el){
  if(!isEdited(el))return true;
  const {ppCell:key,rowId:id}=el.dataset;
  try{
   const current=currentPriceRow(id);if(!current)throw Error('配置范围已变化，请重新选择。');
   let plan;
   if(key==='price'){
    const value=parseArrival(el.value);
    plan=current.quote.arrival===value?[]:[{id,fields:{price:value}}];
   }else plan=planIdEdit(api.allConfigs(),key,[id],[el.value],{allowBlank:true});
   if(plan.length){
    const pending=api.apply(plan,key==='price'?'调整到手价':'修改 '+fieldNames[key]);
    if(api.nas){
     const old=el.defaultValue;
     pending.then(()=>refresh({force:true}),error=>{if(el.isConnected)el.value=el.defaultValue=old;announce(error.message);});
    }
   }
   el.defaultValue=el.value;
   return true;
  }catch(error){el.value=el.defaultValue;announce(error.message);return false;}
 }
 function scheduleRefresh(){
  deferredDraw=true;
  clearTimeout(renderTimer);
  renderTimer=setTimeout(()=>{if(!pointerDown){deferredDraw=false;refresh();}},0);
 }
 body.addEventListener('focusin',event=>{if(event.target.matches('[data-pp-cell]'))event.target.select();});
 body.addEventListener('focusout',event=>{
  if(!rendering&&event.target.isConnected&&isEdited(event.target)){commitInput(event.target);scheduleRefresh();}
 });
 body.addEventListener('pointerdown',()=>{pointerDown=true;});
 const endPointer=()=>{pointerDown=false;if(visible()&&deferredDraw)scheduleRefresh();};
 // 保留正在点击的单元格，直到 click 完成才允许重建可见行。
 document.addEventListener('pointerup',()=>{if(pointerDown)endPointer();});
 document.addEventListener('pointercancel',()=>{if(pointerDown)endPointer();});
 body.addEventListener('paste',event=>{
  const input=event.target,key=input.dataset.ppCell;
  if(!['spu','sku'].includes(key))return;
  event.preventDefault();
  try{
   const values=parseIdPaste(event.clipboardData?.getData('text/plain')??'',key),i=drawnIds.indexOf(input.dataset.rowId);
   if(i<0)throw Error('当前行已改变，请重新选择单元格。');
   const ids=drawnIds.slice(i),plan=planIdEdit(api.allConfigs(),key,ids,values);
   if(plan.length){
    const pending=api.apply(plan,'表格粘贴 '+fieldNames[key]);
    if(api.nas){pending.then(()=>{refresh({force:true});announce('NAS 已确认粘贴修改。');},error=>announce(error.message));return;}
   }
   refresh({force:true});
   announce(plan.length?(key==='spu'?'SPU 已更新，同一链接的配置已同步。':'已粘贴 '+values.length+' 行 SKU。'):'编号没有变化。');
  }catch(error){announce(error.message);}
 });
 body.addEventListener('keydown',event=>{
  const el=event.target,key=el.dataset.ppCell,id=el.dataset.rowId;
  if(!key||event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();el.value=el.defaultValue;el.select();return;}
  if(!['Enter','Tab','ArrowUp','ArrowDown'].includes(event.key))return;
  const idx=drawnIds.indexOf(id),oldOrder=drawnIds.slice(),col=fields.indexOf(key);
  let row=idx,fieldIndex=col;
  if(event.key==='Tab'){
   fieldIndex+=event.shiftKey?-1:1;
   if(fieldIndex===fields.length){row++;fieldIndex=0;}
   if(fieldIndex<0){row--;fieldIndex=fields.length-1;}
  }else row+=event.key==='ArrowUp'||event.key==='Enter'&&event.shiftKey?-1:1;
  event.preventDefault();
  const didEdit=isEdited(el);if(!commitInput(el)){el.select();return;}
  if(didEdit)refresh({force:true});
  if(!oldOrder[row]&&event.key==='Tab'){(event.shiftKey?selectAll:$('#pp-batch').disabled?$('#pp-save'):$('#pp-batch')).focus();return;}
  if(!focusCell(oldOrder[Math.max(0,Math.min(oldOrder.length-1,row))],fields[fieldIndex]))focusCell(drawnIds[Math.min(row,drawnIds.length-1)],fields[fieldIndex]);
 });
 selectAll.onchange=()=>{chosen=new Set(selectAll.checked?drawnIds:[]);syncSelection();};
 body.addEventListener('change',event=>{
  const id=event.target.dataset.ppPick;
  if(id){event.target.checked?chosen.add(id):chosen.delete(id);syncSelection();}
 });
 const reroute=()=>{chosen.clear();refresh({force:true});};
 // 状态多选采用“任一匹配”，并与店铺、链接、搜索及汇总筛选叠加。
 $('#pp-status-filter').onclick=()=>{
  api.openDialog('筛选状态','<p class="hint">可多选，显示包含任一所选状态的配置；不勾选时显示全部状态。</p><div class="pp-status-options">'+statusChoices.map(([key,label])=>`<label><input type="checkbox" data-pp-status-choice="${key}"${statusFilter.has(key)?' checked':''}> ${label}</label>`).join('')+'</div><div class="actions"><button id="pp-status-clear">清除筛选</button><button id="pp-status-apply" class="primary">应用</button></div>');
  const d=dialog();
  d.querySelector('#pp-status-clear').onclick=()=>{statusFilter.clear();api.closeDialog();reroute();};
  d.querySelector('#pp-status-apply').onclick=()=>{statusFilter=new Set(Array.from(d.querySelectorAll('[data-pp-status-choice]:checked'),el=>el.dataset.ppStatusChoice));api.closeDialog();reroute();};
 };
 $('#pp-shop').onchange=e=>{shop=e.target.value;product='';collapsed.clear();reroute();};
 $('#pp-product').onchange=e=>{product=e.target.value;collapsed.delete(product);reroute();};
 $('#pp-search').oninput=reroute;
 $('#pp-basis').onchange=e=>{basis=e.target.value;reroute();};
 $('#pp-sort').onchange=e=>{sort=e.target.value;reroute();};
 $('#pp-summary').onclick=e=>{const key=e.target.closest('[data-pp-filter]')?.dataset.ppFilter;if(key){filter=key;reroute();}};
 for(const [key,value] of [['grouped',true],['flat',false]])$('#pp-'+key).onclick=()=>{
  grouped=value;$('#pp-grouped').setAttribute('aria-pressed',String(value));$('#pp-flat').setAttribute('aria-pressed',String(!value));reroute();
 };
 body.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  const {ppCollapse,ppEditLink,ppDetails}=b.dataset;
  if(ppCollapse){
   collapsed.has(ppCollapse)?collapsed.delete(ppCollapse):collapsed.add(ppCollapse);refresh({force:true});
   Array.from(body.querySelectorAll('[data-pp-collapse]')).find(el=>el.dataset.ppCollapse===ppCollapse)?.focus();
  }
  if(ppEditLink){const c=api.links().find(c=>linkKey(c)===ppEditLink);if(c)api.editLink(c);}
  if(ppDetails)openDetail(ppDetails);
 });
 $('#pp-back').onclick=()=>hide();
 $('#pp-shop-settings').onclick=()=>api.editShop(shop);
 $('#pp-alert').onclick=()=>openAlert();
 $('#pp-new-link').onclick=()=>api.newLink(shop==='all'?api.activeShop():shop);
 $('#pp-batch').onclick=()=>openBatch();
 $('#pp-undo').onclick=()=>{api.undo();if(api.nas)refresh({force:true});};
 $('#pp-redo').onclick=()=>{api.redo();if(api.nas)refresh({force:true});};
 const saveButton=$('#pp-save');
 saveButton.onclick=async()=>{
  if(saveButton.disabled)return;saveButton.disabled=true;
  try{await api.save();if(api.nas)refresh({force:true});}
  catch(error){announce(error.message);}
  finally{saveButton.disabled=false;}
 };
 if(api.nas){
  saveButton.textContent='保存到服务端';
  const discard=document.createElement('button');discard.type='button';discard.className=saveButton.className;
  discard.textContent='处理旧版价格草稿';discard.onclick=()=>{
   const old=api.oldPriceDraft?.()||[];
   if(!old.length)return announce('没有未合入的旧版价格草稿。当前编辑可用撤销处理。');
   api.openDialog('旧版价格利润草稿','<p class="hint">与当前版本一致且无同字段冲突的旧草稿会在手动保存时合入。冲突草稿保留供核对。</p><ul>'+
    old.map(row=>'<li>'+esc(api.allConfigs().find(c=>c.id===row.id)?.name||row.id)+' · '+esc(JSON.stringify(row.fields))+'</li>').join('')+
    '</ul><button id="pp-drop-old" type="button">放弃旧版草稿</button>');
   dialog().querySelector('#pp-drop-old').onclick=()=>{api.discard();api.closeDialog();refresh({force:true});};
  };saveButton.after(discard);
 }

 function openDetail(id){
  const row=currentPriceRow(id);if(!row)return;
  const {config:c,quote:p,metrics:t}=row;
  api.openDialog('利润明细','<p class="hint">'+esc(shopName(c.shopId)+' · '+c.product+' · '+c.name)+'</p><dl class="pp-details"><dt>到手价 / 定价</dt><dd>'+money(p.arrival)+' / '+money(p.listPrice)+'</dd><dt>ERP 成本 / 扣点 / 固定费用</dt><dd>'+money(t.erp)+' / '+money(t.erpDeduction)+' / '+money(p.rule.erpFixed)+'</dd><dt>核算成本 / 扣点 / 固定费用</dt><dd>'+money(t.tax)+' / '+money(t.taxDeduction)+' / '+money(p.rule.taxFixed)+'</dd><dt>分期费'+(p.term?'（'+p.term+' 期 · '+p.percent+'%）':'')+'</dt><dd>'+money(p.fee)+'</dd><dt>ERP 利润 / 利润率</dt><dd>'+money(t.erpProfitAfter)+' / '+percent(t.erpMargin)+'</dd><dt>核算利润 / 利润率</dt><dd>'+money(t.taxProfitAfter)+' / '+percent(t.taxMargin)+'</dd></dl><p class="hint">利润 = 到手价 − 成本 − 扣点 − 固定费用 − 分期费。利润率按到手价计算。'+(t.erpFallback?'有 '+t.erpFallback+' 项 ERP 成本暂用核算成本代入。':'')+'</p><div class="actions"><button id="pp-details-rule">链接设置</button><button id="pp-details-config">前往配置</button></div>');
  dialog().querySelector('#pp-details-rule').onclick=()=>api.editLink(c);
  dialog().querySelector('#pp-details-config').onclick=()=>{api.closeDialog();hide();api.locate(c);};
 }
 function openAlert(){
  const targetShop=shop,rules=normalizeProfitAlerts(api.settings(shop).profitAlert)??{bases:['erp','tax'],erpProfit:DEFAULT_PROFIT_ALERT,taxProfit:DEFAULT_PROFIT_ALERT};
  const modes=[['amount','利润金额（元）'],['rate','利润率（%）']],sections=[['erp','ERP 利润'],['tax','核算利润']];
  const choices=sections.map(([key,label])=>`<label><input type="checkbox" value="${key}" name="pp-alert-basis"${rules.bases.includes(key)?' checked':''}> ${label}</label>`).join('');
  const fields=sections.map(([key,label])=>{
   const rule=rules[key+'Profit'],id='pp-alert-'+key;
   return `<fieldset class="pp-alert-rule" data-alert-section="${key}"><legend>${label}</legend><label class="field">判定方式<select id="${id}-mode">${options(modes,rule.mode)}</select></label><div class="pp-rule-fields"><label class="field">亏损线<input type="number" id="${id}-loss" step="any" value="${rule.loss}"></label><label class="field">目标线<input type="number" id="${id}-target" step="any" value="${rule.target}"></label></div></fieldset>`;
  }).join('');
  api.openDialog('预警规则','<p class="hint">'+esc(shopName(targetShop))+' · 所选口径各用自己的阈值；任一项触线即预警。</p><fieldset class="pp-alert-fields"><legend>检测口径</legend>'+choices+'</fieldset>'+fields+'<p class="hint">未勾选的口径保留设置、不参与预警；某项利润缺失时只跳过该项。</p><p id="pp-alert-error" class="error" role="status"></p><div class="actions"><button class="primary" id="pp-alert-apply">应用</button></div>');
  const d=dialog(),controls=sections.map(([key,label])=>{
   const find=part=>d.querySelector('#pp-alert-'+key+'-'+part);
   const check=d.querySelector('[name="pp-alert-basis"][value="'+key+'"]'),panel=d.querySelector('[data-alert-section="'+key+'"]');
   const mode=find('mode'),loss=find('loss'),target=find('target');
   // 隐藏不会销毁输入值；取消后重新勾选仍显示本次修改。
   const toggle=()=>{panel.hidden=!check.checked;panel.disabled=!check.checked;};
   check.onchange=toggle;toggle();
   mode.onchange=()=>{loss.value=0;target.value=mode.value==='rate'?2:100;};
   return {key,label,check,mode,loss,target};
  });
  d.querySelector('#pp-alert-apply').onclick=async event=>{
   const bases=controls.filter(c=>c.check.checked).map(c=>c.key),next={...rules,bases};
   const error=d.querySelector('#pp-alert-error');
   if(!bases.length){error.textContent='请至少选择一个检测口径。';return;}
   for(const {key,label,check,mode,loss,target} of controls){
    const rule=normalizeProfitAlert({mode:mode.value,loss:loss.valueAsNumber,target:target.valueAsNumber});
    if(check.checked&&!rule){error.textContent=label+'：请填写有效数值；目标线必须不小于零和亏损线。';return;}
    if(rule)next[key+'Profit']=rule;
   }
   const button=event.currentTarget;if(button.disabled)return;
   button.disabled=true;
   try{
    const outcome=api.setAlert(targetShop,next);if(api.nas)await outcome;
    if(button.isConnected)api.closeDialog();refresh({force:true});
   }catch(failure){if(button.isConnected)error.textContent=failure.message;}
   finally{button.disabled=false;}
  };
 }
 function openBatch(){
  const ids=drawnIds.filter(id=>chosen.has(id));
  api.openDialog('批量调价','<p class="hint">已勾选 '+ids.length+' 套 · '+(basis==='erp'?'ERP':'核算')+' 利润口径。金额和比例按到手价调整；目标价向上取整到元。</p><label class="field">调整方式<select id="pp-batch-mode">'+options([['delta','统一增减金额（元）'],['ratio','按售价比例增减（%）'],['target','目标利润金额（元）'],['margin','目标利润率（%）']],'delta')+'</select></label><label class="field">调整值<input type="number" step="any" id="pp-batch-value" placeholder="如 100 或 -100"></label><p id="pp-batch-error" class="error" role="status"></p><div class="pp-batch-preview" id="pp-batch-preview"></div><div class="actions"><button id="pp-batch-apply" class="primary" disabled>应用到表格</button></div>');
  const d=dialog(),value=d.querySelector('#pp-batch-value'),mode=d.querySelector('#pp-batch-mode'),preview=d.querySelector('#pp-batch-preview'),error=d.querySelector('#pp-batch-error'),apply=d.querySelector('#pp-batch-apply');
  const read=()=>{const lookup=new Map(rows().map(r=>[r.config.id,r])),selected=ids.map(id=>lookup.get(id));if(selected.some(r=>!r))throw Error('所选配置已变化，请重新勾选。');return planPriceBatch(selected,{basis,mode:mode.value,input:value.value});};
  function update(){
   error.textContent='';preview.replaceChildren();apply.disabled=true;
   if(!value.value)return;
   try{
    const plan=read(),changes=plan.filter(x=>x.price!=null&&x.price!==x.from),invalid=plan.filter(x=>x.reason&&!x.reason.startsWith('缺少'));
    preview.innerHTML='<p class="hint">可调整 '+changes.length+' 套 · 跳过 '+(plan.length-changes.length)+' 套</p>'+plan.map(x=>'<div class="list-card"><span>'+esc(x.name)+'</span><strong>'+money(x.from)+' → '+(x.reason?esc(x.reason):money(x.price))+'</strong></div>').join('');
    if(invalid.length)error.textContent='存在无法应用的价格或目标，请调整数值后重试。';
    apply.disabled=!changes.length||!!invalid.length;
   }catch(e){error.textContent=e.message;}
  }
  mode.onchange=value.oninput=update;
  apply.onclick=async()=>{
   update();if(apply.disabled)return;
   const plan=read().filter(x=>x.price!=null&&x.price!==x.from).map(x=>({id:x.id,fields:{price:x.price}}));
   apply.disabled=true;
   try{
    const outcome=api.apply(plan,'批量调价');if(api.nas)await outcome;
    if(apply.isConnected)api.closeDialog();refresh({force:true});announce(api.nas?'已暂存 '+plan.length+' 套工作台价格，点击“保存表内草稿到 NAS”后提交。':'已调整 '+plan.length+' 套价格，可撤销。');
   }catch(failure){if(apply.isConnected)error.textContent=failure.message;}
   finally{if(apply.isConnected)apply.disabled=false;}
  };
 }
 function show(){
  // 大店铺首次按链接折叠，避免同时创建上千行可编辑输入框；筛选与汇总仍覆盖全店。
  if(api.nas&&!initialGroups&&api.rows().length>200){
   collapsed=new Set(groupedConfigs().keys());initialGroups=true;
  }
  if(!visible()){shop=api.activeShop();product='';chosen.clear();}
  root.hidden=false;workspace.classList.add('price-profit-active');
  refresh({force:true});$('#pp-search').focus();
 }
 function hide(){
  if(!visible())return;
  if(root.contains(document.activeElement)&&isEdited(document.activeElement))commitInput(document.activeElement);
  root.hidden=true;workspace.classList.remove('price-profit-active');pointerDown=false;api.onClose();
 }
 return {show,hide,visible,refresh,historyButtons};
}
