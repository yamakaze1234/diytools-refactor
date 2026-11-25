// 合成三店数据验证单店权限、事务失败、原回执以及换码后按新编码核价。
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient,nasShopIds} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {planSharedCostSync,sharedCostGoods} from '../../../apps/desktop/public/workbench/nas-cost-overlay.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 fixture 目录');
const localOperator='fixture_legacy03',configId='fixture-overlap';
const migration=name=>readFile(new URL('../sql/'+name,import.meta.url),'utf8');

test('三店成本与 ERP 同步、手动价保护及旧报价原子失效',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'cost-sync-uploads'),verifyError:error=>{if(!['P0001','42883'].includes(error.code))console.error(error.code,error.message,error.detail,error.where);},authenticate:async header=>({
  uid:header?.slice(7)||fixtureActor,workspaceId:fixtureWorkspace,
 })});
 const client=(shopId,uid=fixtureActor)=>createNasApiClient({shopId,nativeRequest:(path,options)=>
  fetch(api.url+path,{...options,headers:{...options.headers,authorization:'Bearer '+uid,'x-workbench-deployment':fixtureDeployment}})});
 const intel=client('intel',localOperator);
 const shopClients=Object.fromEntries(nasShopIds.map(shop=>[shop,client(shop)]));
 let current=await intel.detail(configId);
 const replace=(doc,dependencies=current.dependencies)=>intel.save('replace',configId,{
  operation_id:randomUUID(),expected_version:current.version,dependencies,document:doc,
 });
 const chosen=(apiClient,body)=>apiClient.workspaceWrite('quotations',{operation_id:randomUUID(),changes:[{
  id:configId,action:'select_workbook',expected_version:body.version,spu:body.document.spu,sku:body.document.skuId,
  amount_cents:'280000',workbook_sha256:'e'.repeat(64),workbook_row:12
 }]});
 try{
  // 没装迁移时旧报价保护仍生效。
  await assert.rejects(intel.costSyncSnapshot(),{code:'NAS_COST_SYNC_NOT_INSTALLED'});
  await assert.rejects(replace({...current.document,skuId:'12346'}),{code:'QUOTATION_REVIEW_REQUIRED'});
  assert.equal((await intel.me()).shops.filter(row=>row.role==='operations').map(row=>row.shop_id).join(','),'intel');
  await assert.rejects(client('gigabyte',localOperator).costSyncSnapshot(),{code:'FORBIDDEN'});
  await api.db.exec(await migration('027-quotation-identity-invalidation.sql'));
  await api.db.exec(await migration('028-cross-shop-cost-sync.sql'));
  // 已装旧 028 但未装 030，回执保护必须回滚三店写入。
  const oldSchema=await intel.costSyncSnapshot();
  const oldPlan=planSharedCostSync(oldSchema,[{goodsId:'100001',name:'测试',sku:'A',erp:1,stockAvailable:-1,stockIncomingAvailable:2}],'erp','intel');
  await assert.rejects(intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:oldPlan.changes}),{code:'NAS_COST_SYNC_NOT_INSTALLED'});
  assert.deepEqual(await intel.costSyncSnapshot(),oldSchema);
  // 重复安装不重建任何业务记录。
  for(let i=0;i<2;i++)await api.db.exec(await migration('030-incoming-stock.sql'));

  // 建源初次写入成本行时也保留独立的最终可销、待入可销。
  const newId='9901234';
  await shopClients.intel.saveCatalog('shared-sources',newId,'create',{operation_id:randomUUID(),document:{
   id:newId,name:'新配件',erpAdoption:{name:'新品',erp:99,sku:'A01',stockAvailable:-2,stockIncomingAvailable:8}}});
  const adopted=await shopClients.intel.resource('costs',newId);
  assert.deepEqual([adopted.document.stockAvailable,adopted.document.stockIncomingAvailable],[-2,8]);

  await chosen(intel,current);
  current=await intel.detail(configId);
  await intel.workspaceWrite('quotations',{operation_id:randomUUID(),changes:[{
   id:configId,action:'publish',expected_version:current.version
  }]});
  current=await intel.detail(configId);
  const updated={...current.document,skuId:'12346',spu:'98766'};
  await assert.rejects(replace(updated,{...current.dependencies,costs:{'100001':'999'}}),{code:'DEPENDENCY_CONFLICT'});
  let quote=await intel.quotation(configId);
  assert.equal(quote.amount_cents,'280000');assert.equal(quote.published,true);
  await replace(updated);
  current=await intel.detail(configId);
  assert.deepEqual([current.document.spu,current.document.skuId],['98766','12346']);
  quote=await intel.quotation(configId);
  assert.equal(quote.amount_cents,null);assert.equal(quote.published,false);
  assert.equal((await api.db.query("SELECT status FROM intel_live.quotations WHERE configuration_id='fixture-overlap'")).rows[0].status,'unmatched');
  assert.equal((await api.db.query("SELECT 1 FROM intel_live.intel_quotation_overrides WHERE configuration_id='fixture-overlap'")).rows.length,0);
  await chosen(intel,current);
  assert.equal((await intel.quotation(configId)).amount_cents,'280000');
  assert.deepEqual((await shopClients.gigabyte.detail(configId)).document.skuId,'12345');

  // 模拟同货号一个店已是新价、另两店保留旧价和手动覆盖，另一个货号只存在技嘉。
  await api.db.exec(`
   UPDATE workbench_sources.entries SET fields=fields||'{"tax":980}'::jsonb WHERE id='100001';
   UPDATE workbench_sources.aliases SET fields=fields||'{"tax":1100}'::jsonb,legacy=legacy||'["tax"]'::jsonb
      WHERE entry_id='100001' AND shop_id<>'intel';
   INSERT INTO intel_live.intel_cost_overrides(goodsid,document,version)
      VALUES('100001','{"goodsId":"100001","tax":980,"erp":12,"nasTaxOverride":true}',2)
      ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version;
   INSERT INTO gigabyte_live.intel_cost_overrides(goodsid,document,version)
      VALUES('100001','{"goodsId":"100001","tax":1100,"erp":21,"nasTaxOverride":true}',2),
            ('9900059','{"goodsId":"9900059","tax":49,"erp":50}',1)
      ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version;
   INSERT INTO jonsbo_live.intel_cost_overrides(goodsid,document,version)
      VALUES('100001','{"goodsId":"100001","tax":1030,"erp":31,"nasTaxOverride":true,"nasManualTax":true}',2)
      ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version;
  `);
  const snapshot=await intel.costSyncSnapshot();
  assert(sharedCostGoods(snapshot).includes('9900059'));
  const prices=[{goods_id:'100001',tax:980},{goods_id:'9900059',tax:59}];
  const plan=planSharedCostSync(snapshot,prices,'tax-file','intel');
  assert.deepEqual(plan.changes.map(row=>row.id),['100001','9900059']);
  assert.deepEqual(plan.protectedRows,[{goodsId:'100001',shop:'乔思伯',before:1030,after:980}]);
  const stale=structuredClone(plan.changes);stale[1].expected_versions.gigabyte='900';
  await assert.rejects(intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:stale}),
   error=>error.code==='VERSION_CONFLICT'&&error.details.goods_id==='9900059');
  assert.deepEqual(await intel.costSyncSnapshot(),snapshot,'第二项冲突应撤回第一项及共用输出源变化');
  const body={operation_id:randomUUID(),changes:plan.changes};
  const result=await intel.workspaceWrite('costs',body);
  assert.deepEqual(await intel.workspaceWrite('costs',body),result);
  assert.deepEqual(await intel.workspaceReceipt(body.operation_id),result);
  for(const shop of nasShopIds){
   const cost=await shopClients[shop].resource('costs','100001'),onlyOne=await shopClients[shop].resource('costs','9900059');
   assert.equal(cost.document.tax,shop==='jonsbo'?1030:980);
   assert.equal(onlyOne.document.tax,59);
  }
  const after=await intel.costSyncSnapshot();
  assert.equal(after.common['100001'].tax,980);
  assert.deepEqual(after.common['100001'].overrideShops,['jonsbo']);
  assert(after.stores.jonsbo['100001'].manual);
  const noChanges=planSharedCostSync(after,prices,'tax-file','intel');
  assert.equal(noChanges.changes.length,0);
  assert.equal(noChanges.protectedRows.length,1);
  const changedCommon=planSharedCostSync(after,[{goods_id:'100001',tax:960}],'tax-file','intel');
  await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:changedCommon.changes});
  const reread=await intel.costSyncSnapshot();
  assert.equal(reread.common['100001'].tax,960);
  assert.equal(reread.stores.jonsbo['100001'].tax,1030);
  const erp=planSharedCostSync(reread,[{goodsId:'9900059',erp:null,stockAvailable:0,sku:'987',name:'ERP 配件'},
   {goodsId:'100001',erp:45,stockAvailable:-2,stockIncomingAvailable:13,sku:'654',name:'ERP 核对'}],'erp','intel');
  await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:erp.changes});
  for(const shop of nasShopIds){
   const {document}=await shopClients[shop].resource('costs','100001');
   const missing=await shopClients[shop].resource('costs','9900059');
   assert.deepEqual([document.tax,document.erp,document.stockAvailable,document.stockIncomingAvailable,document.nasManualTax===true],
    [shop==='jonsbo'?1030:960,45,-2,13,shop==='jonsbo']);
   assert.deepEqual([missing.document.tax,missing.document.erp,missing.document.stockAvailable,missing.document.erpUnknown],[59,null,0,true]);
   const activity=await shopClients[shop].activity();
   assert(activity.some(row=>row.action==='erp_sync'));
  }
  // 只有待入变动时也要生成计划，并在三店回读到同一数值。
  const update={goodsId:'100001',name:'ERP 核对',sku:'654',erp:45,stockAvailable:-2,stockIncomingAvailable:-1};
  const beforeIncoming=await intel.costSyncSnapshot();
  for(const shop of nasShopIds)assert.equal(beforeIncoming.stores[shop]['100001'].stockIncomingAvailable,13);
  const incomingPlan=planSharedCostSync(beforeIncoming,[update],'erp','intel');
  const invalid=structuredClone(incomingPlan.changes);
  invalid[0].fields.stockIncomingAvailable='-1';
  await assert.rejects(intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:invalid}),{code:'VALIDATION_FAILED'});
  await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:incomingPlan.changes});
  const afterIncoming=await intel.costSyncSnapshot();
  for(const shop of nasShopIds)assert.equal(afterIncoming.stores[shop]['100001'].stockIncomingAvailable,-1);
  assert.equal(planSharedCostSync(afterIncoming,[update],'erp','intel').changes.length,0);
 }finally{await api.close();}
});
