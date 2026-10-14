/** 同步 Worker 入口：在独立线程运行协议引擎，通过消息让宿主执行本机 I/O。 */
import {createCloudEngine} from './cloud-engine.js';
import {createCloudCheckpointCache} from './cloud-checkpoint-cache.js';
let sequence=0;const pending=new Map();
/** 为发往宿主的操作分配请求关联，并等待对应结果。 */
async function request(action,payload={}){
 const id=++sequence,body=JSON.stringify(payload);
 const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});self.postMessage({kind:'native',id,action,body});});
 let value;try{value=JSON.parse(result.body);}catch{throw Error('云同步返回格式无效');}
 if(result.status<200||result.status>=300)throw Object.assign(Error(value.error||'云同步失败'),{status:result.status});return value;
}
const cache=createCloudCheckpointCache(request,{patch:true});
const engine=createCloudEngine({load:cache.load,commit:cache.commit,call:input=>request('call',input),uploadAssets:({urls})=>request('assetsEnsure',{urls}),downloadAssets:({urls})=>request('assetsDownload',{urls}),onProgress:value=>self.postMessage({kind:'progress',value})});
self.onmessage=async({data})=>{
 if(data.kind==='native-result'){const job=pending.get(data.id);if(!job)return;pending.delete(data.id);if(data.error)job.reject(Error(data.error));else job.resolve(data.result);return;}
 if(data.kind==='stop'){engine.stop();return;}
 if(data.kind!=='command')return;
 try{
  let value;
  if(data.method==='run')value=await engine.run(data.args[0]);
  else if(data.method==='status')value=await engine.status();
  else if(data.method==='resolve')value=await engine.resolve(...data.args);
  else if(data.method==='conflicts'){
   const snapshot=await cache.load(),rows=snapshot.document.records.filter(row=>row.conflict);value={rows:rows.slice(0,100),total:rows.length};
  }
  else if(data.method==='verifyAssets'){
   const snapshot=await cache.load(),urls=new Set();
   const visit=v=>{if(typeof v==='string'&&v.startsWith('/uploads/'))urls.add(v);else if(v&&typeof v==='object')for(const child of Object.values(v))visit(child);};
   visit(snapshot.state);for(const row of snapshot.document.records)visit(row.draft);
   self.postMessage({kind:'progress',value:{phase:'assets',count:urls.size}});
   value=await request('assetsDownload',{urls:[...urls]});
  }
  else throw Error('未知同步任务');
  self.postMessage({kind:'result',id:data.id,value});
 }catch(error){self.postMessage({kind:'result',id:data.id,error:{message:error.message,status:error.status,code:error.code}});}
};
