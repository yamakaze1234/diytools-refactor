import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudEngine,equivalent} from '../../public/workbench/cloud-engine.js';
import {equal} from '../../public/workbench/cloud-protocol.js';
import {projectWorkspace,applyWorkspace} from '../../public/workbench/cloud-projection.js';
import {createCloudCheckpointCache} from '../../public/workbench/cloud-checkpoint-cache.js';

const copy=structuredClone;
const member={uid:'u1',workspaceId:'w1'};
function fixture(){
 const state={revision:1,configs:[{id:'c1',shopId:'intel',name:'旧名',price:100,spu:'12345678901234567890',parts:[],actualParts:[],addons:[]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]};
 const projection=projectWorkspace(state),rows=[...projection,{type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:1},createdAt:'2026-01-01T00:00:00Z'}}];
 return {state,cloudVersion:1,document:{format:1,...member,deviceId:'d1',cursor:1,records:rows.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),outbox:[],materializedProjection:projection}};
}
function harness({snapshot=fixture(),onCall,onCommit,uploadAssets,downloadAssets,onProgress}={}){
 let current=copy(snapshot),calls=[],commits=0,log=[],receipts=new Map(),remote=new Map(current.document?.records?.map(r=>[[r.type,r.id].join('|'),{type:r.type,id:r.id,version:r.version,data:copy(r.base)}])||[]);
 const api={get current(){return current;},get calls(){return calls;},get commits(){return commits;},edit(fn){fn(current.state);current.state.revision++;},change(fn){fn(current);},async load(){return copy(current);},async commit(request){commits++;if(onCommit)await onCommit(request,api);if(request.baseRevision!==current.state.revision||request.cloudVersion!==current.cloudVersion)throw Object.assign(Error('CAS'),{status:409});current={state:{...copy(request.state),revision:current.state.revision+1},cloudVersion:current.cloudVersion+1,document:copy(request.document)};return {revision:current.state.revision,cloudVersion:current.cloudVersion,activityDelta:[]};},async call(req){calls.push(copy(req));if(onCall){const result=await onCall(req,api);if(result!==undefined)return result;}if(req.action==='sync.pushBatch'){return {ok:true,results:req.payload.requests.map(item=>{const p=item.payload;if(receipts.has(p.mutationId))return copy(receipts.get(p.mutationId));const r=remote.get([p.entityType,p.entityId].join('|'));const row={type:p.entityType,id:p.entityId,version:(r?.version||0)+1,data:copy(p.after)};remote.set([row.type,row.id].join('|'),row);log.push({...copy(row),seq:1+log.length+1,mutationId:p.mutationId});const result={ok:true,mutationId:p.mutationId,record:row};receipts.set(p.mutationId,result);return copy(result);})};}if(req.action==='sync.pull'){const head=req.payload.headSeq??1+log.length,changes=log.filter(r=>r.seq>req.payload.cursor&&r.seq<=head);const next=changes.at(-1)?.seq??req.payload.cursor;return {ok:true,headSeq:head,nextCursor:next,hasMore:false,changes:copy(changes)};}throw Error('unexpected '+req.action);}};
 api.engine=createCloudEngine({...api,load:api.load,commit:api.commit,call:api.call,uploadAssets,downloadAssets,onProgress});return api;
}
const rowData=h=>copy(h.current.document.records.find(r=>r.type==='configuration').draft);
const change=(data,version=2,seq=2)=>({type:'configuration',id:'c1',version,seq,data});

function conflictFixture(count=3){
 const s=assetFixture(count);
 for(const row of s.document.records.filter(r=>r.type==='configuration')){
  row.draft.name='本机 '+row.id;row.base={...copy(row.base),name:'云端 '+row.id};row.version=2;
  row.conflict={code:'CONFLICT',fields:['name'],remote:{type:row.type,id:row.id,version:2,data:copy(row.base)}};
  s.state.configs.find(c=>c.id===row.id).name=row.draft.name;
 }
 s.document.materializedProjection=projectWorkspace(s.state);return s;
}
const choices=(rows,choice='remote')=>rows.map(({type,id,token})=>({type,id,token,choice}));
test('bulk cloud choice commits selected records once, keeps unselected conflict and performs no cloud writes',async()=>{
 const h=harness({snapshot:conflictFixture()}),preview=await h.engine.conflicts();assert.equal(h.commits,0);
 const result=await h.engine.resolveMany(choices(preview.rows.slice(0,2)));
 assert.equal(result.resolved,2);assert.equal(result.conflicts,1);assert.equal(h.commits,1);assert.equal(h.calls.length,0);
 assert.deepEqual(h.current.state.configs.map(c=>c.name),['云端 c0','云端 c1','本机 c2']);
 assert.equal(h.current.document.records[0].conflict,null);assert.deepEqual(h.current.document.records[0].base,h.current.document.records[0].draft);
});
test('bulk local choice keeps drafts, advances bases and leaves changes pending upload',async()=>{
 const h=harness({snapshot:conflictFixture()}),{rows}=await h.engine.conflicts();
 const result=await h.engine.resolveMany(choices(rows,'local'));
 assert.equal(result.conflicts,0);assert.equal(result.pending,3);assert.equal(h.commits,1);
 assert.ok(h.current.state.configs.every(c=>c.name.startsWith('本机')));assert.equal(h.calls.length,0);
});
test('editing one selected draft after comparison rejects entire batch without losing the edit',async()=>{
 const h=harness({snapshot:conflictFixture()}),{rows}=await h.engine.conflicts();h.edit(s=>s.configs[1].name='刚刚编辑');
 await assert.rejects(h.engine.resolveMany(choices(rows)),/重新比较/);assert.equal(h.commits,0);
 assert.deepEqual(h.current.state.configs.map(c=>c.name),['本机 c0','刚刚编辑','本机 c2']);
 assert.ok(h.current.document.records.filter(r=>r.type==='configuration').every(r=>r.conflict));
});
test('bulk compare CAS retry protects changed remote and does not partly resolve other selected rows',async()=>{
 let once=true;const h=harness({snapshot:conflictFixture(),onCommit(req,api){if(once){once=false;api.change(s=>{const row=s.document.records[1];row.conflict.remote.data.name='新的云端';row.conflict.remote.version=3;row.version=3;row.base=copy(row.conflict.remote.data);s.cloudVersion++;});}}});
 const {rows}=await h.engine.conflicts();await assert.rejects(h.engine.resolveMany(choices(rows)),/重新比较/);
 assert.ok(h.current.document.records.filter(r=>r.type==='configuration').every(r=>r.conflict));assert.ok(h.current.state.configs.every(c=>c.name.startsWith('本机')));
});
test('bulk comparison rejects expired, duplicate and cross-record tokens',async()=>{
 const h=harness({snapshot:conflictFixture()}),first=await h.engine.conflicts(),second=await h.engine.conflicts();
 await assert.rejects(h.engine.resolveMany(choices(first.rows)),/过期/);
 const selected=choices(second.rows);await assert.rejects(h.engine.resolveMany([selected[0],selected[0]]),/重复/);
 await assert.rejects(h.engine.resolveMany([{...selected[0],id:selected[1].id}]),/过期/);assert.equal(h.commits,0);
});
test('comparison limits current page to 100 and next page remains available after batch',async()=>{
 const h=harness({snapshot:conflictFixture(101)}),first=await h.engine.conflicts();assert.equal(first.rows.length,100);assert.equal(first.total,101);
 await h.engine.resolveMany(choices(first.rows));const next=await h.engine.conflicts();assert.equal(next.rows.length,1);assert.equal(next.total,1);
});
test('uncertain outbox blocks every selected resolution and remains unchanged',async()=>{
 const snapshot=conflictFixture(),row=snapshot.document.records[1];
 snapshot.document.outbox=[{protocolVersion:2,action:'sync.push',requestId:'request-test',payload:{mutationId:'pending-mutation-001',deviceId:'d1',entityType:row.type,entityId:row.id,baseVersion:row.version,after:copy(row.draft)}}];
 const h=harness({snapshot}),{rows}=await h.engine.conflicts();await assert.rejects(h.engine.resolveMany(choices(rows)),/待确认/);
 assert.equal(h.commits,0);assert.deepEqual(h.current.document,snapshot.document);
});
test('comparison refresh includes a saved offline edit without writing the preview',async()=>{
 const h=harness({snapshot:conflictFixture()});h.edit(s=>s.configs[0].name='刚编辑的名称');
 const {rows}=await h.engine.conflicts();assert.equal(rows[0].draft.name,'刚编辑的名称');assert.equal(h.commits,0);
 await h.engine.resolveMany(choices(rows));assert.equal(h.current.state.configs[0].name,'云端 c0');
});
test('cloud selection can restore an offline deleted config from a read-only preview',async()=>{
 const h=harness({snapshot:conflictFixture()});h.edit(s=>s.configs.splice(0,1));
 const {rows}=await h.engine.conflicts();assert.ok(rows[0].draft.deletedAt);assert.equal(h.commits,0);
 await new Promise(r=>setTimeout(r,5));await h.engine.resolveMany(choices(rows));assert.equal(h.current.state.configs.length,3);assert.ok(!h.current.state.configs.find(c=>c.id==='c0').deletedAt);
});
test('batch returns the durable receipt even when subsequent reads would fail',async()=>{
 const h=harness({snapshot:conflictFixture()}),engine=createCloudEngine({load:async()=>{if(h.commits)throw Error('读取失败');return h.load();},commit:h.commit,call:h.call});
 const {rows}=await engine.conflicts(),result=await engine.resolveMany(choices(rows));assert.equal(result.resolved,3);assert.equal(result.conflicts,0);assert.equal(h.commits,1);
});

// 原 canonical 是协议 oracle；快速比较不能使用 JSON.stringify 吞掉 undefined 字段或数组项。
test('recursive comparison preserves canonical missing undefined null array and numeric semantics',()=>{
 const values=[undefined,null,NaN,Infinity,-Infinity,0,-0,1,'undefined','null','',true,false,{},
  {x:undefined},{x:null},{x:NaN},{x:0},{x:1},[],[undefined],[null],[NaN],Array(1),Array(2),
  {b:2,a:1},{a:1,b:2},{nested:{x:undefined}},{nested:{}},[{},[undefined]], [{},[null]],
  {x:()=>{}},{x:Symbol('x')},[()=>{}],[Symbol('x')],new Date('2026-01-01T00:00:00Z')];
 for(const a of values)for(const b of values)assert.equal(equivalent(a,b),equal(a,b));
 assert.equal(equivalent({}, {x:undefined}),false);
 assert.equal(equivalent({x:undefined},{x:null}),false);
 assert.equal(equivalent([undefined],[null]),false);
 assert.equal(equivalent({b:2,a:1},{a:1,b:2}),true);
});

// 构造跨多个推送批次的共享原图场景，验证优化没有绕过持久队列与图片先行约束。
function assetFixture(count=101){
 const s=fixture();s.state.configs=Array.from({length:count},(_,i)=>({...copy(s.state.configs[0]),id:'c'+i}));
 s.document.materializedProjection=projectWorkspace(s.state);
 s.document.records=[...s.document.materializedProjection.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),s.document.records.find(r=>r.type==='workspace_meta')];
 return s;
}
test('shared content addressed images are verified once per direction and reset next run',async()=>{
 const url='/uploads/'+'a'.repeat(64)+'.png',uploads=[],downloads=[];
 const h=harness({snapshot:assetFixture(),uploadAssets({urls}){uploads.push(urls);assert.equal(h.current.document.outbox.length,50);},downloadAssets({urls}){downloads.push(urls);}});
 h.edit(s=>s.configs.forEach(c=>{c.caseImage=url;c.name='共享图';}));await h.engine.run({member});
 assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests.length),[50,50,1]);
 assert.deepEqual(uploads,[[url]]);assert.deepEqual(downloads,[[url]]);
 h.edit(s=>s.configs.forEach(c=>{c.name='下一轮';}));await h.engine.run({member});
 assert.deepEqual(uploads,[[url],[url]]);assert.deepEqual(downloads,[[url],[url]]);
});
test('later batch images never delay first batch and failed upload resumes exact durable requests',async()=>{
 const first='/uploads/'+'a'.repeat(64)+'.png',later='/uploads/'+'b'.repeat(64)+'.png';let failLater=true;
 const uploads=[],h=harness({snapshot:assetFixture(51),uploadAssets({urls}){uploads.push(urls);if(urls.includes(later)&&failLater)throw Error('第二批图片断线');},downloadAssets(){}});
 h.edit(s=>s.configs.forEach((c,i)=>{c.caseImage=i<50?first:later;}));
 await assert.rejects(h.engine.run({member}),/第二批图片断线/);
 assert.deepEqual(uploads,[[first],[later]]);assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,1);
 const pending=copy(h.current.document.outbox);assert.equal(pending.length,1);assert.equal(pending[0].payload.entityId,'c50');
 failLater=false;await h.engine.run({member});
 assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch')[1].payload.requests,pending);
 assert.deepEqual(uploads,[[first],[later],[later]]);assert.equal(h.current.document.outbox.length,0);
});
test('editing image while assets are checked preserves submitted snapshot and sends new image separately',async()=>{
 const first='/uploads/'+'a'.repeat(64)+'.png',next='/uploads/'+'b'.repeat(64)+'.png',uploads=[];
 const h=harness({uploadAssets({urls}){uploads.push(urls);if(urls.includes(first))h.edit(s=>s.configs[0].caseImage=next);},downloadAssets(){}});
 h.edit(s=>s.configs[0].caseImage=first);await h.engine.run({member});
 assert.deepEqual(uploads,[[first],[next]]);
 assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests[0].payload.after.caseImage),[first,next]);
 assert.equal(h.current.state.configs[0].caseImage,next);assert.equal(h.current.document.outbox.length,0);
});
test('pause after queue persistence does not start asset network and retry revalidates assets',async()=>{
 const url='/uploads/'+'a'.repeat(64)+'.png';let once=true,uploads=0;
 const h=harness({onCommit(req){if(once&&req.document.outbox.length){once=false;h.engine.stop();}},uploadAssets(){uploads++;},downloadAssets(){}});
 h.edit(s=>s.configs[0].caseImage=url);await assert.rejects(h.engine.run({member}),error=>error.code==='SYNC_STOPPED');
 const pending=copy(h.current.document.outbox);assert.equal(uploads,0);assert.equal(pending.length,1);
 await h.engine.run({member});assert.equal(uploads,1);assert.deepEqual(h.calls.find(r=>r.action==='sync.pushBatch').payload.requests,pending);
});
test('upload progress advances only after durable receipts and reports distinct image phases',async()=>{
 const progress=[],url='/uploads/'+'a'.repeat(64)+'.png';
 const h=harness({snapshot:assetFixture(),uploadAssets(){},downloadAssets(){},onProgress:event=>progress.push(event)});
 h.edit(s=>s.configs.forEach(c=>{c.caseImage=url;}));await h.engine.run({member});
 assert.deepEqual(progress.filter(p=>p.phase==='upload'),[{phase:'upload',count:50,completed:0},{phase:'upload',count:50,completed:50},{phase:'upload',count:1,completed:100}]);
 assert.deepEqual(progress.filter(p=>p.phase==='assets-upload'),[{phase:'assets-upload',count:1}]);
 assert.deepEqual(progress.filter(p=>p.phase==='assets-download'),[{phase:'assets-download',count:1}]);
});

test('no document and mismatching member reject without network',async()=>{const h=harness({snapshot:{...fixture(),document:null}});await assert.rejects(h.engine.run({member}),/未初始化/);assert.equal(h.calls.length,0);const a=harness();await assert.rejects(a.engine.run({member:{...member,uid:'other'}}),/成员/);assert.equal(a.calls.length,0);});
test('ordinary durable save is caught up, request is persisted before HTTP',async()=>{let checked=false;const h=harness({onCall(req,api){if(req.action==='sync.pushBatch'){assert.deepEqual(api.current.document.outbox,req.payload.requests);checked=true;}}});h.edit(s=>{s.configs[0].name='本机新名';});assert.equal((await h.engine.status()).localChanges,true);await h.engine.run({member});assert.equal(checked,true);assert.equal(h.current.state.configs[0].name,'本机新名');assert.equal(h.current.document.outbox.length,0);assert.equal((await h.engine.status()).pending,0);assert.equal((await h.engine.status()).running,false);});
test('dropped response leaves immutable request; restart retries exact mutation/body',async()=>{let lost=true;const h=harness({onCall(req){if(req.action==='sync.pushBatch'&&lost){lost=false;throw Error('掉响应');}}});h.edit(s=>s.configs[0].name='离线');await assert.rejects(h.engine.run({member}),/掉响应/);const out=copy(h.current.document.outbox);assert.equal(out.length,1);h.edit(s=>s.configs[0].name='后续编辑');const restart=createCloudEngine({load:h.load,commit:h.commit,call:h.call});await restart.run({member});assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch')[0].payload.requests,out);assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch')[1].payload.requests,out);assert.equal(h.current.state.configs[0].name,'后续编辑');assert.equal(h.current.document.outbox.length,0);});
test('CAS conflict after response only recomputes locally and preserves flying input',async()=>{let inject=false,conflicted=false;const h=harness({onCall(req){if(req.action==='sync.pushBatch')inject=true;},onCommit(request,api){if(inject&&!conflicted&&!request.document.outbox.length){conflicted=true;api.edit(s=>{s.configs[0].footer='飞行新输入';});}}});h.edit(s=>s.configs[0].name='保存名');await h.engine.run({member});assert.equal(conflicted,true);assert.equal(h.current.state.configs[0].footer,'飞行新输入');const pushes=h.calls.filter(r=>r.action==='sync.pushBatch');assert.equal(pushes.length,2);assert.notEqual(pushes[0].payload.requests[0].payload.mutationId,pushes[1].payload.requests[0].payload.mutationId);});
test('different fields merge; array and same field conflict; latest remote is used by resolve',async()=>{const h=harness({onCall(req,api){if(req.action==='sync.pull'){const cursor=req.payload.cursor;if(cursor===1){const data=rowData(api);data.name='云端新名';return {ok:true,headSeq:3,nextCursor:2,hasMore:true,changes:[change(data,2,2)]};}if(cursor===2){const data=rowData(api);data.name='更新云名';return {ok:true,headSeq:3,nextCursor:3,hasMore:false,changes:[change(data,3,3)]};}return {ok:true,headSeq:3,nextCursor:3,hasMore:false,changes:[]};}}});h.edit(s=>s.configs[0].name='本机名');await h.engine.run({member,upload:false});const row=h.current.document.records.find(r=>r.id==='c1');assert.equal(row.conflict.remote.version,3);assert.equal(row.conflict.remote.data.name,'更新云名');assert.equal(h.current.state.configs[0].name,'本机名');await h.engine.resolve('configuration','c1','remote');assert.equal(h.current.state.configs[0].name,'更新云名');assert.equal((await h.engine.status()).conflicts,0);});
test('invalid seq/page/head cannot advance persisted cursor',async()=>{for(const bad of [{ok:true,headSeq:3,nextCursor:3,hasMore:false,changes:[change({...fixture().document.records[0].draft,name:'bad'},2,3)]},{ok:true,headSeq:2,nextCursor:1,hasMore:false,changes:[]},{ok:true,headSeq:2,nextCursor:1,hasMore:true,changes:[]}]){const h=harness({onCall:req=>req.action==='sync.pull'?bad:undefined});await assert.rejects(h.engine.run({member,upload:false}));assert.equal(h.current.document.cursor,1);assert.equal(h.current.state.configs[0].name,'旧名');}});
test('fixed head remains stable across multiple pages',async()=>{const h=harness({onCall(req,api){if(req.action==='sync.pull'){if(req.payload.cursor===1)return {ok:true,headSeq:3,nextCursor:2,hasMore:true,changes:[change({...rowData(api),footer:'a'},2,2)]};assert.equal(req.payload.headSeq,3);return {ok:true,headSeq:4,nextCursor:3,hasMore:true,changes:[change({...rowData(api),footer:'b'},3,3)]};}}});await assert.rejects(h.engine.run({member,upload:false}));assert.equal(h.current.document.cursor,2);assert.equal(h.current.state.configs[0].footer,'a');});
test('snapshot atomically stages complete pages and rebases offline edit',async()=>{const h=harness({onCall(req,api){if(req.action==='sync.pull'){return req.payload.cursor<10?{ok:false,code:'SNAPSHOT_REQUIRED'}:{ok:true,headSeq:11,nextCursor:11,hasMore:false,changes:req.payload.cursor===10?[change({...rowData(api),warranty:'后续增量'},3,11)]:[]};}if(req.action==='sync.snapshot'){if(req.payload.cursor===null)return {ok:true,checkpointSeq:10,records:[{...change({...rowData(api),footer:'远端字段'},2),seq:undefined}],nextCursor:['configuration','c1'],hasMore:true};assert.equal(api.current.document.cursor,1);assert.equal(req.payload.checkpointSeq,10);return {ok:true,checkpointSeq:10,records:[{type:'workspace_meta',id:'root',version:1,data:copy(api.current.document.records.find(r=>r.type==='workspace_meta').base)}],nextCursor:['workspace_meta','root'],hasMore:false};}}});h.edit(s=>s.configs[0].name='离线名');await h.engine.run({member,upload:false});assert.equal(h.current.document.cursor,11);assert.equal(h.current.state.configs[0].name,'离线名');assert.equal(h.current.state.configs[0].footer,'远端字段');assert.equal(h.current.state.configs[0].warranty,'后续增量');});
test('snapshot failure, duplicate rows and changed checkpoint preserve cursor',async()=>{for(const mode of ['failure','duplicate','changed']){let page=0;const h=harness({onCall(req,api){if(req.action==='sync.pull')return {ok:false,code:'SNAPSHOT_REQUIRED'};if(req.action==='sync.snapshot'){page++;if(page===1)return {ok:true,checkpointSeq:10,records:[change(rowData(api),2)],nextCursor:['configuration','c1'],hasMore:true};if(mode==='failure')throw Error('断线');if(mode==='duplicate')return {ok:true,checkpointSeq:10,records:[change(rowData(api),2)],nextCursor:['configuration','c1'],hasMore:false};return {ok:true,checkpointSeq:11,records:[],nextCursor:['configuration','c1'],hasMore:false};}}});await assert.rejects(h.engine.run({member,upload:false}));assert.equal(h.current.document.cursor,1);}});

test('empty first download uses current snapshot instead of replaying all historical changes',async()=>{
 const fresh=fixture();fresh.state.configs=[];fresh.document.records=[];fresh.document.materializedProjection=[];fresh.document.cursor=0;
 const config=fixture().document.records[0].base,events=[],rows=Array.from({length:120},(_,i)=>({type:'configuration',id:'c'+String(i).padStart(3,'0'),version:7,data:{...copy(config),id:'c'+String(i).padStart(3,'0'),name:'current-'+i}}));
 rows.push({type:'workspace_meta',id:'root',version:1,data:{format:2,counts:{configuration:120},createdAt:'2026-01-01T00:00:00Z'}});
 const h=harness({snapshot:fresh,onProgress:event=>events.push(event),onCall(req,api){
  if(req.action==='sync.snapshot'){
   assert.equal(api.current.document.cursor,0);assert.equal(api.current.state.configs.length,0);
   const start=req.payload.cursor===null?0:100,records=rows.slice(start,start+100),last=records.at(-1);
   return{ok:true,checkpointSeq:63251,records,nextCursor:[last.type,last.id],hasMore:start+100<rows.length};
  }
  if(req.action==='sync.pull'){
   assert.equal(req.payload.cursor,63251,'fresh client must skip superseded historical versions');
   return{ok:true,headSeq:63251,nextCursor:63251,hasMore:false,changes:[]};
  }
 }});
 await h.engine.run({member,upload:false});
 assert.deepEqual(h.calls.map(req=>req.action),['sync.snapshot','sync.snapshot','sync.pull']);assert.equal(h.current.state.configs.length,120);
 assert.equal(h.current.document.cursor,63251);assert.equal(h.current.document.records.length,121);assert.equal(h.commits,2);
 assert.ok(events.some(event=>event.phase==='checkpoint'&&event.received===121&&event.page===2));
});

test('missing optional first snapshot replays retained log from original cursor and preserves concurrent edits',async()=>{
 for(const partial of [false,true]){
  const initial=fixture();initial.document.origin='empty-workspace';
  if(!partial){initial.state.configs=[];initial.document.records=[];initial.document.materializedProjection=[];initial.document.cursor=0;}
  const start=initial.document.cursor,base=fixture().document.records[0].base;
  const h=harness({snapshot:initial,onCall(req,api){
   if(req.action==='sync.snapshot'){
    if(partial)api.edit(s=>s.configs[0].footer='同步期间输入');
    return{ok:false,code:'SNAPSHOT_UNAVAILABLE'};
   }
   assert.equal(req.action,'sync.pull','fallback must not upload');
   assert.equal(req.payload.cursor,start);
   return{ok:true,headSeq:start+2,nextCursor:start+2,hasMore:false,changes:[
    change({...copy(base),name:'云端最新'},2,start+1),
    {type:'workspace_meta',id:'root',version:2,seq:start+2,data:copy(fixture().document.records.find(r=>r.type==='workspace_meta').base)}
   ]};
  }});
  await h.engine.run({member,upload:false});
  assert.deepEqual(h.calls.map(r=>r.action),['sync.snapshot','sync.pull']);
  assert.equal(h.current.document.cursor,start+2);assert.equal(h.current.state.configs[0].name,'云端最新');
  if(partial)assert.equal(h.current.state.configs[0].footer,'同步期间输入');
  assert.deepEqual(h.current.document.outbox,[]);
 }
});

test('required missing checkpoint stops without advancing cursor or losing local draft',async()=>{
 const h=harness({onCall(req){
  return{ok:false,code:req.action==='sync.pull'?'SNAPSHOT_REQUIRED':'SNAPSHOT_UNAVAILABLE'};
 }});
 h.edit(s=>s.configs[0].name='保留本地草稿');
 await assert.rejects(h.engine.run({member,upload:false}),e=>e.code==='SNAPSHOT_UNAVAILABLE');
 assert.deepEqual(h.calls.map(r=>r.action),['sync.pull','sync.snapshot']);
 assert.equal(h.current.document.cursor,1);assert.equal(h.current.state.configs[0].name,'保留本地草稿');
});

test('first snapshot only falls back for explicit unavailable response before receiving pages',async()=>{
 for(const mode of ['denied','database','later-page']){
  const fresh=fixture();fresh.state.configs=[];fresh.document.records=[];fresh.document.materializedProjection=[];fresh.document.cursor=0;
  let page=0;const h=harness({snapshot:fresh,onCall(req){
   assert.equal(req.action,'sync.snapshot');page++;
   if(mode==='later-page'&&page===1)return{ok:true,checkpointSeq:100,records:[change(fixture().document.records[0].base,1)],nextCursor:['configuration','c1'],hasMore:true};
   return{ok:false,code:mode==='denied'?'UNAUTHENTICATED':mode==='database'?'DATABASE_UNAVAILABLE':'SNAPSHOT_UNAVAILABLE'};
  }});
  await assert.rejects(h.engine.run({member,upload:false}));
  assert.equal(h.current.document.cursor,0);assert.equal(h.current.state.configs.length,0);assert.equal(h.commits,0);
 }
});

test('initial snapshot interruption preserves empty cursor and retries without any upload',async()=>{
 const fresh=fixture();fresh.state.configs=[];fresh.document.records=[];fresh.document.materializedProjection=[];fresh.document.cursor=0;
 let calls=0;const h=harness({snapshot:fresh,onCall(req){assert.equal(req.action,'sync.snapshot');calls++;if(calls===1)return{ok:true,checkpointSeq:100,records:[change(fixture().document.records[0].base,1)],nextCursor:['configuration','c1'],hasMore:true};throw Error('snapshot network interrupted');}});
 await assert.rejects(h.engine.run({member,upload:false}),/interrupted/);
 assert.equal(h.current.document.cursor,0);assert.deepEqual(h.current.document.records,[]);assert.equal(h.current.state.configs.length,0);assert.equal(h.commits,0);
});

test('pause during the final initial snapshot response does not publish a partial first workspace',async()=>{
 const fresh=fixture();fresh.state.configs=[];fresh.document.records=[];fresh.document.materializedProjection=[];fresh.document.cursor=0;
 const h=harness({snapshot:fresh,onCall(req){assert.equal(req.action,'sync.snapshot');h.engine.stop();return{ok:true,checkpointSeq:100,records:[change(fixture().document.records[0].base,1)],nextCursor:['configuration','c1'],hasMore:false};}});
 await assert.rejects(h.engine.run({member,upload:false}),error=>error.code==='SYNC_STOPPED');
 assert.equal(h.current.document.cursor,0);assert.equal(h.commits,0);assert.equal(h.current.state.configs.length,0);
});

test('cursor zero with existing local edits keeps incremental merge instead of fresh snapshot',async()=>{
 for(const unaligned of [false,true]){
  const current=fixture();current.document.cursor=0;current.document.records=unaligned?[]:current.document.records.map(row=>({...row,version:0,base:null}));if(unaligned)current.document.materializedProjection=[];
  const h=harness({snapshot:current,onCall(req){assert.equal(req.action,'sync.pull');return{ok:true,headSeq:0,nextCursor:0,hasMore:false,changes:[]};}});
  await h.engine.run({member,upload:false});assert.equal(h.current.state.configs[0].name,'旧名');assert.equal(h.current.document.records[0].base,null);
 }
});

test('unfinished download from empty origin resumes via snapshot once, then remains incremental after completion',async()=>{
 const partial=fixture();partial.document.origin='empty-workspace';partial.document.cursor=300;
 const h=harness({snapshot:partial,onCall(req,api){
  if(req.action==='sync.snapshot')return{ok:true,checkpointSeq:900,records:api.current.document.records.map(row=>({type:row.type,id:row.id,version:row.version+1,data:{...copy(row.base),...(row.type==='configuration'?{name:'latest snapshot'}:{})}})),nextCursor:['workspace_meta','root'],hasMore:false};
  assert.equal(req.action,'sync.pull');assert.equal(req.payload.cursor,900);return{ok:true,headSeq:900,nextCursor:900,hasMore:false,changes:[]};
 }});
 await h.engine.run({member});assert.equal(h.current.state.configs[0].name,'latest snapshot');assert.equal(h.current.document.origin,'empty-workspace');assert.ok(h.current.document.lastSyncedAt);
 assert.deepEqual(h.calls.map(req=>req.action),['sync.snapshot','sync.pull','sync.pull']);
 await h.engine.run({member,upload:false});assert.equal(h.calls.filter(req=>req.action==='sync.snapshot').length,1);
});

test('partial download with missing origin, migration origin, completed sync, conflict or local draft never switches to snapshot',async()=>{
 for(const reason of ['missing-origin','migration','synced','draft','unaligned-edit','conflict']){
  const partial=fixture();partial.document.origin='empty-workspace';partial.document.cursor=300;
  if(reason==='missing-origin')delete partial.document.origin;
  if(reason==='migration')partial.document.origin='cutover-preflight';
  if(reason==='synced')partial.document.lastSyncedAt='2026-10-14T01:00:00Z';
  if(reason==='draft'){partial.document.records[0].draft.name='local draft';partial.state.configs[0].name='local draft';partial.document.materializedProjection=projectWorkspace(partial.state);}
  if(reason==='unaligned-edit')partial.state.configs[0].name='unsynchronized local edit';
  if(reason==='conflict'){const row=partial.document.records[0];row.conflict={fields:['name'],remote:{type:row.type,id:row.id,version:row.version,data:copy(row.base)}};}
  const originalName=partial.state.configs[0].name;
  const h=harness({snapshot:partial,onCall(req){assert.equal(req.action,'sync.pull',reason);return{ok:true,headSeq:300,nextCursor:300,hasMore:false,changes:[]};}});
  await h.engine.run({member,upload:false});assert.equal(h.current.state.configs[0].name,originalName,reason);
 }
});

test('local edit arriving during partial first snapshot is preserved by checkpoint CAS merge',async()=>{
 const partial=fixture();partial.document.origin='empty-workspace';partial.document.cursor=300;
 const h=harness({snapshot:partial,onCall(req,api){
  if(req.action==='sync.snapshot'){
   api.edit(state=>{state.configs[0].footer='typed while downloading';});
   return{ok:true,checkpointSeq:900,records:partial.document.records.map(row=>({type:row.type,id:row.id,version:row.version+1,data:{...copy(row.base),...(row.type==='configuration'?{name:'snapshot name'}:{})}})),nextCursor:['workspace_meta','root'],hasMore:false};
  }
  assert.equal(req.action,'sync.pull');return{ok:true,headSeq:900,nextCursor:900,hasMore:false,changes:[]};
 }});
 await h.engine.run({member,upload:false});assert.equal(h.current.state.configs[0].footer,'typed while downloading');assert.equal(h.current.state.configs[0].name,'snapshot name');
 assert.equal(h.current.document.records.find(row=>row.id==='c1').draft.footer,'typed while downloading');assert.equal((await h.engine.status()).pending,1);
});
test('partial batch persists confirmed result and leaves failed immutable outbox',async()=>{const s=fixture();s.state.configs.push({...copy(s.state.configs[0]),id:'c2'});s.document.materializedProjection=projectWorkspace(s.state);s.document.records.push({...copy(s.document.records[0]),id:'c2',base:{...copy(s.document.records[0].base),id:'c2'},draft:{...copy(s.document.records[0].draft),id:'c2'}});const h=harness({snapshot:s,onCall(req){if(req.action==='sync.pushBatch')return {ok:true,results:req.payload.requests.map((r,i)=>i===0?{ok:true,mutationId:r.payload.mutationId,record:{type:r.payload.entityType,id:r.payload.entityId,version:2,data:r.payload.after}}:{ok:false,code:'RETRYABLE'})};}});h.edit(s=>s.configs.forEach(c=>c.name='新'));await assert.rejects(h.engine.run({member}),/RETRYABLE/);assert.equal(h.current.document.outbox.length,1);assert.equal(h.current.document.records.find(r=>r.id==='c1').version,2);assert.equal(h.current.document.records.find(r=>r.id==='c2').version,1);});
test('wrong identity/version/mutation and expired receipt retain original outbox',async()=>{for(const mode of ['identity','version','mutation','expired']){const h=harness({onCall(req){if(req.action==='sync.pushBatch'){const r=req.payload.requests[0],p=r.payload;return {ok:true,results:[mode==='expired'?{ok:false,code:'RECEIPT_EXPIRED'}:{ok:true,mutationId:mode==='mutation'?'other':p.mutationId,record:{type:'configuration',id:mode==='identity'?'other':p.entityId,version:mode==='version'?0:2,data:p.after}}]};}}});h.edit(s=>s.configs[0].name='新');await assert.rejects(h.engine.run({member}));assert.equal(h.current.document.outbox.length,1);assert.equal(h.current.state.configs[0].name,'新');}});
test('local image blocks push without uploader; uploader covers pending and immutable refs',async()=>{const url='/uploads/'+'a'.repeat(64)+'.png';const h=harness();h.edit(s=>s.configs[0].caseImage=url);await assert.rejects(h.engine.run({member}),/原图上传/);assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,0);assert.equal(h.current.state.configs[0].caseImage,url);let verified=false;const a=harness({downloadAssets(){},uploadAssets(payload){assert.deepEqual(payload.urls,[url]);verified=true;},onCall(req){if(req.action==='sync.pushBatch')assert.equal(verified,true);}});a.edit(s=>s.configs[0].caseImage=url);await a.engine.run({member});assert.equal(a.current.document.outbox.length,0);});
test('read only queries receipt and never retries uncertain push or uploads assets',async()=>{let uploads=0;const h=harness({uploadAssets(){uploads++;},onCall(req){if(req.action==='sync.receipt')return {ok:false,code:'NOT_FOUND'};}});h.edit(s=>s.configs[0].name='新');h.change(s=>{const row=s.document.records[0];row.draft.name='新';s.document.materializedProjection=projectWorkspace(s.state);s.document.outbox=[{protocolVersion:2,action:'sync.push',requestId:crypto.randomUUID(),payload:{mutationId:crypto.randomUUID(),deviceId:'d1',entityType:'configuration',entityId:'c1',baseVersion:1,after:copy(row.draft)}}];});await assert.rejects(h.engine.run({member,upload:false}),/NOT_FOUND/);assert.deepEqual(h.calls.map(r=>r.action),['sync.receipt']);assert.equal(uploads,0);assert.equal(h.current.document.outbox.length,1);});
test('CAS retry bounded; never sends unsaved mutation',async()=>{const h=harness({onCommit(req,api){api.edit(s=>s.configs[0].footer='concurrent');}});h.edit(s=>s.configs[0].name='新');await assert.rejects(h.engine.run({member}),/持续变化/);assert.equal(h.commits,8);assert.equal(h.calls.length,0);assert.equal(h.current.state.configs[0].name,'新');});
test('soft deletion is staged as tombstone rather than lost record',async()=>{const h=harness();h.edit(s=>s.configs=[]);await h.engine.run({member});assert.ok(h.current.document.records.find(r=>r.id==='c1').base.deletedAt);assert.ok(h.current.state.configs[0].deletedAt);});
test('read-only inbound image downloads before materialization; failed download retains cursor',async()=>{const url='/uploads/'+'b'.repeat(64)+'.png';for(const mode of ['success','failure','missing']){let downloaded=false;const h=harness({downloadAssets:mode==='missing'?undefined:async payload=>{assert.deepEqual(payload.urls,[url]);assert.equal(h.current.document.cursor,1);if(mode==='failure')throw Error('下载断线');downloaded=true;},onCall(req,api){if(req.action==='sync.pull')return {ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:req.payload.cursor===1?[change({...rowData(api),caseImage:url},2,2)]:[]};},onCommit(req){if(req.document.cursor===2)assert.equal(downloaded,true);}});if(mode==='success'){await h.engine.run({member,upload:false});assert.equal(h.current.state.configs[0].caseImage,url);}else{await assert.rejects(h.engine.run({member,upload:false}));assert.equal(h.current.document.cursor,1);assert.equal(h.current.state.configs[0].caseImage,undefined);}}});
test('same version different remote contents rejected without consuming cursor',async()=>{const h=harness({onCall(req,api){if(req.action==='sync.pull')return {ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:[change({...rowData(api),name:'被篡改'},1,2)]};}});await assert.rejects(h.engine.run({member,upload:false}),/同一云端/);assert.equal(h.current.document.cursor,1);});
test('batch boundaries obey maximum 50 requests',async()=>{const s=fixture();s.state.configs=Array.from({length:101},(_,i)=>({...copy(s.state.configs[0]),id:'c'+i}));s.document.materializedProjection=projectWorkspace(s.state);s.document.records=[...s.document.materializedProjection.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),s.document.records.find(r=>r.type==='workspace_meta')];const h=harness({snapshot:s,onCall(req){if(req.action==='sync.pushBatch')assert.ok(req.payload.requests.length<=50);}});h.edit(s=>s.configs.forEach(c=>c.name='批量新'));await h.engine.run({member});assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests.length),[50,50,1]);});
test('stop before transmission preserves immutable queue; run resumes',async()=>{let once=true;const h=harness({onCommit(req){if(once&&req.document.outbox.length){once=false;h.engine.stop();}}});h.edit(s=>s.configs[0].name='待上传');await assert.rejects(h.engine.run({member}),error=>error.code==='SYNC_STOPPED');const request=copy(h.current.document.outbox[0]);assert.ok(request);assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,0);await h.engine.run({member});assert.deepEqual(h.calls.find(r=>r.action==='sync.pushBatch').payload.requests[0],request);});
test('stop during network records confirmed receipt before stopping',async()=>{const h=harness({onCall(req){if(req.action==='sync.pushBatch')h.engine.stop();}});h.edit(s=>s.configs[0].name='已发出');await assert.rejects(h.engine.run({member}),error=>error.code==='SYNC_STOPPED');assert.equal(h.current.document.outbox.length,0);assert.equal(h.current.document.records[0].version,2);assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,1);});
test('read-only known receipt confirms request without upload and continues pull',async()=>{const h=harness({onCall(req,api){if(req.action==='sync.receipt'){const p=api.current.document.outbox[0].payload;return {ok:true,mutationId:p.mutationId,record:{type:p.entityType,id:p.entityId,version:2,data:p.after}};}}});h.change(s=>{const row=s.document.records[0];row.draft.name='已提交';s.state.configs[0].name='已提交';s.state.revision++;s.document.materializedProjection=projectWorkspace(s.state);s.document.outbox=[{protocolVersion:2,action:'sync.push',requestId:crypto.randomUUID(),payload:{mutationId:crypto.randomUUID(),deviceId:'d1',entityType:'configuration',entityId:'c1',baseVersion:1,after:copy(row.draft)}}];});await h.engine.run({member,upload:false});assert.deepEqual(h.calls.map(r=>r.action),['sync.receipt','sync.pull']);assert.equal(h.current.document.outbox.length,0);assert.equal(h.current.state.configs[0].name,'已提交');});
test('batch byte budget splits large records while preserving identity',async()=>{const s=fixture();s.state.configs=Array.from({length:5},(_,i)=>({...copy(s.state.configs[0]),id:'c'+i}));s.document.materializedProjection=projectWorkspace(s.state);s.document.records=[...s.document.materializedProjection.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),s.document.records.find(r=>r.type==='workspace_meta')];const h=harness({snapshot:s,onCall(req){if(req.action==='sync.pushBatch')assert.ok(req.payload.requests.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0)<=210000);}});h.edit(s=>s.configs.forEach(c=>c.notes='x'.repeat(100000)));await h.engine.run({member});assert.deepEqual(h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests.length),[2,2,1]);});
test('gallery and root receive through desktop engine',async()=>{const h=harness({onCall(req){if(req.action==='sync.pull')return {ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:req.payload.cursor===1?[{type:'gallery',id:'g1',version:1,seq:2,data:{id:'g1',name:'分类',deletedAt:null}}]:[]};}});await h.engine.run({member,upload:false});assert.deepEqual(h.current.state.caseGallery,[{id:'g1',name:'分类',deletedAt:null}]);});
test('older ERP changes consume sequence but never materialize local cache',async()=>{const h=harness({onCall(req){if(req.action==='sync.pull')return {ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:req.payload.cursor===1?[{type:'erp_snapshot',id:'current',version:1,seq:2,data:{scope:'old',stockAvailable:0}}]:[]};}});await h.engine.run({member,upload:false});assert.equal(h.current.document.cursor,2);assert.equal(h.current.document.records.some(r=>r.type==='erp_snapshot'),false);});
test('cached frozen loader data is never mutated by align, receive or acknowledgement',async()=>{
 const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
 let current=fixture(),loads=0,log=[];current.state.configs[0].name='缓存本机改名';current.state.revision++;current=freeze(current);
 const cache=createCloudCheckpointCache(async(action,input)=>{
  if(action==='load'){loads++;return current;}
  if(action==='status')return {session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  if(action==='commit'){assert.equal(input.baseRevision,current.state.revision);assert.equal(input.cloudVersion,current.cloudVersion);current=freeze({state:{...input.state,revision:current.state.revision+1},cloudVersion:current.cloudVersion+1,document:input.document});return {revision:current.state.revision,cloudVersion:current.cloudVersion};}
 });
 const initial=current,engine=createCloudEngine({...cache,async call(req){if(req.action==='sync.pushBatch')return {ok:true,results:req.payload.requests.map(r=>{const p=r.payload,row={type:p.entityType,id:p.entityId,version:p.baseVersion+1,data:p.after,seq:2};log=[row];return {ok:true,mutationId:p.mutationId,record:row};})};return {ok:true,headSeq:log.length?2:1,nextCursor:log.length?2:1,hasMore:false,changes:req.payload.cursor<2?log:[]};}});
 await engine.run({member});assert.equal(loads,1);assert.equal(initial.document.records[0].base.name,'旧名');assert.equal(initial.document.records[0].draft.name,'旧名');assert.equal(initial.document.outbox.length,0);assert.equal(current.state.configs[0].name,'缓存本机改名');assert.equal(current.document.outbox.length,0);
});
test('conflict change during resolve CAS requires new comparison',async()=>{const s=fixture(),row=s.document.records[0],remote={type:row.type,id:row.id,version:2,data:{...copy(row.base),name:'远端2'}};row.base=copy(remote.data);row.version=2;row.draft.name='本机';row.conflict={code:'CONFLICT',fields:['name'],remote};s.state.configs[0].name='本机';s.document.materializedProjection=projectWorkspace(s.state);let once=true;const h=harness({snapshot:s,onCommit(req,api){if(once){once=false;api.change(s=>{const row=s.document.records[0];row.conflict={...row.conflict,remote:{...copy(row.conflict.remote),version:3,data:{...copy(row.conflict.remote.data),name:'远端3'}}};row.base=copy(row.conflict.remote.data);row.version=3;s.cloudVersion++;});}}});await assert.rejects(h.engine.resolve('configuration','c1','remote'),/重新比较/);assert.equal(h.current.state.configs[0].name,'本机');assert.equal(h.current.document.records[0].conflict.remote.data.name,'远端3');});


// 线上数据库批量 RPC 在约 8 秒失败时，用原持久请求逐步缩小批次。
test('database batch failure halves transmissions without replacing durable requests',async()=>{
 const counts=[],original=new Map();let first=true;
 const h=harness({snapshot:assetFixture(12),onCall(req,api){
  if(req.action!=='sync.pushBatch')return;
  const rows=req.payload.requests;counts.push(rows.length);
  if(first){first=false;for(const row of api.current.document.outbox)original.set(row.payload.mutationId,copy(row));api.edit(s=>s.configs[0].footer='失败期间的新编辑');}
  for(const row of rows){const old=original.get(row.payload.mutationId);if(old)assert.deepEqual(row,old);}
  if(rows.length>3)return {ok:false,code:'DATABASE_UNAVAILABLE',message:'云端数据库请求失败'};
 }});
 h.edit(s=>s.configs.forEach(c=>c.name='待上传'));
 await h.engine.run({member});
 assert.deepEqual(counts,[12,6,3,3,3,3,1]);
 assert.equal(h.current.document.outbox.length,0);
 assert.equal(h.current.state.configs[0].footer,'失败期间的新编辑');
 assert.equal((await h.engine.status()).pending,0);
});

test('unavailable single record stops with the complete immutable queue retained',async()=>{
 const h=harness({snapshot:assetFixture(5),onCall(req){if(req.action==='sync.pushBatch')return {ok:false,code:'DATABASE_UNAVAILABLE'};}});
 h.edit(s=>s.configs.forEach(c=>c.name='本机保留'));
 await assert.rejects(h.engine.run({member}),error=>error.code==='DATABASE_UNAVAILABLE');
 const batches=h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests);
 assert.deepEqual(batches.map(r=>r.length),[5,2,1]);
 assert.deepEqual(h.current.document.outbox,batches[0]);
 assert.ok(h.current.state.configs.every(c=>c.name==='本机保留'));
});

test('permission or malformed responses never trigger batch replay',async()=>{
 for(const response of [{ok:false,code:'FORBIDDEN'},{ok:false,code:'UNAUTHENTICATED'},null,{ok:true,results:[]}]){
  const h=harness({snapshot:assetFixture(5),onCall(req){if(req.action==='sync.pushBatch')return response;}});
  h.edit(s=>s.configs.forEach(c=>c.name='保留'));
  await assert.rejects(h.engine.run({member}));
  assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,1);
  assert.equal(h.current.document.outbox.length,5);
 }
});

test('pause after unavailable response stops before transmitting a smaller batch',async()=>{
 const h=harness({snapshot:assetFixture(5),onCall(req){if(req.action==='sync.pushBatch'){h.engine.stop();return {ok:false,code:'DATABASE_UNAVAILABLE'};}}});
 h.edit(s=>s.configs.forEach(c=>c.name='保留'));
 await assert.rejects(h.engine.run({member}),error=>error.code==='SYNC_STOPPED');
 assert.equal(h.calls.filter(r=>r.action==='sync.pushBatch').length,1);
 assert.equal(h.current.document.outbox.length,5);
});

test('database error after server commit replays receipts without duplicate changes',async()=>{
 let lost=true;
 const h=harness({snapshot:assetFixture(8),async onCall(req,api){
  if(req.action==='sync.pushBatch'&&lost){lost=false;await api.call(req);return {ok:false,code:'DATABASE_UNAVAILABLE'};}
 }});
 h.edit(s=>s.configs.forEach(c=>c.name='服务器已提交'));
 await h.engine.run({member});
 assert.equal(h.current.document.outbox.length,0);
 assert.ok(h.current.document.records.filter(r=>r.type==='configuration').every(r=>r.version===2));
 assert.equal(h.current.document.cursor,9);
 const batches=h.calls.filter(r=>r.action==='sync.pushBatch').map(r=>r.payload.requests);
 assert.deepEqual(batches.slice(2).flat(),batches[0]);
});


test('shop selection isolates upload and preserves other drafts across restart',async()=>{
 const snapshot=fixture();const other={...copy(snapshot.state.configs[0]),id:'c2',shopId:'jonsbo'};
 snapshot.state.configs.push(other);const projected=projectWorkspace(snapshot.state);
 snapshot.document.materializedProjection=projected;
 snapshot.document.records.push({type:'configuration',id:'c2',base:copy(projected[1].data),draft:copy(projected[1].data),version:1,conflict:null});
 const h=harness({snapshot});h.edit(s=>s.configs.forEach(c=>c.name='本机新名'));
 await h.engine.run({member,shopIds:['intel']});
 assert.deepEqual(h.calls.filter(c=>c.action==='sync.pushBatch').flatMap(c=>c.payload.requests.map(r=>r.payload.entityId)),['c1']);
 assert.equal(h.current.document.cursor,1);
 assert.equal(h.current.document.records.find(r=>r.id==='c2').base.name,'旧名');
 assert.equal(h.current.state.configs.find(r=>r.id==='c2').name,'本机新名');
 const resumed=harness({snapshot:h.current});await resumed.engine.run({member,shopIds:['jonsbo']});
 assert.deepEqual(resumed.calls.filter(c=>c.action==='sync.pushBatch').flatMap(c=>c.payload.requests.map(r=>r.payload.entityId)),['c2']);
});

test('unselected downloads and images wait until that shop is selected',async()=>{
 const remote={...copy(fixture().document.records[0].base),id:'c2',shopId:'jonsbo',name:'乔思伯云端',image:'/uploads/'+'a'.repeat(64)+'.png'};
 const rows=[{type:'configuration',id:'c2',version:1,seq:2,data:remote}];
 const downloaded=[];
 const h=harness({downloadAssets:async({urls})=>downloaded.push(...urls),onCall:req=>req.action==='sync.pull'?{ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:req.payload.cursor<2?rows:[]}:undefined});
 await h.engine.run({member,upload:false,shopIds:['intel']});
 assert.equal(h.current.state.configs.some(c=>c.id==='c2'),false);
 assert.equal(h.current.document.cursor,1);assert.equal(h.current.document.shopCursors.intel,2);assert.equal(downloaded.length,0);
 await h.engine.run({member,upload:false,shopIds:['jonsbo']});
 assert.equal(h.current.state.configs.find(c=>c.id==='c2').name,'乔思伯云端');
 assert.equal(h.current.document.shopCursors.jonsbo,2);assert.deepEqual(downloaded,[remote.image]);
});

test('empty or unknown shop selection never contacts cloud',async()=>{
 const h=harness();await assert.rejects(h.engine.run({member,shopIds:[]}));await assert.rejects(h.engine.run({member,shopIds:['unknown']}));assert.equal(h.calls.length,0);
});


test('scoped failed image download preserves progress and retries without skipping',async()=>{
 const data={...copy(fixture().document.records[0].base),name:'新名',image:'/uploads/'+'b'.repeat(64)+'.png'};
 let failed=true;
 const h=harness({downloadAssets:async()=>{if(failed)throw Error('模拟网络失败');},onCall:req=>req.action==='sync.pull'?{ok:true,headSeq:2,nextCursor:2,hasMore:false,changes:req.payload.cursor<2?[change(data)]:[]}:undefined});
 await assert.rejects(h.engine.run({member,upload:false,shopIds:['intel']}),/模拟网络失败/);
 assert.equal(h.current.document.shopCursors,undefined);assert.equal(h.current.state.configs[0].name,'旧名');
 failed=false;await h.engine.run({member,upload:false,shopIds:['intel']});
 assert.equal(h.current.document.shopCursors.intel,2);assert.equal(h.current.state.configs[0].name,'新名');
});

test('unselected uncertain request stays unchanged and is never transmitted',async()=>{
 const snapshot=fixture();snapshot.state.configs[0].shopId='jonsbo';
 const data=projectWorkspace(snapshot.state)[0].data;
 Object.assign(snapshot.document.records[0],{base:copy(data),draft:{...copy(data),name:'待确认'}});
 snapshot.state.configs[0].name='待确认';snapshot.document.materializedProjection=projectWorkspace(snapshot.state);
 const req={protocolVersion:2,action:'sync.push',requestId:crypto.randomUUID(),payload:{mutationId:crypto.randomUUID(),deviceId:'d1',entityType:'configuration',entityId:'c1',baseVersion:1,after:copy(snapshot.document.records[0].draft)}};
 snapshot.document.outbox=[req];const h=harness({snapshot});await h.engine.run({member,shopIds:['intel']});
 assert.deepEqual(h.current.document.outbox,[req]);assert.equal(h.calls.some(r=>['sync.pushBatch','sync.receipt'].includes(r.action)),false);
});
for(const mode of ['nas','cloud'])test(mode+' cost update stays local while cloud configuration changes still merge',async()=>{
 const snapshot=fixture();snapshot.state.costSource=[{goodsId:'123',name:'CPU',tax:500}];snapshot.state.configs[0].parts=[{goodsId:'123',name:'CPU',slot:'CPU',qty:1,tax:500,lineId:'p'}];
 const projection=projectWorkspace(snapshot.state);snapshot.document.materializedProjection=copy(projection);snapshot.document.records=[...projection.map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null})),snapshot.document.records.find(r=>r.type==='workspace_meta')];
 snapshot.state.costSync={mode};snapshot.state.costSource[0].tax=950;snapshot.state.configs[0].parts[0].tax=950;snapshot.state.revision++;
 const remoteConfig=copy(projection.find(r=>r.type==='configuration').data);remoteConfig.name='云端改名';const remoteCost=copy(projection.find(r=>r.type==='component'));
 const h=harness({snapshot,onCall(req){if(req.action==='sync.pull')return {ok:true,headSeq:3,nextCursor:3,hasMore:false,changes:[{...remoteCost,version:2,seq:2,data:{...remoteCost.data,taxCents:88800}},change(remoteConfig,2,3)].filter(row=>row.seq>req.payload.cursor)};}});
 await h.engine.run({member});assert.equal(h.current.state.configs[0].name,'云端改名');assert.equal(h.current.state.configs[0].parts[0].tax,950);assert.equal(h.current.state.costSource[0].tax,950);assert.equal(h.calls.some(r=>r.action==='sync.pushBatch'),false);
});

test('server scoped pages skip foreign sequences only with matching scope receipt',async()=>{
 const h=harness({onCall:req=>{if(req.action==='sync.pull'){
  assert.deepEqual(req.payload.shopIds,['intel']);
  return {ok:true,shopIds:['intel'],headSeq:1000,nextCursor:1000,hasMore:false,changes:[]};
 }}});
 await h.engine.run({member,upload:false,shopIds:['intel']});
 assert.equal(h.current.document.shopCursors.intel,1000);assert.equal(h.current.document.cursor,1);
 const bad=harness({onCall:req=>req.action==='sync.pull'?{ok:true,shopIds:['jonsbo'],headSeq:1000,nextCursor:1000,hasMore:false,changes:[]}:undefined});
 await assert.rejects(bad.engine.run({member,upload:false,shopIds:['intel']}),/游标/);
 assert.equal(bad.current.document.shopCursors,undefined);
});

test('combining already synced shops reuses each shops durable progress',async()=>{
 const snapshot=fixture();snapshot.document.shopCursors={intel:100,'gigabyte|jonsbo':80};
 const h=harness({snapshot,onCall:req=>{if(req.action==='sync.pull'){
  assert.equal(req.payload.cursor,80);return {ok:true,shopIds:['intel','jonsbo'],headSeq:100,nextCursor:100,hasMore:false,changes:[]};
 }}});
 await h.engine.run({member,upload:false,shopIds:['jonsbo','intel']});
 assert.equal(h.current.document.shopCursors.intel,100);assert.equal(h.current.document.shopCursors.jonsbo,100);
 assert.equal(h.current.document.shopCursors['gigabyte|jonsbo'],80);
});


test('locally removed shop re-downloads from zero without sending cloud deletions',async()=>{
 const s=fixture(),remote=copy(s.document.records.find(r=>r.type==='configuration'));
 s.state.configs=[];s.state.revision++;s.cloudVersion++;
 s.document.records=s.document.records.filter(r=>r.type!=='configuration');s.document.materializedProjection=[];
 s.document.cursor=0;s.document.shopCursors={intel:0,jonsbo:50,gigabyte:80};
 const h=harness({snapshot:s,onCall:req=>{
  if(req.action==='sync.snapshot')return {ok:false,code:'SNAPSHOT_UNAVAILABLE'};
  if(req.action==='sync.pull')return {ok:true,shopIds:req.payload.shopIds,headSeq:80,nextCursor:80,hasMore:false,changes:req.payload.cursor<1&&req.payload.shopIds.includes('intel')?[{type:remote.type,id:remote.id,version:remote.version,seq:1,data:remote.base}]:[]};
 }});
 await h.engine.run({member,shopIds:['jonsbo']});assert.equal(h.current.state.configs.length,0);
 await h.engine.run({member,shopIds:['intel']});assert.equal(h.current.state.configs[0].id,'c1');
 assert.equal(h.calls.some(c=>c.action==='sync.pushBatch'),false);
 assert.equal(h.calls.filter(c=>c.action==='sync.pull'&&c.payload.shopIds.includes('intel'))[0].payload.cursor,0);
 assert.equal(h.current.document.shopCursors.gigabyte,80);
});
