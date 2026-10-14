/** 利润检测界面：选择配置范围、启动检查、查看历史并定位问题配置。 */
import {isLegacyTemplateConfig} from './template-library.js';
import {mountProfitScope} from './profit-scope.js';
/** 保存必要编辑后运行利润检测，状态和结果由本机接口返回。 */
export function openProfitCheck({openDialog,request,save,shopId,configs,selected,esc,toast,locate}){
 const openedShop=shopId();
 const all=configs().filter(c=>c.shopId===openedShop&&!c.deletedAt&&!c.emptyLinkDraft&&!isLegacyTemplateConfig(c));
 const allowed=new Set(all.map(c=>c.id)),initial=selected().filter(c=>allowed.has(c.id));
 const selection=new Set(initial.length?initial.map(c=>c.id):all.map(c=>c.id));
 const fmt=n=>n==null?'—':`${n<0?'-':''}¥${(Math.abs(n)/100).toFixed(2)}`;
 let outputNode,dialogNode,pendingStart;
 const output=()=>outputNode?.isConnected&&dialogNode?.open?outputNode:null;
 const show=report=>{
  if(!output()||shopId()!==openedShop)return;
  const rows=report.results.filter(r=>r.shop_id===openedShop&&allowed.has(r.config_id)),abnormal=rows.filter(r=>r.metric==='accounting'&&(!r.valid||r.loss||r.changed));
  const missing=r=>!r.valid&&(!/到手价|分期|数量无效/.test(r.reason||'')||/成本|含税价/.test(r.reason||''));
  const categories={missing:abnormal.filter(missing),profit:abnormal.filter(r=>!missing(r))};
  const count=items=>new Set(items.map(r=>r.config_id)).size;
  let category=categories.profit.length?'profit':'missing';
  output().innerHTML=`<p class="hint">已检测 ${new Set(rows.map(r=>r.config_id)).size} 套配置 · 本地核算需处理 ${count(abnormal)} 套 · 主机模板不参与检测</p><p class="hint">ERP 利润未知：本轮未实时采集 ERP 成本，历史缓存不作为本轮结果。本地核算使用本轮已保存的实际 BOM 和含税单价，独立保留历史与变化基准。</p><div class="profit-category-tabs" aria-label="检测结果分类"><button data-profit-category="missing">成本缺失 <b>${count(categories.missing)}</b></button><button data-profit-category="profit">利润异常 <b>${count(categories.profit)}</b></button></div><p id="profit-category-note" class="hint"></p><div id="profit-results"></div>`;
  const paint=()=>{
  output().querySelectorAll('[data-profit-category]').forEach(button=>{button.classList.toggle('active',button.dataset.profitCategory===category);button.setAttribute('aria-pressed',String(button.dataset.profitCategory===category));});
  output().querySelector('#profit-category-note').textContent=category==='missing'?'缺少已保存的含税单价或实际 BOM；补充后重新检测。无效结果会保留历史，不推进变化基准。':'仅显示核算亏损低于 -¥300、累计变化严格超过 ¥100 及其他计算异常。';
  const groups=new Map();for(const row of categories[category]){if(!groups.has(row.config_id))groups.set(row.config_id,[]);groups.get(row.config_id).push(row);}
  output().querySelector('#profit-results').innerHTML=`${[...groups.values()].map(g=>{
   const s=g[0].snapshot;
   return `<article class="profit-result profit-exception"><div class="profit-exception-heading"><strong>${esc(s.product)} / ${esc(s.name)}</strong><button data-profit-locate="${esc(g[0].config_id)}">定位配置</button></div>${g.map(r=>`<section><strong>${r.metric==='erp'?'ERP':'核算'}利润 ${r.valid?fmt(r.profit_cents):'无法计算'}</strong><span class="profit-reason">${r.loss?'亏损超过 ¥300 ':''}${r.changed?'累计变化超过 ¥100 ':''}</span>${r.reason?`<p>${esc(r.reason)}</p>`:''}${r.valid?`<p class="hint">上次差额 ${fmt(r.previous_delta_cents)} · 累计差额 ${fmt(r.anchor_delta_cents)}${r.configUpdated?' · 配置已更新，请重新检测':''}</p><button class="text-button" data-reset="${esc(r.config_id)}" data-result="${esc(r.id)}" data-metric="${r.metric}">重设此口径变化基准</button>`:''}</section>`).join('')}</article>`;
  }).join('')||`<p class="profit-empty">${category==='missing'?'没有成本缺失项。':'没有利润异常项。'}</p>`}`;
  output().querySelectorAll('[data-profit-locate]').forEach(button=>button.onclick=()=>locate?.(button.dataset.profitLocate));
  output().querySelectorAll('[data-reset]').forEach(button=>button.onclick=async()=>{if(shopId()!==openedShop)return toast('店铺已切换，请重新打开检测');if(!confirm('将此口径当前利润设为新基准？历史记录保留。'))return;try{const receipt=await request('/api/profit/reset',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),shopId:openedShop,configId:button.dataset.reset,metric:button.dataset.metric,resultId:button.dataset.result})});if(!receipt.ok)throw Error('这不是当前最新结果，请重新检测后重设基准');toast('基准已重设');button.disabled=true;}catch(e){toast(e.message);}});
  };
  output().querySelectorAll('[data-profit-category]').forEach(button=>button.onclick=()=>{category=button.dataset.profitCategory;paint();});paint();
 };
 const draw=()=>{
  openDialog('一键检测利润',`<p class="hint">本地手动检测使用已保存到手价、实际 BOM 和核算价（含配置独立改价），主机模板不参与。核算亏损低于 -¥300 或累计变化严格超过 ¥100 时提醒。ERP 本轮未实时采集，显示未知。单次最多检测 1000 套。</p><div class="profit-scope"></div><div class="actions"><button id="profit-start" class="primary">开始本地检测</button><button id="profit-history">查看本店历史</button></div><div id="profit-output" aria-live="polite"></div><details><summary>发布到后台监控</summary><label><input id="profit-publish-enabled" type="checkbox">保存后自动发布完整快照</label><label>目标目录<input id="profit-publish-directory" type="text" placeholder="例如 D:/监控数据"></label><button id="profit-publish-save">保存并发布</button><small id="profit-publish-status"></small></details>`);
  outputNode=document.querySelector('#profit-output');
  dialogNode=document.querySelector('#dialog');
  document.querySelector('#profit-publish-save').onclick=async()=>{try{const v=await request('/api/profit/publish',{method:'POST',body:JSON.stringify({enabled:document.querySelector('#profit-publish-enabled').checked,directory:document.querySelector('#profit-publish-directory').value})});if(output())document.querySelector('#profit-publish-status').textContent=v.error||((v.enabled?'已发布 '+v.publishedAt:'已关闭联动'));}catch(e){toast(e.message);}};
  document.querySelector('#dialog').classList.add('profit-check-dialog');
  for(const id of ['profit-publish-enabled','profit-publish-directory','profit-publish-save'])document.getElementById(id).disabled=true;
  document.querySelector('#profit-publish-status').textContent='此版本尚未接入后台发布';
  output().textContent='可离线检测本地核算利润；ERP 未实时采集，不会推进 ERP 基线。';
  mountProfitScope(document.querySelector('.profit-scope'),all,selection,esc);
  document.querySelector('#profit-start').onclick=async()=>{
   if(shopId()!==openedShop)return toast('店铺已切换，请重新打开检测');if(!selection.size)return toast('请勾选配置');if(selection.size>1000)return toast('单次最多检测 1000 套，请缩小勾选范围');const button=document.querySelector('#profit-start');button.disabled=true;output().textContent='正在保存配置…';
   try{await save();if(!output())return;if(shopId()!==openedShop)throw Error('店铺已切换，请重新打开检测');const configIds=[...selection].sort();if(!pendingStart||JSON.stringify(pendingStart.configIds)!==JSON.stringify(configIds))pendingStart={requestId:crypto.randomUUID(),shopId:openedShop,configIds};const started=await request('/api/profit/start',{method:'POST',body:JSON.stringify(pendingStart)});
    for(;;){if(!output()||shopId()!==openedShop)break;const report=await request('/api/profit/status',{method:'POST',body:JSON.stringify({shopId:openedShop,runId:started.runId})});if(!output()||shopId()!==openedShop)break;if(report.run.status==='completed'){pendingStart=null;show(report);break;}if(['failed','interrupted'].includes(report.run.status)){pendingStart=null;output().textContent=report.run.error||'检测中断';break;}output().textContent='正在计算本地核算利润…';await new Promise(resolve=>setTimeout(resolve,800));}
   }catch(e){if(output())output().textContent=e.message;}finally{if(button.isConnected)button.disabled=false;}
  };
  document.querySelector('#profit-history').onclick=async()=>{try{if(shopId()!==openedShop)throw Error('店铺已切换，请重新打开检测');const history=await request('/api/profit/history',{method:'POST',body:JSON.stringify({shopId:openedShop})});if(!output()||shopId()!==openedShop)return;output().innerHTML=history.runs.map(r=>`<button data-run="${esc(r.id)}">${esc(r.started_at)} · ${r.status==='completed'?'已完成':esc(r.status)} · ${r.covered} 套 · 本地核算</button>`).join('')||'<p>本店暂无新版本检测历史</p>';output().querySelectorAll('[data-run]').forEach(button=>button.onclick=async()=>{try{show(await request('/api/profit/status',{method:'POST',body:JSON.stringify({shopId:openedShop,runId:button.dataset.run})}));}catch(e){toast(e.message);}});}catch(e){toast(e.message);}};
 };
 draw();
}
