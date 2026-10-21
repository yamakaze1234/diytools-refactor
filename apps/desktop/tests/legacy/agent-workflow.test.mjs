import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentWorkflow} from '../../public/workbench/agent-workflow.js';
import {buildAgentPlan} from '../../public/workbench/agent-changes.js';

const copy=v=>structuredClone(v);
const request={shopId:'intel',targets:[{configId:'a',partIndex:0}],action:{type:'quantity',quantity:2}};
function fixture(){
 const config=(id,shopId='intel',productId='p')=>({id,shopId,productId,name:id,parts:[{slot:'CPU',name:'CPU',goodsId:'001',qty:1}],actualParts:[{slot:'CPU',name:'CPU',goodsId:'001',qty:1}]});
 const raw={revision:7,configs:[config('a'),config('sibling'),config('other-link','intel','q'),config('other-shop','jonsbo')]};
 const f={raw,state:copy(raw),blocked:false,locks:[],releases:0,loads:0,applies:[],syncs:0,native:[]};
 const api={state:()=>f.state,savedState:()=>f.raw,blocked:()=>f.blocked,load:async()=>{f.loads++;},lock:blockSync=>{f.locks.push(blockSync);return()=>{f.releases++;};},apply:async(plan,operationId)=>{f.applies.push({plan,operationId});return {revision:8,configs:plan.changes.map(c=>copy(c.after))};},sync:async()=>{f.syncs++;return {running:false,pending:0,conflicts:0,error:null};},native:async(action,payload)=>{f.native.push({action,payload});throw Error('本测试不写盘');}};
 return {f,api,run:createAgentWorkflow(api)};
}
const job=(method,params={})=>({id:'job-1',method,params});
const applyJob=plan=>job('changes.apply',{plan,operationId:'original-operation-001'});

test('脏界面拒绝任务，不载入、不保存、不锁定',async()=>{
 const {f,run}=fixture();f.blocked=true;
 await assert.rejects(run(job('changes.preview',{request})),e=>e.code==='UI_BUSY');
 assert.equal(f.loads,0);assert.equal(f.applies.length,0);assert.deepEqual(f.locks,[]);
});

test('准备期间变脏或预览后版本漂移均拒绝保存并释放锁',async()=>{
 const {f,api,run}=fixture();api.load=async()=>{f.blocked=true;};
 await assert.rejects(run(job('changes.preview',{request})),e=>e.code==='UI_BUSY');assert.equal(f.releases,1);assert.equal(f.applies.length,0);
 f.blocked=false;api.load=async()=>{};const plan=buildAgentPlan(f.state,request);f.state.revision++;
 await assert.rejects(run(applyJob(plan)),/版本已变化/);assert.equal(f.releases,2);assert.equal(f.applies.length,0);
});

test('真实预览纯函数生成计划，operationId原样传递单次官方保存',async()=>{
 const {f,run}=fixture(),before=copy(f.state);
 const preview=await run(job('changes.preview',{request}));assert.equal(preview.localSave,'unchanged');assert.deepEqual(f.state,before);assert.equal(f.applies.length,0);
 assert.deepEqual(preview.exportContext.configs.map(c=>c.id),['a','sibling']);assert.deepEqual(preview.exportContext.configIds,['a']);assert.equal(preview.plan.exportContext,undefined);
 const result=await run(applyJob(preview.plan));assert.equal(f.applies.length,1);assert.equal(f.applies[0].operationId,'original-operation-001');
 assert.equal(result.localSave,'saved');assert.equal(result.revision,8);assert.equal(result.snapshot.configs[0].parts[0].qty,2);assert.equal(f.releases,2);
 assert.equal(f.native.length,0);
});

test('回执快照冻结原始已保存兄弟配置并覆盖目标，不读取保存后live state',async()=>{
 const {f,api,run}=fixture();f.state.configs[1].uiNormalization='尚未保存归一化';
 const plan=buildAgentPlan(f.state,request),receipt={revision:8,configs:[{...copy(plan.changes[0].after),serverCanonical:'回执值'}]};
 api.apply=async()=>{f.raw.configs[1].name='保存时外部修改';f.state.configs[1].name='保存时UI修改';api.state=()=>{throw Error('不得读取保存后的live state');};return receipt;};
 const result=await run(applyJob(plan));assert.deepEqual(result.snapshot.configIds,['a']);assert.deepEqual(result.snapshot.configs.map(c=>c.id),['a','sibling']);
 assert.equal(result.snapshot.configs[0].serverCanonical,'回执值');assert.equal(result.snapshot.configs[1].name,'sibling');assert.equal(result.snapshot.configs[1].uiNormalization,undefined);
 receipt.configs[0].name='回执外部变动';assert.equal(result.snapshot.configs[0].name,'a');assert.equal(result.receipt.configs[0].name,'a');
});

test('no-op 不保存但仍冻结目标原始快照与同链接编号上下文',async()=>{
 const {f,run}=fixture(),req=copy(request);req.action.quantity=1;
 const result=await run(applyJob(buildAgentPlan(f.state,req)));
 assert.equal(result.localSave,'unchanged');assert.equal(f.applies.length,0);assert.deepEqual(result.snapshot.configIds,['a']);assert.deepEqual(result.snapshot.configs.map(c=>c.id),['a','sibling']);
});

test('保存缺失回执、缺少目标或无效版本均不能假成功，错误后仍可执行',async()=>{
 for(const receipt of [null,{revision:8},{revision:8,configs:[]},{revision:6,configs:[{id:'a'}]},{revision:8.5,configs:[{id:'a'}]}]){
  const {f,api,run}=fixture(),plan=buildAgentPlan(f.state,request);api.apply=async()=>receipt;
  await assert.rejects(run(applyJob(plan)),e=>e.code==='SAVE_UNCONFIRMED');assert.equal(f.releases,1);
  assert.equal((await run(job('changes.preview',{request}))).localSave,'unchanged');
 }
});

test('同步冲突、pending、running和错误均不能报告完成，成功分离本机与云端状态',async()=>{
 for(const status of [null,{conflicts:1},{pending:1},{pending:null},{},{running:true},{error:'失败'}]){
  const {f,api,run}=fixture();api.sync=async()=>status;
  await assert.rejects(run(job('sync.run')),e=>e.code==='SYNC_INCOMPLETE');assert.deepEqual(f.locks,[false]);assert.equal(f.releases,1);assert.equal(f.loads,0);assert.equal(f.applies.length,0);
 }
 const {run}=fixture();const result=await run(job('sync.run'));assert.equal(result.localSave,'unchanged');assert.equal(result.cloudSync,'completed');
});

test('load、apply/save、lock及release异常均释放运行标志',async()=>{
 for(const stage of ['load','apply','lock','release']){
  const {f,api,run}=fixture(),plan=buildAgentPlan(f.state,request),original=api[stage==='release'?'lock':stage];
  if(stage==='release')api.lock=()=>()=>{throw Error('release失败');};else api[stage]=()=>{throw Error(`${stage}失败`);};
  await assert.rejects(run(stage==='apply'?applyJob(plan):job('changes.preview',{request})),new RegExp(`${stage}失败`));
  api[stage==='release'?'lock':stage]=original;
  assert.equal((await run(job('changes.preview',{request}))).localSave,'unchanged');
  if(stage==='apply'||stage==='load')assert.ok(f.releases>=2);
 }
});

test('并发请求被拒绝，首个任务完成后可再次执行',async()=>{
 const {api,run}=fixture();let done;api.load=()=>new Promise(resolve=>{done=resolve;});
 const first=run(job('changes.preview',{request}));await assert.rejects(run(job('changes.preview',{request})),e=>e.code==='UI_BUSY');
 done();await first;api.load=async()=>{};assert.equal((await run(job('changes.preview',{request}))).localSave,'unchanged');
});

test('未知任务、无效保存参数与导出参数在渲染写盘前拒绝',async()=>{
 const {f,run}=fixture();
 for(const input of [null,{method:'changes.preview'},job('changes.apply',{plan:{}})])await assert.rejects(run(input),e=>e.code==='INVALID_PARAMS');
 await assert.rejects(run(job('unknown')),e=>e.code==='METHOD_NOT_FOUND');
 await assert.rejects(run(job('export.start',{revision:6})),e=>e.code==='REVISION_CONFLICT');
 await assert.rejects(run(job('export.start',{revision:7,images:'invalid'})),/images/);
 await assert.rejects(run(job('export.start',{snapshot:{revision:7,configs:[]}})),/没有可导出/);
 assert.equal(f.native.length,0);assert.equal(f.applies.length,0);
});

test('受限原操作重放可确认既有pending，保留原编号快照且不重复apply/load',async()=>{
 const {f,api,run}=fixture(),plan=buildAgentPlan(f.state,request),baseline={configs:copy(f.raw.configs.slice(0,2)),revision:7,configIds:['a']};
 f.blocked=true;let resumes=0;
 api.resumePending=input=>input.params?.operationId==='original-operation-001'?async()=>{resumes++;return {baseline,receipt:{revision:8,configs:[copy(plan.changes[0].after)]}};}:null;
 const result=await run(applyJob(plan));assert.equal(result.localSave,'saved');assert.equal(result.revision,8);assert.deepEqual(result.snapshot.configs.map(c=>c.id),['a','sibling']);assert.equal(resumes,1);assert.equal(f.loads,0);assert.equal(f.applies.length,0);assert.equal(f.releases,1);
 await assert.rejects(run(job('changes.apply',{plan,operationId:'different'})),e=>e.code==='UI_BUSY');
});

test('受限重放失败释放锁且仍允许原操作后续确认，未知回执不假成功',async()=>{
 const {f,api,run}=fixture(),plan=buildAgentPlan(f.state,request);f.blocked=true;
 api.resumePending=()=>async()=>{throw Error('仍未确认');};await assert.rejects(run(applyJob(plan)),/仍未确认/);assert.equal(f.releases,1);
 api.resumePending=()=>async()=>({baseline:{configs:copy(f.raw.configs),configIds:['a']},receipt:null});await assert.rejects(run(applyJob(plan)),e=>e.code==='SAVE_UNCONFIRMED');assert.equal(f.releases,2);
});

test('原生已落盘回执在后续草稿存在时仅确认，不保存或清理当前草稿',async()=>{
 const {f,run}=fixture();f.blocked=true;f.state.configs[0].name='后续人工草稿';
 const before=copy(f.state),receipt={revision:8,configs:[{...copy(f.raw.configs[0]),name:'原操作已保存'}]},snapshot={revision:8,configs:copy(receipt.configs),configIds:['a']};
 const result=await run(job('changes.apply',{operationId:'original-operation-001',savedReceipt:receipt,savedSnapshot:snapshot}));
 assert.equal(result.localSave,'saved');assert.deepEqual(f.state,before);assert.equal(f.loads,0);assert.equal(f.applies.length,0);assert.equal(f.locks.length,0);assert.deepEqual(result.snapshot,snapshot);
});

test('旧保存配置缺productId仍冻结完整链接编号上下文且不修改原始记录',async()=>{
 const {f,run}=fixture();for(const c of f.raw.configs.slice(0,2)){delete c.productId;c.product='旧链接';c.spu='001';}
 f.state=copy(f.raw);for(const c of f.state.configs.slice(0,2))c.productId='legacy:001';
 const before=copy(f.raw),req=copy(request);req.targets[0].configId='sibling';
 const preview=await run(job('changes.preview',{request:req}));
 assert.deepEqual(preview.exportContext.configs.map(c=>c.id),['a','sibling']);assert.deepEqual(f.raw,before);assert.equal(preview.exportContext.configs[0].productId,undefined);
});
