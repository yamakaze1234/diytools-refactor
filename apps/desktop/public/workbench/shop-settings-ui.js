/** 店铺设置仅整理呈现；券额、服务和分期沿用正式工程现有保存函数。 */
import {bindRuntimeBanner,runtimeBannerHtml} from './erp-runtime-ui.js';
import {defaultErpExtrasForShop,normalizeErpDefaultExtras} from './erp-default-extras.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function shopSettingsHtml({name,settings,serviceText,pricingHtml,erpShopId}){
 return `<section id="shop-settings-panel"><p class="hint">${esc(name)} · 仅对本店生效</p><nav class="shop-settings-tabs" role="tablist" aria-label="店铺设置标签"><button role="tab" data-shop-tab="erp" aria-selected="true">ERP 店铺与固定附加</button><button role="tab" data-shop-tab="base" aria-selected="false">店铺券与服务承诺</button><button role="tab" data-shop-tab="rule" aria-selected="false">运营费率与分期息点</button></nav>
 <section data-shop-panel="erp" role="tabpanel"><div class="shop-erp-identity"><label class="field">ERP 店铺 ID<input id="shop-erp-id" inputmode="numeric" value="${esc(erpShopId)}"></label><label class="field">ERP 店铺名称<input id="shop-erp-name" maxlength="200" value="${esc(settings.erpShopName)}"></label></div><h3>ERP 匹配默认固定附加明细</h3><p class="hint">本店勾选匹配时自动加入；同 GoodID 合并数量。</p>${runtimeBannerHtml}<div id="shop-extra-session" class="erp-session-status" role="status">正在读取本机 ERP 状态…</div><div id="shop-extras-table"></div><button type="button" id="shop-extra-restore">恢复本店默认</button><button id="shop-extra-toggle" type="button" aria-expanded="false">+ 新增配件</button><section id="shop-extra-add" hidden><label class="field">通过 ERP 搜索选件<input id="shop-extra-query" type="search" placeholder="ERP 配件名称或 GoodID"></label><button id="shop-extra-search" type="button">搜索 ERP</button><button id="shop-extra-connect" type="button">连接 ERP</button><div id="shop-extra-login" hidden><label class="field">ERP 账号<input id="shop-extra-user" autocomplete="off"></label><label class="field">ERP 密码<input id="shop-extra-password" type="password" autocomplete="new-password"></label><button class="primary" id="shop-extra-signin" type="button">登录本机 ERP 会话</button></div><div id="shop-extra-results" role="group" aria-label="ERP 配件搜索结果"></div><label class="field">默认数量<input id="shop-extra-qty" type="number" min="1" step="1" value="1"></label><button class="primary" id="shop-extra-add-button" type="button" disabled>添加所选配件</button></section><p id="shop-extra-status" role="status"></p><div class="actions"><button class="primary" id="shop-erp-save">保存 ERP 店铺与固定附加</button></div></section>
 <section data-shop-panel="base" role="tabpanel" hidden><label class="field">店铺优惠券金额<input id="shop-coupon" type="number" min="0" step=".01" value="${esc(settings.coupon)}"></label><p class="hint">售价 = 到手价 + 店铺优惠券。</p><div class="actions"><button class="primary" id="coupon-save">保存店铺优惠券</button></div><hr><label class="field">默认服务承诺<textarea id="shop-service-text" rows="3" maxlength="1000">${esc(serviceText)}</textarea></label><p class="hint">新建空白配置和商品链接时使用。复制配置和导入模板保留原文案。</p><label><input id="shop-service-existing" type="checkbox"> 同时更新本店仍使用旧默认文案的配置</label><div class="actions"><button id="service-reset">填入系统默认文案</button><button class="primary" id="service-save">保存默认服务承诺</button></div></section>
 <section data-shop-panel="rule" role="tabpanel" hidden><h3>全局修改本店运营费率</h3><label class="field">运营费率（%）<input id="shop-overview-fee-rate" type="number" min="0" max="30" step="0.0001" required disabled></label><small id="shop-fee-rate-note" role="status"></small><div class="actions"><button type="button" id="shop-fee-rate-save" class="primary" disabled>应用到本店全部在用配置</button></div><hr><p class="hint">6 / 12 期读取本店设置，24 期固定 10%。</p>${pricingHtml}<div class="actions"><button class="primary" id="shop-price-save">保存分期息点</button></div></section></section>`;
}
export function bindShopSettings(root,{shopId,extras=[],search,connect,sessionStatus,errorText=error=>error.message}){
 let rows=normalizeErpDefaultExtras(extras),selected=null,generation=0;
 const $=selector=>root.querySelector(selector),status=$('#shop-extra-status');
 root.querySelectorAll('[data-shop-tab]').forEach(button=>button.onclick=()=>{
  root.querySelectorAll('[data-shop-tab]').forEach(tab=>tab.setAttribute('aria-selected',String(tab===button)));
  root.querySelectorAll('[data-shop-panel]').forEach(panel=>panel.hidden=panel.dataset.shopPanel!==button.dataset.shopTab);
 });
 function draw(){
  $('#shop-extras-table').innerHTML=`<table class="shop-extras-table"><thead><tr><th>序</th><th>ERP 配件名称</th><th>GoodID</th><th>默认数量</th><th>操作</th></tr></thead><tbody>${rows.map((row,i)=>`<tr><td>${i+1}</td><td>${esc(row.name)}</td><td>${esc(row.goodsId)}</td><td><input type="number" min="1" step="1" data-extra-qty="${i}" aria-label="${esc(row.name)}默认数量" value="${row.qty}"></td><td><button type="button" data-extra-remove="${i}">移除</button></td></tr>`).join('')||'<tr><td colspan="5">尚未配置固定附加</td></tr>'}</tbody></table>`;
  root.querySelectorAll('[data-extra-remove]').forEach(button=>button.onclick=()=>{try{rows=read();rows.splice(Number(button.dataset.extraRemove),1);draw();}catch(error){status.textContent=errorText(error);}});
 }
 // 仅向本机 worker 查询内存会话，页面只显示账号名。
 function showSession(session){
  const badge=$('#shop-extra-session'),connected=session?.connected===true;
  badge.textContent=connected?`已连接本机 ERP：${session.user||'当前账号'}（仅留本机内存）`:'未连接本机 ERP';
  badge.dataset.connected=String(connected);
  $('#shop-extra-connect').hidden=connected;
  $('#shop-extra-search').disabled=!connected;
  if(connected)$('#shop-extra-login').hidden=true;
 }
 let sessionRevision=0;
 async function refreshSession(){
  const revision=++sessionRevision;
  try{
   const session=await sessionStatus();
   if(root.isConnected&&revision===sessionRevision)showSession(session);
  }catch(error){
   if(root.isConnected&&revision===sessionRevision)$('#shop-extra-session').textContent=errorText(error);
  }
 }
 // 恢复只修改当前表单，点击保存后才替换本店设置。
 $('#shop-extra-restore').onclick=()=>{rows=defaultErpExtrasForShop(shopId);draw();status.textContent='已填入本店默认明细，保存后生效。';};
 bindRuntimeBanner(root,refreshSession);
 void refreshSession();
 $('#shop-extra-toggle').onclick=()=>{
  const panel=$('#shop-extra-add'),button=$('#shop-extra-toggle');
  panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));
  button.textContent=panel.hidden?'+ 新增配件':'收起新增区';
  if(!panel.hidden){void refreshSession();$('#shop-extra-query').focus();}
 };
 $('#shop-extra-connect').onclick=()=>{$('#shop-extra-login').hidden=!$('#shop-extra-login').hidden;};
 // 输入法确认候选词时保留原生回车；快捷操作复用按钮的可用状态。
 for(const [input,action] of [['#shop-extra-query','#shop-extra-search'],['#shop-extra-user','#shop-extra-signin'],['#shop-extra-password','#shop-extra-signin']]){
  $(input).onkeydown=event=>{
   if(event.key!=='Enter'||event.isComposing)return;
   event.preventDefault();
   if(!event.repeat&&!$(action).disabled)$(action).click();
  };
 }
 $('#shop-extra-signin').onclick=async()=>{
  const password=$('#shop-extra-password'),button=$('#shop-extra-signin');
  button.disabled=true;
  try{
   const session=await connect({username:$('#shop-extra-user').value.trim(),password:password.value});
   if(root.isConnected&&session){sessionRevision++;showSession(session);status.textContent='ERP 已连接，可搜索配件。';}
  }catch(error){if(root.isConnected)status.textContent=errorText(error);}
  finally{password.value='';button.disabled=false;}
 };
 function clearSelection(){
  selected=null;$('#shop-extra-add-button').disabled=true;$('#shop-extra-results').replaceChildren();
 }
 $('#shop-extra-query').oninput=()=>{generation++;clearSelection();};
 $('#shop-extra-search').onclick=async()=>{
  const token=++generation;status.textContent='正在查询 ERP…';clearSelection();
  try{
   const response=await search($('#shop-extra-query').value.trim());
   if(!root.isConnected||generation!==token)return;
   const found=normalizeErpDefaultExtras((response.rows??[]).map(row=>({...row,qty:1})));
   $('#shop-extra-results').innerHTML=found.map((row,i)=>`<button type="button" data-extra-pick="${i}" aria-pressed="false"><strong>${esc(row.name)}</strong><span>GoodID ${esc(row.goodsId)}</span></button>`).join('');
   root.querySelectorAll('[data-extra-pick]').forEach(button=>button.onclick=()=>{
    selected=found[Number(button.dataset.extraPick)];$('#shop-extra-add-button').disabled=false;
    root.querySelectorAll('[data-extra-pick]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
   });
   status.textContent=found.length?'选择配件并填写数量。':'未找到配件。';
  }catch(error){if(root.isConnected&&generation===token)status.textContent=errorText(error);}
 };
 $('#shop-extra-add-button').onclick=()=>{
  if(!selected)return;
  try{
   const qty=Number($('#shop-extra-qty').value);
   rows=normalizeErpDefaultExtras([...read(),{...selected,qty}]);draw();
   status.textContent=`已添加「${selected.name}」× ${qty}，列表共 ${rows.find(row=>row.goodsId===selected.goodsId).qty} 件。保存后生效。`;
   generation++;clearSelection();
   $('#shop-extra-qty').value='1';$('#shop-extra-query').value='';$('#shop-extra-query').focus();
  }catch(error){status.textContent=errorText(error);}
 };
 function read(){return normalizeErpDefaultExtras(rows.map((row,i)=>({...row,qty:Number(root.querySelector(`[data-extra-qty="${i}"]`).value)})));}
 draw();return {read};
}
