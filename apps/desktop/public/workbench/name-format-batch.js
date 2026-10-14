/** 批量配置命名：区分自动名称与手工名称，预览确认后再应用命名方案。 */
import {suggestedName} from './legacy-names.js';
import {syncPosterShortName} from './short-name-poster.js';

export const NAME_FORMATS=[['compact','格式二：CPU＋显卡＋内存＋硬盘'],['default','格式一：CPU丨显卡 版本']];
const namingInput=c=>JSON.stringify({id:c.id,shopId:c.shopId,deletedAt:c.deletedAt,name:c.name,version:c.version,shortName:c.shortName,nameFormat:c.nameFormat,shortNameAuto:c.shortNameAuto,parts:(c.parts||[]).map(({slot,name,goodsId,qty})=>({slot,name,goodsId,qty}))});
const manualName=c=>c.shortNameAuto!==true&&Boolean(String(c.shortName||'').trim());

/** 按店铺、格式和是否覆盖手工名称生成修改计划。 */
export function nameFormatPlan(configs,{format='compact',replaceManual=false,shopId}={}){
 if(!NAME_FORMATS.some(([value])=>value===format))throw Error('请选择已有的简称格式');
 if(!configs.length)throw Error('请先勾选配置');
 const shop=shopId??configs[0].shopId,ids=new Set();
 const rows=configs.map(c=>{
  if(c.deletedAt||c.shopId!==shop||ids.has(c.id))throw Error('配置范围已变化，请重新选择当前店铺的配置');
  ids.add(c.id);
  const preserved=manualName(c)&&!replaceManual,after=preserved?c.shortName:suggestedName(c,format);
  return {id:c.id,name:c.name,product:c.product,before:c.shortName||'',after,preserved,baseline:namingInput(c),changed:!preserved&&(c.shortName!==after||c.nameFormat!==format||c.shortNameAuto!==true)};
 });
 return {shopId:shop,format,replaceManual,rows};
}

/** 应用前核验计划的输入配置没有发生变化。 */
export function validateNameFormatPlan(plan,configs){
 const byId=new Map(configs.map(c=>[c.id,c]));
 for(const row of plan.rows){const c=byId.get(row.id);if(!c||c.deletedAt||c.shopId!==plan.shopId||namingInput(c)!==row.baseline)throw Error('配置或简称已变化，请重新预览');}
}

/** 将已核验的新名称写入目标配置。 */
export function applyNameFormatPlan(plan,configs){
 validateNameFormatPlan(plan,configs);
 const byId=new Map(configs.map(c=>[c.id,c])),ids=[];
 for(const row of plan.rows){if(row.preserved)continue;const c=byId.get(row.id);Object.assign(c,{shortName:row.after,nameFormat:plan.format,shortNameAuto:true});syncPosterShortName(c);ids.push(c.id);}
 return ids;
}

// Both creation dialogs and the selected-config editor require a current preview.
/** 绑定命名参数和预览失效状态，防止改参数后误用旧预览。 */
export function mountNameFormatPreview(container,{getConfigs,shopId,esc,toast,format='compact',scope='本次配置',requirePreview=true,onPreview=()=>{},onInvalidate=()=>{}}){
 container.innerHTML=`<p class="hint">${esc(scope)}：${requirePreview?'选择简称格式并预览':'创建时使用所选简称格式，可先预览'}。配置名称、版本、SPU、SKU 保持原值。</p><label class="field">简称格式<select data-batch-name-format>${NAME_FORMATS.map(([value,label])=>`<option value="${value}" ${value===format?'selected':''}>${esc(label)}</option>`).join('')}</select></label><label class="field"><span><input type="checkbox" data-batch-name-manual> 同时重新生成手动填写的简称</span><small>默认保留手动简称；勾选后按所选格式重新生成。</small></label><button type="button" data-batch-name-preview>预览简称</button><p class="hint" data-batch-name-status role="status"></p><div data-batch-name-results></div>`;
 const $=selector=>container.querySelector(selector);let plan=null;
 const options=()=>({format:$('[data-batch-name-format]').value,replaceManual:$('[data-batch-name-manual]').checked,shopId});
 const invalidate=()=>{plan=null;$('[data-batch-name-status]').textContent='内容已变化，请重新预览简称';$('[data-batch-name-results]').innerHTML='';onInvalidate();};
 for(const selector of ['[data-batch-name-format]','[data-batch-name-manual]'])$(selector).onchange=invalidate;
 const preview=()=>{try{plan=nameFormatPlan(getConfigs(),options());const kept=plan.rows.filter(r=>r.preserved).length;$('[data-batch-name-status]').textContent=`共 ${plan.rows.length} 套配置；生成 ${plan.rows.length-kept} 个简称${kept?`，保留 ${kept} 个手动简称`:''}。核对后再应用。`;$('[data-batch-name-results]').innerHTML=`<div class="wps-table-wrap"><table class="wps-table"><thead><tr><th>配置</th><th>原简称</th><th>应用后简称</th></tr></thead><tbody>${plan.rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.before||'（空）')}</td><td>${esc(r.after)}${r.preserved?'<small>保留手动简称</small>':''}</td></tr>`).join('')}</tbody></table></div>`;onPreview(plan);return plan;}catch(error){plan=null;toast(error.message);return null;}};
 $('[data-batch-name-preview]').onclick=preview;
 return {preview,invalidate,read(){if(!requirePreview)return nameFormatPlan(getConfigs(),options());if(!plan)throw Error('请先预览简称，核对后再应用');validateNameFormatPlan(plan,getConfigs());return plan;}};
}

/** 打开批量命名界面，由调用方完成业务保存。 */
export function openNameFormatBatch({openDialog,closeDialog,esc,toast,getConfigs,shopId,apply,scope,format}){
 openDialog('批量修改简称格式','<div id="batch-name-format-mount"></div><div class="actions"><button id="batch-name-format-apply" class="primary" disabled>应用预览中的简称</button></div>');
 const button=document.querySelector('#batch-name-format-apply'),mount=document.querySelector('#batch-name-format-mount');
 const control=mountNameFormatPreview(mount,{getConfigs,shopId,esc,toast,scope,format,onPreview:plan=>button.disabled=!plan.rows.some(r=>!r.preserved),onInvalidate:()=>button.disabled=true});
 button.onclick=()=>{try{const plan=control.read();apply(plan);closeDialog();}catch(error){button.disabled=true;toast(error.message);}};
}

export function mountNameFormatEntry(open){
 const input=document.querySelector('[data-config="name"]');if(!input||document.querySelector('#batch-name-formats'))return;
 const button=document.createElement('button');button.type='button';button.id='batch-name-formats';button.textContent='批量修改简称格式';button.onclick=open;input.after(button);
}
