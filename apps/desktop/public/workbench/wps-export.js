import {slots} from './core.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=value=>String(value??'').replace(/[\t\r\n]+/g,' ');
const safeText=value=>/^[=+@-]/.test(text(value))?"'"+text(value):text(value);

// WPS 原模板：表头、定价、八项主配件、分隔、六项附件、分隔、空行。
export function wpsExport(configs,{layout='FH',startRow=1}={}){
 if(layout!=='FH')throw Error('仅支持 F:H 导出');
 startRow=Number(startRow);
 if(!Number.isSafeInteger(startRow)||startRow<1)throw Error('目标起始行必须为正整数');
 if(!configs.length)throw Error('没有可导出的配置');
 const rows=[],blocks=[];
 for(const config of configs){
  const parts=config.parts||[],used=new Set();
  const core=slots.slice(0,8).map(slot=>{const i=parts.findIndex((p,i)=>p.slot===slot&&!used.has(i));if(i>=0)used.add(i);return{part:parts[i],category:slot};});
  const extra=parts.filter((p,i)=>!used.has(i)&&(p.displayName||p.name)).map(p=>({part:p,category:p.slot==='风扇'?'风扇':'配件'}));
  while(extra.length<6)extra.push({category:extra.length<2?'风扇':'配件'});
  const base=startRow+rows.length,block=[];
  const add=(values,kind='part')=>block.push({values,kind});
  const price=config.price;
  if(price!==''&&price!=null&&(!Number.isFinite(Number(price))||Number(price)<0))throw Error(`${config.name||'配置'}的到手价无效`);
  add(['','定价',''],'header');
  add(['数量',price===''||price==null?'':Number(price),''],'summary');
  const partRow=({part,category})=>{
   const name=part?.displayName||part?.name||'',qty=name?Number(part.qty):'';
   if(name&&(!Number.isSafeInteger(qty)||qty<1))throw Error(`${config.name||'配置'} / ${category}的数量必须为正整数`);
   add([qty,category,text(name)]);
  };
  core.forEach(partRow);
  add(['','',''],'separator');
  extra.forEach(partRow);
  add(['','',''],'separator');add(['','',''],'blank');
  blocks.push({name:config.name||'未命名配置',startRow:base,rowCount:block.length});rows.push(...block);
 }
 if(startRow+rows.length-1>1048576)throw Error('导出区域超出 WPS 工作表行数上限');
 const tsv=rows.map(r=>r.values.map(v=>typeof v==='number'?v:safeText(v)).join('\t')).join('\r\n');
 // 仅用于对话框预览，复制始终使用纯文本，避免覆盖 WPS 模板样式。
 const previewHtml=`<table style="border-collapse:collapse;font-family:Microsoft YaHei;font-size:14pt">${rows.map(r=>`<tr>${r.values.map((v,i)=>`<td style="border:1px solid #d9d9d9;vertical-align:middle;${['header','summary'].includes(r.kind)&&i===1?'background:#ffff00;color:#ff0000;text-align:center;':''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
 return{rows,blocks,tsv,previewHtml,startRow,endRow:startRow+rows.length-1,layout:'FH'};
}

export async function copyWpsExport(result){
 if(navigator.clipboard?.writeText){
  try{await navigator.clipboard.writeText(result.tsv);return;}catch{}
 }
 if(globalThis.ClipboardItem&&navigator.clipboard?.write){
  try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([result.tsv],{type:'text/plain'})})]);return;}catch{}
 }
 let copied=false;
 const handler=e=>{if(!e.clipboardData)return;e.preventDefault();e.clipboardData.setData('text/plain',result.tsv);copied=true;};
 document.addEventListener('copy',handler);
 try{if(!document.execCommand('copy')||!copied)throw Error('当前环境未允许复制，请允许剪贴板访问后重试');}finally{document.removeEventListener('copy',handler);}
}

export function openWpsExport(configs,{openDialog,selectedIds=null}){
 const initial=selectedIds===null?null:new Set(selectedIds);
 openDialog('导出回 WPS',`<p class="hint">当前链接 ${configs.length} 套配置，勾选后按工作台原顺序连续导出。“定价”使用工作台到手价。导出范围为 F:H，包含数量、分类和展示名称，保留 WPS 原模板格式。</p><div class="actions"><button id="wps-export-all">全选配置</button><button id="wps-export-none">清空选择</button><span id="wps-export-count"></span></div><div style="max-height:180px;overflow:auto;margin:12px 0">${configs.map((c,i)=>`<label style="display:flex;align-items:center;gap:8px;margin:6px 0"><input type="checkbox" data-wps-export-index="${i}" ${initial===null||initial.has(c.id)?'checked':''} style="width:auto"><span>${esc(c.name||'未命名配置')}${c.version?' · '+esc(c.version):''} · 到手价 ${c.price==null||c.price===''?'未填写':'¥'+esc(c.price)}</span></label>`).join('')}</div><div class="inline-grid"><label class="field">目标起始行<input id="wps-export-row" type="number" min="1" step="1" value="1"></label></div><p id="wps-export-hint" class="hint"></p><button id="wps-export-copy" class="primary">复制到 WPS</button><p id="wps-export-status" class="hint" role="status"></p><div id="wps-export-preview" style="overflow:auto;max-height:420px;margin-top:12px" tabindex="0" aria-label="WPS 导出预览"></div>`);
 const $=s=>document.querySelector(s);let result;
 const refresh=()=>{try{
  const chosen=configs.filter((c,i)=>$(`[data-wps-export-index="${i}"]`).checked);
  $('#wps-export-count').textContent=`已选 ${chosen.length} / ${configs.length} 套`;
  if(!chosen.length)throw Error('请至少勾选一套配置');
  result=wpsExport(chosen,{startRow:$('#wps-export-row').value});
  $('#wps-export-hint').textContent=`在 WPS 选中 F${result.startRow} 后粘贴，覆盖至 H${result.endRow}。直接 Ctrl+V 粘贴内容，保留 WPS 原模板的字体、底色与分隔行格式。每套通常 19 行，超过六项附件时自动增加行数。`;
  $('#wps-export-preview').innerHTML=result.previewHtml.slice(result.previewHtml.indexOf('<table'),result.previewHtml.indexOf('</table>')+8);
  $('#wps-export-status').textContent=result.blocks.map(b=>`${b.name}：第 ${b.startRow} 行起（${b.rowCount} 行）`).join('；');
  $('#wps-export-copy').disabled=false;
 }catch(e){result=null;$('#wps-export-copy').disabled=true;$('#wps-export-status').textContent=e.message;$('#wps-export-preview').innerHTML='';$('#wps-export-hint').textContent='';}};
 const boxes=[...document.querySelectorAll('[data-wps-export-index]')];
 boxes.forEach(box=>box.onchange=refresh);
 $('#wps-export-all').onclick=()=>{boxes.forEach(box=>box.checked=true);refresh();};
 $('#wps-export-none').onclick=()=>{boxes.forEach(box=>box.checked=false);refresh();};
 $('#wps-export-row').oninput=refresh;
 $('#wps-export-copy').onclick=async()=>{if(!result)return;const current=result;try{await copyWpsExport(current);$('#wps-export-status').textContent=`已复制 ${current.blocks.length} 套配置，请粘贴到 WPS 的 F${current.startRow}。`;}catch(e){$('#wps-export-status').textContent=e.message;}};
 refresh();
}
