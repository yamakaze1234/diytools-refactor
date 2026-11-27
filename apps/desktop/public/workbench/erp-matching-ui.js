/** 匹配任务独立于价格表；关闭弹窗可继续后台处理同一份冻结快照。 */
import {matchingStamp} from './erp-matching-model.js';
import {actions,actionCounts,esc,renderMatchRow,updatePrompt} from './erp-matching-view.js';
import {runtimeBannerHtml,bindRuntimeBanner} from './erp-runtime-ui.js';

const phases={previewing:'正在只读预览',preview:'请核对预览',running:'正在匹配',needs_review:'需要只读核验',recovering:'正在只读核验',done:'已完成',failed:'未完成',stopped:'已停止',partial:'部分完成'};
const pageSize=50;
const panelHtml=`<section id="erp-match-panel">
 <header class="erp-controls">${runtimeBannerHtml}<div class="erp-control-row">
 <div class="erp-account"><span id="erp-match-session" role="status">正在读取本机 ERP 状态…</span><button type="button" id="erp-match-switch">连接账号</button><button id="erp-match-disconnect" type="button" hidden>断开</button></div>
 <span id="erp-match-summary"></span><button type="button" id="erp-match-preview">只读预览</button><button type="button" id="erp-match-background" hidden>转到后台运行</button></div>
 <details id="erp-match-login"><summary>连接本机 ERP</summary><form id="erp-match-login-form" autocomplete="off"><label>ERP 账号<input id="erp-match-user" autocomplete="off"></label><label>ERP 密码<input id="erp-match-password" type="password" autocomplete="new-password"></label><button id="erp-match-connect" class="primary">连接 ERP</button></form></details></header>
 <div class="erp-summary"><div id="erp-filters" role="group" aria-label="筛选匹配动作"></div><span id="erp-match-progress"></span></div>
 <div id="erp-match-results" class="erp-match-scroll"><table><colgroup><col style="width:25%"><col style="width:145px"><col></colgroup><thead><tr><th>配置 / SPU / SKU</th><th>动作 / 回执</th><th>差异与目标 BOM</th></tr></thead><tbody></tbody></table></div>
 <div id="erp-match-pager" hidden><button type="button" data-erp-page="prev">上一页</button><span></span><button type="button" data-erp-page="next">下一页</button></div>
 <footer class="erp-footer"><div><span id="erp-match-message" role="status"></span><span id="erp-match-hint"></span></div><div class="erp-footer-actions">
 <button id="erp-match-recover" hidden>只读核验远端结果</button><button id="erp-match-retry" hidden>重新预览未完成项</button><button id="erp-match-close">关闭</button><button class="primary" id="erp-match-execute" disabled>确认执行本次快照 (0)</button></div></footer></section>`;

export function createErpMatchingUi(api){
 let job=null,selected=0,panel=null,timer=null,disposed=false,offset=0,filter='all',revision=0;
 let previewStamp=null,previewIds=[],previewJobId=null,dismissed=null,connected=false,available=true,submitting=false,lastRows=null;
 let panelError='';
 const dismissalKey='diy-erp-matching-dismissed-v1';
 const storage=()=>api.storage===undefined?globalThis.localStorage:api.storage;
 try{dismissed=JSON.parse(storage()?.getItem(dismissalKey)??'null');}catch{}
 // 沿用旧存储键，只按任务编号判断；旧记录中的阶段和进度不会让浮条重新出现。
 function rememberDismissal(value){
  dismissed=value;
  try{if(value)storage()?.setItem(dismissalKey,JSON.stringify(value));else storage()?.removeItem(dismissalKey);}catch{}
 }
 function dismiss(){if(job)rememberDismissal({id:job.id});}

 const details=new Map(),busy=()=>Boolean(job?.active);
 const terminalReceipt=()=>job&&!busy()&&['done','partial','failed','stopped'].includes(job.phase);
 const canRecover=()=>['needs_review','failed','partial','stopped'].includes(job?.phase);
 const floating=document.createElement('aside');
 floating.className='erp-match-floating';floating.hidden=true;floating.setAttribute('aria-label','ERP 后台匹配进度');document.body.append(floating);
 const request=(action,payload={})=>{
  // 主动执行或核验会继续同一任务；新预览则等收到新任务编号再显示。
  if(dismissed&&['match_execute','match_recover'].includes(action)){rememberDismissal(null);update();}
  return api.request({action,payload});
 };
 const partName=id=>api.partName?.(String(id));
 function update(){
  // 已有任务的核验按任务编号进行，取消表格勾选后仍可从工具栏进入。
  const reviewOnly=selected===0&&canRecover();
  api.onLabel?.(busy()?`ERP 匹配中 (${job.finished}/${job.total})`:reviewOnly?'查看 ERP 匹配任务':`ERP 勾选匹配 (${selected})`,!busy()&&selected===0&&!reviewOnly);
  if(job&&dismissed&&job.id!==dismissed.id)rememberDismissal(null);
  floating.hidden=!job||Boolean(dismissed&&dismissed.id===job.id);
  floating.innerHTML=job?`<strong>${esc(phases[job.phase]??job.phase)} ${esc(job.finished??0)}/${esc(job.total??job.items.length)}</strong><button data-erp-task type="button">查看任务</button><button data-erp-dismiss aria-label="关闭匹配提示" type="button">×</button>`:'';
  if(panel?.isConnected)renderJob();
 }
 floating.onclick=event=>{
  if(event.target.closest('[data-erp-dismiss]')){dismiss();update();}
  if(event.target.closest('[data-erp-task]'))void open(false);
 };
 async function refresh(){
  if(disposed)return;
  clearTimeout(timer);
  const token=++revision;
  try{
   const result=await request('match_status',{offset,limit:pageSize,filter});
   if(token===revision&&!disposed){job=result.job;update();}
  }catch(error){if(token===revision&&panel?.isConnected){panelError=api.errorText(error);renderJob();}}
  finally{if(token===revision&&!disposed&&(busy()||panel?.isConnected))timer=setTimeout(refresh,busy()?600:2500);}
 }
 function renderJob(){
  // dialog.close() 先隐藏窗口，close 事件稍后送达。期间保留用户关闭时实际看到的回执编号。
  if(!panel?.closest('dialog[open]'))return;
  const $=selector=>panel.querySelector(selector),counts=actionCounts(job),total=job?.total??job?.items.length??0;
  const actionable=(counts.create??0)+(counts.update??0)+(counts.reuse??0),active=busy()||submitting;
  const blocked=job?.hasConflicts||counts.conflict>0,needsPreview=job?.phase==='preview'&&!previewStamp;
  $('#erp-match-summary').textContent=job?`当前表格已勾选 ${selected} 套 · 本次任务 ${total} 套`:`已勾选 ${selected} 套配置`;
  $('#erp-match-preview').disabled=selected===0||!connected||!available||active||job?.phase==='needs_review';
  $('#erp-match-preview').classList.toggle('primary',!$('#erp-match-preview').disabled);
  $('#erp-match-connect').classList.toggle('primary',!connected);
  $('#erp-match-background').hidden=!busy();
  $('#erp-match-execute').textContent=`确认执行本次快照 (${actionable})`;
  $('#erp-match-execute').disabled=!connected||!available||active||job?.phase!=='preview'||!previewStamp||previewJobId!==job?.id||blocked||actionable===0;
  $('#erp-match-recover').hidden=!canRecover();
  $('#erp-match-retry').hidden=!['failed','partial','stopped'].includes(job?.phase);
  $('#erp-match-recover').disabled=$('#erp-match-retry').disabled=active||!connected||!available;
  const closeButton=$('#erp-match-close');
  closeButton.dataset.receiptId=terminalReceipt()?job.id:'';
  closeButton.textContent=closeButton.dataset.receiptId?'关闭回执':'关闭';
  $('#erp-match-hint').textContent=job?.phase==='preview'?(counts.update?updatePrompt(counts.update):blocked?'请核对异常阻断项后重新预览。':''):'';
  $('#erp-match-message').textContent=panelError||(needsPreview?'请重新只读预览当前配置。':job?.message||phases[job?.phase]||'');
  const filters=['all','create','update','already','conflict',...(counts.reuse||filter==='reuse'?['reuse']:[])];
  const chips=job?filters.map(key=>`<button type="button" data-erp-filter="${key}" aria-pressed="${key===filter}">${actions[key]??'全部'} <b>${key==='all'?total:counts[key]??0}</b></button>`).join(''):'';
  const filterBox=$('#erp-filters');if(filterBox.innerHTML!==chips)filterBox.innerHTML=chips;
  const progress=$('#erp-match-progress');
  if(job?.active){
   progress.innerHTML=`<span>${esc(phases[job.phase])} ${esc(job.finished)} / ${esc(total)}</span><progress aria-label="匹配读取进度" value="${esc(job.finished)}" max="${esc(total||1)}"></progress>`;
  }else progress.textContent=job?.phase==='preview'?'冻结快照 · 预览有效期 30 分钟':'';
  const visible=job?.items??[];
  const markup=visible.map(row=>{
   const full=details.get(job.id+':'+row.configId);
   const item=full?{...row,expected:full.expected,diff:full.diff,componentNames:full.componentNames}:row;
   return renderMatchRow(item,id=>item.componentNames?.[id]||partName(id),Boolean(full));
  }).join('')||`<tr><td colspan="3" class="erp-empty">${job?'此筛选下暂无配置':'勾选已保存的配置后，点击只读预览。'}</td></tr>`;
  // 状态轮询保留已展开的配件列表与内部滚动位置。
  if(markup!==lastRows){
   const body=$('#erp-match-results tbody'),opened=new Set([...body.querySelectorAll('details[open]')].map(el=>el.dataset.bomId));
   body.innerHTML=markup;lastRows=markup;
   for(const fold of body.querySelectorAll('details'))fold.open=opened.has(fold.dataset.bomId);
  }
  const filteredTotal=job?.filteredTotal??total,pager=$('#erp-match-pager');
  pager.hidden=filteredTotal<=pageSize;
  pager.querySelector('span').textContent=`${Math.floor(offset/pageSize)+1} / ${Math.max(1,Math.ceil(filteredTotal/pageSize))} 页`;
  pager.querySelector('[data-erp-page=prev]').disabled=!offset;pager.querySelector('[data-erp-page=next]').disabled=offset+pageSize>=filteredTotal;
 }
 async function stopForLeave(message='后台 ERP 匹配尚未结束。确认停止后续配置、等待当前配置处理完成，再退出或切换账号？'){
  await refresh();if(!busy())return true;
  if(!confirm(message))return false;
  job=(await request('match_stop')).job;update();
  for(let i=0;i<250&&busy();i++){await new Promise(resolve=>setTimeout(resolve,600));await refresh();}
  if(busy())throw Error('当前 ERP 配置尚未结束，请稍后再切换或退出账号。');
  return true;
 }
 async function sessionChange(action,credentials={}){
  if(!await stopForLeave())return;
  const result=await api.request({action,...credentials});
  previewStamp=null;
  return result;
 }
 async function preview(){
  offset=0;filter='all';details.clear();previewStamp=null;previewJobId=null;renderJob();
  const items=await api.snapshots(previewIds.length?previewIds:undefined);
  job=(await request('match_preview',{items,mode:'rematch'})).job;
  previewIds=items.map(item=>item.configId);previewStamp=matchingStamp(items);previewJobId=job.id;
  update();void refresh();
 }
 async function open(fresh=true){
  if(fresh&&!busy()&&job?.phase!=='needs_review'){
   // 浮条已收起时，工具栏可以继续本窗口的原预览。换勾选后须重新预览，执行前仍逐项核对冻结快照。
   const picked=new Set(api.selectedIds());
   const resume=job?.phase==='preview'&&dismissed?.id===job.id&&previewJobId===job.id&&previewStamp&&
    picked.size===previewIds.length&&previewIds.every(id=>picked.has(id));
   if(!resume){previewIds=[];previewStamp=null;}
  }
  offset=0;filter='all';lastRows=null;panelError='';
  api.openDialog('ERP 勾选匹配',panelHtml);
  const own=panel=document.querySelector('#erp-match-panel'),$=selector=>own.querySelector(selector);
  connected=false;available=true;
  function showSession(session){
   if(panel!==own||!own.isConnected)return;
   connected=session.connected===true;
   $('#erp-match-session').dataset.connected=String(connected);
   $('#erp-match-session').textContent=connected?`已连接本机 ERP：${session.user||'当前账号'}`:'未连接本机 ERP';
   $('#erp-match-login').open=!connected;$('#erp-match-disconnect').hidden=!connected;
   $('#erp-match-switch').textContent=connected?'切换账号':'连接账号';
   renderJob();
  }
  async function refreshSession(){
   try{showSession(await api.request({action:'status'}));}
   catch(error){if(panel===own&&own.isConnected){$('#erp-match-session').textContent=api.errorText(error);$('#erp-match-login').open=true;}}
  }
  bindRuntimeBanner(own,refreshSession,ready=>{if(panel===own){available=ready;renderJob();}});
  function safe(fn,lock=false){
   return async event=>{
    event?.preventDefault();if(lock&&submitting)return;
    panelError='';
    if(lock){submitting=true;renderJob();}
    try{await fn(event);}
    catch(error){if(panel===own)panelError=api.errorText(error);}
    finally{if(lock)submitting=false;if(panel===own)renderJob();}
   };
  }
  $('#erp-match-switch').onclick=()=>{const form=$('#erp-match-login');form.open=!form.open;if(form.open)$('#erp-match-user').focus();};
  $('#erp-match-login-form').onsubmit=safe(async()=>{const password=$('#erp-match-password');try{const session=await sessionChange('connect',{username:$('#erp-match-user').value.trim(),password:password.value});if(session)showSession(session);}finally{password.value='';}},true);
  $('#erp-match-disconnect').onclick=safe(async()=>{const session=await sessionChange('disconnect');if(session)showSession(session);},true);
  $('#erp-match-preview').onclick=safe(preview,true);
  $('#erp-match-execute').onclick=safe(async()=>{
   const stamp=previewStamp,task=job;
   if(!stamp||matchingStamp(await api.snapshots(previewIds))!==stamp||stamp!==previewStamp||task?.id!==previewJobId||task.id!==job?.id||task.phase!=='preview'||!own.isConnected)throw Error('配置、草稿或店铺附加已变化，请重新预览。');
   const count=actionCounts(task).update??0;
   if(!confirm(count?updatePrompt(count):'确认按本次冻结快照执行 ERP 套餐匹配？'))return;
   job=(await request('match_execute',{jobId:task.id,previewDigest:task.previewDigest,confirmRematch:true})).job;
   update();void refresh();
  },true);
  $('#erp-match-recover').onclick=safe(async()=>{job=(await request('match_recover',{jobId:job.id})).job;update();void refresh();},true);
  $('#erp-match-retry').onclick=safe(async()=>{previewIds=job.unfinishedIds??job.items.filter(item=>item.state!=='verified').map(item=>item.configId);if(!previewIds.length)throw Error('本批已全部完成。');await preview();},true);
  $('#erp-filters').onclick=safe(async event=>{const button=event.target.closest('[data-erp-filter]');if(button){filter=button.dataset.erpFilter;offset=0;await refresh();}});
  $('#erp-match-pager').onclick=safe(async event=>{const button=event.target.closest('[data-erp-page]');if(button){offset=Math.max(0,offset+(button.dataset.erpPage==='next'?pageSize:-pageSize));await refresh();}});
  $('#erp-match-results').onclick=event=>{
   const button=event.target.closest('[data-erp-detail]');if(!button)return;
   void safe(async()=>{const id=job.id,result=await request('match_detail',{jobId:id,configId:button.dataset.erpDetail});if(panel===own&&job?.id===id){const item=result.job.items[0];details.set(id+':'+item.configId,item);}})(event);
  };
  // 转入后台只关闭弹窗，即使任务恰在此时完成，也保留浮条。
  let backgrounded=false;
  $('#erp-match-background').onclick=()=>{backgrounded=true;api.closeDialog();};
  $('#erp-match-close').onclick=()=>api.closeDialog();
  const dialog=own.closest('dialog');
  dialog.addEventListener('close',function onClose(){
   // 同一个原生弹窗可能已重新打开，此前排队的 close 不应卸载新面板。
   if(panel===own&&dialog.open&&own.isConnected)return;
   dialog.removeEventListener('close',onClose);
   if(panel!==own)return;
   if(!backgrounded&&job&&$('#erp-match-close').dataset.receiptId===job.id)dismiss();
   panel=null;update();
  });
  renderJob();await Promise.all([refreshSession(),refresh()]);
 }
 void refresh();
 return {open,stopForLeave,changeSession:sessionChange,selected(count){selected=count;update();},active:busy,
  async confirmClose(){await refresh();return !busy()||confirm('后台 ERP 匹配尚未结束，关闭将中断任务。未确认步骤会保留回执且不会自动续写。确认关闭？');},
  dispose(){disposed=true;clearTimeout(timer);floating.remove();}};
}
