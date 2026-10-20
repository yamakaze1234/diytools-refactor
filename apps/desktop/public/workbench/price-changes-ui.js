/** 本机价格批次查询、配件分类、利润追踪与处理回执。 */
import {filterPriceItems,priceMovement,trackedProfit,money,linkKey} from './price-changes.js';
import {priceReportSheets,priceReportWorkbook} from './price-changes-export.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={high:'上涨 ≥5% / 从零上涨',up:'上涨 <5%',down:'降价',first:'首次采集',missing:'价格缺失',same:'本口径未变化'};
const stamp=v=>new Date(v).toLocaleString('zh-CN');
export async function openPriceChanges(api,{revision,automatic=false}={}){
 const call=(action,data={})=>api.request('/api/price-changes/'+action,{method:'POST',body:JSON.stringify(data)});
 api.openDialog(automatic?'本次价格变动':'检查价格变化','<p id="price-loading" role="status">正在读取价格变化记录…</p>');
 const loading=document.querySelector('#price-loading');
 let view=loading;
 try{
 let batches=(await call('list')).batches;if(!loading.isConnected||!document.querySelector('#dialog').open)return;
 if(!batches.length){loading.textContent='暂无价格变化记录。启用此功能后的成本更新或 ERP 同步会自动记录，升级时会从本机真实历史补录今日价格更新。';return;}
 let batch,tab='parts',metric='erp',band='',slot='',search='',status='',selected=null,offset=0,more=batches.length===30,generation=0,page=0;
 const current=()=>api.configs();
 const draw=()=>{
  // 每次重绘只属于当前仍打开的视图；关闭后返回的处理回执不能重新 showModal。
  if(!view.isConnected||!document.querySelector('#dialog').open)return;
  const items=filterPriceItems(batch.items,{metric,band,slot,search:tab==='parts'?search:''}),ids=new Set(items.flatMap(r=>r.configIds));
  const configs=batch.configs.filter(r=>ids.has(r.after.id)&&(!status||(status==='done')===batch.handled.includes(r.after.id))&&(!search||tab==='parts'||`${r.after.product} ${r.after.name} ${r.after.productUrl} ${batch.items.filter(i=>i.configIds.includes(r.after.id)).map(i=>i.name+' '+i.goodsId).join(' ')}`.toLowerCase().includes(search.toLowerCase())));
  const total=tab==='parts'?items.length:configs.length,pages=Math.max(1,Math.ceil(total/60));page=Math.min(page,pages-1);const visibleItems=items.slice(page*60,page*60+60),visibleConfigs=configs.slice(page*60,page*60+60);
  if(!visibleConfigs.some(c=>c.after.id===selected))selected=visibleConfigs[0]?.after.id;
  const allLinks=new Set(batch.configs.map(r=>linkKey(r.after))).size;
  const unique=new Set(batch.items.map(r=>r.goodsId)).size;
  api.openDialog(automatic?'本次价格变动':'检查价格变化',`<section class="price-track"><p class="hint">${esc(batch.message||'价格更新')} · ${esc(stamp(batch.at))} · ${batch.daily?'昨日最后保存价 → 今日最新保存价':'与本次保存前比较'}</p><div class="price-tabs"><button id="pc-day" class="${batch.daily?'active':''}">今日 vs 昨日</button><button id="pc-single" class="${!batch.daily?'active':''}">逐批次变化</button></div><div class="price-summary"><span>变动配件 <b>${unique}</b></span><span>影响链接 <b>${allLinks}</b><small>按店铺去重</small></span><span>影响配置 <b>${batch.configs.length}</b></span><span>${batch.daily?'对比日期':'待处理'} <b>${batch.daily?esc(batch.day):batch.configs.filter(c=>!batch.handled.includes(c.after.id)).length}</b></span></div><div class="price-toolbar"><label>更新批次<select id="pc-batch" ${batch.daily?'disabled':''}>${batches.map(b=>`<option value="${b.revision}" ${b.revision===batch.revision?'selected':''}>${esc(stamp(b.at))} · ${esc(b.message||'价格更新')}</option>`).join('')}</select></label>${more?'<button id="pc-more">更早批次</button>':''}<label>价格口径<select id="pc-metric"><option value="erp" ${metric==='erp'?'selected':''}>ERP 价</option><option value="tax" ${metric==='tax'?'selected':''}>成本价（含税核算）</option></select></label><label>配件类型<select id="pc-slot"><option value="">全部类型</option>${[...new Set(batch.items.flatMap(r=>r.slots))].sort().map(s=>`<option ${slot===s?'selected':''}>${esc(s)}</option>`).join('')}</select></label><label class="price-search">搜索<input id="pc-search" type="search" value="${esc(search)}" placeholder="配件 / ERP编码 / 链接"></label></div><div class="price-bands"><button data-band="" class="${!band?'active':''}">全部</button>${Object.entries(names).map(([k,n])=>`<button data-band="${k}" class="${band===k?'active':''}">${n} <small>${batch.items.filter(r=>priceMovement(r,metric).kind===k).length}</small></button>`).join('')}</div><div class="price-tabs"><button data-tab="parts" class="${tab==='parts'?'active':''}">配件变化</button><button data-tab="links" class="${tab==='links'?'active':''}">受影响链接</button><label>处理状态<select id="pc-status" ${batch.daily?'disabled':''}><option value="">全部</option><option value="todo" ${status==='todo'?'selected':''}>待处理</option><option value="done" ${status==='done'?'selected':''}>已处理</option></select></label></div><div id="pc-content"></div><div class="actions"><button id="pc-prev" ${page===0?'disabled':''}>上一页</button><span>${page+1} / ${pages} 页 · ${total} 项</span><button id="pc-next" ${page>=pages-1?'disabled':''}>下一页</button></div><p class="hint">成本价与 ERP 价分别记录；同配件不同旧价分行列出。按实际 BOM 关联，利润已扣分期费；历史快照保留，处理标记只属于本批次。</p><div class="actions"><button id="pc-export" ${batch.daily&&!batch.baselineKnown?'disabled':''}>导出完整报表（Excel）</button><button id="pc-close">${automatic?'稍后查看':'关闭'}</button>${automatic?'<button id="pc-all" class="primary">查看受影响链接</button>':''}</div></section>`);
  document.querySelector('#dialog').classList.add('price-changes-dialog');
  const content=document.querySelector('#pc-content');
  view=content;
  const change=r=>{const m=priceMovement(r,metric);return `<span class="pc-${m.kind}">${m.label||`${m.delta>0?'+':''}${money(m.delta)}${m.percent==null?'':` / ${m.percent>0?'+':''}${m.percent.toFixed(1)}%`}`}</span>`;};
  if(tab==='parts'){
   const groups=new Map();for(const r of visibleItems){const key=names[priceMovement(r,metric).kind]+' · '+(r.slots.join(' / ')||'未分类');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
   content.innerHTML=[...groups].map(([title,rs])=>`<details class="price-group" open><summary>${esc(title)} <small>${rs.length} 项</small></summary><div class="price-table-scroll"><table><thead><tr><th>配件 / ERP编码</th><th>成本价 前 → 后</th><th>ERP价 前 → 后</th><th>变化幅度</th><th>影响链接</th></tr></thead><tbody>${rs.map(r=>`<tr><td>${esc(r.name)}<small>${esc(r.goodsId)}</small></td><td>${money(r.before.tax)} → ${money(r.after.tax)}</td><td>${money(r.before.erp)} → ${money(r.after.erp)}</td><td>${change(r)}</td><td><button data-goods="${esc(r.goodsId)}">${new Set(batch.configs.filter(c=>r.configIds.includes(c.after.id)).map(c=>linkKey(c.after))).size} 个链接 ›</button></td></tr>`).join('')}</tbody></table></div></details>`).join('')||'<p class="price-empty">没有符合筛选条件的配件。</p>';
   content.querySelectorAll('[data-goods]').forEach(b=>b.onclick=()=>{search=b.dataset.goods;tab='links';page=0;draw();});
  }else{
   content.innerHTML=`<p class="hint">当前筛选：${new Set(configs.map(c=>linkKey(c.after))).size} 个链接 · ${configs.length} 套配置</p><div class="price-link-layout"><div class="price-table-scroll"><table><thead><tr><th>链接 / 配置</th><th>${metric==='tax'?'核算':'ERP'}利润 前 → 后</th><th>状态</th></tr></thead><tbody>${visibleConfigs.map(r=>`<tr class="${selected===r.after.id?'selected':''}"><td><button data-config="${esc(r.after.id)}">${esc(r.after.product)} / ${esc(r.after.name)}</button><small>${esc(api.shopName?.(r.after.shopId)||r.after.shopId)}</small></td><td>${money(trackedProfit(r.before)?.[metric])} → ${money(trackedProfit(r.after)?.[metric])}</td><td>${batch.daily?'按批次处理':batch.handled.includes(r.after.id)?'已处理':'待处理'}</td></tr>`).join('')||'<tr><td colspan="3">没有符合筛选条件的配置。</td></tr>'}</tbody></table></div><aside id="pc-detail"></aside></div>`;
   content.querySelectorAll('[data-config]').forEach(b=>b.onclick=()=>{selected=b.dataset.config;draw();});
   const row=configs.find(c=>c.after.id===selected),detail=document.querySelector('#pc-detail');
   if(row){const c=row.after,live=current().find(v=>v.id===c.id&&!v.deletedAt),p=trackedProfit(live),old=trackedProfit(row.before),next=trackedProfit(c),handled=batch.handled.includes(c.id);let url='';try{const parsed=new URL(live?.productUrl||c.productUrl);if(['http:','https:'].includes(parsed.protocol))url=parsed.href;}catch{}
    detail.innerHTML=`<h3>${esc(c.product)}</h3><p>${esc(c.name)} · 实际 BOM</p>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开商品链接 ↗</a>`:'<small>未填写商品网址</small>'}<dl><dt>${batch.daily?'昨日 → 今日':'本批次'}核算利润</dt><dd>${money(old?.tax)} → ${money(next?.tax)}</dd><dt>${batch.daily?'昨日 → 今日':'本批次'} ERP 利润</dt><dd>${money(old?.erp)} → ${money(next?.erp)}</dd><dt>当前已保存到手价</dt><dd>${live?money(Math.round(Number(live.price)*100)):'配置已删除'}</dd><dt>当前核算 / ERP 利润</dt><dd>${money(p?.tax)} / ${money(p?.erp)}</dd></dl>${old?.fallback||next?.fallback||p?.fallback?'<p class="hint">部分 ERP 成本缺失，利润使用核算成本代入。</p>':''}<h4>本次变价配件</h4>${batch.items.filter(r=>r.configIds.includes(c.id)).map(r=>`<p>${esc(r.name)}<br><small>核算 ${money(r.before.tax)} → ${money(r.after.tax)}<br>ERP ${money(r.before.erp)} → ${money(r.after.erp)}</small></p>`).join('')}<button id="pc-locate" class="primary" ${!live?'disabled':''}>定位配置并调整</button><button id="pc-handle" ${batch.daily?'disabled title="请在逐批次变化中标记处理"':''}>${batch.daily?'处理标记请切换逐批次':handled?'恢复待处理':'标记已处理'}</button>`;
    document.querySelector('#pc-locate').onclick=()=>api.locate(c.id);
    document.querySelector('#pc-handle').onclick=async e=>{e.target.disabled=true;try{await call('handle',{revision:batch.revision,configId:c.id,handled:!handled});batch.handled=handled?batch.handled.filter(id=>id!==c.id):[...batch.handled,c.id];if(content.isConnected)draw();}catch(error){api.toast(error.message);e.target.disabled=false;}};
   }
  }
  document.querySelector('#pc-day').onclick=()=>loadDay();document.querySelector('#pc-single').onclick=()=>load(batches[0].revision);
  document.querySelector('#pc-prev').onclick=()=>{page--;draw();};document.querySelector('#pc-next').onclick=()=>{page++;draw();};
  document.querySelector('#pc-batch').onchange=e=>load(Number(e.target.value));
  document.querySelector('#pc-more')?.addEventListener('click',async e=>{e.target.disabled=true;try{const next=(await call('list',{offset:offset+30})).batches;if(!content.isConnected)return;offset+=30;batches.push(...next);more=next.length===30;draw();}catch(err){api.toast(err.message);e.target.disabled=false;}});
  for(const [id,set] of [['pc-metric',v=>metric=v],['pc-slot',v=>slot=v],['pc-status',v=>status=v]])document.getElementById(id).onchange=e=>{set(e.target.value);page=0;draw();};
  document.querySelector('#pc-search').oninput=e=>{search=e.target.value;page=0;const position=e.target.selectionStart;draw();const field=document.querySelector('#pc-search');field.focus();field.setSelectionRange(position,position);};
  // 弹窗与主编辑器都有 data-tab；事件只能绑定当前价格视图，避免覆盖主编辑器页签。
  const root=content.closest('.price-track');
  root.querySelectorAll('[data-band]').forEach(b=>b.onclick=()=>{band=b.dataset.band;page=0;draw();});
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;page=0;draw();});
  document.querySelector('#pc-export').onclick=async e=>{const button=e.currentTarget;button.disabled=true;try{const sheets=priceReportSheets(batch,{configs:current(),shopName:api.shopName});const blob=priceReportWorkbook(sheets);await api.download(blob,`价格变动_${batch.daily?batch.day+'-昨日对比':'批次'+batch.revision}.xlsx`);api.toast('已发起报表下载，包含完整配件及链接利润明细');}catch(error){api.toast('导出失败：'+error.message);}finally{button.disabled=false;}};
  document.querySelector('#pc-close').onclick=()=>document.querySelector('#dialog').close();
  document.querySelector('#pc-all')?.addEventListener('click',()=>{automatic=false;tab='links';page=0;draw();});
 };
 const load=async id=>{const token=++generation,anchor=document.querySelector('#pc-content')||loading;try{const result=await call('detail',{revision:id});if(token!==generation||!anchor.isConnected||!document.querySelector('#dialog').open)return;batch=result;selected=null;page=0;if(batch.items.every(r=>r.before.erp===r.after.erp))metric='tax';draw();await call('seen',{revision:id});}catch(error){api.toast(error.message);}};
 const loadDay=async()=>{const token=++generation,anchor=document.querySelector('#pc-content')||loading;try{const result=await call('day');if(token!==generation||!anchor.isConnected||!document.querySelector('#dialog').open)return;batch=result;page=0;selected=null;band='';slot='';search='';status='';metric='tax';draw();if(!batch.baselineKnown)document.querySelector('#pc-content').innerHTML='<p class="price-empty">本机缺少可核验的昨日基线，请查看逐批次记录。不会把今天上一次更新当作昨天价格。</p>';}catch(error){api.toast(error.message);}};
 await load(revision||batches[0].revision);
 }catch(error){if(loading.isConnected)loading.textContent=error.message;}
}
