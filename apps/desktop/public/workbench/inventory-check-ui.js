// 库存全屏页按同一报告筛选和分组，替换业务继续使用统一预览与保存校验。
import {replacementDiff} from './global-batch.js';
import {checkInventory,stockReplacementTasksPlan,validateStockReplacement,inventoryThreshold,savedInventoryThreshold,inventoryCategories} from './inventory-check-data.js';
import {inventoryShell,drawInventoryResults,stockTime} from './inventory-check-view.js';
import {stockTaskEditor} from './inventory-check-tasks.js';
import {inventoryLinks} from './inventory-export.js';
import {sourceImageEntries} from './source-sync-data.js';
import {renderPoster} from './poster.js';
import {makeZip} from './zip.js';

export function openInventoryCheck(api){
 const {root,esc,getConfigs:getAllConfigs,getCosts,shop,product,download,getCatalog}=api;
 const $=selector=>root.querySelector(selector);
 let single=!!api.single,threshold=savedInventoryThreshold(),report,plan,retry,busy=false,visible=[];
 const filters={status:'issues',category:'',group:'status'},expanded=new Set();
 const getConfigs=()=>single?inventoryLinks(getAllConfigs(),shop.id).find(g=>g.id===product?.id)?.configs||[]:getAllConfigs();
 root.innerHTML=inventoryShell(api,threshold);
 const message=text=>$('#stock-message').textContent=text;
 const invalidate=()=>{plan=null;$('#stock-apply').disabled=true;$('#stock-diff').replaceChildren();};
 const layouts=()=>[...root.querySelectorAll('[data-stock-layout]:checked')].map(el=>el.dataset.stockLayout);
 const lock=value=>{busy=value;root.inert=value;$('#stock-scan').disabled=value;};
 const clearRetry=()=>{retry=null;$('#stock-retry').hidden=true;};
 const snapshot=()=>checkInventory(getConfigs(),getCosts(),shop.id,threshold,getCatalog());
 const tasks=stockTaskEditor({$,esc,getCatalog,getCosts,getConfigs:getAllConfigs,shop,invalidate,drawReport});
 function drawReport(){
  visible=drawInventoryResults({$,esc,issues:report?.issues||[],threshold,filters,categories:inventoryCategories,expanded,drafts:tasks.drafts,active:tasks.active});
 }
 function showSnapshot(){
  report=snapshot();expanded.clear();
  if(report.issues.length)expanded.add(report.issues[0].key);
  // 用库存源实际更新时间；扫描本地报告的时间不能冒充 ERP 同步时间。
  const latest=getCosts().reduce((ts,c)=>Math.max(ts,Date.parse(c.stockUpdatedAt)||0),0);
  $('#stock-summary').textContent=`● 本机 ERP 库存时间：${stockTime(latest)||'未记录'} · 忽略 ${report.skippedSpecial} 处特殊配件 · 检查 ${report.linkCount} 个链接、${report.configCount} 套配置`;
  $('[data-scope-btn="shop"]').textContent=`全店链接 (${api.getShopLinkCount()})`;
  tasks.reset(threshold);drawReport();
 }
 async function scan(){
  if(busy)return;
  for(const b of root.querySelectorAll('[data-scope-btn]'))b.setAttribute('aria-pressed',String(b.dataset.scopeBtn===(single?'link':'shop')));
  try{
   threshold=inventoryThreshold($('#stock-threshold').value);
   lock(true);await api.load(single?product?.id:null);
   showSnapshot();clearRetry();try{localStorage.setItem('diy-stock-threshold',String(threshold));}catch{}
   message('检查完成。点击中间配件的「展示和实际一起替换」即可开始。');
  }catch(error){message(error.message);}finally{lock(false);}
 }
 function resetReport(){
  report=null;expanded.clear();tasks.reset(threshold);clearRetry();drawReport();
  $('#stock-summary').textContent='请重新检查库存。';message('请重新检查库存。');
 }
 $('#stock-results').onclick=e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-stock-locate'))return api.locate(b.dataset.stockLocate);
  if(b.hasAttribute('data-stock-toggle')){
   const key=b.dataset.stockToggle;if(expanded.has(key))expanded.delete(key);else expanded.add(key);
   drawReport();
  }else if(b.hasAttribute('data-stock-edit')){
   const row=report.issues.find(r=>r.key===b.dataset.stockEdit);
   tasks.open(row);message('已载入替换任务，核对链接与新配件后点击「预览全部任务」。');
  }
 };
 function pickStatus(key){filters.status=key;drawReport();}
 $('#stock-statuses').onclick=e=>{const b=e.target.closest('[data-stock-status]');if(b)pickStatus(b.dataset.stockStatus);};
 $('#stock-kpis').onclick=e=>{const b=e.target.closest('[data-stock-kpi]');if(b)pickStatus(b.dataset.stockKpi);};
 $('#stock-categories').onclick=e=>{const b=e.target.closest('[data-stock-cat]');if(b){filters.category=b.dataset.stockCat;drawReport();}};
 $('#stock-reset-cat').onclick=()=>{filters.category='';drawReport();};
 for(const b of root.querySelectorAll('[data-stock-group]'))b.onclick=()=>{
  filters.group=b.dataset.stockGroup;
  for(const el of root.querySelectorAll('[data-stock-group]'))el.setAttribute('aria-pressed',String(el===b));
  drawReport();
 };
 $('#stock-result-search').oninput=drawReport;$('#stock-only-transit').onchange=drawReport;$('#stock-sort').onchange=drawReport;
 $('#stock-expand-all').onclick=()=>{for(const row of visible)expanded.add(row.key);drawReport();};
 $('#stock-collapse-all').onclick=()=>{expanded.clear();drawReport();};
 $('#stock-scan').onclick=scan;$('#stock-threshold').oninput=resetReport;
 $('#stock-scope').onclick=e=>{
  const b=e.target.closest('[data-scope-btn]');if(!b||single===(b.dataset.scopeBtn==='link'))return;
  single=b.dataset.scopeBtn==='link';resetReport();scan();
 };
 $('#stock-back').onclick=()=>api.back();
 $('#stock-task-actions').onchange=invalidate;
 $('#stock-preview').onclick=()=>{try{
  plan=stockReplacementTasksPlan(getConfigs(),getCosts(),getCatalog(),report,tasks.drafts);
  $('#stock-diff').innerHTML=`<pre>${esc(replacementDiff(plan))}</pre>`;
  $('#stock-apply').disabled=!plan.changes.length;
  message(`${plan.taskCount} 条任务，将修改 ${plan.productIds.length} 个链接、${plan.changes.length} 套配置。`);
 }catch(error){invalidate();message(error.message);}};
 async function exportImages(saved){
  if(!saved.layouts.length)return;
  const configs=inventoryLinks(getConfigs(),shop.id).filter(g=>saved.productIds.includes(g.id)).flatMap(g=>g.configs);
  const entries=sourceImageEntries(configs,null,saved.skuMode).filter(e=>saved.layouts.includes(e.config.layout)),files=[],failures=[];
  for(const [i,entry] of entries.entries()){message(`修改已保存，正在生成 ${i+1}/${entries.length}：${entry.config.name}`);try{const result=await renderPoster(entry.config,1400);if(result.overflow)throw Error('内容超出画布，请调整版式');const blob=await new Promise(resolve=>result.canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败');files.push({name:entry.name,bytes:new Uint8Array(await blob.arrayBuffer())});}catch(e){failures.push({name:entry.name,error:e.message});}}
  if(!entries.length)throw Error('当前没有可导出的配置图');
  if(!files.length)throw Error('没有成功生成图片：'+failures.map(f=>f.error).join('；'));
  const summary={createdAt:new Date().toISOString(),expected:entries.length,success:files.map(f=>f.name),failures};files.push({name:'导出结果.json',bytes:new TextEncoder().encode(JSON.stringify(summary,null,2))});download(makeZip(files),`库存替换配置图_${Date.now()}.zip`);message(`修改已保存，导出 ${summary.success.length}/${entries.length} 张图片${failures.length?'；失败项见 ZIP 内导出结果.json，可重试。':'。'}`);
  if(failures.length)throw Error('部分图片生成失败，详情见 ZIP 内导出结果。');
 }
// 保存回执和导出分别记录。出图失败只重试导出，避免再次提交替换。
 async function finishSaved(saved){
  await api.load(single?product?.id:null);
  showSnapshot();
  if(saved.layouts.length){await exportImages(saved);}
  else message(`已保存 ${saved.count} 套配置的展示配件、实际配件与逐项升级说明修改。`);
 }
 async function apply(){
  if(busy||!plan)return;
  const approved=plan;
  const saved={count:plan.changes.length,productIds:plan.productIds,layouts:layouts(),skuMode:$('#stock-sku-mode').value};
  lock(true);clearRetry();
  try{
   validateStockReplacement(approved,getConfigs(),getCosts(),getCatalog());
   await api.apply(approved);invalidate();retry=saved;
   await finishSaved(saved);clearRetry();
  }catch(error){
   if(error.retryStockSave){
    invalidate();retry={...saved,save:error.retryStockSave};message('保存待确认：'+error.message);$('#stock-retry').textContent='重试原保存并导出';
   }else if(retry){message('修改已保存，刷新或导出未完成：'+error.message);$('#stock-retry').textContent='重试刷新与导出';}
   else{message('保存未完成：'+error.message+'。请重新预览后重试。');invalidate();$('#stock-retry').textContent='重新预览';}
   $('#stock-retry').hidden=false;
  }finally{lock(false);}
 }
 $('#stock-apply').onclick=apply;
 $('#stock-retry').onclick=async()=>{
  if(busy)return;
  if(!retry){$('#stock-preview').click();return;}
  lock(true);
  try{
   // 原保存确认后移除保存回调，后续导图失败只重试出图。
   if(retry.save){await retry.save();delete retry.save;}
   await finishSaved(retry);clearRetry();
  }catch(error){
   message((retry.save?'保存待确认：':'修改已保存，刷新或导出未完成：')+error.message);
   if(!retry.save)$('#stock-retry').textContent='重试刷新与导出';
  }finally{lock(false);}
 };
 scan();
 return {busy:()=>busy,dispose:()=>{root.replaceChildren();}};
}
