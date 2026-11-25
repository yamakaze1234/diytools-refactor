import {createHash} from 'node:crypto';
import {buildNasProfitReport} from '../../../apps/desktop/public/workbench/nas-profit-check.js';
import {Fault,requireValue} from './config.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const validConfigId=value=>typeof value==='string'&&/^[\w.:\-]{1,128}$/.test(value);
const shape=(input,keys)=>input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>keys.includes(key));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failureStatus={FORBIDDEN:403,NOT_FOUND:404,OPERATION_REUSED:409,VERSION_CONFLICT:409,PROFIT_RESULT_STALE:409};

async function observe(db,action,input){
 try{
  const {rows:[row]}=await db.query('SELECT intel_live.profit_observe($1,$2::jsonb) AS data',[action,JSON.stringify(input)]);
  requireValue(row?.data,'INVALID_API_RESPONSE',503);
  if(row.data.error)throw new Fault(row.data.error,failureStatus[row.data.error]??400);
  return row.data;
 }catch(error){
  if(error.code==='42883')throw new Fault('NAS_PROFIT_NOT_INSTALLED',503);
  throw error;
 }
}

async function snapshotRows(ids,loadSaved,shop){
 const data=await loadSaved(ids),versions=new Map(data.configs.map(row=>[row.id,row.nasVersion]));
 requireValue(ids.every(id=>/^[1-9]\d{0,18}$/.test(versions.get(id)||'')),'VERSION_CONFLICT',409);
 let report;
 try{report=buildNasProfitReport({...data,shopId:shop,configIds:ids});}
 catch{throw new Fault('VERSION_CONFLICT',409);}
 // 比较口径含 formulaVersion/overviewFeeRate，费率或公式变化不能沿用旧亏损快照指纹。
 return report.results.map(row=>({...row,config_version:versions.get(row.config_id),fingerprint:hash(row.snapshot)}));
}

/** 调用方绑定该店的已认证运营；请求只提交配置 ID，报告由 NAS 自己核算。 */
export async function runNasProfit(db,action,input,loadSaved,shop='intel'){
 requireValue(input?.shopId===shop);
 if(action==='start'){
  requireValue(shape(input,['shopId','requestId','configIds'])&&uuid(input.requestId)&&Array.isArray(input.configIds)&&
   input.configIds.length>0&&input.configIds.length<=5000&&input.configIds.every(validConfigId)&&new Set(input.configIds).size===input.configIds.length);
  const ids=[...input.configIds].sort(),requestId=input.requestId.toLowerCase(),scopeHash=hash(ids);
  const previous=await observe(db,'lookup',{requestId,scopeHash});
  if(previous.runId)return previous;
  const results=await snapshotRows(ids,loadSaved,shop);
  return observe(db,'start',{requestId,scopeHash,results});
 }
 if(action==='history'){
  requireValue(shape(input,['shopId']));return observe(db,'history',{});
 }
 if(action==='status'){
  const offset=input.offset??0;
  requireValue(shape(input,['shopId','runId','offset'])&&uuid(input.runId)&&Number.isSafeInteger(offset)&&offset>=0&&offset<=5000);
  return observe(db,'status',{runId:input.runId.toLowerCase(),offset});
 }
 if(action==='reset'){
  requireValue(shape(input,['shopId','requestId','configId','metric','resultId'])&&uuid(input.requestId)&&validConfigId(input.configId)&&
   uuid(input.resultId)&&input.metric==='accounting');
  const requestId=input.requestId.toLowerCase(),resultId=input.resultId.toLowerCase(),configId=input.configId;
  const prior=await observe(db,'reset_lookup',{requestId,resultId,configId});
  if(prior.ok)return prior;
  let row;
  try{[row]=await snapshotRows([configId],loadSaved,shop);}
  catch(error){if(error.status===404||error.status===409)throw new Fault('PROFIT_RESULT_STALE',409);throw error;}
  return observe(db,'reset',{requestId,resultId,configId,fingerprint:row.fingerprint});
 }
 throw new Fault('METHOD_NOT_ALLOWED',405);
}
