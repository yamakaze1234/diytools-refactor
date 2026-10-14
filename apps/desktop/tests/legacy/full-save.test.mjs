import test from 'node:test';
import assert from 'node:assert/strict';
import {saveFullState} from '../../public/workbench/full-save.js';
import {applyWorkspace,projectWorkspace} from '../../public/workbench/cloud-projection.js';
import {applyManualCosts} from '../../public/workbench/erp-sync.js';
import {initializeActualParts} from '../../public/workbench/actual-parts.js';
const base=()=>({revision:10,configs:[{id:'c',name:'old',parts:[{goodsId:'1',tax:100,erp:70}]}],sourceCatalog:[{sourceId:'s',goodsId:'1',tax:100,erp:70}],costSource:[{goodsId:'1',tax:100,erp:70}],templates:[],caseGallery:[],shopSettings:{},logs:[],erpSync:{updatedAt:'saved'}});
const stale=()=>Object.assign(Error('版本已更新'),{status:409});
test('ERP之后云更新推进revision：保留成本草稿、ERP字段及云新增配置后自动保存',async()=>{
 const original=base(),draft=structuredClone(original),remote=structuredClone(original),posts=[];
 draft.costSource[0].tax=120;draft.sourceCatalog[0].tax=120;draft.configs[0].parts[0].tax=120;
 remote.revision=12;remote.configs.push({id:'new',name:'cloud'});remote.configs[0].name='cloud-name';remote.costSource[0].erp=80;
 const expected=structuredClone(draft);
 const result=await saveFullState(async(path,options)=>{if(!options)return structuredClone(remote);const body=JSON.parse(options.body);posts.push(body);if(posts.length===1)throw stale();return {state:{...remote,...body,revision:13}};},original,draft,{});
 assert.deepEqual(posts.map(p=>p.baseRevision),[10,12]);assert.equal(result.state.costSource[0].tax,120);assert.equal(result.state.costSource[0].erp,80);
 assert.equal(result.state.configs.length,2);assert.equal(result.state.configs[0].name,'cloud-name');assert.equal(result.state.configs[0].parts[0].tax,120);
 assert.deepEqual(draft,expected);assert.equal(original.revision,10);
});
test('同一成本同时改成不同值：停止并保留草稿，不自动覆盖他人修改',async()=>{
 const original=base(),draft=structuredClone(original),remote=structuredClone(original);draft.costSource[0].tax=120;remote.costSource[0].tax=130;remote.revision++;
 let posts=0;await assert.rejects(saveFullState(async(path,options)=>{if(options){posts++;throw stale();}return remote;},original,draft,{}),e=>e.status===409);
 assert.equal(posts,1);assert.equal(draft.costSource[0].tax,120);assert.equal(remote.costSource[0].tax,130);
});
test('同步连续推进时有限重试，稍后可重新保存，不误标永久冲突',async()=>{
 const original=base(),draft=structuredClone(original);draft.costSource[0].tax=120;let revision=10,posts=0;
 await assert.rejects(saveFullState(async(path,options)=>{if(options){posts++;throw stale();}return {...original,revision:++revision};},original,draft,{},3),e=>e.code==='SAVE_RETRY_LATER'&&e.status!==409);
 assert.equal(posts,3);assert.equal(draft.costSource[0].tax,120);
});
test('同revision的真实409和非并发网络失败不会自动重写',async()=>{
 for(const status of [409,500]){let posts=0;const original=base();await assert.rejects(saveFullState(async(path,options)=>{if(options){posts++;throw Object.assign(Error('failure'),{status});}return original;},original,structuredClone(original),{}),e=>e.status===status);assert.equal(posts,1);}
});

test('云物化保留本机成本时间，人工更新与无业务变化的远端回载不误冲突',async()=>{
 const fixture=base();fixture.configs[0].price=200;fixture.configs[0].parts[0].slot='CPU';fixture.costSource[0].name='fixture';fixture.sharedCostScope='fixture';
 const original=initializeActualParts(applyWorkspace(fixture,projectWorkspace(fixture)));
 applyManualCosts(original,[{goodsId:'1',tax:100}],'2026-10-14T01:00:00.000Z');
 original.configs[0].erpImportedAt='2026-10-14T01:30:00.000Z';
 const projected=projectWorkspace(original),config=projected.find(row=>row.type==='configuration').data;
 assert.equal(Object.hasOwn(config,'taxUpdatedAt'),false);assert.equal(Object.hasOwn(config,'erpImportedAt'),false);
 const remote=initializeActualParts(applyWorkspace(original,projected));remote.revision++;
 assert.equal(remote.configs[0].taxUpdatedAt,original.configs[0].taxUpdatedAt);assert.equal(remote.configs[0].erpImportedAt,original.configs[0].erpImportedAt);
 const draft=structuredClone(original);applyManualCosts(draft,[{goodsId:'1',tax:120}],'2026-10-14T02:00:00.000Z');
 let posts=0;
 const saved=await saveFullState(async(path,options)=>{if(!options)return remote;posts++;if(posts===1)throw stale();return{state:{...remote,...JSON.parse(options.body)}};},original,draft,{});
 assert.equal(posts,2);assert.equal(saved.state.costSource[0].tax,120);assert.equal(saved.state.configs[0].taxUpdatedAt,'2026-10-14T02:00:00.000Z');
 // 相同人工价格字段真实被另一次编辑修改，仍须显式比较。
 const concurrent=structuredClone(remote);applyManualCosts(concurrent,[{goodsId:'1',tax:130}],'2026-10-14T03:00:00.000Z');posts=0;
 await assert.rejects(saveFullState(async(path,options)=>{if(options){posts++;throw stale();}return concurrent;},original,draft,{}),e=>e.status===409);
 assert.equal(posts,1);assert.equal(draft.costSource[0].tax,120);
});

test('同配置不同商品同时人工改价只合并派生时间，保留两边价格且同商品冲突仍拒绝',async()=>{
 const original=base();original.configs[0].parts[0].slot='CPU';original.configs[0].parts.push({slot:'GPU',goodsId:'2',tax:200,erp:180});
 original.costSource.push({goodsId:'2',tax:200,erp:180});original.sourceCatalog.push({sourceId:'s2',goodsId:'2',tax:200,erp:180});
 original.configs[0].taxUpdatedAt='2026-10-14T07:00:00.000Z';original.configs[0].erpImportedAt='2026-10-14T06:00:00.000Z';
 const draft=structuredClone(original),remote=structuredClone(original);remote.revision++;
 applyManualCosts(draft,[{goodsId:'1',tax:125.5}],'2026-10-14T08:00:00.000Z');
 applyManualCosts(remote,[{goodsId:'2',tax:88}],'2026-10-14T09:00:00.000Z');
 draft.configs[0].erpImportedAt='2026-10-14T08:30:00.000Z';remote.configs[0].erpImportedAt='2026-10-14T09:30:00.000Z';
 let posts=0;
 const saved=await saveFullState(async(path,options)=>{if(!options)return remote;posts++;if(posts===1)throw stale();return{state:{...remote,...JSON.parse(options.body)}};},original,draft,{});
 assert.equal(posts,2);assert.deepEqual(saved.state.costSource.map(row=>row.tax),[125.5,88]);assert.deepEqual(saved.state.configs[0].parts.map(row=>row.tax),[125.5,88]);
 assert.equal(saved.state.configs[0].taxUpdatedAt,'2026-10-14T09:00:00.000Z');assert.equal(saved.state.configs[0].erpImportedAt,'2026-10-14T09:30:00.000Z');
 applyManualCosts(remote,[{goodsId:'1',tax:130}],'2026-10-14T10:00:00.000Z');posts=0;
 await assert.rejects(saveFullState(async(path,options)=>{if(options){posts++;throw stale();}return remote;},original,draft,{}),e=>e.status===409);assert.equal(posts,1);
 assert.equal(draft.costSource[0].tax,125.5);assert.equal(remote.costSource[0].tax,130);
});
