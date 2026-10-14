import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLegacyMigrationPlan} from '../../public/workbench/legacy-migration-plan.js';
import {projectWorkspace,applyWorkspace} from '../../public/workbench/cloud-projection.js';
import {initializeActualParts} from '../../public/workbench/actual-parts.js';
import {normalizePosterDesign} from '../../public/workbench/poster-design.js';
import {createCloudEngine} from '../../public/workbench/cloud-engine.js';
import {Worker} from 'node:worker_threads';
import {createCloudWorker} from '../../public/workbench/cloud-worker-client.js';

const copy=structuredClone;
const projected=state=>JSON.parse(JSON.stringify(projectWorkspace(state)));
function fixture(){
 const state={revision:12,configs:[{id:'c1',shopId:'intel',name:'已保存',price:123.45,spu:'12345678901234567890',parts:[],actualParts:[],addons:[],posterDesignVersion:1,skuMode:'dedicated'}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]};
 const rows=[...projected(state),{type:'workspace_meta',id:'root',data:{format:2}}];
 return {prepared:true,token:'native-capture-token',sourceBound:true,state,records:rows.map(row=>({type:row.type,id:row.id,version:5,base:copy(row.data),draft:copy(row.data),conflict:null})),outbox:[]};
}
const config=source=>source.records.find(row=>row.type==='configuration');
const request=row=>({protocolVersion:2,action:'sync.push',requestId:'request-unchanged',payload:{deviceId:'old-device',mutationId:'immutable-mutation-001',entityType:row.type,entityId:row.id,baseVersion:row.version,after:copy(row.draft)}});
const oldImage='/uploads/123-456-0123456789abcdef.png',canonicalImage='/uploads/0123456789abcdef'+ 'a'.repeat(48)+'.png';
function imageFixture(){
 const source=fixture();source.state.configs[0].caseImage=oldImage;config(source).base.caseImage=oldImage;config(source).draft.caseImage=oldImage;
 source.assetReplacements={[oldImage]:canonicalImage};return source;
}

test('matching saved state preserves cloud acknowledgements and does not mutate inputs',()=>{
 const source=fixture(),before=copy(source),plan=buildLegacyMigrationPlan(source);
 assert.deepEqual(plan,{token:source.token,records:source.records,materializedProjection:projected(source.state)});
 assert.deepEqual(source,before);
});
test('saved edit absent from stale draft becomes pending without acknowledging cloud',()=>{
 const source=fixture();source.state.configs[0].name='本机较新保存';
 const before=copy(config(source)),after=config(buildLegacyMigrationPlan(source));
 assert.equal(after.draft.name,'本机较新保存');assert.deepEqual(after.base,before.base);assert.equal(after.version,5);assert.equal(after.conflict,null);
});
test('a newly saved entity is retained as a new unacknowledged record',()=>{
 const source=fixture();source.state.configs.push({...copy(source.state.configs[0]),id:'c2',name:'新增'});
 const added=buildLegacyMigrationPlan(source).records.find(row=>row.id==='c2');
 assert.equal(added.version,0);assert.equal(added.base,null);assert.equal(added.draft.name,'新增');
});
test('already pending edit and original outbox request remain immutable',()=>{
 const source=fixture();config(source).draft.name='本机未确认';source.state.configs[0].name='本机未确认';source.outbox=[request(config(source))];
 const before=copy(source),plan=buildLegacyMigrationPlan(source);
 assert.deepEqual(plan.records,source.records);assert.deepEqual(source,before);assert.equal(plan.outbox,undefined);
});
test('new saved fields can coexist with an immutable older in-flight request',()=>{
 const source=fixture();source.outbox=[request(config(source))];source.state.configs[0].name='发送后保存';const original=copy(source.outbox);
 assert.equal(config(buildLegacyMigrationPlan(source)).draft.name,'发送后保存');assert.deepEqual(source.outbox,original);
});
test('divergent edits over the same acknowledged field reject without losing either',()=>{
 const source=fixture();config(source).draft.name='队列中的名字';source.state.configs[0].name='另一个名字';const before=copy(source);
 assert.throws(()=>buildLegacyMigrationPlan(source),/无法确定先后/);assert.deepEqual(source,before);
});
test('saved state reverting pending draft is ambiguous and is not silently discarded',()=>{
 const source=fixture();config(source).draft.name='未确认更新';
 assert.throws(()=>buildLegacyMigrationPlan(source),/无法确定先后/);
});
test('legacy materialization defaults do not manufacture pending uploads',()=>{
 const source=fixture(),row=config(source);for(const key of ['actualParts','posterDesignVersion','skuMode']){delete row.base[key];delete row.draft[key];}
 const plan=buildLegacyMigrationPlan(source);assert.deepEqual(plan.records,source.records);
});
test('saved edit with legacy materialization defaults preserves original record shape',()=>{
 const source=fixture(),row=config(source);for(const key of ['actualParts','posterDesignVersion','skuMode']){delete row.base[key];delete row.draft[key];}
 source.state.configs[0].name='更改名称';const next=config(buildLegacyMigrationPlan(source));
 assert.equal(next.draft.name,'更改名称');assert.equal(Object.hasOwn(next.draft,'actualParts'),false);assert.equal(Object.hasOwn(next.draft,'posterDesignVersion'),false);
});
test('local ERP values stay in original state and never enter shared records',()=>{
 const source=fixture();source.state.costSource=[{goodsId:'123',name:'配件',tax:1.23,erp:8,stockAvailable:7,localInventoryOnly:true}];source.state.sharedCostScope='fixture-scope';
 const plan=buildLegacyMigrationPlan(source),row=plan.records.find(row=>row.type==='component');
 assert.deepEqual(row.draft,{erpScopeId:'fixture-scope',goodsId:'123',name:'配件',taxCents:123});assert.equal(source.state.costSource[0].erp,8);
});
test('local-only inventory without shared tax does not create cloud record',()=>{
 const source=fixture();source.state.costSource=[{goodsId:'123',name:'库存',tax:null,erp:8,localInventoryOnly:true}];
 assert.equal(buildLegacyMigrationPlan(source).records.some(row=>row.type==='component'),false);
});
test('deleted component remains in records when intentionally absent from materialized state',()=>{
 const source=fixture(),draft={erpScopeId:'scope',goodsId:'123',taxCents:100,deletedAt:'2026-10-14T00:00:00Z'};
 source.records.push({type:'component',id:'scope|123',version:3,base:copy(draft),draft:copy(draft),conflict:null});
 assert.deepEqual(buildLegacyMigrationPlan(source).records,source.records);
});
test('missing live configuration never becomes an implicit remote deletion',()=>{
 const source=fixture();source.state.configs=[];assert.throws(()=>buildLegacyMigrationPlan(source),/无法确定先后/);
});
test('explicit conflict is retained when saved draft matches and blocks mismatching saved edits',()=>{
 const source=fixture(),row=config(source);row.conflict={code:'CONFLICT',fields:['name'],remote:{type:row.type,id:row.id,version:6,data:{...copy(row.base),name:'远端'}}};
 assert.deepEqual(buildLegacyMigrationPlan(source).records,source.records);
 source.state.configs[0].name='另一个编辑';assert.throws(()=>buildLegacyMigrationPlan(source),/无法确定先后/);
});
test('unbound old local data creates draft-only records',()=>{
 const source=fixture();source.sourceBound=false;source.records=[];
 const plan=buildLegacyMigrationPlan(source);assert.ok(plan.records.every(row=>row.base===null&&row.version===0));assert.equal(plan.records.length,1);
});
test('unbound legacy SQLite draft-only records are valid local saves, not unidentified cloud history',()=>{
 const source=fixture();source.sourceBound=false;source.records=source.records.filter(row=>row.type!=='workspace_meta');
 for(const row of source.records){row.base=null;row.version=0;}
 assert.deepEqual(buildLegacyMigrationPlan(source).records,source.records);
});
test('duplicate, incompatible version, incomplete cloud root and unknown type are rejected',()=>{
 for(const change of [s=>s.records.push(copy(s.records[0])),s=>config(s).version=0,s=>s.records=s.records.filter(r=>r.type!=='workspace_meta'),s=>config(s).type='erp_chunk',s=>{s.sourceBound=false;}]){
  const source=fixture();change(source);assert.throws(()=>buildLegacyMigrationPlan(source));
 }
});
test('outbox identity and duplicate entity protections are checked before producing plan',()=>{
 for(const change of [s=>s.outbox[0].payload.entityId='missing',s=>s.outbox.push(copy(s.outbox[0])),s=>s.outbox[0].payload.mutationId='short',s=>s.outbox[0].protocolVersion=1]){
  const source=fixture();source.outbox=[request(config(source))];change(source);assert.throws(()=>buildLegacyMigrationPlan(source),/提交/);
 }
});
test('re-materialization preserves prepared shared fields after a saved edit',()=>{
 const source=fixture();source.state.configs[0].name='新名字';const plan=buildLegacyMigrationPlan(source);
 const restored=initializeActualParts(applyWorkspace(source.state,plan.records));restored.configs.forEach(normalizePosterDesign);
 assert.deepEqual(projected(restored),plan.materializedProjection);
});

for(const changed of [false,true])test(`migrated cloud engine ${changed?'uploads only the genuinely saved edit':'resumes cursor without uploading unchanged records'}`,async()=>{
 const source=fixture();if(changed)source.state.configs[0].name='迁移时保留的本机保存';
 const plan=buildLegacyMigrationPlan(source),member={uid:'fixture-user',workspaceId:'fixture-workspace'};
 let current={state:copy(source.state),cloudVersion:1,document:{format:1,...member,deviceId:'new-native-device',cursor:84,records:plan.records,outbox:copy(source.outbox),materializedProjection:plan.materializedProjection}};
 const calls=[];
 const engine=createCloudEngine({
  load:async()=>copy(current),
  commit:async input=>{assert.equal(input.baseRevision,current.state.revision);assert.equal(input.cloudVersion,current.cloudVersion);current={state:{...copy(input.state),revision:current.state.revision+1},cloudVersion:current.cloudVersion+1,document:copy(input.document)};return {revision:current.state.revision,cloudVersion:current.cloudVersion,activityDelta:[]};},
  call:async request=>{
   calls.push(copy(request));
   if(request.action==='sync.pushBatch')return {ok:true,results:request.payload.requests.map(item=>({ok:true,mutationId:item.payload.mutationId,record:{type:item.payload.entityType,id:item.payload.entityId,version:item.payload.baseVersion+1,data:copy(item.payload.after)}}))};
   if(request.action==='sync.pull'){assert.equal(request.payload.cursor,84);return {ok:true,headSeq:84,nextCursor:84,hasMore:false,changes:[]};}
   throw Error('unexpected offline mock action '+request.action);
  },
 });
 await engine.run({member});
 const pushes=calls.filter(request=>request.action==='sync.pushBatch').flatMap(request=>request.payload.requests);
 assert.equal(pushes.length,changed?1:0);
 assert.equal(current.state.configs[0].name,source.state.configs[0].name);
 assert.equal(current.document.cursor,84);
 if(changed){assert.equal(pushes[0].payload.baseVersion,5);assert.equal(pushes[0].payload.after.name,source.state.configs[0].name);}
});

test('verified original-image map changes only drafts and materialized projection, retaining acknowledged old URLs',()=>{
 const source=imageFixture(),before=copy(source),plan=buildLegacyMigrationPlan(source);
 assert.equal(config(plan).draft.caseImage,canonicalImage);assert.equal(config(plan).base.caseImage,oldImage);
 assert.equal(plan.materializedProjection.find(row=>row.id==='c1').data.caseImage,canonicalImage);
 assert.deepEqual(plan.records.find(row=>row.type==='workspace_meta'),source.records.find(row=>row.type==='workspace_meta'));
 assert.deepEqual(source,before);
});
test('old-image mapping is not used to overwrite immutable outbox or conflict references',()=>{
 const source=imageFixture();source.outbox=[request(config(source))];const before=copy(source);
 assert.throws(()=>buildLegacyMigrationPlan(source),/待确认提交或同步冲突/);assert.deepEqual(source,before);
 source.outbox=[];const row=config(source);row.conflict={code:'CONFLICT',fields:['caseImage'],remote:{type:row.type,id:row.id,version:6,data:copy(row.base)}};
 assert.throws(()=>buildLegacyMigrationPlan(source),/待确认提交或同步冲突/);
});
test('unverified, malformed or mismatched-format image mappings are rejected',()=>{
 for(const change of [s=>delete s.assetReplacements,s=>s.assetReplacements={[oldImage]:'/uploads/not-a-hash.png'},s=>s.assetReplacements={[oldImage]:canonicalImage.replace('.png','.jpg')},s=>s.assetReplacements={'/uploads/../../secret':canonicalImage}]){
  const source=imageFixture();change(source);assert.throws(()=>buildLegacyMigrationPlan(source),/原图/);
 }
});
test('actual cloud worker verifies canonical migrated images and completes normal engine sync',async()=>{
 let nativeWorker;class Adapter{
  constructor(url){nativeWorker=new Worker(new URL('./fixtures/cloud-worker-host.mjs',import.meta.url),{workerData:{moduleUrl:url.href}});nativeWorker.on('message',data=>this.onmessage?.({data}));nativeWorker.on('error',error=>this.onerror?.(error));}
  postMessage(value){nativeWorker.postMessage(value);}terminate(){return nativeWorker.terminate();}
 }
 const source=imageFixture(),plan=buildLegacyMigrationPlan(source),member={uid:'fixture-user',workspaceId:'fixture-workspace'};
 const importedState=copy(source.state);importedState.configs[0].caseImage=canonicalImage; // Native applies its own verified map.
 let current={state:importedState,cloudVersion:1,document:{format:1,...member,deviceId:'new-device',cursor:84,records:plan.records,outbox:[],materializedProjection:plan.materializedProjection}};
 const uploaded=[],verified=[];
 const client=createCloudWorker({WorkerClass:Adapter,raw:async(action,body)=>{
  const input=JSON.parse(body);let value;
  if(action==='status')value={session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  else if(action==='load')value=current;
  else if(action==='assetsDownload'||action==='assetsEnsure'){assert.deepEqual(input.urls,[canonicalImage]);verified.push(action);value={ok:true};}
  else if(action==='call'){
   if(input.action==='sync.pull')value={ok:true,headSeq:84,nextCursor:84,hasMore:false,changes:[]};
   else if(input.action==='sync.pushBatch'){uploaded.push(...input.payload.requests);value={ok:true,results:input.payload.requests.map(item=>({ok:true,mutationId:item.payload.mutationId,record:{type:item.payload.entityType,id:item.payload.entityId,version:item.payload.baseVersion+1,data:copy(item.payload.after)}}))};}
   else throw Error('unexpected cloud action '+input.action);
  }else if(action==='commit'){
   assert.equal(input.baseRevision,current.state.revision);assert.equal(input.cloudVersion,current.cloudVersion);
   let document=input.document;
   if(input.documentPatch){document={...current.document,...input.documentPatch.set,records:current.document.records.map(row=>copy(row))};for(const row of input.documentPatch.records){const i=document.records.findIndex(old=>old.type===row.type&&old.id===row.id);if(i<0)document.records.push(row);else document.records[i]=row;}}
   current={state:input.state?{...input.state,revision:current.state.revision+1}:current.state,cloudVersion:current.cloudVersion+1,document};value={revision:current.state.revision,cloudVersion:current.cloudVersion};
  }else throw Error('unexpected native action '+action);
  return {status:200,body:JSON.stringify(value)};
 }});
 try{
  await client.verifyAssets();const result=await client.run({member});assert.equal(result.cursor,84);assert.equal(uploaded.length,1);assert.equal(uploaded[0].payload.after.caseImage,canonicalImage);assert.equal(source.records[0].base.caseImage,oldImage);assert.ok(verified.includes('assetsDownload'));
 }finally{await nativeWorker.terminate();}
});
