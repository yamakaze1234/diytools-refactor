/** 读取单个 Excel 单元格公式，并按结构化列名套用到其他配件。 */
const tokens=/"(?:[^"]|"")*"|'(?:[^']|'')*'|\[(@?)([^\[\]]+)\]/g;
const columnMap=slots=>new Map(slots.flatMap(slot=>[
 [slot.toLowerCase()+'_id',{slot,column:target=>target+'_id'}],
 [('定位'+slot).toLowerCase(),{slot,column:target=>'定位'+target}],
]));

export function cleanPartFormula(input) {
 const formula=String(input??'').trim().replace(/^[\\'](?==)/,'');
 if(!/^=\s*\S/.test(formula)||formula.length>8192||/[\t\r\n\0]/.test(formula))
  throw Error('请从主机维护表公式栏复制一个完整的单元格公式。');
 return formula;
}

export function expandPartFormula(input,slots,onlySlot=null) {
 const formula=cleanPartFormula(input);
 if(onlySlot){
  if(!slots.includes(onlySlot))throw Error('请选择当前布局中的配件槽位。');
  return {[onlySlot]:formula};
 }
 const columns=columnMap(slots);
 const referenced=new Set([...formula.matchAll(tokens)].flatMap(([, ,column])=>{
  const entry=columns.get(column?.toLowerCase());
  return entry?[entry.slot]:[];
 }));
 if(referenced.size!==1)throw Error(referenced.size?'公式引用了多个配件，请选择“只改一个配件”。':
  '未识别配件列名。请粘贴带“CPU_id”或“定位CPU”等列名的公式，或选择“只改一个配件”。');
 // 只替换公式中的结构化列名，字符串和带引号的工作簿名称原样保留。
 return Object.fromEntries(slots.map(slot=>[slot,formula.replace(tokens,(token,at,column)=>{
  const entry=columns.get(column?.toLowerCase());
  return entry?'['+at+entry.column(slot)+']':token;
 })]));
}

function storageKey(scope,shopId,short){return 'diy-part-export-formulas:'+JSON.stringify([scope,shopId,short?'short':'legacy']);}

export function readPartFormulas(storage,scope,shopId,short,slots) {
 let raw;
 try{raw=JSON.parse(storage.getItem(storageKey(scope,shopId,short))||'{}');}catch{return {};}
 const result={};
 for(const slot of slots)if(typeof raw?.[slot]==='string'){
  try{result[slot]=cleanPartFormula(raw[slot]);}catch{/* 无效历史设置回到该配件的默认公式。 */}
 }
 return result;
}

export function savePartFormulas(storage,scope,shopId,short,formulas) {
 storage.setItem(storageKey(scope,shopId,short),JSON.stringify(formulas));
}

/** 原导出弹窗内的独立设置区域。成功保存后直接重算现有的导出预览。 */
export function mountPartFormulaEditor(root,{shopName,getSlots,read,write,defaultFormula,onSave}){
 root.innerHTML=`<summary>配件公式设置</summary><div class="part-formula-controls">
   <label class="field">应用范围<select id="part-formula-range"><option value="all">该店全部配件</option><option value="one">只改一个配件</option></select></label>
   <label class="field" id="part-formula-target" hidden>配件槽位<select id="part-formula-slot"></select></label>
  </div><label class="field">从主机维护表公式栏粘贴<textarea id="part-formula-input" rows="3" spellcheck="false" maxlength="8193"></textarea></label>
  <p class="hint">整店套用时，会替换公式里的商品 ID 和定位列名。设置保存在本机。</p>
  <div class="actions"><button type="button" class="primary" id="part-formula-save">应用公式</button><button type="button" id="part-formula-reset">恢复默认</button>
  <small id="part-formula-status" class="hint" role="status"></small></div>`;
 const $=selector=>root.querySelector(selector);
 const input=$('#part-formula-input'),slot=$('#part-formula-slot'),range=$('#part-formula-range'),status=$('#part-formula-status');
 range.options[0].textContent=shopName+'全部配件';
 const one=()=>range.value==='one';
 let edited=false;
 function display(){
  const selected=slot.value;
  slot.replaceChildren(...getSlots().map(label=>new Option(label,label)));
  if(getSlots().includes(selected))slot.value=selected;
  input.value=read()[slot.value]??defaultFormula(slot.value);
  edited=false;status.textContent='';
 }
 function apply(reset){
  const saved=read();
  try{
   if(reset){
    if(one())delete saved[slot.value];
   }else Object.assign(saved,expandPartFormula(input.value,getSlots(),one()?slot.value:null));
   write(reset&&!one()?{}:saved);
   display();onSave();
   status.textContent=reset?'已恢复默认公式。':one()?'已更新此配件公式。':'已更新该店当前布局的全部配件公式。';
  }catch(error){status.textContent=error.message;}
 }
 range.onchange=()=>{$('#part-formula-target').hidden=!one();status.textContent='';};
 input.oninput=()=>{edited=true;status.textContent='';};
 slot.onchange=()=>{if(!edited)input.value=read()[slot.value]??defaultFormula(slot.value);status.textContent='';};
 $('#part-formula-save').onclick=()=>apply(false);
 $('#part-formula-reset').onclick=()=>apply(true);
 display();
 return display;
}
