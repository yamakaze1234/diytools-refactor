/** 输出源写经真实三店 HTTP/SQL 回读。ERP 与原生任务账本由测试提供，所有写入仅进入合成内存库。 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createAgentSources} from '../public/workbench/agent-sources.js';
import {createNasApiClient,nasShopIds} from '../public/workbench/nas-api-client.js';
import {fixtureActor,fixtureWorkspace,fixtureDeployment,startSourceAcceptance} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2],op=()=>crypto.randomUUID();
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成 SQL 夹具目录');
const server=await startSourceAcceptance({fixture,root:join(fixture,'source-lifecycle-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
try{
 for(const name of ['020-workbench-global-tax','021-workbench-alias-addons','027-quotation-identity-invalidation','028-cross-shop-cost-sync',
  '029-manual-tax-protection','030-incoming-stock','031-erp-category','033-source-default-tax-and-erp-name']){
  await server.db.exec(await readFile(new URL('../../../services/nas-api/sql/'+name+'.sql',import.meta.url),'utf8'));
 }
 const clients=new Map(nasShopIds.map(shop=>[shop,createNasApiClient({shopId:shop,nativeRequest:(path,options)=>
  fetch(server.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})})]));
 const intel=clients.get('intel'),goodsIds=['998812','998813'];
 const erpRows=goodsIds.map(goodsId=>({goodsId,name:'合成内存 '+goodsId,erp:42,stockAvailable:4,sku:'',erpCategory:'内存'}));
 let pending=false,online=true,states;
 const workflow=createAgentSources({access:async id=>({client:clients.get(id),assertDrafts:async()=>{}}),
  sourceHasPending:()=>pending,refresh:async()=>true,readErp:async(kind,ids)=>{
   if(!online)throw Error('合成 ERP 离线');
   return kind==='tax-current'?{rows:ids.map(goods_id=>({goods_id,tax:48}))}:{complete:true,rows:erpRows,total:erpRows.length};
  },native:async(action,payload)=>{
   const state=states[payload.stepIndex];
   if(action==='preflight')state.state='submitted';
   else if(action==='step.confirm')Object.assign(state,{state:'confirmed',receipt:payload.receipt});
   else assert.fail(action);
  }});
 const preview=request=>workflow.preview({operationId:op(),request:{shopId:'intel',...request}});
 async function apply(plan){
  states=plan.steps.map((_,index)=>({index,operationId:op(),state:'pending'}));
  return workflow.apply({id:op(),params:{operationId:op(),plan,stepStates:states}});
 }
 const run=async request=>{const {plan}=await preview(request);return apply(plan);};
 const edit=(sourceId,fields,extra={})=>({scope:'shop',action:'edit',sourceId,fields,...extra});
 async function aliases(id,shops){
  const entry=(await intel.catalog('shared-sources',id)).document;
  return Promise.all(shops.map(async shop=>(await clients.get(shop).catalog('sources',entry.stores[shop][0].sourceId)).document));
 }

 // 工作表中的未保存名称不参与预览，同一变更在提交时必须被拦住。
 const local='fixture-cost-history',baseline=await intel.catalog('sources',local);
 pending=true;
 const staged=await preview(edit(local,{name:'工作表并存验收'}));
 assert.equal(staged.summary.workbenchSourceHasPending,true);
 await assert.rejects(apply(staged.plan),{code:'UNSAVED_DRAFT'});
 assert.equal((await intel.catalog('sources',local)).version,baseline.version);
 pending=false;

 const adopt={scope:'shop',action:'adopt_erp',goodsId:goodsIds[0]};
 online=false;await assert.rejects(preview(adopt),{code:'ERP_UNAVAILABLE'});online=true;
 await run(adopt);
 const [adopted]=await aliases(goodsIds[0],['intel']);
 assert.equal(adopted.tax,48);
 assert.ok(!(await clients.get('jonsbo').catalog('sources')).some(row=>row.document.goodsId===goodsIds[0]));
 await run(edit(adopted.sourceId,{tax:69}));
 assert.equal((await intel.resource('costs',goodsIds[0])).document.nasManualTax,true);
 await run({scope:'shop',action:'edit',sourceId:adopted.sourceId,resumeTax:true});
 const restored=(await intel.resource('costs',goodsIds[0])).document;
 assert.equal(restored.tax,48);assert.notEqual(restored.nasManualTax,true);

 await run({scope:'shared',action:'adopt_erp',goodsId:goodsIds[1],fields:{name:'三店共用内存','capacityOverrides.memoryGb':32}});
 const shared=await aliases(goodsIds[1],nasShopIds),intelId=shared[0].sourceId;
 assert.ok(shared.every(row=>row.name==='三店共用内存'&&row.capacityOverrides.memoryGb===32));
 await run(edit(intelId,{name:'英特尔专用名'}));
 assert.deepEqual((await aliases(goodsIds[1],nasShopIds)).map(r=>r.name),['英特尔专用名','三店共用内存','三店共用内存']);
 await run({scope:'shared',action:'edit',sourceId:intelId,restoreFields:['name']});
 assert.ok((await aliases(goodsIds[1],nasShopIds)).every(row=>row.name==='三店共用内存'));

 const special=await preview({scope:'shared',action:'create_special',fields:{name:'无独显验收项'}});
 await apply(special.plan);
 const specialRows=await aliases(special.plan.steps[0].resourceId,nasShopIds);
 assert.ok(specialRows.every(row=>row.specialComponent&&row.goodsId===''&&row.tax===0));
 const archive={scope:'shop',action:'archive',sourceId:local};
 await run(archive);assert.ok((await intel.catalog('sources',local)).document.deletedAt);
 await run({...archive,action:'restore'});assert.ok(!(await intel.catalog('sources',local)).document.deletedAt);
 console.log(JSON.stringify({workbenchPending:true,erpOffline:true,shopAdoption:true,taxResume:true,sharedAdoption:true,restoreField:true,specialStores:3,archiveRestore:true}));
}finally{await server.close();}
