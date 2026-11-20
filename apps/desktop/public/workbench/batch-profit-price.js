/** 11-19：批量按目标利润定价——选范围、按核算或 ERP 利润填目标，可同时设分期和 99 结尾，预览后一次应用（可撤销）。 */
import {totals} from './core.js';
import {pricing} from './pricing.js';
import {overviewTableTotals} from './overview-table-model.js';

// 与总表同口径：核算利润 = 到手价 − 核算成本 − 分期费；ERP 利润 = 到手价 × 98% − ERP 总价（不扣分期）。
export function snap99(value){const n=Math.round(Number(value)),hundred=Math.floor(n/100),tens=Math.floor(n/10)%10;return tens>=5?hundred*100+99:Math.max(99,(hundred-1)*100+99);}
export function priceForTarget(config,settings,kind,target){
 const raw=totals(config,settings),quote=pricing(config,settings),t=overviewTableTotals(config,raw,quote,{price:0});
 const inst=quote.term===24?10:quote.percent||0;
 const base=kind==='tax'?t.fee:raw.erp,keep=kind==='tax'?1-inst/100:1-0.02;
 if(kind==='tax'&&quote.term==null)return null;
 if(base==null||!(keep>0))return null;
 const price=Math.round((target+Number(base))/keep);
 if(price<0)return price;
 return config.overviewPrice99?snap99(price):price;
}
const fmt=n=>n==null||!Number.isFinite(n)?'—':Math.round(n).toLocaleString('zh-CN');

export function openBatchProfitPrice({openDialog,esc,toast,settings,scopes,apply}){
 const defaultScope=scopes.find(s=>s.count&&s.preferred)?.key||scopes.find(s=>s.count)?.key||scopes[0].key;
 openDialog('批量按利润定价',`<p class="hint">按目标利润反推到手价，一次应用到所选范围。口径同配置总表：核算利润扣分期费，ERP 利润不扣分期。应用后可按 Ctrl+Z 或「撤销」恢复。</p>
 <div class="bpp-form">
  <fieldset><legend>范围</legend>${scopes.map(s=>`<label><input type="radio" name="bpp-scope" value="${s.key}" ${s.key===defaultScope?'checked':''} ${s.count?'':'disabled'}> ${esc(s.label)}（${s.links} 个链接 · ${s.count} 套）</label>`).join('')}</fieldset>
  <fieldset><legend>按哪个利润</legend><label><input type="radio" name="bpp-kind" value="tax" checked> 核算利润</label><label><input type="radio" name="bpp-kind" value="erp"> ERP 利润</label></fieldset>
  <label class="field">目标利润（元，可为负数）<input id="bpp-target" inputmode="decimal" autocomplete="off" placeholder="例如 100 或 -500"></label>
  <label class="field">分期<select id="bpp-installment"><option value="keep">保持各链接现状</option><option value="on">整链开启分期（到手价 × 10%）</option><option value="off">整链关闭分期</option></select></label>
  <label class="field">到手价 99 结尾<select id="bpp-99"><option value="keep">保持各链接现状</option><option value="on">整链取 99</option><option value="off">整链不取 99</option></select></label>
 </div>
 <p class="hint">分期与取 99 属于整条链接的设置。同链接未勾选配置会同步开关，开启取 99 也会调整这些配置的尾数，预览会一并列出。</p><p id="bpp-summary" class="hint" role="status"></p>
 <div class="bpp-preview"><table><thead><tr><th>链接</th><th>配置</th><th>现到手价</th><th>新到手价</th><th>变化</th><th>核算利润</th><th>ERP 利润</th></tr></thead><tbody id="bpp-rows"></tbody></table></div>
 <div class="actions"><button id="bpp-apply" class="primary" disabled>应用到所选范围</button></div>`);
 const $=s=>document.querySelector(s),val=name=>document.querySelector(`input[name="${name}"]:checked`)?.value;
 let plan=[];
 const build=()=>{
  const scope=scopes.find(s=>s.key===val('bpp-scope')),kind=val('bpp-kind'),text=$('#bpp-target').value.normalize('NFKC').replace(/[,，\s]/g,'').replace(/^[−–]/,'-'),target=Number(text);
  const inst=$('#bpp-installment').value,n99=$('#bpp-99').value;
  plan=[];$('#bpp-apply').disabled=true;
  if(!scope||text===''||text==='-'||!Number.isFinite(target)){$('#bpp-rows').innerHTML='';$('#bpp-summary').textContent='填写目标利润后显示预览。';return;}
  let skipped=0;const rows=[];
  for(const c of scope.configs()){
   // 在副本上先套用分期 / 99 设置，再反推价格，保证预览与应用一致。
   const next=structuredClone(c);
   if(inst!=='keep')next.installment=inst==='on'?24:0;
   if(n99!=='keep')next.overviewPrice99=n99==='on';
   const price=priceForTarget(next,settings(),kind,target);
   if(price==null||price<0){skipped++;continue;}
   next.price=price;
   const after=overviewTableTotals(next,totals(next,settings()),pricing(next,settings()));
   // 保留用户选择的模式，不能把“保持”误当成整链统一指令。
   plan.push({id:c.id,installment:next.installment,price99:next.overviewPrice99,installmentMode:inst,price99Mode:n99,price});
   rows.push(`<tr><td>${esc(c.product||'')}</td><td>${esc(c.name||'')}</td><td>${fmt(Number(c.price))}</td><td><strong>${fmt(price)}</strong></td><td class="${price>Number(c.price)?'bpp-up':price<Number(c.price)?'bpp-down':''}">${Number.isFinite(Number(c.price))?(price-Number(c.price)>0?'+':'')+fmt(price-Number(c.price)):'—'}</td><td>${fmt(after.taxProfit)}</td><td>${fmt(after.erpProfit)}</td></tr>`);
  }
  // 整链开关涉及未勾选配置时，也先预览这些副作用；它们不套用目标利润。
  if(inst!=='keep'||n99!=='keep'){
   const planned=new Set(plan.map(p=>p.id)),links=new Set(scope.configs().map(c=>c.productId));
   for(const c of scope.related?.()||[]){
    if(planned.has(c.id)||!links.has(c.productId))continue;
    const next=structuredClone(c);if(inst!=='keep')next.installment=inst==='on'?24:0;if(n99!=='keep')next.overviewPrice99=n99==='on';
    if(n99==='on'&&next.price!=null&&next.price!=='')next.price=snap99(next.price);
    const after=overviewTableTotals(next,totals(next,settings()),pricing(next,settings()));
    plan.push({id:c.id,installment:next.installment,price99:!!next.overviewPrice99,installmentMode:inst,price99Mode:n99,price:next.price});
    rows.push(`<tr><td>${esc(c.product||'')}</td><td>${esc(c.name||'')}（整链设置）</td><td>${fmt(c.price)}</td><td><strong>${fmt(next.price)}</strong></td><td>${c.price==null?'—':fmt(next.price-c.price)}</td><td>${fmt(after.taxProfit)}</td><td>${fmt(after.erpProfit)}</td></tr>`);
   }
  }
  $('#bpp-rows').innerHTML=rows.join('');
  const originals=new Map([...(scope.related?.()||[]),...scope.configs()].map(c=>[c.id,c]));
  const changed=plan.filter(p=>{const c=originals.get(p.id);return Number(c.price)!==p.price||(inst!=='keep')||(n99!=='keep');}).length;
  $('#bpp-summary').textContent=`将调整 ${plan.length} 套${skipped?`，${skipped} 套成本不完整已跳过目标利润定价`:''}；其中到手价有变化的 ${plan.filter(p=>Number(originals.get(p.id).price)!==p.price).length} 套。`;
  $('#bpp-apply').disabled=!plan.length||!changed;
 };
 document.querySelectorAll('#dialog input, #dialog select').forEach(el=>el.addEventListener('input',build));
 document.querySelectorAll('#dialog input[type=radio], #dialog select').forEach(el=>el.addEventListener('change',build));
 $('#bpp-target').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&!$('#bpp-apply').disabled){e.preventDefault();$('#bpp-apply').click();}});
 $('#bpp-apply').onclick=async()=>{if(!plan.length)return;const kind=val('bpp-kind')==='tax'?'核算':'ERP',target=$('#bpp-target').value.trim(),count=plan.length;try{await apply(plan,`批量按${kind}利润 ${target} 定价`);toast(`已按${kind}利润 ${target} 调整 ${count} 套配置，可撤销`);}catch(error){toast(error.message);}};
 build();$('#bpp-target').focus();
}
