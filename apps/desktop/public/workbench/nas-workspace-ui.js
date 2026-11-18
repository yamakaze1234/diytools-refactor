/** 独立 NAS 试验编辑入口；页面不会回写本机配置或触发旧同步。 */
import {createNasApiClient,NasApiError} from './nas-api-client.js';
import {createNasDraftController} from './nas-draft-controller.js';

const text={
 FORBIDDEN:'这个账号没有英特尔运营权限。',UNAUTHENTICATED:'请先使用工作台账号登录。',
 WRITES_DISABLED:'当前试验接口只读。',VERSION_CONFLICT:'服务器上的配置已修改。本机草稿已保留，请先查看服务器版本。',
 DEPENDENCY_CONFLICT:'关联的配件来源或成本已修改，本机草稿已保留。',SAVE_STATUS_UNKNOWN:'服务器是否已保存尚未确认。请查询上次提交结果。',
 RECEIPT_NOT_FOUND:'暂未查到回执。可稍后查询，或使用原编号重试。',REQUEST_TIMEOUT:'连接超时，草稿仍保留在本机。',
 NETWORK_OR_RESPONSE_ERROR:'暂时连不上 NAS，草稿仍保留在本机。',NO_CHANGES:'当前草稿没有修改。',
 DRAFT_STORAGE_UNAVAILABLE:'本机草稿存储不可用，请保存自己的修改副本。',MEMBER_CHANGED:'登录成员已变更，请关闭页面后重新打开。',
 QUOTATION_REVIEW_REQUIRED:'该配置已有维护表报价，修改 SPU 或 SKU 前需要重新核价。',
 INVALID_DEPENDENCY:'选择的配件来源不可用。',VALIDATION_FAILED:'请检查编辑内容。',
 UNSAVED_DRAFT:'这套配置还有未提交的草稿，请先保存或放弃。',
};
const readable=error=>{const message=text[error.code]||'操作未完成，请核对网络和当前账号。';return error.details?.field?message+' 字段：'+error.details.field:message;};

export async function installNasWorkspace({openDialog,esc,notify}){
 const button=document.getElementById('nas-workspace');
 if(!button)return;
 const nativeRequest=(path,options)=>fetch('/api/native-nas'+path,options);
 let settings;
 try{
  const value=await nativeRequest('/settings',{method:'GET',cache:'no-store'});
  settings=await value.json();
  if(!value.ok||!settings.configured||typeof settings.endpoint_id!=='string')return;
 }catch{return;}
 button.hidden=false;
 button.onclick=async()=>{
  const api=createNasApiClient({nativeRequest});
  const draft=createNasDraftController({client:api,storage:localStorage,endpointId:settings.endpoint_id});
  const dialog=document.getElementById('dialog');
  const body=document.getElementById('dialog-body');
  const title='英特尔 · NAS 试验工作区';
  openDialog(title,'<p class="hint" data-nas-message role="status">正在核对成员和店铺权限…</p>');
  const session={};dialog.nasSession=session;
  const active=()=>dialog.open&&dialog.nasSession===session&&document.getElementById('dialog-title')?.textContent===title;
  const status=message=>{if(!active())return;const el=body.querySelector('[data-nas-message]');if(el)el.textContent=message;};
  let previousQuery='',offset=0,archived=false,entry=null,canWrite=false,busy=false;
  const click=(type,action)=>{const el=body.querySelector('[data-nas-'+type+']');if(el)el.onclick=action;};
  const guarded=action=>async event=>{
   event?.preventDefault?.();if(busy)return;
   busy=true;
   const actionButton=event?.currentTarget;
   if(actionButton)actionButton.disabled=true;
   try{if(active())await action(event);}
   catch(error){if(active())status(readable(error));}
   finally{busy=false;if(actionButton?.isConnected)actionButton.disabled=false;}
  };
  const list=async()=>{
   if(!active())return;
   entry=null;
   body.innerHTML='<p class="hint" data-nas-message role="status">正在加载 NAS 配置…</p>';
   const rows=await api.list({limit:50,offset,search:previousQuery,archived});
   if(!active())return;
   const local=draft.drafts();
   body.innerHTML='<div class="actions"><label class="field">搜索配置<input data-nas-search value="'+esc(previousQuery)+'" placeholder="名称 / SPU / SKU"></label>'+
    '<button data-nas-find>查找</button><button data-nas-archived>'+(archived?'显示启用配置':'查看已归档')+'</button>'+
    (canWrite&&!archived?'<button data-nas-new>新建配置</button>':'')+'</div>'+
    '<p class="hint" data-nas-message role="status">'+(canWrite?'更改先保留为本机草稿，点击保存后才提交到 NAS。':'当前只读，可查看 NAS 中的完整配置。')+'</p>'+
    (local.length?'<div class="overview-list"><strong>本机草稿</strong>'+local.map(row=>'<div class="list-card"><div><strong>'+esc(row.name||'未命名配置')+
    '</strong><small>'+(row.pending?'等待核对提交结果':'待提交')+'</small></div><button data-nas-open="'+esc(row.id)+'" data-local>继续</button></div>').join('')+'</div>':'')+
    '<div class="overview-list">'+(rows.length?rows.map(row=>'<div class="list-card"><div><strong>'+esc(row.name)+'</strong>'+
      '<small>SPU '+esc(row.spu||'未录入')+' · SKU '+esc(row.sku_id||'未录入')+' · '+esc(row.final_price_cents===null?'缺维护表价':'¥'+(Number(row.final_price_cents)/100).toFixed(2))+'</small></div>'+
      '<button data-nas-open="'+esc(row.configuration_id)+'">查看配置</button></div>').join(''):'<p class="hint">没有符合的配置。</p>')+'</div>'+
    '<div class="actions"><button data-nas-prev '+(offset?'':'disabled')+'>上一页</button><button data-nas-next '+(rows.length===50?'':'disabled')+'>下一页</button></div>';
   click('find',guarded(()=>{previousQuery=body.querySelector('[data-nas-search]').value.trim();offset=0;return list();}));
   body.querySelector('[data-nas-search]').onkeydown=event=>{if(event.key==='Enter')body.querySelector('[data-nas-find]').click();};
   click('archived',guarded(()=>{archived=!archived;offset=0;return list();}));
   click('new',guarded(async()=>{
    const id=crypto.randomUUID();
    const record=await draft.create({id,shopId:'intel',productId:crypto.randomUUID(),workspaceOrder:Date.now(),name:'新建配置',
     version:'',product:'新建链接',spu:'',skuId:'',price:0,parts:[],actualParts:[],addons:[]});
    entry=null;show(record,'新建草稿仅保存在本机。');
   }));
   click('prev',guarded(()=>{offset=Math.max(0,offset-50);return list();}));
   click('next',guarded(()=>{offset+=50;return list();}));
   for(const el of body.querySelectorAll('[data-nas-open]'))el.onclick=guarded(async()=>{
    const result=await draft.open(el.dataset.nasOpen,{archived:el.hasAttribute('data-local')?false:archived});entry=result.remote;
    show(result.record);
   });
  };
  function show(record,message=''){
   if(!active())return;
   const doc=record.document,pending=!!record.pending;
   const edit=canWrite&&!archived&&!pending;
   const field=(label,key,type='text')=>'<label class="field">'+label+'<input data-nas-field="'+key+'" type="'+type+'" '+(type==='number'?'min="0" step="0.01" ':'')+
    (edit?'':'readonly ' )+'value="'+esc(doc[key]??'')+'"></label>';
   const documents='<details><summary>完整配置</summary><label class="field">配件、加购与图片格式<textarea data-nas-document rows="10" '+(edit?'':'readonly')+'></textarea></label>'+
    (edit?'<button data-nas-apply-doc>应用完整配置到草稿</button>':'')+'</details>';
   body.innerHTML='<div class="actions"><button data-nas-back>返回列表</button><strong>'+esc(doc.name)+'</strong></div>'+
    '<p class="hint" data-nas-message role="status"></p>'+
    '<div class="field-grid">'+field('配置名称','name')+field('配置版本名称','version')+field('SPU','spu')+field('SKU','skuId')+
    field('工作台售价','price','number')+'</div>'+documents+
    '<div class="actions">'+(pending?'<button data-nas-receipt class="primary">查询提交结果</button><button data-nas-retry>重试原提交</button>':
     (edit?'<button data-nas-save class="primary">保存到 NAS</button>':'')+(canWrite?'<button data-nas-archive>'+(archived?'恢复配置':'归档配置')+'</button>':''))+
    (record.version?'<button data-nas-compare>查看服务器版本</button>':'')+'</div><div data-nas-diff></div>';
   const complete=body.querySelector('[data-nas-document]');
   complete.value=JSON.stringify(doc,null,2);
   status(message||(pending?text.SAVE_STATUS_UNKNOWN:entry?.version!==record.version&&entry?'服务器版本已更新，本机草稿已保留。':entry?.final_price_cents===null?'维护表到手价缺失。':''));
   for(const input of body.querySelectorAll('[data-nas-field]'))input.oninput=()=>{
    if(busy||!edit)return;
    try{
     const key=input.dataset.nasField,live=draft.read().document;
     const value=input.type==='number'?(input.value===''?null:input.valueAsNumber):input.value;
     const next={...live,[key]:value};
     draft.edit(next);complete.value=JSON.stringify(next,null,2);status('草稿已保存在本机。');
    }catch(error){status(readable(error));}
   };
   click('apply-doc',guarded(()=>{
    let next;try{next=JSON.parse(complete.value);}catch{status('完整配置内容不完整，请检查后再应用。');return;}
    if(!next||!Array.isArray(next.parts)||!Array.isArray(next.actualParts)||!Array.isArray(next.addons))throw new NasApiError('VALIDATION_FAILED');
    show(draft.edit(next),'完整配置已保存到本机草稿。');
   }));
   click('back',guarded(list));
   click('save',guarded(async()=>{
    try{await draft.save();show(draft.read(),'已保存到 NAS。');}
    catch(error){if(draft.read()?.pending)show(draft.read(),readable(error));else status(readable(error));}
   }));
   click('receipt',guarded(async()=>{await draft.receipt();show(draft.read(),'已确认保存到 NAS。');}));
   click('retry',guarded(async()=>{
    if(!window.confirm('确认重试原提交？只使用原编号和原内容。'))return;
    try{await draft.retry();show(draft.read(),'已确认原提交结果。');}
    catch(error){show(draft.read(),readable(error));}
   }));
   click('archive',guarded(async()=>{
    if(!window.confirm(archived?'恢复这套配置？':'归档这套配置后，它将从启用列表和销售接口移除。确定归档？'))return;
    try{await draft.save(archived?'restore':'archive');await list();}
    catch(error){if(draft.read()?.pending)show(draft.read(),readable(error));else status(readable(error));}
   }));
   click('compare',guarded(async()=>{
    const comparison=await draft.compare();if(!active())return;
    const target=body.querySelector('[data-nas-diff]');
    target.replaceChildren();
    const description=document.createElement('p');description.className='hint';description.textContent='服务器版本：'+comparison.remote.version+'。本机草稿未改变。';target.append(description);
    const remote=document.createElement('textarea');remote.readOnly=true;remote.rows=9;remote.setAttribute('aria-label','服务器完整配置');remote.value=JSON.stringify(comparison.remote.document,null,2);target.append(remote);
    if(!pending){
     const discard=document.createElement('button');discard.textContent='放弃草稿并载入服务器版本';
     discard.onclick=()=>{if(window.confirm('确定放弃本机草稿并载入服务器版本？'))show(draft.abandonForRemote());};target.append(discard);
    }
   }));
  }
  try{canWrite=(await draft.verify()).configuration_writes===true;if(active())await list();}
  catch(error){if(active())status(readable(error));else notify?.(readable(error));}
 };
}
