import {saveFullState} from '../../public/workbench/full-save.js';
import * as scopeHelpers from '../../public/workbench/scoped-save.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';
import * as historyHelpers from '../../public/workbench/editor-performance.js';
import {syncDisplayParts,cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,captureHistorySnapshot,historySnapshotBytes} from '../../public/workbench/editor-performance.js';
import {mergeEditingState,sameEditingState} from '../../public/workbench/workspace-ui-merge.js';

const config=id=>({id,name:id,parts:[{slot:'CPU',goodsId:'1',name:'展示CPU',qty:1,erp:null,stockAvailable:null}],actualParts:[{slot:'CPU',goodsId:'1',name:'实际CPU',qty:1,erp:null,stockAvailable:null}]});
const state=()=>({revision:1,configs:[config('one'),config('two')],templates:[],sourceCatalog:[{sourceId:'s',name:'源'}],costSource:[{goodsId:'1',tax:10}],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[{id:'old',extra:{keep:true}}],unknown:{keep:true}});
const ui={active:'one',activeShopId:'intel',selected:new Set(['one'])};
const baseline=rows=>new Map(rows.map(c=>[c.id,structuredClone(c.parts)]));

test('单配置同步仅访问目标行，批量、空范围及全库范围保留各自语义',()=>{
 const s=state(),before=baseline(s.configs);s.configs[0].parts[0].qty=2;s.configs[1].parts[0].qty=3;
 const untouched=before.get('two');syncDisplayParts(s.configs,before,['one','missing','one']);
 assert.equal(s.configs[0].actualParts[0].qty,2);assert.equal(s.configs[1].actualParts[0].qty,1);assert.equal(before.get('two'),untouched);
 syncDisplayParts(s.configs,before,[]);assert.equal(s.configs[1].actualParts[0].qty,1);
 syncDisplayParts(s.configs,before,['one','two']);assert.equal(s.configs[1].actualParts[0].qty,3);
 s.configs[1].parts[0].qty=4;syncDisplayParts(s.configs,before,null);assert.equal(s.configs[1].actualParts[0].qty,4);
});
test('说明、可见性、未知价格与库存不覆盖独立BOM；明确空BOM仍为空',()=>{
 const s=state(),before=baseline(s.configs);s.configs[0].parts[0].upgrade='升级';s.configs[0].parts[0].posterVisible=false;s.configs[1].actualParts=[];
 syncDisplayParts(s.configs,before,['one','two']);
 assert.equal(s.configs[0].actualParts[0].name,'实际CPU');assert.equal(s.configs[0].actualParts[0].erp,null);assert.equal(s.configs[0].actualParts[0].stockAvailable,null);assert.deepEqual(s.configs[1].actualParts,[]);
 s.configs[0].parts[0].qty=2;syncDisplayParts(s.configs,before,['one']);assert.equal(s.configs[0].actualParts[0].name,'实际CPU');
});
test('保存快照独立保存业务及未知字段，操作日志保持只读引用且不进入保存基线',()=>{
 const s=state(),sent=cloneEditorState(s);assert.equal(sent.logs,s.logs);s.configs[0].name='之后输入';s.unknown.keep=false;
 assert.equal(sent.configs[0].name,'one');assert.equal(sent.unknown.keep,true);assert.equal(withoutActivityLogs(sent).logs,undefined);assert.equal(s.logs.length,1);
});
test('增量快照只复用不可变基线，当前输入及未变字段后续输入不会污染它',()=>{
 const s=state(),accepted=cloneEditorState(s);s.configs[0].name='第一输入';const sent=captureEditorState(s,accepted);
 assert.equal(sent.configs[1],accepted.configs[1]);assert.equal(sent.costSource,accepted.costSource);assert.equal(sent.shopSettings,accepted.shopSettings);assert.notEqual(sent.configs[0],s.configs[0]);assert.notEqual(sent.configs[1],s.configs[1]);
 assert.equal(ordinarySaveChanges(accepted,sent).length,1);s.configs[0].name='第二输入';s.configs[1].parts[0].qty=9;s.shopSettings.intel.coupon=30;
 assert.equal(sent.configs[0].name,'第一输入');assert.equal(sent.configs[1].parts[0].qty,1);assert.equal(sent.shopSettings.intel.coupon,0);assert.equal(accepted.configs[0].name,'one');
});
test('增量快照完整捕获新增删除顺序及未知全局字段，未有基线时仍隔离',()=>{
 const s=state(),accepted=cloneEditorState(s);s.configs.push(config('three'));s.configs[1].deletedAt='today';s.configs.reverse();s.unknown.keep=false;s.costSource[0].tax=12;
 const sent=captureEditorState(s,accepted);assert.deepEqual(sent.configs.map(c=>c.id),['three','two','one']);assert.equal(sent.configs[1].deletedAt,'today');assert.equal(sent.unknown.keep,false);assert.equal(ordinarySaveChanges(accepted,sent),null);
 s.configs[0].parts[0].qty=8;s.costSource[0].tax=13;assert.equal(sent.configs[0].parts[0].qty,1);assert.equal(sent.costSource[0].tax,12);assert.equal(accepted.costSource[0].tax,10);
 const first=captureEditorState(s,null);s.configs[0].name='之后';assert.equal(first.configs[0].name,'three');
});
test('保存回执保留飞行期间的新输入与日志，真正同字段远端修改仍冲突',()=>{
 const sent=state(),live=cloneEditorState(sent),remote=cloneEditorState(sent);sent.configs[0].price=10;live.configs[0].price=12;remote.configs[0].price=10;remote.logs=[{id:'new'},...sent.logs];
 const result=mergeEditorState(sent,live,remote);assert.equal(result.conflict,false);assert.equal(result.state.configs[0].price,12);assert.equal(result.state.logs,remote.logs);assert.deepEqual(sent.logs,[{id:'old',extra:{keep:true}}]);
 remote.configs[0].price=13;assert.equal(mergeEditorState(sent,live,remote).conflict,true);
});
test('历史未变行仅复用早期快照，当前与后续编辑均不能污染它',()=>{
 const s=state(),first=captureHistorySnapshot(s,ui);assert.notEqual(first.configs[0],s.configs[0]);
 assert.equal(captureHistorySnapshot(s,ui,first),first);s.configs[0].name='新名称';
 const second=captureHistorySnapshot(s,ui,first);assert.notEqual(second.configs[0],first.configs[0]);assert.equal(second.configs[1],first.configs[1]);assert.equal(second.costSource,first.costSource);assert.equal(first.configs[0].name,'one');
 s.configs[1].parts[0].qty=9;assert.equal(second.configs[1].parts[0].qty,1);
});
test('历史包含新增、删除、顺序及全局编辑；大小缓存与原JSON限制相同',()=>{
 const s=state(),first=captureHistorySnapshot(s,ui);s.configs.push(config('three'));s.configs[1].deletedAt='today';s.configs.reverse();s.shopSettings.intel.coupon=20;
 const next=captureHistorySnapshot(s,ui,first);assert.deepEqual(next.configs.map(c=>c.id),['three','two','one']);assert.equal(next.configs[1].deletedAt,'today');assert.equal(first.configs.length,2);assert.equal(first.configs[1].deletedAt,undefined);assert.equal(first.shopSettings.intel.coupon,0);
 for(const value of [first,next,{empty:[],nested:{unknown:undefined},values:[null,undefined,'中文',12,true]}])assert.equal(historySnapshotBytes(value),JSON.stringify(value).length*2);
});
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// These VM fixtures exercise the legacy complete-workspace branch. Compact
// eviction is tested independently; it must not schedule work after a VM test.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
const receiptCode=app.slice(app.indexOf('async function savedReceiptState('),app.indexOf('async function recoverySnapshot('));
test('实际普通增量保存不先比较完整草稿，两次并发调用与飞行输入共用请求且后续单独保存',async()=>{
 const s=state(),requests=[],nodes=new Map();let resolveFirst;
 const context={...fullBranch,saveFullState,...historyHelpers,state:s,acceptedState:cloneEditorState(s),dirty:true,conflict:false,savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,operator:'test',changed:{message:'修改名称'},history:[],redoHistory:[],cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,mergeEditingState,ordinarySaveChanges,sourceCatalog:x=>x,syncHistoryButtons(){},trimHistory(){},renderAll(){},pollDerivedStatus:()=>Promise.resolve(),scheduleImageSave(){},toast(){},crypto:{randomUUID},$:(id)=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 context.sameEditingState=(a,b)=>{assert.ok(requests.length>0,'新的快照在请求前无需再比较完整草稿');return sameEditingState(a,b);};
 context.request=async(url,options)=>{
  assert.equal(url,'/api/configs/batch');const payload=JSON.parse(options.body);requests.push(payload);
  const receipt={configs:payload.changes.map(c=>c.after),revision:requests.length+1,updatedAt:'2026-10-12T00:00:00Z',activityDelta:[{id:`log-${requests.length}`}],rebased:false};
  if(requests.length===1)return new Promise(resolve=>resolveFirst=()=>resolve(receipt));return receipt;
 };
 const code=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function sendBatchPending('));Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(receiptCode+code+'\nglobalThis.run=save;',context);
 context.state.configs[0].name='第一输入';const first=context.run(),second=context.run();assert.equal(requests.length,1);
 const pending=context.ordinaryPending;assert.equal(pending.sent.costSource,context.acceptedState.costSource);assert.notEqual(pending.sent.configs[1],context.state.configs[1]);
 context.state.configs[1].name='飞行输入';context.dirty=true;resolveFirst();await Promise.all([first,second]);
 assert.deepEqual(requests.map(p=>p.changes.map(c=>c.id)),[['one'],['two']]);assert.notEqual(requests[0].operationId,requests[1].operationId);assert.equal(context.acceptedState.configs[1].name,'飞行输入');assert.equal(context.state.configs[1].name,'飞行输入');assert.equal(context.dirty,false);
 context.state.configs[0].parts[0].qty=7;assert.equal(context.acceptedState.configs[0].parts[0].qty,1);assert.equal(pending.sent.configs[0].parts[0].qty,1);
});
test('实际changed入口传递所编辑ID，实际checkpoint及跨配置撤销不污染共享快照',()=>{
 assert.match(app,/syncDisplayEdits\(ids\)/);assert.doesNotMatch(app,/syncDisplayEdits\(message/);
 const code=app.slice(app.indexOf('function historySnapshot(){'),app.indexOf('function visiblePosterInput('));
 const s=state(),context={...fullBranch,...historyHelpers,state:s,...ui,history:[],redoHistory:[],captureHistorySnapshot,historySnapshotBytes,sameEditingState,clone:structuredClone,$:()=>({disabled:false}),localStorage:{setItem(){}},sourceCatalog:x=>x,costRows:(_,x)=>x,bindSources(){},alignDisplaySourceNames(){},available:()=>context.state.configs,changed(){},renderAll(){},restoringHistory:false,posterEditor:null};
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(receiptCode+code+'\nglobalThis.check=checkpoint;globalThis.undo=()=>stepHistory(history,redoHistory,"undo");globalThis.redo=()=>stepHistory(redoHistory,history,"redo");',context);
 context.check();context.state.configs[0].name='第一修改';context.active='two';context.check();context.state.configs[1].name='第二修改';context.undo();
 assert.equal(context.state.configs[0].name,'第一修改');assert.equal(context.state.configs[1].name,'two');context.state.configs[0].parts[0].qty=8;
 assert.equal(context.history[0].configs[0].parts[0].qty,1);assert.equal(context.redoHistory[0].configs[0].parts[0].qty,1);
 context.redo();assert.equal(context.state.configs[1].name,'第二修改');assert.equal(context.state.configs[0].parts[0].qty,1);
});
test('实际回执重基更新撤销栈，历史内不复制服务器日志',()=>{
 const sent=state(),remote=cloneEditorState(sent),live=cloneEditorState(sent);remote.configs[0].parts[0].lineId='new-line';live.configs[1].name='飞行输入';
 const earlier=cloneEditorState(sent);earlier.configs[0].price=1;const history=[captureHistorySnapshot(earlier,ui)];
 const context={...fullBranch,saveFullState,...historyHelpers,state:live,acceptedState:null,history,redoHistory:[],cloneEditorState,withoutActivityLogs,mergeEditorState,mergeEditingState,sameEditingState,syncHistoryButtons(){},trimHistory(){},sourceCatalog:x=>x,dirty:true};
 const code=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'));
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(receiptCode+code+'\nglobalThis.accept=acceptSavedState;',context);context.accept(sent,remote);
 assert.equal(context.state.configs[1].name,'飞行输入');assert.equal(context.state.configs[0].parts[0].lineId,'new-line');assert.equal(context.history[0].configs[0].price,1);assert.equal(context.history[0].configs[0].parts[0].lineId,'new-line');assert.equal(context.history[0].logs,undefined);assert.equal(context.acceptedState.logs,remote.logs);
 context.state.configs[0].parts[0].qty=9;assert.equal(context.acceptedState.configs[0].parts[0].qty,1);assert.equal(context.history[0].configs[0].parts[0].qty,1);
});
test('相同编辑回执无需再复制基线，继续输入仍与回执隔离',()=>{
 const sent=state(),live=cloneEditorState(sent),remote=cloneEditorState(sent),context={...fullBranch,state:live,acceptedState:null,sameEditingState};
 const code=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'));
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(receiptCode+code+'\nglobalThis.accept=acceptSavedState;',context);context.accept(sent,remote);
 assert.equal(context.acceptedState,remote);assert.equal(context.state,live);context.state.configs[0].parts[0].qty=4;context.state.shopSettings.intel.coupon=30;
 assert.equal(context.acceptedState.configs[0].parts[0].qty,1);assert.equal(context.acceptedState.shopSettings.intel.coupon,0);
});
test('实际完整保存不提交归档日志，响应等待期间输入继续保存且业务快照独立',async()=>{
 const s=state(),nodes=new Map(),requests=[];
 // A function would fail structuredClone: it demonstrates that no business
 // snapshot, accepted baseline or merge traverses the activity archive.
 s.logs[0].notCloneable=()=>{};
 const context={...fullBranch,saveFullState,...historyHelpers,state:s,acceptedState:cloneEditorState(s),dirty:true,conflict:false,savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,operator:'test',changed:{message:'修改模块'},history:[],redoHistory:[],cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,mergeEditingState,sameEditingState,ordinarySaveChanges:()=>null,sourceCatalog:x=>x,syncHistoryButtons(){},trimHistory(){},renderAll(){},pollDerivedStatus:()=>Promise.resolve(),scheduleImageSave(){},toast(){},$:(id)=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 context.request=async(url,options)=>{
  assert.equal(url,'/api/state');const payload=JSON.parse(options.body);requests.push(payload);assert.equal(Object.hasOwn(payload.baseState,'logs'),false);
  if(requests.length===1){context.state.configs[0].name='第二次输入';context.dirty=true;}
  const remote={...payload.baseState,configs:payload.configs,revision:requests.length+1,updatedAt:'2026-10-12T00:00:00Z',logs:s.logs};
  return {state:remote,revision:remote.revision,updatedAt:remote.updatedAt,logs:remote.logs};
 };
 const code=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function sendBatchPending('));
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(receiptCode+code+'\nglobalThis.run=save;',context);context.state.configs[0].name='第一次输入';await context.run();
 assert.deepEqual(requests.map(p=>p.configs[0].name),['第一次输入','第二次输入']);assert.equal(context.state.configs[0].name,'第二次输入');assert.equal(context.acceptedState.configs[0].name,'第二次输入');assert.equal(context.acceptedState.logs,s.logs);assert.equal(context.dirty,false);
});
