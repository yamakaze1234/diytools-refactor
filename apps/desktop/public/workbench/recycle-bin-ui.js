/** 回收站使用服务端归档时间计算期限，确认清单固定为用户点击时的可见数据。 */
const DAY=86400000;
const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function retentionLabel(at,days,now=Date.now()){
 const left=Date.parse(at)+days*DAY-now;
 if(!Number.isFinite(left))return {text:'时间未知',urgent:false};
 if(left<=0)return {text:'已到清理期限',urgent:true};
 if(left<=DAY)return {text:'剩余 '+Math.ceil(left/3600000)+' 小时 · 即将自动清理',urgent:true};
 return {text:'剩余 '+Math.ceil(left/DAY)+' 天',urgent:false};
}
export function confirmRecycleAction({title,description,items,actionLabel='确认彻底删除',danger=true}){
 if(!items.length)return Promise.resolve(false);
 const dialog=document.createElement('dialog');dialog.className='rb-confirm';dialog.setAttribute('aria-label',title);
 dialog.innerHTML=`<form method="dialog"><header class="${danger?'rb-alert':''}"><h2>${escape(title)}</h2></header>
 <section><p>${escape(description)}</p><ul>${items.map(item=>'<li>'+escape(item)+'</li>').join('')}</ul></section>
 <footer><button value="cancel" autofocus>取消</button><button value="confirm" class="${danger?'rb-danger-solid':''}">${escape(actionLabel)}</button></footer></form>`;
 return new Promise(resolve=>{dialog.addEventListener('close',()=>{const accepted=dialog.returnValue==='confirm';dialog.remove();resolve(accepted);},{once:true});document.body.append(dialog);dialog.showModal();});
}

export function mountConfigRecycle(host,{shopName,nas,rows,load,apply,onCount}){
 const chosen=new Set();let busy=false;
 host.innerHTML=`<article class="rb-config"><header><h2>已删除配置（回收站）</h2><span class="rb-tag">${escape(shopName)}</span><span class="rb-tag" data-total></span><button type="button" data-close aria-label="关闭">×</button></header>
 <main><div class="rb-rule"><b>自动清理规则</b>　${nas?'配置保留 7 天，到期由 NAS 服务端定时彻底清理，不可恢复。':'本机配置可在删除后 7 天内恢复，到期后可手动清理。'}恢复不会自动重新发布给销售，历史操作记录与原图始终保留。</div>
 <div class="rb-tools"><label><input type="checkbox" data-all> 全选</label><input type="search" data-search aria-label="搜索已删除配置" placeholder="搜索链接名称、配置名称或版本…"><small data-count></small>
 <button data-action="restore">恢复所选</button><button data-action="purge" class="rb-danger">彻底删除所选</button><button data-action="clear" class="rb-danger">清空回收站</button></div>
 <div class="rb-list"></div><footer role="status">彻底删除仅移除所选归档配置及其明细，操作日志保留可追溯。</footer></main></article>`;
 const root=host.firstElementChild,$=sel=>root.querySelector(sel),all=$('[data-all]'),search=$('[data-search]'),status=$('footer');
 const title=row=>[row.product,row.name].filter(Boolean).join(' · ');
 const matches=()=>rows.filter(row=>[row.product,row.name,row.label,row.version].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()));
 const recoverable=row=>nas||Date.parse(row.at)+7*DAY>Date.now();
 function render(){
  rows.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)||a.id.localeCompare(b.id));
  const visible=matches(),n=visible.filter(row=>chosen.has(row.id)).length;
  all.checked=visible.length>0&&n===visible.length;all.indeterminate=n>0&&n<visible.length;all.disabled=!visible.length;
  $('[data-total]').textContent=rows.length+' 套';$('[data-count]').textContent='已选 '+chosen.size+' 套';
  $('[data-action=restore]').disabled=!chosen.size||rows.some(row=>chosen.has(row.id)&&!recoverable(row));
  $('[data-action=purge]').disabled=!chosen.size;$('[data-action=clear]').disabled=!rows.length;
  $('.rb-list').innerHTML=visible.map(row=>{
   const expiry=retentionLabel(row.at,7),id=escape(row.id);
   return `<div class="rb-row"><label><input data-id="${id}" type="checkbox" ${chosen.has(row.id)?'checked':''}><span><strong>${escape(title(row))}</strong> <span class="rb-tag">${escape(row.label||row.version)}</span>
   <small>删除时间　${Number.isFinite(Date.parse(row.at))?escape(new Date(row.at).toLocaleString('zh-CN')):'未记录'}　<span class="rb-tag ${expiry.urgent?'rb-danger':'rb-warn'}">${escape(!nas&&expiry.urgent?expiry.text.replace('自动清理','到期'):expiry.text)}</span></small></span></label>
   <button data-restore-config="${id}" ${recoverable(row)?'':'disabled'}>恢复</button><button class="rb-danger" data-purge-config="${id}">彻底删除</button></div>`;
  }).join('')||'<p class="rb-empty">'+(rows.length?'没有匹配的配置。':'暂无已删除配置。')+'</p>';
 }
 search.oninput=render;all.onchange=()=>{for(const row of matches()){if(all.checked)chosen.add(row.id);else chosen.delete(row.id);}render();};
 root.onchange=event=>{const el=event.target;if(el.matches('[data-id]')){if(el.checked)chosen.add(el.dataset.id);else chosen.delete(el.dataset.id);render();}};
 root.onclick=async event=>{
  const button=event.target.closest('button');if(!button||busy)return;
  if(button.hasAttribute('data-close')){host.closest('dialog').close();return;}
  const id=button.dataset.restoreConfig??button.dataset.purgeConfig,action=button.dataset.action??(button.hasAttribute('data-restore-config')?'restore':'purge');
  const targets=rows.filter(row=>id?row.id===id:action==='clear'||chosen.has(row.id));
  if(!targets.length)return;
  const restore=action==='restore',verb=restore?'恢复':'彻底删除';
  busy=true;root.inert=true;
  try{
   const confirmed=await confirmRecycleAction({title:action==='clear'?'确认清空回收站？':'确认'+verb+targets.length+'套配置？',description:restore?'恢复后可继续编辑，不会自动发布给销售。':'以下配置及其配件明细将被永久移除，无法撤销。历史操作记录与原图保留。',items:targets.map(r=>title(r)+(r.label?' · '+r.label:'')),actionLabel:'确认'+verb,danger:!restore});
   if(!confirmed||!root.isConnected||!host.closest('dialog').open)return;
   const done=await apply(restore?'restore':'purge',targets);
   if(done===false)return;
   rows=await load();chosen.clear();onCount?.(rows.length);render();status.textContent='已'+verb+' '+targets.length+' 套配置。';
  }catch(error){status.textContent=error.message;try{rows=await load();chosen.clear();onCount?.(rows.length);render();}catch{/* 保留错误提示与原清单供重新打开。 */}}
  finally{busy=false;root.inert=false;}
 };
 onCount?.(rows.length);render();
}
