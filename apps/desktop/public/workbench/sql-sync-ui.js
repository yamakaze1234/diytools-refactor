/** 公司 SQL 只读同步界面：管理本机连接资料、生成更新预览，并在确认后应用。 */
const esc=value=>String(value??'未知').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Adapted from the original SQL dialog. Passwords live only in this dialog/request.
/** 绑定连接、预览与确认入口；业务更新通过受控本机接口执行。 */
export function bindSqlSync(api){
 const dialog=document.querySelector('#dialog');let generation=0,applying=false,retained=null,reading=false,readError='';
 const context=()=>api.context?.();
 const unchanged=stamp=>stamp===context()&&!api.hasPending?.();
 const request=api.sqlRequest|| (async(path,data)=>{const response=await fetch('/api/sql-sync/'+path,data===undefined?{signal:AbortSignal.timeout(15000)}:{...(path==='preview'?{signal:AbortSignal.timeout(90000)}:{}),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw Error(result.error||'数据库服务不可用');return result;});
 const lockClose=locked=>{applying=locked;const close=dialog.querySelector('.dialog-title .close');if(close)close.disabled=locked;};
 dialog.addEventListener('cancel',event=>{if(applying)event.preventDefault();});
 dialog.addEventListener('close',()=>{generation++;const input=dialog.querySelector('#sql-password');if(input)input.value='';lockClose(false);});
 function setup(){
  if(applying)return;
  // 查询及预览属于工作台会话，关闭共享弹窗只释放界面，不丢弃查询结果。
  if(retained){showPreview(retained.plan,retained.stamp);return;}
  if(reading){api.openDialog('ERP同步 · 后台读取', '<p id="sql-read-wait" role="status">正在后台读取公司 SQL，关闭后仍会保留预览结果。稍后重新打开即可继续。</p>');return;}
  const token=++generation;let busy=false,formEdited=false,savedSettings=null,settings={server:'',port:1433,database:'',user:'',encrypt:true,trustServerCertificate:false};
  api.openDialog('ERP同步 · 公司数据库',`<p class="hint">只读公司大库，先预览差异，再更新${api.sharedCosts?'三店工作区':api.nas?'英特尔工作区':'本机'} ERP 成本与可销数。</p><form id="sql-connection-form"><details id="sql-connection-details" open><summary>连接设置</summary><div class="form-grid">${[['server','服务器'],['port','端口'],['database','数据库'],['user','只读账号']].map(([key,label])=>`<label class="field">${label}<input id="sql-${key}" name="${key}" value="${esc(settings[key])}" required ${key==='port'?'type="number" min="1" max="65535"':'autocomplete="off"'}></label>`).join('')}<label class="field">密码<input id="sql-password" type="password" autocomplete="off" required></label></div><label><input id="sql-encrypt" type="checkbox" checked> 加密连接</label> <label><input id="sql-trust" type="checkbox"> 信任服务器证书（公司自签证书时使用）</label><label style="display:block;margin-top:10px"><input id="sql-remember" type="checkbox" checked> 在本机加密保存${api.nas?'连接':'并自动填入'}</label><button id="sql-forget" type="button">清除本机保存的连接</button>${api.nas?'<button type="button" id="sql-use-saved">选用原工作台保存的连接…</button>':''}</details><p id="sql-message" role="status" class="hint"></p><div class="actions"><button type="button" id="sql-cancel">取消</button><button type="submit" class="primary" id="sql-read" disabled>读取并预览</button></div></form>`);
  const form=document.querySelector('#sql-connection-form'),message=form.querySelector('#sql-message');if(readError)message.textContent=readError;
  const live=()=>token===generation&&dialog.open&&form.isConnected;
  const lock=locked=>{busy=locked;form.querySelectorAll('input,button').forEach(input=>{if(input.id!=='sql-cancel')input.disabled=locked;});};
  const fields=['server','port','database','user'];
  const checkSettings=()=>({...Object.fromEntries(fields.map(k=>[k,form.querySelector('#sql-'+k).value])),encrypt:form.querySelector('#sql-encrypt').checked,trustServerCertificate:form.querySelector('#sql-trust').checked});
  const reuse=()=>api.nas&&savedSettings&&Object.entries(checkSettings()).every(([key,value])=>String(value)===String(savedSettings[key]));
  form.addEventListener('input',()=>{formEdited=true;if(api.nas)form.querySelector('#sql-password').required=!reuse();});
  request('credentials').then(saved=>{if(!live()||formEdited||busy)return;if(saved.saved){settings=saved.settings;for(const key of ['server','port','database','user'])form.querySelector('#sql-'+key).value=settings[key];form.querySelector('#sql-encrypt').checked=settings.encrypt;form.querySelector('#sql-trust').checked=settings.trustServerCertificate;if(api.nas){savedSettings=settings;form.querySelector('#sql-password').required=false;message.textContent='已保存本机加密连接；留空密码即可直接读取。';}else{form.querySelector('#sql-password').value=saved.password||'';message.textContent='已从本机加密存储填入连接信息';}const details=form.querySelector('#sql-connection-details');if(api.inline&&details)details.open=false;}}).catch(error=>{if(live())message.textContent=error.message;}).finally(()=>{if(live()&&!busy)form.querySelector('#sql-read').disabled=false;});
  form.querySelector('#sql-forget').onclick=async()=>{if(busy||api.canStart?.()===false)return;formEdited=true;api.busy?.(true);lock(true);try{await request('credentials/clear',{});if(!live())return;for(const key of ['server','database','user','password'])form.querySelector('#sql-'+key).value='';form.querySelector('#sql-remember').checked=false;if(api.nas){savedSettings=null;form.querySelector('#sql-password').required=true;}message.textContent='已清除本机保存的连接';const details=form.querySelector('#sql-connection-details');if(details)details.open=true;}catch(error){if(live())message.textContent=error.message;}finally{if(live())lock(false);api.busy?.(false);}};
  form.querySelector('#sql-cancel').onclick=()=>dialog.close();
  const read=async (selected=false)=>{
   if(busy||!live()||api.canStart?.()===false)return;formEdited=true;api.busy?.(true);lock(true);message.textContent='正在保存本机配置…';
   let password=form.querySelector('#sql-password').value;form.querySelector('#sql-password').value='';
   settings=checkSettings();
   try{if(!api.nas)await globalThis.window?.workbenchPauseCloud?.();await api.flush();if(!live())return;const stamp=context();if(!unchanged(stamp))throw Error('本页仍有未保存修改，请先保存后重试。');message.textContent='正在连接 SQL 并读取 ERP 成本与库存，最多等待 90 秒…';reading=true;readError='';const result=await request(selected?'preview-saved':'preview',selected?undefined:{settings,password,remember:form.querySelector('#sql-remember').checked,operator:api.operator(),...(api.nas?{useSaved:!password&&reuse()}: {})});
    if(result.cancelled){if(live()){message.textContent='未选择连接文件。';lock(false);}return;}
    // 不因关闭或后续编辑丢失结果；确认应用时仍要求原始版本与有效期一致。
    retained={plan:result,stamp,createdAt:Date.now(),page:0};password='';
    if(live()||dialog.open&&dialog.querySelector('#sql-read-wait'))showPreview(result,stamp);
   }catch(error){readError=error.name==='TimeoutError'?'SQL 读取超时，尚未应用数据，请重新读取。':(api.errorText?.(error)??error.message);const wait=dialog.querySelector('#sql-read-wait');if(wait)wait.textContent=readError;if(live()){if(!api.nas)form.querySelector('#sql-password').value=password;message.textContent=error.name==='TimeoutError'?'SQL 读取超时，尚未应用数据。请检查当前电脑的网络和 SQL 连接设置后重试。':(api.errorText?.(error)??error.message);lock(false);}}finally{password='';reading=false;api.busy?.(false);}
  };
  form.onsubmit=event=>{event.preventDefault();void read();};
  const existing=form.querySelector('#sql-use-saved');if(existing)existing.onclick=()=>read(true);
 }
 function showPreview(plan,stamp){
  const token=++generation;let busy=false;
  api.openDialog('确认 ERP 同步差异',`<p>来源：${plan.source?.server?`${esc(plan.source.server)}:${esc(plan.source.port)} / ${esc(plan.source.database)}`:'已选择的只读连接'} · 公司大库</p><p>读取 ${plan.total} 件商品；匹配 ${plan.matched} 处记录，未匹配 ${plan.unmatched} 处，成本、库存或类别变化 ${plan.changes.length} 处。</p><p class="hint">${plan.unknown} 件商品没有已确认的公司大库库存，将显示为未知；未匹配记录保留旧缓存，但配置价格计算会改用核算成本并显示警示。ERP 成本取自库存查询的单价成本；人工核算价保留，${api.sharedCosts?'确认后更新三店库存、ERP 成本与类别。':api.nas?'确认后只更新英特尔工作区。':'结果仅保存在本机。'}预览有效期 10 分钟。</p><div class="sql-diff-scroll"><table class="sql-diff-table"><colgroup><col style="width:70px"><col style="width:95px"><col><col style="width:145px"><col style="width:145px"></colgroup><thead><tr><th>位置</th><th>goods_id</th><th>配件</th><th>原最终可销 / 待入可销 / 成本</th><th>新最终可销 / 待入可销 / 成本</th></tr></thead><tbody></tbody></table></div><div class="actions"><button id="sql-diff-prev">上一页</button><span id="sql-diff-page"></span><button id="sql-diff-next">下一页</button></div><p id="sql-apply-message" class="hint" role="status"></p><div class="actions"><button id="sql-preview-cancel">关闭并保留预览</button><button id="sql-preview-refresh">重新读取</button><button id="sql-apply" class="primary">确认应用</button></div>`);
  const button=document.querySelector('#sql-apply'),message=document.querySelector('#sql-apply-message'),cancel=document.querySelector('#sql-preview-cancel');
  const live=()=>token===generation&&dialog.open&&button.isConnected;
  let diffPage=retained?.page||0;const drawDiff=()=>{if(retained)retained.page=diffPage;const pages=Math.max(1,Math.ceil(plan.changes.length/100));document.querySelector('.sql-diff-table tbody').innerHTML=plan.changes.slice(diffPage*100,(diffPage+1)*100).map(c=>`<tr><td>${esc(c.area)}</td><td>${esc(c.goodsId)}</td><td>${esc(c.name)}${Object.hasOwn(c,'categoryAfter')?`<br><small>类别：${esc(c.categoryBefore===undefined?'未采集':c.categoryBefore??'未分类')} → ${esc(c.categoryAfter??'未分类')}</small>`:''}</td><td>${esc(c.before)} / ${esc(c.incomingBefore)} / ¥${esc(c.erpBefore)}</td><td>${esc(c.after)} / ${esc(c.incomingAfter)} / ¥${esc(c.erpAfter)}</td></tr>`).join('');document.querySelector('#sql-diff-page').textContent=`第 ${diffPage+1} / ${pages} 页，共 ${plan.changes.length} 处变化`;document.querySelector('#sql-diff-prev').disabled=diffPage===0;document.querySelector('#sql-diff-next').disabled=diffPage>=pages-1;document.querySelector('.sql-diff-scroll').scrollTop=0;};document.querySelector('#sql-diff-prev').onclick=()=>{diffPage--;drawDiff();};document.querySelector('#sql-diff-next').onclick=()=>{diffPage++;drawDiff();};drawDiff();
  const valid=()=>unchanged(stamp)&&Date.now()-(retained?.createdAt||0)<600000;
  const refresh=document.querySelector('#sql-preview-refresh');refresh.onclick=()=>{if(!busy){retained=null;readError='';setup();}};
  if(!valid()){button.disabled=true;message.textContent='预览已过期或配置已变化，可以继续查看，应用前请重新读取。';}else if(api.nas&&!plan.changes.length){button.disabled=true;message.textContent='没有需要应用的变化。';}
  cancel.onclick=()=>{if(!busy)dialog.close();};
  button.onclick=async()=>{
   if(busy||!live()||api.canStart?.()===false)return;
   if(!valid()){message.textContent='预览已过期或配置已变化，请重新读取预览。';button.disabled=true;return;}
   busy=true;api.busy?.(true);button.disabled=true;cancel.disabled=true;refresh.disabled=true;lockClose(true);message.textContent=api.nas?'正在确认应用到服务端…':'正在确认应用到本机…';
   try{if(!api.nas)await globalThis.window?.workbenchPauseCloud?.();await api.flush();if(!live())return;if(!valid())throw Error('预览已过期或配置已变化，请重新读取预览。');const result=await request('apply',{id:plan.id});if(api.nas&&result.cancelled){if(live())message.textContent='已取消确认，仍可核对预览。';return;}retained=null;if(!live())return;
    // 按需回载要求弹窗关闭；在同一应用期间锁住页面输入，避免新编辑与回载相撞。
    const wasInert=document.body.inert;document.body.inert=true;
    try{if(!api.inline)dialog.close();if(await api.receive(result)===false)return;if(api.inline){button.hidden=true;message.textContent="ERP 库存与成本已更新，可继续操作下方核算成本。";}}finally{document.body.inert=wasInert;}
    api.toast(`ERP 成本与库存已更新：${plan.changes.length} 处变化，人工核算价保留。${api.nas?'已保存到服务端。':'结果仅保存在本机。'}`);
    // 配置回载及输入解锁已完成，再尝试本次价格提示；不让明细读取占用回载锁。
    await api.afterApply?.(result);
   }catch(error){if(live()){message.textContent=api.errorText?.(error)??error.message;button.disabled=!valid();}else api.toast(api.errorText?.(error)??error.message);}finally{busy=false;lockClose(false);api.busy?.(false);if(live()){cancel.disabled=false;refresh.disabled=false;if(api.nas&&retained)button.disabled=!valid()||!plan.changes.length;}}
  };
 }
 return{setup,preview:setup};
}
