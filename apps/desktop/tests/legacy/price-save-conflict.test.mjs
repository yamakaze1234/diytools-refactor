import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as scope from '../../public/workbench/scoped-save.js';
import {mergePriceSaveConflict} from '../../public/workbench/price-save-merge.js';
import {mergeEditorState,cloneEditorState} from '../../public/workbench/editor-performance.js';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';
import {saveFullState} from '../../public/workbench/full-save.js';
const initial=()=>({revision:1,configs:[{id:'c1',shopId:'intel',productId:'p1',price:100,name:'配置1',priceImportedAt:'old'},{id:'c2',price:200}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]});
const changes=()=>{const base=initial(),local=structuredClone(base),remote=structuredClone(base);local.configs[0].price=110;local.configs[0].priceImportedAt='local';remote.configs[0].price=120;remote.configs[0].priceImportedAt='remote';remote.revision=2;return {base,local,remote};};

test('重现原合并的价格冲突，新规则保留本次价格并合并远端独立字段',()=>{
 const {base,local,remote}=changes();remote.configs[0].name='最新名称';remote.configs[1].price=230;
 assert.equal(mergeEditorState(base,local,remote).conflict,true);
 const result=mergePriceSaveConflict(base,local,remote);
 assert.equal(result.conflict,false);assert.equal(result.priceOverrides,1);
 assert.equal(result.state.configs[0].price,110);assert.equal(result.state.configs[0].priceImportedAt,'local');
 assert.equal(result.state.configs[0].name,'最新名称');assert.equal(result.state.configs[1].price,230);
 assert.equal(base.configs[0].price,100);assert.equal(remote.configs[0].price,120);
});
test('手工调整价格同样优先，但没有改过的导入时间跟随最新版本',()=>{
 const {base,local,remote}=changes();local.configs[0].priceImportedAt='old';
 const result=mergePriceSaveConflict(base,local,remote);assert.equal(result.conflict,false);
 assert.equal(result.state.configs[0].price,110);assert.equal(result.state.configs[0].priceImportedAt,'remote');
});
test('名称等其他字段重叠仍冲突，价格授权不扩大覆盖范围',()=>{
 const {base,local,remote}=changes();local.configs[0].name='本次名称';remote.configs[0].name='另一名称';
 assert.equal(mergePriceSaveConflict(base,local,remote).conflict,true);
});
test('删除、移至其他链接、无效价格不能自动覆盖',()=>{
 for(const mutate of [r=>r.configs.splice(0,1),r=>r.configs[0].deletedAt='deleted',r=>r.configs[0].productId='p2']){
  const {base,local,remote}=changes();mutate(remote);assert.equal(mergePriceSaveConflict(base,local,remote).priceOverrides,0);
 }
 const {base,local,remote}=changes();local.configs[0].price=-1;assert.equal(mergePriceSaveConflict(base,local,remote).priceOverrides,0);
});
test('本页未改价格时保留最新价格，不产生覆盖授权',()=>{
 const {base,local,remote}=changes();local.configs[0]={...base.configs[0],name:'本页名称'};
 const result=mergePriceSaveConflict(base,local,remote);assert.equal(result.priceOverrides,0);assert.equal(result.state.configs[0].price,120);
});

const app=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const saveCode=app.slice(app.indexOf('async function save(){'),app.indexOf('async function sendBatchPending(){'));
function harness({otherConflict=false,repeat=false,editDuringLoad=false}={}){
 const {base,local,remote}=changes(),requests=[],dialogs=[],nodes=new Map();
 if(otherConflict){local.configs[0].name='local';remote.configs[0].name='remote';}
 const c={...scope,state:local,acceptedState:base,dirty:true,conflict:false,fullWorkspace:true,
  savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,history:[],redoHistory:[],changed:{message:'更新价格'},operator:'test',
  crypto:{randomUUID},mergePriceSaveConflict,ordinarySaveChanges,cloneEditorState,saveFullState,
  request:async(url,options)=>{if(!options)return remote;const payload=JSON.parse(options.body);requests.push(payload);
   if(requests.length===1||repeat)throw Object.assign(Error('版本冲突'),{status:409});
   assert.equal(payload.baseRevision,2);assert.equal(payload.baseState?.configs[0].price??payload.changes[0].base.price,120);
   return {revision:3,configs:payload.configs||payload.changes.map(row=>row.after),updatedAt:'2026-10-19',activityDelta:[]};},
  completeWorkspaceSnapshot:async merge=>{if(editDuringLoad){c.state.configs[0].price=130;throw Error('载入期间有新的输入');}return {...merge(c.acceptedState,c.state,remote),remote};},
  acceptSavedState:async(snapshot,saved)=>{c.acceptedState=saved;},
  syncHistoryButtons(){},rememberDisplayParts(){},renderAll(){},pruneDetails(){},setTimeout:()=>0,compactWorkspace:async()=>{},
  pollDerivedStatus:async()=>{},scheduleImageSave(){},toast(){},openConflict:message=>dialogs.push(message),
  $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 vm.runInNewContext(saveCode+'\nglobalThis.run=save;',c);return {c,requests,dialogs};
}
test('实际导入保存入口收到409后以最新基线重试并覆盖价格',async()=>{
 const {c,requests,dialogs}=harness();await c.run();assert.equal(requests.length,2);
 assert.equal(requests[1].configs[0].price,110);assert.equal(c.state.configs[0].price,110);
 assert.equal(c.dirty,false);assert.equal(c.conflict,false);assert.deepEqual(dialogs,[]);
});
test('其他字段也冲突时停止覆盖并保留本页全部输入',async()=>{
 const {c,requests,dialogs}=harness({otherConflict:true});await assert.rejects(c.run(),e=>e.status===409);
 assert.equal(requests.length,1);assert.equal(dialogs.length,1);assert.equal(c.state.configs[0].name,'local');assert.equal(c.dirty,true);
});
test('持续并发时最多重试一次，不循环自动覆盖',async()=>{
 const {c,requests,dialogs}=harness({repeat:true});await assert.rejects(c.run(),e=>e.status===409);
 assert.equal(requests.length,2);assert.equal(dialogs.length,1);assert.equal(c.state.configs[0].price,110);
});
test('获取最新版本期间有新输入，保留输入且不使用旧快照覆盖',async()=>{
 const {c,requests}=harness({editDuringLoad:true});await assert.rejects(c.run(),/新的输入/);
 assert.equal(requests.length,1);assert.equal(c.state.configs[0].price,130);assert.equal(c.dirty,true);
});
