/** 将归档查询、恢复确认和工作区回读连接到历史弹窗。 */
/** 旧版历史读取与恢复界面：查询归档版本，先预览差异再交给本机接口恢复。 */
export function bindLegacyHistory({flush,receive,openDialog,esc,toast,runMutation=operation=>operation()}){
 let marker=null;
 const stale=()=>Object.assign(Error(''),{stale:true});
 const alive=node=>node?.isConnected&&document.querySelector('#dialog')?.open;
 const render=(title,html)=>{openDialog(title,html);marker=document.querySelector('#legacy-message');};
 const request=async(action,input,keepCommittedResult=false)=>{const owner=marker;if(owner&&!alive(owner))throw stale();const r=await fetch('/api/legacy-history/'+action,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const v=await r.json();if(!keepCommittedResult&&owner&&(!alive(owner)||owner!==marker))throw stale();if(!r.ok)throw Error(v.error||'旧历史读取失败');return v;};
 const guard=fn=>async()=>{try{await fn();}catch(e){if(e.stale)return;toast(e.message);const node=document.querySelector('#legacy-message');if(node)node.textContent=e.message;}};
 // 预览直接读取保存快照；确认恢复才保存草稿并与同步互斥。
 const mutate=fn=>guard(()=>runMutation(fn));
 const footer='<p id="legacy-message" class="error"></p>';
 const pager=(v)=>`<div class="actions"><button id="legacy-prev" ${v.offset?'':'disabled'}>上一页</button><span>第 ${Math.floor(v.offset/v.limit)+1} 页 · 共 ${v.total} 条</span><button id="legacy-next" ${v.offset+v.limit<v.total?'':'disabled'}>下一页</button></div>`;
 const bindPager=(v,load)=>{document.querySelector('#legacy-prev').onclick=guard(()=>load(Math.max(0,v.offset-v.limit)));document.querySelector('#legacy-next').onclick=guard(()=>load(v.offset+v.limit));};
 const versions=async(offset=0)=>{
  render('旧版历史归档','<p>正在读取旧版历史…</p>'+footer);
  const status=await request('status');
  if(!status.available){render('旧版历史归档','<p>尚未导入旧历史归档。完成迁移校验后，旧版本与利润历史会在这里显示。</p>'+footer);return;}
  const page=await request('versions',{offset});
  render('旧版历史归档',`<p>旧版本与新版历史分别保留。可预览并还原选中配置；未选配置、当前顺序、成本源及店铺设置保持现状。</p><div class="actions"><button id="legacy-profit">旧利润历史</button></div>${pager(page)}${page.versions.map(v=>`<section class="history-item"><div><strong>${esc(v.name||`旧版本 ${v.revision}`)}${v.pinned?' · 已固定':''}</strong><time>${esc(v.at)}</time><p>${esc(v.reason)} · ${esc(v.scope)}</p></div><button data-legacy-version="${esc(v.id)}">预览恢复</button></section>`).join('')}${footer}`);
  bindPager(page,versions);document.querySelector('#legacy-profit').onclick=guard(profitRuns);
  document.querySelectorAll('[data-legacy-version]').forEach(b=>b.onclick=guard(async()=>{if(!b.isConnected||!alive(marker))return;await preview(b.dataset.legacyVersion);}));
 };
 const preview=async(id,offset=0,selection=new Set(),baseline=null)=>{
  const p=await request('preview',{id,offset});
  if(baseline&&(p.hash!==baseline.hash||p.baseRevision!==baseline.baseRevision))throw Error('当前配置或归档已变化，请返回并重新预览');
  baseline??={hash:p.hash,baseRevision:p.baseRevision};
  render('旧版本恢复预览',`<p>旧版本 ${p.revision} 与当前数据有 ${p.total} 套配置不同。最多选择 100 套；恢复会写入旧版本字段，保留当前新增字段，并按旧版本恢复删除状态；同时保存新版历史以便回退。</p>${pager(p)}${p.changes.map(c=>`<section class="history-item"><label><input type="checkbox" data-legacy-select="${esc(c.id)}" ${selection.has(c.id)?'checked':''}>${esc(c.shopId||'intel')} · ${esc(c.product||'')} / ${esc(c.name||c.id)} · ${esc(c.kind)}${c.deletedAt?'（旧版本中已删除）':''}</label><button data-legacy-detail="${esc(c.id)}">查看字段差异</button></section>`).join('')}<div class="actions"><button id="legacy-back">返回旧版本</button><button id="legacy-restore" class="primary" ${selection.size?'':'disabled'}>还原已选 ${selection.size} 套</button></div>${footer}`);
  bindPager(p,n=>preview(id,n,selection,baseline));
  document.querySelector('#legacy-back').onclick=guard(()=>versions());
  document.querySelectorAll('[data-legacy-select]').forEach(b=>b.onchange=()=>{if(b.checked&&selection.size>=100){b.checked=false;toast('每次最多恢复 100 套');return;}if(b.checked)selection.add(b.dataset.legacySelect);else selection.delete(b.dataset.legacySelect);const button=document.querySelector('#legacy-restore');button.disabled=!selection.size;button.textContent=`还原已选 ${selection.size} 套`;});
  document.querySelectorAll('[data-legacy-detail]').forEach(b=>b.onclick=guard(async()=>{const d=await request('preview',{id,configId:b.dataset.legacyDetail});render('旧配置字段差异',`<p>${d.missingAssets.length?`缺少 ${d.missingAssets.length} 个本地素材，恢复会被阻止。`:'本地素材检查通过。'}</p><pre>${esc(JSON.stringify({当前:d.before,恢复后:d.after},null,2))}</pre><button id="legacy-back">返回选择</button>${footer}`);document.querySelector('#legacy-back').onclick=guard(()=>preview(id,offset,selection,baseline));}));
  document.querySelector('#legacy-restore').onclick=guard(async()=>{const ids=[...selection];render('确认还原旧配置',`<p>将写入已选 ${ids.length} 套配置的旧版本字段；当前新增字段保留，删除状态按旧版恢复。确认前请检查字段差异；恢复后可在新版历史中回退。</p><div class="actions"><button id="legacy-cancel">返回预览</button><button id="legacy-confirm" class="primary">保存当前并还原</button></div>${footer}`);document.querySelector('#legacy-cancel').onclick=guard(()=>preview(id,offset,selection,baseline));document.querySelector('#legacy-confirm').onclick=mutate(async()=>{const confirm=document.querySelector('#legacy-confirm');confirm.disabled=true;try{await flush();if(!confirm.isConnected||!alive(marker))return;const owner=marker;await request('restore',{id,...baseline,configIds:ids},true);if(owner===marker&&alive(owner))document.querySelector('#dialog').close();await receive();toast(`已还原 ${ids.length} 套配置`);}catch(e){const b=document.querySelector('#legacy-confirm');if(b)b.disabled=false;throw e;}});});
 };
 const profitRuns=async()=>{
  const {runs}=await request('profit');
  render('旧利润历史',`<p>以下为旧版采集结果，保留当时来源与公式。不会用旧 ERP 观测覆盖新版检测基准。</p>${runs.map(r=>`<section class="history-item"><div><strong>${esc(r.started_at)} · ${esc(r.status)}</strong><p>${r.covered} 套 · ${esc(r.source)} · ${esc(r.formula)}</p></div><button data-legacy-run="${esc(r.id)}">查看结果</button></section>`).join('')||'<p>暂无旧利润历史。</p>'}<button id="legacy-back">返回旧版本</button>${footer}`);
  document.querySelector('#legacy-back').onclick=guard(()=>versions());document.querySelectorAll('[data-legacy-run]').forEach(b=>b.onclick=guard(()=>profitRows(b.dataset.legacyRun)));
 };
 const money=v=>v==null?'—':`¥${(v/100).toFixed(2)}`;
 const profitRows=async(id,offset=0)=>{const p=await request('profit',{id,offset});render('旧利润检测结果',`<p>旧版历史，只读显示。</p>${pager(p)}${p.rows.map(r=>`<section class="history-item"><div><strong>${esc(r.shopId)} · ${esc(r.snapshot?.product||'')} / ${esc(r.snapshot?.name||r.configId)}</strong><p>${r.metric==='erp'?'ERP':'核算'}利润：${r.valid?money(r.profitCents):'无效'} · 基准差额 ${money(r.anchorDeltaCents)}</p><p>${esc(r.reason)}</p></div></section>`).join('')}<button id="legacy-back">返回检测历史</button>${footer}`);bindPager(p,n=>profitRows(id,n));document.querySelector('#legacy-back').onclick=guard(profitRuns);};
 return {open:guard(()=>versions())};
}
