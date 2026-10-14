/** 数据与同步弹窗：展示成员状态、同步进度、冲突处理、本机缓存和历史入口。 */
import {bindVersionHistory} from './version-history-ui.js';
import {bindLegacyHistory} from './legacy-history-ui.js';
import {createCloudController} from './cloud-controller.js';
import {createCloudWorker} from './cloud-worker-client.js';

/** 安装登录后同步调度和手动操作入口，将远端回读交给宿主 receive。 */
export async function bindWorkspaceSync({flush,receive,openDialog,esc,toast,onMember}){
 const $=selector=>document.querySelector(selector),button=$('#workspace-sync'),label=$('#workspace-sync-status'),operator=$('#operator-open');
 const history=bindVersionHistory({flush,receive,openDialog,esc,toast,runMutation}),legacy=bindLegacyHistory({flush,receive,openDialog,esc,toast,runMutation});
 let available=true,phase='',timer,maintenanceTimer,lastSyncedAt=null,wasRunning=false,leaving=false,cleaning=false;
 const blocked=()=>Boolean(window.parent.workbenchClosePending||window.parent.workbenchUpdatePending);
 const localOnly=view=>view.configured===false||view.session.configured===false;
 const conflictCount=view=>Number(view.checkpoint.conflicts||view.summary?.conflicts||0);
 const pendingText=view=>typeof view.summary?.pending==='number'?`${view.summary.pending} 项`:view.checkpoint.localChangesPending?'有本机修改等待同步':'正在检查';
 const recentText=view=>{const value=view.checkpoint.lastSyncedAt||view.summary?.lastSyncedAt||lastSyncedAt;if(!value)return'尚未同步';const date=new Date(value);return Number.isNaN(date.getTime())?'尚未同步':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 function showError(error){const text=error?.message||String(error);toast(text);const node=$('#cloud-message');if(node)node.textContent=text;}
 function render(view){
  if(wasRunning&&!view.running&&view.summary&&!view.error)lastSyncedAt=new Date().toISOString();wasRunning=view.running;
  const member=view.session.member;
  button.textContent='数据与同步';
  label.textContent=!available||localOnly(view)?'本机保存':view.running?(phase||'同步中…'):view.error?'同步未完成':!view.session.authenticated?'登录已失效':conflictCount(view)?'有同步冲突':!view.checkpoint.initialized?'正在准备同步':view.automatic?'自动同步已开启':'自动同步已暂停';
  label.title=localOnly(view)?'云同步未配置，配置保存在本机':view.error||'配置先保存在本机；登录后自动同步';
  operator.textContent=member?.name||(localOnly(view)?'本机工作台':'请登录');operator.title='成员与同步';onMember?.(member?{...member,name:member.name||'成员'}:null);
  const message=$('#cloud-message');if(message)message.textContent=localOnly(view)?'':view.error||(view.running?(phase||'正在同步，请稍候…'):!view.session.authenticated?'登录已失效，当前输入仍保留。':'' );
  const pending=$('#cloud-pending');if(pending)pending.textContent=pendingText(view);
  const recent=$('#cloud-recent');if(recent)recent.textContent=recentText(view);
  for(const node of document.querySelectorAll('[data-cloud-idle]'))node.disabled=view.running||leaving||cleaning;
  const pause=$('#cloud-pause');if(pause){pause.textContent=view.automatic?'暂停同步':'继续同步';pause.disabled=leaving;}
  const conflicts=$('#cloud-conflicts');if(conflicts)conflicts.hidden=!conflictCount(view);
  const logout=$('#cloud-logout');if(logout)logout.disabled=leaving;
 }
 const controller=createCloudController({flush,receive,isBlocked:()=>blocked()||cleaning,onChange:render,makeEngine:createCloudWorker,onProgress:progress=>{
  // 只展示服务端已确认的数量和当前批次，未知总量时不拼凑百分比。
  const count=Math.max(0,Number(progress.count)||0),completed=Math.max(0,Number(progress.completed)||0);
  phase=progress.phase==='upload'?`正在上传修改：本批 ${count} 项，已处理 ${completed} 项…`
   :progress.phase==='assets-upload'?`正在检查并上传原图：本批 ${count} 张…`
   :progress.phase==='assets-download'?`正在接收原图：本批 ${count} 张…`
   :progress.phase==='download'?'正在接收配置更新…'
   :progress.phase==='checkpoint'?'正在保存同步结果…'
   :progress.phase==='assets'?'正在同步图片…':'正在同步…';
  render(controller.status());
 }});
 const guard=fn=>async()=>{try{if(cleaning)throw Error('请等待缓存清理完成');if(blocked())throw Error('请等待保存、退出或更新完成后再操作。');await fn();}catch(error){showError(error);}};
 // 只读历史和预览不等待同步；只有本机写操作持有互斥，防止恢复与云回读交错。
 async function runMutation(operation){
  if(blocked()||leaving)throw Error('请等待当前保存、退出或更新完成后再操作。');
  if(controller.status().running)throw Error('同步正在后台进行，可继续查看；恢复或清理请等待同步完成后重试。');
  if(cleaning)throw Error('请等待当前本机维护操作完成');
  cleaning=true;render(controller.status());
  try{
   // 设置互斥后再次确认，防止状态通知中的同步入口抢先启动。
   if(controller.status().running)throw Error('同步已开始，请等待本轮同步完成后重试。');
   return await operation();
  }finally{cleaning=false;render(controller.status());}
 }
 // 关闭仅收起弹窗；同步保留后台执行，顶部仍显示进度。
 const close=()=>$('#dialog').close();
 async function leave(){
  if(leaving)return;
  leaving=true;render(controller.status());
  try{
   // Session expiration alone never detaches an editor. Stop/save must complete.
   await controller.stop();
   if(blocked())throw Error('请等待保存、退出或更新完成后再操作。');
   if(window.workbenchSourceEditor?.hasPending())await window.workbenchSourceEditor.save();
   await flush();
   if(blocked())throw Error('请等待保存、退出或更新完成后再操作。');
   await controller.logout();
   window.parent.postMessage({type:'workbench-signed-out'},location.origin);
  }finally{leaving=false;render(controller.status());}
 }
 const kindLabels={configuration:'配置',component:'成本',source:'输出源',template:'模板',settings:'店铺设置',gallery:'图片'};
 async function showConflicts(){
  const {rows,total}=await controller.conflicts();
  openDialog('处理同步冲突',`<p>同一项内容被两端修改时，选择需要保留的版本。</p><p id="cloud-message" class="error"></p>${rows.slice(0,100).map((row,i)=>`<details><summary>${esc(row.draft?.name||kindLabels[row.type]||'待确认内容')}</summary><pre>${esc(JSON.stringify({本机:row.draft,云端:row.conflict.remote.data},null,2))}</pre><div class="actions"><button data-choice="local" data-row="${i}">保留本机版本</button><button data-choice="remote" data-row="${i}">采用云端版本</button></div></details>`).join('')||'<p>没有待处理冲突。</p>'}${total>100?'<p>先显示前 100 项，处理后继续。</p>':''}<div class="actions"><button id="cloud-back">返回</button></div>`);
  for(const node of document.querySelectorAll('[data-choice]'))node.onclick=guard(async()=>{const row=rows[Number(node.dataset.row)];node.disabled=true;await controller.resolve(row.type,row.id,node.dataset.choice);await showConflicts();});
  $('#cloud-back').onclick=guard(open);
 }
 const cacheRequest=async(action='preview')=>{
  const response=await fetch('/api/cache/'+action,action!=='preview'?{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}:{});
  const value=await response.json();if(!response.ok)throw Error(value.error||'缓存操作失败');return value;
 };
 const cacheSize=bytes=>`${(Number(bytes||0)/1024/1024).toFixed(2)} MiB`;
 const cacheResultText=result=>`已清理 ${Number(result.cleared.images?.count||0)} 张旧生成图（${cacheSize(result.cleared.images?.bytes)}）；${Number(result.cleared.index?.count??result.cleared.count)} 套配置索引已清理，需要时重建。`;
 async function maintainCache(){
  if(!available||cleaning||blocked()||leaving||controller.status().running||window.workbenchSourceEditor?.hasPending())return;
  cleaning=true;
  try{await flush();if(blocked()||leaving||controller.status().running)return;const result=await cacheRequest('maintain');if(!result.skipped&&result.cleared?.count)toast(cacheResultText(result));}
  catch(error){showError(error);}
  finally{cleaning=false;render(controller.status());}
 }
 async function openCache(){
  // 缓存统计只读取已保存数据，不触发保存，也不抢占正在运行的同步。
  openDialog('清理本机缓存','<p id="cache-message" role="status">正在检查本机缓存…</p><div class="actions"><button id="cache-back">返回数据与同步</button></div>');
  $('#cache-back').onclick=guard(open);
  const marker=$('#cache-message');
  let plan;try{plan=await cacheRequest();}catch(error){if($('#cache-message')===marker)marker.textContent=error.message;return;}
  if($('#cache-message')!==marker||!$('#dialog')?.open)return;
  openDialog('清理本机缓存',`<p>每 3 天自动清理一次；关闭期间到期，下次启动后补做。</p>${(plan.categories||[]).map(c=>`<p>${esc(c.label)}：${Number(c.count||0)} 项，约 ${cacheSize(c.bytes)}。</p>`).join('')}<p>过期且无引用的旧生成图会直接删除；每套配置各版式的最新生成图、配置、历史记录、恢复草稿和原图均保留。</p><p class="hint">配置索引需要时重建，空间供数据库复用，数据库文件不会立即缩小。</p><p>下次自动清理：${plan.nextCleanupAt?esc(new Date(plan.nextCleanupAt).toLocaleString('zh-CN')):'首次运行后开始计时'}</p><p id="cache-message" role="status"></p><div class="actions"><button id="cache-clear" class="primary" ${plan.count?'':'disabled'}>清理缓存</button><button id="cache-back">返回数据与同步</button></div>`);
  $('#cache-back').onclick=guard(open);
  const clearButton=$('#cache-clear'),message=$('#cache-message');
  clearButton.onclick=async()=>{
   if(cleaning)return;
   try{
    if(blocked()||controller.status().running||leaving)throw Error('请等待当前保存、同步或退出操作完成');
    cleaning=true;clearButton.disabled=true;
    await flush();
    if(blocked()||controller.status().running||leaving)throw Error('请等待当前同步或退出操作完成');
    const result=await cacheRequest('clear');
    if($('#cache-message')===message)message.textContent=cacheResultText(result);
    toast('本机缓存已清理');
   }catch(error){if($('#cache-message')===message){message.textContent=error.message;clearButton.disabled=false;}else toast(error.message);}
   finally{cleaning=false;}
  };
 }
 async function open(){
  // 先显示已知状态，避免打开面板也排队等待上传或一次额外的保存。
  const view=controller.status(),member=view.session.member;
  openDialog('数据与同步',`<p>配置先保存在本机，登录后每 2 小时自动同步；本机缓存每 3 天自动清理。</p>${localOnly(view)?'<p>云同步未配置，当前使用本机保存。</p>':!available?'<p>请在 Windows 工作台中使用同步。</p>':!view.session.authenticated?'<p>登录已失效，当前输入仍保留。</p><button id="cloud-logout" class="primary">保存并重新登录</button>':`<p>成员：${esc(member?.name||'成员')}</p><p>最近同步：<span id="cloud-recent"></span></p><p>待同步：<span id="cloud-pending"></span></p><div class="actions"><button id="cloud-sync-now" class="primary" data-cloud-idle>立即同步</button><button id="cloud-pause">${view.automatic?'暂停同步':'继续同步'}</button><button id="cloud-conflicts" data-cloud-idle ${conflictCount(view)?'':'hidden'}>处理冲突</button><button id="cloud-logout">退出登录</button></div>`}<p id="cloud-message" class="error" role="status"></p><p class="hint">同步在后台进行，可关闭此窗口继续编辑，也可查看历史和缓存；还原、清理需等本轮同步完成。</p><div class="actions"><button id="local-cache">清理本机缓存</button><button id="offline-history">本机历史版本</button><button id="offline-restore">还原配置</button><button id="offline-legacy-history">旧版历史归档</button><button id="cloud-close">关闭</button></div>`);
  $('#local-cache').onclick=guard(openCache);$('#offline-history').onclick=history.open;$('#offline-restore').onclick=history.restore;$('#offline-legacy-history').onclick=legacy.open;$('#cloud-close').onclick=close;
  if($('#cloud-logout'))$('#cloud-logout').onclick=guard(leave);
  if($('#cloud-sync-now'))$('#cloud-sync-now').onclick=guard(async()=>{await controller.run(true);toast('本轮同步完成');});
  if($('#cloud-conflicts'))$('#cloud-conflicts').onclick=guard(showConflicts);
  if($('#cloud-pause'))$('#cloud-pause').onclick=guard(async()=>{if(controller.status().automatic)await controller.stop();else await controller.run(true);});
  render(view);
  if(available&&!view.running)void controller.refresh().catch(showError);
 }
 button.onclick=guard(open);operator.onclick=guard(open);
 try{await controller.refresh();}catch{available=false;render(controller.status());}
 if(available){
  // 本机模式只维护缓存，不建立云同步定时器或发起首次同步。
  if(!localOnly(controller.status())){
   timer=setInterval(()=>controller.tick().catch(showError),2*60*60*1000);
  // Initialization is in the background; its failure remains visible/retryable.
  Promise.resolve().then(()=>controller.start()).catch(showError).then(maintainCache);
  }else void maintainCache();
  maintenanceTimer=setInterval(maintainCache,60*60*1000);
 }
 $('#dialog').addEventListener('close',()=>{setTimeout(()=>controller.deliver().catch(showError),0);});
 window.workbenchPauseCloud=()=>controller.stop();
 window.addEventListener('unload',()=>{clearInterval(timer);clearInterval(maintenanceTimer);controller.pause();},{once:true});
 return {status:()=>controller.status(),open:guard(open)};
}
