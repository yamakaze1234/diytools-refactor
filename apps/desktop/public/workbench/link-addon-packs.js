import {moneyCents} from './pricing.js';

const goods=value=>typeof value==='string'&&/^\d{1,20}$/.test(value)&&!/^0+$/.test(value);
const key=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const text=(value,limit)=>typeof value==='string'&&value.length<=limit&&!value.includes('\u0000');
const count=value=>Number.isSafeInteger(value)&&value>=1&&value<=1000;
const yuan=value=>'¥'+(value/100).toLocaleString('zh-CN',{maximumFractionDigits:2});

/** 编辑页和 NAS 使用相同的保存条件，页面可指出需要补齐的字段。 */
export function addonPackValidationIssue(pack){
 if(!pack||!key(pack.id)||!key(pack.productId)||!text(pack.name,100)||
    !['parts','text'].includes(pack.mode)||!['preset','custom'].includes(pack.copyMode)||
    !['parts','name'].includes(pack.preset)||!text(pack.customCopy,1800)||
    !pack.presetEdits||typeof pack.presetEdits!=='object'||Array.isArray(pack.presetEdits)||Object.keys(pack.presetEdits).some(k=>!['parts','name'].includes(k)||!text(pack.presetEdits[k],1800))||
    !Array.isArray(pack.rules)||pack.rules.length>24||
    Object.keys(pack).some(k=>!['id','productId','name','mode','priceCents','copyMode','preset','customCopy','presetEdits','rules'].includes(k)))return '方案资料无效，最多支持 24 项配件规则';
 if(!pack.name.trim())return '请填写方案名称';
 if(pack.mode==='text'){
  if(pack.priceCents!==null||pack.rules.length)return '仅文案方案不能包含配件或补差';
  return addonPackCopy(pack)?'':'请填写配置图文案';
 }
 if(!Number.isSafeInteger(pack.priceCents)||pack.priceCents<0||pack.priceCents>100000000)return '请填写有效的客户补差（可填 0）';
 if(!pack.rules.length)return '请至少添加一项加购配件';
 const originals=new Set();
 for(const [index,row] of pack.rules.entries()){
  const label=`第 ${index+1} 项`;
  if(!row||Object.keys(row).some(k=>!['kind','originalGoodsId','slot','sourceId','targetGoodsId','qtyMode','qty'].includes(k))||
   !['add','replace'].includes(row.kind))return label+'配件规则无效';
  if(row.kind==='replace'){
   if(!goods(row.originalGoodsId)||!text(row.slot,20)||!row.slot)return '请选择'+label+'的原型号';
   if(originals.has(row.originalGoodsId))return '同一个原型号只能替换一次';
   originals.add(row.originalGoodsId);
  }
  if(!key(row.sourceId)||!goods(row.targetGoodsId))return '请选择'+label+'的加购配件';
  if(!(row.kind==='replace'&&row.qtyMode==='match'||row.qtyMode==='fixed'&&count(row.qty)))return label+'的固定数量须为 1–1000 的整数';
 }
 const shownCopy=pack.copyMode==='custom'?pack.customCopy:pack.presetEdits[pack.preset];
 return shownCopy!==undefined&&!shownCopy.trim()?'请填写配置图文案，或使用自动生成的预设':'';
}

export function validAddonPack(pack){
 return addonPackValidationIssue(pack)==='';
}

export function addonPackInputs(sources,costs){
 return {sources:new Map(sources.filter(row=>!row.deletedAt&&goods(row.goodsId)).map(row=>[row.sourceId,row])),
  costs:new Map(costs.map(row=>[row.goodsId,row]))};
}

function unit(part,field,costs){
 if(field==='tax'&&part.taxOverride?.goodsId===part.goodsId)return moneyCents(part.taxOverride.value);
 const value=costs.get(part.goodsId)??part;
 if(field==='erp'&&(value.erpMissing||value.erpUnknown))return null;
 return moneyCents((field==='tax'?value.tax??part.tax:value.erp)??null);
}
const sum=(rows,field)=>rows.some(row=>row[field]===null)?null:rows.reduce((total,row)=>total+row[field],0);
const delta=(current,next)=>current===null||next===null?null:next-current;
function costLine(part,qty,costs){
 const tax=unit(part,'tax',costs),erp=unit(part,'erp',costs);
 return {part,qty,tax,erp,taxSubtotal:tax===null?null:tax*qty,erpSubtotal:erp===null?null:erp*qty};
}

/** 汇总同商品原件的各行数量和成本。命中要求全部替换规则都适用，原 BOM 始终只读。 */
export function assessAddonPack(config,pack,{sources,costs}){
 if(!config||config.deletedAt||config.productId!==pack.productId)return {issue:'不属于当前链接',lines:[]};
 if(pack.mode==='text')return {issue:'',lines:[]};
 if(!Array.isArray(config.actualParts))return {issue:'实际配件尚未载入',lines:[]};
 if(!pack.rules.length)return {issue:'请添加配件规则',lines:[]};
 const lines=[],used=new Set();
 for(const rule of pack.rules){
  const target=sources.get(rule.sourceId);
  if(!target||target.goodsId!==rule.targetGoodsId)return {issue:'请选择有效的输出源配件',lines:[]};
  const originals=rule.kind==='replace'?config.actualParts.filter(part=>part.goodsId===rule.originalGoodsId):[];
  if(rule.kind==='replace'){
   if(used.has(rule.originalGoodsId))return {issue:'同一个原型号只能替换一次',lines:[]};
   used.add(rule.originalGoodsId);
   if(!originals.length)return {issue:'未匹配原型号 '+(rule.originalGoodsId||rule.slot||''),lines:[]};
   if(originals.some(part=>!count(part.qty)))return {issue:'原配件数量无效',lines:[]};
  }
  const originalQty=originals.reduce((total,part)=>total+part.qty,0);
  const qty=rule.kind==='replace'&&rule.qtyMode==='match'?originalQty:rule.qty;
  if(!Number.isSafeInteger(qty)||qty<1||qty>100000)return {issue:'请填写有效数量',lines:[]};
  const same=originalQty===qty&&rule.originalGoodsId===target.goodsId;
  // 按实际配置行保留单价，便于核对同型号各行的手工成本。
  const oldCosts=originals.map(part=>costLine(part,part.qty,costs)),newCost=costLine(target,qty,costs);
  lines.push({rule,target,qty,originals,originalQty,same,oldCosts,newCost,
   tax:same?0:delta(sum(oldCosts,'taxSubtotal'),newCost.taxSubtotal),erp:same?0:delta(sum(oldCosts,'erpSubtotal'),newCost.erpSubtotal)});
 }
 const changes=lines.filter(line=>!line.same);
 if(!changes.length)return {issue:'已是升级配件',lines};
 const tax=sum(changes,'tax'),erp=sum(changes,'erp');
 return {issue:'',lines,tax,erp,profit:pack.priceCents==null||tax===null?null:pack.priceCents-tax};
}

export function addonPackLine(line,ids=false){
 const label=part=>part.name+(ids?'（'+part.goodsId+'）':'');
 const target=label(line.target)+' ×'+line.qty;
 return line.originals.length?'替换'+line.rule.slot+' '+label(line.originals[0])+' ×'+line.originalQty+' → '+target:'新增 '+target;
}
// 额外配件栏保留实际位置做成本明细；文案按配件品类命名。
export function addonPartSlot(part){
 const kind=part.category||part.slot;
 if(kind&&!kind.startsWith('配件'))return kind;
 return /风扇|正叶|反叶|PWM/i.test([part.name,part.erpName].join(' '))?'风扇':kind||'配件';
}
export function addonPartsCopy(result){
 return result.lines.filter(line=>!line.same).map(({rule,target,qty})=>
  (rule.kind==='add'?'新增'+addonPartSlot(target):rule.slot+'升级为')+' '+target.name+' ×'+qty).join('；');
}
export function addonPackCopy(pack,result){
 if(pack.copyMode==='custom')return pack.customCopy.trim();
 const preset=pack.mode==='text'?'name':pack.preset;
 return (pack.presetEdits[preset]??(preset==='name'?pack.name:addonPartsCopy(result))).trim();
}
export function addonPackPosterText(pack,result){
 const text=addonPackCopy(pack,result);
 return text&&pack.mode==='parts'&&pack.copyMode==='preset'&&pack.priceCents!==null?'+'+yuan(pack.priceCents)+'　'+text:text;
}
export function addonPackRows(config,packs,inputs){
 return packs.filter(pack=>pack.productId===config.productId).flatMap(pack=>{
  const result=assessAddonPack(config,pack,inputs);
  return result.issue?[]:[{id:pack.id,mode:pack.mode,text:addonPackPosterText(pack,result)}];
 });
}
