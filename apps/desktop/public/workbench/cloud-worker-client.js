/** 将 Worker 请求转发到本机云桥接端点。 */
/** 主线程的同步 Worker 代理：关联请求回执、转发原生调用并接收进度通知。 */
async function requestRaw(action,body){
 const result=await fetch('/api/native-cloud/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body,cache:'no-store'});
 return{status:result.status,body:await result.text()};
}
// Only small status/progress messages reach the UI. Full projection, comparison
// and JSON serialization run in the worker; authenticated HTTP remains native.
/** 创建带请求关联和关闭处理的 Worker 通道，业务合并在 Worker 内执行。 */
export function createCloudWorker({onProgress=()=>{},WorkerClass=globalThis.Worker,raw=requestRaw}={}){
 const worker=new WorkerClass(new URL('./cloud-worker.js',import.meta.url),{type:'module'}),pending=new Map(),assetJobs=new Set();let sequence=0,failed=null,stopping=false;
 worker.onmessage=async({data})=>{
  if(data.kind==='native'){
   let operationId;
   try{
    let body=data.body;
    if(['assetsEnsure','assetsDownload'].includes(data.action)){
     if(stopping)throw Error('paused');operationId=crypto.randomUUID();assetJobs.add(operationId);
     body=JSON.stringify({...JSON.parse(body),operationId});
    }
    worker.postMessage({kind:'native-result',id:data.id,result:await raw(data.action,body)});
   }catch{worker.postMessage({kind:'native-result',id:data.id,error:stopping?'同步已暂停，已下载图片和本机修改已保留':'云同步接口不可用，本机修改已保留'});}
   finally{if(operationId)assetJobs.delete(operationId);}return;
  }
  if(data.kind==='progress'){onProgress(data.value);return;}
  if(data.kind==='result'){const job=pending.get(data.id);if(!job)return;pending.delete(data.id);if(data.error)job.reject(Object.assign(Error(data.error.message),{status:data.error.status,code:data.error.code}));else job.resolve(data.value);}
 };
 worker.onerror=()=>{failed=Error('同步任务已中断，待确认请求保留在本机，请重开工作台后继续');for(const job of pending.values())job.reject(failed);pending.clear();};
 const command=(method,args)=>failed?Promise.reject(failed):new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({kind:'command',id,method,args});});
 const start=(method,args)=>{stopping=false;return command(method,args);};
 const stop=()=>{stopping=true;worker.postMessage({kind:'stop'});return Promise.allSettled([...assetJobs].map(operationId=>raw('assetsCancel',JSON.stringify({operationId}))));};
 return{run:input=>start('run',[input]),status:()=>command('status',[]),conflicts:()=>command('conflicts',[]),verifyAssets:()=>start('verifyAssets',[]),resolve:(...args)=>command('resolve',args),stop,dispose:()=>{stop();worker.terminate();worker.onerror();}};
}
