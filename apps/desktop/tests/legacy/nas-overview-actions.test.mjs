// 全局展示文案、精确依赖和持久进度均使用合成资料验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {globalUpgradeSourceDocument,applyGlobalUpgradeText,verifyOverviewReceipt,prepareOverviewConfigOperation,
 validateOverviewJob,createNasOverviewActions} from '../../public/workbench/nas-overview-actions.js';
import {withCurrentSharedSource} from '../../public/workbench/shared-source-fields.js';
import {followSourceChanges,initializeSourceFollow} from '../../public/workbench/source-follow.js';
import {replaceSourcePart} from '../../public/workbench/source.js';
import {NasApiError} from '../../public/workbench/nas-api-client.js';

const clone=value=>structuredClone(value),shops=['intel','gigabyte','jonsbo'];
const source=()=>({document:{id:'1',common:{addon:{addonText:'原文',addonGoodsId:'2',addonQty:1}},stores:{
 intel:[{sourceId:'s',fields:{addon:{addonText:'来源一',addonGoodsId:'3',addonQty:2}}},
  {sourceId:'s2',fields:{addon:{addonText:'来源二',addonGoodsId:'4',addonQty:8}}}],gigabyte:[],jonsbo:[]}}});
const doc=()=>({id:'c',shopId:'intel',productId:'p',parts:[{sourceId:'s',goodsId:'1',name:'测试配件',slot:'CPU',upgrade:'原文'}],actualParts:[],
 addons:[{sourceId:'s',text:'财务快照',goodsId:'9',qty:2,followPolicy:'snapshot'}]});
const entry=()=>({sourceId:'s',sharedSourceId:'1',shopId:'intel',goodsId:'1',name:'测试配件',addonText:'统一文案',
 addonChoices:[{id:'choice',enabled:true,label:'选配规则保留',goodsId:'',qty:1,originalQty:1,priceCents:null}]});

test('全局加购逐别名保留原商品与数量，不用第一条别名覆盖同店其它来源',()=>{
 const input=source(),result=globalUpgradeSourceDocument(input,'统一');
 assert.deepEqual(result.alias_edits.intel.s.addon,{addonText:'统一',addonGoodsId:'3',addonQty:2});
 assert.deepEqual(result.alias_edits.intel.s2.addon,{addonText:'统一',addonGoodsId:'4',addonQty:8});
 assert.equal(input.document.stores.intel[0].fields.addon.addonText,'来源一');
});

test('现有配置显式跟随顶层加购文案，后续源修改仍更新；新配置保留选配规则和财务快照',()=>{
 const original=doc(),updated=applyGlobalUpgradeText(original,'1','统一文案',[{sourceId:'s'}]);
 assert.deepEqual(updated.addons,original.addons);assert.equal(updated.parts[0].sourceFollow.upgrade.textOnly,true);
 const row=entry();withCurrentSharedSource(updated,new Map([['s',row]]));assert.equal(updated.parts[0].upgrade,'统一文案');
 const later={...row,addonText:'下一次源文案'};
 withCurrentSharedSource(updated,new Map([['s',later]]));assert.equal(updated.parts[0].upgrade,'下一次源文案');
 assert.equal(updated.parts[0].sourceFollow.upgrade.textOnly,true);
 const next=doc();replaceSourcePart(next,0,later);assert.equal(next.parts[0].upgrade,'选配规则保留');
 assert.equal(next.parts[0].sourceFollow.upgrade.textOnly,undefined);
 const plain={...later};delete plain.addonChoices;
 replaceSourcePart(next,0,plain);assert.equal(next.parts[0].upgrade,'下一次源文案');
});

test('原来源增量同步同样保留 textOnly 跟随，不被多选文案覆盖，明确清空也跟随',()=>{
 const row=entry(),updated=applyGlobalUpgradeText(doc(),'1',row.addonText,[{sourceId:'s'}]);
 initializeSourceFollow([updated],[row]);
 const result=followSourceChanges([updated],[row],[{...row,addonText:'新统一文案'}]);
 assert.equal(result.count,1);assert.equal(updated.parts[0].upgrade,'新统一文案');assert.equal(updated.parts[0].sourceFollow.upgrade.textOnly,true);
 followSourceChanges([updated],[{...row,addonText:'新统一文案'}],[{...row,addonText:''}]);
 assert.equal(updated.parts[0].upgrade,'');assert.equal(updated.parts[0].sourceFollow.upgrade.textOnly,true);
});

const fixture=()=>{
 const sourceOp={kind:'source',shop:'intel',id:'1',status:'done',sourceIdsByShop:Object.fromEntries(shops.map(shop=>[shop,['s']])),
  body:{operation_id:randomUUID(),expected_version:'1',document:{id:'1'}}};
 sourceOp.receipt={kind:'shared-sources',shop_id:'intel',resource_id:'1',operation_id:sourceOp.body.operation_id,archived:false,version:'2',
  document:{id:'1',source_versions:Object.fromEntries(shops.map(shop=>[shop,{s:'5'}]))}};
 const configOp={kind:'configs',shop:'intel',status:'ready',sourceIds:['s'],body:{operation_id:randomUUID(),changes:[{
  id:'c',action:'replace',expected_version:'7',document:doc(),dependencies:{sources:{s:'1',unrelated:'9'},costs:{1:'3'}}}]}};
 return {format:1,id:randomUUID(),scope:'scope',operations:[sourceOp,configOp]};
};

test('来源只能接续本计划完整回执里的版本，别人后续修改不能被吸收为新依赖',async()=>{
 const job=fixture(),[sourceOp,configOp]=job.operations;
 await assert.rejects(prepareOverviewConfigOperation(configOp,sourceOp,{resource:async()=>({version:'6'})}),/又被修改/);
 assert.equal(configOp.body.changes[0].dependencies.sources.s,'1');
 await prepareOverviewConfigOperation(configOp,sourceOp,{resource:async()=>({version:'5'})});
 assert.deepEqual(configOp.body.changes[0].dependencies,{sources:{s:'5',unrelated:'9'},costs:{1:'3'}});
 for(const patch of [{version:'9'},{kind:'sources'},{archived:true},{document:{id:'1',source_versions:{intel:{s:'5'}}}}])
  assert.throws(()=>verifyOverviewReceipt(sourceOp,{...sourceOp.receipt,...patch}),/未核实/);
 assert.throws(()=>validateOverviewJob({...job,scope:'another'},'scope'),/无法核验/);
 assert.throws(()=>validateOverviewJob({...job,format:undefined},'scope'),/无法核验/);
});

async function harness(job,{receiptError=null,sourceVersion='5',saveError=null}={}){
 let saved=clone(job),writes=0,sourceWrites=0,lookups=0,refreshes=0;
 const client={catalogReceipt:async()=>{lookups++;if(receiptError)throw receiptError;return clone(job.operations[0].receipt);},
  saveCatalog:async(_kind,_id,_action,body)=>{sourceWrites++;assert.deepEqual(body,job.operations[0].body);if(saveError)throw saveError;return clone(job.operations[0].receipt);},
  resource:async()=>({version:sourceVersion}),workspaceWrite:async(_kind,body)=>{writes++;return {shop_id:'intel',kind:'configurations',
   operation_id:body.operation_id,changes:body.changes.map(c=>({configuration_id:c.id,version:(BigInt(c.expected_version)+1n).toString(),archived:false}))};}};
 const node={addEventListener(){}};
 const previous=globalThis.document;globalThis.document={querySelector:()=>node};
 const actions=createNasOverviewActions({storage:{get:async()=>clone(saved),put:async(_key,value)=>{saved=clone(value);}},
  workspace:{sharedPreviewScope:()=>job.scope,agentAccess:async()=>({client,assertWritable(){},assertDrafts:async()=>{}})},
  lock:()=>()=>{},openDialog(){},closeDialog(){},toast(){},refresh:async()=>{refreshes++;}});
 return {actions,read:()=>clone(saved),writes:()=>writes,sourceWrites:()=>sourceWrites,lookups:()=>lookups,refreshes:()=>refreshes,close(){globalThis.document=previous;}};
}

test('未知回执恢复只确认原批次，后续配置须再次明确继续；重开使用持久正文',async()=>{
 const job=fixture();job.operations[0].status='unknown';
 const h=await harness(job);
 try{
  await h.actions.resume(false);assert.equal(h.lookups(),1);assert.equal(h.writes(),0);
  assert.equal(h.read().operations[0].status,'done');assert.equal(h.read().operations[1].status,'ready');
  await h.actions.resume(false);assert.equal(h.writes(),1);assert.equal(h.refreshes(),1);assert.equal(h.read(),null);
 }finally{h.close();}
});

test('查询未知操作得到404时不自动重发，来源又改版时不发送配置',async()=>{
 const job=fixture();job.operations[0].status='unknown';
 let h=await harness(job,{receiptError:new NasApiError('RECEIPT_NOT_FOUND',404)});
 try{await assert.rejects(h.actions.resume(false));assert.equal(h.writes(),0);assert.equal(h.read().operations[0].status,'unknown');}finally{h.close();}
 h=await harness(fixture(),{sourceVersion:'6'});
 try{await assert.rejects(h.actions.resume(false),/又被修改/);assert.equal(h.writes(),0);assert.equal(h.read().operations[1].status,'ready');}finally{h.close();}
});

test('显式重试先查原回执，再用原编号原正文重放一批，不接着发送后续配置',async()=>{
 const job=fixture();job.operations[0].status='unknown';
 const h=await harness(job,{receiptError:new NasApiError('RECEIPT_NOT_FOUND',404)});
 try{
  await h.actions.resume(true);assert.equal(h.lookups(),1);assert.equal(h.sourceWrites(),1);assert.equal(h.writes(),0);
  assert.equal(h.read().operations[0].status,'done');assert.equal(h.read().operations[1].status,'ready');
 }finally{h.close();}
});

test('未知原号重试遇权限拒绝仍保持未知，只有原版本冲突可结束本次尝试',async()=>{
 for(const [error,status]of [[new NasApiError('FORBIDDEN',403),'unknown'],[new NasApiError('NAS_GLOBAL_UPGRADE_NOT_INSTALLED',503),'unknown'],[new NasApiError('VERSION_CONFLICT',409),'rejected']]){
  const job=fixture();job.operations[0].status='unknown';const body=clone(job.operations[0].body);
  const h=await harness(job,{receiptError:new NasApiError('RECEIPT_NOT_FOUND',404),saveError:error});
  try{await assert.rejects(h.actions.resume(true),{code:error.code});assert.equal(h.read().operations[0].status,status);assert.deepEqual(h.read().operations[0].body,body);assert.equal(h.writes(),0);}finally{h.close();}
 }
});

test('首次全局提交缺少迁移时明确拒绝，不占用未知恢复队列',async()=>{
 const job=fixture();job.operations[0].status='ready';
 const h=await harness(job,{saveError:new NasApiError('NAS_GLOBAL_UPGRADE_NOT_INSTALLED',503)});
 try{await assert.rejects(h.actions.resume(false),{code:'NAS_GLOBAL_UPGRADE_NOT_INSTALLED'});assert.equal(h.read().operations[0].status,'rejected');assert.equal(h.writes(),0);}finally{h.close();}
});

test('完整三店控制器先保存当前输入并接续其回执版本，其他配置保留预览版本',async()=>{
 const previous=globalThis.document,nodes=new Map(),written=[];let currentSaved=false,saved=null,refreshed=0;
 globalThis.document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{addEventListener(){}});return nodes.get(selector);}};
 const shared={version:'1',document:{id:'1',common:{addon:{addonText:'完整来源文案',addonGoodsId:'2',addonQty:2,addonPriceCents:19900}},
  stores:Object.fromEntries(shops.map(shop=>[shop,[{sourceId:'s',fields:{}}]]))}};
 const documentFor=shop=>({...doc(),shopId:shop,name:shop==='intel'&&currentSaved?'刚保存的新名称':'预览原名称'});
 const clients=Object.fromEntries(shops.map(shop=>[shop,{
  workspaceIndex:async()=>({revision:'head',summaries:[]}),workspaceCatalog:async()=>({sourceCatalog:[{sourceId:'s',goodsId:'1'}],costSource:[],costVersions:{}}),sourceUsage:async()=>['c'],
  detail:async()=>({version:shop==='intel'&&currentSaved?'8':'7',document:documentFor(shop),dependencies:{sources:{s:'1'},costs:{1:'3'}}}),
  catalog:async()=>clone(shared),resource:async()=>({version:'5'}),
  saveCatalog:async(_kind,id,_action,body)=>({kind:'shared-sources',shop_id:shop,resource_id:id,operation_id:body.operation_id,archived:false,version:'2',
   document:{id,source_versions:Object.fromEntries(shops.map(id=>[id,{s:'5'}]))}}),
  workspaceWrite:async(_kind,body)=>{written.push({shop,body:clone(body)});return {kind:'configurations',shop_id:shop,operation_id:body.operation_id,
   changes:body.changes.map(row=>({configuration_id:row.id,version:(BigInt(row.expected_version)+1n).toString(),archived:false}))};},
 } ]));
 const actions=createNasOverviewActions({storage:{get:async()=>clone(saved),put:async(_key,value)=>{saved=clone(value);}},
  workspace:{sharedPreviewScope:()=> 'scope',agentAccess:async shop=>({client:clients[shop],assertWritable(){},assertDrafts:async()=>{}})},
  currentDocument:()=>({...documentFor('intel'),parts:documentFor('intel').parts.map(p=>({...p,upgrade:'当前统一文案'}))}),
  saveCurrent:async()=>{currentSaved=true;},esc:String,lock:()=>()=>{},openDialog(){},closeDialog(){},toast:message=>assert.doesNotMatch(message,/失败|未核实|无法/),
  refresh:async()=>{refreshed++;}});
 try{
  await actions.upgrade('c','CPU','all');await nodes.get('#gup-apply').onclick({currentTarget:nodes.get('#gup-apply')});
  assert.equal(written.length,3);assert.equal(refreshed,1);assert.equal(saved,null);
  for(const {shop,body} of written){
   const change=body.changes[0];assert.equal(change.expected_version,shop==='intel'?'8':'7');
   assert.equal(change.document.name,shop==='intel'?'刚保存的新名称':'预览原名称');
   assert.equal(change.document.parts[0].upgrade,'完整来源文案');assert.equal(change.document.parts[0].sourceFollow.upgrade.structured,true);
   assert.equal(change.dependencies.sources.s,'5');assert.equal(change.dependencies.costs['1'],'3');
   assert.equal(change.document.addons[0].goodsId,'2');assert.equal(change.document.addons[0].qty,2);
   assert.equal(change.document.addons[0].priceCents,19900);assert.equal(change.document.addons[0].followAll,true);
  }
 }finally{globalThis.document=previous;}
});
