// 删除与编号的隔离 HTTP 验收，仅使用显式 fixture 导入本机 PGlite，不连接正式库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {buildNasOperationPlan,createNasOperationQueue} from '../../../apps/desktop/public/workbench/nas-operation-plan.js';

const fixture=process.argv[2];if(!fixture)throw Error('请指定隔离 SQL fixture 目录');
test('删除首中尾、恢复、幂等回执、冲突回滚及超过100套跨批删除',async()=>{
 const errors=[],api=await startSourceAcceptance({fixture,root:join(fixture,'removal-test-uploads'),
  authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace}),verifyError:error=>errors.push(error.message)});
 const call=async(shop,path,body,status=200)=>{
  const response=await fetch(api.url+'/api/v1/operations/'+path+'?shop_id='+shop,{method:body?'POST':'GET',
   headers:{'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify({value,errors}));return value.data??value.error;
 };
 const batch=(shop,changes,operation_id=randomUUID(),status=200)=>call(shop,'workspace/configurations',{operation_id,changes},status);
 try{
  for(const shop of ['intel','gigabyte','jonsbo']){
   // 每套合成fixture都独立创建三条同链接配置，不依赖历史真实样本的条数和排序。
   const seedIndex=await call(shop,'workspace-index'),seed=await call(shop,'configurations/'+seedIndex.summaries[0].id),product=randomUUID();
   await batch(shop,Array.from({length:3},(_,i)=>{const document={...structuredClone(seed.document),id:randomUUID(),productId:product,name:'配置'+(i+1),skuId:'',spu:'',workspaceOrder:i};return {id:document.id,action:'create',document,dependencies:seed.dependencies};}));
   const index=await call(shop,'workspace-index');
   const rows=index.summaries.filter(row=>row.productId===product).slice(0,3),ids=rows.map(row=>row.id);
   assert.equal(ids.length,3);
   // 明确准备连续编号，价格、SKU、配件及原始排序保持样本原值。
   for(const [i,id] of ids.entries())await api.db.query(`UPDATE ${shop}_live.configurations SET name=$2 WHERE configuration_id=$1`,[id,'配置'+(i+1)]);
   const outside=index.summaries.find(row=>row.productId!==product),outsideBefore=await call(shop,'configurations/'+outside.id);
   for(const position of [0,1,2]){
    const before=await Promise.all(ids.map(id=>call(shop,'configurations/'+id))),target=before[position];
    const body={operation_id:randomUUID(),changes:[{id:target.document.id,action:'archive',expected_version:target.version}]};
    const receipt=await call(shop,'workspace/configurations',body),active=await call(shop,'workspace-index');
    assert.deepEqual(active.summaries.filter(row=>row.productId===product).map(row=>row.name),['配置1','配置2']);
    assert.deepEqual(await call(shop,'workspace/configurations',body),receipt);
    assert.deepEqual(await call(shop,'workspace/receipts/'+body.operation_id),receipt);
    const renamed=receipt.changes.flatMap(row=>row.reordered??[]);
    for(const row of renamed){
     const old=before.find(value=>value.document.id===row.configuration_id),after=await call(shop,'configurations/'+row.configuration_id);
     assert.equal(row.previous_version,old.version);assert.equal(after.version,row.version);
     assert.deepEqual(after.document,{...old.document,name:row.name});
    }
    const audit=await api.db.query(`SELECT resource_id FROM ${shop}_live.workspace_audit WHERE operation_id=$1`,[body.operation_id]);
    assert.equal(audit.rows.length,1+renamed.length);
    const restored=await batch(shop,[{id:target.document.id,action:'restore',expected_version:receipt.changes[0].version}]);
    const result=await call(shop,'workspace-index');assert.deepEqual(result.summaries.filter(row=>row.productId===product).map(row=>[row.id,row.name]),ids.map((id,i)=>[id,'配置'+(i+1)]));
    assert.equal((await call(shop,'configurations/'+target.document.id)).version,restored.changes[0].version);
   }
   const stable=await Promise.all(ids.map(id=>call(shop,'configurations/'+id)));
   assert.equal(await batch(shop,[{id:ids[0],action:'archive',expected_version:stable[0].version},{id:ids[1],action:'archive',expected_version:'999999'}],randomUUID(),409),'VERSION_CONFLICT');
   assert.deepEqual(await call(shop,'configurations/'+ids[0]),stable[0]);
   assert.deepEqual(await call(shop,'configurations/'+outside.id),outsideBefore);
   await api.db.query(`UPDATE ${shop}_live.configurations SET name='颜值升级包' WHERE configuration_id=$1`,[ids[1]]);
   await batch(shop,[{id:ids[0],action:'archive',expected_version:stable[0].version}]);
   assert.equal((await call(shop,'configurations/'+ids[1])).document.name,'颜值升级包');
  }
  // 101套模拟同链接全选，确实经过两次独立 HTTP 事务与前端持久队列。
  const sourceDetail=await call('intel','configurations/'+(await call('intel','workspace-index')).summaries[0].id),source=sourceDetail.document;
  const product=randomUUID(),docs=Array.from({length:101},(_,i)=>({...structuredClone(source),id:randomUUID(),productId:product,
   name:'配置'+(i+1),skuId:'',spu:'',workspaceOrder:i}));
  const makeQueue=()=>{let record=null;return createNasOperationQueue({key:randomUUID(),storage:{get:async()=>structuredClone(record),put:async(_,value)=>{record=structuredClone(value);}},
   client:{workspaceWrite:(_kind,body)=>call('intel','workspace/configurations',body)}});};
  const create=makeQueue();await create.add(buildNasOperationPlan('configurations',docs.map(document=>({id:document.id,action:'create',document,dependencies:sourceDetail.dependencies}))));
  await create.submit();
  const archive=makeQueue();await archive.add(buildNasOperationPlan('configurations',docs.map(document=>({id:document.id,action:'archive',expected_version:'1'}))));
  const completed=await archive.submit();assert.deepEqual(completed.batches.map(row=>row.status),['done','done']);
  assert.equal(completed.batches[1].body.changes[0].expected_version,'2');
  assert.equal((await call('intel','workspace-index')).summaries.filter(row=>row.productId===product).length,0);
 }finally{await api.close();}
});
