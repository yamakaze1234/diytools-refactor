/** 配件维护资料：人工覆盖优先，ERP 原文和型号推断只作为自动值。 */
export const boardTypes=['ATX','MATX','ITX','E-ATX'];
const text=row=>[row?.erpModel,row?.erpSpec,row?.erpName,row?.name].filter(Boolean).join(' ').normalize('NFKC').toUpperCase();
export function inferBoardType(row){
 const s=text(row);
 // 仅匹配芯片组型号后的 M/I，不读取 GAMING、WIFI、ICE 中的字母。
 if(/(?:CROSSHAIR|MAXIMUS).*EXTREME|AORUS.*XTREME|(?:PROART|CREATOR)|STRIX.*[ABHXZ]\d{3}[EI]?-[GI]\b/.test(s))return null;
 const m=s.match(/(?:^|[^A-Z0-9])(?:[ABHXZ]\d{3}|TRX\d{2})([A-Z]*)(?=[^A-Z0-9]|$)/);
 if(!m)return null;
 if(/^(?:E)?I$/.test(m[1]))return 'ITX';if(/^(?:E)?M$/.test(m[1]))return 'MATX';
 // B760BKB、B650E 等特殊后缀不可当作普通 ATX。
 if(m[1]&&m[1]!=='E')return null;
 if(/(?:^|[ /（(])(?:MINI[- ]?ITX|ITX)(?=[ /）)]|$)/.test(s))return 'ITX';
 return 'ATX';
}
export function inferCaseType(row){
 const s=text(row).replace(/(?:SFX(?:[- ]L)?\s*(?:和|\/|与)\s*)?(?:E[- ]?)?ATX\s*电源/g,'');
 const types=[...s.matchAll(/(?:^|[^A-Z0-9])((?:MICRO[- ]?|M[- ]?)ATX|MINI[- ]?ITX|ITX|E[- ]?ATX|ATX)(?![A-Z0-9])/g)].map(m=>m[1].replace(/MICRO|M(?=INI)/,'M'));
 if(!types.length)return null;
 const canonical=types.map(v=>/^(MICRO|M).*ATX$/.test(v)?'MATX':/ITX$/.test(v)?'ITX':/^E/.test(v)?'E-ATX':'ATX');
 return ['E-ATX','ATX','MATX','ITX'].find(v=>canonical.includes(v))||null;
}
export function validateHardware(value){
 if(value==null)return undefined;if(typeof value!=='object'||Array.isArray(value))throw Error('配件识别资料格式无效');
 const result={};
 if(value.cpuName!=null&&value.cpuName!==''){if(typeof value.cpuName!=='string'||value.cpuName.trim().length>80)throw Error('CPU 简称须为 80 字以内的文字');if(value.cpuName.trim())result.cpuName=value.cpuName.trim();}
 if(value.boardType){if(!boardTypes.includes(value.boardType))throw Error('主板板型无效');result.boardType=value.boardType;}
 if(value.caseBoards!=null){if(!Array.isArray(value.caseBoards)||!value.caseBoards.length||value.caseBoards.some(v=>!boardTypes.includes(v)))throw Error('请选择机箱支持的主板板型');result.caseBoards=boardTypes.filter(v=>value.caseBoards.includes(v));}
 return Object.keys(result).length?result:undefined;
}
export function boardType(row){return row?.hardwareOverrides?.boardType||row?.hardwareFacts?.boardType||inferBoardType(row);}
export function caseSupport(row){
 const exact=row?.hardwareOverrides?.caseBoards||row?.hardwareFacts?.caseBoards;
 if(exact)return {exact,type:null,known:true};
 const type=row?.hardwareFacts?.caseType||inferCaseType(row);return {exact:null,type,known:!!type};
}
export function boardCaseIssue(board,box){
 const type=boardType(board),support=caseSupport(box);
 if(!type||!support.known)return {status:'unknown',message:'主板或机箱板型资料未识别，请在维护数据中补充'};
 // ERP 常只有机箱最大板型，不能据此保证所有小板型都兼容；仅明确超尺寸时判错。
 const rank={'ITX':0,'MATX':1,'ATX':2,'E-ATX':3};
 const bad=support.exact?!support.exact.includes(type):rank[type]>rank[support.type];
 return {status:bad?'error':'ok',message:bad?`搭配错误：当前机箱不支持 ${type} 主板`:''};
}
export function configHardwareIssues(config){
 const result=[];for(const [field,label] of [['parts','展示配件'],['actualParts','实际配件']]){
 const parts=config[field]||[],board=parts.find(p=>p.slot==='主板'&&p.goodsId),box=parts.find(p=>p.slot==='机箱'&&p.goodsId);
 if(board&&box){const issue=boardCaseIssue(board,box);if(issue.status!=='ok')result.push({...issue,label});}
 }return result;
}
export function copyHardware(source,part){for(const key of ['hardwareOverrides','hardwareFacts','erpSpec','erpModel']){if(source[key]!==undefined)part[key]=structuredClone(source[key]);else delete part[key];}}
/** 只填自动资料，绝不把推断写入人工覆盖。 */
export function hardwareFacts(row){
 const facts={...row.hardwareFacts},s=text(row),category=row.erpCategory||'';
 if(category==='主板'||inferBoardType(row)){const type=inferBoardType(row);if(type&&!facts.boardType)facts.boardType=type;}
 if(category==='机箱'||/机箱|风扇位|风扇位置|风冷限高|散热器限高/.test(s)){const type=inferCaseType(row);if(type&&!facts.caseType)facts.caseType=type;}
 return Object.keys(facts).length?facts:undefined;
}
/** 已核对资料的批量补全仅修改识别字段，不触碰既有价格、名称、数量或加购。 */
export function applyHardwareMaintenance(state,changes){
 const next=structuredClone(state),ids=new Set();
 for(const {before,row} of changes){
  const target=next.sourceCatalog.find(r=>r.sourceId===row.sourceId);
  if(!target||target.goodsId!==row.goodsId||target.shopId!==row.shopId||JSON.stringify(target)!==JSON.stringify(before))throw Error('维护资料已变化，请重新读取后补全');
  for(const key of ['hardwareFacts','erpSpec','erpModel','erpCategory'])if(row[key]!==undefined)target[key]=structuredClone(row[key]);
 }
 const sources=new Map(next.sourceCatalog.map(r=>[JSON.stringify([r.shopId||'intel',r.sourceId]),r]));
 for(const c of next.configs)for(const p of [...c.parts||[],...c.actualParts||[]]){
  const row=sources.get(JSON.stringify([c.shopId||'intel',p.sourceId]));if(!row||row.goodsId!==p.goodsId)continue;
  const before=JSON.stringify(p);copyHardware(row,p);if(before!==JSON.stringify(p))ids.add(c.id);
 }
 return {next,configIds:[...ids]};
}
