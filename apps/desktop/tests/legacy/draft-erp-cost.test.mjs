import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasMainWorkspace} from '../../public/workbench/nas-main-workspace.js';
import {visibleNasCosts} from '../../public/workbench/nas-cost-overlay.js';
import {NasApiError} from '../../public/workbench/nas-api-client.js';

// 合成工作区模拟重开前后的本机存储、服务端成本版本和实际发送的请求正文。
function fixture(){
 const id='212618',part={lineId:'disk',slot:'硬盘',goodsId:id,name:'测试硬盘',erp:520,tax:555,qty:1};
 const document={id:'c',shopId:'intel',name:'已保存',parts:[{...part}],actualParts:[{...part}],addons:[]};
 const cost={goodsId:id,erp:560.33864542,tax:560,nasTaxOverride:true};
 const values=new Map(),writes=[];
 const storage={get length(){return values.size;},key:i=>[...values.keys()][i],
  getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 let version='1',advanceOnSave=false;
 const client={
  me:async()=>({workspace_id:'test',uid:'user',data_source:'intel_live',configuration_writes:true,shops:[{shop_id:'intel',role:'operations'}]}),
  bindIdentity(){},
  workspaceIndex:async()=>({revision:'1',summaries:[document]}),
  workspaceCatalog:async()=>({sourceCatalog:[],costSource:[{...cost}],costVersions:{[id]:version},shopSettings:{intel:{}}}),
  detail:async()=>({document:structuredClone(document),version:'1',dependencies:{sources:{},costs:{[id]:version}}}),
  resource:async(kind,key)=>{assert.equal(kind,'costs');assert.equal(key,id);return {version,document:{...cost}};},
  save:async(action,key,body)=>{
   writes.push(structuredClone(body));
   if(advanceOnSave){advanceOnSave=false;version='2';cost.erp=null;cost.nasErpOverride=true;}
   if(body.dependencies.costs[id]!==version)throw new NasApiError('DEPENDENCY_CONFLICT',409);
   return {configuration_id:key,shop_id:'intel',version:'2',operation_id:body.operation_id,archived:false};
  }
 };
 const build=()=>createNasMainWorkspace({storage,createClient:()=>client,
  nativeRequest:async()=>Response.json({configured:true,main_editor:true,endpoint_id:'test'})});
 async function load(workspace){
  const index=await workspace.request('/api/workspace/index');
  const result=await workspace.request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:['c'],revision:index.revision})});
  const view=visibleNasCosts(result.configs[0],new Map([[id,index.metadata.costSource[0]]]));
  workspace.attach(view);return view;
 }
 return {build,load,writes,client,changeDuringSave:()=>{advanceOnSave=true;}};
}

test('只打开、展示和暂存干净配置不会制造成本差异或提交请求',async()=>{
 const f=fixture(),workspace=f.build(),view=await f.load(workspace);
 assert.equal(view.actualParts[0].erp,560.33864542);
 assert.equal(workspace.stage(view).document.actualParts[0].erp,520);
 assert.deepEqual(workspace.drafts(),[]);
 await assert.rejects(workspace.submit(view),{code:'NO_CHANGES'});
 assert.equal(f.writes.length,0);
});

for(const opened of [false,true]){
 test('旧草稿重开后'+(opened?'打开再保存':'直接保存')+'校准两个配件清单的 ERP，保留原含税价',async()=>{
  const f=fixture(),first=f.build(),original=await f.load(first);
  original.name='草稿';const staged=first.stage(original);
  assert.equal(staged.document.actualParts[0].erp,520);
  const reopened=f.build();
  await reopened.initialize();
  if(opened){
   const draft=await f.load(reopened);
   assert.equal(draft.actualParts[0].erp,560.33864542);
   await reopened.submit(draft);
  }else await reopened.submitDraft('c');
  assert.equal(f.writes.length,1);
  const saved=f.writes[0].document;
  assert.equal(saved.name,'草稿');
  for(const part of [...saved.parts,...saved.actualParts]){
   assert.equal(part.erp,560.33864542);assert.equal(part.tax,555);
  }
  assert.deepEqual(reopened.drafts(),[]);
 });
}

test('成本依赖冲突后用新版本的明确空价重建正文',async()=>{
 const f=fixture(),workspace=f.build(),view=await f.load(workspace);
 view.name='草稿';workspace.stage(view);f.changeDuringSave();
 const receipt=await workspace.submit(view);
 assert.ok(receipt.dependenciesRefreshed);
 assert.equal(f.writes.length,2);
 assert.equal(f.writes[0].document.actualParts[0].erp,560.33864542);
 const retried=f.writes[1];
 assert.equal(retried.dependencies.costs['212618'],'2');
 assert.equal(retried.document.actualParts[0].erp,null);
 assert.equal(retried.document.actualParts[0].erpUnknown,true);
 assert.notEqual(f.writes[0].operation_id,retried.operation_id);
});

const observed={sources:{},costs:{'212618':'2'}};
test('预加载后另一窗口产生的草稿和旧版价格草稿都阻止来源差异替换',async()=>{
 const f=fixture(),reader=f.build(),writer=f.build(),view=await f.load(reader),other=await f.load(writer);
 const replacement=[{id:view.id,action:'replace',document:{...view,name:'来源同步'}}];
 other.name='另一窗口的编辑';const saved=writer.stage(other);
 assert.deepEqual([...await reader.acceptObservedDependencies(observed)],[]);
 assert.equal(reader.stage(view).dependencies.costs['212618'],'1');
 await assert.rejects(reader.configurationChanges(replacement,{sourceSync:true}),{code:'UNSAVED_DRAFT'});
 assert.deepEqual(writer.stage(other),saved);
 other.name='已保存';writer.stage(other);
 const prices=[{id:'c',expected_version:'1',fields:{price:160}}];writer.priceDraft(prices);
 assert.deepEqual([...await reader.acceptObservedDependencies(observed)],[]);
 await assert.rejects(reader.configurationChanges(replacement,{sourceSync:true}),{code:'UNSAVED_DRAFT'});
 assert.deepEqual(writer.priceDraft(),prices);
 writer.priceDraft([]);
 assert.deepEqual([...await reader.acceptObservedDependencies(observed)],['c']);
 assert.equal((await reader.configurationChanges(replacement,{sourceSync:true}))[0].dependencies.costs['212618'],'2');
 assert.deepEqual(f.writes,[]);
});

test('刷新等待时产生的草稿及已发送但尚未回执的保存保留原依赖和完整正文',async()=>{
 const f=fixture(),workspace=f.build(),view=await f.load(workspace);
 const refreshing=workspace.acceptObservedDependencies(observed);
 view.parts[0].hardwareOverrides={cpuName:'本机手填'};const staged=workspace.stage(view);
 assert.deepEqual([...await refreshing],[]);assert.deepEqual(workspace.stage(view),staged);
 const entered=Promise.withResolvers(),resume=Promise.withResolvers(),realSave=f.client.save;
 f.client.save=async(...args)=>{entered.resolve();await resume.promise;return realSave(...args);};
 const saving=workspace.submit(view);await entered.promise;
 try{
  const pending=workspace.stage(view);
  assert.equal(pending.pending.body.dependencies.costs['212618'],'1');
  assert.deepEqual([...await workspace.acceptObservedDependencies(observed)],[]);
  assert.deepEqual(workspace.stage(view),pending);
  await assert.rejects(workspace.configurationChanges([{id:'c',action:'replace',document:view}],{sourceSync:true}),{code:'UNSAVED_DRAFT'});
 }finally{resume.resolve();await saving;}
 assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].document.parts[0].hardwareOverrides,{cpuName:'本机手填'});
});
