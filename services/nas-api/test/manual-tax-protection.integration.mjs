// 隔离三店数据验证输出源维护与全局改价均按手动核算价受保护，不被成本表同步覆盖。
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient,nasShopIds} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {planSharedCostSync} from '../../../apps/desktop/public/workbench/nas-cost-overlay.js';
import {applySharedTaxEdit} from '../../../apps/desktop/public/workbench/shared-source-editor.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成三店 SQL fixture 目录');
const migration=name=>readFile(new URL('../sql/'+name,import.meta.url),'utf8');

test('输出源维护与全局改价均默认受手动核算价保护，同步成本表时保留，恢复后重新跟随',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'manual-tax-protection-uploads'),
  verifyError:error=>{if(!['P0001','42883'].includes(error.code))console.error(error.code,error.message,error.detail,error.where);},
  authenticate:async header=>({uid:header?.slice(7)||fixtureActor,workspaceId:fixtureWorkspace})});
 const client=shopId=>{
  const c=createNasApiClient({shopId,nativeRequest:(path,options)=>
   fetch(api.url+path,{...options,headers:{...options.headers,authorization:'Bearer '+fixtureActor,'x-workbench-deployment':fixtureDeployment}})});
  c.bindIdentity(fixtureWorkspace,fixtureActor);
  return c;
 };
 const stores=Object.fromEntries(nasShopIds.map(shop=>[shop,client(shop)]));
 const intel=stores.intel;

 async function syncTax(rows){
  const snapshot=await intel.costSyncSnapshot();
  const plan=planSharedCostSync(snapshot,rows,'tax-file','intel');
  if(plan.changes.length)await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:plan.changes});
  return plan;
 }
 async function saveSource(id,edits){
  const entry=await intel.catalog('shared-sources',id);
  return intel.saveCatalog('shared-sources',id,'replace',{
   operation_id:randomUUID(),expected_version:entry.version,document:{id,edits},
  });
 }
 async function globalTax(id,fields){
  const costs=Object.fromEntries(await Promise.all(nasShopIds.map(async shop=>[shop,await stores[shop].resource('costs',id)])));
  return intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:[{
   id,action:'global_tax',expected_version:costs.intel.version,
   expected_versions:Object.fromEntries(nasShopIds.map(shop=>[shop,costs[shop].version])),fields,
  }]});
 }
 async function resumeShopTax(shop,id,tax){
  const current=await stores[shop].resource('costs',id);
  return stores[shop].workspaceWrite('costs',{operation_id:randomUUID(),changes:[{
   id,action:'tax_resume',expected_version:current.version,fields:{tax,taxUpdatedAt:new Date().toISOString()},
  }]});
 }

 try{
  for(const name of [
   '020-workbench-global-tax.sql',
   '021-workbench-alias-addons.sql',
   '027-quotation-identity-invalidation.sql',
   '028-cross-shop-cost-sync.sql',
   '029-manual-tax-protection.sql',
   '029-manual-tax-protection.sql', // 幂等重复安装
  ])await api.db.exec(await migration(name));

  // 先用成本表把 100001 在三店统一成非手动基线价 100。
  await syncTax([{goods_id:'100001',tax:100}]);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,100);
   assert.equal(document.nasManualTax,false);
  }

  // 1) 输出源维护仅改名称/颜色，未改核算价 -> 不得误标手动价，后续成本表同步仍更新。
  await saveSource('100001',{intel:{values:{name:'只改名称不改价','hardwareOverrides.color':'黑'},restore:[]}});
  assert.equal((await stores.intel.resource('costs','100001')).document.nasManualTax,false);
  await syncTax([{goods_id:'100001',tax:110}]);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,110);
   assert.equal(document.nasManualTax,false);
  }

  // 2) 输出源维护单店改核算价（如总表「修改输出源」或单店编辑）-> 本店标为手动价，另两店正常同步。
  await saveSource('100001',{intel:{values:{tax:145},restore:[]}});
  assert.equal((await stores.intel.resource('costs','100001')).document.nasManualTax,true);
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.nasManualTax,false);
  const singleSync=await syncTax([{goods_id:'100001',tax:160}]);
  assert.deepEqual(singleSync.protectedRows,[{goodsId:'100001',shop:'英特尔',before:145,after:160}]);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,shop==='intel'?145:160);
   assert.equal(document.nasManualTax,shop==='intel');
  }

  // 3) 在单店输出源维护点「恢复共用」（此时共用价为成本表同步价 160）-> 解除手动保护并重新跟随成本表。
  await saveSource('100001',{intel:{values:{},restore:['tax']}});
  assert.equal((await stores.intel.resource('costs','100001')).document.tax,160);
  assert.equal((await stores.intel.resource('costs','100001')).document.nasManualTax,false);
  await syncTax([{goods_id:'100001',tax:175}]);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,175);
   assert.equal(document.nasManualTax,false);
  }

  // 4) 输出源维护「三店共用」修改核算价（哪怕与当前价同为 175 或改为 180）-> 三店全部标为手动价，同步成本表全保留。
  await saveSource('100001',applySharedTaxEdit({},175));
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,175);
   assert.equal(document.nasManualTax,true);
  }
  // 4b) 在共用手动价期间仅改单店名称 -> 手动保护保持不变。
  await saveSource('100001',{gigabyte:{values:{name:'共用手动价后只改名称'},restore:[]}});
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.nasManualTax,true);
  // 4c) 单店先覆盖再恢复到人工共用价 -> 仍沿用其他兄弟店的共用手动保护。
  await saveSource('100001',{jonsbo:{values:{tax:188},restore:[]}});
  await saveSource('100001',{jonsbo:{values:{},restore:['tax']}});
  assert.equal((await stores.jonsbo.resource('costs','100001')).document.tax,175);
  assert.equal((await stores.jonsbo.resource('costs','100001')).document.nasManualTax,true);
  // 4d) 同步成本表（195）-> 三店全部受保护保留 175，共用基线更新为 195。
  const sharedSync=await syncTax([{goods_id:'100001',tax:195}]);
  assert.equal(sharedSync.protectedRows.length,3);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,175);
   assert.equal(document.nasManualTax,true);
  }
  const afterSharedSync=await intel.costSyncSnapshot();
  assert.equal(afterSharedSync.common['100001'].tax,195);
  assert.deepEqual(afterSharedSync.common['100001'].overrideShops.sort(),['gigabyte','intel','jonsbo']);

  // 5) 在「当前店铺核算价」对单店点「重新同步核算价」（tax_resume）-> 仅该店恢复跟随，另两店仍受保护。
  await resumeShopTax('intel','100001',195);
  assert.equal((await stores.intel.resource('costs','100001')).document.nasManualTax,false);
  await syncTax([{goods_id:'100001',tax:200}]);
  assert.equal((await stores.intel.resource('costs','100001')).document.tax,200);
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.tax,175);
  assert.equal((await stores.jonsbo.resource('costs','100001')).document.tax,175);

  // 6) 输出源维护清空核算价为待核算（tax: null）-> 不应锁成手动价，下次成本表同步可补价。
  await saveSource('100001',{gigabyte:{values:{tax:null},restore:[]}});
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.tax,null);
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.nasManualTax,false);
  await syncTax([{goods_id:'100001',tax:202}]);
  assert.equal((await stores.intel.resource('costs','100001')).document.tax,202);
  assert.equal((await stores.gigabyte.resource('costs','100001')).document.tax,202);
  assert.equal((await stores.jonsbo.resource('costs','100001')).document.tax,175);

  // 7) 总表「应用到全局核算价」与「全局恢复」：
  // 此时 intel=202(自动), gigabyte=202(自动), jonsbo=175(手动)。
  await globalTax('100001',{tax:230});
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,230);
   assert.equal(document.nasManualTax,true);
   assert.equal(document.globalTax.base,shop==='jonsbo'?175:202);
   assert.equal(document.globalTax.baseManual,shop==='jonsbo');
  }
  // 连续二次全局改价仍保留首次 base 与 baseManual。
  await globalTax('100001',{tax:240});
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,240);
   assert.equal(document.nasManualTax,true);
   assert.equal(document.globalTax.base,shop==='jonsbo'?175:202);
   assert.equal(document.globalTax.baseManual,shop==='jonsbo');
  }
  // 同步成本表（215）-> 三店全部受保护保持 240，globalTax 标记完好保留。
  const globalSync=await syncTax([{goods_id:'100001',tax:215}]);
  assert.equal(globalSync.protectedRows.length,3);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,240);
   assert.equal(document.nasManualTax,true);
   assert.equal(document.globalTax.value,240);
  }
  // 执行「全局恢复」-> 三店恢复各自原价与原手动状态（intel/gigabyte 回到自动同步，jonsbo 维持手动）。
  await globalTax('100001',{restore:true});
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,shop==='jonsbo'?175:202);
   assert.equal(document.nasManualTax,shop==='jonsbo');
   assert.equal(document.globalTax,undefined);
  }
  // 再次同步成本表（218）-> intel/gigabyte 恢复跟随更新为 218，jonsbo 仍保留原手动价 175。
  const postRestoreSync=await syncTax([{goods_id:'100001',tax:218}]);
  assert.deepEqual(postRestoreSync.protectedRows,[{goodsId:'100001',shop:'乔思伯',before:175,after:218}]);
  for(const shop of nasShopIds){
   const {document}=await stores[shop].resource('costs','100001');
   assert.equal(document.tax,shop==='jonsbo'?175:218);
   assert.equal(document.nasManualTax,shop==='jonsbo');
  }

  // 8) 新增输出源：填了数字核算价受保护，留空待核算不锁手动。
  await intel.saveCatalog('shared-sources','9900881','create',{
   operation_id:randomUUID(),document:{id:'9900881',edits:{shared:{values:{name:'新建带价配件',tax:320},restore:[]}}},
  });
  await intel.saveCatalog('shared-sources','9900882','create',{
   operation_id:randomUUID(),document:{id:'9900882',edits:{shared:{values:{name:'新建留空配件',tax:null},restore:[]}}},
  });
  const createSync=await syncTax([{goods_id:'9900881',tax:350},{goods_id:'9900882',tax:360}]);
  assert.equal(createSync.protectedRows.filter(row=>row.goodsId==='9900881').length,3);
  assert.equal(createSync.protectedRows.filter(row=>row.goodsId==='9900882').length,0);
  for(const shop of nasShopIds){
   assert.equal((await stores[shop].resource('costs','9900881')).document.tax,320);
   assert.equal((await stores[shop].resource('costs','9900881')).document.nasManualTax,true);
   assert.equal((await stores[shop].resource('costs','9900882')).document.tax,360);
   assert.equal((await stores[shop].resource('costs','9900882')).document.nasManualTax,false);
  }

  // 9) 普通运行角色不能直接调用内部投影函数。
  await api.db.exec('BEGIN; SET LOCAL ROLE diy_api_intel_production');
  await assert.rejects(
   api.db.query("SELECT workbench_sources.project_with_tax_mode('100001',ARRAY['intel'],now(),NULL,ARRAY['intel'],ARRAY[]::text[])"),
   /permission denied/
  );
  await api.db.exec('ROLLBACK');
 }finally{await api.close();}
});
