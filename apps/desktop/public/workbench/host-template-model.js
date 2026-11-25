/** 主机模板在已有配置文档上编辑，保存和生成各自使用原工作台路径。 */
import {blankConfig,clone} from './core.js';
import {partCapacity,capacityText} from './component-capacity.js';
import {shortCpu} from './legacy-names.js';
import {replaceSourcePart} from './source.js';
import {effectivePartColor} from './erp-part-description.js';
import {excludedComponent} from './component-policy.js';

export const templateSlots=['CPU','显卡','主板','内存','硬盘','电源'];
export const templatePart=(config,slot)=>config.parts.find(row=>row.slot===slot&&row.name);
const partText=part=>[part?.erpName,part?.erpModel,part?.erpSpec,part?.name].filter(Boolean).join(' ').normalize('NFKC');
const amdCpu=text=>/AMD|锐龙|RYZEN|\b(?:[579]\d{3}(?:X3D2?|[XFG]|\b))/i.test(text);
const cpuModel=part=>part.hardwareOverrides?.cpuName||partText(part).match(/\b\d{4,5}(?:X3D2?|KF|KS|[KFTGX])?\b/i)?.[0]||shortCpu(part.name);

function cpuSocket(text){
 if(amdCpu(text)){const generation=text.match(/\b([5789])\d{3}/)?.[1];return generation==='5'?'AM4':generation?'AM5':'';}
 if(/Ultra|\b2\d{2}(?:K|F|KF|\b)/i.test(text))return 'LGA1851';
 return /1[2-4]代|\b1[2-4]\d{3}/.test(text)?'LGA1700':'';
}
export function boardSocket(text){
 if(/\b(?:A620|B650|X670|B840|B850|X870)/i.test(text))return 'AM5';
 if(/\b(?:A320|A520|B450|B550|X570)/i.test(text))return 'AM4';
 if(/\b(?:Z890|B860|H810)/i.test(text))return 'LGA1851';
 return /\b(?:B760|H610|B660|Z790|H770|Z690|H670|B760)/i.test(text)?'LGA1700':'';
}
const ddr=text=>/DDR\s*4|\bD4\b/i.test(text)?'DDR4':/DDR\s*5|\bD5\b/i.test(text)?'DDR5':'';
export function templateIssues(config){
 const cpu=cpuSocket(partText(templatePart(config,'CPU'))),boardText=partText(templatePart(config,'主板')),board=boardSocket(boardText);
 const boardDdr=ddr(boardText)||(board==='AM4'?'DDR4':board?'DDR5':''),memory=ddr(partText(templatePart(config,'内存'))),out=[];
 if(cpu&&board&&cpu!==board)out.push({slots:['CPU','主板'],message:'CPU '+cpu+' 与主板 '+board+' 接口不符'});
 if(boardDdr&&memory&&boardDdr!==memory)out.push({slots:['主板','内存'],message:'主板需要 '+boardDdr+'，当前内存是 '+memory});
 return out;
}

const commonVram={'5070':12,'5070TI':16,'5080':16,'5090':32,'5090D':32,'9070XT':16,'9070GRE':12,'6500XT':4,'7650GRE':8,'5050':8};
/** 按附件规则识别显卡型号和规格。已维护的硬件属性优先，未知时按型号推断。 */
export function gpuSpec(part){
 const text=partText(part).toUpperCase();
 const codename=text.match(/\b(?:GV-)?([NR])(\d{4}|\d{3})(GRE|XT|[TSX])?(?=[A-Z-]|\b)/);
 const match=text.match(/\b(RTX|RX)[\s-]*(\d{4})[\s-]*(TI\s*SUPER|TI|XT|SUPER|GRE|D(?=V\d|\b))?/)||
  (/(显卡|技嘉|华硕|七彩虹|微星|GIGABYTE|ASUS|MSI)/.test(text)?
   text.match(/(?:^|[^A-Z0-9])(RTX|RX)?[\s-]*([2-9]\d{3})\s*(TI\s*SUPER|TI|XT|SUPER|GRE|D(?=V\d|\b))?(?=\b|[^A-Z0-9]|V\d)(?=.{0,30}\d{1,2}\s*G)/):null);
 const codeSuffix={T:'TI',S:'SUPER',X:'XT',XT:'XT',GRE:'GRE'};
 const model=match?match[2]+(match[3]||'').replace(/\s/g,''):codename?
  codename[2].padEnd(4,'0')+(codeSuffix[codename[3]]||''):'';
 if(!model||/延长线|支架|机箱|ITX\/|一体水冷|内存|DDR[45]|马甲|\bC\d{2}\b/.test(text))return null;
 const maker=(match?.[1]==='RX'||codename?.[1]==='R'||!match?.[1]&&/(?:XT|GRE)$/.test(model))?'RX':'RTX';
 const capacity=partCapacity(part,'vramGb');
 const namedVram=Number(text.match(/(?:^|[^0-9])(\d{1,2})\s*G[BD]?\b/)?.[1]);
 const vram=capacity>0&&capacity<=64?capacity:namedVram>0&&namedVram<=64?namedVram:commonVram[model]||null;
 const maintainedFans=Number(part?.hardwareOverrides?.gpuFans??part?.hardwareFacts?.gpuFans);
 const fans=[1,2,3].includes(maintainedFans)?maintainedFans:
  Number(text.match(/(?:[X×]([1-3])|([1-3]))\s*(?:风扇|FAN)/)?.slice(1).find(Boolean)||text.match(/WF([1-3])/)?.[1])||
  (/单风扇|七彩虹.*MINI|COLORFUL.*MINI/.test(text)?1:/双风扇|\bDUAL\b|\bDUO\b|风魔/.test(text)?2:
  /三风扇|魔鹰|雪鹰|(?:猎鹰|EAGLE)\s*MAX|技嘉.*(?:5070|5080|5090)/.test(text)?3:/猎鹰|EAGLE/.test(text)?2:3);
 const fanLabel=/^5060/.test(model)&&fans?['','单风扇','双风扇','三风扇'][fans]:'';
 return {model,maker,vram,fans,label:[maker+model,vram?vram+'G':'',fanLabel].filter(Boolean).join(' ')};
}

/** 候选按已用槽位、显式分类和 ERP 原名归类；目录中可识别的商品皆保留原货号。 */
export function templateCatalog(catalog,configs=[]){
 const slots=new Map();
 for(const config of configs)for(const part of config.parts||[]){
  const id=part.sourceId||part.goodsId;
  if(id&&!slots.has(id))slots.set(id,part.slot);
 }
 return catalog.filter(row=>!row.deletedAt&&!excludedComponent(row)).map(row=>{
  const text=partText(row),category=row.slot||slots.get(row.sourceId)||slots.get(row.goodsId)||row.erpCategory||'';
  const slot=templateSlots.includes(category)||['散热','机箱','风扇'].includes(category)||category.startsWith('配件')?category:
   gpuSpec(row)?'显卡':boardSocket(text)?'主板':/CPU|处理器|酷睿|锐龙|RYZEN|\b1[2-4]\d{3}(KF?|F)\b/i.test(text)?'CPU':
   /内存|DDR[45]|UDIMM|马甲|\bC\d{2}\b/i.test(text)?'内存':/固态|硬盘|\bSSD\b|\bNVME\b/i.test(text)?'硬盘':
   /电源|\b\d{3,4}W\b/i.test(text)?'电源':/机箱/.test(text)?'机箱':/水冷|散热器/.test(text)?'散热':
   /风扇|\b(?:ZE|ZA|XA)-/.test(text)?'风扇':'配件';
  return {...row,templateSlot:slot};
 });
}
export function slotCandidates(catalog,slot,platform){
 const source=catalog.filter(row=>slot==='配件'?row.templateSlot.startsWith('配件')&&!/延长线/.test(partText(row)):row.templateSlot===slot);
 if(slot==='CPU'){
  const seen=new Map();
  for(const row of source)if(amdCpu(partText(row))===(platform==='amd')){
   const model=cpuModel(row);if(!seen.has(model))seen.set(model,{...row,templateLabel:model||row.name});
  }
  return [...seen.values()];
 }
 if(slot==='主板')return source.filter(row=>{const socket=boardSocket(partText(row));return !socket||socket.startsWith(platform==='amd'?'AM':'LGA');});
 return source;
}
export function gpuChoices(catalog){
 const seen=new Map();
 for(const row of catalog.filter(row=>row.templateSlot==='显卡')){
  const spec=gpuSpec(row);
  if(spec&&!seen.has(spec.label))seen.set(spec.label,{name:spec.label,goodsId:'',templateSpec:spec,group:spec.maker==='RX'?'A 卡（AMD）':'N 卡（NVIDIA）'});
 }
 return [{name:'无卡',goodsId:'',group:''},...[...seen.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}))];
}
export function rankedTemplateGpus(catalog,spec,color){
 return catalog.flatMap(row=>{
  if(row.templateSlot!=='显卡')return [];
  const parsed=gpuSpec(row);
  return parsed?.model===spec.model&&parsed.maker===spec.maker&&(!spec.vram||spec.vram===parsed.vram)&&
   (!spec.fans||spec.fans===parsed.fans)?[row]:[];
 }).sort((a,b)=>{
  const rank=row=>[Number(/^(停产|停售)/.test(row.erpName||row.name)),Number(!(row.stockAvailable>0)),
   Number(spec.fans!==1&&/半高|MINI|ITX|-GL\b|8GL/i.test(partText(row))),
   Number((effectivePartColor(row,partText(row))||'黑')!==(color==='white'?'白':'黑')),
   Number(!/技嘉|GIGABYTE/i.test(partText(row))),row.erp??Infinity];
  const av=rank(a),bv=rank(b);return av.reduce((order,value,i)=>order||(value===bv[i]?0:value-bv[i]),0);
 });
}

export function newTemplateDraft(template){
 const platform=template.platform??template.configs[0]?.templatePlatform;
 const color=template.color??template.configs[0]?.templateColor;
 const data={name:template.name,
  platform:['intel','amd'].includes(platform)?platform:(template.configs.some(row=>amdCpu(partText(templatePart(row,'CPU'))))||/AMD|锐龙/i.test(template.name)?'amd':'intel'),
  color:['white','black'].includes(color)?color:(/白/.test(template.name)?'white':'black'),configs:clone(template.configs)};
 return {data,baseline:clone(data),undo:[],redo:[]};
}
export const templateDirty=draft=>JSON.stringify(draft.data)!==JSON.stringify(draft.baseline);
export function editTemplate(draft,edit){
 const next=clone(draft.data);edit(next);
 if(JSON.stringify(next)===JSON.stringify(draft.data))return false;
 draft.undo.push(draft.data);if(draft.undo.length>50)draft.undo.shift();
 draft.redo=[];draft.data=next;return true;
}
export function templateHistory(draft,redo=false){
 const from=redo?draft.redo:draft.undo,to=redo?draft.undo:draft.redo;
 if(!from.length)return;
 to.push(draft.data);draft.data=from.pop();
}

/** 修改主机模板配件时保留展示与实际的既有其他槽位及本行数量。 */
export function setTemplatePart(config,slot,source,quantity){
 const index=config.parts.findIndex(p=>p.slot===slot),aIndex=config.actualParts.findIndex(p=>p.slot===slot);
 const previous=config.parts[index]?.sourceId;
 function apply(parts,position,document){
  if(position<0){position=parts.length;parts.push({slot,lineId:crypto.randomUUID(),name:'',goodsId:'',qty:1});}
  const old=parts[position],qty=quantity??old.qty??1;
  if(source?.sourceId){
   replaceSourcePart(document,position,source);
   delete parts[position].templateSpec;
   parts[position].qty=qty;
  }else parts[position]={slot,lineId:old.lineId||crypto.randomUUID(),name:source?.name??'',goodsId:'',qty,
   erp:source?.name==='无卡'?0:null,tax:source?.name==='无卡'?0:null,upgrade:'',...(source?.templateSpec?{templateSpec:source.templateSpec}:{})};
 }
 apply(config.parts,index,config);apply(config.actualParts,aIndex,{...config,parts:config.actualParts,addons:[]});
 if(previous&&previous!==source?.sourceId&&!config.parts.some(row=>row.sourceId===previous))
  config.addons=config.addons.filter(row=>row.sourceId!==previous);
 delete config.emptyLinkDraft;
}
export function insertTemplateRow(data,index,shopId,duplicate=false){
 const reference=data.configs[index],product={id:reference?.productId||data.configs[0]?.productId||crypto.randomUUID(),name:data.name,shopId,category:'主机模板',configs:[]};
 const config=duplicate&&reference?{...clone(reference),id:crypto.randomUUID(),skuId:'',spu:'',productUrl:''}:blankConfig(reference,product);
 data.configs.splice(index+1,0,config);
}
export function templateShort(config){
 const [cpu,gpu,ram,ssd]=['CPU','显卡','内存','硬盘'].map(slot=>templatePart(config,slot));
 const spec=gpu?.templateSpec||gpuSpec(gpu);
 return [cpu?cpuModel(cpu):'—',gpu?.name==='无卡'?'无卡':spec?spec.model+(spec.vram?' '+spec.vram+'G':''):gpu?.name||'—',
  ram?capacityText(partCapacity(ram,'memoryGb'),ram.qty)||'内存':'—',ssd?capacityText(partCapacity(ssd,'storageGb'),ssd.qty)||'硬盘':'—'];
}
const itemText=(part,qty=1)=>part?part.name+(part.goodsId?'（GoodID '+part.goodsId+'）':'')+(qty>1?' ×'+qty:''):'（未填）';

export function templateSelectionText(data,picked,appearance){
 const selected=data.configs.flatMap((config,index)=>picked.has(config.id)?[[config,index+1]]:[]);
 const lines=['【选号单】母版：'+data.name];
 for(const slot of ['机箱','散热','风扇']){
  const item=appearance[slot];if(item?.name||slot!=='风扇')lines.push(slot+'：'+itemText(item?.name?item:null,item?.qty));
 }
 const extras=appearance.accessories.filter(item=>item.name).map(item=>itemText(item,item.qty));
 if(extras.length)lines.push('配件：'+extras.join('；'));
 lines.push('延长线：跟显卡走','选号（'+selected.length+' 套）：'+(selected.map(([,index])=>index).join('、')||'（未选）'));
 for(const [config,index] of selected){
  lines.push('　'+index+'号 '+templateShort(config).join('+'));
  lines.push('　　'+templateSlots.map(slot=>{const part=templatePart(config,slot);return slot+'：'+itemText(part,part?.qty);}).join('；'));
  for(const issue of templateIssues(config))lines.push('　　⚠ '+issue.message);
 }
 return [...lines,'改动：'+(appearance.changes.trim()||'无')].join('\n');
}

/** 生成前匹配当前店铺货号。其它已配置外观留作模板默认值。 */
export function applyTemplateAppearance(config,catalog,appearance,gpuId){
 const find=id=>catalog.find(row=>row.sourceId===id);
 if(gpuId){const gpu=find(gpuId);if(!gpu)throw Error('所选显卡货号已变化');setTemplatePart(config,'显卡',gpu);}
 for(const slot of ['机箱','散热','风扇']){
  const item=appearance[slot];
  if(item.name){const row=find(item.sourceId);if(!row)throw Error('请先选择当前店铺的'+slot);setTemplatePart(config,slot,row,item.qty);}
 }
 const gpu=templatePart(config,'显卡'),parsed=gpu?.templateSpec||gpuSpec(gpu);
 const cableId=parsed?.maker==='RTX'&&/^(5070|5080|5090)/.test(parsed.model)?'41283':'44360';
 const cable=catalog.find(row=>row.goodsId===cableId);
 const oldCable=config.parts.find(row=>['41283','44360'].includes(row.goodsId)||/延长线/.test(row.name));
 const free=()=>['配件1','配件2','配件3','配件4','配件5'].find(slot=>!templatePart(config,slot));
 if(!cable&&oldCable)throw Error('当前店铺缺少显卡对应的延长线 '+cableId+'，请先维护该输出源。');
 if(cable){
  const slot=oldCable?.slot||free();if(!slot)throw Error('配件槽位已满，无法添加延长线。');
  setTemplatePart(config,slot,cable,1);
 }
 appearance.accessories.filter(item=>item.name).forEach(item=>{
  const row=find(item.sourceId);if(!row)throw Error('请先选择当前店铺的其他配件');
  const slot=config.parts.find(part=>part.slot.startsWith('配件')&&part.sourceId===row.sourceId)?.slot||free();
  if(!slot)throw Error('配件槽位已满，请减少右侧的附加配件。');
  setTemplatePart(config,slot,row,item.qty);
 });
}
