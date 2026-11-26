import {profitTone} from './profit-tone.js';
import {copyPlainText} from './clipboard.js';
import {DEFAULT_PROFIT_ALERT,DEFAULT_PRICING_RULE,normalizeProfitAlert,normalizeProfitAlerts,validatePricingRule,productInstallment,moneyCents} from './pricing.js';
import {flagsFor,linkKey,parseArrival,planPriceMatrix,priceProfitRow} from './price-profit-model.js';
import {planPriceTemplateExport,priceTemplateWorkbook} from './price-template-export.js';
import {saveExportFolder} from './folder-export.js';
import {overviewFeeRate,readOverviewFeeRate} from './overview-table-model.js';
import {snap99} from './batch-profit-price.js';
import {mountTaxOverrideTools,deltaLabel} from './tax-override-ui.js';
import {taxDelta} from './tax-override-model.js';
import {actualParts} from './actual-parts.js';
import {configurationStock} from './inventory-check-data.js';
import {isSpecialComponent} from './special-components.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amountFormat=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const money=value=>value==null?'—':(value<0?'−¥':'¥')+amountFormat.format(Math.abs(value));
const percent=value=>value==null?'—':amountFormat.format(value)+'%';
const yuan=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const whole=value=>value==null?'—':yuan.format(value);
const ruleFields={erpRate:'ERP 扣点',taxRate:'核算扣点',erpFixed:'ERP 固定费用',taxFixed:'核算固定费用',fee6:'6 期息点',fee12:'12 期息点',fee24:'24 期息点'};
const fieldNames={spu:'SPU',sku:'SKU',shortName:'SKU 名称 / 简称',price:'到手价',rate:'运营费率',taxTarget:'目标核算利润',erpTarget:'目标ERP利润'};
const writableColumns={1:'spu',2:'sku',3:'shortName',5:'price',6:'rate',7:'taxTarget',8:'erpTarget'};
// Tab 与矩阵粘贴共用实际列序，自动跳过只读列。
const fields=Object.values(writableColumns);
const largeShopSize=100;
const filters=[['all','全部配置'],['loss','亏损预警'],['missing','资料缺失'],['fallback','ERP 成本代入']];
const statusChoices=[['erp-loss','ERP 利润亏损预警'],['tax-loss','核算利润亏损预警'],['missing','资料缺失'],['fallback','ERP 成本代入'],['normal','正常']];
// 与确认稿共用列序和列宽，配置简称及序号作为冻结列。
const defaultVisibleColumns=16;
const preciseKeys=new Set(['price','taxTarget','erpTarget']);
const columns=[
 ['序',46],['SPU',125],['SKU',125],['SKU 名称 / 简称',236],['售价',76],['到手价',79,'arrival'],['运营费率',72],
 ['核算利润',80,'taxProfitAfter'],['ERP 利润',80,'erpProfitAfter'],['核算利润率',83,'taxMargin'],
 ['可销',68],['含税成本',78],['ERP 成本',78],['状态',116],['机箱 / 颜色',104],['费率成本',82],
 ['ERP 利润率',87,'erpMargin'],['成本运营费',79],['ERP 扣点',79],['分期费',79],['待入可销',76],
];
/** 筛选精确对应可见标签：亏损标签不同时算作“低于目标”标签。 */
function statusKeys(flags){
 const result=flags.hits.loss.map(key=>key+'-loss');
 if(flags.missing)result.push('missing');
 if(flags.fallback)result.push('fallback');
 return result.length?result:['normal'];
}
const field=(id,label,value,step,max)=>'<label class="field">'+label+'<input id="'+id+'" type="number" step="'+step+'" min="0" max="'+max+'" value="'+esc(value)+'" required></label>';

export function pricingRuleFields(prefix,rule=DEFAULT_PRICING_RULE){
 return '<div class="pp-rule-fields">'+Object.entries(ruleFields).map(([key,label])=>{
  // 失效字段静默保留，避免保存店铺息点时改写旧库兼容信息。
  if(!key.startsWith('fee'))return '<input type="hidden" id="'+prefix+'-'+key+'" value="'+esc(rule[key])+'">';
  if(key==='fee24')return '<label class="field">24 期息点（固定 10%）<input readonly value="10"><input type="hidden" id="'+prefix+'-'+key+'" value="'+esc(rule[key])+'"></label>';
  return field(prefix+'-'+key,label+'（%）',rule[key],'.0001',99);
 }).join('')+'</div>';
}
export function readPricingRuleFields(prefix,root=document){
 return validatePricingRule(Object.fromEntries(Object.keys(ruleFields).map(key=>[key,root.querySelector('#'+prefix+'-'+key).value])));
}

/** 表格的编辑计划先全部验证，再交给工作台保存和历史管理。 */
export function mountPriceProfit(root,api){
 const workspace=root.closest('.workspace');
 let shop=api.activeShop(),product='',filter='all',sort=null,grouped=true,activeLink='';
 let statusFilter=new Set();
 const partFilters=new Map();
 let partMatch='any';
 // 搜索时使用临时折叠状态，清空搜索即可恢复平时的浏览位置。
 const searchCollapsed=new Set();
 let visibleGroups=new Map(),activeCollapsed,largeSearchCollapsed=null;
 let chosen=new Set(),collapsed=new Set(),rendering=false,pointerDown=false,deferredDraw=false,renderTimer=0,drawnIds=[];
 const expanded=new Set();
 const cards=new Map();
 let moreColumns=false,range=null,rangePointer=null;
 let baseRows=new Map(),selectedRows=new Map(),removeRange=false,copyAligned=true;
 let renderedRows=new Map(),renderedLinks=new Map(),paintedCells=new Set(),paintedCurrent=null;
 let pendingWrites=0,writeTail=Promise.resolve(),savedState=null,saving=false,fullDrawRequested=false;
 const pendingInputResults=new Set();let inputRejected=null;
 const pendingInputs=new WeakSet(),dirtyRows=new Set();
 let rowCache=new Map(),stockIndex=new Map(),linkScope=[];
 const focusClass=index=>index===0?' pp-frozen-number':index===3?' pp-frozen-config':'';
 const colClass=index=>(index>=defaultVisibleColumns?' pp-extra':'')+focusClass(index);
 const $=selector=>root.querySelector(selector);
 const dialog=()=>document.querySelector('#dialog-body');
 const visible=()=>!root.hidden;
 const shopName=id=>api.shops.find(s=>s.id===id)?.name||id;
 const options=(entries,active)=>entries.map(([v,n])=>'<option value="'+esc(v)+'"'+(v===active?' selected':'')+'>'+esc(n)+'</option>').join('');
 const groupedConfigs=(configs=api.links())=>{
  const groups=new Map();
  for(const c of configs){const key=linkKey(c);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
  return groups;
 };
 const installmentByLink=groups=>new Map(Array.from(groups,([key,list])=>[key,productInstallment(list)]));
 const rows=(groups=groupedConfigs(),changedIds=null)=>{
  const terms=installmentByLink(groups);
  return api.rows().filter(config=>shop==='all'||config.shopId===shop).map(config=>{
   if(changedIds&&!changedIds.has(config.id)&&rowCache.has(config.id))return rowCache.get(config.id);
   const row=priceProfitRow(config,{...api.settings(config.shopId),linkInstallment:terms.get(linkKey(config))});
   return {...row,flags:flagsFor(row)};
  });
 };
 const match=(row,needle)=>[row.config.name,row.config.shortName,row.config.product,row.config.productUrl,row.config.spu,row.config.skuId,shopName(row.config.shopId)].some(v=>String(v??'').toLowerCase().includes(needle));
 const currentPriceRow=id=>{const c=api.rows().find(c=>c.id===id);return c?priceProfitRow(c,{...api.settings(c.shopId),linkInstallment:productInstallment(api.links().filter(link=>linkKey(link)===linkKey(c)))}):null;};

 root.innerHTML=`
 <header class="pp-header">
  <div><h1 id="price-profit-title">价格与利润</h1><p>与配置总表共用成本、利润与配置编辑。展开即可换件、改数量和展示明细。</p></div>
  <div class="pp-actions"><button id="pp-undo" disabled>撤销</button><button id="pp-redo" disabled>重做</button>
   <button id="pp-batch">批量按利润定价</button><button id="pp-erp-match">ERP 勾选匹配 (0)</button><button id="pp-export-price-template">导出全店价格模板</button><button id="pp-save">保存到本机</button><span id="pp-save-count" role="status" hidden></span>
   <details class="pp-menu"><summary>更多</summary><div><button id="pp-back">返回配置</button><button id="pp-shop-settings">店铺设置</button><button id="pp-new-link">新建链接</button><button id="pp-status-filter" aria-label="筛选状态">全部状态 ▾</button></div></details>
  </div>
 </header>
 <section class="pp-sheet" aria-label="价格与利润工作表">
  <div class="pp-toolbar">
   <div class="pp-filters">
    <label class="pp-control pp-field"><span>店铺</span><select id="pp-shop"></select></label>
    <label class="pp-control pp-field"><span>链接</span><select id="pp-product"></select></label>
    <label class="pp-control pp-search"><input id="pp-search" aria-label="搜索配置" type="search" placeholder="搜索配置、SPU 或 SKU" autocomplete="off"></label>
    <button type="button" id="pp-part-filter" popovertarget="pp-part-panel">配件筛选 <strong id="pp-part-count" hidden></strong><i class="pp-chevron" aria-hidden="true"></i></button>
   </div>
   <div class="pp-tools">
    <div class="pp-switcher" role="group" aria-label="表格视图"><button id="pp-grouped" aria-pressed="true">按链接</button><button id="pp-flat" aria-pressed="false">平铺</button></div>
    <button id="pp-expand-links">全部展开链接</button><button id="pp-collapse-links">全部收起链接</button>
    <button id="pp-tax-reopen" hidden>单独核算价</button><button id="pp-more" aria-pressed="false">显示更多列</button><button id="pp-close-expanded">收起配置</button><button id="pp-copy-range" disabled>复制选区</button>
   </div>
  </div>
  <div id="pp-tax-banner" class="pp-tax-banner" hidden></div>
  <div class="pp-summary"><div id="pp-summary" role="group" aria-label="价格利润筛选"></div><div class="pp-tools"><small class="pp-alert-hint">启用的利润口径低于亏损线即标记预警</small><button id="pp-alert">预警规则</button></div></div>
  <div class="pp-formula"><strong id="pp-address">—</strong><span aria-hidden="true">fx</span><input id="pp-formula-value" aria-label="当前值或公式" readonly><small id="pp-formula-hint"></small><button id="pp-formula-detail" disabled>查看公式</button></div>
  <div class="pp-grid" tabindex="0" aria-label="价格与利润表格区域">
   <table class="pp-table">
    <colgroup>${columns.map(([,width],i)=>'<col class="'+colClass(i)+'" style="width:'+width+'px">').join('')}</colgroup>
    <thead>
     <tr class="pp-letters" aria-hidden="true">${columns.map((_,i)=>'<th class="'+colClass(i)+'" data-pp-letter="'+i+'">'+(i===0?'◢':String.fromCharCode(64+i))+'</th>').join('')}</tr>
     <tr class="pp-fields">${columns.map(([label,,key],i)=>'<th scope="col" data-pp-head="'+i+'" class="'+colClass(i)+'">'+(i===0?'序<input type="checkbox" id="pp-select-all" title="全选/取消全选当前可见配置" aria-label="全选可见配置">':key?'<button data-pp-sort="'+key+'">'+label+'<span aria-hidden="true"></span></button>':label)+'<span class="pp-resizer" data-pp-resize="'+i+'" title="拖动调宽，双击恢复默认"></span></th>').join('')}</tr>
    </thead><tbody id="pp-rows"></tbody>
   </table>
  </div>
  <footer class="pp-footer"><strong id="pp-selection"></strong><span id="pp-result-count" role="status"></span><span class="pp-help">拖动选区 · <kbd>Shift</kbd> 扩选 · <kbd>Ctrl</kbd> 多选 · <kbd>Ctrl</kbd>+<kbd>C</kbd> 复制</span></footer>
 </section>
 <aside id="pp-part-panel" class="pp-part-panel" popover="auto" aria-labelledby="pp-part-title">
  <header><h2 id="pp-part-title">按实际配件筛选</h2><button id="pp-part-clear">清空</button></header>
  <input id="pp-part-search" type="search" aria-label="实际配件筛选" placeholder="搜索型号或 GoodID" autocomplete="off">
  <div class="pp-switcher" role="group" aria-label="多个配件的匹配方式"><button data-pp-match="any" aria-pressed="true">匹配任一</button><button data-pp-match="all" aria-pressed="false">匹配全部</button></div>
  <div id="pp-part-tags"></div><div id="pp-part-choices"></div>
 </aside><span id="pp-status" class="pp-sr" role="status"></span>`;
 const body=$('#pp-rows');
 const grid=$('.pp-grid');
 const exportButton=$('#pp-export-price-template');
 const widthKey='diy-price-column-widths-v3';
 let widths=columns.map(c=>c[1]),resize=null,suppressSortUntil=0;
 try{const saved=JSON.parse(localStorage.getItem(widthKey));if(Array.isArray(saved)&&saved.length===columns.length&&saved.every(v=>Number.isFinite(v)&&v>=38&&v<=640))widths=saved;}catch{}
 function applyWidths(){
  table.querySelectorAll(':scope > colgroup > col').forEach((col,i)=>col.style.width=widths[i]+'px');
  table.style.setProperty('--pp-width',widths.slice(0,moreColumns?columns.length:defaultVisibleColumns).reduce((a,b)=>a+b,0)+'px');
 }
 const selectAll=$('#pp-select-all');
 const announce=message=>{$('#pp-status').textContent=message;api.toast(message);};
 const inputFor=(id,key)=>renderedRows.get(id)?.querySelector('[data-pp-cell="'+key+'"]');
 const focusCell=(id,key)=>{const el=inputFor(id,key);if(el){el.focus({preventScroll:true});el.select();el.scrollIntoView({block:'nearest',inline:'nearest'});}return !!el;};
 const isEdited=el=>el?.matches('[data-pp-cell]')&&el.value!==el.defaultValue;
 const partIdentity=part=>JSON.stringify([part.slot,part.goodsId||part.name]);
 const table=$('.pp-table'),partPanel=$('#pp-part-panel');
 const taxTools=mountTaxOverrideTools(root,{
  refresh:()=>refresh({force:true}),openDialog:api.openDialog,closeDialog:api.closeDialog,errorText:api.errorText??(error=>error.message),
  restore:entries=>mutate(()=>api.restoreTaxes(entries)),
  locate:id=>{
   // 定位仍停留在价格页；展开后聚焦该套首个独立含税价输入。
   taxTools.resetFilter();const config=api.rows().find(c=>c.id===id);if(!config)return;
   product='';$('#pp-search').value='';filter='all';statusFilter.clear();partFilters.clear();collapsed.delete(linkKey(config));expanded.add(id);
   refresh({force:true});markRange({id,col:11});const item=cards.get(id),line=taxTools.info(id)[0];
   const input=line&&[...(item?.container.querySelectorAll('.ov-tax-input')??[])].find(el=>el.getAttribute('aria-label')===config.name+' '+line.slot+'含税单价');
   if(input){input.focus({preventScroll:true});input.select();input.scrollIntoView({block:'center'});}
  }
 });
 new ResizeObserver(([entry])=>table.style.setProperty('--pp-frozen-width',entry.borderBoxSize[0].inlineSize+'px')).observe(table.tHead.rows[0].cells[0]);
 let filterChoices=[];
 const releaseCard=id=>{const item=cards.get(id);if(item){api.releaseCard?.(item.container);item.row.remove();cards.delete(id);}};
 // 仅补丁更新主行；展开卡片和正在输入的 DOM 始终保持同一个实例。
 function patchMainRow(old,next){
  for(const attr of ['data-expanded','data-selected'])old.toggleAttribute(attr,next.hasAttribute(attr));
  for(let i=0;i<next.cells.length;i++){
   const cell=old.cells[i],fresh=next.cells[i],input=cell.querySelector('[data-pp-cell]'),replacement=fresh.querySelector('[data-pp-cell]');
   cell.className=fresh.className;
   if(fresh.hasAttribute('data-profit-tone'))cell.dataset.profitTone=fresh.dataset.profitTone;
   if(input&&replacement){
    if(!pendingInputs.has(input)&&!(document.activeElement===input&&isEdited(input))){
     const focused=document.activeElement===input;
     const value=focused&&replacement.dataset.ppPrecise!==undefined?replacement.dataset.ppPrecise:replacement.value;
     input.value=input.defaultValue=value;
     if(replacement.dataset.ppPrecise!==undefined)input.dataset.ppPrecise=replacement.dataset.ppPrecise;
    }
    const button=cell.querySelector('[data-pp-expand]'),freshButton=fresh.querySelector('[data-pp-expand]');
    if(button){button.setAttribute('aria-expanded',freshButton.getAttribute('aria-expanded'));button.setAttribute('aria-label',freshButton.getAttribute('aria-label'));}
   }else if(cell.innerHTML!==fresh.innerHTML)cell.replaceChildren(...fresh.childNodes);
  }
 }
 function syncDetail(id,main,fresh){
  if(!fresh){releaseCard(id);return;}
  let item=cards.get(id);
  if(!item){item={row:fresh,container:fresh.querySelector('[data-pp-card]')};cards.set(id,item);}
  item.row.cells[0].colSpan=moreColumns?columns.length:defaultVisibleColumns;
  if(main.nextElementSibling!==item.row)main.after(item.row);
  api.renderCard?.(item.container,id);
 }
 function reconcileRows(markup,span){
  const parser=document.createRange();parser.selectNodeContents(body);
  const fragment=parser.createContextualFragment(markup||'<tr><td colspan="'+span+'" class="pp-empty">没有符合条件的配置</td></tr>');
  const next=[...fragment.children],keepCards=new Set(next.filter(row=>row.hasAttribute('data-pp-detail')).map(row=>row.dataset.ppDetail));
  for(const id of cards.keys())if(!keepCards.has(id))releaseCard(id);
  const wanted=[];
  for(const fresh of next){
   const id=fresh.dataset.ppRow;
   if(id){const old=renderedRows.get(id);if(old){patchMainRow(old,fresh);wanted.push(old);}else wanted.push(fresh);}
   else if(fresh.hasAttribute('data-pp-detail')){
    const id=fresh.dataset.ppDetail;let item=cards.get(id);
    if(!item){item={row:fresh,container:fresh.querySelector('[data-pp-card]')};cards.set(id,item);}
    item.row.cells[0].colSpan=span;wanted.push(item.row);
   }else wanted.push(fresh);
  }
  const retained=new Set(wanted);for(const row of [...body.children])if(!retained.has(row))row.remove();
  let cursor=body.firstElementChild;
  for(const row of wanted){if(row!==cursor)body.insertBefore(row,cursor);cursor=row.nextElementSibling;}
  for(const [id,item] of cards)api.renderCard?.(item.container,id);
 }
 function markDirtyCells(){
  const accepted=api.accepted?.()??[],base=new Map(accepted.map(c=>[c.id,c]));
  // 基线独立按链接汇总，已保存的混合分期与当前行使用相同的计算入口。
  const terms=installmentByLink(groupedConfigs(accepted));
  for(const [id,tr] of renderedRows){
   const row=rowCache.get(id),before=base.get(id);if(!row||!before)continue;
   const old=priceProfitRow(before,{...api.settings(before.shopId),linkInstallment:terms.get(linkKey(before))});
   const values=r=>({1:r.config.spu||'',2:r.config.skuId||'',3:r.config.shortName||r.config.name,4:r.quote.listPrice,5:r.quote.arrival,6:overviewFeeRate(r.config),7:r.metrics.taxProfitAfter,8:r.metrics.erpProfitAfter,11:r.metrics.tax,12:r.metrics.erp,15:r.metrics.basis});
   const original=values(old),current=values(row);
   for(const [col,value] of Object.entries(current)){
    const cell=tr.cells[col],dirty=original[col]!==value;
    cell.toggleAttribute('data-pp-dirty',dirty);
    cell.title=dirty?'未保存：'+(original[col]??'空')+' → '+(value??'空'):(col==='4'||col==='5')&&row.quote.coupon>0?'售价 '+money(row.quote.listPrice)+' = 到手价 + 店铺券 '+money(row.quote.coupon):'';
    if(col==='15'&&!dirty&&value!=null)cell.title='按 99 结尾显示，利润核算使用 '+money(value);
   }
  }
 }
 const matchesParts=config=>{
  if(!partFilters.size)return true;
  const parts=new Set(actualParts(config).map(partIdentity));
  const matches=Array.from(partFilters.keys(),key=>parts.has(key));
  return partMatch==='all'?matches.every(Boolean):matches.some(Boolean);
 };
 function drawPartFilter(){
  const query=$('#pp-part-search').value.trim().toLowerCase();
  const options=filterChoices.filter(({part})=>[part.name,part.slot,part.goodsId].some(value=>String(value??'').toLowerCase().includes(query))).slice(0,120);
  $('#pp-part-tags').innerHTML=Array.from(partFilters,([key,name])=>'<button type="button" data-pp-part-key="'+esc(key)+'" aria-pressed="true">'+esc(name)+' ×</button>').join('');
  $('#pp-part-choices').innerHTML=options.length?options.map(({key,part,count})=>'<button type="button" data-pp-part-key="'+esc(key)+'" aria-pressed="'+partFilters.has(key)+'"><strong>'+esc(part.slot)+'</strong><span>'+esc(part.name)+'</span><small>'+count+' 套</small></button>').join(''):'<p>没有匹配的实际配件。</p>';
  $('#pp-part-count').hidden=!partFilters.size;
  $('#pp-part-count').textContent=partFilters.size;
  $('#pp-part-clear').disabled=!partFilters.size;
  partPanel.querySelectorAll('[data-pp-match]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.ppMatch===partMatch)));
 }
 function collectPartChoices(){
  const partsByKey=new Map();
  for(const {config} of linkScope){
   const seen=new Set();
   for(const part of actualParts(config)){
    if(!part.name||part.qty<=0||isSpecialComponent(part))continue;
    const key=partIdentity(part);if(seen.has(key))continue;
    seen.add(key);
    const option=partsByKey.get(key);
    if(option)option.count++;
    else partsByKey.set(key,{key,part,count:1});
   }
  }
  filterChoices=Array.from(partsByKey.values()).sort((a,b)=>b.count-a.count);
  drawPartFilter();
 }
 function updateLinkHeader(header,key,config){
  if(!header)return;
  const selected=activeLink===key,hidden=activeCollapsed.has(key);
  header.toggleAttribute('data-current-link',selected);
  header.querySelector('[data-pp-select-link]').setAttribute('aria-pressed',String(selected));
  header.querySelector('[data-pp-jump-link]').hidden=!selected;
  header.querySelector('[data-pp-edit-link]').hidden=!selected;
  const spu=header.querySelector('[data-pp-link-spu]');spu.hidden=hidden&&!selected;
  if(config)spu.textContent='SPU '+(config.spu||'—');
 }

 function refresh({force=false,ids=null,baselineOnly=false}={}){
  if(!visible()||rendering)return;
  // 回执只更新已绘制单元格的角标和提示，编辑或框选期间也能安全执行。
  if(baselineOnly){markDirtyCells();return;}
  if(pendingWrites){if(force)fullDrawRequested=true;return;}
  if(!force&&(isEdited(document.activeElement)||pointerDown))return;
  const existingFocus=document.activeElement,focused=body.contains(existingFocus)&&existingFocus.matches('[data-pp-cell]')?[existingFocus.dataset.rowId,existingFocus.dataset.ppCell]:null;
  const activeSummary=existingFocus?.dataset.ppFilter;
  const needle=$('#pp-search').value.trim().toLowerCase();
  // 活跃筛选或排序可能改变可见行及其位置，普通编辑只替换受影响的行。
  const patch=ids&&rowCache.size&&!sort&&filter==='all'&&!needle&&!statusFilter.size&&!partFilters.size&&!taxTools.active();
  rendering=true;
  try{
   const groups=groupedConfigs(),inShop=rows(groups,patch?ids:null);
   rowCache=new Map(inShop.map(row=>[row.config.id,row]));
   const links=new Map(Array.from(groups).filter(([,list])=>shop==='all'||list[0].shopId===shop).map(([key,list])=>[key,list[0]]));
   if(!links.has(product))product='';
   if(!patch){
    const shops=api.shops.map(s=>[s.id,s.name]);
    $('#pp-shop').innerHTML=options(api.nas?shops:[['all','全部店铺'],...shops],shop);
    $('#pp-product').innerHTML=options([['','全部链接'],...Array.from(links,([key,c])=>[key,(shop==='all'?shopName(c.shopId)+' · ':'')+(c.product||'未命名链接')])],product);
   }
   $('#pp-shop-settings').disabled=shop==='all';
   $('#pp-alert').disabled=shop==='all';
   $('#pp-shop-settings').title=shop==='all'?'请选择需要修改的店铺':'';
   $('#pp-alert').title=shop==='all'?'请选择需要修改的店铺':'';
   exportButton.disabled=shop==='all';
   exportButton.title=shop==='all'?'请选择需要导出的店铺':'导出当前店铺完整的抖店批量改价模板';
   linkScope=inShop.filter(r=>(!product||product===linkKey(r.config))&&match(r,needle));
   if(partPanel.matches(':popover-open'))collectPartChoices();
   const scope=linkScope.filter(r=>matchesParts(r.config));
   const counts=Object.fromEntries(filters.map(([key])=>[key,key==='all'?scope.length:scope.filter(r=>r.flags[key]).length]));
   if(patch){for(const [key] of filters)$(`[data-pp-filter="${key}"] strong`).textContent=counts[key];}
   else{
    $('#pp-summary').innerHTML=filters.map(([key,label])=>'<button type="button" data-pp-filter="'+key+'" aria-pressed="'+String(filter===key)+'"><span>'+label+'</span><strong>'+counts[key]+'</strong></button>').join('');
    if(activeSummary)$('#pp-summary').querySelector('[data-pp-filter="'+activeSummary+'"]')?.focus({preventScroll:true});
   }
   const basicFiltered=scope.filter(r=>(filter==='all'||r.flags[filter])&&(!statusFilter.size||statusKeys(r.flags).some(key=>statusFilter.has(key))));
   taxTools.update(basicFiltered.map(row=>row.config),api.costs?.()??[]);
   const filtered=basicFiltered.filter(row=>taxTools.matches(row.config));
   $('#pp-status-filter').textContent=(statusFilter.size?'已选 '+statusFilter.size+' 项':'全部状态')+' ▾';
   // 结果数量包含折叠组中的匹配配置；底部可见数量仍表示可操作行。
   $('#pp-result-count').textContent='筛选结果：'+filtered.length+' 套配置';
   const sortRows=list=>{
    if(!sort)return;
    const value=r=>sort.key==='arrival'?r.quote.arrival:r.metrics[sort.key];
    list.sort((a,b)=>{const x=value(a),y=value(b);return x==null?+(y!=null):y==null?-1:(x-y)*sort.direction;});
   };
   table.querySelectorAll('[data-pp-sort]').forEach(button=>{
    const active=sort?.key===button.dataset.ppSort;
    button.querySelector('span').textContent=active?(sort.direction===1?'↑':'↓'):'↕';
    button.closest('th').setAttribute('aria-sort',active?(sort.direction===1?'ascending':'descending'):'none');
   });
   const displayLinks=new Map();
   for(const row of filtered){const key=linkKey(row.config);if(!displayLinks.has(key))displayLinks.set(key,[]);displayLinks.get(key).push(row);}
   const showEmpty=filter==='all'&&!needle&&!statusFilter.size&&!partFilters.size&&!taxTools.active();
   const displayedGroups=grouped?[...links].filter(([key])=>displayLinks.has(key)||
    showEmpty&&(!product||key===product)&&groups.get(key).some(c=>c.emptyLinkDraft)):[];
   visibleGroups=displayLinks;
   activeCollapsed=collapsed;
   if(needle){
    if(displayedGroups.length<=20||filtered.length<=300)activeCollapsed=searchCollapsed;
    else {
     if(!largeSearchCollapsed)largeSearchCollapsed=new Set(collapsed);
     activeCollapsed=largeSearchCollapsed;
    }
   }
   // 可销按实际配件及用量折算；缺少库存时显示未知。
   if(!patch){
    stockIndex=new Map();
    for(const part of api.costs?.()??[]){if(!stockIndex.has(part.goodsId))stockIndex.set(part.goodsId,[]);stockIndex.get(part.goodsId).push(part);}
   }
   let sequence=0;
   const span=moreColumns?columns.length:defaultVisibleColumns;
   applyWidths();
   const rowHTML=(row,number)=>{
    const {config:c,quote:p,metrics:t,flags:f}=row;
    const overrides=taxTools.info(c.id),difference=taxDelta(overrides);
    const status=[...f.hits.loss.map(key=>['destructive',(key==='erp'?'ERP':'核算')+'亏损预警']),f.missing?['muted','资料缺失']:null,f.fallback?['warning','ERP 成本代入']:null].filter(Boolean);
    if(!status.length)status.push(['success','正常']);
    const id=esc(c.id),picked=chosen.has(c.id),open=expanded.has(c.id);
    const editor=(key,value)=>'<input class="pp-cell '+(key==='price'?'pp-price-cell':key==='shortName'?'pp-name-cell':['rate','taxTarget','erpTarget'].includes(key)?'pp-number-cell':'pp-id-cell')+'" aria-label="'+esc(c.name)+' '+fieldNames[key]+'" data-row-id="'+id+'" data-pp-cell="'+key+'" inputmode="'+(key==='price'?'decimal':key==='shortName'?'text':'numeric')+'" autocomplete="off" spellcheck="false"'+(preciseKeys.has(key)?' data-pp-precise="'+esc(value)+'"':'')+' value="'+esc(preciseKeys.has(key)&&value!=null?whole(value):value)+'">';
    const cell=(col,text,classes='',profit)=>'<td data-pp-col="'+col+'" class="'+classes+colClass(col)+'"'+(profit!==undefined?' data-profit-tone="'+profitTone(profit)+'"':'')+'>'+text+'</td>';
    const numeric=(col,value,tone=false)=>cell(col,whole(value),'pp-number',tone?value:undefined);
    const {stockAvailable:stock,stockIncomingAvailable:incoming}=configurationStock(c,stockIndex);
    const inTransit=stock!=null&&stock<=0&&incoming>0;
    const stockLabel=whole(stock)+(inTransit?'<small class="pp-incoming" title="有货在途">待入'+whole(incoming)+'</small>':'');
    const chassis=actualParts(c).find(part=>part.slot==='机箱');
    // 改核算价胶囊优先显示，不能被前面的“正常”占满状态列而隐藏。
    const badge=(overrides.length?'<button class="pp-tax-pill" data-tax-locate="'+esc(c.id)+'">改核算价×'+overrides.length+' ('+deltaLabel(difference)+')</button>':'')+status.filter(([,label])=>!overrides.length||label!=='正常').map(([kind,label])=>'<span class="pp-badge" data-variant="'+kind+'">'+esc(label)+'</span>').join('');
    const main='<tr data-pp-row="'+id+'"'+(picked?' data-selected':'')+(open?' data-expanded':'')+'>'+
      cell(0,'<label class="pp-seq"><input type="checkbox" data-pp-pick="'+id+'" aria-label="勾选 '+esc(c.name)+'"'+(picked?' checked':'')+'><span>'+number+'</span></label>')+
      cell(1,editor('spu',c.spu))+cell(2,editor('sku',c.skuId))+
      cell(3,'<div class="pp-config-cell"><button type="button" class="pp-config-link" aria-label="'+(open?'收起':'展开')+esc(c.name)+'实际配件" data-pp-expand="'+id+'" aria-expanded="'+open+'"><i class="pp-chevron" aria-hidden="true"></i></button>'+editor('shortName',c.shortName||c.name)+'</div>')+
      numeric(4,p.listPrice)+cell(5,editor('price',p.arrival))+cell(6,editor('rate',overviewFeeRate(c)))+
      cell(7,editor('taxTarget',t.taxProfitAfter),'pp-number',t.taxProfitAfter)+cell(8,editor('erpTarget',t.erpProfitAfter),'pp-number',t.erpProfitAfter)+cell(9,percent(t.taxMargin),'pp-number',t.taxProfitAfter)+cell(10,stockLabel,'pp-number'+(stock===0&&!inTransit?' pp-out':''))+cell(11,overrides.length?'<button class="pp-tax-cost" data-tax-locate="'+esc(c.id)+'">'+whole(t.tax)+'<small>'+deltaLabel(difference)+'</small></button>':whole(t.tax),'pp-number'+(overrides.length?' pp-tax-changed':''))+numeric(12,t.erp)+
      // 费率成本仅在价格表按 99 结尾展示；缺失成本保留为空值。
      cell(13,badge,'pp-status-cell')+cell(14,esc(chassis?.name||'—'),'pp-chassis')+numeric(15,t.basis==null?null:snap99(t.basis))+
      cell(16,percent(t.erpMargin),'pp-number',t.erpProfitAfter)+numeric(17,t.taxDeduction)+numeric(18,t.erpDeduction)+numeric(19,p.fee)+numeric(20,incoming)+'</tr>';
    if(!open)return main;
    return main+'<tr data-pp-detail="'+id+'" class="pp-expanded"><td colspan="'+span+'"><section class="pp-detail"><div data-pp-card="'+id+'"></div></section></td></tr>';
   };
   $('#pp-expand-links').disabled=!grouped||!displayedGroups.some(([key])=>activeCollapsed.has(key));
   $('#pp-collapse-links').disabled=!grouped||!displayedGroups.some(([key])=>!activeCollapsed.has(key));
   if(patch){
    for(const id of ids){
     const row=rowCache.get(id);if(!row)continue;
     const key=linkKey(row.config);
     updateLinkHeader(renderedLinks.get(key),key,links.get(key));
     const old=renderedRows.get(id);if(!old)continue;
     const fragment=document.createRange();fragment.selectNode(old);
     const replacement=fragment.createContextualFragment(rowHTML(row,old.querySelector('.pp-seq span').textContent));
     patchMainRow(old,replacement.firstElementChild);
     syncDetail(id,old,replacement.querySelector('[data-pp-detail]'));
    }
    historyButtons();markDirtyCells();paintRange();
    if(focused&&!existingFocus.isConnected)focusCell(...focused);
    return;
   }
   const shown=[];
   if(grouped){
    const markup=displayedGroups.map(([key,c])=>{
     const group=displayLinks.get(key)||[],hidden=activeCollapsed.has(key),k=esc(key);
     sortRows(group);
     if(!hidden)shown.push(...group);
     const term=productInstallment(groups.get(key)),hint='息点跟随店铺 · '+(term===null?'分期设置不一致':term?term+' 期免息':'不分期');
     const current=activeLink===key,groupOverrides=taxTools.group(group.map(row=>row.config.id)),changedConfigs=new Set(groupOverrides.map(line=>line.configId));
     const taxTag=groupOverrides.length?'<button class="pp-tax-pill" data-tax-group="'+esc(JSON.stringify([...changedConfigs]))+'">单独核算 '+changedConfigs.size+' 套 ('+deltaLabel(taxDelta(groupOverrides))+')</button>':'';
     return '<tr class="pp-link-group" data-pp-group="'+k+'"'+(current?' data-current-link':'')+'><td class="pp-frozen-number"><input type="checkbox" data-pp-pick-link="'+k+'" aria-label="整链全选 '+esc(c.product||'未命名链接')+'"></td><td colspan="3"><div class="pp-group-id"><button type="button" data-pp-collapse="'+k+'" aria-expanded="'+String(!hidden)+'" aria-label="'+(hidden?'展开':'收起')+esc(c.product||'未命名链接')+'"><i class="pp-chevron" aria-hidden="true"></i></button><button type="button" data-pp-select-link="'+k+'" aria-pressed="'+current+'"><strong>'+esc(c.product||'未命名链接')+'</strong><small>'+group.length+' 套</small></button>'+taxTag+'<button type="button" data-pp-jump-link="'+k+'"'+(current?'':' hidden')+'>编辑配置</button></div></td><td colspan="'+(span-4)+'"><div class="pp-group-meta"><span data-pp-link-spu'+(hidden&&!current?' hidden':'')+'>SPU '+esc(c.spu||'—')+'</span><div class="pp-link-controls"><label>整链费率 <input data-pp-link-rate="'+k+'" aria-label="整链运营费率" value="'+overviewFeeRate(c)+'" size="3">%</label><label><input type="checkbox" data-pp-link99="'+k+'"'+(groups.get(key).every(c=>c.overviewPrice99)?' checked':'')+'>整链99结尾</label><label>整链分期 <select data-pp-link-term="'+k+'">'+options([[0,'不分期'],[6,'6 期'],[12,'12 期'],[24,'24 期（10%）']],term)+'</select></label><button type="button" data-pp-edit-link="'+k+'" title="'+esc(hint)+'"'+(current?'':' hidden')+'>链接设置</button></div></div></td></tr>'+
       (hidden?'':group.length?group.map(row=>rowHTML(row,++sequence)).join(''):'<tr><td colspan="'+span+'" class="pp-empty">此链接尚无配置价格，可在配置页继续编辑。</td></tr>');
    }).join('');
    reconcileRows(markup,span);
   }else{sortRows(filtered);shown.push(...filtered);reconcileRows(filtered.map(row=>rowHTML(row,++sequence)).join(''),span);}
   drawnIds=shown.map(r=>r.config.id);
   renderedRows=new Map(Array.from(body.rows).filter(row=>row.hasAttribute('data-pp-row')).map(row=>[row.dataset.ppRow,row]));
   renderedLinks=new Map(Array.from(body.rows).filter(row=>row.hasAttribute('data-pp-group')).map(row=>[row.dataset.ppGroup,row]));
   chosen=new Set(drawnIds.filter(id=>chosen.has(id)));
   syncSelection();historyButtons();markDirtyCells();paintRange();
   if(focused)focusCell(...focused);
  }finally{rendering=false;}
 }
 function historyButtons(){
  const [undo,redo]=api.history();
  $('#pp-undo').disabled=!undo;$('#pp-redo').disabled=!redo;
 }
 function syncSelection(only=null){
  for(const [key,tr] of renderedLinks){
   const checkbox=tr.querySelector('[data-pp-pick-link]'),rows=visibleGroups.get(key)||[];
   const count=rows.reduce((sum,row)=>sum+Number(chosen.has(row.config.id)),0);
   checkbox.checked=!!count&&count===rows.length;
   checkbox.indeterminate=count>0&&count<rows.length;
   checkbox.disabled=!rows.length;
  }
  selectAll.disabled=!drawnIds.length;
  selectAll.checked=!!drawnIds.length&&chosen.size===drawnIds.length;
  selectAll.indeterminate=!!chosen.size&&!selectAll.checked;
  $('#pp-selection').textContent='可见 '+drawnIds.length+' 套 · 已选 '+chosen.size+' 套';
  api.onErpSelection?.(chosen.size);
  $('#pp-batch').disabled=false;
  for(const tr of only?[renderedRows.get(only)]:renderedRows.values()){
   const checked=chosen.has(tr.dataset.ppRow);
   tr.toggleAttribute('data-selected',checked);tr.querySelector('[data-pp-pick]').checked=checked;
  }
 }
 // 按触发先后处理草稿写入和撤销重做，结算前保留当前单元格内容。
 function mutate(operation){
  const queued=pendingWrites++>0;
  const run=queued?writeTail.then(operation):Promise.resolve().then(operation);
  const result=run.finally(()=>{if(!--pendingWrites&&(deferredDraw||fullDrawRequested))scheduleRefresh();});
  writeTail=result.catch(()=>{});
  return result;
 }
 function flushRowRefresh(){
  if(!visible()||pendingWrites||pointerDown||isEdited(document.activeElement))return;
  const ids=fullDrawRequested?null:new Set(dirtyRows);
  dirtyRows.clear();deferredDraw=false;fullDrawRequested=false;
  if(!ids||ids.size)refresh({ids});
 }
 function scheduleRefresh(ids=[]){
  ids.forEach(id=>dirtyRows.add(id));deferredDraw=true;
  clearTimeout(renderTimer);
  renderTimer=setTimeout(flushRowRefresh,0);
 }
 function rejectInput(error){
  inputRejected=error;announce(api.errorText?.(error)||error.message);return false;
 }
 function commitInput(el){
  if(pendingInputs.has(el))return false;
  if(!isEdited(el))return true;
  inputRejected=null;
  const {ppCell:key,rowId:id}=el.dataset;
  try{
   const current=currentPriceRow(id);if(!current)throw Error('配置范围已变化，请重新选择。');
   // 单格与矩阵复用完整校验，目标利润复用总表 priceForTarget/snap99。
   const value=el.value;
   let plan=planPriceMatrix(api.allConfigs(),[id],[key],[[value]],api.settings);
   if(!plan.length){el.value=el.defaultValue;return true;}
   pendingInputs.add(el);el.readOnly=true;
   const result=mutate(()=>api.apply(configs=>{
    plan=planPriceMatrix(configs,[id],[key],[[value]],api.settings);return plan;
   },key==='price'?'调整到手价':'修改 '+fieldNames[key],{scopeIds:[id]})).then(()=>{
    if(preciseKeys.has(key)){
     // 目标利润经过反推及整链取整，提交后显示实际核算值。
     const updated=currentPriceRow(id);
     const precise=key==='price'?updated.quote.arrival:updated.metrics[key==='taxTarget'?'taxProfitAfter':'erpProfitAfter'];
     el.value=el.dataset.ppPrecise=String(precise??'');
    }
    el.defaultValue=el.value;
    if(preciseKeys.has(key)&&document.activeElement!==el)formatAmount(el);
    scheduleRefresh(plan.map(row=>row.id));return true;
   },error=>{
    el.value=el.defaultValue;
    if(preciseKeys.has(key)&&document.activeElement!==el)formatAmount(el);
    return rejectInput(error);
   }).finally(()=>{
    pendingInputs.delete(el);pendingInputResults.delete(result);el.readOnly=false;
   });
   pendingInputResults.add(result);return result;
  }catch(error){el.value=el.defaultValue;return rejectInput(error);}
 }
 function formatAmount(field){
  const precise=field.dataset.ppPrecise;
  field.value=field.defaultValue=precise===''?'':whole(Number(precise));
 }
 body.addEventListener('focusin',event=>{const field=event.target;if(field.matches('[data-pp-cell]')){
  if(pendingInputs.has(field))return;
  if(field.dataset.ppPrecise!==undefined)field.value=field.defaultValue=field.dataset.ppPrecise;
  field.select();if(!pointerDown)markRange(cellPosition(field));
 }});
 body.addEventListener('focusout',event=>{
  const field=event.target;
  if(rendering||pendingInputs.has(field))return;
  const edited=field.isConnected&&isEdited(field);
  if(edited){
   const result=commitInput(field);
   if(typeof result==='boolean'&&field.dataset.ppPrecise!==undefined)formatAmount(field);
  }else if(field.dataset.ppPrecise!==undefined)formatAmount(field);
  if(deferredDraw)scheduleRefresh();
 });
 function focusRange(){
  grid.focus({preventScroll:true});
  document.getSelection()?.removeAllRanges();
 }
 let dragState=null;
 body.addEventListener('pointerdown',event=>{
  if(event.button!==0||!event.isPrimary||event.target.closest('.pp-expanded'))return;
  const pos=cellPosition(event.target);
  if(!pos||event.target.closest('button,.pp-seq'))return;
  pointerDown=true;
  rangePointer=event.pointerId;
  const input=event.target.closest('[data-pp-cell]'),focused=input===document.activeElement;
  dragState={pos,input,focused,x:event.clientX,y:event.clientY,moved:false,modified:event.shiftKey||event.ctrlKey||event.metaKey};
  markRange(pos,event.shiftKey,event.ctrlKey);
  // 原地松开才编辑，拖动从任何列启动；已聚焦输入框保留格内光标操作。
  if(!focused||dragState.modified){
   event.preventDefault();
   if(dragState.modified)focusRange();
  }
 });
 document.addEventListener('pointermove',event=>{
  if(!dragState||rangePointer!==event.pointerId||!(event.buttons&1)||!range)return;
  const pos=cellPosition(document.elementFromPoint(event.clientX,event.clientY));
  if(!dragState.moved&&pos?.id===dragState.pos.id&&pos.col===dragState.pos.col&&Math.hypot(event.clientX-dragState.x,event.clientY-dragState.y)<4)return;
  if(dragState.focused&&!dragState.moved&&pos?.id===dragState.pos.id&&pos.col===dragState.pos.col)return;
  dragState.moved=true;document.body.classList.add('pp-selecting');
  event.preventDefault();
  if(pos)markRange(pos,true);focusRange();
 });
 body.addEventListener('dragstart',event=>{if(!event.target.closest('.pp-expanded')&&event.target.closest('[data-pp-row]'))event.preventDefault();});
 const endPointer=(cancelled=false)=>{
  const drag=dragState;dragState=null;pointerDown=false;rangePointer=null;document.body.classList.remove('pp-selecting');
  if(drag&&!cancelled&&!drag.moved&&!drag.modified){if(drag.input){if(!drag.focused){drag.input.focus({preventScroll:true});drag.input.select();}}else focusRange();}
  if(visible()&&deferredDraw)scheduleRefresh();
 };
 // 保留正在点击的单元格，直到 click 完成才允许重建可见行。
 document.addEventListener('pointerup',()=>{if(pointerDown)endPointer();});
 document.addEventListener('pointercancel',()=>{if(pointerDown)endPointer(true);});
 grid.addEventListener('paste',event=>{
  if(event.target.closest('.pp-expanded'))return;
  const input=event.target,text=(event.clipboardData?.getData('text/plain')??'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(input.matches('[data-pp-cell]')&&!/[\t\n]/.test(text))return;
  const pos=cellPosition(input)??range?.end;if(!pos)return;
  event.preventDefault();
  try{
   const lines=text.split('\n');while(lines.at(-1)==='')lines.pop();
   const key=writableColumns[pos.col];
   if(lines.length>1&&['spu','sku'].includes(key)&&new RegExp('^'+key+'(?:\\s*(?:id|编码))?$','i').test(lines[0].trim()))lines.shift();
   const matrix=lines.map(line=>line.split('\t')),i=drawnIds.indexOf(pos.id);
   if(i<0)throw Error('当前行已改变，请重新选择单元格。');
   if(!matrix.length||matrix.length>drawnIds.length-i)throw Error('粘贴内容超过当前单元格后可见行数。');
   const ids=drawnIds.slice(i,i+matrix.length),keys=columns.slice(pos.col,moreColumns?columns.length:defaultVisibleColumns).map((_,offset)=>writableColumns[pos.col+offset]??null);
   const editor=input.matches('[data-pp-cell]')?input:null;
   if(editor&&pendingInputs.has(editor))throw Error('请等待当前编辑完成');
   // 多格粘贴暂时接管当前草稿；成功才舍弃旧输入，失败时保留原文字供继续编辑。
   if(editor){pendingInputs.add(editor);editor.readOnly=true;}
   const unlock=()=>{if(editor){pendingInputs.delete(editor);editor.readOnly=false;}};
   // 载入所有 linkId 后才整批验证；统一提交一次，Ctrl+Z 一步撤销。
   mutate(()=>api.apply(configs=>planPriceMatrix(configs,ids,keys,matrix,api.settings),'表格矩阵粘贴',{scopeIds:ids})).then(()=>{
    if(editor)editor.value=editor.defaultValue;
    unlock();
    fullDrawRequested=true;scheduleRefresh();flushRowRefresh();announce('已粘贴 '+matrix.length+' 行，可撤销。');
   },error=>{unlock();announce(api.errorText?.(error)||error.message);});
  }catch(error){announce(api.errorText?.(error)||error.message);}
 });
 body.addEventListener('keydown',async event=>{
  const el=event.target,key=el.dataset.ppCell,id=el.dataset.rowId;
  if(!key||event.isComposing)return;
  if(pendingInputs.has(el)){if(['Escape','Enter','Tab','ArrowUp','ArrowDown'].includes(event.key))event.preventDefault();return;}
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
  const result=commitInput(el),success=typeof result==='boolean'?result:await result;
  if(document.activeElement!==el)return;
  if(!success){el.select();return;}
  flushRowRefresh();
  if(!oldOrder[row]&&event.key==='Tab'){(event.shiftKey?selectAll:$('#pp-batch').disabled?$('#pp-save'):$('#pp-batch')).focus();return;}
  if(!focusCell(oldOrder[Math.max(0,Math.min(oldOrder.length-1,row))],fields[fieldIndex]))focusCell(drawnIds[Math.min(row,drawnIds.length-1)],fields[fieldIndex]);
 });
 selectAll.onchange=()=>{chosen=new Set(selectAll.checked?drawnIds:[]);syncSelection();};
 body.addEventListener('change',event=>{
  const key=event.target.dataset.ppPickLink;
  if(key){
   const checked=event.target.checked;
   for(const row of visibleGroups.get(key)||[]){
    if(checked)chosen.add(row.config.id);else chosen.delete(row.config.id);
   }
   if(checked&&activeCollapsed.delete(key))refresh({force:true});else syncSelection();
   return;
  }
  const id=event.target.dataset.ppPick;
  if(id){event.target.checked?chosen.add(id):chosen.delete(id);syncSelection(id);}
 });
 const reroute=()=>{chosen.clear();clearRange();refresh({force:true});};
 // 状态多选采用“任一匹配”，并与店铺、链接、搜索及汇总筛选叠加。
 $('#pp-status-filter').onclick=()=>{
  api.openDialog('筛选状态','<p class="hint">可多选，显示包含任一所选状态的配置；不勾选时显示全部状态。</p><div class="pp-status-options">'+statusChoices.map(([key,label])=>`<label><input type="checkbox" data-pp-status-choice="${key}"${statusFilter.has(key)?' checked':''}> ${label}</label>`).join('')+'</div><div class="actions"><button id="pp-status-clear">清除筛选</button><button id="pp-status-apply" class="primary">应用</button></div>');
  const d=dialog();
  d.querySelector('#pp-status-clear').onclick=()=>{statusFilter.clear();api.closeDialog();reroute();};
  d.querySelector('#pp-status-apply').onclick=()=>{statusFilter=new Set(Array.from(d.querySelectorAll('[data-pp-status-choice]:checked'),el=>el.dataset.ppStatusChoice));api.closeDialog();reroute();};
 };
 $('#pp-shop').onchange=e=>{shop=e.target.value;product='';activeLink='';collapsed.clear();partFilters.clear();reroute();};
 $('#pp-product').onchange=e=>{product=e.target.value;activeCollapsed?.delete(product);reroute();};
 $('#pp-search').oninput=()=>{searchCollapsed.clear();largeSearchCollapsed=null;reroute();};
 $('#pp-part-search').oninput=drawPartFilter;
 partPanel.addEventListener('beforetoggle',event=>{
  if(event.newState!=='open')return;
  const bounds=$('#pp-part-filter').getBoundingClientRect();
  partPanel.style.left=Math.max(8,Math.min(bounds.left,innerWidth-450))+'px';
  partPanel.style.top= bounds.bottom+5+'px';
  collectPartChoices();
 });
 partPanel.onclick=event=>{
  const button=event.target.closest('button');if(!button)return;
  const {ppPartKey:key,ppMatch:mode}=button.dataset;
  if(button.id==='pp-part-clear')partFilters.clear();
  else if(mode)partMatch=mode;
  else if(key){
   if(partFilters.has(key))partFilters.delete(key);
   else {const choice=filterChoices.find(option=>option.key===key);if(choice)partFilters.set(key,choice.part.name);}
  }else return;
  reroute();
  if(key)Array.from(partPanel.querySelectorAll('[data-pp-part-key]')).find(item=>item.dataset.ppPartKey===key)?.focus();
 };
 table.tHead.onclick=event=>{
  if(performance.now()<suppressSortUntil||event.target.closest('[data-pp-resize]'))return;
  const key=event.target.closest('[data-pp-sort]')?.dataset.ppSort;
  if(key){sort=sort?.key!==key?{key,direction:1}:sort.direction===1?{key,direction:-1}:null;reroute();}
 };
 table.tHead.addEventListener('pointerdown',event=>{
  const handle=event.target.closest('[data-pp-resize]');if(!handle||event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  resize={id:event.pointerId,col:Number(handle.dataset.ppResize),x:event.clientX,width:widths[Number(handle.dataset.ppResize)]};
  handle.setPointerCapture(event.pointerId);
 });
 table.tHead.addEventListener('pointermove',event=>{
  if(!resize||resize.id!==event.pointerId)return;
  widths[resize.col]=Math.round(Math.max(resize.col===0?38:48,Math.min(640,resize.width+event.clientX-resize.x)));applyWidths();
 });
 const endResize=event=>{if(!resize||resize.id!==event.pointerId)return;resize=null;suppressSortUntil=performance.now()+400;localStorage.setItem(widthKey,JSON.stringify(widths));};
 table.tHead.addEventListener('pointerup',endResize);table.tHead.addEventListener('pointercancel',endResize);
 table.tHead.addEventListener('dblclick',event=>{const handle=event.target.closest('[data-pp-resize]');if(!handle)return;event.preventDefault();const col=Number(handle.dataset.ppResize);widths[col]=columns[col][1];applyWidths();localStorage.setItem(widthKey,JSON.stringify(widths));});
 $('#pp-expand-links').onclick=()=>{activeCollapsed.clear();refresh({force:true});};
 $('#pp-collapse-links').onclick=()=>{for(const key of visibleGroups.keys())activeCollapsed.add(key);refresh({force:true});};
 $('#pp-more').onclick=()=>{moreColumns=!moreColumns;root.toggleAttribute('data-pp-more',moreColumns);$('#pp-more').setAttribute('aria-pressed',String(moreColumns));refresh({force:true});};
 $('#pp-close-expanded').onclick=()=>{expanded.clear();refresh({force:true});};
 $('#pp-summary').onclick=e=>{const key=e.target.closest('[data-pp-filter]')?.dataset.ppFilter;if(key){filter=key;reroute();}};
 for(const [key,value] of [['grouped',true],['flat',false]])$('#pp-'+key).onclick=()=>{
  grouped=value;$('#pp-grouped').setAttribute('aria-pressed',String(value));$('#pp-flat').setAttribute('aria-pressed',String(!value));reroute();
 };
 body.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  const {ppCollapse,ppEditLink,ppExpand,ppSelectLink,ppJumpLink,ppPickPart,ppConfig}=b.dataset;
  if(ppCollapse){
   activeCollapsed.has(ppCollapse)?activeCollapsed.delete(ppCollapse):activeCollapsed.add(ppCollapse);refresh({force:true});
   Array.from(body.querySelectorAll('[data-pp-collapse]')).find(el=>el.dataset.ppCollapse===ppCollapse)?.focus();
  }
  if(ppSelectLink){
   const previous=activeLink;activeLink=ppSelectLink;
   updateLinkHeader(renderedLinks.get(previous),previous);
   updateLinkHeader(renderedLinks.get(activeLink),activeLink);
  }
  if(ppJumpLink){const c=api.rows().find(row=>linkKey(row)===ppJumpLink);if(c){void hide(c);}else{const link=api.links().find(row=>linkKey(row)===ppJumpLink);if(link)api.editLink(link);}}
  if(ppEditLink){const c=api.links().find(c=>linkKey(c)===ppEditLink);if(c)api.editLink(c);}
  if(ppExpand){expanded.has(ppExpand)?expanded.delete(ppExpand):expanded.add(ppExpand);refresh({force:true,ids:new Set([ppExpand])});body.querySelector('[data-pp-expand="'+CSS.escape(ppExpand)+'"]')?.focus({preventScroll:true});}
 });
 body.addEventListener('change',event=>{
  const input=event.target,key=input.dataset.ppLinkTerm??input.dataset.ppLink99??input.dataset.ppLinkRate;if(!key)return;
  const ids=api.links().filter(c=>linkKey(c)===key).map(c=>c.id),fields={};
  try{
   if(input.hasAttribute('data-pp-link-term'))fields.installment=Number(input.value);
   else if(input.hasAttribute('data-pp-link-rate'))fields.overviewFeeRate=readOverviewFeeRate(input.value);
   else fields.overviewPrice99=input.checked;
   mutate(()=>api.apply(configs=>configs.filter(c=>!c.deletedAt&&linkKey(c)===key).map(c=>({id:c.id,fields:{...fields,...(fields.overviewPrice99&&c.price!=null?{price:snap99(c.price)}:{})}})),'修改整链价格属性',{scopeIds:ids})).then(()=>{fullDrawRequested=true;scheduleRefresh();},error=>{announce(api.errorText?.(error)||error.message);refresh({force:true});});
  }catch(error){announce(api.errorText?.(error)||error.message);refresh({force:true});}
 });
 body.addEventListener('keydown',event=>{if(event.target.matches('[data-pp-link-rate]')&&event.key==='Enter'){event.preventDefault();event.target.blur();}});
 $('#pp-back').onclick=()=>hide();
 $('#pp-shop-settings').onclick=()=>api.editShop(shop);
 $('#pp-alert').onclick=()=>openAlert();
 $('#pp-new-link').onclick=()=>api.newLink(shop==='all'?api.activeShop():shop);
 $('#pp-batch').onclick=()=>api.batchProfit?.(drawnIds.filter(id=>chosen.has(id)),product,shop);
 $('#pp-erp-match').onclick=()=>api.openErpMatching?.();
 exportButton.onclick=()=>openPriceTemplateExport().catch(error=>announce(api.errorText?.(error)||error.message));
 const replay=async operation=>{
  try{
   await mutate(operation);
   fullDrawRequested=true;
   flushRowRefresh();
  }catch(error){announce(api.errorText?.(error)||error.message);}
 };
 $('#pp-undo').onclick=()=>replay(api.undo);
 $('#pp-redo').onclick=()=>replay(api.redo);
 document.addEventListener('keydown',event=>{
  if(!visible()||event.defaultPrevented||event.isComposing||event.altKey||!(event.ctrlKey||event.metaKey)||document.querySelector('dialog[open]'))return;
  const key=event.key.toLowerCase();if(!['z','y'].includes(key))return;
  const target=event.target;if(target.isContentEditable||target.closest('input,textarea,select')&&!target.matches('[data-pp-cell]')||isEdited(target))return;
  event.preventDefault();if(!event.repeat)void replay(key==='y'||event.shiftKey?api.redo:api.undo);
 });
 function cellPosition(target){
  const cell=target?.closest('[data-pp-col]'),row=cell?.closest('[data-pp-row]');
  return row?{id:row.dataset.ppRow,col:Number(cell.dataset.ppCol)}:null;
 }
 function cellAt({id,col}){return renderedRows.get(id)?.cells[col];}
 function rangeBounds(){
  if(!range)return null;
  const from=drawnIds.indexOf(range.start.id),to=drawnIds.indexOf(range.end.id),high=moreColumns?columns.length-1:defaultVisibleColumns-1;
  if(from<0||to<0||range.start.col>high||range.end.col>high)return null;
  return [Math.min(from,to),Math.max(from,to),Math.min(range.start.col,range.end.col),Math.max(range.start.col,range.end.col)];
 }
 function copyValue(cell){
  const input=cell?.querySelector('input:not([type="checkbox"])');
  // 到手价显示为整数，复制仍使用可重新粘贴的原始精度。
  if(input?.dataset.ppPrecise!==undefined)return input.dataset.ppPrecise;
  const value=(input?.value??cell?.textContent??'').trim().replace(/[\t\r\n]+/g,' ');
  return value==='—'?'':cell?.classList.contains('pp-number')?value.replace(/,/g,''):value;
 }
 function paintRange(){
  const bounds=rangeBounds();
  const current=bounds&&cellAt(range.end);
  const nextRows=new Map(),nextCells=new Set(),high=moreColumns?columns.length-1:defaultVisibleColumns-1;
  const visibleMask=(1<<(high+1))-1;
  // 每行用一组列位保存选区，按配置 ID 跟踪行，隐藏的列和行不会被复制。
  for(const [id,mask] of baseRows)if(renderedRows.has(id)&&(mask&visibleMask))nextRows.set(id,mask&visibleMask);
  if(bounds){
   const [top,bottom,left,right]=bounds;
   const areaMask=((1<<(right-left+1))-1)<<left;
   for(let i=top;i<=bottom;i++){
    const id=drawnIds[i],previous=nextRows.get(id)??0;
    const mask=removeRange?previous&~areaMask:previous|areaMask;
    if(mask)nextRows.set(id,mask);
    else nextRows.delete(id);
   }
  }
  selectedRows=nextRows;
  copyAligned=true;
  const firstMask=selectedRows.values().next().value;
  // 拖动时只更新进入或离开选区的格子，避免每次重画整个表格。
  for(const [id,mask] of selectedRows){
   if(mask!==firstMask)copyAligned=false;
   for(let col=0;col<=high;col++)if(mask&(1<<col)){
    const cell=cellAt({id,col});
    nextCells.add(cell);
    if(!paintedCells.has(cell))cell.setAttribute('data-pp-range','');
   }
  }
  for(const cell of paintedCells)if(!nextCells.has(cell))cell.removeAttribute('data-pp-range');
  paintedCells=nextCells;
  const outlined=nextCells.has(current)?current:null;
  if(outlined!==paintedCurrent){
   paintedCurrent?.removeAttribute('data-pp-current');
   outlined?.setAttribute('data-pp-current','');
   paintedCurrent=outlined;
  }
  $('#pp-copy-range').disabled=!selectedRows.size;
  $('#pp-formula-detail').disabled=!current;
  $('#pp-address').textContent=current?(range.end.col?String.fromCharCode(64+range.end.col):'序')+(drawnIds.indexOf(range.end.id)+1):'—';
  const column=range?.end.col;
  const formula=column===4?'售价 = 到手价 + 店铺券':column===11&&range?taxTools.formula(range.end.id)||null:column===7?'到手价 − (含税成本 × (1 + 运营费率%) + 100) − 分期费':column===8?'到手价 × 98% − ERP 总成本':null;
  const field=current?.querySelector('[data-pp-cell]');
  const formulaEditor=$('#pp-formula-value');
  if(document.activeElement!==formulaEditor){
   formulaEditor.readOnly=field?.dataset.ppCell!=='price';
   formulaEditor.value=current?(formula||copyValue(current)||'—'):'';
  }
  const row=range&&rowCache.get(range.end.id);
  $('#pp-formula-hint').textContent=current?columns[column][0]+(field?' · 可编辑':' · 只读')+(row?.quote.coupon>0?' · 售价 '+money(row.quote.listPrice)+'（店铺券 '+money(row.quote.coupon)+'）':''):'';
  table.querySelectorAll('[data-pp-letter]').forEach(letter=>letter.toggleAttribute('data-current',Boolean(current)&&Number(letter.dataset.ppLetter)===column));
 }
 function clearRange(){range=null;baseRows=new Map();removeRange=false;}
 function markRange(pos,extend=false,toggle=false){
  if(!pos)return;
  if(extend&&rangeBounds())range.end=pos;
  else{
   // Ctrl 按下时记录已有选区，拖动只改变本次范围，经过的格子不会被反复切换。
   baseRows=toggle?selectedRows:new Map();
   removeRange=toggle&&Boolean((baseRows.get(pos.id)??0)&(1<<pos.col));
   range={start:pos,end:pos};
  }
  paintRange();
 }
 const copyAlignmentMessage='所选单元格的行列未对齐，请分开复制。';
 function rangeText(){
  if(!copyAligned)throw Error(copyAlignmentMessage);
  const mask=selectedRows.values().next().value,cols=[];
  for(let col=0;col<columns.length;col++)if(mask&(1<<col))cols.push(col);
  // 跳过整列或整行的间隔，再按表格显示顺序输出，避免贴入错误的行列。
  return drawnIds.filter(id=>selectedRows.has(id)).map(id=>cols.map(col=>copyValue(cellAt({id,col}))).join('\t')).join('\r\n');
 }
 grid.addEventListener('copy',event=>{
  if(!selectedRows.size||!event.clipboardData)return;
  const target=event.target;
  // 输入框有文本选区时沿用原生复制，光标未选中文字时复制当前格。
  if(target!==grid&&(!target.matches('[data-pp-cell]')||target.selectionStart!==target.selectionEnd))return;
  event.preventDefault();
  if(!copyAligned){announce(copyAlignmentMessage);return;}
  event.clipboardData.setData('text/plain',rangeText());
  announce('已复制选区');
 });
 grid.addEventListener('keydown',event=>{
  const target=event.target,onGrid=target===grid;
  // 刚聚焦输入框时整格文字被选中，Shift+方向键仍可扩选单元格。
  // 修改过内容或手动选中文字时，由输入框处理键盘操作。
  if(!onGrid&&!(event.shiftKey&&target.matches('[data-pp-cell]')&&!isEdited(target)&&
   target.selectionStart===0&&target.selectionEnd===target.value.length))return;
  if(onGrid&&event.key==='Escape'){clearRange();paintRange();return;}
  // 阻止浏览器发起空的复制事件，保留剪贴板里已有的内容。
  if(event.ctrlKey&&event.key.toLowerCase()==='c'&&!copyAligned){event.preventDefault();announce(copyAlignmentMessage);return;}
  if(!rangeBounds())return;
  const moves={ArrowLeft:[0,-1],ArrowRight:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0]};
  const move=moves[event.key];if(!move)return;
  event.preventDefault();
  const index=Math.max(0,Math.min(drawnIds.length-1,drawnIds.indexOf(range.end.id)+move[0]));
  const pos={id:drawnIds[index],col:Math.max(0,Math.min(moreColumns?columns.length-1:defaultVisibleColumns-1,range.end.col+move[1]))};
  if(!onGrid){event.stopPropagation();focusRange();}
  markRange(pos,event.shiftKey);cellAt(pos)?.scrollIntoView({block:'nearest',inline:'nearest'});
 },true);
 $('#pp-copy-range').onclick=async()=>{
  if(!selectedRows.size)return;
  try{await copyPlainText(rangeText());announce('已复制选区');}
  catch(error){focusRange();announce(api.errorText?.(error)||error.message);}
 };
 $('#pp-formula-detail').onclick=()=>{if(rangeBounds())openDetail(range.end.id);};
 const formulaEditor=$('#pp-formula-value');
 let formulaRowId=null;
 formulaEditor.onfocus=()=>{
  if(formulaEditor.readOnly||!rangeBounds())return;
  formulaRowId=range.end.id;
  const price=inputFor(formulaRowId,'price');
  formulaEditor.value=price.dataset.ppPrecise;
  formulaEditor.select();
 };
 formulaEditor.onblur=()=>{
  const price=inputFor(formulaRowId,'price');formulaRowId=null;
  if(!price||pendingInputs.has(price)){paintRange();return;}
  price.defaultValue=price.dataset.ppPrecise;
  price.value=formulaEditor.value;
  const result=commitInput(price);
  if(typeof result==='boolean'){formatAmount(price);paintRange();}
 };
 formulaEditor.onkeydown=event=>{
  if(!formulaRowId||!['Enter','Escape'].includes(event.key))return;
  event.preventDefault();
  if(event.key==='Escape')formulaEditor.value=inputFor(formulaRowId,'price')?.dataset.ppPrecise??'';
  formulaEditor.blur();
 };

 async function flush(){
  const field=document.activeElement;
  if(field===formulaEditor)formulaEditor.blur();
  else if(root.contains(field)&&isEdited(field)&&!pendingInputs.has(field))commitInput(field);
  // 鼠标点击工具栏时可能先触发失焦，须检查该次提交的结果再读取全店数据。
  const results=await Promise.all([...pendingInputResults]);
  while(pendingWrites)await writeTail;
  if(inputRejected||results.includes(false)){
   const error=inputRejected??Error('请先修正当前输入');
   inputRejected=null;
   throw error;
  }
 }
 function hasUnsavedPrices(configs,targetShop){
  if(savedState?.count>0)return true;
  if(!api.accepted)return false;
  const inShop=c=>(c.shopId||'intel')===targetShop&&!c.deletedAt&&!c.emptyLinkDraft;
  const current=configs.filter(inShop),accepted=new Map(api.accepted().filter(inShop).map(c=>[c.id,c]));
  return current.length!==accepted.size||current.some(c=>{
   const before=accepted.get(c.id);
   return !before||['spu','skuId','price','productDraft'].some(key=>c[key]!==before[key]);
  });
 }
 async function openPriceTemplateExport(){
  const targetShop=shop;
  if(targetShop==='all'){announce('请先选择具体店铺再导出全店价格模板');return;}
  await flush();
  if(shop!==targetShop||!visible())return;
  // 直接从全店数据源读取，筛选、排序和折叠只影响页面显示。
  const configs=api.rows(),settings=api.settings(targetShop),name=shopName(targetShop);
  const plan=planPriceTemplateExport(configs,{shopId:targetShop,settings,links:api.links?.()??configs});
  const coupon=(moneyCents(settings.coupon??0)??0)/100;
  const skippedByReason=new Map();
  for(const {reason} of plan.skipped)skippedByReason.set(reason,(skippedByReason.get(reason)||0)+1);
  const skippedDetails=plan.skipped.length?`<ul class="pp-price-template-reasons">${Array.from(skippedByReason,([reason,count])=>`<li>${esc(reason)} · ${count} 条</li>`).join('')}</ul>
   <details><summary>查看跳过明细</summary><ul class="pp-price-template-skipped">${plan.skipped.map(({product,name,reason})=>`<li>${esc(product||'未命名链接')} / ${esc(name||'未命名配置')} / ${esc(reason)}</li>`).join('')}</ul></details>`:'';
  api.openDialog('导出全店价格模板',`<section class="pp-price-template-summary">
   <p><strong>${esc(name)}</strong> · 可导出 ${plan.rows.length} 个 SKU（${plan.spuCount} 个商品 SPU） · 跳过 ${plan.skipped.length} 条</p>
   <p>${coupon>0?'售价 = 到手价 + 店铺券 '+money(coupon):'售价 = 到手价'}</p>
   <p class="hint">全店范围导出，不受当前筛选影响。同商品 ID 已自动聚拢连续，模板保留空白列。</p>
   ${hasUnsavedPrices(configs,targetShop)?'<p><strong>当前包含未保存修改，将按表格当前最新售价导出</strong></p>':''}
   ${skippedDetails}</section>
   <div class="actions"><button id="pp-price-template-close">关闭</button><button id="pp-price-template-download" class="primary"${plan.rows.length?'':' disabled'}>导出 Excel 模板 (.xlsx)</button></div>`);
  dialog().querySelector('#pp-price-template-close').onclick=()=>api.closeDialog();
  const exportButton=dialog().querySelector('#pp-price-template-download');
  exportButton.onclick=async()=>{
   exportButton.disabled=true;
   try{
    const folderName=`${name}_全店价格模板_${new Date().toLocaleDateString('sv-SE')}`;
    const fileName=folderName+'.xlsx',workbook=priceTemplateWorkbook(plan.rows);
    // 桌面端沿用图片目录选择，收到实际写入回执后才提示导出成功。
    const result=await saveExportFolder([{name:fileName,bytes:new Uint8Array(await workbook.arrayBuffer())}],folderName);
    if(result?.cancelled){announce('已取消价格模板导出');return;}
    if(result){
     if(!result.ok||!result.files?.includes(fileName))throw Error(result.error||'价格模板未保存，请重试');
    }else await api.download(workbook,fileName);
    if(exportButton.isConnected)api.closeDialog();
    const summary=`${plan.rows.length} 条价格，跳过 ${plan.skipped.length} 条`;
    announce(result?`已导出 ${summary}。保存到：${result.directory}`:`已开始下载 ${summary}，请查看浏览器下载记录`);
   }catch(error){announce(api.errorText?.(error)||error.message);}
   finally{exportButton.disabled=false;}
  };
 }

 const saveButton=$('#pp-save');
 const saveCount=$('#pp-save-count');
 function saveStatus(next=savedState){
  savedState=next;
  saveButton.disabled=saving||Boolean(next?.disabled);
  if(!next)return;
  saveButton.textContent=next.label+(api.nas?' ('+(next.count||0)+')':'');
  saveCount.hidden=false;
  saveCount.textContent=next.count?`${next.count} 套待保存`:'无待保存';
 }
 saveButton.onclick=async()=>{
  if(saveButton.disabled)return;
  saving=true;saveStatus();
  try{await mutate(api.save);refresh({force:true});}
  catch(error){announce(api.errorText?.(error)||error.message);}
  finally{saving=false;saveStatus();}
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
  };$('#pp-status-filter').after(discard);
 }

 function openDetail(id){
  const row=currentPriceRow(id);if(!row)return;
  const {config:c,quote:p,metrics:t}=row;
  api.openDialog('利润明细','<p class="hint">'+esc(shopName(c.shopId)+' · '+c.product+' · '+c.name)+'</p><dl class="pp-details"><dt>到手价 / 售价</dt><dd>'+money(p.arrival)+' / '+money(p.listPrice)+'</dd><dt>ERP 成本 / 扣点 / 固定费用</dt><dd>'+money(t.erp)+' / '+money(t.erpDeduction)+' / '+money(0)+'</dd><dt>含税成本 / 成本运营费 / 固定费用</dt><dd>'+money(t.tax)+' / '+money(t.taxDeduction)+' / '+money(100)+'</dd><dt>分期费'+(p.term?'（'+p.term+' 期 · '+p.percent+'%）':'')+'</dt><dd>'+money(p.fee)+'</dd><dt>ERP 利润 / 利润率</dt><dd>'+money(t.erpProfitAfter)+' / '+percent(t.erpMargin)+'</dd><dt>核算利润 / 利润率</dt><dd>'+money(t.taxProfitAfter)+' / '+percent(t.taxMargin)+'</dd></dl><p class="hint">核算利润 = 到手价 −（含税成本 + 含税成本 × 运营费率% + 100）− 分期费；ERP 利润 = 到手价 × 98% − ERP 成本。利润率按到手价计算。'+(t.erpFallback?'有 '+t.erpFallback+' 项 ERP 成本暂用核算成本代入。':'')+'</p><div class="actions"><button id="pp-details-rule">链接设置</button><button id="pp-details-config">前往配置</button></div>');
  dialog().querySelector('#pp-details-rule').onclick=()=>api.editLink(c);
  dialog().querySelector('#pp-details-config').onclick=()=>{api.closeDialog();void hide(c);};
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
   }catch(failure){if(button.isConnected)error.textContent=api.errorText?.(failure)||failure.message;}
   finally{button.disabled=false;}
  };
 }
 function show(){
  // 大店保留完整筛选范围，首次只在当前链接下创建配置行。
  if(!visible()){
   shop=api.activeShop();product='';sort=null;grouped=true;activeLink='';chosen.clear();clearRange();collapsed.clear();expanded.clear();
   $('#pp-grouped').setAttribute('aria-pressed','true');$('#pp-flat').setAttribute('aria-pressed','false');
   const config=api.currentConfig?.();
   if(api.rows().filter(c=>c.shopId===shop).length>=largeShopSize){
    collapsed=new Set(groupedConfigs().keys());
    if(config)collapsed.delete(linkKey(config));
   }
   if(config&&!config.emptyLinkDraft){range={start:{id:config.id,col:5},end:{id:config.id,col:5}};}
  }
  root.hidden=false;workspace.classList.add('price-profit-active');
  refresh({force:true});grid.focus({preventScroll:true});
 }
 let leaving=false;
 async function hide(target){
  if(!visible()||leaving)return;
  leaving=true;
  try{
   const field=document.activeElement;
   if(root.contains(field)&&isEdited(field)&&!pendingInputs.has(field)&&!await commitInput(field)){inputRejected=null;return;}
   // 先提交当前输入并等待已入队的失焦写入，再交还焦点或定位配置。
   const inputResults=await Promise.all([...pendingInputResults]);
   while(pendingWrites)await writeTail;
   if(inputRejected||inputResults.includes(false)){inputRejected=null;return;}
   if(partPanel.matches(':popover-open'))partPanel.hidePopover();
   for(const id of cards.keys())releaseCard(id);
   root.hidden=true;workspace.classList.remove('price-profit-active');pointerDown=false;rangePointer=null;
   await api.onClose();
   if(target)await api.locate(target);
  }catch(error){announce(api.errorText?.(error)||error.message);}
  finally{leaving=false;}
 }
 return {show,hide,visible,refresh,historyButtons,saveStatus,selectedIds:()=>[...chosen],flush,clearCaches:()=>{for(const id of cards.keys())releaseCard(id);rowCache.clear();stockIndex.clear();}};
}
