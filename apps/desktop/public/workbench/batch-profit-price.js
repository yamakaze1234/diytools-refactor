/** 11-19：批量按目标利润定价——选范围、按核算或 ERP 利润填目标，可同时设分期和 99 结尾，预览后一次应用（可撤销）。 */
import {totals} from './core.js';
import {pricing} from './pricing.js';
import {overviewTableTotals} from './overview-table-model.js';

// 与总表同口径：核算利润 = 到手价 − 核算成本 − 分期费；ERP 利润 = 到手价 × 98% − ERP 总价（不扣分期）。
export function snap99(value){const n=Math.round(Number(value)),hundred=Math.floor(n/100),tens=Math.floor(n/10)%10;return tens>=5?hundred*100+99:Math.max(99,(hundred-1)*100+99);}
export function priceForTarget(config,settings,kind,target){
 const quote=pricing(config,settings),raw=totals(config,settings,quote);
 return targetArrival(config,raw,quote,kind,target);
}
function targetArrival(config,raw,quote,kind,target){
 const t=kind==='tax'?overviewTableTotals(config,raw,quote,{price:0}):null;
 const inst=quote.term===24?10:quote.percent||0;
 const base=kind==='tax'?t.fee:raw.erp,keep=kind==='tax'?1-inst/100:1-0.02;
 if(kind==='tax'&&quote.term==null)return null;
 if(base==null||!(keep>0))return null;
 const price=Math.round((target+Number(base))/keep);
 if(price<0)return price;
 return config.overviewPrice99?snap99(price):price;
}
const fmt=n=>n==null||!Number.isFinite(n)?'—':Math.round(n).toLocaleString('zh-CN');

export function openBatchProfitPrice({openDialog,esc,toast,settings,scopes,loadAll,apply}){
 const readyScopes=loadAll?scopes.filter(s=>s.key!=='all'):scopes;
 const defaultScope=(readyScopes.find(s=>s.count&&s.preferred)||readyScopes.find(s=>s.count))?.key;
 openDialog('批量按利润定价',`<p class="hint">按目标利润反推到手价，一次应用到所选范围。口径同配置总表：核算利润扣分期费，ERP 利润不扣分期。应用后可按 Ctrl+Z 或「撤销」恢复。</p>
 <div class="bpp-form">
  <fieldset><legend>范围</legend>${scopes.map(s=>`<label><input type="radio" name="bpp-scope" value="${s.key}" ${s.key===defaultScope?'checked':''} ${s.count?'':'disabled'}> ${esc(s.label)}（${s.links} 个链接 · ${s.count} 套）</label>`).join('')}</fieldset>
  <fieldset><legend>按哪个利润</legend><label><input type="radio" name="bpp-kind" value="tax" checked> 核算利润</label><label><input type="radio" name="bpp-kind" value="erp"> ERP 利润</label></fieldset>
  <label class="field">目标利润（元，可为负数）<input id="bpp-target" inputmode="decimal" autocomplete="off" placeholder="例如 100 或 -500"></label>
  <label class="field">分期<select id="bpp-installment"><option value="keep">保持各链接现状</option><option value="on">整链开启分期（到手价 × 10%）</option><option value="off">整链关闭分期</option></select></label>
  <label class="field">到手价 99 结尾<select id="bpp-99"><option value="keep">保持各链接现状</option><option value="on">整链取 99</option><option value="off">整链不取 99</option></select></label>
 </div>
 <p class="hint">分期与取 99 属于整条链接的设置。同链接未勾选配置会同步开关，开启取 99 也会调整这些配置的尾数，预览会一并列出。</p><p id="bpp-summary" class="hint" role="status"></p>
 <p id="bpp-progress" class="hint" role="status" hidden></p><button type="button" id="bpp-retry" hidden>重试载入</button>
 <div class="bpp-preview"><table><thead><tr><th>链接</th><th>配置</th><th>现到手价</th><th>新到手价</th><th>变化</th><th>核算利润</th><th>ERP 利润</th></tr></thead><tbody id="bpp-rows"></tbody></table></div>
 <div class="actions" id="bpp-pages" hidden><button type="button" id="bpp-prev">上一页</button><span id="bpp-page"></span><button type="button" id="bpp-next">下一页</button></div>
 <div class="actions"><button id="bpp-apply" class="primary" disabled>应用到所选范围</button></div>`);
 const dialog=document.querySelector('#dialog'),$=s=>dialog.querySelector(s),val=name=>$('input[name="'+name+'"]:checked')?.value;
 const input=$('#bpp-target'),applyButton=$('#bpp-apply'),summary=$('#bpp-summary'),progress=$('#bpp-progress'),retry=$('#bpp-retry');
 const table=$('#bpp-rows'),pages=$('#bpp-pages'),pageSize=100,costs=new WeakMap(),settingsAtOpen=settings();
 const isOpen=()=>dialog.open&&applyButton.isConnected;
 let plan=[],preview=[],page=0,timer,loading=null,loaded=!loadAll,loadError=null,applying=false;
 function drawPage(){
  const count=Math.ceil(preview.length/pageSize);
  table.innerHTML=preview.slice(page*pageSize,(page+1)*pageSize).map(({c,price,after,related})=>{
   const before=c.price==null||c.price===''?null:Number(c.price),delta=before==null?null:price-before;
   return `<tr><td>${esc(c.product||'')}</td><td>${esc(c.name||'')}${related?'（整链设置）':''}</td><td>${fmt(before)}</td><td><strong>${fmt(price)}</strong></td><td class="${delta>0?'bpp-up':delta<0?'bpp-down':''}">${delta>0?'+':''}${fmt(delta)}</td><td>${fmt(after.taxProfit)}</td><td>${fmt(after.erpProfit)}</td></tr>`;
  }).join('');
  pages.hidden=count<=1;
  $('#bpp-page').textContent=`第 ${page+1} / ${count} 页`;
  $('#bpp-prev').disabled=page===0;$('#bpp-next').disabled=page+1>=count;
  table.closest('.bpp-preview').scrollTop=0;
 }
 function build(){
  clearTimeout(timer);
  if(!isOpen()||applying)return;
  const key=val('bpp-scope'),scope=scopes.find(s=>s.key===key),kind=val('bpp-kind');
  const text=input.value.normalize('NFKC').replace(/[,，\s]/g,'').replace(/^[−–]/,'-'),target=Number(text);
  const inst=$('#bpp-installment').value,n99=$('#bpp-99').value;
  const waiting=key==='all'&&!loaded;
  progress.hidden=!waiting;retry.hidden=!waiting||!loadError;
  plan=[];preview=[];page=0;applyButton.disabled=true;
  if(!scope||waiting||text===''||text==='-'||!Number.isFinite(target)){
   summary.textContent=waiting?'':!scope?'请选择定价范围。':'填写有效的目标利润后显示预览。';
   drawPage();return;
  }
  const configs=scope.configs(),related=inst!=='keep'||n99!=='keep'?scope.related?.()||[]:[];
  if([...configs,...related].some(c=>!c)){summary.textContent='配置范围已变化，请重新打开定价弹窗。';drawPage();return;}
  let skipped=0,priceChanges=0;
  function add(c,related=false){
   // 试算只需要定价字段。实际 BOM 成本可用于各次目标及开关试算，不复制配置。
   const trial={price:c.price,pricingRule:c.pricingRule,overviewFeeRate:c.overviewFeeRate,
    installment:inst==='keep'?c.installment:inst==='on'?24:0,overviewPrice99:n99==='keep'?c.overviewPrice99:n99==='on'};
   let base=costs.get(c);
   if(!base){
    const quote=pricing(c,settingsAtOpen);
    base={raw:totals(c,settingsAtOpen,quote),quotes:new Map([[c.installment,quote]])};costs.set(c,base);
   }
   if(!base.quotes.has(trial.installment))base.quotes.set(trial.installment,pricing(trial,settingsAtOpen));
   const quote=base.quotes.get(trial.installment);
   const price=related?(n99==='on'&&c.price!=null&&c.price!==''?snap99(c.price):c.price):targetArrival(trial,base.raw,quote,kind,target);
   if(!related&&(price==null||price<0)){skipped++;return;}
   // 保持模式保留各配置原设定；显式开关对同链接其他配置生效。
   plan.push({id:c.id,installment:trial.installment,price99:trial.overviewPrice99,installmentMode:inst,price99Mode:n99,price});
   const after=overviewTableTotals(trial,base.raw,quote,{price});
   preview.push({c,price,after,related});
   if(Number(c.price)!==price)priceChanges++;
  }
  configs.forEach(c=>add(c));
  if(related.length){
   const planned=new Set(plan.map(p=>p.id)),links=new Set(configs.map(c=>c.productId));
   for(const c of related)if(!planned.has(c.id)&&links.has(c.productId))add(c,true);
  }
  summary.textContent=`将调整 ${plan.length} 套${skipped?`，${skipped} 套成本不完整已跳过目标利润定价`:''}；其中到手价有变化的 ${priceChanges} 套。`;
  applyButton.disabled=!plan.length||!(priceChanges||inst!=='keep'||n99!=='keep');
  drawPage();
 }
 function loadSelectedScope(){
  if(val('bpp-scope')==='all'&&!loaded&&!loading){
   loadError=null;progress.textContent='正在载入本店配置…';
   loading=loadAll({isOpen,progress:(count,total)=>{
    if(isOpen())progress.textContent=`已载入 ${count} / ${total}`;
   }}).then(()=>{loaded=isOpen();},error=>{
    loadError=error;
    if(isOpen())progress.textContent='载入失败：'+error.message;
   }).finally(()=>{loading=null;build();});
  }
  build();
 }
 dialog.querySelectorAll('input[name="bpp-scope"]').forEach(el=>el.onchange=loadSelectedScope);
 dialog.querySelectorAll('input[name="bpp-kind"], #bpp-installment, #bpp-99').forEach(el=>el.onchange=build);
 retry.onclick=loadSelectedScope;
 input.oninput=()=>{clearTimeout(timer);applyButton.disabled=true;timer=setTimeout(build,100);};
 input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();build();if(!applyButton.disabled)applyButton.click();}};
 $('#bpp-prev').onclick=()=>{page--;drawPage();};$('#bpp-next').onclick=()=>{page++;drawPage();};
 applyButton.onclick=async()=>{
  if(applyButton.disabled||applying)return;
  const kind=val('bpp-kind')==='tax'?'核算':'ERP',target=input.value.trim(),count=plan.length;
  applying=true;applyButton.disabled=true;
  try{await apply(plan,`批量按${kind}利润 ${target} 定价`);toast(`已按${kind}利润 ${target} 调整 ${count} 套配置，可撤销`);}
  catch(error){toast(error.message);}
  finally{applying=false;build();}
 };
 build();input.focus();
}
