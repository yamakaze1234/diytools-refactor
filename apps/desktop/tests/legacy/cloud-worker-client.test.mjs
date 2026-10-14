import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudWorker} from '../../public/workbench/cloud-worker-client.js';
test('worker bridge forwards raw checkpoint strings and preserves CAS failure for engine retry',async()=>{
 let worker;class WorkerStub{constructor(){worker=this;this.sent=[];}postMessage(value){this.sent.push(value);}terminate(){}}
 const nativeCalls=[],client=createCloudWorker({WorkerClass:WorkerStub,raw:async(action,body)=>{nativeCalls.push({action,body});return{status:409,body:'{"error":"stale"}'};}});
 const running=client.run({member:{uid:'u',workspaceId:'w'},upload:false}),command=worker.sent[0];
 await worker.onmessage({data:{kind:'native',id:7,action:'commit',body:'{"revision":7}'}});
 assert.deepEqual(nativeCalls,[{action:'commit',body:'{"revision":7}'}]);assert.equal(worker.sent[1].result.status,409);
 await worker.onmessage({data:{kind:'result',id:command.id,error:{message:'stale',status:409}}});await assert.rejects(running,{status:409});
 client.stop();assert.equal(worker.sent.at(-1).kind,'stop');
 const second=client.run({});worker.onerror();await assert.rejects(second,/保留/);await assert.rejects(client.status(),/中断/);
});

test('pause cancels the exact asset operation and rejects later worker asset requests before native dispatch',async()=>{
 let worker,complete;const gate=new Promise(resolve=>{complete=resolve;});class WorkerStub{constructor(){worker=this;this.sent=[];}postMessage(value){this.sent.push(value);}}
 const calls=[],client=createCloudWorker({WorkerClass:WorkerStub,raw:async(action,body)=>{calls.push({action,payload:JSON.parse(body)});if(action==='assetsDownload')await gate;return{status:200,body:'{"ok":true}'};}});
 const inFlight=worker.onmessage({data:{kind:'native',id:1,action:'assetsDownload',body:'{"urls":[]}'}});
 await client.stop();assert.equal(calls[1].action,'assetsCancel');assert.equal(calls[0].payload.operationId,calls[1].payload.operationId);
 await worker.onmessage({data:{kind:'native',id:2,action:'assetsEnsure',body:'{"urls":[]}'}});assert.equal(calls.length,2);assert.match(worker.sent.at(-1).error,/暂停/);
 complete();await inFlight;
});
