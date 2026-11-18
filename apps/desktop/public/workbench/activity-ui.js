/** 操作记录弹窗：分页读取记录，并提供定位相关配置的入口。 */
import {recentActivity} from './activity.js';
const nasKinds={configurations:['配置','configuration'],sources:['输出源','source'],costs:['成本与库存','component'],
 addons:['加购','source'],gallery:['机箱图库','gallery'],templates:['配置模板','template'],settings:['店铺设置','settings'],
 quotations:['维护表报价','quotation'],assets:['原图',null]};
const nasActions={create:'新增',replace:'修改',design:'调整样式',archive:'移入回收站',restore:'恢复',copy:'复制',apply:'应用',
 upload:'上传',erp_snapshot:'同步 ERP',tax_file:'导入含税成本',tax_edit:'修改含税成本',select_workbook:'确认维护表价格',
 publish:'向销售发布',withdraw:'撤回销售发布'};

/** 用 NAS 已有审计字段恢复可读的记录；服务端没有细分字段或成员名时不猜测。 */
function nasActivityRow(row){
 if(!row||typeof row.kind!=='string'||typeof row.resource_id!=='string'||typeof row.created_at!=='string'||
    !Number.isFinite(Date.parse(row.created_at)))throw Error('服务端操作记录返回不完整。');
 const [label,type]=Object.hasOwn(nasKinds,row.kind)?nasKinds[row.kind]:['工作区资料',null];
 const action=Object.hasOwn(nasActions,row.action)?nasActions[row.action]:'维护';
 const version=/^[1-9]\d{0,18}$/.test(row.next_version??'')?' · 版本 '+row.next_version:'';
 return {message:`${action} · ${label}`,summary:(typeof row.resource_name==='string'&&row.resource_name||row.resource_id)+version,
  at:row.created_at,origin:'nas',operator:typeof row.operator==='string'?row.operator:'',
  target:type?{type,id:row.resource_id,shopId:'intel',...(type==='component'?{goodsId:row.resource_id}:{})}:null};
}
/** 将只读记录查询与配置定位交给调用方，弹窗本身不改变业务数据。 */
export function openActivity({openDialog,esc,rows=[],request,loadNasPage,locate,toast}){
 const hint=loadNasPage?'展示 NAS 工作区已保存的操作，日期按北京时间。旧工作台本机记录未迁入，定位打开当前版本。':'保留最近 7 天。云端记录为其他成员已同步的修改；尚未同步的编辑不可见。摘要不展开完整内容，定位显示当前版本。';
 openDialog('操作记录',`<p class="hint">${hint}</p><div class="inline-grid"><label class="field">开始日期<input id="activity-from" type="date"></label><label class="field">结束日期<input id="activity-to" type="date"></label></div><p id="activity-count" class="hint"></p><div id="activity-list"></div><div class="actions"><button id="activity-prev">上一页</button><span id="activity-page"></span><button id="activity-next">下一页</button></div>`);
 const marker=document.querySelector('#activity-list'),$=s=>document.querySelector(s);let page=0,generation=0;const alive=()=>marker.isConnected&&document.querySelector('#activity-list')===marker;const day=at=>{const d=new Date(at);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 const stamp=r=>r.origin==='nas'?new Date(r.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hourCycle:'h23'}):new Date(r.at).toLocaleString();
 async function draw(){const token=++generation;try{const from=$('#activity-from').value,to=$('#activity-to').value;let visible,total,pages;
  if(loadNasPage||request){
   if(loadNasPage&&from&&to&&from>to)throw Error('开始日期不得晚于结束日期。');
   const result=loadNasPage?await loadNasPage({page,pageSize:30,from,to}):await request('/api/activity?'+new URLSearchParams({page:String(page),pageSize:'30',from,to}));
   if(token!==generation||!alive())return;
   if(loadNasPage&&(!Array.isArray(result?.rows)||!Number.isSafeInteger(result.page)||result.page<0||
      !Number.isSafeInteger(result.total)||result.total<0||result.pageSize!==30||result.rows.length>result.pageSize||
      result.page>=Math.max(1,Math.ceil(result.total/result.pageSize))))throw Error('服务端操作记录分页返回不完整。');
   page=result.page;visible=loadNasPage?result.rows.map(nasActivityRow):result.rows;total=result.total;pages=Math.max(1,Math.ceil(total/result.pageSize));
  }else{const filtered=recentActivity(rows).filter(r=>(!from||day(r.at)>=from)&&(!to||day(r.at)<=to));total=filtered.length;pages=Math.max(1,Math.ceil(total/30));page=Math.min(page,pages-1);visible=filtered.slice(page*30,page*30+30);}
 $('#activity-count').textContent=`共 ${total} 条记录`;$('#activity-list').innerHTML=visible.map((r,i)=>`<div class="list-card"><div><strong>${esc(r.message)}</strong><p>${esc(r.summary||'')}</p>${r.preview?`<p>${esc(r.preview)}${r.preview.length>=80?'…':''}</p>`:''}<small>${r.origin==='nas'?'操作人':r.origin==='cloud'?'云端同步 · 成员':'本地操作 · 操作人'}：${esc(r.operator||(r.origin==='nas'?'未记录':'历史记录未记录'))} · ${esc(stamp(r))}</small></div>${r.target?`<button data-activity-locate="${i}">定位修改</button>`:`<small>${loadNasPage?'此记录没有可定位的编辑位置':'旧记录无定位信息'}</small>`}</div>`).join('')||'<p class="hint">所选日期暂无操作记录。</p>';
 for(const b of document.querySelectorAll('[data-activity-locate]'))b.onclick=async()=>{try{await locate(visible[Number(b.dataset.activityLocate)].target);}catch(e){toast(e.message);}};
 $('#activity-page').textContent=`${page+1} / ${pages}`;$('#activity-prev').disabled=page===0;$('#activity-next').disabled=page===pages-1;
 }catch(error){if(token===generation&&alive())toast(error.message);}}
 for(const id of ['activity-from','activity-to'])$('#'+id).onchange=()=>{page=0;draw();};$('#activity-prev').onclick=()=>{page--;draw();};$('#activity-next').onclick=()=>{page++;draw();};draw();
}
