/** 三店共用核算价复用原成本队列；跨店权限、版本与落库由受限数据库事务核验。 */
import {Fault} from './config.mjs';
import {priceHistorySnapshot} from './price-history.mjs';

export const globalTaxShops=['intel','gigabyte','jonsbo'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validVersion=value=>value===null||typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const valid=(condition,field)=>{if(!condition)throw new Fault('VALIDATION_FAILED',400,{field});};

export function validateGlobalTax(row,shop){
 valid(plain(row)&&Object.keys(row).every(key=>['id','action','expected_version','expected_versions','fields'].includes(key)), 'changes.global_tax');
 valid(/^\d{1,20}$/.test(row.id)&&row.action==='global_tax'&&plain(row.expected_versions)&&
  Object.keys(row.expected_versions).length===3&&globalTaxShops.every(id=>Object.hasOwn(row.expected_versions,id)&&validVersion(row.expected_versions[id]))&&
  validVersion(row.expected_version)&&row.expected_version===row.expected_versions[shop],'changes.expected_versions');
 const fields=row.fields;
 valid(plain(fields)&&Object.keys(fields).length===1,'changes.global_tax.fields');
 valid(fields.restore===true&&Object.keys(fields)[0]==='restore'||Object.keys(fields)[0]==='tax'&&typeof fields.tax==='number'&&
  Number.isFinite(fields.tax)&&fields.tax>=0&&fields.tax<=100000000&&Math.abs(fields.tax*100-Math.round(fields.tax*100))<1e-6,'changes.global_tax.fields');
}

export async function applyGlobalTax(db,{member,shop,row,operationId,requestId,hash}){
 try{
  const {rows:[{data}]}=await db.query('SELECT workbench_sources.global_tax($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) AS data',
   [shop,member.workspaceId,member.uid,row.id,JSON.stringify(row.expected_versions),JSON.stringify(row.fields),operationId,requestId]);
  const versions=Object.fromEntries(globalTaxShops.map(id=>[id,data[id].version]));
  const result={id:row.id,version:versions[shop],shop_versions:versions};
  const receipt={shop_id:shop,operation_id:operationId,kind:'costs',changes:[result]};
  const history={};
  for(const id of globalTaxShops){
   const context=data[id];
   const snapshot=priceHistorySnapshot({...context,costs:new Map(context.costs.map(cost=>[cost.goodsId,cost])),
    changes:new Map([[row.id,{before:context.before,after:context.after}]])});
   history[id]={...snapshot,previousVersion:context.previous_version,version:context.version};
  }
  await db.query('SELECT workbench_sources.finish_global_tax($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)',
   [shop,member.workspaceId,member.uid,operationId,hash,JSON.stringify(receipt),JSON.stringify(history),requestId,row.id]);
  return {id:row.id,action:'global_tax',previousVersion:data[shop].previous_version,result};
 }catch(error){
  if(error.code==='42883'||error.code==='3F000')throw new Fault('NAS_GLOBAL_TAX_NOT_INSTALLED',503);
  if(error.code==='P0001'){
   if(error.message==='FORBIDDEN')throw new Fault('FORBIDDEN',403);
   if(['VERSION_CONFLICT','GLOBAL_TAX_RESTORE_CONFLICT','OPERATION_REUSED'].includes(error.message))throw new Fault(error.message,409);
   if(error.message==='GLOBAL_TAX_INVALID')throw new Fault('VALIDATION_FAILED',400,{field:'global_tax'});
  }
  throw error;
 }
}
