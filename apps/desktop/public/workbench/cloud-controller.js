/** 云同步界面控制层：协调登录、保存、同步引擎和回读；用操作代次阻止暂停后的旧异步结果继续应用。 */
import {createCloudEngine} from './cloud-engine.js';

/** 通过本机桥接调用云操作，并保留 HTTP 状态供上层识别失败。 */
export async function nativeCloud(action,payload={}){
 const response=await fetch('/api/native-cloud/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store'});
 const value=await response.json();
 if(!response.ok)throw Object.assign(Error(value.error||'云同步失败，本机修改已保留'),{status:response.status});
 return value;
}

// Startup/member login connects the bundled bootstrap once and enables this
// login's automatic cycle. Cancellation fences every asynchronous boundary.
/** 建立单次同步任务和成员归属检查，所有启动、手动与定时同步共用这套状态。 */
export function createCloudController({request=nativeCloud,flush,receive,isBlocked=()=>false,onChange=()=>{},onProgress=()=>{},makeEngine=createCloudEngine}){
 let view={session:{authenticated:false},checkpoint:{initialized:false},running:false,automatic:false,error:null},flight=null,startFlight=null,logoutFlight=null,stopped=false,needsReceive=false,generation=0,verifiedOwner=null;
 const emit=()=>onChange({...view});
 const engine=makeEngine({load:()=>request('load'),commit:input=>request('commit',input),call:input=>request('call',input),
  uploadAssets:({urls})=>request('assetsEnsure',{urls}),downloadAssets:({urls})=>request('assetsDownload',{urls}),onProgress});
 const ready=()=>view.session.authenticated&&view.checkpoint.initialized&&view.session.member?.uid===view.checkpoint.uid&&view.session.member?.workspaceId===view.checkpoint.workspaceId;
 const owner=()=>view.session.authenticated&&view.session.member?.uid&&view.session.member?.workspaceId?{uid:view.session.member.uid,workspaceId:view.session.member.workspaceId}:null;
 const ownerKey=()=>{const member=owner();return member?JSON.stringify([member.uid,member.workspaceId]):null;};
 const cancelError=()=>Object.assign(Error('本轮同步已暂停'),{code:'CLOUD_STOPPED'});
 const check=operation=>{if(stopped||isBlocked()||operation!==generation)throw cancelError();};
 /** 成员或工作区变化时停止复用原同步资料，避免跨账号应用数据。 */
 function checkOwner(expected){const current=owner();if(!current||current.uid!==expected.uid||current.workspaceId!==expected.workspaceId||view.checkpoint.initialized&&!ready())throw Error('请登录数据所属成员，账号或工作区不匹配');}
 async function refresh(operation=generation){const result=await request('status');if(operation!==generation)return view;view={...view,...result,running:Boolean(flight)};if(!view.checkpoint.initialized||verifiedOwner!==ownerKey())verifiedOwner=null;emit();return view;}
 async function deliver(){if(needsReceive&&!isBlocked()){const accepted=await receive();if(accepted!==false)needsReceive=false;}}
 function launch(operation,task){
  const job=Promise.resolve().then(async()=>{try{check(operation);return await task();}
   catch(error){if(operation===generation){view.error=error.message;view.automatic=false;}needsReceive=true;throw error;}
   finally{try{await refresh(operation);await deliver();}catch(error){if(operation===generation)view.error??=error.message;}if(flight===job){view.running=false;flight=null;}emit();}});
  flight=job;view.running=true;view.error=null;emit();return job;
 }
 /** 先保存编辑草稿，再接入及校验原图，最后执行同步并通知工作台回读。 */
 async function synchronize(operation,upload,expected){
  check(operation);checkOwner(expected);
  await flush();check(operation);
  await request('resume');check(operation);
  await refresh(operation);check(operation);checkOwner(expected);
  if(!view.checkpoint.initialized){
   await request('connect');needsReceive=true;check(operation);
   await refresh(operation);check(operation);checkOwner(expected);
   if(!view.checkpoint.initialized)throw Error('本机云同步资料未接入，请重试自动连接');
   await deliver();check(operation);
  }
  await verifyOnce(operation,expected);check(operation);checkOwner(expected);
  const result=await engine.run({member:view.session.member,upload});
  view.summary=result;needsReceive=true;await deliver();return result;
 }
 /** 同一已确认成员只做一次自动原图校验；手动校验可强制重跑。 */
 async function verifyOnce(operation,expected,force=false){
  check(operation);checkOwner(expected);
  const key=JSON.stringify([expected.uid,expected.workspaceId]);
  if(typeof engine.verifyAssets!=='function'||!force&&verifiedOwner===key)return;
  const result=await engine.verifyAssets();check(operation);
  if(result===false||result?.cancelled)throw cancelError();
  await refresh(operation);check(operation);checkOwner(expected);
  verifiedOwner=key;return result;
 }
 function run(upload=true){
  if(logoutFlight)return Promise.reject(Error('正在退出登录，请稍后重试'));
  if(flight)return flight;
  if(isBlocked())return Promise.reject(Error('当前正在保存、退出或更新，请稍后同步'));
  const expected=owner();if(!expected||view.checkpoint.initialized&&!ready())return Promise.reject(Error('请登录数据所属成员，账号或工作区不匹配'));
  stopped=false;if(upload)view.automatic=true;const operation=generation;
  return launch(operation,()=>synchronize(operation,Boolean(upload),expected));
 }
 function connectAndSync(upload=true){return run(upload);}
 function start(){
  if(startFlight)return startFlight;
  const operation=generation;
  startFlight=(async()=>{await refresh(operation);check(operation);if(!owner())return view;if(view.checkpoint.initialized&&!ready())throw Error('请登录数据所属成员，账号或工作区不匹配');return run(true);})().catch(error=>{if(operation===generation){view.error=error.message;view.automatic=false;emit();}throw error;});
  return startFlight;
 }
 function login(username,password){
  if(logoutFlight)return Promise.reject(Error('请等待退出登录完成'));
  if(flight)return Promise.reject(Error('请先暂停并等待当前同步结束'));
  if(isBlocked())return Promise.reject(Error('当前正在保存、退出或更新，请稍后登录'));
  const operation=++generation;stopped=false;
  return launch(operation,async()=>{let session;try{session=await request('login',{username,password});}finally{password='';}check(operation);view.session=session;await refresh(operation);check(operation);const expected=owner();if(!expected)throw Error('成员登录未确认，请重试');view.automatic=true;return synchronize(operation,true,expected);});
 }
 function logout(){
  if(logoutFlight)return logoutFlight;
  let operation;
  const job=Promise.resolve().then(async()=>{if(flight)await flight.catch(()=>{});await request('logout');await refresh(operation);}).finally(()=>{if(logoutFlight===job)logoutFlight=null;});
  logoutFlight=job;pause();operation=generation;verifiedOwner=null;view.session={authenticated:false};view.summary=null;emit();return job;
 }
 async function automatic(enabled){if(enabled&&(!owner()||view.checkpoint.initialized&&!ready()))throw Error('请先登录数据所属成员');view.automatic=Boolean(enabled);if(enabled)stopped=false;emit();}
 /** 递增操作代次并停止引擎，使此前等待中的异步步骤失效。 */
 function pause(){generation++;stopped=true;view.automatic=false;engine.stop?.();emit();}
 async function tick(){if(stopped||isBlocked())return;await deliver();if(view.automatic&&!flight)await run(true);else if(!flight)await refresh();}
 async function stop(){pause();if(flight)await flight.catch(()=>{});if(logoutFlight)await logoutFlight.catch(()=>{});}
 async function preview(){if(flight)throw Error('请等待同步结束');await flush();return request('planPreview');}
 async function apply(token){if(flight)throw Error('请等待同步结束');await flush();const result=await request('planApply',{token});needsReceive=true;await refresh();return result;}
 async function conflicts(){return engine.conflicts();}
 async function resolve(type,id,choice){if(flight)throw Error('请等待同步结束');await flush();await engine.resolve(type,id,choice);needsReceive=true;await refresh();return deliver();}
 function resolveMany(selections){
  if(flight||logoutFlight)return Promise.reject(Error('请等待同步或退出结束'));
  if(isBlocked())return Promise.reject(Error('请等待当前保存或维护操作完成'));
  const expected=owner(),operation=generation;
  if(!expected||!ready())return Promise.reject(Error('请登录数据所属成员'));
  // 手动处理允许处于暂停状态；仍持有 flight，阻止定时同步、退出和重复点击交错。
  const checkResolution=()=>{if(operation!==generation||isBlocked())throw cancelError();checkOwner(expected);};
  const job=Promise.resolve().then(async()=>{
   try{
    checkResolution();await flush();checkResolution();await refresh(operation);checkResolution();
    const result=await engine.resolveMany(selections);view.summary=result;needsReceive=true;return result;
   }finally{
    try{await refresh(operation);await deliver();}catch(error){if(operation===generation)view.error=error.message;}
    finally{if(flight===job){flight=null;view.running=false;}emit();}
   }
  });
  flight=job;view.running=true;view.error=null;emit();return job;
 }
 function verifyAssets(){
  if(flight)return Promise.reject(Error('请等待当前同步结束'));if(!ready())return Promise.reject(Error('请先完成登录与接入'));
  if(typeof engine.verifyAssets!=='function')return Promise.reject(Error('原图校验暂未接通'));
  stopped=false;const operation=generation,expected=owner();return launch(operation,async()=>{await request('resume');check(operation);await refresh(operation);check(operation);return verifyOnce(operation,expected,true);});
 }
 return {refresh,start,connectAndSync,run,login,logout,automatic,pause,tick,stop,preview,apply,conflicts,resolve,resolveMany,verifyAssets,deliver,status:()=>view};
}
