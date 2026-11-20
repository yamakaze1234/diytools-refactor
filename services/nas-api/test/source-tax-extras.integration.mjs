// 只使用合成三店 fixture，重现旧店铺覆盖遮住共用价，并验证图底部文案真实保存。
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {applySharedTaxEdit} from '../../../apps/desktop/public/workbench/shared-source-editor.js';
import {visibleNasCosts} from '../../../apps/desktop/public/workbench/nas-cost-overlay.js';
import {addPosterExtra,editPosterExtra} from '../../../apps/desktop/public/workbench/config-extras.js';
import {nasDependencies} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
const fixture=process.argv[2];if(!fixture)throw Error('请指定合成 fixture 目录');
test('来源共用改价解除旧tax覆盖，三店来源/成本生效，独立配置价及图底部文字保存正确',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'source-tax-extras-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 const shops=['intel','gigabyte','jonsbo'],clients=Object.fromEntries(shops.map(shop=>{const client=createNasApiClient({shopId:shop,nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});client.bindIdentity(fixtureWorkspace,fixtureActor);return [shop,client];}));
 try{
  // 三店各自有名称、加购与价格覆盖；另加同店第二来源验证成本不再因多旧价而跳过。
  for(const [index,shop] of shops.entries()){
   await api.db.query("UPDATE workbench_sources.aliases SET fields=fields||$2::jsonb WHERE entry_id='100001' AND shop_id=$1",[shop,JSON.stringify({tax:1290+index*10,name:'本店原名称-'+shop,addon:{addonText:'原加购-'+shop,addonGoodsId:'100001',addonQty:2,addonPriceCents:9900}})]);
   await api.db.query("SELECT workbench_sources.project('100001',ARRAY[$1::text],now())",[shop]);
  }
  await api.db.query("INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id,fields) VALUES('100001','intel','second-tax-alias',$1)",[JSON.stringify({name:'同店另一历史来源',tax:1280})]);
  await api.db.query("SELECT workbench_sources.project('100001',ARRAY['intel'],now())");
  let entry=await clients.intel.catalog('shared-sources','100001');
  await clients.intel.saveCatalog('shared-sources','100001','replace',{operation_id:randomUUID(),expected_version:entry.version,document:{id:'100001',edits:{shared:{values:{tax:1320},restore:[]}}}});
  assert.equal((await clients.intel.resource('sources','fixture-local')).document.tax,1290,'旧流程：共用价1320被店铺1290遮住');
  entry=await clients.intel.catalog('shared-sources','100001');const before=entry.document,raw=await clients.intel.detail('fixture-overlap');
  // 即使共同字段本来就为1320，明确再次应用也必须解除旧覆盖。
  await clients.intel.saveCatalog('shared-sources','100001','replace',{operation_id:randomUUID(),expected_version:entry.version,document:{id:'100001',edits:applySharedTaxEdit({},1320)}});
  const after=await clients.intel.catalog('shared-sources','100001');
  for(const shop of shops){
   const source=await clients[shop].resource('sources','fixture-local'),cost=await clients[shop].resource('costs','100001');
   assert.equal(source.document.tax,1320);assert.equal(cost.document.tax,1320);
   assert.equal(source.document.name,'本店原名称-'+shop);assert.equal(source.document.addonText,'原加购-'+shop);
   for(const alias of after.document.stores[shop]){assert.ok(!Object.hasOwn(alias.fields,'tax'));const prior=before.stores[shop].find(row=>row.sourceId===alias.sourceId);for(const key of ['name','addon'])assert.deepEqual(alias.fields[key],prior.fields[key]);}
  }
  const unchanged=await clients.intel.detail('fixture-overlap');assert.deepEqual(unchanged.document,raw.document);
  const cost=(await clients.intel.resource('costs','100001')).document,view=structuredClone(raw.document);
  visibleNasCosts(view,new Map([['100001',cost]]));assert.equal(view.actualParts.find(part=>part.goodsId==='100001').tax,1320);
  const independent=structuredClone(raw.document),part=independent.actualParts.find(part=>part.goodsId==='100001');part.taxOverride={goodsId:'100001',value:777};part.tax=777;
  visibleNasCosts(independent,new Map([['100001',cost]]));assert.equal(part.tax,777);assert.equal(part.taxOverride.value,777);
  const document=structuredClone(unchanged.document);addPosterExtra(document,'addons');const i=document.addons.length-1;
  editPosterExtra(document,'addons',i,'text','【豪华颜值升级 +399元 联系客服加购】');editPosterExtra(document,'addons',i,'note','X400CG新款\n神光同步 | 流光溢彩');
  addPosterExtra(document,'benefits');editPosterExtra(document,'benefits',document.benefits.length-1,'text','专属装机测试\n售后支持');
  await clients.intel.workspaceWrite('configurations',{operation_id:randomUUID(),changes:[{id:document.id,action:'replace',expected_version:unchanged.version,document,dependencies:await nasDependencies(clients.intel,document,unchanged.dependencies)}]});
  const saved=await clients.intel.detail(document.id);assert.equal(saved.document.addons.at(-1).text,'【豪华颜值升级 +399元 联系客服加购】');assert.match(saved.document.addons.at(-1).note,/X400CG新款\n神光同步/);assert.match(saved.document.benefits.at(-1).text,/专属装机测试\n售后支持/);
  assert.deepEqual(saved.document.actualParts,raw.document.actualParts);assert.equal(saved.document.price,raw.document.price);
 }finally{await api.close();}
});
