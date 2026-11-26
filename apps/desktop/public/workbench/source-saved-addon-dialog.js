import {exportOptionsHtml,readExportOptions,exportSourceImages} from './source-sync-export.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

/** 仅对刚刚保存的本店输出源作一次决策；只有明确跟随的升级说明可提交。 */
export function openSavedAddonDecision(api){
 const {plan,rows}=api;
 if(!plan.followConfigCount&&!plan.manualConfigCount)return Promise.resolve({updated:false});
 const dialog=document.createElement('dialog');
 dialog.id='modal-save-prompt';dialog.className='sd-modal sd-saved-dialog';
 dialog.setAttribute('aria-labelledby','saved-addon-title');
 dialog.innerHTML=`<header class="sd-header"><div><span class="sd-badge sd-ok">输出源已保存</span><strong id="saved-addon-title">是否立即更新本店配置的加购？</strong></div><button type="button" data-close aria-label="关闭">✕</button></header>
 <section class="sd-saved-content">
 <div class="sd-saved-sources"><span>本次已保存 <strong>${rows.length}</strong> 条含加购修改的输出源：</span>${rows.map(row=>`<span class="sd-badge sd-cat">${esc(row.name||row.erpName||row.originalName||row.goodsId)}</span>`).join('')}</div>
 <div class="sd-split"><section class="sd-follow-card"><div><b>跟随输出源（可立即更新）</b><strong id="prompt-follow-cnt">${plan.followConfigCount} 套</strong></div><small>涉及 ${plan.followLinkCount} 个链接 · 同步更新为最新加购。</small></section>
 <section class="sd-manual-card"><div><b>人工特殊文案（自动保护）</b><strong id="prompt-manual-cnt">${plan.manualConfigCount} 套</strong></div><small title="涉及 ${plan.manualLinkCount} 个链接">不会强制替换，留待「待确认差异」人工确认。</small></section></div>
 <div class="sd-saved-export"><label class="sd-export-intro"><input id="prompt-export-toggle" type="checkbox" checked><span><b>更新后同时导出对应配置的配置图与 SKU 图</b><small>若不勾选，更新后可在顶栏「本次变动」随时补导这批配置的图片；若点左下角「暂不更新」，则会留在「待确认差异」中稍后处理或导图。</small></span></label>
 <div id="prompt-export-options">${exportOptionsHtml({prompt:true,count:plan.followConfigCount})}</div></div>
 <p data-prompt-status role="status" hidden></p></section>
 <footer class="sd-saved-footer"><button id="btn-defer-update" type="button">暂不更新，留待确认差异</button><button id="btn-update-now" type="button" class="sd-primary"></button></footer>`;
 const $=selector=>dialog.querySelector(selector);
 let busy=false,updated=false;
 function refresh(){
  const exportOn=$('#prompt-export-toggle').checked,options=readExportOptions(dialog);
  $('#prompt-export-options').hidden=!exportOn;
  $('#btn-update-now').disabled=busy||updated||!plan.followConfigCount;
  $('#btn-update-now').textContent=exportOn&&options.layouts.length?`立即更新 ${plan.followConfigCount} 套加购并导图`:`仅立即更新 ${plan.followConfigCount} 套加购`;
 }
 function message(value){
  const status=$('[data-prompt-status]');status.hidden=!value;status.textContent=value;api.message?.(value);
 }
 const finished=new Promise(resolve=>dialog.addEventListener('close',()=>{dialog.remove();resolve({updated});},{once:true}));
 const close=()=>{if(!busy)dialog.close();};
 $('[data-close]').onclick=close;
 $('#btn-defer-update').onclick=close;
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 dialog.addEventListener('change',refresh);
 $('#btn-update-now').onclick=async()=>{
  if(busy||updated||!plan.followConfigCount)return;
  const options=readExportOptions(dialog),withExport=$('#prompt-export-toggle').checked&&options.layouts.length>0;
  busy=true;for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=true;
  try{
   // 即使上游误传了人工项，也拒绝整批提交，避免把未确认内容写进配置。
   if(plan.changes.some(c=>c.details.some(d=>d.kind!=='follow'||d.field!=='upgrade'||d.ignored)))throw Error('计划含需人工确认的差异，请重新查看待确认差异。');
   await api.apply(plan);updated=true;
   // 收到保存成功回执即登记补导，即使后续刷新角标失败也可找到这一批。
   if(!withExport)api.onUpdatedWithoutExport?.(plan.changes);
   await api.onChanged?.();
   if(withExport)await exportSourceImages(api,plan.changes,plan.shopId,options,text=>message('配置已更新。'+text));
   else message(`已更新本店 ${plan.followConfigCount} 套跟随配置的加购。`);
   dialog.close();
  }catch(error){
   // 配置已提交、导出任务可能尚未创建；沿用免导出的回执，补导时无需再次提交配置。
   if(updated&&withExport)api.onUpdatedWithoutExport?.(plan.changes);
   message((updated?'加购已更新，后续操作未完成：':'配置更新未完成：')+error.message+(updated?'。可在顶栏「本次变动」补导图片。':''));
   if(updated)$('#btn-defer-update').textContent='关闭';
  }finally{
   busy=false;
   for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=false;
   refresh();
  }
 };
 document.body.append(dialog);refresh();dialog.showModal();return finished;
}
