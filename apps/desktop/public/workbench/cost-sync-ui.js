/** 含税成本更新：本机固定路径与独立云成本目录共用预览/确认流程。 */
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 界面使用 Excel 列字母；存储和读取器继续使用数字，兼容已有设置。
function columnLetters(value){let n=Number(value),text='';if(!Number.isInteger(n)||n<1||n>16384)return '';while(n){n--;text=String.fromCharCode(65+n%26)+text;n=Math.floor(n/26);}return text;}
function columnNumber(value){const text=String(value).trim().toUpperCase();if(!/^[A-Z]{1,3}$/.test(text))throw Error('请填写 Excel 列字母，例如 BB、BO');let n=0;for(const c of text)n=n*26+c.charCodeAt(0)-64;if(n>16384)throw Error('列字母必须在 A 至 XFD 范围内');return n;}
export function bindCostSync(api){
 let busy=false,settings=null,plan=null,generation=0,savedSettings=null,settingsRefreshed=false;
 const request=async(path,data)=>{const r=await fetch(path,{...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),signal:AbortSignal.timeout(120000)});const v=await r.json();if(!r.ok)throw Error(v.error||'成本操作失败');return v;};
 const $=s=>document.querySelector(s);
 const dialog=$('#dialog');dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 async function setup(){
  if(busy){api.toast('成本读取或应用中，请稍候');return;}
  const token=++generation;
  try{settings=await request('/api/cost-sync/settings');if(token!==generation||(api.root&&!api.root()?.isConnected))return;savedSettings={...settings};settingsRefreshed=false;draw();}catch(e){api.toast(e.message);}
 }
 function draw(){
  const token=++generation;plan=null;
  api.openDialog('ERP 同步 · 含税成本',`<section class="cloud-panel cost-sync-panel"><div class="cost-mode-grid">${[['nas','本地 NAS 表格','固定路径，只读 Excel，不同步云端成本'],['cloud','云端成本','独立接口，只读取最新价格，不拉历史和图片']].map(([id,title,help])=>`<label class="cloud-shop-card"><input type="radio" name="cost-mode" value="${id}" ${settings.mode===id?'checked':''}><span class="cloud-shop-copy"><strong>${title}</strong><span>${help}</span></span><span class="cloud-shop-state" aria-hidden="true"></span></label>`).join('')}</div><div id="cost-local-fields" ${settings.mode==='nas'?'':'hidden'}><label class="field">Excel 文件<input id="cost-file-path" readonly placeholder="请选择 Excel 文件" value="${esc(settings.path)}"></label><button id="cost-choose-file" type="button">选择 Excel 文件…</button><div class="form-grid"><label class="field">工作表<input id="cost-file-sheet" value="${esc(settings.sheet)}"></label><label class="field">goods_id 所在列<input id="cost-goods-column" type="text" maxlength="3" placeholder="例如 BB" value="${columnLetters(settings.goodsColumn)}"></label><label class="field">含税成本所在列<input id="cost-tax-column" type="text" maxlength="3" placeholder="例如 BO" value="${columnLetters(settings.taxColumn)}"></label></div><p class="hint">只读已保存的单元格值，不运行宏、不刷新外部连接、不写回文件。无效成本跳过并保留原价。</p></div><p id="cost-cloud-help" class="hint" ${settings.mode==='cloud'?'':'hidden'}>每页最多 1,000 条，只下载 goods_id 与含税成本。仅更新本机缓存，不上传本机成本；读取途中云端价格变化时需要重新读取。</p><p class="hint">路径和来源仅保存在本机。确认后成本影响本机所有店铺；普通配置同步不会覆盖这份成本。</p><p id="cost-sync-message" role="status"></p><div id="cost-preview"></div><div class="actions"><button id="cost-close">关闭</button><button id="cost-read" class="primary">读取核算成本</button><button id="cost-apply" class="primary" hidden>确认更新核算成本</button></div></section>`);
  const live=()=>token===generation&&$('#cost-read')&&dialog.open;
  const message=$('#cost-sync-message');
  const lock=value=>{busy=value;api.busy?.(value);for(const el of (api.root?.()||dialog).querySelectorAll('button,input'))el.disabled=value;};
  $('#cost-close').onclick=()=>dialog.close();
  for(const el of dialog.querySelectorAll('[name="cost-mode"]'))el.onchange=()=>{settings.mode=el.value;$('#cost-local-fields').hidden=el.value!=='nas';$('#cost-cloud-help').hidden=el.value!=='cloud';plan=null;$('#cost-apply').hidden=true;$('#cost-preview').replaceChildren();};
  $('#cost-choose-file').onclick=async()=>{if(busy||api.canStart?.()===false)return;lock(true);try{const result=await request('/api/sql-sync/cost-file',{});if(!live()||result.cancelled)return;$('#cost-file-path').value=result.path;plan=null;$('#cost-apply').hidden=true;$('#cost-preview').replaceChildren();message.textContent='文件已选择，点击读取预览后记住此路径';}catch(e){message.textContent=e.message;}finally{lock(false);}};
  for(const selector of ['#cost-goods-column','#cost-tax-column'])$(selector).oninput=()=>{$(selector).value=$(selector).value.toUpperCase();plan=null;$('#cost-apply').hidden=true;};
  $('#cost-read').onclick=async()=>{
   if(busy||api.canStart?.()===false)return;lock(true);plan=null;$('#cost-apply').hidden=true;message.textContent='正在准备读取…';const started=performance.now();
   try{
    await window.workbenchPauseCloud?.();await api.flush();
    if(api.hasPending?.())throw Error('请先保存当前修改');
    const config={mode:settings.mode,path:$('#cost-file-path').value.trim(),sheet:$('#cost-file-sheet').value.trim(),goodsColumn:settings.mode==='nas'?columnNumber($('#cost-goods-column').value):settings.goodsColumn,taxColumn:settings.mode==='nas'?columnNumber($('#cost-tax-column').value):settings.taxColumn};
    const changed=Object.keys(config).some(k=>config[k]!==savedSettings?.[k]);settings=await request('/api/cost-sync/settings',config);savedSettings={...settings};if(changed||!settingsRefreshed){if(await api.receive({})===false)throw Error('本机配置未完成回载，请关闭同步窗口后重试');settingsRefreshed=true;}
    message.textContent=settings.mode==='nas'?'正在只读读取 Excel…':'正在分页读取最新云端成本…';
    plan=await request(settings.mode==='nas'?'/api/sql-sync/cost-preview':'/api/native-cloud/costsPreview',{});
    if(!live())return;
    message.textContent=`读取 ${plan.total} 条，匹配 ${plan.matched} 处，${plan.changed} 处成本变化，新增 ${plan.added||0} 条成本缓存。${plan.invalidCount?`另有 ${plan.invalidCount} 条无效成本，跳过并保留原价。`:''} 用时 ${((performance.now()-started)/1000).toFixed(1)} 秒。`;
    $('#cost-preview').innerHTML=`<div class="cost-preview-scroll"><table><thead><tr><th>goods_id</th><th>原含税成本</th><th>新含税成本</th><th>说明</th></tr></thead><tbody>${plan.examples.map(r=>`<tr><td>${esc(r.goodsId)}</td><td>${esc(r.before??'未知')}</td><td>${esc(r.after??'未知')}</td><td>${r.overridePreserved?'保留独立改价':''}</td></tr>`).join('')}</tbody></table></div><p class="hint">最多展示 80 处差异，应用全部有效成本。预览有效期 10 分钟。</p>${plan.invalid?.length?`<p class="error">跳过：${plan.invalid.map(r=>esc(r.goods_id)+'（'+esc(r.reason)+'）').join('、')}</p>`:''}`;
    $('#cost-apply').hidden=false;
   }catch(e){message.textContent=e.message;plan=null;}finally{lock(false);}
  };
  $('#cost-apply').onclick=async()=>{
   if(busy||!plan||api.canStart?.()===false)return;lock(true);
   try{await api.flush();if(api.hasPending?.())throw Error('请先保存当前修改');const result=await request('/api/cost-sync/apply',{id:plan.id});plan=null;$('#cost-apply').hidden=true;if(await api.receive(result)===false)return;message.textContent='成本已保存到本机，未修改 Excel 或云端成本。';api.toast('含税成本已更新');}
   catch(e){message.textContent=e.message;}finally{lock(false);}
  };
 }
 return {setup};
}
