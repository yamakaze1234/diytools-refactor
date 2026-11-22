/** 由正式 ERP 名称提取显示字段，放置标签时保留配件原文和货号。 */
import {excludedComponent} from './component-policy.js';
import {hardwareColors} from './component-hardware.js';

const brands=/^(?:JONSBO(?=乔思伯)|GIGABYTE(?=技嘉)|ZHITAI(?=致态)|ASUS(?=华硕)|MSI(?=微星)|COLORFUL(?=七彩虹))/i;
const tagPattern=/^(缺货|停售|停产)[\s：:·-]*/;
const normalized=value=>String(value??'').normalize('NFKC').trim();
const searchable=value=>normalized(value).toLowerCase();
const textOf=part=>[part?.erpName,part?.erpModel,part?.erpSpec,part?.name].filter(Boolean).join(' ');

/** ERP 的状态前缀和最后一组括号独立显示，原名可悬停查看和搜索。 */
export function splitErpName(value){
 const raw=normalized(value),tags=[];
 let main=raw,match;
 while((match=main.match(tagPattern))){tags.push(match[1]);main=main.slice(match[0].length);}
 if(/\*\s*!?\s*$/.test(main)){tags.push('*');main=main.replace(/\s*\*\s*!?\s*$/,'');}
 const params=main.match(/\s*\(([^()]*)\)\s*$/);
 if(params)main=main.slice(0,params.index);
 return {raw,main:main.trim().replace(brands,'')||raw,spec:params?.[1]??'',tags:[...new Set(tags)]};
}

// 瓦数清洗前保留风扇后缀，例如 ZE-120W 的 W 是型号的一部分。
const colorNoise=/((?:ZE|ZA|XA)-\d{3}WR?\b)|80\s*PLUS\s*白(?:金牌|金|牌)?|白金牌|白牌|白金|黑白|白黑|白\s*\/\s*黑|黑\s*\/\s*白|白盒|黑盒|黑神话|\d+\s*W\b/gi;
const explicitWhite=/白|\b(?:WHITE|W)\b|(?:ZE|ZA|XA)-(?:120|140|240|360|420)WR?\b/i;
const explicitBlack=/黑|\bBLACK\b|(?:ZE|ZA|XA)-(?:120|140|240|360|420)BR?\b/i;
const whiteSeries=/冰雕|冰猎鹰|冰魔鹰|冰雪|雪鹰|吹雪|AERO|雕妹|\bICE\b/i;
const blackSeries=/魔鹰|猎鹰|风魔/i;

/** 仅清洗用于识别的文本。主名明确时优先采用，显式冲突留空。 */
export function partColor(value){
 const name=normalized(value).replace(colorNoise,(_,fanCode)=>fanCode??' ');
 let main=name, previous;
 // 逐层移除括号参数，包括 ERP 名称中的嵌套括号。
 do{
  previous=main;
  main=main.replace(/\([^()]*\)/g,' ');
 }while(main!==previous);
 for(const text of [main,name]){
  const white=explicitWhite.test(text),black=explicitBlack.test(text);
  if(white||black)return white===black?'':white?'白':'黑';
 }
 // 冰猎鹰和冰魔鹰包含黑色系列简称，先匹配完整白色系列。
 if(whiteSeries.test(name))return '白';
 return blackSeries.test(name)?'黑':'';
}

/** 人工颜色供标签、配件差异与选卡共用，清空后回到自动资料和型号推断。 */
export function effectivePartColor(part,automaticText=textOf(part)){
 const manual=part?.hardwareOverrides?.color,known=part?.hardwareFacts?.color;
 return hardwareColors.includes(manual)?manual:hardwareColors.includes(known)?known:partColor(automaticText);
}

const fanSize=name=>name.match(/\b(?:ZE|ZA|XA|TH|TM|TX)-(120|140|240|280|360|420)/i)?.[1]||
 name.match(/\b(120|140|240|280|360|420)\s*(?:mm|冷排|连体)/i)?.[1]||'';
const blade=name=>/反叶|\b(?:ZE|ZA|XA)-\d{3}[BW]R\b/i.test(name)?'反叶':
 /正叶|\b(?:ZE|ZA|XA)-\d{3}[BW]\b/i.test(name)?'正叶':'';
const modelTokens=name=>name.toUpperCase().match(/[A-Z]{1,8}[- ]?\d{2,5}[A-Z0-9]*/g)?.map(x=>x.replace(/[- ]/g,'').replace(/ZS$/,''))??[];

export function erpDescription(part,shown,original,slot){
 const details=splitErpName(original),display=normalized(shown?.displayName||shown?.name),issues=[];
 const color=effectivePartColor(part,details.raw||textOf(part));
 const shownColor=effectivePartColor(shown,display);
 if(shownColor&&color&&shownColor!==color)issues.push('颜色：展示 '+shownColor+'，实物 '+color);
 if(details.raw&&display){
  for(const [label,parse] of [['叶型',blade],['尺寸',fanSize]]){
   const left=parse(display),right=parse(details.raw);
   if(left&&right&&left!==right)issues.push(label+'：展示 '+left+'，实物 '+right);
  }
  const expected=modelTokens(display),actual=modelTokens(details.raw);
  if(!issues.length&&expected.length&&actual.length&&!expected.some(x=>actual.some(y=>x.startsWith(y)||y.startsWith(x))))issues.push('型号看起来不同');
 }
 return {...details,main:details.main||part?.name||'',color:['主板','显卡'].includes(slot)?color:'',
  issues,missing:!!part?.goodsId&&!details.raw};
}

/** 按当前店铺建立 ERP 搜索索引，输出源已有货号和星号商品从新品候选排除。 */
export function erpCatalogIndex(rows){
 return rows.filter(row=>!excludedComponent({erpName:row.name})).map(row=>({
  ...row,erpName:row.name,searchText:searchable(row.name+' '+row.goodsId),
 }));
}
export function searchErpParts(index,query,existing,limit=20){
 const terms=searchable(query).split(/\s+/).filter(Boolean);
 if(terms.join('').length<2)return [];
 const found=[];
 for(const row of index){
  if(existing.has(row.goodsId)||!terms.every(term=>row.searchText.includes(term)))continue;
  found.push(row);
  if(found.length===limit)break;
 }
 return found;
}
