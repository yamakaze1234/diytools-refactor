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
test('全量历史压缩包含其他撤销步骤涉及的配置，往返修改不能丢撤销',()=>{
 const state=makeState(),first=helpers.captureHistorySnapshot(state,ui());
 state.configs[0].name='middle';const middle=helpers.captureConfigHistorySnapshot(state,ui(),['one']);state.configs[0].name='one';
 const stacks=helpers.compactConfigHistory([[first,middle],[]],state);assert(stacks);
 assert.equal(stacks[0][0].configs[0].name,'one');assert.equal(stacks[0][0].configs.length,1);
 const undo1=helpers.restoreHistorySnapshot(state,stacks[0][1]);assert.equal(undo1.configs[0].name,'middle');
 const undo2=helpers.restoreHistorySnapshot(undo1,stacks[0][0]);assert.equal(undo2.configs[0].name,'one');
 for(const change of [s=>s.configs.reverse(),s=>s.configs.pop(),s=>s.shopSettings.intel.coupon++]){
  const changed=structuredClone(state);change(changed);const compressed=helpers.compactConfigHistory([[first],[]],changed)[0][0];
  assert.equal(compressed.historyScope,'workspace');assert(sameEditingState(helpers.restoreHistorySnapshot(changed,compressed),state));
 }
});
test('全局排序与公共资料撤销不保留无变化配置，按需补全后可往返恢复',async()=>{
 const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());state.configs.reverse();state.shopSettings.intel.coupon=88;
 const history=helpers.compactConfigHistory([[before],[]],state)[0];assert.equal(history[0].configs.length,0);assert.deepEqual(Object.keys(history[0].globals),['shopSettings']);
 const {context,calls}=compactHarness(state,['one'],history);context.ensureFullWorkspace=async()=>{calls.hydrated=true;context.state=structuredClone(state);context.fullWorkspace=true;};
 await context.undo();assert(calls.hydrated);assert.deepEqual(Array.from(context.state.configs,c=>c.id),['one','two']);assert.equal(context.state.shopSettings.intel.coupon,0);
 assert.equal(context.redoHistory[0].configs.length,0);await context.redo();assert.deepEqual(Array.from(context.state.configs,c=>c.id),['two','one']);assert.equal(context.state.shopSettings.intel.coupon,88);
});
test('全局增删压缩保留缺失配置正文，撤销与重做不会丢新增或已删除项',async()=>{
 for(const modify of [s=>s.configs.pop(),s=>s.configs.push(config('three'))]){
  const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());modify(state);
  const entry=helpers.compactConfigHistory([[before],[]],state)[0][0],opposite=helpers.captureWorkspaceHistorySnapshot(state,ui(),entry);
  const restored=helpers.restoreHistorySnapshot(state,entry);assert.deepEqual(restored.configs,makeState().configs);
  assert.deepEqual(helpers.restoreHistorySnapshot(restored,opposite).configs,state.configs);
 }
});
test('压缩全局撤销在局部保存后保留公共资料和未加载的变动配置，并合入远端非冲突字段',()=>{
 const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());state.configs[1].price=20;state.shopSettings.intel.coupon=30;
 const entry=helpers.compactConfigHistory([[before],[]],state)[0][0];
 const sent={...structuredClone(state),configs:[structuredClone(state.configs[0])]},remote=structuredClone(sent);remote.configs[0].name='其他配置修改';
 const rebased=helpers.rebaseHistorySnapshot(entry,sent,remote);assert.equal(rebased.conflict,false);assert.equal(rebased.snapshot.configs[0].price,10);
 const full={...state,configs:[remote.configs[0],state.configs[1]]},restored=helpers.restoreHistorySnapshot(full,rebased.snapshot);
 assert.equal(restored.shopSettings.intel.coupon,0);assert.equal(restored.configs[0].name,'其他配置修改');assert.equal(restored.configs[1].price,10);
 const allRemote=structuredClone(state);allRemote.configs[1].name='云端非重叠字段';
 const refreshed=helpers.rebaseHistorySnapshot(entry,state,allRemote);assert.equal(refreshed.conflict,false);assert.equal(refreshed.snapshot.configs[0].name,'云端非重叠字段');
 allRemote.shopSettings.intel.coupon=99;assert.equal(helpers.rebaseHistorySnapshot(entry,state,allRemote).conflict,true);
});
test('按需刷新后补全全局历史，保留未加载配置远端字段和远端新增项',()=>{
 const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());state.configs[1].price=20;state.shopSettings.intel.coupon=30;
 let entry=helpers.compactConfigHistory([[before],[]],state)[0][0];
 const partial={...structuredClone(state),configs:[structuredClone(state.configs[0])]};
 entry=helpers.rebaseHistorySnapshot(entry,partial,partial).snapshot;
 const remote=structuredClone(state);remote.configs[1].name='远端名称';remote.configs.push(config('remote-added'));
 const rebased=helpers.rebaseWorkspaceHistorySnapshot(entry,remote);assert.equal(rebased.conflict,false);
 const restored=helpers.restoreHistorySnapshot(remote,rebased.snapshot);
 assert.equal(restored.configs[1].name,'远端名称');assert.equal(restored.configs[1].price,10);assert(restored.configs.some(c=>c.id==='remote-added'));
 const overlapping=structuredClone(remote);overlapping.configs[1].price=99;assert.equal(helpers.rebaseWorkspaceHistorySnapshot(entry,overlapping).conflict,true);
});
test('混合局部与全局栈补全后连续撤销不覆盖未加载配置的远端字段',()=>{
 const state=makeState(),local=helpers.captureConfigHistorySnapshot(state,ui(),['two']);state.configs[1].price=20;
 const global=helpers.captureHistorySnapshot(state,ui());state.shopSettings.intel.coupon=1;
 const stack=helpers.compactConfigHistory([[local,global],[]],state)[0],partial={...state,configs:[state.configs[0]]};
 const refreshed=stack.map(item=>helpers.rebaseHistorySnapshot(item,partial,partial).snapshot),remote=structuredClone(state);remote.configs[1].name='云端名称';
 const rebased=refreshed.map(item=>helpers.rebaseWorkspaceHistorySnapshot(item,remote));assert(rebased.every(item=>!item.conflict));
 const undoGlobal=helpers.restoreHistorySnapshot(remote,rebased[1].snapshot),undoLocal=helpers.restoreHistorySnapshot(undoGlobal,rebased[0].snapshot);
 assert.equal(undoLocal.configs[1].name,'云端名称');assert.equal(undoLocal.configs[1].price,10);assert.equal(undoLocal.shopSettings.intel.coupon,0);
});
test('本地全局移除配置后补全不误判远端删除，仍可先恢复再撤销局部编辑',()=>{
 const state=makeState(),local=helpers.captureConfigHistorySnapshot(state,ui(),['two']);state.configs[1].price=20;
 const global=helpers.captureHistorySnapshot(state,ui());state.configs.pop();
 const stack=helpers.compactConfigHistory([[local,global],[]],state)[0];assert.deepEqual(stack[0].baseline.configs,[]);
 const rebased=stack.map(item=>helpers.rebaseWorkspaceHistorySnapshot(item,state));assert(rebased.every(item=>!item.conflict));
 const restored=helpers.restoreHistorySnapshot(state,rebased[1].snapshot);assert.equal(restored.configs[1].price,20);
 assert.equal(helpers.restoreHistorySnapshot(restored,rebased[0].snapshot).configs[1].price,10);
});
function harness(state=makeState()){
 const calls={changed:[],bound:[],aligned:[],rendered:[]};
 const context={...fullBranch,...helpers,...ui(),state,history:[],redoHistory:[],sameEditingState,mergeEditingState,clone:structuredClone,restoringHistory:false,posterEditor:null,catalog:state.sourceCatalog,$:()=>({disabled:false}),localStorage:{setItem(){}},sourceCatalog:rows=>rows,costRows:(_,rows)=>rows,bindSources:rows=>calls.bound.push(rows.map(row=>row.id)),alignDisplaySourceNames:rows=>calls.aligned.push(rows.map(row=>row.id)),available:()=>context.state.configs.filter(config=>!config.deletedAt),changed:(message,ids)=>calls.changed.push({message,ids}),renderAll:ids=>calls.rendered.push(ids)};
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(historyCode+'\nglobalThis.full=checkpoint;globalThis.scoped=checkpointConfig;globalThis.undo=()=>stepHistory(history,redoHistory,"undo");globalThis.redo=()=>stepHistory(redoHistory,history,"redo");globalThis.trim=trimHistory;',context);
 return {context,calls};
}
const row=(context,id)=>context.state.configs.find(config=>config.id===id);

function compactHarness(fullState,loadedIds,history,active='one'){
 const {context,calls}=harness({...structuredClone(fullState),configs:structuredClone(fullState.configs.filter(row=>loadedIds.includes(row.id)))});
 context.fullWorkspace=false;context.history=history;context.active=active;context.selected=new Set([active]);context.acceptedState=structuredClone(context.state);
 context.lazyWorkspace={index:()=>({summaries:fullState.configs.map(row=>({id:row.id}))})};calls.loaded=[];
 context.loadDetail=async id=>{if(row(context,id))return;calls.loaded.push(id);const detail=fullState.configs.find(row=>row.id===id);assert.ok(detail);context.state.configs.push(structuredClone(detail));context.acceptedState.configs.push(structuredClone(detail));};
 return {context,calls};
}

test('压缩后的全量撤销同时加载变化配置与原活动项，保持编辑页面',async()=>{
 const state=makeState();state.configs.push(config('three'));
 const before=helpers.captureHistorySnapshot(state,ui());state.configs[1].price=20;
 const history=helpers.compactConfigHistory([[before],[]],state)[0];assert.deepEqual(history[0].configs.map(row=>row.id),['two']);
 const {context,calls}=compactHarness(state,['three'],history,'three');await context.undo();
 assert.deepEqual(calls.loaded,['two','one']);assert.equal(context.active,'one');assert.ok(row(context,context.active));assert.equal(row(context,'two').price,10);assert.equal(context.redoHistory.length,1);
 await context.redo();assert.equal(row(context,'two').price,20);assert.equal(context.active,'three');
});

test('跳过无变化聚焦记录后继续加载下个压缩撤销项，不丢失修改',async()=>{
 const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());state.configs[1].price=20;
 const noop=helpers.captureConfigHistorySnapshot(state,ui(),['one']);
 const history=helpers.compactConfigHistory([[before,noop],[]],state)[0];
 const {context,calls}=compactHarness(state,['one'],history);await context.undo();
 assert.deepEqual(calls.loaded,['two']);assert.equal(row(context,'two').price,10);assert.equal(context.history.length,0);assert.equal(context.redoHistory.length,1);
 await context.redo();assert.equal(row(context,'two').price,20);
});

test('压缩撤销详情加载失败保留栈及草稿，重试仍可恢复',async()=>{
 const state=makeState(),before=helpers.captureHistorySnapshot(state,ui());state.configs[1].price=20;
 const history=helpers.compactConfigHistory([[before],[]],state)[0],entry=history[0];
 const {context}=compactHarness(state,['one'],history),load=context.loadDetail;
 context.loadDetail=async id=>{if(id==='two')throw Error('网络中断');return load(id);};
 await assert.rejects(context.undo(),/网络中断/);assert.equal(context.history.length,1);assert.equal(context.history[0],entry);assert.equal(context.redoHistory.length,0);assert.equal(context.active,'one');assert.equal(row(context,'two'),undefined);
 context.loadDetail=load;await context.undo();assert.equal(row(context,'two').price,10);assert.equal(context.history.length,0);assert.equal(context.redoHistory.length,1);
});

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
 const {context}=harness(),baseline=[];Object.assign(context,{acceptedState:null,dirty:false,changeCounter:0,pendingImages:new Set(),imageRecords:new Map(),timer:null,imageTimer:null,conflict:false,batchPromise:null,current:()=>row(context,context.active),document:{querySelector:()=>null},rememberDisplayParts:ids=>baseline.push(ids),visiblePosterInput:value=>JSON.stringify(value),updateHeading(){},updateSummary(){},refreshCurrentListPart(){},schedulePreview(){},setTimeout:()=>1,clearTimeout(){},suggestedName(){throw Error('不应重算已恢复简称');},$:(id)=>({disabled:false,textContent:'',classList:{add(){}}})});
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
