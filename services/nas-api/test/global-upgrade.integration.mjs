// 同店多别名的真实三店结构验证；仅使用显式合成 fixture 和内存 PostgreSQL。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {globalUpgradeSourceDocument,applyGlobalUpgradeText} from '../../../apps/desktop/public/workbench/nas-overview-actions.js';
import {withCurrentSharedSource} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {replaceSourcePart} from '../../../apps/desktop/public/workbench/source.js';

const fixture=process.argv[2];if(!fixture)throw Error('请指定合成三店 SQL fixture 目录');
test('全局加购保留同店每条别名规则，回执冻结来源版本，配置文本独立跟随',async()=>{
 const errors=[];
 const api=await startSourceAcceptance({fixture,root:join(fixture,'global-upgrade-test-uploads'),
  authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace}),verifyError:error=>errors.push(error.message)});
 const call=async(shop,path,{body,method=body?'POST':'GET',status=200}={})=>{
  const response=await fetch(api.url+'/api/v1/operations/'+path+'?shop_id='+shop,{method,
   headers:{'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify({result,errors}));return result.data??result.error;
 };
 try{
  const first={addonText:'第一条原文',addonGoodsId:'100002',addonQty:2,addonPriceCents:900};
  const second={addonText:'第二条原文',addonGoodsId:'100003',addonQty:5,addonPriceCents:1900};
  await api.db.query("UPDATE workbench_sources.aliases SET fields=fields||jsonb_build_object('addon',$1::jsonb) WHERE entry_id='100001' AND shop_id='intel'",[JSON.stringify(first)]);
  await api.db.query("INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id,fields) VALUES('100001','intel','fixture-second',$1)",[JSON.stringify({addon:second})]);
  await api.db.query("SELECT workbench_sources.project('100001',ARRAY['intel','gigabyte','jonsbo'],now())");
  let source=await call('intel','catalog/shared-sources/100001');
  const body={operation_id:randomUUID(),expected_version:source.version,document:globalUpgradeSourceDocument(source,'三店统一文案')};
  assert.equal(await call('intel','catalog/shared-sources/100001',{body,method:'PUT',status:503}),'NAS_GLOBAL_UPGRADE_NOT_INSTALLED');
  const sql=await readFile(new URL('../sql/021-workbench-alias-addons.sql',import.meta.url),'utf8');await api.db.exec(sql);await api.db.exec(sql);
  const receipt=await call('intel','catalog/shared-sources/100001',{body,method:'PUT'});
  assert.deepEqual(await call('intel','catalog/shared-sources/100001',{body,method:'PUT'}),receipt);
  assert.deepEqual(await call('intel','catalog/receipts/'+body.operation_id),receipt);
  const versions=receipt.document.source_versions;
  assert.equal(Object.keys(versions.intel).length,2);
  for(const [id,expected] of [['fixture-local',first],['fixture-second',second]]){
   const current=await call('intel','sources/'+id);assert.equal(current.document.addonText,'三店统一文案');
   assert.equal(current.document.addonGoodsId,expected.addonGoodsId);assert.equal(current.document.addonQty,expected.addonQty);
   assert.equal(current.document.addonPriceCents,expected.addonPriceCents);assert.equal(current.version,versions.intel[id]);
  }
  const baseline=await call('intel','configurations/fixture-overlap');
  source=await call('intel','catalog/shared-sources/100001');
  const document=applyGlobalUpgradeText(baseline.document,'100001','三店统一文案',source.document.stores.intel);
  const dependencies=structuredClone(baseline.dependencies);
  for(const id of Object.keys(dependencies.sources))if(versions.intel[id])dependencies.sources[id]=versions.intel[id];
  const saved=await call('intel','workspace/configurations',{body:{operation_id:randomUUID(),changes:[{id:document.id,action:'replace',
   expected_version:baseline.version,document,dependencies}]}});
  assert.ok(saved.changes.length);
  const loaded=(await call('intel','configurations/fixture-overlap')).document;
  assert.equal(loaded.parts[0].sourceFollow.upgrade.textOnly,true);
  // 别人随后再修改源的顶层文案，既有配置仍明确跟随；原回执版本不能漂移。
  const nextDocument=globalUpgradeSourceDocument(source,'来源后续文案');
  const next=await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:source.version,document:nextDocument}});
  const currentSource=(await call('intel','sources/fixture-local')).document;
  withCurrentSharedSource(loaded,new Map([['fixture-local',currentSource]]));assert.equal(loaded.parts[0].upgrade,'来源后续文案');
  assert.notEqual(next.document.source_versions.intel['fixture-local'],versions.intel['fixture-local']);
  const fresh={parts:[{slot:'CPU'}],actualParts:[],addons:[]};replaceSourcePart(fresh,0,currentSource);
  assert.equal(fresh.parts[0].upgrade,'来源后续文案');
  // 普通来源维护继续修改共用文案时，带独立商品规则的各别名仍跟随文案；原来继承共用商品的来源继续继承。
  const managed=await call('intel','catalog/shared-sources/100001');
  await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:managed.version,
   document:{id:'100001',edits:{shared:{values:{addon:{...managed.document.common.addon,addonText:'共用维护再次改文案',addonGoodsId:'100004',addonQty:6}},restore:[]}}}}});
  const allSources=await Promise.all(['fixture-local','fixture-second'].map(id=>call('intel','sources/'+id)));
  assert.deepEqual(allSources.map(row=>row.document.addonText),['共用维护再次改文案','共用维护再次改文案']);
  assert.deepEqual(allSources.map(row=>row.document.addonGoodsId),['100002','100003']);
  assert.equal((await call('gigabyte','sources/fixture-local')).document.addonGoodsId,'100004');
  withCurrentSharedSource(loaded,new Map([['fixture-local',allSources[0].document]]));assert.equal(loaded.parts[0].upgrade,'共用维护再次改文案');
  const listed=await call('intel','catalog/shared-sources/100001');
  assert.ok(listed.document.stores.intel.every(alias=>alias.fields.addon.addonText==='共用维护再次改文案'));
  // 明确单店改文案会解除该店的共用文本继承；后续共用维护不能覆盖它。
  await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:listed.version,
   document:{id:'100001',edits:{intel:{values:{addon:{...first,addonText:'本店明确文案'}},restore:[]}}}}});
  const scoped=await call('intel','catalog/shared-sources/100001');
  await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:scoped.version,
   document:{id:'100001',edits:{shared:{values:{addon:{...scoped.document.common.addon,addonText:'共用第三次文案'}},restore:[]}}}}});
  assert.equal((await call('intel','sources/fixture-local')).document.addonText,'本店明确文案');
  assert.equal((await call('gigabyte','sources/fixture-local')).document.addonText,'共用第三次文案');
  // 单店只改名称时原加购不能因 JSON 运算顺序丢失，所有未编辑字段应保留。
  const fieldsBefore=await call('intel','sources/fixture-local'),nameEntry=await call('intel','catalog/shared-sources/100001');
  await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:nameEntry.version,
   document:{id:'100001',edits:{intel:{values:{name:'单店仅修改名称'},restore:[]}}}}});
  const fieldsAfter=await call('intel','sources/fixture-local');
  for(const key of ['addonText','addonGoodsId','addonPriceCents','addonQty','addonChoices','capacityOverrides','hardwareOverrides','tax'])assert.deepEqual(fieldsAfter.document[key],fieldsBefore.document[key],key);
  assert.equal(fieldsAfter.document.name,'单店仅修改名称');
  const invalid={...nextDocument,alias_edits:{intel:{missing:{addon:{addonText:'无效来源'}}}}};
  const latest=await call('intel','catalog/shared-sources/100001');
  assert.equal(await call('intel','catalog/shared-sources/100001',{method:'PUT',status:409,body:{operation_id:randomUUID(),expected_version:latest.version,document:invalid}}),'SHARED_SOURCE_VALUE_REQUIRED');
  assert.equal((await call('intel','catalog/shared-sources/100001')).version,latest.version);
 }finally{await api.close();}
});
