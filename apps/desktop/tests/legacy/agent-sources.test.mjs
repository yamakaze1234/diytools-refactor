import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSources} from '../../public/workbench/agent-sources.js';
import {NasApiError} from '../../public/workbench/nas-api-client.js';
import {validateSharedSourceEdit,validateErpAdoption} from '../../../../services/nas-api/src/shared-sources.mjs';

const shops=['intel','gigabyte','jonsbo'];
const op=()=>crypto.randomUUID();
const clone=structuredClone;
function fixture({managed=false,three=true,manual=false,tracked=true}={}){
 const source=id=>({shopId:id,sourceId:'src',name:'原名称',goodsId:'88',tax:10,addonText:'',...(managed?{sharedSourceId:'88'}:{})});
 const shared={id:'88',version:'3',document:{id:'88',common:{name:'原名称',tax:10},
  stores:Object.fromEntries(shops.map(id=>[id,[{sourceId:'src',fields:{},legacy:[]}]]))}};
 const wrapper=id=>({id:'src',version:'2',owner_shop:id,shared:false,editable:true,document:source(id)});
 const data=Object.fromEntries(shops.map(s=>[s,{source:wrapper(s),cost:{goodsId:'88',tax:10,nasManualTax:manual,nasTaxOverride:true},costVersion:'3'}]));
 const grant=(three?shops:['intel']);
 const me={shops:grant.map(shop_id=>({shop_id,role:'operations'})),shop_capabilities:Object.fromEntries(grant.map(s=>[s,{data_source:s+'_live',
  workspace_writes:true,configuration_writes:true,catalog_writes:true,shared_sources:true}]))};
 const config=(shop,id,isManual)=>({id,name:id,shopId:shop,productId:'link',product:'链接',
  parts:[{sourceId:'src',goodsId:'88',slot:'显卡',name:isManual?'手工名称':'原名称',upgrade:'',qty:1}],
  actualParts:[{sourceId:'src',goodsId:'88',slot:'显卡',name:'实际 BOM 不动',qty:1}],addons:[]});
 const allDocs={};
 for(const shop of shops)allDocs[shop]=Object.fromEntries((tracked?['c1','c2']:[]).map(id=>[id,{version:'5',document:config(shop,id,id==='c2'),dependencies:{sources:{src:'2'},costs:{'88':'3'}}}]));
 const env={pending:false,draft:false,failConfig:null,failAfterWrite:null,failRefresh:false,
  failErp:false,erpName:'制造商 GPU',prohibit:false,templates:[],logs:[],shared,me,data,allDocs};
 const receipts=new Map(),journals=new Map();
 function getClient(shop){
  const state=data[shop];
  const receipt=(kind,id)=>{env.logs.push(['lookup',kind,shop,id]);if(!receipts.has(id))throw new NasApiError('NOT_FOUND',404);return clone(receipts.get(id));};
  return {me:async()=>me,catalog:async(kind,id)=>{
    if(kind==='templates')return env.templates;
    if(kind==='shared-sources')return managed?[clone(shared)]:[];
    if(id&&state.source.id!==id)throw new NasApiError('NOT_FOUND',404);
    return id?clone(state.source):[clone(state.source)];
   },
   workspaceCatalog:async()=>({costSource:[clone(state.cost)],costVersions:{88:state.costVersion}}),
   sourceUsage:async()=>Object.keys(allDocs[shop]),
   detail:async id=>clone(allDocs[shop][id]),
   resource:async(kind,id)=>kind==='sources'?{version:state.source.version,document:state.source.document}:{version:state.costVersion,document:state.cost},
   catalogReceipt:async id=>receipt('catalog',id),workspaceReceipt:async id=>receipt('workspace',id),
   async saveCatalog(kind,id,action,body){
    env.logs.push(['write',kind,shop,body.operation_id]);
    assert(!receipts.has(body.operation_id),'不可重复写已确认操作');
    if(kind==='shared-sources'&&action==='create'){
     if(body.document.erpAdoption)validateErpAdoption(id,body.document);else validateSharedSourceEdit(id,body.document,true);
    }else if(kind==='shared-sources')validateSharedSourceEdit(id,body.document,false);
    const oldVersion=kind==='sources'?state.source.version:shared.version;
    if(body.expected_version&&body.expected_version!==oldVersion)throw new NasApiError('VERSION_CONFLICT',409);
    const version=body.expected_version?String(Number(oldVersion)+1):'1';
    const document=body.document?.erpAdoption?{id,sourceId:'erp:'+shop+':'+id,version,reused:false}:kind==='shared-sources'?{id}:body.document??state.source.document;
    if(kind==='sources'){
     state.source.document=clone(document);state.source.version=version;
     if(action==='archive')state.source.document.deletedAt='2026-11-27';else delete state.source.document.deletedAt;
    }
    const out={kind,shop_id:shop,resource_id:id,operation_id:body.operation_id,version,document,archived:action==='archive'};
    receipts.set(body.operation_id,out);
    if(env.failAfterWrite){env.failAfterWrite=false;throw new NasApiError('SAVE_STATUS_UNKNOWN',503);}
    return out;
   },
   async workspaceWrite(kind,body){
    env.logs.push(['write',kind,shop,body.operation_id]);
    if(env.failConfig&&kind==='configurations'){const e=env.failConfig;env.failConfig=null;throw e;}
    const changes=body.changes.map(c=>{
     if(kind==='costs'){
      assert.equal(state.costVersion,c.expected_version);state.costVersion=String(Number(c.expected_version)+1);
      state.cost.tax=c.fields.tax;state.cost.nasManualTax=c.action==='tax_edit';return {id:c.id,version:state.costVersion};
     }
     const present=allDocs[shop][c.id];
     assert.equal(c.expected_version,present.version);assert.equal(c.dependencies.sources.src,state.source.version);
     assert.equal(c.dependencies.costs['88'],state.costVersion);
     present.version=String(Number(c.expected_version)+1);present.document=c.document;
     return {configuration_id:c.id,shop_id:shop,operation_id:body.operation_id,archived:false,version:present.version};
    });
    const out={kind,shop_id:shop,operation_id:body.operation_id,changes};receipts.set(body.operation_id,out);return out;
   }
  };
 }
 const api={sourceHasPending:()=>env.pending,access:async shop=>({client:getClient(shop),async assertDrafts(){if(env.draft)throw new NasApiError('UNSAVED_DRAFT',409);}}),
  async readErp(kind){if(env.failErp)throw new NasApiError('NETWORK_OR_RESPONSE_ERROR');return kind==='tax-current'?{rows:[{goods_id:'88',tax:6},{goods_id:'77',tax:7}]}:
   {complete:true,total:1,rows:[{goodsId:'77',name:env.erpName,erp:9,stockAvailable:0,erpCategory:'显卡'}]};},
  async native(action,p){const state=journals.get(p.id)[p.stepIndex];env.logs.push([action,p.stepIndex]);
   if(action==='preflight'){if(env.prohibit)throw new NasApiError('PERMISSION_REVOKED',403);state.state='submitted';}
   else{state.state='confirmed';state.receipt=clone(p.receipt);}
  },async refresh(){if(env.failRefresh)throw Error('刷新失败');return true;}};
 const agent=createAgentSources(api);
 return {...env,env,agent,async plan(request){return agent.preview({operationId:op(),request:{shopId:'intel',scope:'shop',...request}});},
  job(plan){const state=plan.steps.map((s,index)=>({index,operationId:op(),state:'pending'}));const id=op();journals.set(id,state);return {id,params:{plan,stepStates:state}};}};
}
test('来源预览允许保留工作表草稿；提交拦截工作表、跟随配置草稿及撤权',async()=>{
 const f=fixture();f.env.pending=true;
 const {plan,summary}=await f.plan({action:'edit',sourceId:'src',fields:{name:'新名称',tax:25},followConfigs:true});
 assert.equal(summary.workbenchSourceHasPending,true);
 assert.deepEqual(summary.steps.map(s=>s.kind),['catalog','costs','configurations']);
 assert.equal(summary.follow[0].manualTextCount,1);assert.equal(summary.follow[0].followConfigCount,1);
 const job=f.job(plan);
 await assert.rejects(f.agent.apply(job),{code:'UNSAVED_DRAFT'});
 f.env.pending=false;f.env.draft=true;
 await assert.rejects(f.agent.apply(job),{code:'UNSAVED_DRAFT'});
 f.env.draft=false;f.env.prohibit=true;
 await assert.rejects(f.agent.apply(job),{code:'PERMISSION_REVOKED'});
 assert.equal(f.env.logs.filter(x=>x[0]==='write').length,0);
});
test('来源和价格已保存、跟随冲突；原步骤收据和冻结依赖版本可继续使用',async()=>{
 const f=fixture();
 const {plan}=await f.plan({action:'edit',sourceId:'src',fields:{name:'新名称',tax:25},followConfigs:true});
 const job=f.job(plan);f.env.failConfig=new NasApiError('VERSION_CONFLICT',409);
 await assert.rejects(f.agent.apply(job),{code:'VERSION_CONFLICT'});
 assert.deepEqual(job.params.stepStates.map(s=>s.state),['confirmed','confirmed','submitted']);
 const fixed=job.params.stepStates.map(s=>s.operationId);
 assert.deepEqual(plan.steps[2].body.changes[0].dependencies,{sources:{src:'3'},costs:{88:'4'}});
 f.env.failRefresh=true;
 const result=await f.agent.apply(job);
 assert.equal(result.uiRefreshed,false);assert.equal(result.nasSave,'saved');assert.equal(result.receipts.length,3);
 assert.equal(f.env.logs.filter(x=>x[0]==='write'&&x[1]==='sources').length,1);
 assert.equal(f.env.logs.filter(x=>x[0]==='lookup'&&x[3]===fixed[2]).length,1);
 assert.equal(f.env.allDocs.intel.c1.document.parts[0].name,'新名称');
 assert.equal(f.env.allDocs.intel.c1.document.actualParts[0].name,'实际 BOM 不动');
 assert.equal(f.env.allDocs.intel.c2.document.parts[0].name,'手工名称');
});
test('来源已落库但返回途中断网，再申请先查原回执，撤权后不新发写入',async()=>{
 const f=fixture(),{plan}=await f.plan({action:'edit',sourceId:'src',fields:{name:'已保存'}});
 const job=f.job(plan);f.env.failAfterWrite=true;
 await assert.rejects(f.agent.apply(job),{code:'SAVE_STATUS_UNKNOWN'});
 f.env.prohibit=true;f.env.pending=true;
 assert.equal((await f.agent.apply(job)).nasSave,'saved');
 assert.equal(f.env.logs.filter(x=>x[0]==='write').length,1);
});
test('三店共用维护按各店有效文案跟随，保留独享名；恢复仅改所选店字段',async()=>{
 const f=fixture({managed:true});
 f.env.shared.document.stores.jonsbo[0].fields={name:'乔思伯专用'};
 f.env.data.jonsbo.source.document.name='乔思伯专用';
 const {plan,summary}=await f.plan({action:'edit',scope:'shared',sourceId:'src',fields:{name:'三店新名',tax:25},followConfigs:true});
 assert.equal(plan.steps[0].catalogKind,'shared-sources');assert.equal(plan.steps.filter(s=>s.kind==='costs').length,0);
 assert.deepEqual(plan.steps.filter(s=>s.kind==='configurations').map(s=>s.shopId),['intel','gigabyte']);
 assert.deepEqual(summary.follow.map(s=>s.followConfigCount),[1,1,0]);
 validateSharedSourceEdit('88',plan.steps[0].body.document,false);
 const restore=await f.plan({shopId:'jonsbo',scope:'shared',action:'edit',sourceId:'src',restoreFields:['name']});
 assert.deepEqual(restore.plan.steps[0].body.document.edits,{jonsbo:{values:{},restore:['name']}});
 const single=fixture({managed:true,three:false});
 await assert.rejects(single.plan({scope:'shared',action:'edit',sourceId:'src',fields:{name:'越权'}}),{code:'FORBIDDEN'});
 await assert.rejects(single.plan({scope:'shop',action:'create_special',fields:{name:'特殊项'}}),{code:'INVALID_PARAMS'});
});
test('独享恢复成本表和软删除沿用正式版本/引用限制，未知字段不可注入',async()=>{
 const f=fixture({manual:true,tracked:false});
 const {plan}=await f.plan({action:'edit',sourceId:'src',resumeTax:true});
 assert.equal(plan.steps[1].body.changes[0].fields.tax,6);assert.equal(plan.steps[1].action,'tax_resume');
 await f.agent.apply(f.job(plan));assert.equal(f.env.data.intel.cost.nasManualTax,false);
 f.env.templates=[{document:{configs:[{parts:[{sourceId:'src'}]}]}}];
 await assert.rejects(f.plan({action:'archive',sourceId:'src'}),{code:'CATALOG_IN_USE'});
 f.env.templates=[];
 const archived=(await f.plan({action:'archive',sourceId:'src'})).plan;
 await f.agent.apply(f.job(archived));
 const restored=(await f.plan({action:'restore',sourceId:'src'})).plan;
 await f.agent.apply(f.job(restored));assert(!f.env.data.intel.source.document.deletedAt);
 await assert.rejects(f.plan({action:'edit',sourceId:'src',fields:{owner_shop:'shared'}}),{code:'INVALID_PARAMS'});
 await assert.rejects(f.plan({action:'edit',sourceId:'src',fields:{addon:{addonChoices:[{id:'x',enabled:true,label:'升',goodsId:'77',token:'秘密'}]}}}),{code:'INVALID_PARAMS'});
});
test('ERP 建源严格核验当前观察，单店 adopt_erp 与三店 create 走真实接口合同',async()=>{
 const f=fixture({tracked:false});
 const request={action:'adopt_erp',goodsId:'77',fields:{name:'测试新源'}};
 f.env.failErp=true;await assert.rejects(f.plan(request),{code:'ERP_UNAVAILABLE'});
 f.env.failErp=false;f.env.erpName='已排除*!';await assert.rejects(f.plan(request),{code:'SOURCE_EXCLUDED'});
 f.env.erpName='正常商品';
 const single=(await f.plan(request)).plan;assert.equal(single.steps[0].body.document.erpAdoption.tableTax,7);
 await f.agent.apply(f.job(single));
 const shared=(await f.plan({...request,scope:'shared'})).plan;
 assert.equal(shared.steps[0].body.document.taxMode,'default_table');assert.equal(shared.steps.length,1);
 await f.agent.apply(f.job(shared));
 const special=(await f.plan({action:'create_special',scope:'shared',fields:{name:'无独显'}})).plan;
 assert.match(special.steps[0].resourceId,/^special:/);await f.agent.apply(f.job(special));
});

test('只为 NAS 证明本店独占的旧来源补齐 shopId，并拒绝外店标签与无法恢复的旧归档文档',async()=>{
 const f=fixture({tracked:false});delete f.env.data.intel.source.document.shopId;
 const edit=(await f.plan({action:'edit',sourceId:'src',fields:{name:'补齐旧资料'}})).plan;
 assert.equal(edit.steps[0].body.document.shopId,'intel');
 const archive=(await f.plan({action:'archive',sourceId:'src'})).plan;
 assert.deepEqual(archive.steps.map(s=>s.action),['replace','archive']);assert.equal(archive.steps[1].body.expected_version,'3');
 f.env.data.intel.source.document.deletedAt='2026-10-01';
 await assert.rejects(f.plan({action:'restore',sourceId:'src'}),{code:'LEGACY_SOURCE_SHOP_MISSING'});
 f.env.data.intel.source.document.shopId='gigabyte';
 await assert.rejects(f.plan({action:'edit',sourceId:'src',fields:{name:'错误店铺'}}),{code:'INVALID_API_RESPONSE'});
});
test('仅提供结构化加购自动生成跟随展示文案，预览冻结原请求',async()=>{
 const f=fixture({tracked:false});
 const fields={addon:{addonChoices:[{id:'a',label:'扩展',goodsId:'',enabled:true,qty:1}]}};
 const {plan}=await f.plan({action:'edit',sourceId:'src',fields});
 assert.equal(plan.steps[0].body.document.addonText,'扩展');
 assert.deepEqual(plan.request.fields,fields);
});
