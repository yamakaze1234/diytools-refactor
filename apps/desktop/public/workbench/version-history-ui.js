/** 绑定历史弹窗操作；恢复前保存必要草稿，成功后让宿主重新接收状态。 */
/** 本机版本历史界面：查询、命名、差异预览和恢复均通过本机版本接口。 */
export function bindVersionHistory({flush,receive,openDialog,esc,toast,runMutation=operation=>operation()}){
 let marker=null;
 const alive=node=>node?.isConnected&&document.querySelector('#dialog')?.open;
 const stale=()=>Object.assign(Error(''),{stale:true});
 // 用户关闭或切换弹窗后，旧查询不得重新打开历史页或覆盖新输入。
 const render=(title,html)=>{openDialog(title,html);marker=document.querySelector('#version-message');};
 const request=async(action,data,keepCommittedResult=false)=>{const owner=marker;if(owner&&!alive(owner))throw stale();const response=await fetch('/api/versions'+action,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();if(!keepCommittedResult&&owner&&(!alive(owner)||owner!==marker))throw stale();if(!response.ok)throw Error(value.error);return value;};
 const guard=fn=>async()=>{try{await fn();}catch(error){if(error.stale)return;toast(error.message);const node=document.querySelector('#version-message');if(node)node.textContent=error.message;}};
 // 浏览和差异预览只读；命名、删除标记和恢复提交才获取本机写入互斥。
 const mutate=fn=>guard(()=>runMutation(fn));
 const size=bytes=>bytes==null?'未设置上限':`${(bytes/1024**3).toFixed(2)} GiB`;
 const manage=guard(async()=>{
  const stats=await request('/status');
  const date=value=>value?new Date(value).toLocaleString('zh-CN'):'尚未执行';
  const result=stats.result;
  render('历史数据管理',`<p>本机所有店铺：普通历史及恢复草稿保留最近 7×24 小时，命名版本保留至主动删除。</p><p>数据库 ${size(stats.bytes)} · ${stats.count} 个普通版本、${stats.named} 个命名版本。</p><p>可复用空闲页 ${size(stats.reusableBytes)} · 写入日志 ${size(stats.walBytes)}。日常清理后空间由 SQLite 复用，不立即缩小文件。</p><p>上次完成：${esc(date(stats.lastCleanup))}<br>下次检查：${stats.nextCheckAt?esc(date(stats.nextCheckAt)):'启动后空闲时'}（忙碌时暂缓）</p><p>${result?`最近处理：${Number(result.history||0)} 条普通历史、${Number(result.drafts||0)} 份登记草稿；${Number(stats.pendingFiles||0)} 个文件待回收。`:'尚无清理结果。首次处理会先备份并校验命名版本。'}</p>${stats.error?`<p class="error">${esc(stats.error)}</p>`:''}<p id="version-message" class="error"></p><div class="actions"><button id="version-back">返回历史</button></div>`);
  document.querySelector('#version-back').onclick=()=>show(false);
 });
 const show=restoreMode=>guard(async()=>{
  render(restoreMode?'还原配置':'历史版本',`<p class="hint">正在读取历史版本，请稍候…</p><p id="version-message" class="error"></p>`);
  const [{versions},stats]=await Promise.all([request(''),request('/status')]);
  render(restoreMode?'还原配置':'历史版本',`<p>编辑内容及时保存在本机；历史按编辑阶段生成，本机所有店铺的普通历史和恢复草稿保留最近 7×24 小时，命名版本长期保留。数据库占用 ${size(stats.bytes)}。</p><p id="version-message" class="error"></p><div class="actions"><button id="version-name">保存命名版本</button><button id="version-manage">历史数据管理</button></div>${versions.map(v=>`<section class="history-item"><div><strong>${v.name?esc(v.name):`版本 ${v.revision}`}</strong><time>${esc(new Date(v.at).toLocaleString('zh-CN'))}</time><p>${esc(v.reason)}</p></div><div><button data-version="${esc(v.id)}">${restoreMode?'查看差异并还原':'查看差异'}</button>${v.pinned?`<button data-delete-named="${esc(v.id)}">删除命名版本</button>`:''}</div></section>`).join('')||'<p>尚无历史版本。</p>'}`);
  document.querySelector('#version-manage').onclick=manage;
  document.querySelector('#version-name').onclick=()=>{render('保存命名版本',`<label>版本名称<input id="version-name-input" maxlength="80" placeholder="例如：国庆活动价格确认版"></label><p id="version-message" class="error"></p><div class="actions"><button id="version-name-save" class="primary">保存</button><button id="version-back">返回历史</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-name-save').onclick=mutate(async()=>{await flush();await request('/name',{name:document.querySelector('#version-name-input').value});toast('命名版本已保存');await show(restoreMode);});};
  for(const button of document.querySelectorAll('[data-delete-named]'))button.onclick=()=>{const id=button.dataset.deleteNamed;render('删除命名版本',`<p>删除此命名版本及其独立恢复快照；普通历史仍按最近 7×24 小时保留。</p><p id="version-message" class="error"></p><div class="actions"><button id="version-delete-confirm" class="danger">确认删除</button><button id="version-back">返回历史</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-delete-confirm').onclick=mutate(async()=>{await request('/delete-named',{id});await show(restoreMode);});};
  for(const button of document.querySelectorAll('[data-version]'))button.onclick=guard(async()=>{const preview=await request('/preview',{id:button.dataset.version});render('还原版本预览',`<p>将还原至版本 ${preview.revision}，涉及 ${preview.changes.length} 条业务记录。差异基于本机已保存数据；确认前请检查以下差异。</p><p id="version-message" class="error"></p>${preview.changes.map(c=>`<details><summary>${esc(c.type)} · ${esc(c.name)}</summary><pre>${esc(JSON.stringify({当前:c.before,还原后:c.after},null,2))}</pre></details>`).join('')}<div class="actions"><button id="version-back">返回历史</button><button id="version-apply" class="primary" ${preview.changes.length?'':'disabled'}>备份当前并还原</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-apply').onclick=mutate(async()=>{const apply=document.querySelector('#version-apply'),owner=marker;apply.disabled=true;try{await flush();if(!apply.isConnected||owner!==marker||!alive(owner))return;await request('/restore',{id:preview.id,hash:preview.hash,baseRevision:preview.baseRevision},true);if(owner===marker&&alive(owner))document.querySelector('#dialog').close();await receive();toast('已还原并保存为新版本');}catch(e){if(apply.isConnected)apply.disabled=false;throw e;}});});
 })();
 return {open:()=>show(false),restore:()=>show(true),manage};
}
