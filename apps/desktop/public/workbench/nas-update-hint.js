/** 只用服务端审计时间和本机收到的业务回执判断更新，不比较电脑与 NAS 的时钟。 */
export function createNasUpdateHint(){
 let baseline=null,remoteTime=null;
 const own=new Set();
 const key=(kind,id,version)=>JSON.stringify([kind,id,String(version)]);
 function saved(receipt){
  const kind=receipt.kind||(receipt.configuration_id?'configurations':null);
  if(!kind)return;
  const record=row=>{
   const id=row.configuration_id??row.resource_id??row.id;
   if(id&&row.version!=null)own.add(key(kind,id,row.version));
  };
  for(const change of receipt.changes??[receipt]){
   record(change);
   // 删除、恢复及编号可能由同一个事务改变多套配置。
   for(const row of change.reordered??[])record(row);
  }
 }
 function observe({updatedAt,activity},poll){
  const latest=Date.parse(updatedAt)||0;
  if(baseline===null){baseline=latest;return;}
  if(latest<=baseline)return;
  const newer=activity.filter(row=>Date.parse(row.created_at)>baseline);
  const external=newer.find(row=>!own.has(key(row.kind,row.resource_id,row.next_version)));
  // 普通回读不能吞掉他人同时提交的更新。等下一次小时检查再提醒。
  if(external||!newer.length){
   if(!poll)return;
   remoteTime=external?.created_at??updatedAt;
  }
  baseline=latest;
  own.clear();
 }
 return {saved,observe,time:()=>remoteTime};
}

/** 前台唤醒和定时器共用截止时间，避免刚恢复窗口就连续发两次请求。 */
export function watchNasUpdates(check){
 const hour=3_600_000,events=new AbortController();
 let next=Date.now()+hour,timeout;
 function due(){
  if(Date.now()<next){arm();return;}
  next=Date.now()+hour;
  arm();
  void check();
 }
 function arm(){
  clearTimeout(timeout);
  timeout=setTimeout(due,Math.max(0,next-Date.now()));
 }
 const options={signal:events.signal};
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)due();},options);
 window.addEventListener('focus',due,options);
 if(window.parent!==window)window.parent.addEventListener('focus',due,options);
 // bfcache 恢复已有页面时沿用同一基线，销毁页面时移除宿主上的监听。
 window.addEventListener('pageshow',due,options);
 arm();
 return ()=>{clearTimeout(timeout);events.abort();};
}
