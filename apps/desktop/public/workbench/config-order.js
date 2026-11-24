/** 根据持久化顺序恢复列表，兼容旧配置缺少排序字段的情况。 */
/** 配置持久顺序规则：恢复 workspaceOrder，并在复制配置时插入相邻位置。 */
export function restoreConfigOrder(configs){
 const groups=new Map();for(const c of configs){const key=JSON.stringify([c.shopId,c.productId||c.product||c.spu]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 for(const group of groups.values()){
  if(group.every(c=>Number.isFinite(c.workspaceOrder))&&new Set(group.map(c=>c.workspaceOrder)).size===group.length){group.sort((a,b)=>a.workspaceOrder-b.workspaceOrder);continue;}
  const line=c=>c.wpsImport?.lineStart,num=c=>/^配置\s*(\d+)$/.exec(c.name||'')?.[1];
  if(group.every(c=>Number.isFinite(line(c)))&&new Set(group.map(line)).size===group.length)group.sort((a,b)=>line(a)-line(b));
  else if(group.every(c=>num(c))&&new Set(group.map(num)).size===group.length)group.sort((a,b)=>Number(num(a))-Number(num(b)));
 }
 return [...groups.values()].flat();
}

// Persist insertion beside its source, without renumbering other links.
/** 将副本插入来源配置之后，保持其他配置相对次序。 */
export function insertConfigAfter(configs,sourceId,duplicate){
 const index=configs.findIndex(c=>c.id===sourceId),source=configs[index];
 const group=c=>JSON.stringify([c.shopId,c.productId||c.product||c.spu]);
 if(!source||source.deletedAt)throw Error('原配置已删除或不存在');
 if(!duplicate?.id||configs.some(c=>c.id===duplicate.id)||group(source)!==group(duplicate))throw Error('复制配置的 ID 或链接无效');
 const siblings=configs.filter(c=>group(c)===group(source));
 let ordered=configs,position=siblings.indexOf(source);
 const rank=rows=>position+1<rows.length?(rows[position].workspaceOrder+rows[position+1].workspaceOrder)/2:rows[position].workspaceOrder+1;
 const usable=siblings.every((c,i)=>Number.isFinite(c.workspaceOrder)&&(!i||c.workspaceOrder>siblings[i-1].workspaceOrder));
 let value=usable?rank(siblings):NaN;
 if(!Number.isFinite(value)||value<=source.workspaceOrder||(position+1<siblings.length&&value>=siblings[position+1].workspaceOrder)){
  // Legacy/duplicate ranks or exhausted floating-point gaps: repair this link only.
  const start=configs.indexOf(siblings[0]),ranks=new Map(siblings.map((c,i)=>[c.id,start+i*2]));
  ordered=configs.map(c=>ranks.has(c.id)?{...c,workspaceOrder:ranks.get(c.id)}:c);
  value=ranks.get(sourceId)+1;
 }
 const result=[...ordered];result.splice(index+1,0,{...duplicate,workspaceOrder:value});return result;
}

const CONFIG_NUMBER_PREFIX=/^配置\s*(?:[0-9]+|[一二三四五六七八九十百零〇两]+)(?=$|[\s：:·\-—_（(丨|])/;

/** 按新序号替换文本开头的“配置N”编号，保留其余文案；无编号前缀时原样返回。 */
export function renumberConfigPrefix(text,ordinal){
 const raw=String(text??'');
 if(!Number.isInteger(ordinal)||ordinal<1)return raw;
 const match=CONFIG_NUMBER_PREFIX.exec(raw);
 return match?`配置${ordinal}${raw.slice(match[0].length)}`:raw;
}

/** 按链接现有顺序连续编号；只替换明确的配置编号，保留容量、型号及特殊名称。 */
export function planConfigRenumber(configs){
 let ordinal=0;
 return configs.filter(c=>!c.deletedAt).map(c=>{
  const before=String(c.name||'');
  const match=CONFIG_NUMBER_PREFIX.exec(before);
  const nextOrdinal=match?++ordinal:null;
  const after=match?`配置${nextOrdinal}${before.slice(match[0].length)}`:before;
  const shortNameBefore=String(c.shortName||'');
  const shortNameAfter=nextOrdinal?renumberConfigPrefix(shortNameBefore,nextOrdinal):shortNameBefore;
  return {id:c.id,ordinal:nextOrdinal,before,after,shortNameBefore,shortNameAfter,shortNameChanged:shortNameBefore!==shortNameAfter,skipped:!match};
 });
}

/** 应用重新编号到单套完整配置，同步更新简称及海报副标题中的配置编号。 */
export function applyConfigRenumber(config,row,autoShortName=null){
 if(!config||!row)return config;
 const oldShortName=config.shortName;
 config.name=row.after;
 if(!Number.isInteger(row.ordinal)||row.ordinal<1)return config;
 if(config.shortNameAuto===true&&typeof autoShortName==='function'){
  config.shortName=autoShortName(config,config.nameFormat||'compact');
 }else if(typeof config.shortName==='string'&&config.shortName){
  config.shortName=renumberConfigPrefix(config.shortName,row.ordinal);
 }
 const shortNameUpdated=config.shortName!==oldShortName;
 if(typeof config.posterSubtitle==='string'){
  if(shortNameUpdated&&config.posterSubtitle===oldShortName)delete config.posterSubtitle;
  else config.posterSubtitle=renumberConfigPrefix(config.posterSubtitle,row.ordinal);
 }
 for(const styles of [config.textStyles,config.skuTextStyles]){
  if(typeof styles?.['header.subtitle']?.text==='string'){
   if(shortNameUpdated&&styles['header.subtitle'].text===oldShortName)delete styles['header.subtitle'].text;
   else styles['header.subtitle'].text=renumberConfigPrefix(styles['header.subtitle'].text,row.ordinal);
  }
 }
 return config;
}

/** 删除后接续本链接下一套或上一套；整链移除时才转到相邻链接。 */
export function configAfterRemoval(configs,activeId,removedIds){
 const removed=new Set(removedIds),rows=configs.filter(c=>!c.deletedAt),active=rows.find(c=>c.id===activeId);
 if(active&&!removed.has(activeId))return activeId;
 if(!active)return rows.find(c=>!removed.has(c.id))?.id??null;
 const siblings=rows.filter(c=>c.shopId===active.shopId&&c.productId===active.productId),index=siblings.indexOf(active);
 return siblings.slice(index+1).find(c=>!removed.has(c.id))?.id??siblings.slice(0,index).reverse().find(c=>!removed.has(c.id))?.id??
  rows.slice(rows.indexOf(active)+1).find(c=>!removed.has(c.id))?.id??rows.slice(0,rows.indexOf(active)).reverse().find(c=>!removed.has(c.id))?.id??null;
}
