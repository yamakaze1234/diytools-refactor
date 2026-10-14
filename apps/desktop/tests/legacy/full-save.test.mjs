import test from 'node:test';
import assert from 'node:assert/strict';
import {saveFullState} from '../../public/workbench/full-save.js';
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
