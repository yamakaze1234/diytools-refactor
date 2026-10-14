import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createLazyWorkspace,markPartialWorkspace,assertCompleteWorkspace,assertLoadedChanges,summaryOf,completeWorkspaceViews} from '../../public/workbench/lazy-workspace.js';
import {saveFullState} from '../../public/workbench/full-save.js';
import {mergeEditorState} from '../../public/workbench/editor-performance.js';
import {mountTemplateArea} from '../../public/workbench/template-area.js';
import {productGroups} from '../../public/workbench/core.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const config=id=>({id,shopId:'intel',productId:'link',name:id,parts:[],actualParts:[],modules:[],unknown:{preserved:true}});
function fixture(count=20,custom){const rows=Array.from({length:count},(_,i)=>config('c'+i)),calls=[];let revision=7;
 const index=()=>({revision,updatedAt:'today',summaries:rows.map(summaryOf),metadata:{shopSettings:{},templates:[],sourceCatalog:[],costSource:[],caseGallery:[]}});
 const request=async(url,options)=>{calls.push({url,...options});if(custom){const result=await custom(url,options);if(result!==undefined)return result;}if(url==='/api/workspace/index')return index();const input=JSON.parse(options.body);assert.equal(input.revision,revision);assert(input.ids.length<=64);return{revision,configs:input.ids.map(id=>structuredClone(rows.find(c=>c.id===id)))};};
 return{rows,calls,index,request,next:()=>revision++,store:createLazyWorkspace({request})};
}

test('startup reads only the index; a selected config loads its complete document and unknown fields',async()=>{
 const f=fixture();await f.store.refresh();assert.deepEqual(f.store.cachedIds(),[]);assert.equal(f.calls.length,1);
 const [row]=await f.store.load(['c3']);assert.equal(f.calls.length,2);assert.deepEqual(row.unknown,{preserved:true});
 await f.store.load(['c3']);assert.equal(f.calls.length,2);assert.deepEqual(f.store.cachedIds(),['c3']);
});
test('late detail replies from an old index are rejected and cannot poison the current cache',async()=>{
 const gate=deferred(),f=fixture(2,(url)=>url==='/api/configs/load'?gate.promise:undefined);
 await f.store.refresh();const flight=f.store.load(['c0']);f.next();await f.store.refresh();gate.resolve({revision:7,configs:[config('c0')]});
 await assert.rejects(flight,/版本已变化/);assert.deepEqual(f.store.cachedIds(),[]);
});

test('overlapping clicks share pending detail reads and preserve requested order',async()=>{
 const gate=deferred(),f=fixture(4,async url=>{if(url==='/api/configs/load')await gate.promise;});await f.store.refresh();
 const a=f.store.load(['c0','c1']),b=f.store.load(['c1','c0']),c=f.store.load(['c1','c2']);
 await Promise.resolve();gate.resolve();const [one,two,three]=await Promise.all([a,b,c]);
 assert.deepEqual(f.calls.filter(r=>r.url==='/api/configs/load').map(r=>JSON.parse(r.body).ids),[['c0','c1'],['c2']]);
 assert.equal(one[0],two[1]);assert.equal(one[1],three[0]);assert.deepEqual(two.map(row=>row.id),['c1','c0']);
});

test('failed shared load can be retried and an old flight cannot remove a new revision flight',async()=>{
 let attempt=0;const gates=[deferred(),deferred()],f=fixture(1,url=>url==='/api/configs/load'?gates[attempt++].promise:undefined);
 await f.store.refresh();const old=f.store.load(['c0']);await Promise.resolve();f.next();await f.store.refresh();
 const fresh=f.store.load(['c0']);await Promise.resolve();gates[0].resolve({revision:7,configs:[config('c0')]});await assert.rejects(old,/版本已变化/);
 const shared=f.store.load(['c0']);gates[1].resolve({revision:8,configs:[config('c0')]});const [a,b]=await Promise.all([fresh,shared]);assert.equal(a[0],b[0]);assert.equal(attempt,2);
 const failure=fixture(1,()=>{});await failure.store.refresh();let fail=true;const loader=createLazyWorkspace({request:async(url,opts)=>{if(url==='/api/configs/load'&&fail){fail=false;throw Error('offline');}return failure.request(url,opts);}});loader.install(failure.index());
 const results=await Promise.allSettled([loader.load(['c0']),loader.load(['c0'])]);assert(results.every(r=>r.status==='rejected'));assert.equal((await loader.load(['c0']))[0].id,'c0');
});
test('cache evicts least-recent clean details to 16 and never removes pinned dirty rows',async()=>{
 const f=fixture(25);await f.store.refresh();await f.store.load(f.rows.map(c=>c.id));const keep=f.store.prune(['c0','c1']);
 assert.equal(keep.size,16);assert(keep.has('c0'));assert(keep.has('c1'));assert(!keep.has('c2'));
 const dirty=f.rows.map(c=>c.id);await f.store.load(dirty);assert.equal(f.store.prune(dirty).size,25);
});
test('global hydration loads at most 64 per request, returns every row and does not expand the normal cache',async()=>{
 const f=fixture(130);await f.store.refresh();await f.store.load(['c4']);const full=await f.store.full();
 assert.equal(full.configs.length,130);assert.deepEqual(f.store.cachedIds(),['c4']);
 assert.deepEqual(f.calls.filter(c=>c.url==='/api/configs/load').map(c=>JSON.parse(c.body).ids.length),[1,64,64,1]);
});
test('failed global hydrate cannot execute its operation or install a partial collection',async()=>{
 let loads=0,ran=false;const f=fixture(70,url=>{if(url==='/api/configs/load'&&++loads===2)throw Object.assign(Error('stale'),{status:409});});
 await f.store.refresh();await assert.rejects((async()=>{await f.store.full();ran=true;})(),/stale/);
 assert.equal(ran,false);assert.deepEqual(f.store.cachedIds(),[]);
});
test('summary lookalikes cannot be saved, while loaded legacy base fields may be absent',async()=>{
 const f=fixture(1);delete f.rows[0].actualParts;delete f.rows[0].modules;await f.store.refresh();const [base]=await f.store.load(['c0']);const after={...base,actualParts:[],modules:[]};
 assert.doesNotThrow(()=>assertLoadedChanges([{id:'c0',base,after}]));
 assert.throws(()=>assertLoadedChanges([{id:'c0',base:structuredClone(base),after}]),/阻止保存摘要/);
 assert.throws(()=>assertLoadedChanges([{id:'c0',base:f.store.index().summaries[0],after}]),/阻止保存摘要/);
});
test('partial documents cannot reach full-state save and summary projection preserves template identity and GPU ID',async()=>{
 const partial=markPartialWorkspace({configs:[config('c0')]});assert.throws(()=>assertCompleteWorkspace(partial),/尚未全部载入/);
 let sent=false;await assert.rejects(saveFullState(async()=>{sent=true;},partial,partial,{}),/尚未全部载入/);assert.equal(sent,false);
 const summary=summaryOf({...config('c0'),shop:'店铺',isTemplate:true,templateId:'t',parts:[{slot:'显卡',name:'GPU',qty:1,goodsId:'123',tax:100}]});
 assert.equal(summary.parts[0].goodsId,'123');assert.equal(summary.parts[0].tax,undefined);assert.equal(summary.templateId,'t');assert.equal(summary.shop,'店铺');
});

test('global UI action refuses to mutate after hydration failure; compact render never normalizes unseen configurations',async()=>{
 const text=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const action=text.slice(text.indexOf('function fullAction('),text.indexOf('async function prepareCompactSnapshot('));
 let changed=false;const context=vm.createContext({fullWorkspace:false,ensureFullWorkspace:async()=>{throw Error('revision changed');},toast(){}});vm.runInContext(action,context);
 await assert.rejects(context.fullAction(()=>{changed=true;})(),/revision changed/);assert.equal(changed,false);
 const compact=text.slice(text.indexOf('function renderCompact('),text.indexOf('let previewFrame='));
 assert.doesNotMatch(compact,/migrateSavedTemplates|applyPosterTheme|applyPosterView/);
});

test('rebased compact receipt carries fresh cost/source metadata into the local three-way merge',async()=>{
 const text=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const implementation=text.slice(text.indexOf('async function savedReceiptState('),text.indexOf('async function recoverySnapshot('));
 const base={revision:1,configs:[config('c0')],costSource:[{goodsId:'1',tax:10}],sourceCatalog:[{sourceId:'s',name:'原源名称'}],shopSettings:{}};
 const local=structuredClone(base);local.configs[0].name='本机新名称';
 const metadata={costSource:[{goodsId:'1',tax:20}],sourceCatalog:[{sourceId:'s',name:'云端新源名称'}],shopSettings:{}};
 const context=vm.createContext({fullWorkspace:false,acceptedState:base,loadedIds:()=>['c0'],lazyWorkspace:{refresh:async()=>({revision:2,updatedAt:'now',summaries:[summaryOf(config('c0'))],metadata}),load:async()=>[config('c0')]}});
 vm.runInContext(implementation,context);const remote=await context.savedReceiptState({rebased:true});const merged=mergeEditorState(base,local,remote);
 assert.equal(merged.conflict,false);assert.equal(merged.state.configs[0].name,'本机新名称');assert.equal(merged.state.costSource[0].tax,20);assert.equal(merged.state.sourceCatalog[0].name,'云端新源名称');
});

test('full hydration does not erase a dirty loaded row that the remote physically removed',()=>{
 const base={revision:1,configs:[config('c0')],shopSettings:{}},local=structuredClone(base);local.configs[0].name='仍未保存';
 const remote={revision:2,configs:[config('remote-new')],shopSettings:{}};
 const views=completeWorkspaceViews(base,local,remote);assert.equal(views.local.configs.find(c=>c.id==='c0').name,'仍未保存');
 const merged=mergeEditorState(views.base,views.local,remote);assert.equal(merged.conflict,true);assert.equal(merged.state.configs.find(c=>c.id==='c0').name,'仍未保存');
 assert(merged.state.configs.some(c=>c.id==='remote-new'));
});

test('collapsed link groups create no hidden config DOM; searching renders only matching rows',()=>{
 const text=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const implementation=text.slice(text.indexOf('function renderList('),text.indexOf('function renderProduct('));
 const rows=Array.from({length:3000},(_,i)=>({...config('c'+i),product:'链接',name:'配置'+i,version:'',parts:[{slot:'CPU',name:'CPU'}]}));
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',classList:{toggle(){}},querySelectorAll:()=>[]});return nodes.get(id);};
 const context=vm.createContext({document:{querySelector:()=>null},$:node,$$:()=>[],closeLinkCardMenu(){},productGroups,ordinaryConfigs:x=>x,available:()=>rows,linkCategories:()=>[],categoryMatches:()=>true,listedConfigs:()=>rows,selected:new Set(),recentDeletedConfigs:()=>[],listPinnedProduct:null,current:()=>null,collapsedProducts:new Set(['link']),active:null,esc:String,linkCardHeading:g=>`<header>${g.name}</header>`,mountTemplateArea(){},templateSectionOpen:false,bindLinkCardMenus(){},fullAction:f=>f,bindConfigDrag(){}});
 vm.runInContext(implementation,context);context.renderList();assert.doesNotMatch(node('#config-list').innerHTML,/class="config-item/);assert.match(node('#config-list').innerHTML,/<header>链接<\/header>/);
 node('#search').value='配置2999';context.renderList();assert.equal((node('#config-list').innerHTML.match(/class="config-item/g)||[]).length,1);assert.match(node('#config-list').innerHTML,/data-id="c2999"/);
 assert(context.collapsedProducts.has('link'));
});

test('closed template library and collapsed template groups never construct config children',()=>{
 let html='';const container={insertAdjacentHTML:(_where,value)=>{html+=value;},querySelector:()=>({}),querySelectorAll:()=>[]};
 const row={...config('template'),productCategory:'主机模板',product:'模板链接'};
 Object.defineProperty(row,'parts',{get(){throw Error('collapsed template inspected detailed parts');}});
 const options={container,configs:[row],active:null,selected:new Set(),collapsedProducts:new Set(['link']),opened:false,esc:String};
 mountTemplateArea(options);assert.doesNotMatch(html,/data-template-config-id|data-template-product-toggle/);
 html='';mountTemplateArea({...options,opened:true});assert.match(html,/data-template-product-toggle/);assert.doesNotMatch(html,/data-template-config-id/);
});

test('failed detail navigation releases the old preview and retains its active config',async()=>{
 const text=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const implementation=text.slice(text.indexOf('async function activate('),text.indexOf('function renderShop('));
 const stage={inert:true},inspector={inert:true},messages=[];
 const context=vm.createContext({activationGeneration:0,fullWorkspace:false,active:'old',loadDetail:async()=>{throw Error('加载失败');},$:id=>id==='#poster-stage'?stage:inspector,toast:value=>messages.push(value)});
 vm.runInContext(implementation,context);await context.activate('next');assert.equal(stage.inert,false);assert.equal(inspector.inert,false);assert.equal(context.active,'old');assert.deepEqual(messages,['加载失败']);
});

test('an unchanged compact cloud refresh leaves undo and detail state untouched',async()=>{
 const text=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const implementation=text.slice(text.indexOf('async function refreshCompactWorkspace('),text.indexOf('function compactChanges('));
 const history=[{configId:'c0'}];let applied=false;
 const context=vm.createContext({compactRefresh:null,fullWorkspace:false,workspaceLoad:null,savePromise:null,batchPromise:null,ordinaryPending:null,batchPending:null,conflict:false,window:{},$:()=>({open:false}),state:{revision:7},acceptedState:{},lazyWorkspace:{index:()=>({revision:7})},loadedIds:()=>[],active:null,prepareCompactSnapshot:async skip=>{assert.equal(skip,true);return null;},history,applyCompactSnapshot(){applied=true;}});
 vm.runInContext(implementation,context);assert.equal(await context.refreshCompactWorkspace(),true);assert.equal(context.history,history);assert.equal(applied,false);
});
