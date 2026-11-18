// 使用正式三店结构和权限角色检查共用保存、回执、旧引用及各店覆盖。
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {planSharedSources} from '../tools/install-shared-sources.mjs';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
const shops=['intel','gigabyte','jonsbo'];

test('迁移只在值、身份和版本都与人工证据吻合时选定最近值',()=>{
 const rows=shops.map((shop_id,i)=>({shop_id,source_id:'equal-id',source_version:'1',cost_edited:false,
  document:{goodsId:'1',name:'待合并'+i,tax:i===0?10:20}}));
 const history={records:[{goodsId:'1',aliases:shops.map(shop=>({shop,sourceId:'equal-id'})),fields:{
  name:{status:'latest-manual',value:'待合并2',perShop:Object.fromEntries(rows.map(r=>[r.shop_id,{current:r.document.name}]))},
 }}]};
 let [plan]=planSharedSources(rows,history);
 assert.equal(plan.common.name,'待合并2');
 assert.equal(Object.hasOwn(plan.common,'tax'),false);
 assert.deepEqual(plan.stores.map(alias=>alias.fields.tax),[10,20,20]);
 rows[1].source_version='2';
 [plan]=planSharedSources(rows,history);
 assert.equal(Object.hasOwn(plan.common,'name'),false);
 assert.equal(plan.stores[1].fields.name,'待合并1');
 assert.deepEqual(plan.stores.map(alias=>alias.source_id),['equal-id','equal-id','equal-id']);
});

test('实际 HTTP 和数据库事务保留历史、处理共用、覆盖与恢复',async()=>{
 const errors=[];
 const api=await startSourceAcceptance({fixture,root:join(fixture,'shared-integration-uploads'),authenticate:async header=>
  ({uid:header||fixtureActor,workspaceId:fixtureWorkspace}),verifyError:error=>errors.push(error.message)});
 const paths={
  catalog:'catalog/shared-sources',
  sources:'catalog/sources',
  costs:'costs',
  receipt:'catalog/receipts',
 };
 async function request(shop,path,expected,{body,method=body?'POST':'GET',actor=fixtureActor}={}){
  const res=await fetch(api.url+'/api/v1/operations/'+path+'?shop_id='+shop,{method,
   headers:{'x-workbench-deployment':fixtureDeployment,authorization:actor,'content-type':'application/json'},
   body:body?JSON.stringify(body):undefined});
  const value=await res.json();
  assert.equal(res.status,expected,JSON.stringify({value,errors}));
  return value.data??value.error;
 }
 async function write(id,version,edits,{shop='intel',expect=version?200:201,op=randomUUID(),actor}={}){
  return request(shop,paths.catalog+(version?'/'+id:''),expect,{method:version?'PUT':'POST',actor,
   body:{operation_id:op,...(version?{expected_version:version}:{}),document:{id,edits}}});
 }
 const change=(values={},restore=[])=>({values,restore});
 try{
  const history=await request('intel',paths.catalog+'/9900011',200);
  assert.equal(Object.hasOwn(history.document.common,'tax'),false);
  assert.deepEqual(shops.map(shop=>history.document.stores[shop][0].fields.tax),[220,230,240]);
  let receipt=await write('9900011',history.version,{shared:change({tax:250})});
  for (const [index,shop] of shops.entries()){
   assert.equal((await request(shop,paths.costs+'/9900011',200)).document.tax,220+10*index);
  }
  receipt=await write('9900011',receipt.version,{gigabyte:change({},['tax'])});
  assert.equal((await request('gigabyte',paths.costs+'/9900011',200)).document.tax,250);
  assert.equal((await request('intel',paths.costs+'/9900011',200)).document.tax,220);
  const before=await request('intel',paths.catalog+'/100001',200);
  const original=await request('intel','configurations/fixture-overlap',200);
  const choices=[{id:'one',enabled:true,goodsId:'',label:'可咨询客服加购',qty:1,originalQty:1,priceCents:null}];
  const values={tax:25,addon:{addonChoices:choices,addonText:choices[0].label},'hardwareOverrides.cpuName':'测试简称'};
  receipt=await write('100001',before.version,{shared:change(values),jonsbo:change({tax:27})});
  const latest=await request('intel',paths.catalog+'/100001',200);
  assert.deepEqual(latest.document.common.addon.addonChoices,choices);
  for (const shop of shops){
   const projected=await request(shop,paths.sources+'/fixture-local',200);
   assert.equal(projected.document.hardwareOverrides.cpuName,'测试简称');
   assert.deepEqual(projected.document.addonChoices,choices);
   assert.equal((await request(shop,paths.costs+'/100001',200)).document.tax,shop==='jonsbo'?27:25);
  }
  const snapshot=await request('intel','configurations/fixture-overlap',200);
  assert.equal(snapshot.document.parts[0].sourceId,'fixture-local');
  assert.deepEqual(snapshot.document,original.document);
  assert.equal(await write('100001',before.version,{shared:change({tax:40})},{expect:409}),'VERSION_CONFLICT');
  // 旧成本入口同样只能改本店，并且会进入单店覆盖。
  const cost=await request('gigabyte',paths.costs+'/100001',200);
  await request('gigabyte','workspace/costs',200,{body:{operation_id:randomUUID(),
   changes:[{id:'100001',action:'tax_edit',expected_version:cost.version,fields:{tax:28,taxUpdatedAt:new Date().toISOString()}}]}});
  const merged=await request('intel',paths.catalog+'/100001',200);
  assert.equal(merged.document.stores.gigabyte[0].fields.tax,28);
  assert.equal(merged.document.common.tax,25);
  assert.equal(await write('100001',merged.version,{shared:change({tax:999}),gigabyte:change({},['name'])},{expect:409}),
   'SHARED_SOURCE_VALUE_REQUIRED');
  assert.equal((await request('intel',paths.costs+'/100001',200)).document.tax,25);
  const op=randomUUID(),newEdit={shared:change({name:'测试 48GB 内存',tax:456.01})};
  receipt=await write('9900013',null,newEdit,{op});
  assert.deepEqual(await write('9900013',null,newEdit,{op}),receipt);
  assert.deepEqual(await request('intel',paths.receipt+'/'+op,200),receipt);
  for (const shop of shops){
   assert.equal((await request(shop,paths.sources+'/shared-src:9900013',200)).document.name,'测试 48GB 内存');
   assert.equal((await request(shop,paths.costs+'/9900013',200)).document.tax,456.01);
  }
  const current=await request('intel',paths.catalog+'/9900013',200);
  await api.db.query("UPDATE nas_business.members SET enabled=false WHERE workspace_id=$1 AND uid=$2",[fixtureWorkspace,fixtureActor]);
  assert.equal(await write('9900013',current.version,{shared:change({tax:10})},{expect:403}),'FORBIDDEN');
 }finally{await api.close();}
});
