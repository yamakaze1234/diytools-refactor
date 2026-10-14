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
  render('历史数据管理',`<p>实际文件占用 ${size(stats.bytes)} · 有效历史 ${size(stats.liveBytes??stats.bytes)} / ${size(stats.limit)}，共 ${stats.count} 个版本，其中命名版本 ${stats.named} 个。</p><p>可回收空闲页 ${size(stats.reusableBytes??0)} · 写入日志 ${size(stats.walBytes??0)}（不重复计入有效历史）。</p><p>本机保留历史，自动清理尚未启用。历史链用于恢复，当前版本尚未提供手动清理。</p>${stats.error?`<p class="error">${esc(stats.error)}</p>`:''}<p id="version-message" class="error"></p><div class="actions"><button data-clean="all" disabled title="当前版本须保留历史链，尚未启用清理">清理普通历史（尚未启用）</button><button id="version-back">返回历史</button></div>`);
  document.querySelector('#version-back').onclick=()=>show(false);
  for(const button of document.querySelectorAll('[data-clean]'))button.onclick=guard(async()=>{
   const mode=button.dataset.clean,plan=await request('/cleanup',{mode,preview:true});
   render('确认清理历史',`<p>将删除当前工作区 ${plan.count} 个普通版本。本次手动清理保留未到期的最新恢复点和命名版本。删除后无法从历史中找回这些版本。</p><p>目前历史库实际占用 ${size(plan.bytes)}；释放量以清理后文件大小为准。</p><p id="version-message" class="error"></p><div class="actions"><button id="version-cancel">返回管理</button><button id="version-confirm" class="danger" >确认清理</button></div>`);
   document.querySelector('#version-cancel').onclick=manage;
   document.querySelector('#version-confirm').onclick=mutate(async()=>{const result=await request('/cleanup',{mode,signature:plan.signature});toast(`已清理 ${result.removed} 个版本，实际释放 ${size(Math.max(0,result.before-result.after))}`);await manage();});
  });
 });
 const show=restoreMode=>guard(async()=>{
  render(restoreMode?'还原配置':'历史版本',`<p class="hint">正在读取历史版本，请稍候…</p><p id="version-message" class="error"></p>`);
  const [{versions},stats]=await Promise.all([request(''),request('/status')]);
  render(restoreMode?'还原配置':'历史版本',`<p>编辑内容及时保存在本机；历史按编辑阶段生成，本机保留历史，自动清理尚未启用，全部历史占用 ${size(stats.bytes)}。</p><p id="version-message" class="error"></p><div class="actions"><button id="version-name">保存命名版本</button><button id="version-manage">历史数据管理</button></div>${versions.map(v=>`<section class="history-item"><div><strong>${v.name?esc(v.name):`版本 ${v.revision}`}</strong><time>${esc(new Date(v.at).toLocaleString('zh-CN'))}</time><p>${esc(v.reason)}</p></div><div><button data-version="${esc(v.id)}">${restoreMode?'查看差异并还原':'查看差异'}</button>${v.pinned?`<button data-delete-named="${esc(v.id)}">删除命名标记</button>`:''}</div></section>`).join('')||'<p>尚无历史版本。</p>'}`);
  document.querySelector('#version-manage').onclick=manage;
  document.querySelector('#version-name').onclick=()=>{render('保存命名版本',`<label>版本名称<input id="version-name-input" maxlength="80" placeholder="例如：国庆活动价格确认版"></label><p id="version-message" class="error"></p><div class="actions"><button id="version-name-save" class="primary">保存</button><button id="version-back">返回历史</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-name-save').onclick=mutate(async()=>{await flush();await request('/name',{name:document.querySelector('#version-name-input').value});toast('命名版本已保存');await show(restoreMode);});};
  for(const button of document.querySelectorAll('[data-delete-named]'))button.onclick=()=>{const id=button.dataset.deleteNamed;render('删除命名版本',`<p>仅删除此命名标记，底层普通历史版本继续保留。</p><p id="version-message" class="error"></p><div class="actions"><button id="version-delete-confirm" class="danger">确认删除</button><button id="version-back">返回历史</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-delete-confirm').onclick=mutate(async()=>{await request('/delete-named',{id});await show(restoreMode);});};
  for(const button of document.querySelectorAll('[data-version]'))button.onclick=guard(async()=>{const preview=await request('/preview',{id:button.dataset.version});render('还原版本预览',`<p>将还原至版本 ${preview.revision}，涉及 ${preview.changes.length} 条业务记录。差异基于本机已保存数据；确认前请检查以下差异。</p><p id="version-message" class="error"></p>${preview.changes.map(c=>`<details><summary>${esc(c.type)} · ${esc(c.name)}</summary><pre>${esc(JSON.stringify({当前:c.before,还原后:c.after},null,2))}</pre></details>`).join('')}<div class="actions"><button id="version-back">返回历史</button><button id="version-apply" class="primary" ${preview.changes.length?'':'disabled'}>备份当前并还原</button></div>`);document.querySelector('#version-back').onclick=()=>show(restoreMode);document.querySelector('#version-apply').onclick=mutate(async()=>{const apply=document.querySelector('#version-apply'),owner=marker;apply.disabled=true;try{await flush();if(!apply.isConnected||owner!==marker||!alive(owner))return;await request('/restore',{id:preview.id,hash:preview.hash,baseRevision:preview.baseRevision},true);if(owner===marker&&alive(owner))document.querySelector('#dialog').close();await receive();toast('已还原并保存为新版本');}catch(e){if(apply.isConnected)apply.disabled=false;throw e;}});});
 })();
 return {open:()=>show(false),restore:()=>show(true),manage};
}
