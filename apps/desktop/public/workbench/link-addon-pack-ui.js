import {addonPackCopy,addonPackLine,addonPackValidationIssue,addonPartSlot,addonPartsCopy,assessAddonPack} from './link-addon-packs.js';
import {sameNasDocument} from './nas-main-workspace.js';
import {moneyCents} from './pricing.js';
import {destroyProductSearch,mountProductSearch} from './product-search.js';

const blank=(productId,mode='parts',id=crypto.randomUUID())=>({id,productId,name:'',mode,priceCents:null,copyMode:mode==='text'?'custom':'preset',preset:'parts',customCopy:'',presetEdits:{},rules:[]});
// 金额仍按分计算和保存，这里只将页面金额四舍五入到元。
const integerYuan=value=>Math.sign(value)*Math.round(Math.abs(value)/100);
const yuanFormat=new Intl.NumberFormat('zh-CN');
function price(value,signed=false){
 if(value==null)return '待核算';
 const amount=integerYuan(value),prefix=amount<0?'−':signed&&amount>0?'+':'';
 return prefix+'¥'+yuanFormat.format(Math.abs(amount));
}
const tone=value=>{
 const amount=integerYuan(value);
 return amount>0?'positive':amount<0?'negative':'';
};
const options=(rows,value,esc)=>rows.map(([id,label])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
const packProfitText=(amount,value)=>amount==null?'待定价':price(value,true);
const profit=(amount,value)=>`<strong data-profit-tone="${tone(value)}">${packProfitText(amount,value)}</strong>`;
const signed=value=>price(value,true);
const currentConfigCopy='';
function partDetails(result,esc,amount){
 const part=row=>`<div class="pack-part"><strong>${esc(row.part.name)}</strong><small class="pack-tags">商品 ID ${esc(row.part.goodsId)}　数量 ×${row.qty}</small><small>核算 ${price(row.tax)}/件 · 小计 ${price(row.taxSubtotal)}</small><small>ERP ${price(row.erp)}/件 · 小计 ${price(row.erpSubtotal)}</small></div>`;
 const table=`<div class="addon-pack-table"><table class="pack-manifest-table" aria-label="加购配件逐项明细"><thead><tr><th>操作</th><th>原实际配件</th><th>加购配件</th><th>单项成本差</th></tr></thead><tbody>${result.lines.map(line=>`<tr>
  <td><span class="pack-operation" data-kind="${line.rule.kind}">${line.originalQty?'替换':'新增'}</span><small>${esc(line.rule.slot||line.target.slot||'配件')}</small>${line.same?'<small>已相同</small>':''}</td>
  <td>${line.oldCosts.map(part).join('')||'—'}${line.oldCosts.length?`<small>实际原件 ${esc(line.oldCosts.map(row=>row.part.slot+' ×'+row.qty).join('、'))}</small>`:''}</td>
  <td>${part(line.newCost)}</td><td class="pack-deltas"><small>核算 <strong>${signed(line.tax)}</strong></small><small>ERP <strong>${signed(line.erp)}</strong></small></td>
 </tr>`).join('')}</tbody></table></div>`;
 if(amount===undefined||result.issue)return table;
 return table+`<dl class="pack-totals">${[['核算成本差',signed(result.tax)],['ERP 成本差',signed(result.erp)],['客户补差',amount===null?'待定价':signed(amount)]].map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

/** 链接加购在工作台内直接编辑，切换配置只改变试算对象。 */
export function mountAddonPackEditor(root,api){
 const {product,configs,esc,inputs,drafts,configCopy}=api;
 const $=id=>root.querySelector('#'+id);
 const sourceRows=[...inputs.sources.values()];
 const originals=[...new Map(configs.flatMap(c=>c.actualParts||[])
  .filter(part=>/^\d{1,20}$/.test(part.goodsId)&&!/^0+$/.test(part.goodsId)).map(part=>[part.goodsId,part])).values()];
 const trial=configs.find(c=>c.id===api.currentId)||configs[0];
 const currentSaved=()=>api.saved().filter(pack=>pack.productId===product.id);
 const savedPlan=id=>currentSaved().find(pack=>pack.id===id)??null;
 const contents=()=>[...new Map([...currentSaved(),...[...drafts.values()].map(row=>row.pack)].filter(pack=>pack.productId===product.id).map(pack=>[pack.id,pack])).values()];
 let draft,base,baseline,lastPartsId,busy=false,disposed=false,notice='',reuseOrigin='';
 const candidate=()=>draft.mode==='parts'?draft:{...draft,priceCents:null,rules:[]};
 const preset=()=>draft.preset;
 const assess=config=>assessAddonPack(config,candidate(),inputs);
 const alive=()=>!disposed&&root.isConnected;
 function write(){
  notice='';
  // 只保留实际修改。输入后恢复原值时同时清掉预览所用的草稿。
  if(sameNasDocument(candidate(),baseline))drafts.delete(draft.id);
  else drafts.set(draft.id,{pack:structuredClone(draft),base});
  api.refresh();
 }
 const stateLabel=()=>drafts.has(draft.id)?'有未保存的修改':currentSaved().some(pack=>pack.id===draft.id)?'已保存':'新方案';
 const destroySearch=()=>root.querySelectorAll('.product-search').forEach(destroyProductSearch);
 function editablePlan(plan){
  const value=structuredClone(plan);
  if(value.mode==='text'&&value.copyMode!=='custom'){
   // 旧版链接文案若使用方案名预设，进入编辑时带入已有显示文字。
   value.customCopy=addonPackCopy(value);
   value.copyMode='custom';
  }
  return value;
 }
 // 旧配置文案和链接方案是两个独立的编辑对象，切换类型不改写原方案。
 function pick(id,newMode='parts'){
  const saved=savedPlan(id),stored=drafts.get(id);
  draft=id===currentConfigCopy?null:editablePlan(stored?.pack??saved??blank(product.id,newMode));
  base=stored?stored.base:saved;
  if(stored&&sameNasDocument(draft,saved&&editablePlan(saved))){
   drafts.delete(id);base=saved;api.refresh();
  }
  baseline=draft?editablePlan(base??blank(product.id,draft.mode,draft.id)):null;
  if(draft?.mode==='parts')lastPartsId=draft.id;
  reuseOrigin='';notice='';
  api.selected(draft?.id??currentConfigCopy);render();
 }
 function render(){
  if(!alive())return;
  destroySearch();
  const structured=draft?.mode==='parts',usePreset=structured&&draft.copyMode==='preset';
  const plans=contents().filter(pack=>pack.mode===(structured?'parts':'text'));
  const planOptions=plans.map(pack=>[pack.id,pack.name||'未命名草稿']);
  if(!structured)planOptions.unshift([currentConfigCopy,'当前配置文案']);
  if(draft&&!plans.some(pack=>pack.id===draft.id))planOptions.push([draft.id,'新方案']);
  const configRows=draft?[]:configCopy.rows();
  if(!draft&&!configRows.length)configRows.push({index:null,text:'',note:''});
  root.innerHTML=`<div class="pack-sheet">
   <section class="pack-section">
    <div class="pack-head"><h2>加购与选配</h2><div class="pack-actions"><span id="pack-status" class="hint" role="status"></span>
     ${draft?'<button id="pack-discard" type="button" hidden>放弃草稿</button>':''}
     <button id="pack-save" class="primary" type="button">${structured?'保存加购包':draft?'保存文案方案':'保存配置文案'}</button></div></div>
    <div class="pack-plan-bar"><label class="field">加购选配方案<select id="pack-select">${options(planOptions,draft?.id??currentConfigCopy,esc)}</select></label>
    <div class="pack-actions"><button id="pack-new" type="button">＋ ${structured?'新建加购包':'新建链接文案'}</button><button id="pack-reuse-open" type="button">${structured?'套用已有加购包':'套用链接文案'}</button></div></div>
    ${reuseOrigin?`<p class="hint pack-origin">${esc(reuseOrigin)}</p>`:''}
    ${draft?`<div class="pack-plan-fields"><label class="field">方案名称<input id="pack-name" maxlength="100" placeholder="输入方案名称" value="${esc(draft.name)}"></label>
     ${structured?`<label class="field">客户补差（元）<input id="pack-price" inputmode="numeric" pattern="[0-9]*" maxlength="12" placeholder="输入整数金额" value="${draft.priceCents===null?'':integerYuan(draft.priceCents)}"></label>`:''}</div>`:''}
   </section>
   ${structured?'<section class="pack-section pack-scope"><h3>按原型号匹配 <span class="hint" id="pack-match-count"></span></h3><p class="hint" id="pack-scope-note"></p></section>':''}
   <section class="pack-section">
    <div class="pack-subhead"><h3>内容类型</h3><div class="pack-actions pack-mode" role="group" aria-label="内容类型">
     <button id="pack-parts-mode" type="button" aria-pressed="${structured}">加购包方案</button><button id="pack-text-mode" type="button" aria-pressed="${!structured}">仅文案</button></div></div>
    ${structured?`<div class="pack-subhead"><h3>加购配件</h3><div class="pack-actions"><button id="pack-add" type="button">＋ 新增配件</button><button id="pack-replace" type="button">＋ 添加替换项</button></div></div>
    <div id="pack-rules"></div><p class="hint pack-rule-note">按原型号商品 ID 汇总所有实际原件。换后总数可跟随原总数，也可单独指定。</p>`:''}
   </section>
   ${structured?`<section class="pack-section pack-manifest" aria-label="加购包清单明细">
    <div class="pack-head"><div><h3>加购包清单明细 <small class="hint" id="pack-manifest-status"></small></h3><p id="pack-manifest-name"></p></div>
     <label class="field pack-trial">试算配置<select id="pack-trial">${options(configs.map(c=>[c.id,c.name]),trial.id,esc)}</select></label></div>
    <div id="pack-details"></div></section>
    <section class="pack-section pack-profit"><div><h3>加购包利润</h3><p id="pack-profit-note" class="hint">客户补差 − 核算成本差</p></div><output id="pack-profit-value"></output></section>`:''}
   <section class="pack-section"><div class="pack-subhead"><h3>配置图文案</h3>${structured?`<div class="pack-actions pack-mode" role="group" aria-label="文案方式">
    <button id="pack-preset-mode" type="button" aria-pressed="${usePreset}">预设</button><button id="pack-custom-mode" type="button" aria-pressed="${!usePreset}">自定义</button></div>`:''}</div>
    ${draft?`<div class="${usePreset?'pack-copy-fields':''}">
     ${usePreset?`<label class="field">选择文案预设<select id="pack-preset">${options([['parts','按配件明细生成'],['name','使用方案名称']],preset(),esc)}</select></label>`:''}
     <div><label class="field">展示文字<textarea id="pack-copy" maxlength="1800" rows="2" placeholder="${usePreset?'选好配件后自动生成，可直接编辑':'输入配置图要展示的文字'}"></textarea></label>
      <div class="pack-copy-tools">${usePreset?'<button id="pack-copy-reset" type="button" hidden>重新生成</button>':structured?'<button id="pack-copy-fill" type="button">用加购配件填入文案</button>':''}</div></div>
    </div>`:`<p class="hint">当前配置 ${esc(trial.name)} · 仅应用到本套</p>
     ${configRows.map(row=>`<div class="pack-config-copy-row" data-config-addon-copy>
      <label class="field">展示文字<textarea data-copy-field="text" rows="4" placeholder="输入配置图要展示的文字"></textarea></label>
      <label class="field">补充说明（可留空）<textarea data-copy-field="note" rows="2"></textarea></label>
      <button type="button" data-copy-remove ${row.index===null?'hidden':''}>移除此条</button></div>`).join('')}
     <button id="pack-add-config-copy" type="button">＋ 添加文案</button>`}
   </section>
  </div>`;
  $('pack-select').onchange=event=>pick(event.currentTarget.value);
  $('pack-new').onclick=()=>{pick(undefined,structured?'parts':'text');$('pack-name').focus();};
  $('pack-reuse-open').onclick=()=>reuse(structured?'parts':'text');
  $('pack-parts-mode').onclick=()=>{
   if(structured)return;
   pick(lastPartsId??contents().find(pack=>pack.mode==='parts')?.id);$('pack-parts-mode').focus();
  };
  $('pack-text-mode').onclick=()=>{
   if(!structured)return;
   pick(currentConfigCopy);$('pack-text-mode').focus();
  };
  if(!draft){mountConfigCopy(configRows);return;}
  $('pack-discard').onclick=()=>{
   const {id,mode}=draft;drafts.delete(id);api.refresh();pick(id,mode);$('pack-name').focus();
  };
  $('pack-name').oninput=event=>{draft.name=event.currentTarget.value;change(true);};
  if(structured){
   for(const [id,value] of [['pack-preset-mode','preset'],['pack-custom-mode','custom']]){
    $(id).onclick=()=>{if(draft.copyMode===value)return;draft.copyMode=value;write();render();$(id).focus();};
   }
   $('pack-price').oninput=event=>{
    const input=event.currentTarget,value=input.value.trim();
    if(input.value!==value)input.value=value;
    draft.priceCents=/^\d+$/.test(value)?moneyCents(value):null;change(false);
   };
   $('pack-trial').onchange=event=>api.activate(event.currentTarget.value);
   for(const [id,kind] of [['pack-replace','replace'],['pack-add','add']])$(id).onclick=()=>{
    draft.rules.push({kind,originalGoodsId:'',slot:'',sourceId:'',targetGoodsId:'',qtyMode:kind==='replace'?'match':'fixed',qty:1});write();render();
    $('pack-rules').lastElementChild.querySelector('input')?.focus();
   };
   draft.rules.forEach(mountRule);
  }
  if($('pack-preset'))$('pack-preset').onchange=event=>{draft.preset=event.currentTarget.value;change(true);};
  $('pack-copy').oninput=event=>{
   if(draft.copyMode==='custom')draft.customCopy=event.currentTarget.value;
   else draft.presetEdits[preset()]=event.currentTarget.value;
   change(false);
  };
  if($('pack-copy-reset'))$('pack-copy-reset').onclick=()=>{delete draft.presetEdits[preset()];change(true);};
  if($('pack-copy-fill'))$('pack-copy-fill').onclick=()=>{draft.customCopy=addonPartsCopy(assess(trial));change(true);$('pack-copy').focus();};
  $('pack-save').onclick=commit;
  draw(true);
 }
 function mountConfigCopy(rows){
  const status=$('pack-status'),save=$('pack-save');
  const update=()=>{
   const dirty=configCopy.isDirty();
   status.textContent=notice||(dirty?'有未保存的修改':'已保存');
   save.disabled=busy||!dirty;
  };
  for(const [i,element] of [...root.querySelectorAll('[data-config-addon-copy]')].entries()){
   let index=rows[i].index;
   const remove=element.querySelector('[data-copy-remove]');
   for(const field of element.querySelectorAll('[data-copy-field]')){
    field.value=rows[i][field.dataset.copyField]??'';
    field.onfocus=configCopy.onBegin;
    field.oninput=()=>{
     index??=configCopy.onAdd();
     configCopy.onEdit(index,field.dataset.copyField,field.value);remove.hidden=false;notice='';update();
    };
   }
   remove.onclick=()=>{configCopy.onBegin();configCopy.onRemove(index);notice='';render();$('pack-add-config-copy').focus();};
  }
  $('pack-add-config-copy').onclick=()=>{
   const empty=root.querySelector('[data-copy-remove][hidden]')?.parentElement;
   if(empty){empty.querySelector('[data-copy-field="text"]').focus();return;}
   configCopy.onBegin();configCopy.onAdd();notice='';render();
   [...root.querySelectorAll('[data-copy-field="text"]')].at(-1)?.focus();
  };
  save.onclick=async()=>{
   busy=true;notice='正在保存…';root.inert=true;update();
   try{await configCopy.onSave();notice='';}
   catch(error){notice=api.errorText(error);}
   finally{busy=false;if(alive()){root.inert=false;update();}}
  };
  update();
 }
 function change(refreshText){write();draw(refreshText);}
 function draw(refreshText){
  const result=assess(trial),structured=draft.mode==='parts';
  const matches=structured?configs.map(config=>config===trial?result:assess(config)).filter(value=>!value.issue):[];
  if(refreshText)$('pack-copy').value=draft.copyMode==='custom'?draft.customCopy:(draft.presetEdits[preset()]??addonPackCopy(candidate(),result));
  if($('pack-copy-reset'))$('pack-copy-reset').hidden=draft.presetEdits[preset()]===undefined;
  if($('pack-copy-fill'))$('pack-copy-fill').disabled=!addonPartsCopy(result);
  const dirty=drafts.has(draft.id);
  const conflict=dirty&&!sameNasDocument(savedPlan(draft.id),base);
  const issue=$('pack-price')?.validity.patternMismatch?'客户补差请填写整数（可填 0）':
   addonPackValidationIssue(candidate())||(structured&&!matches.length?`没有匹配的配置 · ${result.issue}`:'');
  $('pack-status').textContent=notice||(conflict?'这份加购包已被更新。可放弃本机草稿并载入已保存版本。':
   dirty&&issue?issue:drafts.failed(draft.id)?'草稿暂未写入本机，请保存加购包。':stateLabel());
  $('pack-discard').hidden=!dirty;
  const select=$('pack-select');
  select.selectedOptions[0].textContent=draft.name|| (drafts.has(draft.id)?'未命名草稿':'新方案');
  $('pack-save').disabled=busy||!dirty||conflict||Boolean(issue);
  if(!structured)return;
  $('pack-match-count').textContent=`· 当前链接匹配 ${matches.length} / ${configs.length} 套`;
  $('pack-scope-note').textContent=`当前试算 ${trial.name}。方案保存原型号与数量规则，可在本链接重复使用。`;
  $('pack-manifest-name').textContent=draft.name||'未命名方案';
  $('pack-manifest-status').textContent=dirty&&issue?'草稿待补齐':stateLabel();
  $('pack-details').innerHTML=result.lines.length?partDetails(result,esc,draft.priceCents):`<p class="pack-empty">${esc(result.issue||'暂无配件明细')}</p>`;
  if(result.lines.length&&result.issue)$('pack-details').insertAdjacentHTML('beforeend',`<p class="hint pack-rule-note">${esc(result.issue)}</p>`);
  for(const [index,line] of draft.rules.entries()){
   const summary=$('pack-rules').children[index].querySelector('.pack-rule-summary'),row=result.lines[index];
   if(row)summary.innerHTML=`<strong>${esc(trial.name)}试算</strong>　${esc(addonPackLine(row,true))}`;
   else summary.textContent=(line.kind==='replace'&&!line.originalGoodsId?'请选择原型号':!line.targetGoodsId?'请选择加购配件':result.issue);
   const qty=$('pack-rules').children[index].querySelector('output');
   if(qty)qty.textContent=row?'×'+row.qty:'—';
  }
  const profits=matches.map(row=>row.profit).filter(value=>value!==null),lo=profits.length?Math.min(...profits):null,hi=profits.length?Math.max(...profits):null;
  $('pack-profit-value').innerHTML=profit(draft.priceCents,lo)+(integerYuan(hi)!==integerYuan(lo)?' <small>至</small> '+profit(draft.priceCents,hi):'');
  $('pack-profit-note').textContent='客户补差 − 核算成本差'+(profits.length<matches.length&&draft.priceCents!==null?' · 部分待核算':'');
 }
 function mountRule(rule,index){
  const row=document.createElement('div'),replacing=rule.kind==='replace';
  row.className='pack-rule'+(replacing?'':' pack-rule-add');
  row.innerHTML=`${replacing?'<div data-pack-original-picker></div>':''}<div data-pack-source></div>
   ${replacing?`<label class="field">数量规则<select data-pack-qty-mode>${options([['match','跟随原总数'],['fixed','固定总数量']],rule.qtyMode,esc)}</select></label>`:''}
   <label class="field">${replacing?'换后总数':'数量'}${rule.qtyMode==='match'?'<output></output>':`<input data-pack-qty type="number" min="1" max="1000" value="${rule.qty||''}">`}</label>
   <button data-pack-remove type="button" aria-label="移除此项">×</button><p class="pack-rule-summary"></p>`;
  $('pack-rules').append(row);
  const find=selector=>row.querySelector(selector);
  if(replacing){
   picker(find('[data-pack-original-picker]'),{rows:originals,idKey:'goodsId',value:rule.originalGoodsId,label:'原型号 · 全部替换',
    choose:part=>{rule.originalGoodsId=part?.goodsId||'';rule.slot=part?addonPartSlot(part):'';change(true);}});
   find('[data-pack-qty-mode]').onchange=event=>{rule.qtyMode=event.currentTarget.value;write();render();$('pack-rules').children[index].querySelector('[data-pack-qty-mode]').focus();};
  }
  const qty=find('[data-pack-qty]');
  if(qty)qty.oninput=()=>{rule.qty=qty.value?Number(qty.value):null;change(true);};
  find('[data-pack-remove]').onclick=()=>{draft.rules.splice(index,1);write();render();};
  picker(find('[data-pack-source]'),{rows:sourceRows,idKey:'sourceId',value:rule.sourceId,label:replacing?'换后型号':'加购配件',
   choose:part=>{rule.sourceId=part?.sourceId||'';rule.targetGoodsId=part?.goodsId||'';if(!replacing)rule.slot=part?addonPartSlot(part):'';change(true);}});
 }
 function picker(holder,{rows,idKey,value,label,choose}){
  holder.innerHTML=`<label class="field">${label}<input type="search" data-product-query autocomplete="off" placeholder="输入商品名称或 ID" value="${esc(rows.find(part=>part[idKey]===value)?.name)}"></label>`;
  const input=holder.querySelector('input');
  mountProductSearch(holder,{getRows:()=>rows,idKey,selected:value,label,inputElement:input,inlineSelection:true,deferred:true,stableRows:true,
   describe:part=>[part.goodsId,part.erpName,part.erpModel,part.erpSpec].filter(Boolean).join(' · '),onChange:choose});
 }
 async function commit(){
  if($('pack-save').disabled)return;
  const pack=candidate();
  busy=true;notice='正在保存…';root.inert=true;draw(false);
  try{
   await api.save({id:pack.id,productId:product.id,pack},base);
   base=structuredClone(pack);baseline=editablePlan(pack);
   drafts.delete(pack.id);api.refresh();
   if(alive()){notice='已保存';render();$('pack-save').focus();}
  }catch(error){notice=api.errorText(error);}
  finally{busy=false;if(alive()){root.inert=false;draw(false);}}
 }
 function reuse(mode){
  api.openDialog(mode==='parts'?'套用已有加购包':'套用链接文案',`<div class="pack-reuse-fields"><p class="hint">目标链接：${esc(product.name)}</p>
   <label class="field">其他链接的已保存方案<select id="pack-reuse"></select></label>
   <div class="pack-reuse-match" id="pack-reuse-match" role="status"></div>
   <div class="pack-actions"><button id="pack-reuse-cancel" type="button">取消</button><button id="pack-reuse-confirm" class="primary" type="button" disabled>套用为新方案</button></div></div>`);
  const select=document.getElementById('pack-reuse'),confirmButton=document.getElementById('pack-reuse-confirm');
  const reused=api.saved().filter(pack=>pack.productId!==product.id&&pack.mode===mode);
  select.innerHTML=options([['',reused.length?'请选择方案':'没有其他链接的已保存方案'],...reused.map(pack=>[pack.id,api.productName(pack.productId)+' / '+pack.name])],'',esc);
  select.onchange=()=>{
   const from=reused.find(pack=>pack.id===select.value);
   const matches=from?configs.filter(c=>!assessAddonPack(c,{...from,productId:product.id},inputs).issue):[];
   confirmButton.disabled=!matches.length;
   document.getElementById('pack-reuse-match').innerHTML=from?`<strong>目标链接匹配 ${matches.length} / ${configs.length} 套</strong><small>${esc(matches.map(c=>c.name).join('、'))}</small>`:'<small>选择后查看目标链接匹配的配置。</small>';
  };
  select.onchange();
  document.getElementById('pack-reuse-cancel').onclick=api.closeDialog;
  confirmButton.onclick=()=>{
   const from=reused.find(pack=>pack.id===select.value);
   if(!from||confirmButton.disabled||!alive())return;
   draft={...editablePlan(from),id:crypto.randomUUID(),productId:product.id,priceCents:null};
   base=null;baseline=blank(product.id,mode,draft.id);
   if(mode==='parts')lastPartsId=draft.id;
   reuseOrigin='套用自 '+api.productName(from.productId)+' / '+from.name+(mode==='parts'?'。请填写本链接的客户补差。':'。');
   api.selected(draft.id);write();api.closeDialog();render();($('pack-price')??$('pack-name')).focus();
  };
 }
 pick(api.initialId??(configCopy.rows().length?currentConfigCopy:contents()[0]?.id));
 return ()=>{disposed=true;root.inert=false;destroySearch();};
}

/** 福利点使用当前配置的草稿；保存按钮只提交当前配置。 */
export function mountAddonBenefits(root,{config,rows,visible,esc,onBegin,onEdit,onAdd,onRemove,onVisible,onSave,isDirty}){
 const status=()=>root.querySelector('#benefit-status'),save=()=>root.querySelector('#save-benefits');
 const update=()=>{status().textContent=isDirty()?'有未保存的修改':'已保存';save().disabled=!isDirty();};
 root.innerHTML=`<div class="pack-sheet"><section class="pack-section">
  <div class="pack-head"><h2>福利点</h2><div class="pack-actions"><span id="benefit-status" role="status" class="hint"></span><button type="button" class="primary" id="save-benefits">保存福利点</button></div></div>
  <p class="hint">${esc(config.name)} · 编辑本套配置图里的福利点</p>
  <div class="pack-benefit-settings"><label><input type="checkbox" id="benefit-visible" ${visible?'checked':''}>显示在配置图中</label>
   <button type="button" data-add-extra="benefits">＋ 添加福利点</button></div>
  ${rows.length?rows.map(row=>`<div class="pack-benefit-row"><label class="field">福利文案<textarea data-extra-kind="benefits" data-extra-field="text" data-extra-index="${row.index}" rows="2" maxlength="500">${esc(row.text)}</textarea></label>
   <label class="field">补充说明（可留空）<textarea data-extra-kind="benefits" data-extra-field="note" data-extra-index="${row.index}" rows="2" maxlength="500">${esc(row.note)}</textarea></label>
   <button type="button" data-remove-extra="benefits" data-extra-index="${row.index}">移除此条</button></div>`).join(''):'<p class="pack-empty">当前配置暂无福利点。</p>'}
 </section></div>`;
 root.querySelector('#benefit-visible').onchange=event=>{onVisible(event.currentTarget.checked);update();};
 root.querySelector('[data-add-extra]').onclick=onAdd;
 for(const input of root.querySelectorAll('[data-extra-field]')){
  input.onfocus=onBegin;
  input.oninput=()=>{onEdit(Number(input.dataset.extraIndex),input.dataset.extraField,input.value);update();};
 }
 for(const button of root.querySelectorAll('[data-remove-extra]'))button.onclick=()=>onRemove(Number(button.dataset.extraIndex));
 save().onclick=async()=>{
  const button=save();
  button.disabled=true;status().textContent='正在保存…';
  try{await onSave();}finally{if(button.isConnected)update();}
 };
 update();
}

export function openAddonPackMaintenance({openDialog,esc,configs,packs,inputs,edit}){
 openDialog('加购包维护','<div class="actions"><input id="pack-search" type="search" aria-label="搜索加购包、链接或 SPU" placeholder="方案名 / 链接 / SPU"><label><input id="pack-losses" type="checkbox">仅看亏损</label></div><div id="pack-maintenance-list"></div>');
 const $=id=>document.getElementById(id),holder=$('pack-maintenance-list');
 const groups=new Map();
 for(const config of configs){const list=groups.get(config.productId)??[];list.push(config);groups.set(config.productId,list);}
 function draw(){
  const query=$('pack-search').value.trim().toLowerCase(),losses=$('pack-losses').checked;
  const results=packs.flatMap(pack=>{
   const list=groups.get(pack.productId)??[],link=list[0],matches=list.map(c=>({c,result:assessAddonPack(c,pack,inputs)})).filter(row=>!row.result.issue);
   const known=matches.map(row=>row.result.profit).filter(value=>value!=null),min=known.length?Math.min(...known):null;
   if(![pack.name,link?.product,link?.spu].join(' ').toLowerCase().includes(query)||losses&&!(min<0))return [];
   const name=link?.product||'链接已无在用配置';
   return [`<details class="list-card addon-pack-maintenance"><summary><strong>${esc(pack.name)}</strong> · ${esc(name)} · SPU ${esc(link?.spu||'未填写')} · 命中 ${matches.length} 套
    ${pack.mode==='parts'?` · 最低利润 <strong data-profit-tone="${tone(min)}">${esc(packProfitText(pack.priceCents,min))}</strong>`:''}</summary>
    ${link?`<button data-pack-edit="${esc(pack.id)}" type="button">编辑此方案</button>`:''}
    ${matches.map(({c,result})=>pack.mode==='parts'?`<details class="addon-pack-match"><summary>${esc(c.name)} · 核算差 ${price(result.tax)} · ERP 差 ${price(result.erp)} · 客户补差 ${price(pack.priceCents)} · 利润 ${profit(pack.priceCents,result.profit)}</summary>${partDetails(result,esc)}</details>`:`<div class="addon-pack-match">${esc(c.name)}</div>`).join('')}</details>`];
  });
  holder.innerHTML=results.join('')||'<p class="hint">没有匹配的加购包。</p>';
  for(const button of holder.querySelectorAll('[data-pack-edit]'))button.onclick=()=>edit(packs.find(pack=>pack.id===button.dataset.packEdit));
 }
 $('pack-search').oninput=draw;$('pack-losses').onchange=draw;draw();
}
