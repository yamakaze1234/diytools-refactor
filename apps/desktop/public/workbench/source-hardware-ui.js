import {boardTypes,boardType,caseSupport,validateHardware} from './component-hardware.js';
import {shortCpu} from './legacy-names.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function hardwareFieldsHtml(row){const v=row.hardwareOverrides||{};return `<fieldset id="source-hardware" ${row.specialComponent?'hidden':''}>
 <legend>CPU、主板与机箱识别</legend>
 <p class="hardware-intro">只维护当前配件适用的项目；人工设置优先，价格同步不会覆盖。</p>
 <div class="hardware-grid">
  <label class="field hardware-field" data-maintenance-kind="cpu"><span class="hardware-label">CPU 简称识别名称</span><input id="source-hardware-cpu" value="${esc(v.cpuName)}" maxlength="80" placeholder="自动识别，可填写如 14600KF" aria-describedby="source-hardware-cpu-result"><small id="source-hardware-cpu-result" data-hardware-hint="cpu"></small></label>
  <label class="field hardware-field" data-maintenance-kind="board"><span class="hardware-label">主板板型</span><select id="source-hardware-board" aria-describedby="source-hardware-board-result"><option value="">自动识别</option>${boardTypes.map(t=>`<option ${v.boardType===t?'selected':''}>${t}</option>`).join('')}</select><small id="source-hardware-board-result" data-hardware-hint="board"></small></label>
 </div>
 <div class="hardware-case" data-maintenance-kind="case" role="group" aria-labelledby="source-hardware-case-label" aria-describedby="source-hardware-case-result">
  <div class="hardware-case-heading"><span id="source-hardware-case-label" class="hardware-label">机箱支持的主板板型</span><span class="hardware-multiple">可多选</span></div>
  <div class="hardware-options">${boardTypes.map(t=>`<label class="hardware-option"><input id="source-hardware-case-${t}" data-case-board="${t}" type="checkbox" ${v.caseBoards?.includes(t)?'checked':''}><span>${t}</span></label>`).join('')}</div>
  <small id="source-hardware-case-result" data-hardware-hint="case"></small>
 </div>
 <p class="hardware-footnote">恢复自动识别：清空 CPU 名称、选择“自动识别”，或取消全部机箱板型。</p>
 </fieldset>`;}
export function readHardwareFields(root,validate=true){const raw={cpuName:root.querySelector('#source-hardware-cpu')?.value||'',boardType:root.querySelector('#source-hardware-board')?.value||''};const selected=[...root.querySelectorAll('[data-case-board]:checked')].map(el=>el.dataset.caseBoard);if(selected.length)raw.caseBoards=selected;return validate?validateHardware(raw):validateHardware(raw);}
export function updateHardwareHints(root,row){const v=readHardwareFields(root,false)||{},automatic={...row,hardwareOverrides:undefined},support=caseSupport(automatic);for(const [key,value]of Object.entries({cpu:v.cpuName?`人工：${v.cpuName}`:`自动：${row.hardwareFacts?.cpuName||shortCpu(row.erpName||row.name)||'未识别'}`,board:v.boardType?`人工：${v.boardType}`:`自动：${boardType(automatic)||'未识别'}`,case:v.caseBoards?`人工支持：${v.caseBoards.join('、')}`:support.exact?`已记录支持：${support.exact.join('、')}`:support.type?`自动最大板型：${support.type}；完整支持列表可手工维护`:'自动：未识别，请维护支持板型'})){const el=root.querySelector(`[data-hardware-hint="${key}"]`);if(el)el.textContent=value;}}
