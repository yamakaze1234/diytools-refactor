/** 旧备份仅提取明确归属当前店铺的配置副本，不恢复旧库、店铺设置或同步队列。 */
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const cleanPath=/^\/uploads\/[0-9a-f]{64}\.(?:png|jpe?g)$/;
const refList=row=>[row.caseImage,...(row.posterImages||[]).map(image=>image.url)].filter(Boolean);
export function prepareLegacyNasImport(text,{shopId='intel',uuid=()=>crypto.randomUUID()}={}){
 let input;try{input=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Error('不是有效的 JSON 备份。');}
 if(!record(input)||!Array.isArray(input.configs)||input.configs.length>5000)throw Error('备份应包含至多 5000 套配置。');
 const valid=[],invalid=[],productIds=new Map();let ignored=0;
 for(const old of input.configs){
  if(!record(old)||old.shopId!==shopId||old.deletedAt){ignored++;continue;}
  if(typeof old.id!=='string'||typeof old.name!=='string'||!old.name.trim()||!Array.isArray(old.parts)||!Array.isArray(old.modules)||
   (old.posterImages!==undefined&&!Array.isArray(old.posterImages))){invalid.push({name:old.name||'未命名',reason:'缺少完整配置字段'});continue;}
  const row=structuredClone(old),links=refList(row);
  if(links.some(path=>!cleanPath.test(path))){invalid.push({name:row.name,reason:'图片是旧本机路径或外部链接，需先登记同一原图'});continue;}
  const group=old.productId||old.id;
  if(!productIds.has(group))productIds.set(group,uuid());
  row.id=uuid();row.productId=productIds.get(group);row.product=row.product||row.name;
  row.spu='';row.skuId='';row.productUrl='';row.actualParts??=structuredClone(row.parts);row.addons??=[];row.price??=null;
  delete row.deletionSessionId;delete row.published;delete row.quotation;delete row.priceBasis;delete row.archived_at;delete row.final_price_cents;
  valid.push({document:row,images:links});
 }
 return {valid,invalid,ignored,images:[...new Set(valid.flatMap(row=>row.images))]};
}
