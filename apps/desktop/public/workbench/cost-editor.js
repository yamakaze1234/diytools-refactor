/** 共享成本源编辑弹窗：支持查询、手工税价和批量粘贴，保存前核验输入。 */
import {componentStockHtml} from './component-stock-view.js';
import {parseCostPaste,parseCostPrice} from './cost-paste.js';
import {erpUnitCost} from './core.js';
import {moneyCents} from './pricing.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const stamp=x=>x?new Date(x).toLocaleString('zh-CN'):'尚未更新';
const money=x=>x==null?'—':Number(x).toFixed(2);
/** 维护成本编辑草稿与筛选界面，通过调用方保存接口提交。 */
export function openCostEditor(api){let page=0,selected=new Set(),preview=null,busy=false;
 api.openDialog(api.nas?'当前店铺核算价':'成本源维护',`<p class="hint">${api.nas?'打开时读取主机成本表。手动保存后本店这一行会保留手改价，直到点击「重新同步核算价」。':'库存与 ERP 成本由右上角“一键同步”更新。含税核算价人工维护，保存后同步到引用该 goods_id 的输出源和配置，并记录时间。'}</p><div class="cost-source-meta" id="cost-source-meta"></div>${api.reloadCosts?'<p id="cost-workbook-status" class="hint" role="status"></p>':''}<div class="source-toolbar"><input id="cost-source-search" type="search" placeholder="搜索 goods_id 或商品名称">${api.resume?'<select id="cost-price-filter" aria-label="筛选核算价"><option value="all">全部核算价</option><option value="different">与 ERP 成本不同</option><option value="manual">仅手动改价</option></select>':''}<button id="cost-source-paste-toggle">批量粘贴核算价</button>${api.reloadCosts?'<button id="cost-workbook-refresh">重新读取成本表</button>':''}</div><div id="cost-source-paste" class="hidden"><p class="hint">支持两列：goods_id＋含税单价；或先勾选商品，再粘贴一列单价（按表格原始顺序）。可带 goods_id / 含税成本表头，空值保留原价；#VALUE! 改用对应 ERP 成本，无可用 ERP 成本时保留原核算价。</p><textarea id="cost-paste-values" placeholder="100001&#9;100"></textarea><button id="cost-paste-check">预览修改</button><div id="cost-paste-message" class="hint" role="status" aria-live="polite"></div><div id="cost-paste-diff" class="hint"></div><button id="cost-paste-apply" class="primary" disabled>${api.nas?'保存本店核算价':'保存并更新引用配置'}</button></div><div class="cost-source-wrap"><table class="cost-source-table"><thead><tr><th><input id="cost-source-all" type="checkbox" aria-label="全选搜索结果"></th><th>goods_id</th><th>商品名称</th><th>可销库存</th><th>ERP 成本</th><th>含税核算单价</th><th>核算价更新时间</th><th></th></tr></thead><tbody id="cost-source-rows"></tbody></table></div><div class="source-pagination"><button id="cost-prev">上一页</button><span id="cost-page"></span><button id="cost-next">下一页</button></div><div id="cost-message" class="hint" role="status"></div>`);$('#dialog').classList.add('cost-dialog');
 const panel=$('#cost-source-rows');
 const isManual=row=>api.resume&&row.nasManualTax===true;
 function filtered(source=api.getRows()){
  const q=$('#cost-source-search').value.toLowerCase().trim(),mode=$('#cost-price-filter')?.value;
  return source.filter(row=>{
   if(![row.goodsId,row.name].join(' ').toLowerCase().includes(q))return false;
   if(mode==='manual')return isManual(row);
   if(mode!=='different')return true;
   // 只和有效的 ERP 成本比较，按界面显示的分币精度忽略工作簿小数误差。
   const erp=erpUnitCost(row),tax=moneyCents(row.tax);
   return !erp.fallback&&erp.cents!==null&&tax!==null&&erp.cents!==tax;
  });
 }
 function draw(){
  const source=api.getRows(),stocks=Map.groupBy(source,row=>row.goodsId);
  const rows=filtered(source),pages=Math.max(1,Math.ceil(rows.length/30));page=Math.min(page,pages-1);
  const last=source.reduce((last,row)=>row.taxUpdatedAt>last?row.taxUpdatedAt:last,'');
  $('#cost-source-meta').textContent=`最近核算价更新：${stamp(last)} ｜ 库存 / ERP：${stamp(api.lastErp())}`;
  panel.innerHTML=rows.slice(page*30,page*30+30).map(row=>{
   const unit=erpUnitCost(row),id=esc(row.goodsId),manual=isManual(row);
   return `<tr${manual?' class="cost-manual-row"':''}><td><input type="checkbox" data-cost-choice="${id}" ${selected.has(row.goodsId)?'checked':''}></td>
    <td>${id}</td><td>${esc(row.name)}</td><td>${componentStockHtml(row,stocks)}</td>
    <td>${unit.cents===null?'待补成本':money(unit.cents/100)}${unit.fallback?'<small class="erp-fallback-note">核算成本代入 · ERP价格未识别</small>':''}</td>
    <td><input data-manual-price="${id}" type="number" min="0" step=".01" value="${esc(row.tax)}" aria-label="${id} 含税核算单价">${manual?'<small>手动改价</small>':''}</td>
    <td><small>${stamp(row.taxUpdatedAt)}</small></td><td><div class="cost-row-actions"><button data-cost-save="${id}">保存</button>
    ${manual?`<button data-cost-resume="${id}" title="用成本表最新价格替换手改价，并恢复后续同步">重新同步核算价</button>`:''}</div></td></tr>`;
  }).join('')||'<tr><td colspan="8">没有符合筛选条件的核算价。</td></tr>';
  $('#cost-page').textContent=`${page+1} / ${pages} · ${rows.length} 条 · 已选 ${selected.size} 条`;
  $('#cost-prev').disabled=busy||!page;$('#cost-next').disabled=busy||page===pages-1;
  const all=$('#cost-source-all');
  all.checked=rows.length>0&&rows.every(row=>selected.has(row.goodsId));
  all.indeterminate=rows.some(row=>selected.has(row.goodsId))&&!all.checked;
  for(const checkbox of panel.querySelectorAll('[data-cost-choice]'))checkbox.onchange=()=>{
   checkbox.checked?selected.add(checkbox.dataset.costChoice):selected.delete(checkbox.dataset.costChoice);
   preview=null;$('#cost-paste-apply').disabled=true;draw();
  };
  for(const button of panel.querySelectorAll('[data-cost-save]'))button.onclick=()=>{
   if(busy)return;
   try{const value=button.closest('tr').querySelector('[data-manual-price]').value;
    void commit([{goodsId:button.dataset.costSave,tax:parsePrice(value)}]);
   }catch(error){message(error.message,true);}
  };
  for(const button of panel.querySelectorAll('[data-cost-resume]'))button.onclick=()=>update('正在读取该配件的成本表价格…',async()=>{
   const value=await api.resume(button.dataset.costResume);
   return `已重新同步为 ¥${money(value)}，后续跟随成本表。`;
  });
 }
 function message(text,error=false){for(const id of ['cost-message','cost-paste-message']){const el=$('#'+id);if(el){el.textContent=text;el.classList.toggle('danger',error);}}}
 const parsePrice=parseCostPrice;
 async function update(pending,action){
  if(busy)return;
  busy=true;message(pending);
  const controls=$$('#dialog-body :is(button,input,select,textarea)');
  const enabled=controls.filter(el=>!el.disabled);
  for(const control of enabled)control.disabled=true;
  try{
   await new Promise(resolve=>setTimeout(resolve,0));
   const detail=await action();
   if(panel.isConnected)message(detail);
  }catch(error){if(panel.isConnected)message(error.message,true);}
  finally{
   busy=false;
   if(panel.isConnected){
    for(const control of enabled)control.disabled=false;
    preview=null;$('#cost-paste-apply').disabled=true;$('#cost-paste-diff').textContent='';draw();
   }
  }
 }
 const commit=entries=>update(`正在保存 ${entries.length} 条核算价…`,async()=>{
  const count=await api.apply(entries);
  return `已更新 ${entries.length} 条核算价${api.nas?'，本店手改价已保留。':'，'+count+' 套配置已重新核算。'}`;
 });
 const restartPage=()=>{page=0;draw();};
 $('#cost-source-search').oninput=restartPage;
 if($('#cost-price-filter'))$('#cost-price-filter').onchange=restartPage;
 $('#cost-prev').onclick=()=>{page--;draw();};$('#cost-next').onclick=()=>{page++;draw();};$('#cost-source-all').onchange=e=>{filtered().forEach(r=>e.target.checked?selected.add(r.goodsId):selected.delete(r.goodsId));preview=null;$('#cost-paste-apply').disabled=true;draw();};
 $('#cost-source-paste-toggle').onclick=()=>$('#cost-source-paste').classList.toggle('hidden');$('#cost-paste-values').oninput=()=>{preview=null;$('#cost-paste-apply').disabled=true;$('#cost-paste-diff').textContent='';message('粘贴内容已更改，请点击“预览修改”。');};
 $('#cost-paste-check').onclick=()=>{preview=null;$('#cost-paste-apply').disabled=true;$('#cost-paste-diff').textContent='';try{
 const rows=api.getRows(),lookup=new Map(rows.map(r=>[r.goodsId,r]));
 const result=parseCostPaste($('#cost-paste-values').value,rows,[...selected]);preview=result.entries;const fallbackIds=new Set(result.erpFallbacks.map(r=>r.goodsId));
 const limit=100;$('#cost-paste-diff').textContent=preview.slice(0,limit).map(e=>`${e.goodsId} ${lookup.get(e.goodsId).name}：${money(lookup.get(e.goodsId).tax)} → ${money(e.tax)}${fallbackIds.has(e.goodsId)?'（#VALUE! 改用 ERP 成本）':''}`).join('\n')+(preview.length>limit?`\n…仅展示前 ${limit} 条，保存将应用全部 ${preview.length} 条。`:'');
 message(`可保存 ${preview.length} 条；已识别 ${result.headers} 行表头，${result.blank} 行空值保留，${result.valueErrors.length} 行 #VALUE! 中 ${result.erpFallbacks.length} 条改用 ERP 成本，${result.duplicates} 行相同重复价合并。`+(result.unavailableErp.length?` ${result.unavailableErp.length} 行 ERP 成本不可用，保留原核算价：${result.unavailableErp.slice(0,10).map(r=>r.goodsId).join('、')}${result.unavailableErp.length>10?'…':''}`:'')+(result.unmatched.length?` ${result.unmatched.length} 个 ID 未匹配，不会更新：${result.unmatched.slice(0,10).map(r=>r.goodsId).join('、')}${result.unmatched.length>10?'…':''}`:''));
 $('#cost-paste-apply').textContent=`保存 ${preview.length} 条${api.nas?'本店核算价':'并更新引用配置'}`;$('#cost-paste-apply').disabled=false;
 }catch(e){message(e.message,true);}};
 $('#cost-paste-apply').onclick=()=>preview&&commit(preview);draw();
 if(api.reloadCosts){
  const refresh=$('#cost-workbook-refresh'),status=$('#cost-workbook-status');
  refresh.onclick=async()=>{
   if(busy)return;
   busy=true;refresh.disabled=true;status.textContent='正在读取最新成本表…';
   try{
    const detail=await api.reloadCosts();
    if(status.isConnected)status.textContent=detail;
   }catch(error){if(status.isConnected)status.textContent='当前显示 NAS 已保存价。'+error.message;}
   finally{
    busy=false;refresh.disabled=false;
    if(status.isConnected){
     // 批量预览依赖读取时的价格，任何刷新结果都要求重新预览。
     if(preview)message('成本数据已刷新，请重新预览修改。');
     preview=null;$('#cost-paste-apply').disabled=true;$('#cost-paste-diff').textContent='';
     draw();
    }
   }
  };
  refresh.click();
 }
}
