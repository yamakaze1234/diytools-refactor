import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudController} from '../../public/workbench/cloud-controller.js';
import {createAgentWorkflow} from '../../public/workbench/agent-workflow.js';
import {projectWorkspace} from '../../public/workbench/cloud-projection.js';

// 两个独立本机快照，共享纯内存协议服务；不访问真实账号或网络。
function fixture(){
 const copy=structuredClone,member={uid:'synthetic-user',workspaceId:'synthetic-workspace'};
 const state={revision:1,configs:[{id:'c1',shopId:'intel',name:'initial',price:100,parts:[],actualParts:[],addons:[]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]};
 const projection=projectWorkspace(state),rows=[...projection,{type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:1},createdAt:'2026-01-01T00:00:00Z'}}];
 const remote=new Map(rows.map(r=>[`${r.type}|${r.id}`,{...copy(r),version:1}])),log=[],receipts=new Map();let offline=false;
 async function call(req){
  if(offline)throw Error('synthetic offline');
  if(req.action==='sync.pull'){
   const head=req.payload.headSeq??1+log.length,changes=log.filter(r=>r.seq>req.payload.cursor&&r.seq<=head);
   return {ok:true,headSeq:head,nextCursor:changes.at(-1)?.seq??req.payload.cursor,hasMore:false,changes:copy(changes)};
  }
  if(req.action==='sync.pushBatch')return {ok:true,results:req.payload.requests.map(({payload:p})=>{
   if(receipts.has(p.mutationId))return copy(receipts.get(p.mutationId));
   const key=`${p.entityType}|${p.entityId}`,before=remote.get(key);
   if((before?.version||0)!==p.baseVersion)return {ok:false,code:'CONFLICT',record:copy(before)};
   const row={type:p.entityType,id:p.entityId,version:(before?.version||0)+1,data:copy(p.after)};
   remote.set(key,row);log.push({...copy(row),seq:log.length+2,mutationId:p.mutationId});
   const result={ok:true,mutationId:p.mutationId,record:row};receipts.set(p.mutationId,result);return copy(result);
  })};
  if(req.action==='sync.receipt')return copy(receipts.get(req.payload.mutationId)||{ok:false,code:'NOT_FOUND'});
  throw Error(`Unexpected ${req.action}`);
 }
 function client(deviceId){
  let local={state:copy(state),cloudVersion:1,document:{format:1,...member,deviceId,cursor:1,records:rows.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),outbox:[],materializedProjection:copy(projection)}};
  const controller=createCloudController({flush:async()=>{},receive:async()=>true,request:async(action,payload)=>{
   if(action==='status')return {session:{authenticated:true,member},checkpoint:{initialized:true,...member,conflicts:local.document.records.filter(r=>r.conflict).length}};
   if(action==='resume')return {};
   if(action==='load')return copy(local);
   if(action==='call')return call(payload);
   if(action==='assetsEnsure'||action==='assetsDownload')return {};
   if(action==='commit'){
    if(payload.baseRevision!==local.state.revision||payload.cloudVersion!==local.cloudVersion)throw Object.assign(Error('CAS'),{status:409});
    local={state:{...copy(payload.state),revision:local.state.revision+1},cloudVersion:local.cloudVersion+1,document:copy(payload.document)};
    return {revision:local.state.revision,cloudVersion:local.cloudVersion,activityDelta:[]};
   }
   throw Error(`Unexpected native action ${action}`);
  }});
  const run=createAgentWorkflow({blocked:()=>false,lock:()=>()=>{},sync:async()=>{
   await controller.run(true);const v=controller.status();return {running:v.running,error:v.error,conflicts:Math.max(v.summary?.conflicts||0,v.checkpoint?.conflicts||0),pending:v.summary?.pending??null};
  }});
  return {get state(){return local.state;},edit(name){local.state.configs[0].name=name;local.state.revision++;},init:()=>controller.refresh(),sync:()=>run({method:'sync.run',params:{}})};
 }
 return {client,offline(value){offline=value;},log};
}

test('Agent 经真实同步控制器和引擎同步两个隔离客户端，重复同步不重复上传',async()=>{
 const f=fixture(),a=f.client('a'),b=f.client('b');await Promise.all([a.init(),b.init()]);
 a.edit('saved by agent');assert.equal(b.state.configs[0].name,'initial');
 assert.equal((await a.sync()).cloudSync,'completed');assert.equal((await b.sync()).cloudSync,'completed');
 assert.equal(b.state.configs[0].name,'saved by agent');const count=f.log.length;await a.sync();assert.equal(f.log.length,count);
});

test('双端冲突和断网不能报告云同步完成，本机修改仍保留',async()=>{
 const f=fixture(),a=f.client('a'),b=f.client('b');await Promise.all([a.init(),b.init()]);a.edit('A');b.edit('B');
 await a.sync();await assert.rejects(b.sync(),e=>e.code==='SYNC_INCOMPLETE');assert.equal(b.state.configs[0].name,'B');
 a.edit('offline edit');f.offline(true);await assert.rejects(a.sync(),/synthetic offline/);assert.equal(a.state.configs[0].name,'offline edit');
 f.offline(false);assert.equal((await a.sync()).cloudSync,'completed');
});
