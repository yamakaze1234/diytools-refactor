import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as scope from '../../public/workbench/scoped-save.js';
import {createLazyWorkspace,markPartialWorkspace,assertLoadedChanges,summaryOf} from '../../public/workbench/lazy-workspace.js';
import {normalizeWorkspaceStateAsync} from '../../public/workbench/shops.js';
import {createSourceIndex} from '../../public/workbench/component-index.js';
import {bindSources,alignDisplaySourceNames,sourceCatalog} from '../../public/workbench/source.js';
import {normalizeProducts,posterModules} from '../../public/workbench/core.js';
import {cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,rebaseHistorySnapshot,applySavedReceiptDraft} from '../../public/workbench/editor-performance.js';
import {sameEditingState} from '../../public/workbench/workspace-ui-merge.js';
import {planCompactRefresh,sameWorkspaceMetadata} from '../../public/workbench/compact-refresh.js';
import {prepareWorkspaceState} from '../../public/workbench/workspace-state-apply.js';

const app=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const extract=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end));
const implementation=extract('function pruneDetails(','async function completeWorkspaceSnapshot(')
 +extract('async function prepareCompactSnapshot(','async function savedReceiptState(')
 +extract('let compactRefresh=','function compactChanges(')
 +extract('function compactChanges(','function checkpoint(')
 +extract('function acceptSavedState(','async function sendBatchPending(){');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

async function fixture(onPatch){
 const documents=Array.from({length:3},(_,i)=>({id:'c'+i,shopId:'intel',productId:'link',product:'链接',name:'旧名称'+i,price:10,unknown:{raw:'00123'}}));
 const metadata={dataVersion:3,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 const requests=[],nodes=new Map(),captures=[];let revision=7;
 const request=async(url,options)=>{
  const payload=options?.body?JSON.parse(options.body):null;requests.push({url,payload});
  if(url==='/api/workspace/index')return {revision,updatedAt:'2026-10-12T00:00:00Z',metadata:structuredClone(metadata),summaries:documents.map(summaryOf)};
  if(url==='/api/configs/load'){if(payload.revision!==revision)throw Object.assign(Error('配置列表已更新'),{status:409});return {revision,configs:payload.ids.map(id=>structuredClone(documents.find(row=>row.id===id)))};}
  assert.equal(url,'/api/configs/patch');if(onPatch)await onPatch(payload);
  revision++;return {operationId:payload.operationId,revision,updatedAt:'2026-10-13T00:00:00Z',configs:structuredClone(payload.changes.map(row=>row.after)),activityDelta:[],rebased:false};
 };
 const lazyWorkspace=createLazyWorkspace({request});await lazyWorkspace.refresh();
 const state=markPartialWorkspace(await normalizeWorkspaceStateAsync({...metadata,revision,configs:[]}));
 const context={...scope,request,lazyWorkspace,state,acceptedState:structuredClone(state),fullWorkspace:false,dirty:false,conflict:false,
  createLazyWorkspace,markPartialWorkspace,planCompactRefresh,sameWorkspaceMetadata,prepareWorkspaceState,baseCatalog:[],workspaceLoad:null,
  window:{},document:{activeElement:null},imageRecords:new Map(),selected:new Set(),renderList(){},
  changeCounter:0,savePromise:null,batchPromise:null,batchPending:null,ordinaryPending:null,history:[],redoHistory:[],catalog:[],changed:{message:'编辑配置'},operator:'tester',
  normalizeWorkspaceStateAsync,createSourceIndex,bindSources,alignDisplaySourceNames,normalizeProducts,posterModules,assertLoadedChanges,
  cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,rebaseHistorySnapshot,applySavedReceiptDraft,sameEditingState,sourceCatalog,
  crypto:{randomUUID},rememberDisplayParts(){},syncHistoryButtons(){},trimHistory(){},renderAll(){},pollDerivedStatus:async()=>{},scheduleImageSave(){},toast(){},
  active:'c0',pendingImages:new Set(),displayBaseline:new Map(),setTimeout:()=>0,ensureFullWorkspace:async()=>{throw Error('compact save unexpectedly hydrated full workspace');},
  captureSaveSnapshot(state,base){const result=scope.captureSaveSnapshot(state,base);captures.push(scope.saveSnapshotIds(result));return result;},
  $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);}};
 context.loadedIds=()=>context.state.configs.map(row=>row.id);context.current=()=>context.state.configs.find(row=>row.id===context.active&&!row.deletedAt);
 vm.runInNewContext(implementation+'\nglobalThis.runSave=save;globalThis.load=loadDetail;globalThis.refresh=refreshCompactWorkspace;',context);
 await context.load('c0');
 return {context,requests,documents,captures,metadata,advance:()=>++revision,patches:()=>requests.filter(row=>row.url==='/api/configs/patch').map(row=>row.payload)};
}

test('continuous name, price and parts edits retain the live config and scoped baseline across real save/prune cycles',async()=>{
 const {context:c,requests,captures,patches}=await fixture(),live=c.state.configs[0],parts=live.parts;
 for(const [field,value] of [['name','first'],['price',200],['name','third']]){
  scope.declareSaveScope(c.state,c.acceptedState,['c0']);live[field]=value;scope.changeSaveScope(c.state,c.acceptedState,['c0']);c.dirty=true;await c.runSave();
  await c.load('c0');assert.equal(c.state.configs[0],live);assert.equal(live.parts,parts);
 }
 scope.declareSaveScope(c.state,c.acceptedState,['c0']);parts.push({slot:'CPU',name:'changed',qty:1});scope.changeSaveScope(c.state,c.acceptedState,['c0']);c.dirty=true;await c.runSave();
 assert.equal(captures[0],null);assert.deepEqual(captures.slice(1),[['c0'],['c0'],['c0']]);
 assert.equal(requests.filter(r=>r.url==='/api/configs/load').length,1);assert.equal(patches().length,4);assert.equal(c.state.configs[0],live);
 assert.equal(patches().at(-1).changes[0].after.parts.at(-1).name,'changed');
});

test('selecting the already loaded configuration stays usable while a save is pending',async()=>{
 const {context:c,requests}=await fixture(),live=c.state.configs[0];c.savePromise=new Promise(()=>{});
 await c.load('c0');assert.equal(c.state.configs[0],live);assert.equal(requests.length,2);
});

test('repeated clicks while a new config loads share its request and detail preparation',async()=>{
 const {context:c,requests}=await fixture(),original=c.normalizeWorkspaceStateAsync;let prepares=0;
 c.normalizeWorkspaceStateAsync=async(...args)=>{prepares++;return original(...args);};
 await Promise.all([c.load('c1'),c.load('c1'),c.load('c1')]);
 assert.equal(prepares,1);assert.equal(requests.filter(r=>r.url==='/api/configs/load'&&r.payload.ids.includes('c1')).length,1);
 assert.equal(c.state.configs.filter(row=>row.id==='c1').length,1);
});

test('navigation between loaded configs after a batch only renders the selected detail',async()=>{
 const rows=[{id:'one',shopId:'intel',productId:'link'},{id:'two',shopId:'intel',productId:'link'}],rendered=[];
 const c={activationGeneration:0,fullWorkspace:true,active:'one',selected:new Set(),collapsedProducts:new Set(['link']),posterEditor:{clear(){}},
  current:()=>rows.find(row=>row.id===c.active),available:()=>rows,renderCompact:ids=>rendered.push(Array.from(ids)),renderAll(){throw Error('navigation must not normalize every configuration');},pruneDetails(){},toast(message){throw Error(message);}};
 vm.runInNewContext(extract('async function activate(','function renderShop('),c);
 await c.activate('two');assert.equal(c.current(),rows[1]);assert.deepEqual(rendered,[['two']]);
});

test('active configuration stays pinned when other loaded details exceed the cache limit',async()=>{
 const {context:c}=await fixture(),live=c.state.configs[0];
 // Replace with a smaller real cache to exercise eviction with the same app pruning.
 const index=c.lazyWorkspace.index(),small=createLazyWorkspace({request:c.request,limit:1});small.install(index);small.confirm(index.revision,index.updatedAt,c.acceptedState.configs);c.lazyWorkspace=small;
 await c.load('c1');await c.load('c2');c.pruneDetails();
 assert.deepEqual(Array.from(c.state.configs,row=>row.id),['c0']);assert.equal(c.state.configs[0],live);assert.deepEqual(small.cachedIds(),['c0']);
});

test('compact patch selection skips shared public collections but still detects real global edits',()=>{
 const c={};vm.runInNewContext(extract('function compactChanges(','function checkpoint('),c);
 const shared={toJSON(){throw Error('large shared collection must not be serialized');}},row={id:'c0',shopId:'intel',productId:'link',name:'old'};
 const base={configs:[row],costSource:shared},snapshot={...base,configs:[{...row,name:'new'}]};assert.equal(c.compactChanges(base,snapshot).length,1);
 assert.equal(c.compactChanges({configs:[row],costSource:[{tax:1}]},{configs:[row],costSource:[{tax:2}]}),null);
});

test('clean compaction and remote refresh retain editor config, parts and module object references',async()=>{
 const {context:c}=await fixture(),live=c.state.configs[0];live.parts.push({slot:'CPU',name:'old'});live.modules.push({id:'custom',text:'old'});
 c.markPartialWorkspace=markPartialWorkspace;c.loadedIds=()=>c.state.configs.map(row=>row.id);vm.runInNewContext(extract('function applyCompactSnapshot(','async function compactWorkspace('),c);
 const index=c.lazyWorkspace.index(),configs=structuredClone(c.state.configs);configs[0].parts[0].name='remote';configs[0].modules.at(-1).text='remote';const parts=live.parts,part=parts[0],module=live.modules.at(-1);
 c.applyCompactSnapshot({index,raw:structuredClone(configs),prepared:{state:{...index.metadata,configs:[],revision:index.revision},catalog:[]},configs});
 assert.equal(c.state.configs[0],live);assert.equal(live.parts,parts);assert.equal(live.parts[0],part);assert.equal(live.modules.at(-1),module);assert.equal(part.name,'remote');assert.equal(module.text,'remote');
});

test('full-load status is restored on success and failure without overwriting a newer save status',async()=>{
 for(const outcome of ['success','failure','new-status']){
  const workspace={inert:false},status={textContent:'已保存'},c={fullWorkspace:false,workspaceLoad:null,changeCounter:0,baseCatalog:[],
   $:id=>id==='.workspace'?workspace:status,completeWorkspaceSnapshot:async()=>{if(outcome==='failure')throw Error('load failed');return {state:{},remote:{},counter:0};},
   prepareWorkspaceState:async()=>({state:{},catalog:[]}),rememberDisplayParts(){},renderAll(){if(outcome==='new-status')status.textContent='尚未保存';}};
  vm.runInNewContext(extract('async function ensureFullWorkspace(','function fullAction('),c);
  if(outcome==='failure')await assert.rejects(c.ensureFullWorkspace(),/load failed/);else await c.ensureFullWorkspace();
  assert.equal(workspace.inert,false);assert.equal(status.textContent,outcome==='new-status'?'尚未保存':'已保存');
 }
});

test('actual compact load and save preserve raw provenance while saving first-time normalized fields for only the selected config',async()=>{
 const {context,patches,requests,documents}=await fixture();
 const raw=context.acceptedState.configs[0],draft=context.state.configs[0];
 assert.equal(raw.modules,undefined);assert.equal(raw.actualParts,undefined);assert(Array.isArray(draft.modules));assert(Array.isArray(draft.actualParts));
 assertLoadedChanges([{id:'c0',base:raw,after:draft}]);
 draft.name='新名称';context.dirty=true;await context.runSave();
 assert.equal(patches().length,1);const payload=patches()[0];assert.deepEqual(payload.changes.map(row=>row.id),['c0']);
 assert.equal(payload.changes[0].base.modules,undefined);assert(Array.isArray(payload.changes[0].after.modules));assert(Array.isArray(payload.changes[0].after.actualParts));
 assert.deepEqual(payload.changes[0].after.unknown,{raw:'00123'});assert.equal(context.acceptedState.configs[0].name,'新名称');assert.equal(context.dirty,false);
 assert.equal(context.state.configs.length,1);assert.equal(context.lazyWorkspace.index().summaries.length,3);assert.equal(documents[1].name,'旧名称1');
 assert.deepEqual(requests.map(row=>row.url),['/api/workspace/index','/api/configs/load','/api/configs/patch']);
 // A second edit uses the real confirmed receipt as the authenticated base.
 context.state.configs[0].name='再次编辑';context.dirty=true;scope.invalidateSaveScope(context.state,'test edit');await context.runSave();
 assert.equal(patches().length,2);assert.equal(patches()[1].changes[0].base.name,'新名称');assert.equal(context.acceptedState.configs[0].name,'再次编辑');
});

test('actual compact save retries the identical operation and preserves input arriving while its receipt is in flight',async()=>{
 const started=deferred(),release=deferred();let attempt=0;
 const {context,patches}=await fixture(async()=>{if(++attempt===1)throw Error('回执丢失');if(attempt===2){started.resolve();await release.promise;}});
 context.state.configs[0].name='第一份';context.dirty=true;await assert.rejects(context.runSave(),/回执丢失/);
 const retained=context.ordinaryPending;assert(retained);assert.equal(context.dirty,true);
 const retry=context.runSave();await started.promise;
 const live=context.state.configs[0];live.name='飞行输入';live.textStyles={'header.title':{text:'新标题'}};context.dirty=true;scope.invalidateSaveScope(context.state,'in-flight input');
 release.resolve();await retry;
 assert.equal(patches().length,3);assert.deepEqual(patches()[0],patches()[1]);assert.equal(patches()[0].operationId,retained.payload.operationId);assert.notEqual(patches()[1].operationId,patches()[2].operationId);
 assert.deepEqual(patches().map(row=>row.changes[0].after.name),['第一份','第一份','飞行输入']);
 assert.equal(patches()[2].changes[0].after.textStyles['header.title'].text,'新标题');assert.equal(context.state.configs[0],live);
 assert.equal(context.acceptedState.configs[0].name,'飞行输入');assert.equal(context.state.configs[0].textStyles['header.title'].text,'新标题');assert.equal(context.ordinaryPending,null);assert.equal(context.dirty,false);
});

// 模拟后台提交新版本，验证自动恢复真实点击链路，而非只检查提示文字。
test('版本推进后点击新配置自动刷新一次并打开，已加载对象不变',async()=>{
 const {context:c,requests,documents,advance}=await fixture(),live=c.state.configs[0];
 documents[1].name='后台新名称';advance();
 await c.load('c1');assert.equal(c.state.revision,8);assert.equal(c.state.configs.find(row=>row.id==='c1').name,'后台新名称');
 assert.equal(c.state.configs[0],live);assert.equal(requests.filter(r=>r.url==='/api/workspace/index').length,2);
 assert(!requests.some(r=>r.url==='/api/state?logs=none'));
});

test('其他配置更新时保留当前输入和对象，后续保存携带最新版本及原始基线',async()=>{
 const {context:c,documents,advance,patches}=await fixture(),live=c.state.configs[0],parts=live.parts;
 c.document.activeElement={matches:()=>true};live.name='正在输入';c.dirty=true;c.changeCounter++;
 c.renderAll=()=>assert.fail('刷新不得重建编辑区');documents[2].name='后台更新';advance();
 assert.equal(await c.refresh(),true);assert.equal(c.state.configs[0],live);assert.equal(live.parts,parts);assert.equal(live.name,'正在输入');assert.equal(c.dirty,true);
 assert.equal(c.lazyWorkspace.index().summaries.find(row=>row.id==='c2').name,'后台更新');
 c.renderAll=()=>{};await c.runSave();assert.equal(patches()[0].baseRevision,8);assert.equal(patches()[0].changes[0].base.name,'旧名称0');assert.equal(patches()[0].changes[0].after.name,'正在输入');
});

test('其他已加载但未编辑的配置可以更新，当前草稿保持不变',async()=>{
 const {context:c,documents,advance}=await fixture();await c.load('c1');const live=c.state.configs[0];live.price=888;c.dirty=true;
 documents[1].price=999;advance();assert.equal(await c.refresh(),true);assert.equal(c.state.configs[0],live);assert.equal(live.price,888);
 assert.equal(c.state.configs.find(row=>row.id==='c1').price,999);
});

test('当前草稿的同一配置被修改时保留整个旧基线和输入',async()=>{
 const {context:c,documents,advance}=await fixture(),state=c.state,base=c.acceptedState,index=c.lazyWorkspace.index();
 c.state.configs[0].name='本地';c.dirty=true;documents[0].name='远端';advance();
 assert.equal(await c.refresh(),false);assert.equal(c.state,state);assert.equal(c.acceptedState,base);assert.equal(c.lazyWorkspace.index(),index);assert.equal(c.state.configs[0].name,'本地');
});

test('载入期间的新输入使刷新结果失效，草稿和版本不被覆盖',async()=>{
 const {context:c,advance}=await fixture(),request=c.request;
 advance();let edited=false;c.request=async(...args)=>{const result=await request(...args);if(!edited&&args[0]==='/api/configs/load'){edited=true;c.state.configs[0].name='网络等待期间输入';c.dirty=true;c.changeCounter++;}return result;};
 assert.equal(await c.refresh(),false);assert.equal(c.state.revision,7);assert.equal(c.state.configs[0].name,'网络等待期间输入');
});

test('连续版本变化最多自动恢复一次，不循环重载',async()=>{
 const {context:c,requests,advance}=await fixture(),request=c.request;advance();
 c.request=async(...args)=>{if(args[0]==='/api/workspace/index')advance();return request(...args);};
 // 首次点击使用既有 loader；刷新后的请求仍失败时必须停止。
 const load=c.lazyWorkspace.load.bind(c.lazyWorkspace);c.lazyWorkspace.load=async ids=>{if(ids.includes('c1'))throw Object.assign(Error('更新中'),{status:409});return load(ids);};
 await assert.rejects(c.load('c1'),/当前输入已保留/);assert.equal(requests.filter(r=>r.url==='/api/workspace/index').length,2);
});

test('目标配置删除后更新列表并解释原因，不打开空配置',async()=>{
 const {context:c,documents,advance}=await fixture();documents.splice(1,1);advance();
 await assert.rejects(c.load('c1'),/已被删除/);assert(!c.lazyWorkspace.index().summaries.some(row=>row.id==='c1'));assert.equal(c.state.configs.length,1);
});

test('同步通知和多个点击共享同一索引刷新',async()=>{
 const {context:c,requests,advance}=await fixture();advance();
 assert.deepEqual(await Promise.all([c.refresh(),c.refresh(),c.refresh()]),[true,true,true]);assert.equal(requests.filter(row=>row.url==='/api/workspace/index').length,2);
});

test('公共资料变化时保留未保存草稿，等待现有保存比较流程',async()=>{
 const {context:c,metadata,advance}=await fixture();c.state.configs[0].price=321;c.dirty=true;metadata.shopSettings={intel:{serviceText:'新服务'}};advance();
 assert.equal(await c.refresh(),false);assert.equal(c.state.configs[0].price,321);assert.equal(c.state.revision,7);
});

// 保存请求与刷新不能同时修改保存基线；回执丢失的待重试请求也一样受保护。
test('保存或重试请求尚未确认时不启动索引刷新',async()=>{
 for(const key of ['savePromise','batchPromise','ordinaryPending','batchPending']){
  const {context:c,requests,advance}=await fixture();advance();const count=requests.length;c[key]={};
  assert.equal(await c.refresh(),false);assert.equal(requests.length,count);assert.equal(c.state.revision,7);
 }
});

test('网络错误不触发版本恢复请求',async()=>{
 const {context:c,requests}=await fixture();c.lazyWorkspace.load=async()=>{throw Error('网络超时');};
 await assert.rejects(c.load('c1'),/网络超时/);assert.equal(requests.filter(row=>row.url==='/api/workspace/index').length,1);
});

test('输入框聚焦时远端修改当前配置，保留当前 DOM 和版本等待处理',async()=>{
 const {context:c,documents,advance}=await fixture();c.document.activeElement={matches:()=>true};documents[0].price=99;advance();
 c.renderAll=()=>assert.fail('不能中断当前输入');assert.equal(await c.refresh(),false);assert.equal(c.state.configs[0].price,10);assert.equal(c.state.revision,7);
});

test('刷新期间发生保存基线替换，即使输入计数未变也丢弃迟到结果',async()=>{
 const {context:c,advance}=await fixture(),request=c.request;advance();const newer={...c.acceptedState,revision:9};
 c.request=async(...args)=>{const result=await request(...args);if(args[0]==='/api/configs/load')c.acceptedState=newer;return result;};
 assert.equal(await c.refresh(),false);assert.equal(c.acceptedState,newer);assert.equal(c.state.revision,7);
});

test('弹窗内未提交输入即使焦点在按钮上也阻止刷新基线',async()=>{
 const {context:c,requests,documents,advance}=await fixture();c.$('#dialog').open=true;c.document.activeElement={matches:()=>false};documents[0].parts=[{slot:'CPU',name:'远端替换'}];advance();const count=requests.length;
 assert.equal(await c.refresh(),false);assert.equal(c.state.revision,7);assert.equal(requests.length,count);
});

test('未确认新配置和未知公共字段草稿不会被列表刷新丢弃',async()=>{
 for(const kind of ['new-config','root-field']){
  const {context:c,advance}=await fixture();c.dirty=true;if(kind==='new-config')c.state.configs.push({...structuredClone(c.state.configs[0]),id:'new'});else c.state.customDraft={value:'保留'};advance();
  assert.equal(await c.refresh(),false);assert.equal(c.state.revision,7);
  if(kind==='new-config')assert(c.state.configs.some(row=>row.id==='new'));else assert.equal(c.state.customDraft.value,'保留');
 }
});
