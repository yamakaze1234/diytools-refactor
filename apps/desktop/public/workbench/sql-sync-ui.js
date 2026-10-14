/** 公司 SQL 只读同步界面：管理本机连接资料、生成更新预览，并在确认后应用。 */
const esc=value=>String(value??'未知').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Adapted from the original SQL dialog. Passwords live only in this dialog/request.
/** 绑定连接、预览与确认入口；业务更新通过受控本机接口执行。 */
export function bindSqlSync(api){
 const dialog=document.querySelector('#dialog');let generation=0,applying=false,retained=null,reading=false,readError='';
 const context=()=>api.context?.();
 const unchanged=stamp=>stamp===context()&&!api.hasPending?.();
 const request=async(path,data)=>{const response=await fetch('/api/sql-sync/'+path,data===undefined?{signal:AbortSignal.timeout(15000)}:{...(path==='preview'?{signal:AbortSignal.timeout(90000)}:{}),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw Error(result.error||'数据库服务不可用');return result;};
 const lockClose=locked=>{applying=locked;const close=dialog.querySelector('.dialog-title .close');if(close)close.disabled=locked;};
 dialog.addEventListener('cancel',event=>{if(applying)event.preventDefault();});
 dialog.addEventListener('close',()=>{generation++;const input=dialog.querySelector('#sql-password');if(input)input.value='';lockClose(false);});
 function setup(){
  if(applying)return;
  // 查询及预览属于工作台会话，关闭共享弹窗只释放界面，不丢弃查询结果。
  if(retained){showPreview(retained.plan,retained.stamp);return;}
  if(reading){api.openDialog('ERP同步 · 后台读取', '<p id="sql-read-wait" role="status">正在后台读取公司 SQL，关闭后仍会保留预览结果。稍后重新打开即可继续。</p>');return;}
  const token=++generation;let busy=false,formEdited=false,settings={server:'',port:1433,database:'',user:'',encrypt:true,trustServerCertificate:false};
  api.openDialog('ERP同步 · 公司数据库',`<p class="hint">按 goods_id 精确匹配公司大库的分库可销数。先读取差异，再确认应用。同时读取“库存成本”作为单件 ERP 成本，保留人工核算价；ERP 成本与可销数仅保存在本机。勾选后在本机加密保存连接信息，仅当前 Windows 用户使用，不上传云端。当前为独立测试版。</p><form id="sql-connection-form"><div class="form-grid">${[['server','服务器'],['port','端口'],['database','数据库'],['user','只读账号']].map(([key,label])=>`<label class="field">${label}<input id="sql-${key}" name="${key}" value="${esc(settings[key])}" required ${key==='port'?'type="number" min="1" max="65535"':'autocomplete="off"'}></label>`).join('')}<label class="field">密码<input id="sql-password" type="password" autocomplete="off" required></label></div><label><input id="sql-encrypt" type="checkbox" checked> 加密连接</label> <label><input id="sql-trust" type="checkbox"> 信任服务器证书（公司自签证书时使用）</label><label style="display:block;margin-top:10px"><input id="sql-remember" type="checkbox" checked> 在本机加密保存并自动填入</label><button id="sql-forget" type="button">清除本机保存的连接</button><p id="sql-message" role="status" class="hint"></p><div class="actions"><button type="button" id="sql-cancel">取消</button><button type="submit" class="primary" id="sql-read" disabled>读取并预览</button></div></form>`);
  const form=document.querySelector('#sql-connection-form'),message=form.querySelector('#sql-message');if(readError)message.textContent=readError;
  const live=()=>token===generation&&dialog.open&&form.isConnected;
  const lock=locked=>{busy=locked;form.querySelectorAll('input,button').forEach(input=>{if(input.id!=='sql-cancel')input.disabled=locked;});};
  form.addEventListener('input',()=>{formEdited=true;});
  request('credentials').then(saved=>{if(!live()||formEdited||busy)return;if(saved.saved){settings=saved.settings;for(const key of ['server','port','database','user'])form.querySelector('#sql-'+key).value=settings[key];form.querySelector('#sql-encrypt').checked=settings.encrypt;form.querySelector('#sql-trust').checked=settings.trustServerCertificate;form.querySelector('#sql-password').value=saved.password||'';message.textContent='已从本机加密存储填入连接信息';}}).catch(error=>{if(live())message.textContent=error.message;}).finally(()=>{if(live()&&!busy)form.querySelector('#sql-read').disabled=false;});
  form.querySelector('#sql-forget').onclick=async()=>{if(busy)return;formEdited=true;lock(true);try{await request('credentials/clear',{});if(!live())return;for(const key of ['server','database','user','password'])form.querySelector('#sql-'+key).value='';form.querySelector('#sql-remember').checked=false;message.textContent='已清除本机保存的连接';}catch(error){if(live())message.textContent=error.message;}finally{if(live())lock(false);}};
  form.querySelector('#sql-cancel').onclick=()=>dialog.close();
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!live())return;formEdited=true;lock(true);message.textContent='正在保存本机配置…';
   let password=form.querySelector('#sql-password').value;form.querySelector('#sql-password').value='';
   settings={...Object.fromEntries(['server','port','database','user'].map(k=>[k,form.querySelector('#sql-'+k).value])),encrypt:form.querySelector('#sql-encrypt').checked,trustServerCertificate:form.querySelector('#sql-trust').checked};
   try{await api.flush();if(!live())return;const stamp=context();if(!unchanged(stamp))throw Error('本页仍有未保存修改，请先保存后重试。');message.textContent='正在连接 SQL 并读取 ERP 成本与库存，最多等待 90 秒…';reading=true;readError='';const result=await request('preview',{settings,password,remember:form.querySelector('#sql-remember').checked,operator:api.operator()});
    // 不因关闭或后续编辑丢失结果；确认应用时仍要求原始版本与有效期一致。
    retained={plan:result,stamp,createdAt:Date.now(),page:0};password='';
    if(live()||dialog.open&&dialog.querySelector('#sql-read-wait'))showPreview(result,stamp);
   }catch(error){readError=error.name==='TimeoutError'?'SQL 读取超时，尚未应用数据，请重新读取。':error.message;const wait=dialog.querySelector('#sql-read-wait');if(wait)wait.textContent=readError;if(live()){form.querySelector('#sql-password').value=password;message.textContent=error.name==='TimeoutError'?'SQL 读取超时，尚未应用数据。请检查当前电脑的网络和 SQL 连接设置后重试。':error.message;lock(false);}}finally{password='';reading=false;}
  };
 }
 function showPreview(plan,stamp){
  const token=++generation;let busy=false;
  api.openDialog('确认 ERP 成本与库存差异',`<p>来源：${esc(plan.source.server)}:${esc(plan.source.port)} / ${esc(plan.source.database)} · 公司大库</p><p>读取 ${plan.total} 件商品；匹配 ${plan.matched} 处记录，未匹配 ${plan.unmatched} 处，成本或库存变化 ${plan.changes.length} 处。</p><p class="hint">${plan.unknown} 件商品没有已确认的公司大库库存，将显示为未知；未匹配记录保留旧缓存，但配置价格计算会改用核算成本并显示警示。ERP 成本取自 SQL 库存成本；人工核算价保留，结果仅保存在本机。预览有效期 10 分钟。</p><div class="sql-diff-scroll"><table class="sql-diff-table"><colgroup><col style="width:70px"><col style="width:95px"><col><col style="width:145px"><col style="width:145px"></colgroup><thead><tr><th>位置</th><th>goods_id</th><th>配件</th><th>原可销数 / 成本</th><th>新可销数 / 成本</th></tr></thead><tbody></tbody></table></div><div class="actions"><button id="sql-diff-prev">上一页</button><span id="sql-diff-page"></span><button id="sql-diff-next">下一页</button></div><p id="sql-apply-message" class="hint" role="status"></p><div class="actions"><button id="sql-preview-cancel">关闭并保留预览</button><button id="sql-preview-refresh">重新读取</button><button id="sql-apply" class="primary">确认应用</button></div>`);
  const button=document.querySelector('#sql-apply'),message=document.querySelector('#sql-apply-message'),cancel=document.querySelector('#sql-preview-cancel');
  const live=()=>token===generation&&dialog.open&&button.isConnected;
  let diffPage=retained?.page||0;const drawDiff=()=>{if(retained)retained.page=diffPage;const pages=Math.max(1,Math.ceil(plan.changes.length/100));document.querySelector('.sql-diff-table tbody').innerHTML=plan.changes.slice(diffPage*100,(diffPage+1)*100).map(c=>`<tr><td>${esc(c.area)}</td><td>${esc(c.goodsId)}</td><td>${esc(c.name)}</td><td>${esc(c.before)} / ¥${esc(c.erpBefore)}</td><td>${esc(c.after)} / ¥${esc(c.erpAfter)}</td></tr>`).join('');document.querySelector('#sql-diff-page').textContent=`第 ${diffPage+1} / ${pages} 页，共 ${plan.changes.length} 处变化`;document.querySelector('#sql-diff-prev').disabled=diffPage===0;document.querySelector('#sql-diff-next').disabled=diffPage>=pages-1;document.querySelector('.sql-diff-scroll').scrollTop=0;};document.querySelector('#sql-diff-prev').onclick=()=>{diffPage--;drawDiff();};document.querySelector('#sql-diff-next').onclick=()=>{diffPage++;drawDiff();};drawDiff();
  const valid=()=>unchanged(stamp)&&Date.now()-(retained?.createdAt||0)<600000;
  const refresh=document.querySelector('#sql-preview-refresh');refresh.onclick=()=>{if(!busy){retained=null;readError='';setup();}};
  if(!valid()){button.disabled=true;message.textContent='预览已过期或配置已变化，可以继续查看，应用前请重新读取。';}
  cancel.onclick=()=>{if(!busy)dialog.close();};
  button.onclick=async()=>{
   if(busy||!live())return;
   if(!valid()){message.textContent='预览已过期或配置已变化，请重新读取预览。';button.disabled=true;return;}
   busy=true;button.disabled=true;cancel.disabled=true;refresh.disabled=true;lockClose(true);message.textContent='正在确认应用到本机…';
   try{await api.flush();if(!live())return;if(!valid())throw Error('预览已过期或配置已变化，请重新读取预览。');const result=await request('apply',{id:plan.id});retained=null;if(!live())return;dialog.close();if(await api.receive(result)===false)return;api.toast(`本机 ERP 成本与库存已更新：${plan.changes.length} 处变化，ERP 成本取自 SQL 库存成本；人工核算价保留，结果仅保存在本机。`);
   }catch(error){if(live()){message.textContent=error.message;button.disabled=!valid();}else api.toast(error.message);}finally{busy=false;lockClose(false);if(live()){cancel.disabled=false;refresh.disabled=false;}}
  };
 }
 return{setup,preview:setup};
}
