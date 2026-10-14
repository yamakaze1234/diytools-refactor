import {saveFullState} from '../../public/workbench/full-save.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as scopes from '../../public/workbench/scoped-save.js';
import * as editor from '../../public/workbench/editor-performance.js';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';
import {sameEditingState,mergeEditingState} from '../../public/workbench/workspace-ui-merge.js';

const make=()=>({revision:1,updatedAt:'2026-10-12T00:00:00Z',configs:['one','two'].map(id=>({id,name:id,price:10,parts:[{slot:'CPU',goodsId:'1',qty:1}],actualParts:[],posterDesignVersion:1})),templates:[],sourceCatalog:[],costSource:[{goodsId:'1',tax:10}],caseGallery:[],shopSettings:{intel:{coupon:0}},unknown:{keep:true},logs:[]});
function setup(){const base=make(),live=editor.cloneEditorState(base);return {base,live};}
function confirm(live,base){const snapshot=scopes.captureSaveSnapshot(live,base);scopes.acknowledgeSaveScope(live,base,snapshot,false);return snapshot;}
function edit(live,base,id,value){scopes.declareSaveScope(live,base,[id]);live.configs.find(row=>row.id===id).name=value;scopes.changeSaveScope(live,base,[id]);}

test('默认全量捕获归一差异，确认后只捕获声明目标；快照不共享可编辑草稿',()=>{
 const {base,live}=setup();live.costSource[0].normalized=true;live.configs[1].actualParts=[{slot:'CPU'}];edit(live,base,'one','input');
 const first=scopes.captureSaveSnapshot(live,base);assert.equal(scopes.saveSnapshotIds(first),null);assert.equal(first.costSource[0].normalized,true);assert.equal(first.configs[1].actualParts.length,1);
 const accepted=editor.cloneEditorState(first);scopes.acknowledgeSaveScope(live,accepted,first,false);edit(live,accepted,'one','next');
 const next=scopes.captureSaveSnapshot(live,accepted);assert.deepEqual(scopes.saveSnapshotIds(next),['one']);assert.equal(next.configs[1],accepted.configs[1]);assert.equal(next.costSource,accepted.costSource);assert.notEqual(next.configs[0],live.configs[0]);
 live.configs[0].parts[0].qty=9;live.configs[1].parts[0].qty=8;assert.equal(next.configs[0].parts[0].qty,1);assert.equal(next.configs[1].parts[0].qty,1);
});
test('全局变更full保持粘性；后续focus声明不能隐去全局或未知字段',()=>{
 const {base,live}=setup();confirm(live,base);scopes.invalidateSaveScope(live,'shop coupon');live.shopSettings.intel.coupon=20;live.unknown.keep=false;edit(live,base,'one','local');
 const snapshot=scopes.captureSaveSnapshot(live,base);assert.equal(scopes.saveSnapshotIds(snapshot),null);assert.equal(snapshot.shopSettings.intel.coupon,20);assert.equal(snapshot.unknown.keep,false);assert.equal(ordinarySaveChanges(base,snapshot),null);
});
test('changed空IDs、未声明target与基线替换均回退完整捕获',()=>{
 for(const trigger of ['global','undeclared','base']){const {base,live}=setup();confirm(live,base);scopes.declareSaveScope(live,base,['one']);
  live.configs[1].name='unannounced';scopes.changeSaveScope(live,trigger==='base'?editor.cloneEditorState(base):base,trigger==='global'?[]:['two']);
  const snapshot=scopes.captureSaveSnapshot(live,base);assert.equal(scopes.saveSnapshotIds(snapshot),null);assert.equal(snapshot.configs[1].name,'unannounced');
 }
});
test('恶意未声明unknown字段写入声明目标不会丢失：普通API拒绝后完整payload保留',()=>{
 const {base,live}=setup();confirm(live,base);edit(live,base,'one','input');live.configs[0].unknownNew={nested:'keep'};
 const snapshot=scopes.captureSaveSnapshot(live,base);assert.deepEqual(scopes.saveSnapshotIds(snapshot),['one']);assert.equal(ordinarySaveChanges(base,snapshot,scopes.saveSnapshotIds(snapshot)),null);assert.equal(snapshot.configs[0].unknownNew.nested,'keep');
 // Scope certification covers explicit editor entry points. Arbitrary nested
 // mutation outside declared targets is a contract violation, not detected.
});
test('配置新增删除排序、ID变化、未声明row替换及全局引用替换防御性回退',()=>{
 const mutations=[s=>s.configs.push({id:'three'}),s=>s.configs.pop(),s=>s.configs.reverse(),s=>s.configs[1].id='evil',s=>s.configs[1]={...s.configs[1],name:'replace'},s=>s.costSource=[...s.costSource],s=>s.newGlobal={nested:true}];
 for(const mutate of mutations){const {base,live}=setup();confirm(live,base);edit(live,base,'one','input');mutate(live);const snapshot=scopes.captureSaveSnapshot(live,base);assert.equal(scopes.saveSnapshotIds(snapshot),null);assert.deepEqual(snapshot.configs,live.configs);assert.deepEqual(snapshot.newGlobal,live.newGlobal);}
});
test('回执ack前失效generation不能恢复clean；回执后仍聚焦可继续捕获',()=>{
 const {base,live}=setup();confirm(live,base);edit(live,base,'one','A');const a=scopes.captureSaveSnapshot(live,base),accepted=editor.cloneEditorState(a);
 scopes.acknowledgeSaveScope(live,accepted,a,false);assert.equal(scopes.saveScopeStatus(live).full,false);
 live.configs[0].name='B';scopes.changeSaveScope(live,accepted,['one']);const b=scopes.captureSaveSnapshot(live,accepted);assert.deepEqual(scopes.saveSnapshotIds(b),['one']);
 scopes.invalidateSaveScope(live,'renderAll normalization');scopes.acknowledgeSaveScope(live,editor.cloneEditorState(b),b,false);assert.equal(scopes.saveScopeStatus(live).full,true);
});
test('跨配置输入与同target飞行输入：ack只清掉已确认版本',()=>{
 const {base,live}=setup();confirm(live,base);edit(live,base,'one','A');const a=scopes.captureSaveSnapshot(live,base),accepted=editor.cloneEditorState(a);
 edit(live,base,'one','B');edit(live,base,'two','C');scopes.acknowledgeSaveScope(live,accepted,a,true);
 assert.deepEqual(scopes.saveScopeStatus(live).ids,['one','two']);const next=scopes.captureSaveSnapshot(live,accepted);assert.deepEqual(ordinarySaveChanges(accepted,next,scopes.saveSnapshotIds(next)).map(row=>row.id),['one','two']);assert.equal(a.configs[0].name,'A');
});
test('局部撤销显式转移scope；全局撤销与普通state替换默认全量',()=>{
 const {base,live}=setup();confirm(live,base);edit(live,base,'one','A');const local=editor.restoreHistorySnapshot(live,{historyScope:'configs',configs:[base.configs[0]]});
 scopes.transferSaveScope(live,local,base,['one']);scopes.changeSaveScope(local,base,['one']);assert.deepEqual(scopes.saveSnapshotIds(scopes.captureSaveSnapshot(local,base)),['one']);
 const global=editor.cloneEditorState(local);scopes.transferSaveScope(local,global,base,null);assert.equal(scopes.saveSnapshotIds(scopes.captureSaveSnapshot(global,base)),null);assert.equal(scopes.saveSnapshotIds(scopes.captureSaveSnapshot(editor.cloneEditorState(local),base)),null);
});

const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// These VM fixtures exercise the legacy complete-workspace branch. Compact
// eviction is tested independently; it must not schedule work after a VM test.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
const receiptCode=app.slice(app.indexOf('async function savedReceiptState('),app.indexOf('async function recoverySnapshot('));
function harness(){const {base,live}=setup(),nodes=new Map(),requests=[];
 const context={...fullBranch,saveFullState,...editor,...scopes,state:live,acceptedState:base,dirty:false,conflict:false,savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,changed:{message:'input'},operator:'test',history:[],redoHistory:[],sameEditingState,mergeEditingState,ordinarySaveChanges,crypto:{randomUUID},sourceCatalog:x=>x,syncHistoryButtons(){},trimHistory(){},renderAll(){},pollDerivedStatus:()=>Promise.resolve(),scheduleImageSave(){},toast(){},$:(id)=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 context.request=async(url,options)=>{const payload=JSON.parse(options.body);requests.push({url,payload});if(url==='/api/configs/batch')return {configs:payload.changes.map(row=>row.after),revision:requests.length+1,updatedAt:'2026-10-12T00:00:00Z',activityDelta:[],rebased:false};return {state:{...base,...payload,revision:requests.length+1,logs:[]},revision:requests.length+1,updatedAt:'2026-10-12T00:00:00Z',logs:[]};};
 vm.runInNewContext(receiptCode+app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function sendBatchPending('))+'\nglobalThis.run=save;',context);return {context,requests};
}
test('实际save无变化完整捕获也确认scope，随后普通输入实际走局部增量',async()=>{
 const {context:c,requests}=harness();c.dirty=true;await c.run();assert.equal(requests.length,0);assert.equal(scopes.saveScopeStatus(c.state).full,false);
 edit(c.state,c.acceptedState,'one','A');c.dirty=true;await c.run();assert.deepEqual(scopes.saveSnapshotIds(c.ordinaryPending?.sent),null);assert.equal(requests[0].url,'/api/configs/batch');assert.deepEqual(requests[0].payload.changes.map(row=>row.id),['one']);assert.equal(c.dirty,false);
 c.state.configs[0].name='B';scopes.changeSaveScope(c.state,c.acceptedState,['one']);c.dirty=true;await c.run();assert.equal(requests.length,2);assert.equal(requests[1].payload.changes[0].after.name,'B');
});
test('实际save飞行期间混入全局dirty，后续必走全量且保留新输入',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;let release;
 c.request=async(url,options)=>{const receipt=await send(url,options);if(requests.length===1)return new Promise(resolve=>release=()=>resolve(receipt));return receipt;};
 const saving=c.run();await new Promise(resolve=>setImmediate(resolve));scopes.invalidateSaveScope(c.state,'global edit during flight');c.state.shopSettings.intel.coupon=30;edit(c.state,c.acceptedState,'two','B');c.dirty=true;release();await saving;
 assert.deepEqual(requests.map(row=>row.url),['/api/configs/batch','/api/state']);assert.equal(requests[1].payload.shopSettings.intel.coupon,30);assert.equal(requests[1].payload.configs[1].name,'B');assert.equal(c.dirty,false);
});
test('实际save scoped响应丢失重试原operationId，期间继续输入新target单独保存',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;let fail=true;
 c.request=async(url,options)=>{const receipt=await send(url,options);if(fail){fail=false;throw Error('lost response');}return receipt;};
 await assert.rejects(c.run(),/lost response/);const retained=c.ordinaryPending.sent;assert.deepEqual(scopes.saveSnapshotIds(retained),['one']);edit(c.state,c.acceptedState,'two','B');c.dirty=true;await c.run();
 assert.deepEqual(requests[0].payload,requests[1].payload);assert.notEqual(requests[1].payload.operationId,requests[2].payload.operationId);assert.deepEqual(requests.map(row=>row.payload.changes.map(change=>change.id)),[['one'],['one'],['two']]);assert.equal(retained.configs[1].name,'two');assert.equal(c.dirty,false);
});
test('实际归一/未知入口源审计：renderAll、全baseline、globalcheckpoint、冲突和batch均显式失效',()=>{
 assert.match(app,/function renderAll\([^)]*\)\{if\(!fullWorkspace\)return renderCompact\(\);invalidateSaveScope\(state,'renderAll/);
 assert.match(app,/function rememberDisplayParts\(ids=null\)\{if\(ids===null\)invalidateSaveScope/);
 assert.match(app,/function checkpoint\(\)\{if\(!fullWorkspace\)throw Error\('[^']+'\);invalidateSaveScope/);
 assert.match(app,/preserveMetadata=false\)\{changeSaveScope\(state,acceptedState,ids\)/);
 for(const reason of ['conflict resolution draft','asynchronous batch request','batch request failure'])assert.ok(app.includes(reason));
});
test('未知顶层字段新增、删除与嵌套修改明确拒绝保存，保留dirty和草稿且不发送请求',async()=>{
 for(const mutate of [s=>s.newBusiness={secret:'keep'},s=>delete s.unknown,s=>s.unknown.keep=false]){
  const {context:c,requests}=harness();confirm(c.state,c.acceptedState);scopes.invalidateSaveScope(c.state,'unsupported root edit');mutate(c.state);c.dirty=true;
  const snapshot=scopes.captureSaveSnapshot(c.state,c.acceptedState);assert.equal(ordinarySaveChanges(c.acceptedState,snapshot),null);assert.equal(scopes.sameCapturedBusinessState(snapshot,c.acceptedState),false);
  await assert.rejects(c.run(),/保存协议不支持修改字段/);assert.equal(requests.length,0);assert.equal(c.dirty,true);assert.equal(c.savePromise,null);assert.ok(scopes.unsupportedSaveRootChanges(c.acceptedState,c.state).length);
 }
});
test('原请求重试成功后未知顶层修改仍dirty并拒绝第二次保存，不静默丢失',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;let fail=true;
 c.request=async(url,options)=>{const receipt=await send(url,options);if(fail){fail=false;throw Error('lost response');}return receipt;};
 await assert.rejects(c.run(),/lost response/);scopes.invalidateSaveScope(c.state,'unknown root during retry');c.state.unknown.keep=false;c.dirty=true;
 await assert.rejects(c.run(),/保存协议不支持修改字段/);assert.equal(requests.length,2);assert.deepEqual(requests[0].payload,requests[1].payload);assert.equal(c.dirty,true);assert.equal(c.state.unknown.keep,false);assert.equal(c.acceptedState.unknown.keep,true);
});
test('固定shop注册表/dataVersion归一只读，不阻止六集合保存；ERP标记差异仍明确拒绝',async()=>{
 const {context:c,requests}=harness();c.state.shops=[{id:'intel'}];c.state.dataVersion=3;c.dirty=true;await c.run();assert.equal(requests.length,0);assert.equal(c.dirty,false);
 edit(c.state,c.acceptedState,'one','A');c.dirty=true;await c.run();assert.equal(requests[0].url,'/api/configs/batch');
 scopes.invalidateSaveScope(c.state,'ERP marker changed');c.state.erpSync={updatedAt:'new'};c.dirty=true;await assert.rejects(c.run(),/erpSync/);assert.equal(c.dirty,true);assert.equal(requests.length,1);
});
test('实际归一回执替换草稿后scope回退full，物化字段与草稿/基线隔离',async()=>{
 const {context:c}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;
 c.request=async(url,options)=>{const receipt=await send(url,options);receipt.configs[0].parts[0].lineId='materialized';return receipt;};
 const old=c.state;await c.run();assert.notEqual(c.state,old);assert.equal(scopes.saveScopeStatus(c.state).full,true);assert.equal(c.state.configs[0].parts[0].lineId,'materialized');
 c.state.configs[0].parts[0].qty=5;assert.equal(c.acceptedState.configs[0].parts[0].qty,1);assert.equal(scopes.saveSnapshotIds(scopes.captureSaveSnapshot(c.state,c.acceptedState)),null);
});
test('实际rebased回执读取远端全状态，合并其他配置及全局数据且保留飞行输入',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;let release;
 c.request=async(url,options)=>{
  if(url==='/api/state?logs=none'&&!options){const remote=editor.cloneEditorState(c.acceptedState);remote.configs[0].name='A';remote.configs[1].name='external';remote.shopSettings.intel.coupon=20;remote.revision=2;return remote;}
  const receipt=await send(url,options);if(requests.length===1){receipt.rebased=true;return new Promise(resolve=>release=()=>resolve(receipt));}return receipt;
 };
 const saving=c.run();await new Promise(resolve=>setImmediate(resolve));edit(c.state,c.acceptedState,'one','B');c.dirty=true;release();await saving;
 assert.equal(c.state.configs[0].name,'B');assert.equal(c.state.configs[1].name,'external');assert.equal(c.state.shopSettings.intel.coupon,20);assert.equal(c.dirty,false);assert.equal(requests.length,2);
});
test('实际scoped同字段远端冲突保留飞行草稿，清请求后阻止自动保存',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);edit(c.state,c.acceptedState,'one','A');c.dirty=true;const send=c.request;let release;c.openConflict=()=>{};
 c.request=async(url,options)=>{
  if(url==='/api/state?logs=none'&&!options){const remote=editor.cloneEditorState(c.acceptedState);remote.configs[0].name='external';remote.revision=2;return remote;}
  const receipt=await send(url,options);receipt.rebased=true;return new Promise(resolve=>release=()=>resolve(receipt));
 };
 const saving=c.run();await new Promise(resolve=>setImmediate(resolve));edit(c.state,c.acceptedState,'one','B');c.dirty=true;release();await assert.rejects(saving,error=>error.status===409);
 assert.equal(c.state.configs[0].name,'B');assert.equal(c.acceptedState.configs[0].name,'external');assert.equal(c.conflict,true);assert.equal(c.dirty,true);assert.equal(c.ordinaryPending,null);assert.equal(requests.length,1);
});
test('已确认clean后只有direct dirty而没有tracked changed，捕获回退full且实际修改保存',async()=>{
 const {context:c,requests}=harness();confirm(c.state,c.acceptedState);c.state.configs[1].name='direct dirty edit';c.dirty=true;
 const snapshot=scopes.captureSaveSnapshot(c.state,c.acceptedState);assert.equal(scopes.saveSnapshotIds(snapshot),null);assert.equal(scopes.saveScopeStatus(c.state).reason,'capture without tracked edits');
 await c.run();assert.equal(requests.length,1);assert.equal(requests[0].payload.changes[0].after.name,'direct dirty edit');assert.equal(c.acceptedState.configs[1].name,'direct dirty edit');assert.equal(c.dirty,false);
});
