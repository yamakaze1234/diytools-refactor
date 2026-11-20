// 合成三店服务验证共用+单店一次创建、原号重放，以及权限不足时整笔无残留。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';
const fixture=process.argv[2];if(!fixture)throw Error('请指定合成 fixture 目录');
test('范围差异原子创建与原号重放，失去三店权限后拒绝整笔新增',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'source-scope-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 const client=createNasApiClient({shopId:'intel',nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});
 client.bindIdentity(fixtureWorkspace,fixtureActor);
 try{
  const id='9900191',document={id,edits:{shared:{values:{name:'共用新品',tax:100,'capacityOverrides.memoryGb':48},restore:[]},intel:{values:{name:'英特尔新品',tax:110},restore:[]},jonsbo:{values:{name:'乔思伯新品','capacityOverrides.memoryGb':64},restore:[]}}};
  const body={operation_id:randomUUID(),document};
  await client.saveCatalog('shared-sources',id,'create',body);
  const first=await client.catalog('shared-sources',id);assert.equal(first.version,'1');
  await client.saveCatalog('shared-sources',id,'create',body);assert.deepEqual(await client.catalog('shared-sources',id),first);
  assert.equal(first.document.common.name,'共用新品');assert.equal(first.document.stores.intel[0].fields.name,'英特尔新品');
  assert.equal(first.document.stores.jonsbo[0].fields['capacityOverrides.memoryGb'],64);assert.equal(first.document.stores.gigabyte[0].fields.name,undefined);
  for(const shop of ['intel','gigabyte','jonsbo']){
   const read=createNasApiClient({shopId:shop,nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});read.bindIdentity(fixtureWorkspace,fixtureActor);
   const row=await read.resource('sources',first.document.stores[shop][0].sourceId);
   assert.equal(row.document.tax,shop==='intel'?110:100);assert.equal(row.document.capacityOverrides.memoryGb,shop==='jonsbo'?64:48);
  }
  await api.db.query('DELETE FROM nas_business.operation_group_shops WHERE workspace_id=$1 AND shop_id=$2',[fixtureWorkspace,'jonsbo']);
  const denied='9900192';await assert.rejects(client.saveCatalog('shared-sources',denied,'create',{operation_id:randomUUID(),document:{...document,id:denied}}),{code:'FORBIDDEN'});
  assert.equal((await api.db.query('SELECT count(*)::int AS n FROM workbench_sources.entries WHERE id=$1',[denied])).rows[0].n,0);
  assert.equal((await api.db.query('SELECT count(*)::int AS n FROM workbench_sources.aliases WHERE entry_id=$1',[denied])).rows[0].n,0);
 }finally{await api.close();}
});
