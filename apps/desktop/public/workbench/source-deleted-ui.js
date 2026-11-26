import {confirmRecycleAction} from './recycle-bin-ui.js';
import {sourceSheetCategory,deletedSourceTime,deletedSourceTimestamp,deletedSourceUses} from './source-sheet-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=(text,type='neutral')=>`<span class="ss-deleted-badge ${type}">${esc(text)}</span>`;
const date=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});

// 独立于在用表格的选择与搜索。跨筛选清理前始终列出真实候选，后端再次校验引用与版本。
export function mountDeletedSources(host,api){
 host.innerHTML=`<div class="ss-deleted-policy"><span><b>已删除输出源保留 30 天。</b> ${api.nas?'NAS 定时清理到期、本店非共享且无引用的输出源。':'本机可手动清理无引用项。'}在用配置、归档配置和主机模板的引用均受保护。</span><strong data-deleted-counts></strong></div>
 <div class="ss-deleted-tools"><label><input type="checkbox" data-deleted-all>全选可操作项</label>
 <input type="search" data-deleted-search aria-label="搜索已删除输出源" placeholder="搜索 ERP ID、名称或分类…">
 <div class="ss-deleted-segments" role="group" aria-label="已删除子筛选"><button data-sub="all">全部已删除</button><button data-sub="free">可彻底删除 (0引用)</button><button data-sub="protected">被引用保护中</button></div>
 <div class="ss-deleted-actions"><button data-bulk="restore">批量恢复</button><button data-bulk="purge">批量彻底删除</button><button data-bulk="clear">一键清理可删项</button></div></div>
 <div class="ss-deleted-table"><table><thead><tr><th aria-label="选择"></th><th>输出源配件（ERP ID / 分类 / 名称）</th><th>停用时间与剩余</th><th>引用状态</th><th>操作</th></tr></thead><tbody></tbody></table></div>
 <div class="ss-deleted-note"><span role="status" data-deleted-status></span><button data-deleted-refresh>刷新列表</button></div>`;
 const $=selector=>host.querySelector(selector),selected=new Set();
 let rows=[],category='全部配件',sub='all',query='',visible=[],active=false,loading=false,saving=false,failed=false,generation=0;
 const editable=row=>!!api.change&&api.canEdit(row)!==false;
 const free=row=>deletedSourceUses(row.references)===0;
 const label=row=>(row.name||row.erpName||row.sourceId)+(row.goodsId?' · #'+row.goodsId:'');
 const status=text=>{$('[data-deleted-status]').textContent=text;};
 function render(){
  const disabled=loading||saving||failed,local=new Set(rows.map(row=>row.sourceId));
  for(const id of selected)if(!local.has(id))selected.delete(id);
  const stats=rows.reduce((stats,row)=>{const n=deletedSourceUses(row.references);if(n===null)stats.unknown++;else if(n)stats.protected++;else stats.free++;return stats;},{unknown:0,protected:0,free:0});
  $('[data-deleted-counts]').textContent=`当前可彻底删除 ${stats.free} 条 · 被引用保护 ${stats.protected} 条`+(stats.unknown?' · 引用待核对 '+stats.unknown+' 条':'');
  const needle=query.trim().toLowerCase();
  visible=rows.filter(row=>{
   const kind=sourceSheetCategory(row),refs=deletedSourceUses(row.references);
   return (category==='全部配件'||kind===category)&&(sub==='all'||(sub==='free'?refs===0:refs>0))
    &&(!needle||[row.goodsId,row.sourceId,row.name,row.erpName,row.originalName,kind].join(' ').toLowerCase().includes(needle));
  }).sort((a,b)=>(deletedSourceTimestamp(a.deletedAt)||Infinity)-(deletedSourceTimestamp(b.deletedAt)||Infinity));
  const current=visible.filter(editable),checked=current.filter(row=>selected.has(row.sourceId)),allowed=checked.filter(free);
  $('[data-deleted-all]').checked=!!current.length&&checked.length===current.length;
  $('[data-deleted-all]').indeterminate=!!checked.length&&checked.length<current.length;
  $('[data-deleted-all]').disabled=disabled||!current.length;
  for(const button of host.querySelectorAll('[data-sub]'))button.setAttribute('aria-pressed',String(button.dataset.sub===sub));
  for(const [action,count,title] of [['restore',checked.length,'批量恢复'],['purge',allowed.length,'批量彻底删除']]){
   const button=$('[data-bulk='+action+']');button.disabled=disabled||!count;button.textContent=title+(count?' ('+count+')':'');
  }
  $('[data-bulk=clear]').disabled=disabled||!rows.some(row=>free(row)&&editable(row));
  $('[data-deleted-refresh]').disabled=loading||saving;
  $('tbody').innerHTML=visible.map(row=>{
   const id=esc(row.sourceId),refs=deletedSourceUses(row.references),epoch=deletedSourceTimestamp(row.deletedAt);
   const time=deletedSourceTime(row.deletedAt,Date.now(),api.nas&&row.ownerShop===api.shop&&row.shared===false&&refs===0);
   const why=refs===null?'尚未取得完整引用数':refs>0?`被 ${row.references.configurations} 套配置、${row.references.templates} 个模板引用，需先解除引用`:'';
   return `<tr data-deleted-row="${id}" ${selected.has(row.sourceId)?'class="selected"':''}><td><input type="checkbox" aria-label="选择 ${esc(label(row))}" data-deleted-id="${id}" ${selected.has(row.sourceId)?'checked':''} ${disabled||!editable(row)?'disabled':''}></td>
   <td><b>${esc(row.name||row.originalName)}</b><small>ERP：${esc(row.erpName||row.originalName||'—')}</small><div>${row.goodsId?badge('ID '+row.goodsId):''}${badge(sourceSheetCategory(row))}</div></td>
   <td><small>${Number.isFinite(epoch)?esc(date.format(epoch)):'—'}</small>${badge(time.text,time.days===null?'neutral':time.days<=3?'urgent':'warn')}</td>
   <td>${refs===null?badge('引用待核对'):refs===0?badge('0 引用 · 可清理','ok'):badge('配置 '+row.references.configurations+' 套 · 模板 '+row.references.templates+' 个','warn')}${refs>0?'<small>受保护，需先解除引用</small>':''}</td>
   <td><div><button data-one="restore" ${disabled||!editable(row)?'disabled':''}>恢复输出源</button><button data-one="purge" title="${esc(why||'彻底删除此输出源')}" ${disabled||!editable(row)||!free(row)?'disabled':''}>彻底删除</button></div></td></tr>`;
  }).join('')||`<tr><td colspan="5">${loading?'正在读取已删除输出源…':failed?'读取失败，请刷新列表':'没有符合条件的已删除输出源。'}</td></tr>`;
 }
 async function reload(){
  const token=++generation;
  loading=true;failed=false;render();
  try{
   const result=await api.read();
   if(token!==generation)return;
   rows=result;status('');api.count(rows.length);
  }catch(error){if(token===generation){failed=true;rows=[];status('读取失败：'+error.message);}}
  finally{if(token===generation){loading=false;render();}}
 }
 async function run(action,id){
  if(loading||saving||failed||api.blocked())return;
  const targets=(action==='clear'?rows:id?visible.filter(row=>row.sourceId===id):visible.filter(row=>selected.has(row.sourceId)))
   .filter(row=>editable(row)&&(action==='restore'||free(row)));
  if(!targets.length)return;
  saving=true;api.busy(true);render();
  let done=0,errorText='';
  try{
   if(action!=='restore'&&!await confirmRecycleAction({title:action==='clear'?'确认清理可删输出源':'确认彻底删除输出源',description:'以下输出源将永久删除，无法恢复。仍被配置或模板引用的输出源会保留。',items:targets.map(label),actionLabel:'确认彻底删除'}))return;
   try{
    await api.change(targets,action==='restore'?'restore':'purge',row=>{selected.delete(row.sourceId);done++;});
   }catch(error){errorText=error.message;}
   await reload();
   await api.changed(done);
   const text=(action==='restore'?'已恢复 ':'已彻底删除 ')+done+' 条输出源'+(errorText?'。其余未完成：'+errorText:'。');
   status(text+(failed?' 列表刷新失败，请重试。':''));api.notify(text);
  }finally{saving=false;api.busy(false);render();}
 }
 host.oninput=event=>{if(event.target.matches('[data-deleted-search]')){query=event.target.value;selected.clear();render();}};
 host.onchange=event=>{
  const el=event.target;
  if(el.matches('[data-deleted-all]')){for(const row of visible.filter(editable))el.checked?selected.add(row.sourceId):selected.delete(row.sourceId);}
  else if(el.matches('[data-deleted-id]')){el.checked?selected.add(el.dataset.deletedId):selected.delete(el.dataset.deletedId);}
  else return;
  render();
 };
 host.onclick=event=>{
  const button=event.target.closest('button');if(!button||button.disabled||saving)return;
  if(button.dataset.sub){sub=button.dataset.sub;selected.clear();render();return;}
  if(button.hasAttribute('data-deleted-refresh')){void reload();return;}
  const action=button.dataset.bulk||button.dataset.one;
  if(action)void run(action,button.closest('[data-deleted-row]')?.dataset.deletedRow).catch(error=>{status(error.message);api.notify(error.message);});
 };
 return {show(nextCategory){if(category!==nextCategory)selected.clear();category=nextCategory;if(active){render();return;}active=true;void reload();},
  hide(){if(!active)return;active=false;generation++;loading=false;rows=[];selected.clear();query='';sub='all';$('[data-deleted-search]').value='';}};
}
