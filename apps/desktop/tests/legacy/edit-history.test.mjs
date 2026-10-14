import * as scopeHelpers from '../../public/workbench/scoped-save.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../../public/workbench/editor-performance.js';
import {mergeEditingState,sameEditingState,sameValue} from '../../public/workbench/workspace-ui-merge.js';

const config=id=>({id,name:id,parts:[{slot:'CPU',goodsId:'1',name:'CPU',qty:1,erp:null,stockAvailable:null}],actualParts:[],modules:[{id:'text',text:'原文'}],price:10});
const makeState=()=>({revision:1,configs:[config('one'),config('two')],templates:[],caseGallery:[],sourceCatalog:[{sourceId:'s',name:'源'}],costSource:[{goodsId:'1',tax:10}],shopSettings:{intel:{coupon:0}},logs:[{id:'archive'}],unknown:{keep:true}});
const ui=()=>({active:'one',activeShopId:'intel',selected:new Set(['one'])});
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// Keep these existing undo/retry fixtures on the complete-workspace branch.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
const historyCode=app.slice(app.indexOf('function historySnapshot(){'),app.indexOf('function visiblePosterInput('));
function harness(state=makeState()){
 const calls={changed:[],bound:[],aligned:[],rendered:[]};
 const context={...fullBranch,...helpers,...ui(),state,history:[],redoHistory:[],sameEditingState,mergeEditingState,clone:structuredClone,restoringHistory:false,posterEditor:null,catalog:state.sourceCatalog,$:()=>({disabled:false}),localStorage:{setItem(){}},sourceCatalog:rows=>rows,costRows:(_,rows)=>rows,bindSources:rows=>calls.bound.push(rows.map(row=>row.id)),alignDisplaySourceNames:rows=>calls.aligned.push(rows.map(row=>row.id)),available:()=>context.state.configs.filter(config=>!config.deletedAt),changed:(message,ids)=>calls.changed.push({message,ids}),renderAll:ids=>calls.rendered.push(ids)};
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(historyCode+'\nglobalThis.full=checkpoint;globalThis.scoped=checkpointConfig;globalThis.undo=()=>stepHistory(history,redoHistory,"undo");globalThis.redo=()=>stepHistory(redoHistory,history,"redo");globalThis.trim=trimHistory;',context);
 return {context,calls};
}
const row=(context,id)=>context.state.configs.find(config=>config.id===id);

test('普通编辑首次只捕获目标，重复聚焦去重；未变全局与其他配置不进入条目',()=>{
 const {context}=harness();context.scoped();assert.equal(context.history.length,1);const entry=context.history[0];
 assert.equal(entry.historyScope,'configs');assert.deepEqual([...entry.configs].map(config=>config.id),['one']);assert.equal(entry.costSource,undefined);assert.equal(entry.sourceCatalog,undefined);assert.equal(entry.logs,undefined);assert.notEqual(entry.configs[0],context.state.configs[0]);
 context.scoped();assert.equal(context.history.length,1);context.state.configs[0].name='输入';context.scoped();assert.equal(context.history.length,2);assert.equal(entry.configs[0].name,'one');
});
test('跨配置局部编辑与全局编辑混用时undo/redo严格按操作范围恢复',()=>{
 const {context,calls}=harness();context.scoped();row(context,'one').name='A1';context.active='two';context.selected=new Set(['two']);context.scoped();row(context,'two').parts[0].qty=2;
 context.full();context.state.configs.reverse();context.state.shopSettings.intel.coupon=20;context.state.costSource[0].tax=30;context.state.sourceCatalog[0].name='新源';context.active='one';context.selected=new Set(['one']);context.scoped();row(context,'one').name='A2';
 context.undo();assert.equal(row(context,'one').name,'A1');assert.equal(row(context,'two').parts[0].qty,2);assert.equal(context.state.shopSettings.intel.coupon,20);assert.deepEqual(calls.changed.at(-1).ids,['one']);assert.deepEqual(calls.bound.at(-1),['one']);assert.deepEqual(calls.rendered.at(-1),['one']);
 context.undo();assert.deepEqual(context.state.configs.map(config=>config.id),['one','two']);assert.equal(context.state.shopSettings.intel.coupon,0);assert.equal(context.state.costSource[0].tax,10);assert.equal(context.state.sourceCatalog[0].name,'源');assert.equal(row(context,'two').parts[0].qty,2);
 context.undo();assert.equal(row(context,'two').parts[0].qty,1);assert.equal(row(context,'one').name,'A1');context.undo();assert.equal(row(context,'one').name,'one');
 context.redo();assert.equal(row(context,'one').name,'A1');context.redo();assert.equal(row(context,'two').parts[0].qty,2);context.redo();assert.equal(context.state.shopSettings.intel.coupon,20);assert.deepEqual(context.state.configs.map(config=>config.id),['two','one']);context.redo();assert.equal(row(context,'one').name,'A2');
 assert.equal(context.state.revision,1);assert.equal(context.state.logs[0].id,'archive');
});
test('局部undo创建独立草稿，其他配置和全局集合保持引用；后续输入不污染history和redo',()=>{
 const {context}=harness(),other=context.state.configs[1],costs=context.state.costSource;context.scoped();row(context,'one').name='已改';context.scoped();row(context,'one').modules[0].text='新文字';context.undo();
 assert.equal(context.state.configs[1],other);assert.equal(context.state.costSource,costs);assert.equal(row(context,'one').modules[0].text,'原文');row(context,'one').parts[0].qty=8;assert.equal(context.history[0].configs[0].parts[0].qty,1);assert.equal(context.redoHistory[0].configs[0].parts[0].qty,1);
});
test('实际changed历史分支保留emptyLinkDraft/自动简称，且baseline仅刷新目标',()=>{
 const {context}=harness(),baseline=[];Object.assign(context,{acceptedState:null,dirty:false,changeCounter:0,pendingImages:new Set(),imageRecords:new Map(),timer:null,imageTimer:null,conflict:false,batchPromise:null,current:()=>row(context,context.active),document:{querySelector:()=>null},rememberDisplayParts:ids=>baseline.push(ids),visiblePosterInput:value=>JSON.stringify(value),updateHeading(){},updateSummary(){},schedulePreview(){},setTimeout:()=>1,clearTimeout(){},suggestedName(){throw Error('不应重算已恢复简称');},$:(id)=>({disabled:false,textContent:'',classList:{add(){}}})});
 const changed=app.slice(app.indexOf("function changed(message="),app.indexOf('function downloadBlob('));Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(changed,context);
 row(context,'one').emptyLinkDraft=true;row(context,'one').shortNameAuto=true;row(context,'one').shortName='原自动简称';context.scoped();delete row(context,'one').emptyLinkDraft;row(context,'one').shortName='改后简称';row(context,'one').price=11;context.undo();
 assert.equal(row(context,'one').emptyLinkDraft,true);assert.equal(row(context,'one').shortName,'原自动简称');assert.deepEqual(baseline.at(-1),['one']);assert.equal(context.dirty,true);
});
test('全局新增、删除与排序仍可撤销重做，未知scope保守完整捕获',()=>{
 const {context}=harness();context.scoped(['missing']);assert.equal(context.history[0].historyScope,undefined);context.state.configs.push(config('three'));context.state.configs[0].deletedAt='today';context.state.configs.reverse();context.undo();
 assert.deepEqual(context.state.configs.map(config=>config.id),['one','two']);assert.equal(context.state.configs[0].deletedAt,undefined);context.redo();assert.deepEqual(context.state.configs.map(config=>config.id),['three','two','one']);assert.equal(row(context,'one').deletedAt,'today');
});
test('局部历史回执重基只接触目标，保留其他配置并带入lineId等物化结果',()=>{
 const sent=makeState(),before=structuredClone(sent);before.configs[0].name='撤销前';const snapshot=helpers.captureConfigHistorySnapshot(before,ui(),['one']);const remote=structuredClone(sent);remote.configs[0].parts[0].lineId='line';remote.configs[1].name='其他编辑者';remote.shopSettings.intel.coupon=40;
 const result=helpers.rebaseHistorySnapshot(snapshot,sent,remote);assert.equal(result.conflict,false);assert.equal(result.snapshot.configs.length,1);assert.equal(result.snapshot.configs[0].name,'撤销前');assert.equal(result.snapshot.configs[0].parts[0].lineId,'line');assert.equal(result.snapshot.shopSettings,undefined);assert.equal(result.snapshot.logs,undefined);
 const restored=helpers.restoreHistorySnapshot(remote,result.snapshot);assert.equal(restored.configs[1].name,'其他编辑者');assert.equal(restored.shopSettings.intel.coupon,40);restored.configs[0].parts[0].qty=9;assert.equal(result.snapshot.configs[0].parts[0].qty,1);
});
test('局部历史同字段回执冲突或远端缺失目标时保守清栈',()=>{
 const sent=makeState(),earlier=structuredClone(sent);earlier.configs[0].price=9;const snapshot=helpers.captureConfigHistorySnapshot(earlier,ui(),['one']),remote=structuredClone(sent);remote.configs[0].price=12;
 assert.equal(helpers.rebaseHistorySnapshot(snapshot,sent,remote).conflict,true);remote.configs.shift();assert.equal(helpers.rebaseHistorySnapshot(snapshot,sent,remote).conflict,true);
});
test('完整历史保存回执归一化保留原顺序、新增撤销与全局数据',()=>{
 const before=makeState(),history=helpers.captureHistorySnapshot(before,ui()),sent=structuredClone(before);sent.configs.reverse();sent.configs.push(config('three'));const remote=structuredClone(sent);remote.configs[0].parts[0].lineId='line';
 const result=helpers.rebaseHistorySnapshot(history,sent,remote);assert.equal(result.conflict,false);assert.deepEqual(result.snapshot.configs.map(config=>config.id),['one','two']);assert.equal(result.snapshot.configs[1].parts[0].lineId,'line');assert.equal(result.snapshot.logs,undefined);
});
test('本次全局操作移除占位配置后，保留局部记录并允许先全局再局部撤销',()=>{
 const initial=makeState(),localEntry=helpers.captureConfigHistorySnapshot(initial,ui(),['one']);initial.configs[0].name='占位修改';const fullEntry=helpers.captureHistorySnapshot(initial,ui());
 const sent=structuredClone(initial);sent.configs=sent.configs.filter(config=>config.id!=='one');sent.configs.push(config('imported'));const remote=structuredClone(sent);remote.configs[0].parts[0].lineId='line';
 const local=helpers.rebaseHistorySnapshot(localEntry,sent,remote),full=helpers.rebaseHistorySnapshot(fullEntry,sent,remote);assert.equal(local.conflict,false);assert.equal(full.conflict,false);
 assert.throws(()=>helpers.restoreHistorySnapshot(remote,local.snapshot),/不存在/);const restored=helpers.restoreHistorySnapshot(remote,full.snapshot);assert.equal(restored.configs.find(config=>config.id==='one').name,'占位修改');const undone=helpers.restoreHistorySnapshot(restored,local.snapshot);assert.equal(undone.configs.find(config=>config.id==='one').name,'one');
});
test('实际acceptSavedState重基混合栈，并保留保存期间当前输入',()=>{
 const {context}=harness();const sent=structuredClone(context.state);context.scoped();row(context,'one').price=11;context.full();row(context,'two').name='飞行输入';const remote=structuredClone(sent);remote.configs[0].parts[0].lineId='line';
 Object.assign(context,{acceptedState:null,dirty:true});const accept=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'));Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(accept+'\nglobalThis.accept=acceptSavedState;',context);context.accept(sent,remote);
 assert.equal(row(context,'two').name,'飞行输入');assert.equal(context.history[0].historyScope,'configs');assert.equal(context.history[0].configs[0].parts[0].lineId,'line');assert.equal(context.history[1].configs[0].parts[0].lineId,'line');assert.equal(context.history[0].logs,undefined);
});
test('混合条目内存限制按每项真实bytes求和，次数仍保留30项限制',()=>{
 const {context}=harness();const large={marker:'x'.repeat(17*1024*1024)},small={marker:'small'};context.history.push(large,small);context.trim(context.history);assert.equal(context.history.length,1);assert.equal(context.history[0],small);
 context.history=Array.from({length:35},(_,id)=>({id}));context.trim(context.history);assert.equal(context.history.length,30);assert.equal(context.history[0].id,5);
});
test('单次递归快照保持JSON值/undefined语义，支持删除字段且只共享基线',()=>{
 const values=[{a:{b:1},rows:[{id:'one',value:0},null],unknown:undefined},{a:{b:2},rows:[{id:'two',value:null}],added:true},{a:null,rows:[],old:undefined}];
 for(const old of values)for(const value of values){const accepted=structuredClone(old),live=structuredClone(value),snapshot=helpers.captureEditorState(live,accepted);assert.ok(sameValue(snapshot,live));assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),JSON.parse(JSON.stringify(live)));if(live.a&&typeof live.a==='object'){live.a.b=7;assert.notEqual(snapshot.a,live.a);}}
});
test('入口审计：普通focus与海报采用显式局部，其余全局批量入口仍完整',()=>{
 assert.match(app,/input\.onfocus=\(\)=>checkpointConfig\(\)/);assert.match(app,/posterEditorConfig\(current\(\)\),checkpoint:\(\)=>checkpointConfig\(\)/);assert.match(app,/state\.shopSettings\[shop\.id\]\.coupon=value/);assert.match(app,/checkpoint\(\);state\.shopSettings\[shop\.id\]\.coupon/);assert.match(app,/checkpoint\(\);const ids=applyReplacement/);assert.match(app,/rememberDisplayParts\(restoringConfigIds\)/);assert.match(app,/rememberDisplayParts\(historyIds\)/);
});
