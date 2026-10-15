import {slots} from './core.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=value=>String(value??'').replace(/[\t\r\n]+/g,' ');
const safeText=value=>/^[=+@-]/.test(text(value))?"'"+text(value):text(value);

// WPS 原模板：表头、汇总、八项主配件、分隔、六项附件、分隔、空行。
export function wpsExport(configs,{layout='FH',startRow=1}={}){
 if(!['FH','EH'].includes(layout))throw Error('请选择 F:H 或 E:H 布局');
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
  const add=(values,kind='part',formula=false)=>block.push({values,kind,formula});
  if(layout==='EH'){
   add(['ERP利润','','到手价',''],'header');
   const price=config.price;
   if(price!==''&&price!=null&&(!Number.isFinite(Number(price))||Number(price)<0))throw Error(`${config.name||'配置'}的到手价无效`);
   add([`=G${base+1}*0.98-A${base+1}`,'',price===''||price==null?'':Number(price),''],'summary',true);
  }else{add(['数量','',''],'header');add(['','',''],'summary');}
  const partRow=({part,category})=>{
   const name=part?.displayName||part?.name||'',qty=name?Number(part.qty):'';
   if(name&&(!Number.isSafeInteger(qty)||qty<1))throw Error(`${config.name||'配置'} / ${category}的数量必须为正整数`);
   add(layout==='EH'?[qty,'',category,text(name)]:[qty,category,text(name)]);
  };
  core.forEach(partRow);
  add(layout==='EH'?['','','','']:['','',''],'separator');
  extra.forEach(partRow);
  add(layout==='EH'?['','','','']:['','',''],'separator');
  add(layout==='EH'?['','','','']:['','',''],'blank');
  blocks.push({name:config.name||'未命名配置',startRow:base,rowCount:block.length});rows.push(...block);
 }
 if(startRow+rows.length-1>1048576)throw Error('导出区域超出 WPS 工作表行数上限');
 const tsv=rows.map(r=>r.values.map((v,i)=>r.formula&&i===0?v:typeof v==='number'?v:safeText(v)).join('\t')).join('\r\n');
 const rich=layout==='EH';
 const html=`<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse;font-family:Microsoft YaHei;font-size:14pt">${rows.map(r=>`<tr style="height:23pt">${r.values.map((v,i)=>{
  let style='border:1px solid #d9d9d9;vertical-align:middle;';
  if(rich){
   style+=i===0?'background:#ffffcc;text-align:center;width:60px;':i===1?'width:8px;':i===2?'width:85px;text-align:center;':'width:480px;';
   if(['header','summary'].includes(r.kind))style+=i===0?'background:#000;color:#ffff00;':i===2?'background:#ffff00;color:#ff0000;':'background:#000;';
   if(r.kind==='separator'&&i>=2)style+='background:#000;';
  }
  const formula=r.formula&&i===0;
  const attr=formula?' x:f="=RC[2]*0.98-RC[-4]"':typeof v==='number'?` x:num="${v}"`:' x:str';
  if(!formula&&typeof v!=='number')style+="mso-number-format:'\\@';";
  return `<td${attr} style="${style}">${esc(v)}</td>`;
 }).join('')}</tr>`).join('')}</table></body></html>`;
 return{rows,blocks,tsv,html,startRow,endRow:startRow+rows.length-1,layout};
}

export async function copyWpsExport(result){
 // 同时提交 HTML 与纯文本；E:H 不降级成丢失格式的 writeText。
 if(globalThis.ClipboardItem&&navigator.clipboard?.write){
  try{await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([result.html],{type:'text/html'}),'text/plain':new Blob([result.tsv],{type:'text/plain'})})]);return;}catch{}
 }
 let copied=false;
 const handler=e=>{if(!e.clipboardData)return;e.preventDefault();e.clipboardData.setData('text/html',result.html);e.clipboardData.setData('text/plain',result.tsv);copied=true;};
 document.addEventListener('copy',handler);
 try{if(!document.execCommand('copy')||!copied)throw Error('当前环境未允许复制，请在下方预览中选中表格后按 Ctrl+C');}finally{document.removeEventListener('copy',handler);}
}

export function openWpsExport(configs,{openDialog}){
 openDialog('导出回 WPS',`<p class="hint">导出当前链接全部 ${configs.length} 套配置，顺序与工作台一致。配件使用展示名称，不包含 ERP ID、成本和加购说明。</p><div class="inline-grid"><label class="field">目标布局<select id="wps-export-layout"><option value="FH">F:H：数量 / 分类 / 展示名称</option><option value="EH">E:H：格式、到手价与 ERP 利润公式</option></select></label><label class="field">目标起始行<input id="wps-export-row" type="number" min="1" step="1" value="1"></label></div><p id="wps-export-hint" class="hint"></p><button id="wps-export-copy" class="primary">复制到 WPS</button><p id="wps-export-status" class="hint" role="status"></p><div id="wps-export-preview" style="overflow:auto;max-height:420px;margin-top:12px" tabindex="0" aria-label="WPS 导出预览"></div>`);
 const $=s=>document.querySelector(s);let result;
 const refresh=()=>{try{
  result=wpsExport(configs,{layout:$('#wps-export-layout').value,startRow:$('#wps-export-row').value});
  const rich=result.layout==='EH';
  $('#wps-export-hint').textContent=`在 WPS 选中 ${rich?'E':'F'}${result.startRow} 后粘贴，覆盖至 H${result.endRow}。${rich?'使用普通粘贴保留格式；ERP 利润按到手价 × 0.98 − 同行 A 列计算，A 列需已有 ERP 总成本。':'建议选择“仅粘贴值”保留原表格式。'}每套通常 19 行，超过六项附件时自动增加行数。`;
  $('#wps-export-preview').innerHTML=result.html.slice(result.html.indexOf('<table'),result.html.indexOf('</table>')+8);
  $('#wps-export-status').textContent=result.blocks.map(b=>`${b.name}：第 ${b.startRow} 行起（${b.rowCount} 行）`).join('；');
  $('#wps-export-copy').disabled=false;
 }catch(e){result=null;$('#wps-export-copy').disabled=true;$('#wps-export-status').textContent=e.message;$('#wps-export-preview').innerHTML='';}};
 $('#wps-export-layout').onchange=refresh;$('#wps-export-row').oninput=refresh;
 $('#wps-export-copy').onclick=async()=>{if(!result)return;const current=result;try{await copyWpsExport(current);$('#wps-export-status').textContent=`已复制 ${configs.length} 套配置，请粘贴到 WPS 的 ${current.layout==='EH'?'E':'F'}${current.startRow}。`;}catch(e){$('#wps-export-status').textContent=e.message;}};
 refresh();
}
