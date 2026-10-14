import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as editor from '../../public/workbench/editor-performance.js';
import {sameEditingState,sameEditingStateAsync,mergeEditingState,mergeEditingStateAsync} from '../../public/workbench/workspace-ui-merge.js';
import {normalizeWorkspaceState,normalizeWorkspaceStateAsync} from '../../public/workbench/shops.js';
import {prepareWorkspaceState} from '../../public/workbench/workspace-state-apply.js';
import * as scope from '../../public/workbench/scoped-save.js';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';
import {randomUUID} from 'node:crypto';

const row=id=>({id,name:id,shopId:'intel',product:'测试链接',parts:[{slot:'CPU',goodsId:'1',name:'CPU',qty:1,stockAvailable:null}],actualParts:[],modules:[],unknown:{nested:[null,1.125]}});
const state=(count=3)=>({revision:1,configs:Array.from({length:count},(_,i)=>row(`c${i}`)),templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[{id:'archive'}],unknownRoot:{keep:'原值'}});
const options={budgetMs:0,yieldWork:async()=>{}};
const ui={active:'c0',activeShopId:'intel',selected:new Set(['c0'])};

test('分片合并与同步契约一致：精确值、未知字段、新增删除顺序、并发冲突、缺失/null库存',async()=>{
 const before=state(),local=structuredClone(before),remote=structuredClone(before);
 local.configs[0].name='飞行输入';remote.configs[0].parts[0].lineId='server-line';
 local.configs[1].price=12.125;remote.configs[1].price=13.25;
 remote.configs=remote.configs.filter(c=>c.id!=='c2');local.configs.push(row('new'));
 remote.unknownRoot.extra={exact:0.12345};delete before.configs[0].parts[0].stockAvailable;
 const sync=mergeEditingState(before,local,remote),asyncResult=await mergeEditingStateAsync(before,local,remote,options);
 assert.deepEqual(asyncResult,sync);assert.equal(asyncResult.conflict,true);
 assert.deepEqual(asyncResult.state.configs.map(c=>c.id),['c0','c1','new']);
 assert.equal(asyncResult.state.configs[0].name,'飞行输入');assert.equal(asyncResult.state.configs[0].parts[0].lineId,'server-line');
 asyncResult.state.unknownRoot.extra.exact=0;assert.equal(remote.unknownRoot.extra.exact,0.12345);
 asyncResult.state.configs[0].unknown.nested[1]=0;assert.equal(local.configs[0].unknown.nested[1],1.125);
});
test('分片相等检查保持对象键顺序无关、数组顺序与缺失字段语义',async()=>{
 const a=state(),b=structuredClone(a);b.configs[0]={unknown:b.configs[0].unknown,...b.configs[0],extra:undefined};
 assert.equal(await sameEditingStateAsync(a,b,options),sameEditingState(a,b));
 b.configs.reverse();assert.equal(await sameEditingStateAsync(a,b,options),false);
});
test('回执物化期间未知顶层输入仍保留，后续保存协议拒绝它而不静默丢字段',async()=>{
 const sent=state(),live=structuredClone(sent),remote=structuredClone(sent);live.unknownRoot.keep='未支持的新输入';remote.configs[0].parts[0].lineId='server';
 for(const result of [editor.mergeEditorState(sent,live,remote),await editor.mergeEditorStateAsync(sent,live,remote,options)]){
  assert.equal(result.state.unknownRoot.keep,'未支持的新输入');assert.equal(result.conflict,false);
  result.state.unknownRoot.keep='之后编辑';assert.equal(live.unknownRoot.keep,'未支持的新输入');assert.equal(remote.unknownRoot.keep,'原值');
 }
});
test('异步归一与同步结果一致，只读日志不复制，配置/BOM/模板/来源/未知字段仍隔离',async()=>{
 const input=state();input.templates=[{id:'t',configs:[row('template')],unknown:{keep:true}}];
 input.sourceCatalog=[{sourceId:'source',goodsId:'1',name:'CPU',shopId:'intel',unknown:{keep:true}}];
 input.configs[0].caseImage='/uploads/old-case.png';input.configs[0].unknown.extra=null;
 const expected=normalizeWorkspaceState(input),actual=await normalizeWorkspaceStateAsync(input,[],options);
 assert.deepEqual(actual,expected);assert.equal(actual.logs,input.logs);assert.deepEqual(actual.configs[0].actualParts,[]);
 for(const [live,source] of [[actual.configs[0],input.configs[0]],[actual.templates[0],input.templates[0]],[actual.sourceCatalog[0],input.sourceCatalog[0]]]){live.unknown.keep=false;assert.notEqual(source.unknown.keep,false);}
 actual.unknownRoot.keep='改后';assert.equal(input.unknownRoot.keep,'原值');
 assert.equal(actual.caseGallery[0].url,'/uploads/old-case.png');
});
test('归一不遍历不可复制日志，来源绑定保持独立实际BOM和展示名称',async()=>{
 const input=state();input.logs[0].notCloneable=()=>{};
 input.sourceCatalog=[{sourceId:'source',goodsId:'1',name:'新版CPU',originalName:'CPU',shopId:'intel',tax:12.5}];
 const prepared=await prepareWorkspaceState(input,[],options);
 assert.equal(prepared.state.logs,input.logs);assert.equal(prepared.state.configs[0].parts[0].sourceId,'source');
 assert.equal(prepared.state.configs[0].parts[0].name,'新版CPU');assert.equal(prepared.state.configs[0].parts[0].displayName,'CPU');
 assert.deepEqual(prepared.state.configs[0].actualParts,[]);assert.equal(prepared.state.costSource[0].tax,12.5);
});
test('分片回执跨输入/全局修改和新增撤销检查点时重新准备，保留输入与历史顺序',async()=>{
 const sent=state(102),remote=structuredClone(sent);remote.configs[0].parts[0].lineId='server';
 let live=structuredClone(sent),counter=0,calls=0;const old=editor.captureConfigHistorySnapshot(live,ui,['c0']);let stacks=[[old],[]];
 const result=await editor.prepareSavedReceipt(sent,remote,{getState:()=>live,getCounter:()=>counter,getStacks:()=>stacks,options:{budgetMs:0,yieldWork:async()=>{
  if(++calls===5){live.configs[0].name='分片输入';live.configs[101].unknown.nested.push('尾部输入');live.shopSettings.intel.coupon=31;counter++;}
  if(calls===7)stacks[0].push(editor.captureConfigHistorySnapshot(live,ui,['c101']));
 }}});
 assert.equal(result.live.conflict,false);assert.equal(result.live.state.configs[0].name,'分片输入');
 assert.equal(result.live.state.configs[0].parts[0].lineId,'server');assert.equal(result.live.state.shopSettings.intel.coupon,31);
 assert.deepEqual(result.live.state.configs[101].unknown.nested,[null,1.125,'尾部输入']);
 assert.equal(result.rebased[0].length,2);assert.equal(result.rebased[0][0].snapshot.configs[0].name,'c0');
 assert.equal(result.rebased[0][0].snapshot.configs[0].parts[0].lineId,'server');
 result.live.state.configs[0].unknown.nested[1]=9;assert.equal(remote.configs[0].unknown.nested[1],1.125);assert.equal(result.rebased[0][0].snapshot.configs[0].unknown.nested[1],1.125);
});
test('分片完整历史保留新增删除撤销前顺序和全局数据，不带服务器日志',async()=>{
 const before=state(),history=editor.captureHistorySnapshot(before,ui),sent=structuredClone(before);sent.configs.reverse();sent.configs.push(row('new'));
 const remote=structuredClone(sent);remote.configs[0].parts[0].lineId='server';
 assert.deepEqual(await editor.rebaseHistorySnapshotAsync(history,sent,remote,options),editor.rebaseHistorySnapshot(history,sent,remote));
});
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// These VM fixtures exercise the legacy complete-workspace branch. Compact
// eviction is tested independently; it must not schedule work after a VM test.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
const receiptCode=app.slice(app.indexOf('async function savedReceiptState('),app.indexOf('async function recoverySnapshot('));
const erpCode=app.slice(app.indexOf('async function receiveErp('),app.indexOf('\nfunction openGalleryFull('));
function erpHarness(){
 const previous=state(),next=state();next.revision=2;next.configs[0].parts[0].erp=30;
 const calls={render:[],conflicts:[]},context={...fullBranch,state:previous,acceptedState:previous,catalog:[],baseCatalog:[],active:'c0',selected:new Set(['c0','missing']),imageRecords:new Map([['c0',{revision:1,url:'/saved/previous.png'}]]),history:[{}],redoHistory:[{}],dirty:false,savePromise:null,conflict:false,changeCounter:0,prepareWorkspaceState:async()=>({state:structuredClone(next),catalog:[]}),request:async url=>{assert.equal(url,'/api/state?logs=none');return next;},current:()=>context.state.configs.find(c=>c.id===context.active),available:()=>context.state.configs,syncHistoryButtons(){},renderAll:(...args)=>calls.render.push(args),openConflict:message=>calls.conflicts.push(message),$:()=>({textContent:''}),window:{workbenchHasPendingChanges:()=>context.dirty||!!context.savePromise}};
 vm.runInNewContext(erpCode+'\nglobalThis.receive=receiveErp;',context);return {context,calls,next,previous};
}
test('实际ERP刷新只读取已提交状态，不调用changed/save，清栈筛选选中项并禁止归一触发二次保存',async()=>{
 const {context,calls,next}=erpHarness();context.changed=()=>assert.fail('ERP刷新不应标dirty');context.save=()=>assert.fail('ERP刷新不应再次保存');
 assert.equal(await context.receive({configIds:['c0'],stockField:'分库可销数'}),true);
 assert.equal(context.acceptedState,next);assert.equal(context.state.revision,2);assert.equal(context.dirty,false);
 assert.deepEqual([...context.selected],['c0']);assert.equal(context.history.length,0);assert.equal(context.redoHistory.length,0);
 assert.equal(calls.render[0][0],null);assert.equal(calls.render[0][1],false);
});
test('ERP准备期间输入或undo改变当前草稿时拒绝应用，保留草稿/撤销栈和旧基线',async()=>{
 const {context,calls,previous}=erpHarness();context.prepareWorkspaceState=async next=>{context.state.configs[0].name='新输入';context.dirty=true;context.changeCounter++;return {state:next,catalog:[]};};
 assert.equal(await context.receive({configIds:['c0']}),false);assert.equal(context.state,previous);assert.equal(context.acceptedState,previous);
 assert.equal(context.state.configs[0].name,'新输入');assert.equal(context.history.length,1);assert.equal(calls.render.length,0);assert.equal(context.conflict,true);
});
test('ERP载入新状态后清除旧图片记录，避免归一后的预览仍链接上一版本图片',async()=>{
 const {context}=erpHarness();context.prepareWorkspaceState=async next=>{const prepared=structuredClone(next);prepared.configs[0].parts[0].name='归一后的展示名称';return {state:prepared,catalog:[]};};
 assert.equal(await context.receive({configIds:['c0']}),true);
 assert.equal(context.imageRecords.size,0);assert.equal(context.dirty,false);
});
test('ERP准备期间仅换店不回退店铺和选中项，刷新仍不触发保存',async()=>{
 const {context,next}=erpHarness();next.configs[1].shopId='gigabyte';context.activeShopId='intel';
 context.available=()=>context.state.configs.filter(c=>c.shopId===context.activeShopId);
 context.current=()=>context.available().find(c=>c.id===context.active);
 context.prepareWorkspaceState=async next=>{context.activeShopId='gigabyte';context.active='c1';context.selected=new Set(['c1']);return {state:structuredClone(next),catalog:[]};};
 assert.equal(await context.receive({configIds:['c0']}),true);
 assert.equal(context.activeShopId,'gigabyte');assert.equal(context.active,'c1');assert.deepEqual([...context.selected],['c1']);assert.equal(context.dirty,false);
});
test('分片期间撤销替换草稿且交换历史栈时重基最新栈，物化字段不被撤销掉',async()=>{
 const sent=state(102),remote=structuredClone(sent);sent.configs[0].name='已提交名称';remote.configs[0].name='已提交名称';remote.configs[0].parts[0].lineId='server';
 const previous=state(102),undo=editor.captureConfigHistorySnapshot(previous,ui,['c0']);
 let live=structuredClone(sent),counter=0,calls=0,stacks=[[undo],[]];
 const result=await editor.prepareSavedReceipt(sent,remote,{getState:()=>live,getCounter:()=>counter,getStacks:()=>stacks,options:{budgetMs:0,yieldWork:async()=>{
  if(++calls===5){const redo=editor.captureConfigHistorySnapshot(live,ui,['c0']);live=editor.restoreHistorySnapshot(live,stacks[0].pop());stacks[1].push(redo);counter++;}
 }}});
 assert.equal(result.live.conflict,false);assert.equal(result.live.state.configs[0].name,'c0');assert.equal(result.live.state.configs[0].parts[0].lineId,'server');
 assert.equal(result.rebased[0].length,0);assert.equal(result.rebased[1].length,1);assert.equal(result.rebased[1][0].snapshot.configs[0].name,'已提交名称');assert.equal(result.rebased[1][0].snapshot.configs[0].parts[0].lineId,'server');
});
test('真实大工作区save在分片重基期间输入后继续提交第二次请求，dirty到第二次确认才清除',async()=>{
 const before=state(102),requests=[];let yielded=0;
 const context={...fullBranch,...editor,...scope,state:structuredClone(before),acceptedState:before,changeCounter:0,dirty:true,history:[],redoHistory:[],sameEditingState,sameEditingStateAsync,ordinarySaveChanges,crypto:{randomUUID},operator:'test',changed:{message:'编辑配置'},batchPromise:null,batchPending:null,ordinaryPending:null,savePromise:null,conflict:false,
  syncHistoryButtons(){},trimHistory(){},sourceCatalog:rows=>rows,renderAll(){},pollDerivedStatus:()=>Promise.resolve(),scheduleImageSave(){},toast(){},$:()=>({textContent:''}),
  prepareSavedReceipt:(sent,remote,settings)=>editor.prepareSavedReceipt(sent,remote,{...settings,options:{budgetMs:0,yieldWork:async()=>{if(++yielded===5){context.state.configs[101].name='分片中的输入';context.changeCounter++;context.dirty=true;}}}})};
 context.state.configs[0].name='初次输入';
 context.request=async(url,options)=>{assert.equal(url,'/api/configs/batch');const payload=JSON.parse(options.body);requests.push(payload);const configs=payload.changes.map(item=>structuredClone(item.after));if(requests.length===1)configs[0].parts[0].lineId='server';return {configs,revision:requests.length+1,updatedAt:'2026-10-13T00:00:00Z',activityDelta:[],rebased:false};};
 vm.runInNewContext(receiptCode+app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function sendBatchPending('))+'\nglobalThis.runSave=save;',context);
 await context.runSave();assert.deepEqual(requests.map(payload=>payload.changes.map(row=>row.id)),[['c0'],['c101']]);
 assert.equal(context.state.configs[0].parts[0].lineId,'server');assert.equal(context.acceptedState.configs[101].name,'分片中的输入');assert.equal(context.dirty,false);assert.equal(context.savePromise,null);
});
test('真实大回执入口等待分片重基，保留飞行输入，远端与历史独立',async()=>{
 const sent=state(102),remote=structuredClone(sent),live=structuredClone(sent);remote.configs[0].parts[0].lineId='server';live.configs[101].name='飞行输入';
 const context={...fullBranch,...editor,state:live,acceptedState:sent,changeCounter:1,dirty:true,history:[editor.captureConfigHistorySnapshot(sent,ui,['c0'])],redoHistory:[],sameEditingState,sameEditingStateAsync,syncHistoryButtons(){},trimHistory(){},sourceCatalog:rows=>rows,renderAll(){}};
 vm.runInNewContext(receiptCode+app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'))+'\nglobalThis.accept=acceptSavedState;',context);
 await context.accept(sent,remote);assert.equal(context.acceptedState,remote);assert.equal(context.state.configs[101].name,'飞行输入');assert.equal(context.state.configs[0].parts[0].lineId,'server');
 context.state.configs[0].parts[0].qty=4;assert.equal(remote.configs[0].parts[0].qty,1);assert.equal(context.history[0].configs[0].parts[0].qty,1);
});
for(const count of [3,102])test(`${count}套回执物化后继续使用已绑定数量输入，写入当前草稿而非失联旧对象`,async()=>{
 const sent=state(count),remote=structuredClone(sent),live=structuredClone(sent);remote.configs[0].parts[0].lineId='server';live.configs[0].parts[0].qty=2;
 const input={dataset:{qty:'0'},value:'4',setCustomValidity(){}},boundParts=live.configs[0].parts;
 const context={...fullBranch,...editor,state:live,acceptedState:sent,changeCounter:1,dirty:true,history:[],redoHistory:[],sameEditingState,sameEditingStateAsync,syncHistoryButtons(){},trimHistory(){},sourceCatalog:rows=>rows,renderAll(){assert.fail('dirty编辑期间不能全量重绘失焦');},parts:boundParts,$$:()=>[input],checkpointConfig(){},changed(){context.dirty=true;context.changeCounter++;}};
 const handler=app.slice(app.indexOf("  $$('[data-qty]').forEach"),app.indexOf("  $$('[data-copy-part]').forEach"));
 vm.runInNewContext(handler,context);
 vm.runInNewContext(receiptCode+app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'))+'\nglobalThis.accept=acceptSavedState;',context);
 await context.accept(sent,remote);input.oninput();
 assert.equal(context.state.configs[0].parts[0].qty,4);assert.equal(context.state.configs[0].parts[0].lineId,'server');assert.equal(remote.configs[0].parts[0].qty,1);
 assert.equal(context.state.configs[0],live.configs[0]);assert.equal(context.state.configs[0].parts,boundParts);
});
test('回执最终应用保留模块/配件身份和远端顺序、精确未知字段，与基线和历史独立',()=>{
 const sent=state(),draft=structuredClone(sent),remote=structuredClone(sent);
 sent.configs[0].modules=[{id:'title',text:'原文',style:{x:1.125}}];draft.configs[0].modules=structuredClone(sent.configs[0].modules);remote.configs[0].modules=structuredClone(sent.configs[0].modules);
 draft.configs[0].modules[0].text='飞行文本';remote.configs[0].modules[0].style.x=2.125;remote.configs[0].parts[0].lineId='new-line';remote.configs.reverse();remote.configs.push(row('new'));
 remote.configs.find(c=>c.id==='c0').unknown.raw='00123';remote.configs.find(c=>c.id==='c0').unknown.keepNull=null;
 const module=draft.configs[0].modules[0],part=draft.configs[0].parts[0],history=editor.captureConfigHistorySnapshot(draft,ui,['c0']);
 const merged=editor.mergeEditorState(sent,draft,remote),result=editor.applySavedReceiptDraft(draft,merged.state,sent),config=result.configs.find(c=>c.id==='c0');
 assert.deepEqual(result.configs.map(c=>c.id),['c2','c1','c0','new']);assert.equal(config.modules[0],module);assert.equal(config.parts[0],part);assert.equal(module.text,'飞行文本');assert.equal(module.style.x,2.125);assert.equal(part.lineId,'new-line');assert.equal(config.unknown.raw,'00123');assert.equal(config.unknown.keepNull,null);
 module.text='后续文本';module.style.x=99;part.qty=5;result.configs.at(-1).unknown.nested.push('新增后的编辑');
 assert.equal(sent.configs[0].modules[0].text,'原文');assert.equal(remote.configs.find(c=>c.id==='c0').modules[0].style.x,2.125);assert.equal(history.configs[0].modules[0].text,'飞行文本');assert.equal(history.configs[0].parts[0].qty,1);assert.equal(remote.configs.at(-1).unknown.nested.length,2);
});
test('回执最终应用不修改共享不可变基线，未知嵌套数组改变类型仍保留',()=>{
 const sent=state(),remote=structuredClone(sent);remote.configs[0].unknown.extra=[{id:'nested',value:1.125}];
 const shared={...sent},merged=editor.mergeEditorState(sent,shared,remote),result=editor.applySavedReceiptDraft(shared,merged.state,sent);
 result.configs[0].unknown.extra[0].value=0;assert.equal(remote.configs[0].unknown.extra[0].value,1.125);assert.equal(sent.configs[0].unknown.extra,undefined);
 const live=structuredClone(sent);live.configs[0].unknown={nested:[{id:'nested',value:3.125}]};
 const typeChanged=editor.mergeEditorState(sent,live,sent);assert.doesNotThrow(()=>editor.applySavedReceiptDraft(live,typeChanged.state,sent));assert.equal(live.configs[0].unknown.nested[0].value,3.125);
});
test('历史文案明确未自动清理，删除恢复3天规则仍在',()=>{
 assert.doesNotMatch(app,/所有本地历史备份.*到期自动清除/);assert.match(app,/历史版本（含命名版本）另行保留，当前不会自动清理/);
 assert.match(app,/配置已超过 3 天恢复期限/);
});
