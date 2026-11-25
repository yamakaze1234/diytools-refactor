/** 提醒条固定单行；汇总弹窗只提交已明确选择的配置/配件明细。 */
import {summarizeTaxOverrides,taxDelta} from './tax-override-model.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=value=>value==null?'待补基准':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
export const deltaLabel=value=>value==null?'待补基准':(value>=0?'+':'')+amount(value);
const interval=values=>{const known=[...new Set(values.filter(v=>v!=null))].sort((a,b)=>a-b);return !known.length?'待补基准':known.length===1?amount(known[0]):amount(known[0])+'～'+amount(known.at(-1));};

export function mountTaxOverrideTools(root,api){
 const banner=root.querySelector('#pp-tax-banner'),reopen=root.querySelector('#pp-tax-reopen');
 let summary=summarizeTaxOverrides([],[]),hidden=false,filter=null;
 const refresh=()=>api.refresh();
 function setFilter(next){filter=JSON.stringify(filter)===JSON.stringify(next)?null:next;refresh();}
 function draw(){
  banner.hidden=!summary.count||hidden;reopen.hidden=!summary.count||!hidden;
  reopen.textContent='单独核算价 '+summary.count+' 套';
  banner.innerHTML=`<strong>单独核算价：${summary.count} 套配置 <small>（${summary.itemCount} 项 · 涉及 ${summary.partCount} 款配件）</small></strong><div class="pp-tax-chips">${summary.groups.slice(0,3).map(group=>`<button data-tax-part="${esc(group.goodsId)}" title="${esc(group.name)}">${esc(group.slot)}·${esc(group.name)} · ${group.ids.size}套 (${deltaLabel(taxDelta(group.lines))})</button>`).join('')}${summary.partCount>3?`<button data-tax-summary>+${summary.partCount-3} 款</button>`:''}</div><div class="pp-tax-actions"><button data-tax-only aria-pressed="${!!filter}">只看改动 (${summary.count})</button><button data-tax-summary>查看汇总 / 批量还原</button><button data-tax-hide aria-label="暂时收起单独核算价提醒">×</button></div>`;
 }
 const selections=lines=>lines.map(line=>({configId:line.configId,lineKey:line.lineKey}));
 async function open(){
  let tab='parts',query='',chosen=new Set(),busy=false;
  api.openDialog('单独核算价汇总与批量管理',`<section id="tax-summary-panel"><div class="pp-tax-tabs" role="tablist"><button data-tax-tab="parts" role="tab">按配件聚合</button><button data-tax-tab="configs" role="tab">按配置明细</button></div><div id="tax-summary-body"></div><p id="tax-summary-status" role="status"></p></section>`);
  // 事件只挂本次弹窗节点，关闭移除后不会被永久 dialog-body 保留。
  const panel=document.querySelector('#tax-summary-panel'),body=panel.querySelector('#tax-summary-body'),status=panel.querySelector('#tax-summary-status');
  function render(){
   panel.querySelectorAll('[data-tax-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.taxTab===tab)));
   if(tab==='parts')body.innerHTML=`<div class="pp-tax-scroll"><table class="pp-tax-summary-table"><thead><tr><th>配件 / GoodID</th><th>三店共用价</th><th>当前独立价</th><th>单件差额</th><th>涉及套数</th><th>操作</th></tr></thead><tbody>${summary.groups.map((group,i)=>`<tr><td>${esc(group.name)}<small>${esc(group.goodsId)}</small></td><td>${interval(group.lines.map(l=>l.base))}</td><td>${interval(group.lines.map(l=>l.value))}</td><td>${interval(group.lines.map(l=>l.unit))}</td><td>${group.ids.size}</td><td><button data-tax-show-part="${i}">筛出看表</button><button data-tax-restore-part="${i}">还原此配件 (${group.ids.size}套)</button></td></tr>`).join('')}</tbody></table></div>`;
   else {
    const lines=summary.lines.filter(l=>[l.configName,l.product,l.name,l.goodsId].join(' ').toLowerCase().includes(query.toLowerCase()));
    body.innerHTML=`<label class="field">搜索配置或配件<input id="tax-summary-query" value="${esc(query)}" type="search"></label><div class="pp-tax-scroll"><table class="pp-tax-summary-table"><thead><tr><th>选择</th><th>链接 / 配置</th><th>配件</th><th>单独价 / 共用价</th><th>数量 / 总差额</th><th>操作</th></tr></thead><tbody>${lines.map(line=>`<tr><td><input type="checkbox" data-tax-select="${esc(line.key)}" aria-label="选择${esc(line.configName+' '+line.slot)}" ${chosen.has(line.key)?'checked':''}></td><td>${esc(line.product)}<small>${esc(line.configName)}</small></td><td>${esc(line.slot+' '+line.name)}</td><td>${amount(line.value)} / ${amount(line.base)}</td><td>${line.qty} / ${deltaLabel(line.delta)}</td><td><button data-tax-jump="${esc(line.configId)}">定位</button></td></tr>`).join('')}</tbody></table></div><div class="actions"><button id="tax-restore-selected" ${chosen.size?'':'disabled'}>还原已勾选 ${chosen.size} 项</button><button id="tax-restore-all">全部恢复共用价 (${summary.count}套 · ${summary.itemCount}项)</button></div>`;
    const search=body.querySelector('#tax-summary-query');search.oninput=()=>{const pos=search.selectionStart;query=search.value;render();const next=body.querySelector('#tax-summary-query');next.focus();next.setSelectionRange(pos,pos);};
   }
  }
  panel.onclick=async event=>{
   if(busy)return;
   const button=event.target.closest('button'),data=button?.dataset??{};
   if(data.taxTab){tab=data.taxTab;render();return;}
   if(data.taxShowPart!==undefined){const group=summary.groups[Number(data.taxShowPart)];api.closeDialog();setFilter({part:group.goodsId});return;}
   if(data.taxJump){api.closeDialog();filter=null;api.locate(data.taxJump);return;}
   const lines=data.taxRestorePart!==undefined?summary.groups[Number(data.taxRestorePart)]?.lines:button?.id==='tax-restore-all'?summary.lines:button?.id==='tax-restore-selected'?summary.lines.filter(l=>chosen.has(l.key)):null;
   if(!lines?.length)return;
   busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{const restored=await api.restore(selections(lines));if(restored!==false&&body.isConnected){api.closeDialog();refresh();}}
   catch(error){if(body.isConnected)status.textContent=api.errorText(error);}
   finally{busy=false;if(body.isConnected){panel.querySelectorAll('[data-tax-tab]').forEach(button=>button.disabled=false);render();}}
  };
  panel.onchange=event=>{const key=event.target.dataset.taxSelect;if(key){event.target.checked?chosen.add(key):chosen.delete(key);render();}};
  render();
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;const data=button.dataset;
  if(data.taxHide!==undefined){hidden=true;draw();}
  else if(button===reopen){hidden=false;draw();}
  else if(data.taxOnly!==undefined){filter=filter?null:{all:true};refresh();}
  else if(data.taxSummary!==undefined)void open();
  else if(data.taxPart!==undefined)setFilter({part:data.taxPart});
  else if(data.taxLocate)api.locate(data.taxLocate);
  else if(data.taxGroup)setFilter({ids:JSON.parse(data.taxGroup)});
 });
 return {
  update(configs,costs){summary=summarizeTaxOverrides(configs,costs);if(!summary.count)filter=null;draw();},
  active:()=>!!filter,
  matches:config=>!filter||summary.byConfig.has(config.id)&&(!filter.part||summary.byConfig.get(config.id).some(l=>l.goodsId===filter.part))&&(!filter.ids||filter.ids.includes(config.id)),
  info:id=>summary.byConfig.get(id)??[],
  group:ids=>summary.lines.filter(line=>ids.includes(line.configId)),
  formula:id=>(summary.byConfig.get(id)??[]).map(line=>`${line.slot}：单独价 ${amount(line.value)} vs 共用价 ${amount(line.base)}（${deltaLabel(line.unit)} × ${line.qty}）`).join('；'),
  resetFilter(){filter=null;},open,
 };
}
