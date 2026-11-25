import {Fault} from './config.mjs';
import {globalTaxShops as shops} from './global-tax.mjs';
import {priceHistorySnapshot} from './price-history.mjs';

export const crossShopCostAction=action=>action==='tax_sync'||action==='erp_sync';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const version=value=>value===null||typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const text=value=>typeof value==='string'&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const stock=value=>value===null||number(value,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
const valid=(condition,field)=>{if(!condition)throw new Fault('VALIDATION_FAILED',400,{field});};

export function validateCostSync(rows,shop){
 const action=rows[0].action;
 const tax=action==='tax_sync';
 const keys=['id','action','expected_version','expected_versions','fields',...(tax?['expected_shared_version']:[])];
 for(const row of rows){
  valid(row.action===action&&Object.keys(row).length===keys.length&&Object.keys(row).every(key=>keys.includes(key))&&/^\d{1,20}$/.test(row.id),'changes.cost_sync');
  valid(plain(row.expected_versions)&&Object.keys(row.expected_versions).length===shops.length&&
   shops.every(id=>Object.hasOwn(row.expected_versions,id)&&version(row.expected_versions[id]))&&
   row.expected_version===row.expected_versions[shop]&&(!tax||version(row.expected_shared_version)),'changes.expected_versions');
  const f=row.fields;
  valid(plain(f)&&(tax?Object.keys(f).length===1&&number(f.tax,0,100000000):
   Object.keys(f).every(key=>['erp','stockAvailable','name','sku','stockIncomingAvailable'].includes(key))&&text(f.name)&&text(f.sku)&&(f.erp===null||number(f.erp,0,100000000000))&&
   stock(f.stockAvailable)&&(!Object.hasOwn(f,'stockIncomingAvailable')||stock(f.stockIncomingAvailable))),'changes.cost_sync.fields');
 }
 return action;
}

function translate(error){
 if(error.code==='42883'||error.code==='3F000')throw new Fault('NAS_COST_SYNC_NOT_INSTALLED',503);
 if(error.code==='P0001'){
  if(error.message==='FORBIDDEN')throw new Fault('FORBIDDEN',403);
  if(error.message==='VERSION_CONFLICT')throw new Fault('VERSION_CONFLICT',409,{goods_id:error.detail});
  if(error.message==='OPERATION_REUSED')throw new Fault('OPERATION_REUSED',409);
  if(error.message==='COST_SYNC_INVALID')throw new Fault('VALIDATION_FAILED',400,{field:'cost_sync'});
 }
 throw error;
}

export async function costSyncSnapshot(db,shop,member){
 try{
  const {rows:[{data}]}=await db.query('SELECT workbench_sources.cost_sync_snapshot($1,$2,$3) AS data',[shop,member.workspaceId,member.uid]);
  return data;
 }catch(error){translate(error);}
}

export async function applyCostSync(db,{member,shop,rows,action,operationId,requestId,hash}){
 try{
  const {rows:[{data}]}=await db.query('SELECT workbench_sources.apply_cost_sync($1,$2,$3,$4,$5::jsonb,$6) AS data',
   [shop,member.workspaceId,member.uid,action,JSON.stringify(rows),operationId]);
  // 每店使用自己的回执版本和历史，发起店仍由原工作区队列登记。
  // 旧库函数可能忽略新增观察。回执前核对写入结果，不完整则整笔事务回滚。
  const expectedIncoming=new Map(rows.filter(row=>Object.hasOwn(row.fields,'stockIncomingAvailable'))
   .map(row=>[row.id,row.fields.stockIncomingAvailable]));
  const receipts={},audits={},history={};
  for(const id of shops){
   const context=data[id];
   for(const row of context.changes){
    if(expectedIncoming.has(row.id)&&row.after?.stockIncomingAvailable!==expectedIncoming.get(row.id))
     throw new Fault('NAS_COST_SYNC_NOT_INSTALLED',503);
   }
   const changes=context.changes.map(row=>({id:row.id,version:row.version,...(row.manual?{skipped:'manual_tax'}:{})}));
   receipts[id]={shop_id:id,operation_id:operationId,kind:'costs',changes};
   audits[id]=context.changes.map(({id,version,previous_version,manual})=>({id,version,previous_version,manual}));
   history[id]=priceHistorySnapshot({...context,costs:new Map(context.costs.map(cost=>[cost.goodsId,cost])),
    changes:new Map(context.changes.map(row=>[row.id,{before:row.before,after:row.after}]))});
  }
  await db.query('SELECT workbench_sources.finish_cost_sync($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)',
   [shop,member.workspaceId,member.uid,operationId,hash,action,JSON.stringify(receipts),JSON.stringify(audits),JSON.stringify(history),requestId]);
  return data[shop].changes.map((row,index)=>({id:row.id,action:row.manual?'tax_file_skipped':action,
   previousVersion:row.previous_version,result:receipts[shop].changes[index]}));
 }catch(error){translate(error);}
}
