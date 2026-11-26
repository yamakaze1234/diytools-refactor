// 数据库函数重复核验归属、版本和引用；HTTP 仅返回允许公开的错误及数量。
import {Fault} from './config.mjs';

export async function retentionQuery(db,sql,params){
 try{return await db.query(sql,params);}
 catch(error){
  if(error.code==='42883')throw new Fault('NAS_RETENTION_NOT_INSTALLED',503);
  if(error.code==='42501')throw new Fault('FORBIDDEN',403);
  if(error.code!=='P0001')throw error;
  if(error.message==='CATALOG_IN_USE'){
   const {configurations,templates}=JSON.parse(error.detail);
   if(![configurations,templates].every(n=>Number.isSafeInteger(n)&&n>=0))throw error;
   throw new Fault('CATALOG_IN_USE',409,{configurations,templates});
  }
  const status={NOT_FOUND:404,FORBIDDEN:403,VERSION_CONFLICT:409,INVALID_CONFIGURATION_STATE:409,INVALID_CATALOG_STATE:409};
  if(Object.hasOwn(status,error.message))throw new Fault(error.message,status[error.message]);
  throw error;
 }
}

/** 定时任务按店串行执行；跳过重叠轮次，停止时等待已发出的数据库请求返回。 */
export function startRetention(stores,{initialDelayMs,intervalMs,workspaceId},log=console.error){
 let pending=null,stopped=false,interval;
 const run=()=>{
  if(pending||stopped)return;
  pending=(async()=>{
   for(const [shop,store] of stores){
    if(stopped)break;
    try{await store.purgeExpiredRetention(workspaceId);}
    catch{log(`回收站定时清理失败（${shop}），下次巡检将重试`);}
   }
  })().finally(()=>{pending=null;});
 };
 const first=setTimeout(()=>{run();interval=setInterval(run,intervalMs);interval.unref();},initialDelayMs);
 first.unref();
 return async()=>{stopped=true;clearTimeout(first);clearInterval(interval);await pending;};
}
