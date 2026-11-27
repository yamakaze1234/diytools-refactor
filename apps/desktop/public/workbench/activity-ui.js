/** 操作记录按北京时间分组；NAS 旧版仍可按日期翻页。 */
import {recentActivity} from './activity.js';

const nasKinds={configurations:['配置','configuration'],sources:['输出源','source'],costs:['成本与库存','component'],
 addons:['加购','source'],gallery:['机箱图库','gallery'],templates:['配置模板','template'],settings:['店铺设置','settings'],
 quotations:['维护表报价','quotation'],assets:['原图',null]};
const nasActions={create:'新增',replace:'修改',design:'调整样式',archive:'移入回收站',restore:'恢复',copy:'复制',apply:'应用',
 purge:'彻底清理',upload:'上传',erp_snapshot:'同步 ERP',erp_sync:'三店同步 ERP',tax_file:'导入含税成本',
 tax_sync:'三店同步含税成本表',global_tax:'三店改共用核算价',tax_edit:'修改含税成本',tax_resume:'重新同步核算价',
 tax_file_skipped:'跳过手动核算价',select_workbook:'确认维护表价格',publish:'向销售发布',withdraw:'撤回销售发布'};
const syncedCosts=new Set(['erp_sync','erp_snapshot','tax_sync','tax_file','tax_file_skipped']);
const beijingDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const beijingTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const priorDay=offset=>beijingDay.format(Date.now()-offset*86400000);

function nasActivityRow(row,shopId){
 if(!row||typeof row.kind!=='string'||typeof row.resource_id!=='string'||typeof row.created_at!=='string'||
    !Number.isFinite(Date.parse(row.created_at)))throw Error('服务端操作记录返回不完整。');
 const key=row.kind==='shared-sources'?'sources':row.kind;
 const [kind,type]=Object.hasOwn(nasKinds,key)?nasKinds[key]:['工作区资料',null];
 const version=/^[1-9]\d{0,18}$/.test(row.next_version??'')?'版本 '+row.next_version:'';
 const batch=row.kind==='costs'&&(row.batch===true||syncedCosts.has(row.action));
 const gone=row.action==='purge'||row.object_exists===false;
 const summary=batch&&Number.isSafeInteger(row.updated_count)
  ?`更新 ${row.updated_count} 项${row.skipped_count?`，跳过 ${row.skipped_count} 项手动核算价`:''}`
  :[row.product_name,row.resource_name||row.resource_id,version].filter(Boolean).join(' · ');
 return {kind,action:nasActions[row.action]||'维护',summary,at:row.created_at,gone,batch,
  preview:batch&&Array.isArray(row.samples)?row.samples.slice(0,3).map(({name,id})=>name||id).join('、'):'',
  operator:row.operator||'未记录',actor:row.actor_uid,
  target:gone||!type?null:{type:batch?'price-changes':type,id:row.resource_id,shopId,
   ...(!batch&&type==='component'?{goodsId:row.resource_id}:{})}};
}

function openNasActivity({openDialog,esc,loadNasPage,purgeNas,locate,toast,shop,ownUid,errorText=error=>error.message}){
 openDialog('操作记录',`<p id="activity-rule" class="activity-rule">日期按北京时间。旧工作台本机记录未迁入。</p>
  <div id="activity-operators" class="activity-operators" aria-label="按操作人筛选" hidden></div>
  <div class="activity-filters">
   <label id="activity-kind-filter" hidden>对象类型 <select id="activity-kind"><option value="">全部类型</option>${Object.entries(nasKinds).map(([key,[label]])=>`<option value="${key}">${label}</option>`).join('')}</select></label>
   <label>开始日期 <input id="activity-from" type="date"></label><label>结束日期 <input id="activity-to" type="date"></label>
   <div class="activity-shortcuts" aria-label="常用日期"><button type="button" data-activity-days="1">今天</button>
    <button type="button" data-activity-days="7">近 7 天</button><button type="button" data-activity-days="30">近 30 天</button>
    <button type="button" data-activity-days="">全部日期</button></div>
  </div>
  <section id="activity-cleanup" hidden aria-label="清理历史记录">
   <label>清理范围 <select id="activity-cleanup-scope"><option value="30">清理 30 天前</option><option value="7">清理 7 天前</option>
    <option value="selected">按当前筛选条件清理</option><option value="all">清空当前店全部历史记录</option></select></label>
   <button type="button" id="activity-cleanup-preview">预览清理</button>
   <button type="button" id="activity-cleanup-confirm" hidden>确认清理</button>
   <p id="activity-cleanup-status" role="status">清理只影响操作记录及符合期限的回执。业务数据与近 24 小时的回执会保留。</p>
  </section>
  <div class="activity-scroll"><div id="activity-list" aria-busy="true"></div></div>
  <div class="actions activity-pagination"><button id="activity-prev" disabled>上一页</button><span id="activity-page"></span><button id="activity-next" disabled>下一页</button></div>`,
  {headerHtml:`<div class="activity-header"><span class="activity-shop">${esc(shop?.name||'')}</span>
   <span id="activity-count" role="status"></span><button type="button" id="activity-cleanup-open" hidden>清理历史记录…</button></div>`});
 const $=selector=>document.querySelector(selector),list=$('#activity-list');
 const alive=()=>list.isConnected&&$('#activity-list')===list&&list.closest?.('dialog')?.open!==false;
 const status=$('#activity-cleanup-status'),confirmButton=$('#activity-cleanup-confirm'),previewButton=$('#activity-cleanup-preview');
 let page=0,generation=0,actor='',enhanced=false,purgeBusy=false,approved=null;
 const initialPurgeText=status.textContent;
 const filters=()=>({from:$('#activity-from').value,to:$('#activity-to').value,actor,kind:$('#activity-kind').value});
 function resetPreview(){
  approved=null;confirmButton.hidden=true;status.textContent=initialPurgeText;
 }
 function filterActor(uid){
  actor=uid||'';newFilter();
 }
 function newFilter(){
  resetPreview();page=0;void draw();
 }
 function renderOperators(operators){
  const holder=$('#activity-operators');
  holder.hidden=!enhanced;
  if(!enhanced)return;
  const own=operators.find(row=>row.own);
  const options=[['','全部人员'],[own?.uid||ownUid,'本人（我）'],...operators.filter(row=>!row.own).map(row=>[row.uid,row.name])];
  holder.innerHTML=options.filter(([uid])=>typeof uid==='string').map(([uid,name])=>
   `<button type="button" data-activity-operator="${esc(uid)}" aria-pressed="${uid===actor}">${esc(name)}</button>`).join('');
  for(const button of holder.querySelectorAll('[data-activity-operator]'))button.onclick=()=>filterActor(button.dataset.activityOperator);
 }
 function renderRows(rows){
  let previous=null;
  list.innerHTML=rows.map((row,i)=>{
   const date=new Date(row.at),day=beijingDay.format(date);
   const group=day===previous?'':`<h3 class="activity-day">${day}</h3>`;previous=day;
   const operator=row.actor&&enhanced?`<button type="button" class="activity-person" data-activity-person="${esc(row.actor)}" title="${esc(row.operator)}">${esc(row.operator)}</button>`:`<span class="activity-person" title="${esc(row.operator)}">${esc(row.operator)}</span>`;
   return `${group}<div class="activity-row">
    <time datetime="${esc(row.at)}">${beijingTime.format(date)}</time>${operator}
    <div class="activity-action"><strong>${esc(row.action)}</strong><span>${esc(row.kind)}</span></div>
    <div class="activity-summary"><span>${esc(row.summary)}</span>${row.preview?`<small>${esc(row.preview)}</small>`:''}</div>
    <div class="activity-locate">${row.target?`<button type="button" data-activity-locate="${i}">${row.batch?'检查价格变化':'定位修改'}</button>`:row.gone?'<small>已永久清理</small>':''}</div>
   </div>`;
  }).join('')||'<p class="activity-empty">所选条件下暂无操作记录。</p>';
  for(const button of list.querySelectorAll('[data-activity-person]'))button.onclick=()=>filterActor(button.dataset.activityPerson);
  for(const button of list.querySelectorAll('[data-activity-locate]'))button.onclick=async()=>{
   try{await locate(rows[Number(button.dataset.activityLocate)].target);}catch(error){toast(errorText(error));}
  };
 }
 async function draw(){
  const token=++generation,{from,to,kind}=filters();
  try{
   if(from&&to&&from>to)throw Error('开始日期不得晚于结束日期。');
   list.setAttribute('aria-busy','true');
   const result=await loadNasPage({page,pageSize:30,from,to,...(actor?{actor}:{}),...(kind?{kind}:{})});
   if(token!==generation||!alive())return;
   const pages=Math.max(1,Math.ceil(result?.total/30));
   if(!Array.isArray(result?.rows)||!Number.isSafeInteger(result.page)||result.page<0||
      !Number.isSafeInteger(result.total)||result.total<0||result.pageSize!==30||
      result.rows.length>result.pageSize||result.page>=pages)throw Error('服务端操作记录分页返回不完整。');
   page=result.page;
   enhanced=Array.isArray(result.operators);
   const cleanupOpen=$('#activity-cleanup-open');
   cleanupOpen.hidden=!purgeNas||result.supportsPurge!==true;
   if(cleanupOpen.hidden)$('#activity-cleanup').hidden=true;
   $('#activity-kind-filter').hidden=!enhanced;
   $('#activity-rule').textContent=enhanced?'默认保留 30 天，服务端定时清理；成本同步已按次合并。日期按北京时间。':'日期按北京时间。当前 NAS 支持日期筛选和分页。';
   $('#activity-count').textContent=`共 ${result.total} 条记录`;
   renderOperators(result.operators);
   renderRows(result.rows.map(row=>nasActivityRow(row,shop?.id)));
   $('#activity-page').textContent=`${page+1} / ${pages}`;
   $('#activity-prev').disabled=page===0;$('#activity-next').disabled=page===pages-1;
  }catch(error){
   if(token!==generation||!alive())return;
   if((actor||kind)&&['NAS_ACTIVITY_NOT_INSTALLED','INVALID_REQUEST'].includes(error.code)){
    actor='';$('#activity-kind').value='';page=0;await draw();return;
   }
   toast(errorText(error));
  }finally{if(token===generation&&alive())list.setAttribute('aria-busy','false');}
 }
 const cleanup=$('#activity-cleanup'),scope=$('#activity-cleanup-scope');
 $('#activity-cleanup-open').onclick=()=>{cleanup.hidden=!cleanup.hidden;resetPreview();if(!cleanup.hidden)scope.focus();};
 scope.onchange=resetPreview;
 function cleanupFilters(){
  if(scope.value==='selected')return filters();
  if(scope.value==='all')return {};
  // 以北京时间当天零点为界，保留最近 7 或 30 个自然日（含今天）。
  return {to:priorDay(Number(scope.value))};
 }
 async function changeHistory(preview){
  if(purgeBusy||!purgeNas||(!preview&&!approved))return;
  const filter=preview?cleanupFilters():approved;
  if(filter.from&&filter.to&&filter.from>filter.to){toast('开始日期不得晚于结束日期。');return;}
  purgeBusy=true;scope.disabled=previewButton.disabled=confirmButton.disabled=true;
  const token=generation;
  status.textContent=preview?'正在计算清理范围…':'正在清理操作记录…';
  try{
   const result=await purgeNas({...Object.fromEntries(Object.entries(filter).filter(([,value])=>value)),dry_run:preview});
   if(!alive())return;
   if(![result?.audit_count,result?.receipt_count].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('清理回执不完整，请刷新记录核对。');
   if(preview){
    if(token!==generation||cleanup.hidden){resetPreview();return;}
    approved=filter;confirmButton.hidden=!(result.audit_count||result.receipt_count);
    status.textContent=`预计清理 ${result.audit_count} 条底层审计记录，可回收 ${result.receipt_count} 份过期回执。业务数据与近 24 小时的回执会保留。`;
   }else{
    resetPreview();
    status.textContent=`已清理 ${result.audit_count} 条底层审计记录，回收 ${result.receipt_count} 份过期回执。`;
    page=0;await draw();
   }
  }catch(error){if(alive()){resetPreview();status.textContent=errorText(error);}}
  finally{purgeBusy=false;if(alive())scope.disabled=previewButton.disabled=confirmButton.disabled=false;}
 }
 previewButton.onclick=()=>changeHistory(true);confirmButton.onclick=()=>changeHistory(false);
 for(const id of ['activity-from','activity-to','activity-kind'])$('#'+id).onchange=newFilter;
 for(const button of document.querySelectorAll('[data-activity-days]'))button.onclick=()=>{
  const days=Number(button.dataset.activityDays);
  $('#activity-from').value=days?priorDay(days-1):'';$('#activity-to').value=days?priorDay(0):'';newFilter();
 };
 $('#activity-prev').onclick=()=>{page--;void draw();};$('#activity-next').onclick=()=>{page++;void draw();};void draw();
}

/** 本机历史使用原有的分页接口与定位对象。 */
export function openActivity(options){
 if(options.loadNasPage)return openNasActivity(options);
 const {openDialog,esc,rows=[],request,locate,toast}=options;
 openDialog('操作记录','<p class="hint">保留最近 7 天。云端记录为其他成员已同步的修改；尚未同步的编辑不可见。</p><div class="inline-grid"><label class="field">开始日期<input id="activity-from" type="date"></label><label class="field">结束日期<input id="activity-to" type="date"></label></div><p id="activity-count" class="hint"></p><div id="activity-list"></div><div class="actions"><button id="activity-prev">上一页</button><span id="activity-page"></span><button id="activity-next">下一页</button></div>');
 const $=s=>document.querySelector(s),marker=$('#activity-list');let page=0,generation=0;
 const alive=()=>marker.isConnected&&$('#activity-list')===marker;
 const day=at=>new Date(at).toLocaleDateString('sv-SE');
 async function draw(){
  const token=++generation,from=$('#activity-from').value,to=$('#activity-to').value;
  try{
   let visible,total,pages;
   if(request){
    const result=await request('/api/activity?'+new URLSearchParams({page:String(page),pageSize:'30',from,to}));
    if(token!==generation||!alive())return;
    page=result.page;visible=result.rows;total=result.total;pages=Math.max(1,Math.ceil(total/result.pageSize));
   }else{
    const filtered=recentActivity(rows).filter(r=>(!from||day(r.at)>=from)&&(!to||day(r.at)<=to));
    total=filtered.length;pages=Math.max(1,Math.ceil(total/30));page=Math.min(page,pages-1);visible=filtered.slice(page*30,page*30+30);
   }
   $('#activity-count').textContent=`共 ${total} 条记录`;
   marker.innerHTML=visible.map((r,i)=>`<div class="list-card"><div><strong>${esc(r.message)}</strong><p>${esc(r.summary||'')}</p>
    ${r.preview?`<p>${esc(r.preview)}${r.preview.length>=80?'…':''}</p>`:''}
    <small>${r.origin==='cloud'?'云端同步 · 成员':'本地操作 · 操作人'}：${esc(r.operator||'历史记录未记录')} · ${esc(new Date(r.at).toLocaleString())}</small></div>
    ${r.target?`<button data-activity-locate="${i}">定位修改</button>`:'<small>旧记录无定位信息</small>'}</div>`).join('')||'<p class="hint">所选日期暂无操作记录。</p>';
   for(const b of document.querySelectorAll('[data-activity-locate]'))b.onclick=async()=>{
    try{await locate(visible[Number(b.dataset.activityLocate)].target);}catch(error){toast(error.message);}
   };
   $('#activity-page').textContent=`${page+1} / ${pages}`;
   $('#activity-prev').disabled=page===0;$('#activity-next').disabled=page===pages-1;
  }catch(error){if(token===generation&&alive())toast(error.message);}
 }
 for(const id of ['activity-from','activity-to'])$('#'+id).onchange=()=>{page=0;void draw();};
 $('#activity-prev').onclick=()=>{page--;void draw();};$('#activity-next').onclick=()=>{page++;void draw();};void draw();
}
