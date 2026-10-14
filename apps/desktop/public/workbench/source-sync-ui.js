/** 输出源同步界面：选择同步字段、预览差异，再执行应用与导图。 */
import {sourceImageEntries} from './source-sync-data.js';
import {sourceFollowPlan} from './source-follow.js';
import {renderPoster} from './poster.js';
import {makeZip} from './zip.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'显示名称',tax:'含税核算单价',upgrade:'逐项升级说明'};
/** 为来源编辑器挂载同步范围和确认流程，业务状态由 API 提供。 */
export function mountSourceSync(root,api){
 root.innerHTML=`<h4>输出源更新与手动内容确认</h4><div class="source-fields">${Object.entries(labels).map(([key,name])=>`<label><input type="checkbox" data-source-field="${key}" checked>${name}</label>`).join('')}</div><p class="hint">保存输出源后，未手改的显示名称和逐项加购说明自动更新；手改内容与无法判断的旧内容保留在此待确认。点击链接查看明细，再勾选需要处理的字段。含税核算单价仍需手动确认。人工“加购与选配”不变。</p><p class="hint">确认更新后，所选名称和说明恢复自动跟随；再次手改会重新保护。保留手动内容会忽略本次源版本，下次源内容变化再提醒。</p><div class="source-export-choice"><span>更新后生成图片并导出？</span><label><input type="radio" name="source-export" value="no" checked> 否，仅更新配置数据</label><label><input type="radio" name="source-export" value="yes"> 是，生成并导出所选配置</label></div><div class="actions"><button id="source-check">刷新待确认差异</button><button id="source-apply" class="primary" disabled>确认更新所选项</button><button id="source-ignore" disabled>保留手动内容，忽略本次源版本</button><button id="source-export-retry" hidden>重新保存并导出</button></div><div id="source-diff"></div><p data-source-sync-message class="hint" role="status"></p>`;
 const $=s=>root.querySelector(s);let preview=null,plan=null,busy=false,exportConfigs=null,locked=[],activeLink=null,selected=new Set(),generation=0;
 const message=text=>{$('[data-source-sync-message]').textContent=text;api.message(text);};
 function invalidate(){generation++;preview=null;plan=null;activeLink=null;selected.clear();$('#source-apply').disabled=true;$('#source-ignore').disabled=true;$('#source-diff').innerHTML='';}
 const dialog=root.closest('dialog')||root,cancelGuard=e=>{if(root.isConnected&&busy)e.preventDefault();};dialog.addEventListener('cancel',cancelGuard);
 // Captured controls may belong to a retained, detached source draft after a
 // conflict replaces the shared dialog; restore their state before reopening.
 function lock(value){busy=value;if(value){locked=[...dialog.querySelectorAll('input,textarea,select,button')].map(el=>[el,el.disabled]);for(const [el] of locked)el.disabled=true;}else for(const [el,disabled] of locked)el.disabled=disabled;}
 const autoExport=()=>$('input[name=source-export]:checked').value==='yes';
 const currentItems=()=>preview?preview.changes.filter(c=>c.before.productId===activeLink).flatMap(config=>config.details.map(detail=>({config,detail}))):[];
 function buildPlan(action='update'){return sourceFollowPlan(preview.changes.map(c=>c.before),preview.sources,preview.fields,preview.shopId,{keys:[...selected],action});}
 function selection(){
  if(!preview)return;
  plan=buildPlan();const count=plan.changes.reduce((n,c)=>n+c.details.length,0),hasTax=preview.changes.some(c=>c.details.some(d=>selected.has(d.key)&&d.field==='tax'));
  $('#source-apply').disabled=busy||!count;$('#source-ignore').disabled=busy||!count||hasTax;
  const all=$('[data-source-select-all]'),items=currentItems();if(all){const n=items.filter(i=>selected.has(i.detail.key)).length;all.checked=items.length>0&&n===items.length;all.indeterminate=n>0&&n<items.length;}
  message(`已选择 ${count} 项，涉及 ${plan.changes.length} 套配置。${hasTax?'含核算单价，不能忽略源版本。':'未勾选的内容继续保留。'}${count&&autoExport()?`确认更新后生成并导出 ${plan.changes.length*2} 张图片。`:''}`);
 }
 function renderDetails(){
  const configs=preview.changes.filter(c=>c.before.productId===activeLink);
  root.querySelectorAll('[data-source-link]').forEach(el=>{el.setAttribute('aria-pressed',String(el.dataset.sourceLink===String(activeLink)));el.classList.toggle('primary',el.dataset.sourceLink===String(activeLink));});
  $('[data-source-groups]').innerHTML=configs.length?`<div class="actions"><label><input type="checkbox" data-source-select-all>选择当前链接全部字段</label><button data-source-clear>取消全部字段选择</button></div>${configs.map(c=>`<section class="source-link-group"><strong>${esc(c.product)} · ${esc(c.name)}</strong>${c.details.map(d=>`<div class="source-diff-item"><label><input type="checkbox" data-source-select value="${esc(d.key)}" ${selected.has(d.key)?'checked':''}>${esc(d.slot)} · ${esc(labels[d.field]||d.field)}</label><div class="source-option-change" data-source-description><span>当前内容：${esc(d.before===''||d.before==null?'（空）':d.before)}</span><span>输出源新内容：${esc(d.after===''||d.after==null?'（空）':d.after)}</span></div></div>`).join('')}</section>`).join('')}`:'<p class="hint">点击上方链接后显示差异明细；字段默认不选中。</p>';
  root.querySelectorAll('[data-source-select]').forEach(el=>{el.onclick=e=>e.stopPropagation();el.onchange=e=>{e.stopPropagation();el.checked?selected.add(el.value):selected.delete(el.value);selection();};});
  const all=$('[data-source-select-all]');if(all){all.onclick=e=>e.stopPropagation();all.onchange=e=>{e.stopPropagation();for(const {detail} of currentItems())all.checked?selected.add(detail.key):selected.delete(detail.key);renderDetails();};}
  const clear=$('[data-source-clear]');if(clear)clear.onclick=e=>{e.stopPropagation();selected.clear();renderDetails();};selection();
 }
 async function refresh(){
  if(busy)return;invalidate();const token=generation;
  try{if(api.isEdited())throw Error('请先保存或重置当前输出源修改，再查看差异。');await api.flush();if(token!==generation)return;if(api.isEdited())throw Error('输出源有新修改，请先保存。');
   const fields=[...root.querySelectorAll('[data-source-field]:checked')].map(el=>el.dataset.sourceField);
   preview=sourceFollowPlan(api.getConfigs(),api.getRows(),fields,api.shopId());
   const links=new Map();for(const c of preview.changes){const id=c.before.productId;if(!links.has(id))links.set(id,{name:c.product,count:0});links.get(id).count+=c.details.length;}
   $('#source-diff').innerHTML=`<p class="hint">${links.size} 个链接有待确认差异，点击链接查看明细。</p><div class="source-scope-links">${[...links].map(([id,link])=>`<button type="button" data-source-link="${esc(id)}" aria-pressed="false">${esc(link.name)}（${link.count} 项）</button>`).join('')}</div><div data-source-groups></div>`;
   root.querySelectorAll('[data-source-link]').forEach(el=>el.onclick=e=>{e.stopPropagation();activeLink=[...links.keys()].find(id=>String(id)===el.dataset.sourceLink);renderDetails();});renderDetails();
   if(!preview.changes.length)message('本店没有需要确认的差异。');
  }catch(e){if(token!==generation)return;invalidate();message(e.message);}
 }
 root.querySelectorAll('[data-source-field]').forEach(el=>el.onchange=()=>refresh());
 root.querySelectorAll('input[name=source-export]').forEach(el=>el.onchange=()=>selection());
 $('#source-check').onclick=()=>refresh();
 async function exportAll(){await api.flush();const entries=sourceImageEntries(exportConfigs),files=[],failures=[];for(const [i,entry] of entries.entries()){message(`已更新配置，正在生成图片 ${i+1}/${entries.length}：${entry.config.name}`);try{const result=await renderPoster(entry.config,1400);if(result.overflow)throw Error('图片内容超出，请调整模块或字号');const blob=await new Promise(resolve=>result.canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败');await api.validateImage(entry.config);files.push({name:entry.name,bytes:new Uint8Array(await blob.arrayBuffer())});}catch(e){failures.push({name:entry.name,error:e.message});}}if(!files.length)throw Error('图片全部生成失败：'+failures.map(f=>f.error).join('；'));const report={createdAt:new Date().toISOString(),expected:entries.length,success:files.map(f=>f.name),failures};files.push({name:'导出结果.json',bytes:new TextEncoder().encode(JSON.stringify(report,null,2))});api.download(makeZip(files),`本店输出源更新图片_${Date.now()}.zip`);message(`已更新 ${exportConfigs.length} 套配置，导出 ${report.success.length}/${entries.length} 张图片${failures.length?`，失败 ${failures.length} 张，详情见导出结果.json，可重试。`:'，配置图与 SKU 图已全部更新。'}`);}
 async function applySelected(action){
  if(busy||!preview||!plan?.changes.length)return;
  const approved=buildPlan(action),auto=action!=='ignore'&&autoExport();if(!approved.changes.length)return;exportConfigs=null;let applied=false;
  try{if(api.isEdited())throw Error('输出源有新修改，请先保存并重新预览');lock(true);await api.apply(approved);applied=true;
   if(action!=='ignore')exportConfigs=api.getConfigs().filter(c=>approved.changes.some(d=>d.id===c.id)).map(c=>structuredClone(c));
   if(auto)await exportAll();else message(action==='ignore'?`已保留 ${approved.changes.length} 套配置的所选手动内容，本次源版本不再提醒。`:`已更新 ${approved.changes.length} 套配置，所选名称和说明恢复自动跟随，未生成或导出图片。`);
   $('#source-export-retry').hidden=!auto;
  }catch(e){message('操作未完成：'+e.message);if(exportConfigs)$('#source-export-retry').hidden=false;}finally{const result=root.querySelector("[data-source-sync-message]").textContent;lock(false);invalidate();if(applied)await refresh();message(result);}
 }
 $('#source-apply').onclick=e=>{e.stopPropagation();return applySelected('update');};
 $('#source-ignore').onclick=e=>{e.stopPropagation();if(!$('#source-ignore').disabled)return applySelected('ignore');};
 $('#source-export-retry').onclick=async()=>{if(busy||!exportConfigs)return;try{lock(true);await exportAll();}catch(e){message(e.message);}finally{lock(false);invalidate();}};
 queueMicrotask(()=>{if(!api.isEdited())refresh();});
 return {invalidate,refresh,dispose:()=>dialog.removeEventListener('cancel',cancelGuard)};
}
