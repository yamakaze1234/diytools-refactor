/** 库存工作台固定框架，列表、任务编辑区和底栏分别更新。 */
export function inventoryShell({esc,shop,product,fromPrice},threshold){
 return `<header class="stock-header">
  <div class="stock-heading"><button id="stock-back" class="wb-btn">← 返回${fromPrice?'价格与利润':'配置总表'}</button>
   <h1 id="stock-title">检查商品库存</h1><span class="shop-tag">${esc(shop.name)}</span>
   <div id="stock-scope" class="wb-segments" aria-label="检查范围"><button data-scope-btn="shop">全店链接</button>${product?`<button data-scope-btn="link" title="${esc(product.name)}">当前链接：${esc(product.name)}</button>`:''}</div>
   <span id="stock-summary"></span></div>
  <div class="stock-scan-controls"><label>低库存阈值 ≤ <input id="stock-threshold" class="wb-input" type="number" min="0" max="100000000" step="1" value="${threshold}"></label>
   <button id="stock-scan" class="wb-btn wb-btn-primary wb-cut">重新检查</button></div></header>
 <div class="stock-body">
  <nav class="stock-filters" aria-label="库存筛选"><h2>库存状态</h2><div id="stock-statuses"></div>
   <div class="category-heading"><h2>配件类别 (ERP)</h2><button id="stock-reset-cat" class="wb-link" hidden>重置</button></div><div id="stock-categories"></div></nav>
  <section class="stock-center" aria-label="库存检查结果"><div class="stock-tools"><div id="stock-kpis"></div>
   <div class="stock-toolbar"><input id="stock-result-search" class="wb-input" type="search" placeholder="搜索配件名称、GoodID、关联链接或 SPU…" aria-label="搜索库存结果">
    <label class="wb-btn"><input id="stock-only-transit" type="checkbox">仅看有货在途</label>
    <div class="wb-segments" aria-label="列表分组"><button data-stock-group="status" aria-pressed="true">按状态分组</button><button data-stock-group="category" aria-pressed="false">按配件类别分组</button></div>
    <select id="stock-sort" class="wb-input" aria-label="排序"><option value="impact">按影响配置数 ↓</option><option value="stock">按库存从低到高 ↑</option></select>
    <button id="stock-expand-all" class="wb-btn">全部展开</button><button id="stock-collapse-all" class="wb-btn">全部收起</button></div></div>
   <div id="stock-results"></div></section>
  <aside class="stock-side" aria-label="批量替换任务台">
   <header><div><strong>批量替换任务台</strong><small>展示配件与实际配件按槽位同步替换</small></div><span id="stock-task-count" class="badge badge-cat">0 条任务</span></header>
   <div id="stock-task-tabs"></div><div class="stock-editor"><div id="stock-empty"><b>⇄</b><strong>尚未选择替换任务</strong><small>在左侧列表中点击任意「无库存」或「低库存」配件的 <strong>「展示和实际一起替换」</strong>，可在此批量勾选链接、选择有货替代件并一次预览保存。</small></div>
    <div id="stock-work" hidden><div id="stock-original"></div>
     <section><div class="task-section-title"><strong id="stock-links-title"></strong><span><button class="wb-link" id="stock-select-all">全选</button> <button class="wb-link" id="stock-select-none">清空</button></span></div>
      <div id="stock-links"></div></section>
     <section><strong>2. 选择同品类有货替代件</strong><div class="stock-picker-controls"><label><input type="checkbox" id="stock-same">仅看同大类</label><label><input type="checkbox" id="stock-available">仅看有货</label>
      <input class="wb-input" id="stock-new-query" type="search" placeholder="搜索输出源名、ERP 名或 GoodID" aria-label="搜索替代件"></div><div id="stock-picker"></div></section>
     <section id="stock-name-editor" hidden><label for="stock-display-name"><strong>3. 展示名称（可选）</strong></label><div class="stock-name-controls"><input class="wb-input" id="stock-display-name"><button class="wb-btn" id="stock-default-name">恢复默认名</button></div>
      <small>仅修改海报/配置表展示名，实际 BOM 与成本仍按所选新配件核算。</small></section></div><div id="stock-diff"></div></div>
   <footer id="stock-task-actions"><strong>保存后可选导出所选链接全部配置：</strong><div class="stock-export">
    <label><input type="checkbox" data-stock-layout="long">配置图</label><label><input type="checkbox" data-stock-layout="square">SKU 图</label>
    <select class="wb-input" id="stock-sku-mode" aria-label="SKU 图样式"><option value="padded">详情图补白至 1:1</option><option value="dedicated">缩略图（专用 SKU 排版）</option></select></div>
    <div class="stock-save"><button class="wb-btn" id="stock-preview" disabled>预览全部任务</button><button class="wb-btn wb-btn-primary wb-cut" id="stock-apply" disabled>应用全部并保存</button></div>
    <button class="wb-btn" id="stock-retry" hidden>重试</button><p id="stock-message" role="status" aria-live="polite"></p></footer></aside></div>`;
}

const tones={out:'out',low:'low',unknown:'unk',ok:'ok'};
const labels={out:'无库存',low:'低库存',unknown:'库存未知',ok:'库存充足',issues:'全部不足（无+低）'};
const distinct=(items,key)=>new Set(items.flatMap(item=>item.sources.map(source=>source[key]))).size;
const transit=row=>row.value!==null&&row.incoming>row.value&&row.incoming>0;
export function stockTime(value){
 const date=new Date(value);
 if(!value||!Number.isFinite(date.getTime()))return '';
 const pad=n=>String(n).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function stockBadge(stock){
 return `<span class="badge badge-${tones[stock.status]}" data-status="${stock.status}">${labels[stock.status]}${stock.value==null?'':' · '+stock.value}</span>`;
}
// 搜索与在途条件作用于整个报告，类别数量再跟随当前库存状态。
export function drawInventoryResults({$,esc,issues,threshold,filters,categories,expanded,drafts,active}){
 const query=$('#stock-result-search').value.trim().toLowerCase();
 const matches=row=>(!$('#stock-only-transit').checked||transit(row))&&(!query||
  [row.name,row.category,row.goodsId,...row.sources.flatMap(s=>[s.product,s.spu,s.config,s.name])].some(v=>String(v??'').toLowerCase().includes(query)));
 const base=issues.filter(matches);
 const sets=Object.fromEntries(['out','low','unknown'].map(key=>[key,base.filter(row=>row.status===key)]));
 sets.issues=base.filter(row=>row.status!=='unknown');
 const selected=sets[filters.status],cards=selected.filter(row=>!filters.category||row.category===filters.category);
 const pressed=(a,b)=>String(a===b);
 $('#stock-statuses').innerHTML=['issues','out','low','unknown'].map(key=>`<button class="wb-nav-item ${filters.status===key?'active':''}" aria-pressed="${pressed(filters.status,key)}" data-stock-status="${key}">
  <span>${key==='issues'?'':`<i style="background:var(--wb-${tones[key]}-ink)"></i>`}${labels[key]}${key==='low'?` (≤${threshold})`:''}</span><b style="color:${key==='issues'?'inherit':`var(--wb-${tones[key]}-ink)`}">${sets[key].length}</b></button>`).join('');
 $('#stock-reset-cat').hidden=!filters.category;
 $('#stock-categories').innerHTML=['',...categories].map(cat=>{
  const count=cat?selected.filter(row=>row.category===cat).length:selected.length;
  return `<button class="wb-nav-item ${filters.category===cat?'active':''} ${cat&&!count?'zero':''}" aria-pressed="${pressed(filters.category,cat)}" data-stock-cat="${esc(cat)}"><span>${esc(cat||'全部配件')}</span><span>${count}</span></button>`;
 }).join('');
 const incoming=sets.out.filter(transit).length;
 const kpis=[['out','无库存配件',incoming?`其中 ${incoming} 种有货在途`:'可销 ≤ 0'],['low',`低库存配件 (≤${threshold})`,`涉及 ${distinct(sets.low,'productId')} 个链接`],
  ['issues','合计需处理',`共影响 ${distinct(sets.issues,'configId')} 套配置`],['unknown','库存未知','未绑定 ID 或未匹配 ERP']];
 $('#stock-kpis').innerHTML=kpis.map(([key,title,sub])=>`<button class="stock-kpi ${key==='issues'?'':'badge-'+tones[key]}" aria-pressed="${pressed(filters.status,key)}" data-stock-kpi="${key}"><span><b>${title}</b><strong>${sets[key].length}</strong></span><small>${sub}</small></button>`).join('');
 const impact=new Map(cards.map(row=>[row,distinct([row],'configId')]));
 const stockOrder=(a,b)=>(a.value??Infinity)-(b.value??Infinity);
 const impactOrder=(a,b)=>impact.get(b)-impact.get(a);
 cards.sort((a,b)=>$('#stock-sort').value==='stock'?stockOrder(a,b)||impactOrder(a,b):impactOrder(a,b)||stockOrder(a,b));
 const byStatus=filters.group==='status', groups=Map.groupBy(cards,row=>byStatus?row.status:row.category);
 const keys=byStatus?['out','low','unknown']:categories;
 $('#stock-results').innerHTML=keys.filter(key=>groups.has(key)).map(key=>{
  const rows=groups.get(key),sub=byStatus?'':['out','low','unknown'].map(st=>{const n=rows.filter(r=>r.status===st).length;return n?`${labels[st]} ${n}`:'';}).filter(Boolean).join(' · ');
  return `<section class="stock-group"><div class="stock-group-title ${byStatus?'section-stripe-'+tones[key]:''}"><span><b>${esc(byStatus?labels[key]:key)}</b> <span class="badge badge-cat">${rows.length} 种</span> <small>${sub}</small></span><small>影响 ${distinct(rows,'productId')} 个链接 · ${distinct(rows,'configId')} 套配置</small></div>
   ${rows.map(row=>{
    const key=esc(row.key),open=expanded.has(row.key),added=drafts.some(t=>t.issueKey===row.key);
    return `<article class="stock-issue ${active?.issueKey===row.key?'editing':''}"><div class="stock-item-head">
     <button class="stock-item-info" aria-expanded="${open}" data-stock-toggle="${key}"><span class="stock-item-badges">${stockBadge(row)} <span class="badge badge-cat">${esc(row.category)}</span>
      ${transit(row)?`<span class="badge badge-transit">${row.value<=0?'有货在途 · ':''}待入可销 ${row.incoming}</span>`:''}
      ${added?'<span class="badge badge-ok">已在替换任务</span>':''}<strong title="${esc(row.name)}">${esc(row.name)}</strong></span>
      <small> <span>GoodID ${esc(row.goodsId||'未绑定')}</span><span>影响 <b>${distinct([row],'productId')}</b> 个链接 · <b>${impact.get(row)}</b> 套配置</span><span>${esc(row.reason||'库存时间 '+(stockTime(row.updatedAt).slice(-5)||'未记录'))}</span><u>${open?'收起明细 ▲':'展开影响配置 ▼'}</u></small></button>
     ${row.status==='unknown'?'<small>仅支持定位核对</small>':`<button class="wb-btn ${added?'wb-btn-active':''}" data-stock-edit="${key}">${added?'编辑替换任务':'展示和实际一起替换'}</button>`}</div>
     ${open?`<div class="stock-occurrences">${row.sources.map(s=>`<div><span><strong>${esc(s.product)}</strong><small>· ${esc(s.config)}</small><span class="badge badge-cat">${esc(s.slot)} ×${esc(s.qty)}</span><small>SPU ${esc(s.spu||'未填写')}</small></span><button class="wb-btn" data-stock-locate="${esc(s.configId)}">定位配置</button></div>`).join('')}</div>`:''}</article>`;
   }).join('')}</section>`;
 }).join('')||'<div class="stock-no-results">当前筛选条件下暂无异常库存配件。</div>';
 return cards;
}
