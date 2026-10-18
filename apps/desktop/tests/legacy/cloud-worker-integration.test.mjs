import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createCloudWorker} from '../../public/workbench/cloud-worker-client.js';
import {projectWorkspace} from '../../public/workbench/cloud-projection.js';

test('pause during durable outbox commit releases only after settlement; resume reloads and sends the same mutation',async()=>{
 let nativeWorker;class Adapter{
  constructor(url){nativeWorker=new Worker(new URL('./fixtures/cloud-worker-host.mjs',import.meta.url),{workerData:{moduleUrl:url.href}});nativeWorker.on('message',data=>this.onmessage?.({data}));nativeWorker.on('error',error=>this.onerror?.(error));}
  postMessage(value){nativeWorker.postMessage(value);}terminate(){return nativeWorker.terminate();}
 }
 const member={uid:'u',workspaceId:'w'},state={revision:1,configs:[{id:'c',shopId:'intel',name:'old',price:100,parts:[],actualParts:[],addons:[]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 const projection=projectWorkspace(state),root={type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:1},createdAt:'2026-01-01T00:00:00Z'}};
 let current={state:structuredClone(state),cloudVersion:1,document:{format:1,...member,deviceId:'d',cursor:1,records:[...projection,root].map(r=>({type:r.type,id:r.id,base:structuredClone(r.data),draft:structuredClone(r.data),version:1,conflict:null})),outbox:[],materializedProjection:projection}};
 current.state.configs[0].name='local change';
 let loads=0,held=false,releaseCommit,queueReached;const gate=new Promise(resolve=>releaseCommit=resolve),reached=new Promise(resolve=>queueReached=resolve),sent=[];
 const client=createCloudWorker({WorkerClass:Adapter,raw:async(action,body)=>{
  const input=JSON.parse(body);let value;
  if(action==='status')value={session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  else if(action==='load'){loads++;value=current;}
  else if(action==='call'){
   if(input.action==='sync.pull')value={ok:true,headSeq:1,nextCursor:1,hasMore:false,changes:[]};
   else if(input.action==='sync.pushBatch'){sent.push(...input.payload.requests);value={ok:true,results:input.payload.requests.map(req=>({ok:true,mutationId:req.payload.mutationId,record:{type:req.payload.entityType,id:req.payload.entityId,version:req.payload.baseVersion+1,data:req.payload.after}}))};}
   else throw Error('unexpected call '+input.action);
  }else if(action==='commit'){
   assert.equal(input.baseRevision,current.state.revision);assert.equal(input.cloudVersion,current.cloudVersion);
   let document=input.document;if(input.documentPatch){document={...current.document,...input.documentPatch.set,records:[...current.document.records]};for(const row of input.documentPatch.records){const index=document.records.findIndex(old=>old.type===row.type&&old.id===row.id);if(index<0)document.records.push(row);else document.records[index]=row;}}
   if(!held&&document.outbox.length){held=true;queueReached();await gate;}
   current={state:input.state?{...input.state,revision:current.state.revision+1}:current.state,cloudVersion:current.cloudVersion+1,document};value={revision:current.state.revision,cloudVersion:current.cloudVersion};
  }else throw Error('unexpected action '+action);
  return{status:200,body:JSON.stringify(value)};
 }});
 try{
  const running=client.run({member}),paused=assert.rejects(running,{code:'SYNC_STOPPED'});await reached;await client.stop();assert.equal(sent.length,0);releaseCommit();await paused;
  assert.equal(current.document.outbox.length,1);const mutation=current.document.outbox[0].payload.mutationId,before=loads;
  const status=await client.status();assert.equal(status.uncertain,1);assert.equal(loads,before+1);
  await client.status();assert.equal(loads,before+2,'paused status must release its newly loaded snapshot');
  await client.run({member});assert.equal(sent[0].payload.mutationId,mutation);assert.equal(current.document.outbox.length,0);assert.equal(current.state.configs[0].name,'local change');assert.equal(loads,before+3);
  await client.stop();await assert.rejects(client.run({member:{uid:'other',workspaceId:'w'}}),{code:'OWNER_MISMATCH'});assert.equal(sent.length,1);
 }finally{releaseCommit();await nativeWorker.terminate();}
});

test('real worker downloads with CAS protection then previews and atomically resolves a conflict through the native bridge',async()=>{
 let nativeWorker;class Adapter{
  constructor(url){nativeWorker=new Worker(new URL('./fixtures/cloud-worker-host.mjs',import.meta.url),{workerData:{moduleUrl:url.href}});nativeWorker.on('message',data=>this.onmessage?.({data}));nativeWorker.on('error',error=>this.onerror?.(error));}
  postMessage(value){nativeWorker.postMessage(value);}terminate(){return nativeWorker.terminate();}
 }
 const member={uid:'u',workspaceId:'w'},state={revision:1,configs:[{id:'c',shopId:'intel',name:'old',price:100,parts:[],actualParts:[],addons:[]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 const projection=projectWorkspace(state),root={type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:1},createdAt:'2026-01-01T00:00:00Z'}};
 let current={state,cloudVersion:1,document:{format:1,...member,deviceId:'d',cursor:1,records:[...projection,root].map(r=>({type:r.type,id:r.id,base:structuredClone(r.data),draft:structuredClone(r.data),version:1,conflict:null})),outbox:[],materializedProjection:projection}},injected=false;
 const actions=[];
 const client=createCloudWorker({WorkerClass:Adapter,raw:async(action,body)=>{
  const input=JSON.parse(body);actions.push(action);let value;
  if(action==='status')value={session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  else if(action==='load')value=current;
  else if(action==='call'){
   assert.equal(input.action,'sync.pull');value={ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:input.payload.cursor<2?[{type:'configuration',id:'c',version:2,seq:2,data:{...projection.find(r=>r.type==='configuration').data,name:'remote'}}]:[]};
  }else if(action==='commit'){
   if(!injected){current.state={...current.state,revision:2,configs:[{...current.state.configs[0],footer:'local while downloading'}]};injected=true;}
   if(input.baseRevision!==current.state.revision||input.cloudVersion!==current.cloudVersion)return{status:409,body:'{"error":"stale"}'};
   let document=input.document;
   if(input.documentPatch){document={...current.document,...input.documentPatch.set,records:current.document.records.map(row=>({...row}))};for(const row of input.documentPatch.records){const index=document.records.findIndex(old=>old.type===row.type&&old.id===row.id);if(index<0)document.records.push(row);else document.records[index]=row;}}
   current={state:input.state?{...input.state,revision:current.state.revision+1}:current.state,cloudVersion:current.cloudVersion+1,document};value={revision:current.state.revision,cloudVersion:current.cloudVersion};
  }else throw Error('unexpected action '+action);
  return{status:200,body:JSON.stringify(value)};
 }});
 try{
  const result=await client.run({member,upload:false});assert.equal(result.cursor,2);assert.equal(current.state.configs[0].name,'remote');assert.equal(current.state.configs[0].footer,'local while downloading');assert.equal(actions.filter(a=>a==='call').length,1);assert.equal(current.document.outbox.length,0);
  const row=current.document.records.find(r=>r.type==='configuration');row.draft.name='local choice';row.base.name='remote choice';row.version=3;row.conflict={fields:['name'],remote:{type:row.type,id:row.id,version:3,data:structuredClone(row.base)}};
  current.state.configs[0].name='local choice';current.state.revision++;current.cloudVersion++;current.document.materializedProjection=projectWorkspace(current.state);
  const preview=await client.conflicts();assert.equal(preview.rows.length,1);assert.equal(typeof preview.rows[0].token,'string');
  const before=actions.filter(a=>a==='commit').length;
  const resolved=await client.resolveMany(preview.rows.map(({type,id,token})=>({type,id,token,choice:'remote'})));
  assert.equal(resolved.conflicts,0);assert.equal(current.state.configs[0].name,'remote choice');assert.equal(actions.filter(a=>a==='commit').length,before+1);assert.equal(actions.filter(a=>a==='call').length,1);
 }finally{await nativeWorker.terminate();}
});
