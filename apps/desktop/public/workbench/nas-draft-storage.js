/** NAS 配置草稿以原 JSON 字符串存盘。镜像只属于当前店铺，写入完成以事务提交为准。 */
import {NasApiError} from './nas-api-client.js';

const unavailable=error=>error instanceof NasApiError?error:new NasApiError('DRAFT_STORAGE_UNAVAILABLE',0,{quota:error?.name==='QuotaExceededError'});
export function createNasDraftStorage({indexedDB=globalThis.indexedDB,legacyStorage=null,onError=null,keyRange=globalThis.IDBKeyRange}={}){
 let connection,activePrefix,loaded,loading,migration,writeCount=0;
 const cache=new Map(),tails=new Map(),slots=new Map(),failures=new Map(),latest=new Map();
 function connect(){
  if(!connection)connection=new Promise((resolve,reject)=>{
   const req=indexedDB.open('diy-nas-drafts',1);
   req.onupgradeneeded=()=>req.result.createObjectStore('drafts');
   req.onerror=()=>reject(req.error);
   req.onsuccess=()=>{
    const db=req.result;
    db.onversionchange=()=>{db.close();connection=null;};
    resolve(db);
   };
  }).catch(error=>{connection=null;throw unavailable(error);});
  return connection;
 }
 async function transaction(mode,run){
  const db=await connect();
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('drafts',mode,mode==='readwrite'?{durability:'strict'}:undefined);
   let value,cause;
   const guard=fn=>(...args)=>{try{fn(...args);}catch(error){cause=error;tx.abort();}};
   const read=(request,fn)=>{request.onsuccess=guard(()=>fn(request.result));};
   tx.oncomplete=()=>resolve(value);
   tx.onerror=event=>{cause??=event.target.error;};
   tx.onabort=()=>reject(unavailable(cause||tx.error));
   guard(run)(tx.objectStore('drafts'),read,result=>{value=result;});
  }).catch(error=>{throw unavailable(error);});
 }
 function legacy(prefix){
  const entries=new Map();
  try{
   for(let i=0;i<(legacyStorage?.length??0);i++){
    const key=legacyStorage.key(i);
    if(key?.startsWith(prefix)){const value=legacyStorage.getItem(key);if(value!==null)entries.set(key,value);}
   }
  }catch(error){throw unavailable(error);}
  return entries;
 }
 function scan(prefix){
  return transaction('readonly',(store,read,done)=>{
   const values=new Map();
   // 即使驱动不支持 IDBKeyRange，也只读取目标前缀下的正文。
   const req=keyRange?store.openCursor(keyRange.bound(prefix,prefix+'\uffff')):store.openKeyCursor();
   read(req,cursor=>{
    if(!cursor){done(values);return;}
    if(cursor.key<prefix){cursor.continue(prefix);return;}
    if(!cursor.key.startsWith(prefix)){done(values);return;}
    const key=cursor.key;
    if(keyRange)values.set(key,cursor.value);else read(store.get(key),value=>values.set(key,value));
    cursor.continue();
   });
  });
 }
 async function migrate(prefix){
  const old=legacy(prefix);
  if(!old.size)return;
  await transaction('readwrite',(store,read)=>{
   for(const [key,value] of old)read(store.get(key),saved=>{if(saved===undefined)store.add(value,key);});
  });
  // 迁移事务成功后才释放旧空间；另一个旧窗口在此期间改过的值不能误删。
  try{for(const [key,value] of old)if(legacyStorage.getItem(key)===value)legacyStorage.removeItem(key);}
  catch(error){throw unavailable(error);}
 }
 function migrateLegacy(prefix){
  if(loaded===prefix)return Promise.resolve();
  if(migration?.prefix!==prefix)migration={prefix,promise:migrate(prefix).catch(error=>{migration=null;throw error;})};
  return migration.promise;
 }
 async function loadPrefix(prefix){
  if(loaded===prefix&&activePrefix===prefix)return;
  if(loading?.prefix===prefix)return loading.promise;
  activePrefix=prefix;loaded=null;cache.clear();
  const promise=scan(prefix).then(rows=>{
   if(activePrefix!==prefix)return;
   cache.clear();for(const [key,value] of rows)cache.set(key,value);
   loaded=prefix;
  }).finally(()=>{if(loading?.prefix===prefix)loading=null;});
  loading={prefix,promise};return promise;
 }
 function remember(key,value){
  if(!activePrefix||!key.startsWith(activePrefix))return;
  if(value===null)cache.delete(key);else cache.set(key,value);
 }
 // 同步占据所有目标键的队尾。批量删除也与后到的单键编辑保持顺序。
 function schedule(keys,job,write=true){
  const prior=keys.map(key=>tails.get(key)).filter(Boolean);
  for(const key of keys)slots.delete(key);
  if(write)writeCount++;
  const task=Promise.all(prior).then(job);
  const tail=task.catch(()=>{}).finally(()=>{
   for(const key of keys)if(tails.get(key)===tail){tails.delete(key);latest.delete(key);}
   if(write)writeCount--;
  });
  for(const key of keys)tails.set(key,tail);
  return task;
 }
 function change(key,value,expected){
  return transaction('readwrite',(store,read,done)=>{
   const apply=()=>{if(value===null)store.delete(key);else store.put(value,key);done(true);};
   if(expected===undefined)apply();
   else read(store.get(key),old=>{if((old??null)===expected)apply();else done(false);});
  });
 }
 function write(key,value,{expected,notify:callback}={},background=false){
  const token={};latest.set(key,token);
  if(background){
   remember(key,value);
   const slot=slots.get(key);
   if(slot&&(expected===undefined||expected===slot.value)){slot.value=value;slot.token=token;return slot.task;}
  }
  const slot={value,token,expected};
  const task=schedule([key],async()=>{
   if(slots.get(key)===slot)slots.delete(key);
   // 上一个乐观值未落盘时，重试仍比较原磁盘基线，不能覆盖别的窗口。
   const failed=failures.get(key);
   const retryingEdit=failed?.background&&failed.value===slot.expected;
   const base=retryingEdit?failed.expected:slot.expected;
   try{
    if(!await change(key,slot.value,base))throw new NasApiError('UNSAVED_DRAFT',409);
    if(latest.get(key)===slot.token)remember(key,slot.value);
   }catch(error){
    // 强写失败不会推进控制器，之前未落盘的乐观编辑仍需使用最初的磁盘基线重试。
    const failure=!background&&retryingEdit?{...failed,error}:{error,value:slot.value,expected:base,background,callback};
    failures.set(key,failure);onError?.(key,error);callback?.(key,error);throw error;
   }
   const recovered=failures.delete(key);
   if(recovered){onError?.(key,null);callback?.(key,null);}
  });
  if(background){slot.task=task;slots.set(key,slot);}
  return task;
 }
 function getFresh(key){
  const token={};latest.set(key,token);
  return schedule([key],async()=>{
   if(failures.get(key)?.background)throw failures.get(key).error;
   const value=await transaction('readonly',(store,read,done)=>read(store.get(key),v=>done(v??null)));
   if(latest.get(key)===token)remember(key,value);
   return value;
  },false);
 }
 // 缓存清理需要等写入结束，再把失败草稿交给用户处理。
 async function settle(prefix=''){
  for(;;){
   const work=[...tails].filter(([key])=>key.startsWith(prefix));
   if(!work.length)break;
   await Promise.all(work.map(([,tail])=>tail));
  }
 }
 async function flush(prefix=''){
  await settle(prefix);
  for(const [key,failure] of failures)if(key.startsWith(prefix))throw failure.error;
 }
 async function listFresh(prefix){
  await flush(prefix);
  const result=legacy(prefix);
  for(const [key,value] of await scan(prefix))result.set(key,value);
  return result;
 }
 function compareAndSet(key,expected,value){
  const token={};latest.set(key,token);
  return schedule([key],async()=>{
   if(failures.has(key))throw failures.get(key).error;
   const matched=await change(key,value,expected);
   if(matched&&latest.get(key)===token)remember(key,value);
   return matched;
  });
 }
 function discard(entries,validate){
  const keys=entries.map(entry=>entry.key),token={};
  for(const key of keys)latest.set(key,token);
  return schedule(keys,async()=>{
   if(!keys.length)return false;
   const removed=await transaction('readwrite',(store,read,done)=>{
    let remaining=entries.length,allowed=true;
    for(const entry of entries)read(store.get(entry.key),value=>{
     if(!validate(value??null,entry))allowed=false;
     if(--remaining===0){if(allowed)for(const key of keys)store.delete(key);done(allowed);}
    });
   });
   if(removed)for(const key of keys){
    if(latest.get(key)===token)remember(key,null);
    const failed=failures.get(key);
    if(failures.delete(key)){onError?.(key,null);failed.callback?.(key,null);}
   }
   return removed;
  });
 }
 return {migrateLegacy,loadPrefix,getFresh,listFresh,compareAndSet,settle,flush,
  getCached:key=>cache.get(key)??null,listCached:prefix=>prefix===loaded?new Map(cache):new Map(),
  hasPendingWrites:()=>writeCount>0,hasFailure:key=>failures.has(key),
  enqueueSet:(key,value,options)=>write(key,value,options,true),enqueueRemove:(key,options)=>write(key,null,options,true),
  setNow:(key,value,options)=>write(key,value,options),removeNow:(key,options)=>write(key,null,options),
  discardBatch:discard,discardIf:(key,fn)=>discard([{key}],fn)};
}
