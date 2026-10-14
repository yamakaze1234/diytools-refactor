import * as scopeHelpers from '../../public/workbench/scoped-save.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {mergeEditingState,sameEditingState} from '../../public/workbench/workspace-ui-merge.js';
import {cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,rebaseHistorySnapshot} from '../../public/workbench/editor-performance.js';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';

const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// Keep these existing undo/retry fixtures on the complete-workspace branch.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
const saveCode=app.slice(app.indexOf('async function save(){'),app.indexOf('async function sendBatchPending(){'));
const acceptCode=app.slice(app.indexOf('function acceptSavedState('),app.indexOf('async function save(){'));

test('回执丢失后先重放 A，再以新 operationId 保存期间输入的 B',async()=>{
 const base={revision:0,updatedAt:'2026-09-27T00:00:00Z',configs:[{id:'one',price:10}],logs:[]};
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);};
 const sent=[];let loseFirst=true;
 const context={...fullBranch,state:structuredClone(base),acceptedState:structuredClone(base),dirty:true,conflict:false,
  savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,changed:{message:'编辑价格'},operator:'tester',
  $};
 context.clone=structuredClone;
 Object.assign(context,{cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState});
 context.crypto={randomUUID};
 context.sameEditingState=(a,b)=>JSON.stringify(a.configs)===JSON.stringify(b.configs);
 context.ordinarySaveChanges=(a,b)=>a.configs[0].price===b.configs[0].price?null:[{id:'one',base:a.configs[0],after:b.configs[0]}];
 context.request=async(url,options)=>{
  assert.equal(url,'/api/configs/batch');const payload=JSON.parse(options.body);
  sent.push(payload);
  if(loseFirst){loseFirst=false;throw Error('响应中断');}
  const price=payload.changes[0].after.price;
  return {operationId:payload.operationId,revision:price===11?1:2,updatedAt:'2026-09-27T00:00:01Z',configs:[{id:'one',price}],activityDelta:[],rebased:false};
 };
 context.acceptSavedState=(snapshot,remote)=>{context.acceptedState=structuredClone(remote);};
 context.pollDerivedStatus=()=>Promise.resolve();context.scheduleImageSave=()=>{};context.toast=()=>{};
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(saveCode+'\nglobalThis.runSave=save;',context);
 context.state.configs[0].price=11;
 await assert.rejects(context.runSave(),/响应中断/);
 context.state.configs[0].price=12;
 await context.runSave();
 assert.equal(sent.length,3);
 assert.equal(sent[0].operationId,sent[1].operationId);
 assert.notEqual(sent[1].operationId,sent[2].operationId);
 assert.deepEqual(sent.map(x=>x.changes[0].after.price),[11,11,12]);
 assert.equal(context.state.configs[0].price,12);
 assert.equal(context.acceptedState.configs[0].price,12);
 assert.equal(context.dirty,false);
});

test('旧回执拉取远端同字段更新时保留草稿并阻止自动保存',()=>{
 const sent={revision:1,configs:[{id:'one',price:11}],shopSettings:{}};
 const remote={revision:2,configs:[{id:'one',price:13}],shopSettings:{}};
 const context={...fullBranch,state:{revision:1,configs:[{id:'one',price:12}],shopSettings:{}},acceptedState:structuredClone(sent),
  clone:structuredClone,cloneEditorState,withoutActivityLogs,mergeEditorState,rebaseHistorySnapshot,mergeEditingState,sameEditingState,history:[],redoHistory:[],trimHistory(){},dirty:true};
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(acceptCode+'\nglobalThis.accept=acceptSavedState;',context);
 assert.throws(()=>context.accept(sent,remote),error=>error.status===409);
 assert.equal(context.state.configs[0].price,12);
 assert.equal(context.acceptedState.configs[0].price,13);
 assert.equal(context.dirty,true);
});

test('实际样式增量响应丢失后保留原请求，继续拖动与文本输入分别保存',async()=>{
 const base={revision:7,configs:[{id:'one',shopId:'intel',productId:'link',name:'原名称',unknown:{raw:'00123'},textTransforms:{long:{'header.title':{x:10,y:20}}}}],
  templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]};
 const requests=[],nodes=new Map();let interrupt=true;
 const context={...fullBranch,state:structuredClone(base),acceptedState:structuredClone(base),dirty:true,conflict:false,
  savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,changed:{message:'移动文字'},operator:'tester',
  history:[],redoHistory:[],cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,mergeEditingState,sameEditingState,ordinarySaveChanges,
  crypto:{randomUUID},sourceCatalog:x=>x,syncHistoryButtons(){},renderAll(){},pollDerivedStatus:()=>Promise.resolve(),scheduleImageSave(){},toast(){},
  $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 context.request=async(url,options)=>{
  assert.equal(url,'/api/configs/batch');const payload=JSON.parse(options.body);requests.push(payload);
  if(interrupt){interrupt=false;throw Error('回执丢失');}
  return {operationId:payload.operationId,configs:payload.changes.map(c=>c.after),revision:requests.length+6,updatedAt:'2026-10-12T00:00:00Z',activityDelta:[],rebased:false};
 };
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(acceptCode+saveCode+'\nglobalThis.runSave=save;',context);
 context.state.configs[0].textTransforms.long['header.title'].x=30;
 await assert.rejects(context.runSave(),/回执丢失/);
 context.state.configs[0].textTransforms.long['header.title'].x=50;
 context.state.configs[0].textStyles={'header.title':{text:'继续输入'}};
 await context.runSave();
 assert.equal(requests.length,3);assert.deepEqual(requests[0],requests[1]);
 assert.notEqual(requests[1].operationId,requests[2].operationId);
 assert.deepEqual(requests.map(p=>p.changes[0].after.textTransforms.long['header.title'].x),[30,30,50]);
 assert.equal(requests[0].changes[0].after.textStyles,undefined);
 assert.equal(requests[2].changes[0].after.textStyles['header.title'].text,'继续输入');
 assert.equal(context.acceptedState.configs[0].textTransforms.long['header.title'].x,50);
 assert.deepEqual(context.acceptedState.configs[0].unknown,base.configs[0].unknown);
 assert.equal(context.dirty,false);
});
