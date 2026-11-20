// 完整同步的三店 HTTP 验收：实际运行角色、目录事务、配置记录、检查差价和销售报价。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {createNasOverviewActions} from '../../../apps/desktop/public/workbench/nas-overview-actions.js';
import {nasDependencies} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
import {structuredUpgradeSourceDocument,upgradeAddonDefinition} from '../../../apps/desktop/public/workbench/upgrade-addon-sync.js';
import {addonCheck,detachAddonFollow} from '../../../apps/desktop/public/workbench/addon-data.js';
import {withCurrentSharedSource} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {replaceSourcePart} from '../../../apps/desktop/public/workbench/source.js';
const fixture=process.argv[2];if(!fixture)throw Error('请指定合成 SQL fixture 目录');
const shops=['intel','gigabyte','jonsbo'];
test('完整加购同步写入三店，新增配置、后续价格/数量/方案变更与销售输出一致',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'structured-upgrade-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 const previous=globalThis.document,nodes=new Map();let stored=null,refreshed=0;
 globalThis.document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{addEventListener(){}});return nodes.get(selector);}};
 const clients=Object.fromEntries(shops.map(shop=>{const client=createNasApiClient({shopId:shop,nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});client.bindIdentity(fixtureWorkspace,fixtureActor);return [shop,client];}));
 const sourceId='fixture-local',goodsId='100001';
 const call=async(shop,path)=>{const response=await fetch(api.url+'/api/v1/'+path+'?shop_id='+shop,{headers:{'x-workbench-deployment':fixtureDeployment}});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.data;};
 try{
  await api.db.exec(await readFile(new URL('../sql/021-workbench-alias-addons.sql',import.meta.url),'utf8'));
  for(const [index,shop] of shops.entries()){
   await api.db.query(`INSERT INTO ${shop}_live.costs(goodsid,owner_shop,shared,erp,tax,attrs) SELECT id,$1,false,120,120,'{"name":"合成加购商品"}' FROM unnest(ARRAY['100002','100003','100004']) id ON CONFLICT DO NOTHING`,[shop]);
   await api.db.query("UPDATE workbench_sources.aliases SET fields=fields||jsonb_build_object('addon',$2::jsonb) WHERE shop_id=$1 AND entry_id='100001'",[shop,JSON.stringify({addonText:'旧方案'+shop,addonGoodsId:'100003',addonQty:index+1,addonPriceCents:9900})]);
   await api.db.query("SELECT workbench_sources.project('100001',ARRAY[$1::text],now())",[shop]);
  }
  await api.db.query("INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id,fields) VALUES('100001','intel','second-alias',$1)",[JSON.stringify({name:'独立的型号名称',tax:123,addon:{addonText:'第二条旧方案',addonGoodsId:'100004',addonQty:5,addonPriceCents:99000}})]);
  await api.db.query("SELECT workbench_sources.project('100001',ARRAY['intel'],now())");
  const definition={addonText:'【+199元升级双条内存】',addonGoodsId:'100002',addonQty:2,addonOriginalQty:1,addonPriceCents:19900};
  let entry=await clients.intel.catalog('shared-sources',goodsId);
  await clients.intel.saveCatalog('shared-sources',goodsId,'replace',{operation_id:randomUUID(),expected_version:entry.version,
   document:{id:goodsId,edits:{intel:{values:{addon:definition},restore:[]}}}});
  const before=Object.fromEntries(await Promise.all(shops.map(async shop=>[shop,await clients[shop].detail('fixture-overlap')])));
  for(const shop of shops){
   const old=before[shop],document={...old.document,addons:[...old.document.addons,{text:'独立保留',mode:'add',goodsId:'100004',qty:1,priceCents:500,items:[{goodsId:'100004',qty:1}]}]};
   await clients[shop].workspaceWrite('configurations',{operation_id:randomUUID(),changes:[{id:document.id,action:'replace',expected_version:old.version,document,dependencies:await nasDependencies(clients[shop],document,old.dependencies)}]});
   before[shop]=await clients[shop].detail('fixture-overlap');
  }
  const nameBefore=(await clients.intel.resource('sources','second-alias')).document.name;
  const original=before.intel.document;
  const actions=createNasOverviewActions({storage:{get:async()=>structuredClone(stored),put:async(_,value)=>{stored=structuredClone(value);}},
   workspace:{sharedPreviewScope:()=> 'isolated-structured',agentAccess:async shop=>({client:clients[shop],assertWritable(){},assertDrafts:async()=>{}})},
   currentDocument:()=>structuredClone(original),saveCurrent:async()=>{},esc:String,lock:()=>()=>{},openDialog(){},closeDialog(){},
   toast:message=>assert.doesNotMatch(message,/失败|无法|未核实/),refresh:async()=>{refreshed++;}});
  await actions.upgrade(original.id,original.parts[0].slot,'all');await nodes.get('#gup-apply').onclick({currentTarget:{}});
  assert.equal(stored,null);assert.equal(refreshed,1);
  entry=await clients.intel.catalog('shared-sources',goodsId);
  const aliases=entry.document.stores;
  for(const shop of shops)for(const alias of aliases[shop]){
   const source=(await clients[shop].resource('sources',alias.sourceId)).document;
   assert.equal(source.addonGoodsId,'100002');assert.equal(source.addonQty,2);assert.equal(source.addonPriceCents,19900);
  }
  assert.equal((await clients.intel.resource('sources','second-alias')).document.name,nameBefore);
  const versions={};
  for(const shop of shops){
   const current=await clients[shop].detail('fixture-overlap');versions[shop]=current.version;
   assert.deepEqual(current.document.actualParts,before[shop].document.actualParts);assert.equal(current.document.price,before[shop].document.price);
   const synced=current.document.addons.find(a=>a.sourceId===sourceId);assert.equal(synced.followAll,true);assert.equal(synced.qty,2);assert.equal(synced.priceCents,19900);
   const addons=await call(shop,'operations/configurations/fixture-overlap/addons');
   assert.ok(addons.some(a=>a.text==='独立保留'));assert.deepEqual(addons.find(a=>a.sourceId===sourceId).items,[{goodsId:'100002',qty:2}]);
   const catalog=await clients[shop].workspaceCatalog(),check=addonCheck(addons.find(a=>a.sourceId===sourceId),catalog.costSource,[...current.document.actualParts,...current.document.parts]);
   assert.equal(check.fields[0].costCents,24000);
   await api.db.query(`INSERT INTO ${shop}_live.publications(configuration_id,published) VALUES('fixture-overlap',true) ON CONFLICT(configuration_id) DO UPDATE SET published=true`);
   const offers=await call(shop,'sales/configurations/fixture-overlap/addons');
   assert.ok(offers.some(a=>a.additional_price_cents==='19900'&&a.items[0].goodsid==='100002'&&a.items[0].qty===2),JSON.stringify(offers));
  }
  // 后续改成另一件商品、另一数量并增加方案，无需重写配置，销售仍读当前源定义。
  const next={...definition,addonText:'后续完整方案',addonGoodsId:'100003',addonQty:3,addonPriceCents:29900,addonShowTogether:true,
   addonVariants:[{variantId:'extra',text:'额外升级方案',goodsId:'100004',qty:2,priceCents:39900,originalQty:1,showTogether:true}]};
  entry=await clients.intel.catalog('shared-sources',goodsId);
  await clients.intel.saveCatalog('shared-sources',goodsId,'replace',{operation_id:randomUUID(),expected_version:entry.version,document:structuredUpgradeSourceDocument(entry,upgradeAddonDefinition(next))});
  for(const shop of shops){const detail=await clients[shop].detail('fixture-overlap');assert.equal(detail.version,versions[shop]);
   const offers=await call(shop,'sales/configurations/fixture-overlap/addons');assert.ok(offers.some(a=>a.additional_price_cents==='29900'&&a.items[0].goodsid==='100003'&&a.items[0].qty===3));
   assert.ok(offers.some(a=>a.additional_price_cents==='39900'&&a.items[0].goodsid==='100004'&&a.items[0].qty===2));
   assert.equal(offers.find(a=>a.additional_price_cents==='29900').description,'后续完整方案');
   assert.equal(offers.find(a=>a.additional_price_cents==='39900').description,'额外升级方案');}
  // 新配置选到该输出源时，真实加购项也必须保存，不能只有展示说明。
  const source=(await clients.intel.resource('sources',sourceId)).document,latest=await clients.intel.detail('fixture-overlap');
  const created={...structuredClone(latest.document),id:randomUUID(),skuId:'',addons:[]};replaceSourcePart(created,0,source);
  await clients.intel.workspaceWrite('configurations',{operation_id:randomUUID(),changes:[{id:created.id,action:'create',document:created,dependencies:await nasDependencies(clients.intel,created)}]});
  const loaded=await clients.intel.detail(created.id);assert.equal(loaded.document.addons.find(a=>a.sourceId===sourceId).followAll,true);
  assert.equal(loaded.effective_addons.filter(a=>a.addon.sourceId===sourceId).length,2);
  // 明确退出跟随及移除的结果必须同时反映在数据库、销售和工作台上。
  const current=await clients.intel.detail('fixture-overlap'),snapshot=structuredClone(current.document);
  snapshot.addons=current.effective_addons.map(row=>row.addon);detachAddonFollow(snapshot,sourceId);
  await clients.intel.workspaceWrite('configurations',{operation_id:randomUUID(),changes:[{id:snapshot.id,action:'replace',expected_version:current.version,document:snapshot,dependencies:await nasDependencies(clients.intel,snapshot,current.dependencies)}]});
  assert.ok((await clients.intel.detail(snapshot.id)).document.addons.filter(a=>a.sourceId===sourceId).every(a=>a.followPolicy==='snapshot'&&!a.followAll));
  const after=await clients.intel.detail(snapshot.id),removed=structuredClone(after.document);removed.addons=removed.addons.filter(a=>a.sourceId!==sourceId);detachAddonFollow(removed,sourceId);
  await clients.intel.workspaceWrite('configurations',{operation_id:randomUUID(),changes:[{id:removed.id,action:'replace',expected_version:after.version,document:removed,dependencies:after.dependencies}]});
  const result=await clients.intel.detail(removed.id);withCurrentSharedSource(result.document,new Map([[sourceId,source]]));assert.equal(result.document.addons.filter(a=>a.sourceId===sourceId).length,0);
  assert.equal((await call('intel','sales/configurations/fixture-overlap/addons')).length,1);
 }finally{globalThis.document=previous;await api.close();}
});
