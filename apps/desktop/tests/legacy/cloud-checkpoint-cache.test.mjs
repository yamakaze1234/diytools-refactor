import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCheckpointCache} from '../../public/workbench/cloud-checkpoint-cache.js';
test('cache skips large snapshots only while identity, local revision and queue version all match',async()=>{
 let count=0,current={state:{revision:7,configs:[]},cloudVersion:2,document:{uid:'u',workspaceId:'w',outbox:[]}},member={uid:'u',workspaceId:'w'};
 const cache=createCloudCheckpointCache(async(action,input)=>{
  if(action==='load'){count++;return structuredClone(current);}
  if(action==='status')return{session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  if(action==='commit'){current={...input,state:{...input.state,revision:8},cloudVersion:3};return{revision:8,cloudVersion:3};}
 });
 const first=await cache.load(),second=await cache.load();assert.equal(count,1);assert.notEqual(first,second);assert.notEqual(first.state,second.state);
 await cache.commit({...first,baseRevision:7});assert.equal((await cache.load()).state.revision,8);assert.equal(count,1);
 current.state.revision=9;await cache.load();assert.equal(count,2);
 current.cloudVersion=4;await cache.load();assert.equal(count,3);
 member={uid:'different',workspaceId:'w'};await assert.rejects(cache.load(),/成员已变化/);assert.equal(count,3);
});
test('failed CAS discards all cached state before retry',async()=>{
 let loads=0;const cache=createCloudCheckpointCache(async action=>{if(action==='commit')throw Object.assign(Error('stale'),{status:409});if(action==='status')throw Error('stale cache used');loads++;return{state:{revision:loads},cloudVersion:1,document:{uid:'u',workspaceId:'w'}};});
 await cache.load();await assert.rejects(cache.commit({}),{status:409});await cache.load();assert.equal(loads,2);
});

test('copy-on-write commit sends only changed records and omits unchanged business state',async()=>{
 const rows=Array.from({length:100},(_,i)=>({type:'configuration',id:String(i),draft:{text:'x'.repeat(1000)}}));let submitted;
 const cache=createCloudCheckpointCache(async(action,input)=>{if(action==='load')return{state:{revision:7,configs:[]},cloudVersion:2,document:{uid:'u',workspaceId:'w',records:rows,outbox:[],materializedProjection:[]}};submitted=input;return{revision:7,cloudVersion:3};},{patch:true});
 const snapshot=await cache.load(),document={...snapshot.document,records:[...snapshot.document.records]};document.records[0]={...document.records[0],version:2};
 await cache.commit({...snapshot,baseRevision:7,document});assert.equal(submitted.state,undefined);assert.equal(submitted.document,undefined);assert.equal(submitted.documentPatch.records.length,1);assert.equal(submitted.documentPatch.records[0].id,'0');assert.ok(JSON.stringify(submitted).length<2000);
});

test('selected shop cursor commits stay sparse',async()=>{
 let submitted;
 const cache=createCloudCheckpointCache(async(action,input)=>{if(action==='load')return {state:{revision:7},cloudVersion:2,document:{uid:'u',workspaceId:'w',records:[],outbox:[],materializedProjection:[]}};submitted=input;return{revision:7,cloudVersion:3};},{patch:true});
 const snapshot=await cache.load();await cache.commit({...snapshot,baseRevision:7,document:{...snapshot.document,shopCursors:{intel:1000}}});
 assert.deepEqual(submitted.documentPatch,{set:{shopCursors:{intel:1000}},records:[]});assert.equal(submitted.document,undefined);assert.equal(submitted.state,undefined);
});
