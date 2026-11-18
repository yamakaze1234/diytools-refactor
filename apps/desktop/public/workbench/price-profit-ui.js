import {profitTone} from './profit-tone.js';
import {copyPlainText} from './clipboard.js';
import {DEFAULT_PROFIT_ALERT,DEFAULT_PRICING_RULE,normalizeProfitAlert,normalizeProfitAlerts,validatePricingRule,productInstallment} from './pricing.js';
import {flagsFor,linkKey,MAX_ARRIVAL,parseArrival,parseIdPaste,planIdEdit,planPriceBatch,priceProfitRow} from './price-profit-model.js';
import {actualParts} from './actual-parts.js';
import {componentStockView} from './component-stock-view.js';
import {isSpecialComponent} from './special-components.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amountFormat=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const money=value=>value==null?'—':(value<0?'−¥':'¥')+amountFormat.format(Math.abs(value));
const percent=value=>value==null?'—':amountFormat.format(value)+'%';
const yuan=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const whole=value=>value==null?'—':yuan.format(value);
const ruleFields={erpRate:'ERP 扣点',taxRate:'核算扣点',erpFixed:'ERP 固定费用',taxFixed:'核算固定费用',fee6:'6 期息点',fee12:'12 期息点',fee24:'24 期息点'};
const fieldNames={spu:'SPU',sku:'SKU',shortName:'简称',price:'到手价'};
const fields=Object.keys(fieldNames);
const filters=[['all','全部配置'],['loss','亏损预警'],['missing','资料缺失'],['fallback','ERP 成本代入']];
const statusChoices=[['erp-loss','ERP 利润亏损预警'],['tax-loss','核算利润亏损预警'],['missing','资料缺失'],['fallback','ERP 成本代入'],['normal','正常']];
// 与确认稿共用列序和列宽，配置简称及序号作为冻结列。
const columns=[
 ['序',38],['SPU',125],['SKU',125],['简称',236],['售价',76],['到手价',79,'arrival'],
 ['核算利润',80,'taxProfitAfter'],['ERP 利润',80,'erpProfitAfter'],['核算利润率',83,'taxMargin'],
 ['可销',47],['核算成本',78],['ERP 成本',78],['状态',86],['机箱 / 颜色',104],['尾数99',82],
 ['ERP 利润率',87,'erpMargin'],['核算扣点',79],['ERP 扣点',79],['分期费',79],
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
 let shop=api.activeShop(),product='',filter='all',sort=null,grouped=true,activeLink='';
 let statusFilter=new Set();
 const partFilters=new Map();
 let partMatch='any';
 let chosen=new Set(),collapsed=new Set(),rendering=false,pointerDown=false,deferredDraw=false,renderTimer=0,drawnIds=[];
 const expanded=new Set();
 let moreColumns=false,range=null,rangePointer=null;
 let baseRows=new Map(),selectedRows=new Map(),removeRange=false,copyAligned=true;
 let renderedRows=new Map(),paintedCells=new Set(),paintedCurrent=null;
 const focusClass=index=>index===0?' pp-frozen-number':index===3?' pp-frozen-config':'';
 const colClass=index=>(index>=15?' pp-extra':'')+focusClass(index);
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

 root.innerHTML=`
 <header class="pp-header">
  <div><h1 id="price-profit-title">价格与利润</h1><p>简称可直接编辑 · 左侧箭头展开配件 · 点击商品链接行后可跳转编辑</p></div>
  <div class="pp-actions"><button id="pp-undo" disabled>撤销</button><button id="pp-redo" disabled>重做</button>
   <details class="pp-menu"><summary>更多</summary><div><button id="pp-back">返回配置</button><button id="pp-save">保存到本机</button><button id="pp-shop-settings">店铺设置</button><button id="pp-new-link">新建链接</button><button id="pp-status-filter" aria-label="筛选状态">全部状态 ▾</button><button id="pp-batch" disabled>批量调价</button></div></details>
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
    <button id="pp-more" aria-pressed="false">显示更多列</button><button id="pp-close-expanded">收起配置</button><button id="pp-copy-range" disabled>复制选区</button>
   </div>
  </div>
  <div class="pp-summary"><div id="pp-summary" role="group" aria-label="价格利润筛选"></div><div class="pp-tools"><button id="pp-alert">预警规则</button></div></div>
  <div class="pp-formula"><strong id="pp-address">—</strong><span aria-hidden="true">fx</span><input id="pp-formula-value" aria-label="当前值或公式" readonly><small id="pp-formula-hint"></small><button id="pp-formula-detail" disabled>查看公式</button></div>
  <div class="pp-grid" tabindex="0" aria-label="价格与利润表格区域">
   <table class="pp-table">
    <colgroup>${columns.map(([,width],i)=>'<col class="'+colClass(i)+'" style="width:'+width+'px">').join('')}</colgroup>
    <thead>
     <tr class="pp-letters" aria-hidden="true">${columns.map((_,i)=>'<th class="'+colClass(i)+'" data-pp-letter="'+i+'">'+(i===0?'◢':String.fromCharCode(64+i))+'</th>').join('')}</tr>
     <tr class="pp-fields">${columns.map(([label,,key],i)=>'<th scope="col" data-pp-head="'+i+'" class="'+colClass(i)+'">'+(i===0?'序<input type="checkbox" id="pp-select-all" aria-label="全选可见配置">':key?'<button data-pp-sort="'+key+'">'+label+'<span aria-hidden="true"></span></button>':label)+'</th>').join('')}</tr>
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
 const selectAll=$('#pp-select-all');
 const announce=message=>{$('#pp-status').textContent=message;api.toast(message);};
 const inputFor=(id,key)=>id==null?null:body.querySelector('[data-pp-cell="'+key+'"][data-row-id="'+CSS.escape(id)+'"]');
 const focusCell=(id,key)=>{const el=inputFor(id,key);if(el){el.focus({preventScroll:true});el.select();el.scrollIntoView({block:'nearest',inline:'nearest'});}return !!el;};
 const isEdited=el=>el?.matches('[data-pp-cell]')&&el.value!==el.defaultValue;
 const partIdentity=part=>JSON.stringify([part.slot,part.goodsId||part.name]);
 const table=$('.pp-table'),partPanel=$('#pp-part-panel');
 new ResizeObserver(([entry])=>table.style.setProperty('--pp-frozen-width',entry.borderBoxSize[0].inlineSize+'px')).observe(table.tHead.rows[0].cells[0]);
 let filterChoices=[];
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
   const linkScope=inShop.filter(r=>(!product||product===linkKey(r.config))&&match(r,needle));
   // 筛选候选来自当前范围的实际型号，按配置去重计数。
   const partsByKey=new Map();
   for(const row of linkScope){
    const seen=new Set();
    for(const part of actualParts(row.config)){
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
   const scope=linkScope.filter(r=>matchesParts(r.config));
   const flagged=scope.map(r=>({...r,flags:flagsFor(r)}));
   const counts=Object.fromEntries(filters.map(([key])=>[key,key==='all'?scope.length:flagged.filter(r=>r.flags[key]).length]));
   $('#pp-summary').innerHTML=filters.map(([key,label])=>'<button type="button" data-pp-filter="'+key+'" aria-pressed="'+String(filter===key)+'"><span>'+label+'</span><strong>'+counts[key]+'</strong></button>').join('');
   if(activeSummary)$('#pp-summary').querySelector('[data-pp-filter="'+activeSummary+'"]')?.focus({preventScroll:true});
   const filtered=flagged.filter(r=>(filter==='all'||r.flags[filter])&&(!statusFilter.size||statusKeys(r.flags).some(key=>statusFilter.has(key))));
   $('#pp-status-filter').textContent=(statusFilter.size?'已选 '+statusFilter.size+' 项':'全部状态')+' ▾';
   // 结果数量包含折叠组中的匹配配置；底部可见数量仍表示可操作行。
   $('#pp-result-count').textContent='筛选结果：'+filtered.length+' 套配置';
   if(sort){
    const value=r=>sort.key==='arrival'?r.quote.arrival:r.metrics[sort.key];
    filtered.sort((a,b)=>{const x=value(a),y=value(b);return x==null?+(y!=null):y==null?-1:(x-y)*sort.direction;});
   }
   table.querySelectorAll('[data-pp-sort]').forEach(button=>{
    const active=sort?.key===button.dataset.ppSort;
    button.querySelector('span').textContent=active?(sort.direction===1?'↑':'↓'):'↕';
    button.closest('th').setAttribute('aria-sort',active?(sort.direction===1?'ascending':'descending'):'none');
   });
   const displayLinks=new Map();
   for(const row of filtered){const key=linkKey(row.config);if(!displayLinks.has(key))displayLinks.set(key,[]);displayLinks.get(key).push(row);}
   if(grouped&&filter==='all'&&!needle&&!statusFilter.size&&!partFilters.size)for(const [key] of links)if((!product||key===product)&&!displayLinks.has(key)&&linkChoices.some(c=>linkKey(c)===key&&c.emptyLinkDraft))displayLinks.set(key,[]);
   // 可销按实际配件及用量折算；缺少库存时显示未知。
   const stocksById=new Map();
   for(const part of api.costs?.()??[]){if(!stocksById.has(part.goodsId))stocksById.set(part.goodsId,[]);stocksById.get(part.goodsId).push(part);}
   let sequence=0;
   const span=moreColumns?columns.length:15;
   table.style.setProperty('--pp-width',columns.slice(0,span).reduce((sum,col)=>sum+col[1],0)+'px');
   const rowHTML=row=>{
    const {config:c,quote:p,metrics:t,flags:f}=row;
    const status=[...f.hits.loss.map(key=>['destructive',(key==='erp'?'ERP':'核算')+'亏损预警']),f.missing?['muted','资料缺失']:null,f.fallback?['warning','ERP 成本代入']:null].filter(Boolean);
    if(!status.length)status.push(['success','正常']);
    const id=esc(c.id),picked=chosen.has(c.id),open=expanded.has(c.id);
    const editor=(key,value)=>'<input class="pp-cell '+(key==='price'?'pp-price-cell':key==='shortName'?'pp-name-cell':'pp-id-cell')+'" aria-label="'+esc(c.name)+' '+fieldNames[key]+'" data-row-id="'+id+'" data-pp-cell="'+key+'" inputmode="'+(key==='price'?'decimal':key==='shortName'?'text':'numeric')+'" autocomplete="off" spellcheck="false"'+(key==='price'?' data-pp-precise="'+esc(value)+'"':'')+' value="'+esc(key==='price'&&value!=null?whole(value):value)+'">';
    const cell=(col,text,classes='',profit)=>'<td data-pp-col="'+col+'" class="'+classes+colClass(col)+'"'+(profit!==undefined?' data-profit-tone="'+profitTone(profit)+'"':'')+'>'+text+'</td>';
    const numeric=(col,value,tone=false)=>cell(col,whole(value),'pp-number',tone?value:undefined);
    const parts=actualParts(c).filter(part=>part.name||part.goodsId).map(part=>({part,stock:componentStockView(part,stocksById)}));
    const available=parts.filter(({part})=>!isSpecialComponent(part)).map(({part,stock})=>stock.value==null||!Number.isInteger(Number(part.qty))||part.qty<1?null:Math.floor(stock.value/part.qty));
    const stock=!available.length||available.some(v=>v==null)?(available.includes(0)?0:null):Math.min(...available);
    const basePrice=planPriceBatch([row],{basis:'tax',mode:'target',input:0})[0].price;
    const next99=basePrice==null?null:Math.ceil((basePrice-99)/100)*100+99;
    const chassis=parts.find(({part})=>part.slot==='机箱')?.part;
    const badge=status.map(([kind,label])=>'<span class="pp-badge" data-variant="'+kind+'">'+esc(label)+'</span>').join('');
    const main='<tr data-pp-row="'+id+'"'+(picked?' data-selected':'')+(open?' data-expanded':'')+'>'+
      cell(0,'<label class="pp-seq"><input type="checkbox" data-pp-pick="'+id+'" aria-label="勾选 '+esc(c.name)+'"'+(picked?' checked':'')+'><span>'+ ++sequence+'</span></label>')+
      cell(1,editor('spu',c.spu))+cell(2,editor('sku',c.skuId))+
      cell(3,'<div class="pp-config-cell"><button type="button" class="pp-config-link" aria-label="'+(open?'收起':'展开')+esc(c.name)+'实际配件" data-pp-expand="'+id+'" aria-expanded="'+open+'"><i class="pp-chevron" aria-hidden="true"></i></button>'+editor('shortName',c.shortName||c.name)+'</div>')+
      numeric(4,p.listPrice)+cell(5,editor('price',p.arrival))+
      numeric(6,t.taxProfitAfter,true)+numeric(7,t.erpProfitAfter,true)+cell(8,percent(t.taxMargin),'pp-number',t.taxProfitAfter)+cell(9,whole(stock),'pp-number'+(stock===0?' pp-out':'') )+numeric(10,t.tax)+numeric(11,t.erp)+
      cell(12,badge,'pp-status-cell')+cell(13,esc(chassis?.name||'—'),'pp-chassis')+numeric(14,next99<=MAX_ARRIVAL?next99:null)+
      cell(15,percent(t.erpMargin),'pp-number',t.erpProfitAfter)+numeric(16,t.taxDeduction)+numeric(17,t.erpDeduction)+numeric(18,p.fee)+'</tr>';
    if(!open)return main;
    const uniqueSlot=slot=>parts.filter(({part})=>part.slot===slot).length===1;
    const details=parts.map(({part,stock})=>{
     const slot=esc(part.slot),editable=Boolean(api.applyActual)&&uniqueSlot(part.slot)&&!isSpecialComponent(part);
     const name=editable?'<button type="button" class="pp-part-picker" data-pp-pick-part="'+slot+'" data-pp-config="'+id+'"><span>'+esc(part.name)+'</span><i class="pp-chevron" aria-hidden="true"></i></button>':esc(part.name);
     const qty=editable?'<input type="number" min="1" max="1000" step="1" data-pp-qty="'+slot+'" data-pp-config="'+id+'" aria-label="'+slot+'实际数量" value="'+esc(part.qty)+'">':esc(part.qty);
     return '<tr><th scope="row">'+slot+'</th><td>'+name+'</td><td>'+qty+'</td><td>'+esc(stock.status==='special'?'—':stock.value??'未知')+'</td><td>'+whole(part.erp)+'</td><td>'+whole(part.tax)+'</td></tr>';
    }).join('');
    return main+'<tr class="pp-expanded"><td colspan="'+span+'"><section class="pp-detail"><div class="pp-expanded-head"><strong>实际配件</strong><span>'+esc(c.shortName||c.name)+' · '+parts.length+' 项配件</span><button data-pp-expand="'+id+'">收起 ↑</button></div><div class="pp-detail-grid"><table aria-label="展开的实际配件"><colgroup><col style="width:82px"><col><col style="width:62px"><col style="width:92px"><col span="2" style="width:105px"></colgroup><thead><tr><th>槽位</th><th>实际配件 / 型号</th><th>数量</th><th>ERP 可销</th><th>ERP 单价</th><th>含税单价</th></tr></thead><tbody>'+details+'</tbody></table></div></section></td></tr>';
   };
   const shown=[];
   if(grouped){
    body.innerHTML=Array.from(displayLinks,([key,group])=>{
     const c=links.get(key),hidden=collapsed.has(key),k=esc(key);
     if(!hidden)shown.push(...group);
     const term=productInstallment(groups.get(key)),hint=(c.pricingRule?'独立核算':'跟随店铺')+' · '+(term===null?'分期设置不一致':term?term+' 期免息':'不分期');
     const current=activeLink===key;
     return '<tr class="pp-link-group"'+(current?' data-current-link':'')+'><td class="pp-frozen-number"></td><td colspan="3"><div class="pp-group-id"><button type="button" data-pp-collapse="'+k+'" aria-expanded="'+String(!hidden)+'" aria-label="'+(hidden?'展开':'收起')+esc(c.product||'未命名链接')+'"><i class="pp-chevron" aria-hidden="true"></i></button><button type="button" data-pp-select-link="'+k+'" aria-pressed="'+current+'"><strong>'+esc(c.product||'未命名链接')+'</strong><small>'+group.length+' 套</small></button>'+(current?'<button type="button" data-pp-jump-link="'+k+'">编辑配置</button>':'')+'</div></td><td colspan="'+(span-4)+'"><div class="pp-group-meta"><span>SPU '+esc(c.spu||'—')+'</span>'+(current?'<button type="button" data-pp-edit-link="'+k+'" title="'+esc(hint)+'">链接设置</button>':'')+'</div></td></tr>'+
       (hidden?'':group.length?group.map(rowHTML).join(''):'<tr><td colspan="'+span+'" class="pp-empty">此链接尚无配置价格，可在配置页继续编辑。</td></tr>');
    }).join('');
   }else{shown.push(...filtered);body.innerHTML=filtered.map(rowHTML).join('');}
   if(!body.children.length)body.innerHTML='<tr><td colspan="'+span+'" class="pp-empty">没有符合条件的配置</td></tr>';
   drawnIds=shown.map(r=>r.config.id);
   renderedRows=new Map(Array.from(body.rows).filter(row=>row.hasAttribute('data-pp-row')).map(row=>[row.dataset.ppRow,row]));
   chosen=new Set(drawnIds.filter(id=>chosen.has(id)));
   syncSelection();historyButtons();paintRange();
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
   }else if(key==='shortName'){
    const value=el.value.trim();
    if(!value||value.length>160)throw Error('简称须为 1–160 个字');
    plan=value===(current.config.shortName||current.config.name)?[]:[{id,fields:{shortName:value,shortNameAuto:false}}];
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
 body.addEventListener('focusin',event=>{const field=event.target;if(field.matches('[data-pp-cell]')){
  if(field.dataset.ppCell==='price')field.value=field.defaultValue=field.dataset.ppPrecise;
  field.select();if(!pointerDown)markRange(cellPosition(field));
 }});
 body.addEventListener('focusout',event=>{
  const field=event.target;
  if(!rendering&&field.isConnected&&isEdited(field)){commitInput(field);scheduleRefresh();}
  else if(field.dataset.ppCell==='price'&&field.value!=='')field.value=field.defaultValue=whole(Number(field.dataset.ppPrecise));
 });
 function focusRange(){
  grid.focus({preventScroll:true});
  document.getSelection()?.removeAllRanges();
 }
 body.addEventListener('pointerdown',event=>{
  if(event.button!==0||!event.isPrimary)return;
  pointerDown=true;
  const pos=cellPosition(event.target);
  if(!pos||event.target.closest('button,.pp-seq'))return;
  rangePointer=event.pointerId;
  markRange(pos,event.shiftKey,event.ctrlKey);
  // 扩选、多选和只读单元格由表格接收复制键，普通点击输入框仍可编辑和复制文字。
  if(event.shiftKey||event.ctrlKey||!event.target.matches('[data-pp-cell]')){
   event.preventDefault();
   focusRange();
  }
 });
 body.addEventListener('pointermove',event=>{
  if(rangePointer!==event.pointerId||!(event.buttons&1)||!range)return;
  const pos=cellPosition(event.target);if(!pos||(pos.id===range.end.id&&pos.col===range.end.col))return;
  event.preventDefault();
  markRange(pos,true);focusRange();
 });
 body.addEventListener('dragstart',event=>{if(rangePointer!==null)event.preventDefault();});
 const endPointer=()=>{pointerDown=false;rangePointer=null;if(visible()&&deferredDraw)scheduleRefresh();};
 // 保留正在点击的单元格，直到 click 完成才允许重建可见行。
 document.addEventListener('pointerup',()=>{if(pointerDown)endPointer();});
 document.addEventListener('pointercancel',()=>{if(pointerDown)endPointer();});
 body.addEventListener('paste',event=>{
  const input=event.target,key=input.dataset.ppCell;
  if(key==='price'&&pasteArrivals(event,input.dataset.rowId))return;
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
 const reroute=()=>{chosen.clear();clearRange();refresh({force:true});};
 // 状态多选采用“任一匹配”，并与店铺、链接、搜索及汇总筛选叠加。
 $('#pp-status-filter').onclick=()=>{
  api.openDialog('筛选状态','<p class="hint">可多选，显示包含任一所选状态的配置；不勾选时显示全部状态。</p><div class="pp-status-options">'+statusChoices.map(([key,label])=>`<label><input type="checkbox" data-pp-status-choice="${key}"${statusFilter.has(key)?' checked':''}> ${label}</label>`).join('')+'</div><div class="actions"><button id="pp-status-clear">清除筛选</button><button id="pp-status-apply" class="primary">应用</button></div>');
  const d=dialog();
  d.querySelector('#pp-status-clear').onclick=()=>{statusFilter.clear();api.closeDialog();reroute();};
  d.querySelector('#pp-status-apply').onclick=()=>{statusFilter=new Set(Array.from(d.querySelectorAll('[data-pp-status-choice]:checked'),el=>el.dataset.ppStatusChoice));api.closeDialog();reroute();};
 };
 $('#pp-shop').onchange=e=>{shop=e.target.value;product='';activeLink='';collapsed.clear();partFilters.clear();reroute();};
 $('#pp-product').onchange=e=>{product=e.target.value;collapsed.delete(product);reroute();};
 $('#pp-search').oninput=reroute;
 $('#pp-part-search').oninput=drawPartFilter;
 partPanel.addEventListener('beforetoggle',event=>{
  if(event.newState!=='open')return;
  const bounds=$('#pp-part-filter').getBoundingClientRect();
  partPanel.style.left=Math.max(8,Math.min(bounds.left,innerWidth-450))+'px';
  partPanel.style.top= bounds.bottom+5+'px';
  drawPartFilter();
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
  const key=event.target.closest('[data-pp-sort]')?.dataset.ppSort;
  if(key){sort={key,direction:sort?.key===key?-sort.direction:1};reroute();}
 };
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
   collapsed.has(ppCollapse)?collapsed.delete(ppCollapse):collapsed.add(ppCollapse);refresh({force:true});
   Array.from(body.querySelectorAll('[data-pp-collapse]')).find(el=>el.dataset.ppCollapse===ppCollapse)?.focus();
  }
  if(ppSelectLink){activeLink=ppSelectLink;refresh({force:true});Array.from(body.querySelectorAll('[data-pp-select-link]')).find(el=>el.dataset.ppSelectLink===ppSelectLink)?.focus({preventScroll:true});}
  if(ppJumpLink){const c=api.rows().find(row=>linkKey(row)===ppJumpLink);if(c){hide();api.locate(c);}else{const link=api.links().find(row=>linkKey(row)===ppJumpLink);if(link)api.editLink(link);}}
  if(ppEditLink){const c=api.links().find(c=>linkKey(c)===ppEditLink);if(c)api.editLink(c);}
  if(ppExpand){expanded.has(ppExpand)?expanded.delete(ppExpand):expanded.add(ppExpand);refresh({force:true});body.querySelector('[data-pp-expand="'+CSS.escape(ppExpand)+'"]')?.focus({preventScroll:true});}
  if(ppPickPart)openPartPicker(ppConfig,ppPickPart);
 });
 body.addEventListener('change',async event=>{
  const input=event.target,{ppQty,ppConfig}=input.dataset;if(!ppQty)return;
  try{await api.applyActual(ppConfig,ppQty,{qty:input.valueAsNumber});refresh({force:true});}
  catch(error){input.value=input.defaultValue;announce(error.message);}
 });
 body.addEventListener('keydown',event=>{if(event.target.matches('[data-pp-qty]')&&event.key==='Enter'){event.preventDefault();event.target.blur();}});
 $('#pp-back').onclick=()=>hide();
 $('#pp-shop-settings').onclick=()=>api.editShop(shop);
 $('#pp-alert').onclick=()=>openAlert();
 $('#pp-new-link').onclick=()=>api.newLink(shop==='all'?api.activeShop():shop);
 $('#pp-batch').onclick=()=>openBatch();
 $('#pp-undo').onclick=()=>{api.undo();if(api.nas)refresh({force:true});};
 $('#pp-redo').onclick=()=>{api.redo();if(api.nas)refresh({force:true});};
 function cellPosition(target){
  const cell=target.closest('[data-pp-col]'),row=cell?.closest('[data-pp-row]');
  return row?{id:row.dataset.ppRow,col:Number(cell.dataset.ppCol)}:null;
 }
 function cellAt({id,col}){return renderedRows.get(id)?.cells[col];}
 function rangeBounds(){
  if(!range)return null;
  const from=drawnIds.indexOf(range.start.id),to=drawnIds.indexOf(range.end.id),high=moreColumns?18:14;
  if(from<0||to<0||range.start.col>high||range.end.col>high)return null;
  return [Math.min(from,to),Math.max(from,to),Math.min(range.start.col,range.end.col),Math.max(range.start.col,range.end.col)];
 }
 function copyValue(cell){
  const input=cell?.querySelector('input:not([type="checkbox"])');
  // 到手价显示为整数，复制仍使用可重新粘贴的原始精度。
  if(input?.dataset.ppCell==='price')return input.dataset.ppPrecise;
  const value=(input?.value??cell?.textContent??'').trim().replace(/[\t\r\n]+/g,' ');
  return value==='—'?'':cell?.classList.contains('pp-number')?value.replace(/,/g,''):value;
 }
 function paintRange(){
  const bounds=rangeBounds();
  const current=bounds&&cellAt(range.end);
  const nextRows=new Map(),nextCells=new Set(),high=moreColumns?18:14;
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
  const formula=column===6||column===7?'到手价 − '+(column===6?'核算成本':'ERP 成本')+' − 扣点 − 固定费用 − 分期费':null;
  const field=current?.querySelector('[data-pp-cell]');
  const formulaEditor=$('#pp-formula-value');
  if(document.activeElement!==formulaEditor){
   formulaEditor.readOnly=field?.dataset.ppCell!=='price';
   formulaEditor.value=current?(formula||copyValue(current)||'—'):'';
  }
  $('#pp-formula-hint').textContent=current?columns[column][0]+(field?' · 可编辑':' · 只读'):'';
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
  const pos={id:drawnIds[index],col:Math.max(0,Math.min(moreColumns?18:14,range.end.col+move[1]))};
  if(!onGrid){event.stopPropagation();focusRange();}
  markRange(pos,event.shiftKey);cellAt(pos)?.scrollIntoView({block:'nearest',inline:'nearest'});
 },true);
 $('#pp-copy-range').onclick=async()=>{
  if(!selectedRows.size)return;
  try{await copyPlainText(rangeText());announce('已复制选区');}
  catch(error){focusRange();announce(error.message);}
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
  if(!price){paintRange();return;}
  price.defaultValue=price.dataset.ppPrecise;
  price.value=formulaEditor.value;
  if(commitInput(price))scheduleRefresh();
  else{price.value=price.defaultValue=whole(Number(price.dataset.ppPrecise));paintRange();}
 };
 formulaEditor.onkeydown=event=>{
  if(!formulaRowId||!['Enter','Escape'].includes(event.key))return;
  event.preventDefault();
  if(event.key==='Escape')formulaEditor.value=inputFor(formulaRowId,'price')?.dataset.ppPrecise??'';
  formulaEditor.blur();
 };
 formulaEditor.onpaste=event=>{if(formulaRowId)pasteArrivals(event,formulaRowId);};
 // 按显示顺序粘贴 Excel 的到手价列，整批校验通过才交给同一个撤销记录。
 function pasteArrivals(event,id){
  const text=event.clipboardData?.getData('text/plain')??'',lines=text.trim().split(/\r?\n/);
  if(lines.length<2)return false;
  event.preventDefault();
  try{
   const start=drawnIds.indexOf(id),ids=drawnIds.slice(start,start+lines.length);
   if(start<0||ids.length!==lines.length||lines.some(line=>line.trim().includes('\t')))throw Error('请粘贴到手价单列，且行数不得超出当前表格');
   const plan=lines.map((value,index)=>({id:ids[index],fields:{price:parseArrival(value.trim().replace(/[,，]/g,''))}}));
   if(event.target===formulaEditor){formulaRowId=null;formulaEditor.blur();}
   Promise.resolve(api.apply(plan,'粘贴到手价')).then(()=>refresh({force:true}),error=>announce(error.message));
  }catch(error){announce(error.message);}
  return true;
 }
 function openPartPicker(id,slot){
  const config=currentPriceRow(id)?.config;if(!config)return;
  const catalog=api.partCatalog?.(config.shopId)??[];
  api.openDialog('更换实际配件 · '+slot,'<label class="field">搜索型号或 GoodID<input id="pp-part-query" autocomplete="off"></label><div id="pp-part-options"></div><p id="pp-part-error" role="status"></p>');
  const panel=dialog(),query=panel.querySelector('#pp-part-query'),results=panel.querySelector('#pp-part-options');
  const draw=()=>{
   const text=query.value.trim().toLowerCase();
   const choices=catalog.filter(part=>[part.name,part.goodsId].some(value=>String(value||'').toLowerCase().includes(text))).slice(0,45);
   results.innerHTML=choices.map(part=>'<button type="button" class="pp-part-picker" data-pp-source="'+esc(part.sourceId)+'">'+esc(part.name)+' · '+esc(part.goodsId||'—')+'</button>').join('')||'<p>没有匹配配件</p>';
  };
  query.oninput=draw;draw();query.focus();
  results.onclick=async event=>{
   const choice=event.target.closest('[data-pp-source]');if(!choice)return;
   choice.disabled=true;
   try{await api.applyActual(id,slot,{sourceId:choice.dataset.ppSource});api.closeDialog();refresh({force:true});}
   catch(error){panel.querySelector('#pp-part-error').textContent=error.message;choice.disabled=false;}
  };
 }
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
  api.openDialog('批量调价','<p class="hint">已勾选 '+ids.length+' 套。金额和比例按到手价调整，目标价向上取整到元。</p><label class="field">利润口径<select id="pp-batch-basis"><option value="erp">ERP 利润</option><option value="tax">核算利润</option></select></label><label class="field">调整方式<select id="pp-batch-mode">'+options([['delta','统一增减金额（元）'],['ratio','按售价比例增减（%）'],['target','目标利润金额（元）'],['margin','目标利润率（%）']],'delta')+'</select></label><label class="field">调整值<input type="number" step="any" id="pp-batch-value" placeholder="如 100 或 -100"></label><p id="pp-batch-error" class="error" role="status"></p><div class="pp-batch-preview" id="pp-batch-preview"></div><div class="actions"><button id="pp-batch-apply" class="primary" disabled>应用到表格</button></div>');
  const d=dialog(),basis=d.querySelector('#pp-batch-basis'),value=d.querySelector('#pp-batch-value'),mode=d.querySelector('#pp-batch-mode'),preview=d.querySelector('#pp-batch-preview'),error=d.querySelector('#pp-batch-error'),apply=d.querySelector('#pp-batch-apply');
  const read=()=>{const lookup=new Map(rows().map(r=>[r.config.id,r])),selected=ids.map(id=>lookup.get(id));if(selected.some(r=>!r))throw Error('所选配置已变化，请重新勾选。');return planPriceBatch(selected,{basis:basis.value,mode:mode.value,input:value.value});};
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
  basis.onchange=mode.onchange=value.oninput=update;
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
  // 默认列出所有链接的配置，单套配件明细按需打开。
  if(!visible()){
   shop=api.activeShop();product='';chosen.clear();clearRange();collapsed.clear();expanded.clear();
   const config=api.currentConfig?.();
   if(config&&!config.emptyLinkDraft){range={start:{id:config.id,col:5},end:{id:config.id,col:5}};}
  }
  root.hidden=false;workspace.classList.add('price-profit-active');
  refresh({force:true});grid.focus({preventScroll:true});
 }
 function hide(){
  if(!visible())return;
  if(partPanel.matches(':popover-open'))partPanel.hidePopover();
  if(root.contains(document.activeElement)&&isEdited(document.activeElement))commitInput(document.activeElement);
  root.hidden=true;workspace.classList.remove('price-profit-active');pointerDown=false;rangePointer=null;api.onClose();
 }
 return {show,hide,visible,refresh,historyButtons};
}
