/** 合成三店集成：只改变关联来源/成本时自动接续，同配置并发保存仍严格拒绝。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {createNasDraftController,nasDependencies} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
const fixture=process.argv[2];if(!fixture)throw Error('请指定合成 fixture 目录');
const memory=()=>{const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
test('三店真实 HTTP：旧草稿、成本/来源更新、跟随新增加购、同配置并发与无效来源',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'dependency-integration-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 try{
  for(const shopId of ['intel','gigabyte','jonsbo']){
   const client=createNasApiClient({shopId,nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});
   client.bindIdentity(fixtureWorkspace,fixtureActor);
   const id='fixture-overlap',storage=memory(),build=()=>createNasDraftController({client,storage,shopId,endpointId:'integration'});
   const a=build();await a.open(id);const old=a.read();a.edit({...old.document,name:'本机仅修改文案'});
   await api.db.query(`UPDATE ${shopId}_live.costs SET erp=erp+1,version=version+1 WHERE goodsid='100001'`);
   await api.db.query(`UPDATE ${shopId}_live.sources SET version=version+1,attrs=attrs||'{"deletedAt":"2026-11-24T00:00:00Z"}' WHERE source_id='fixture-local'`);
   assert.equal((await client.detail(id)).version,old.version);
   const reopened=build();await reopened.open(id);const receipt=await reopened.save();assert.equal(receipt.dependenciesRefreshed,true);
   assert.equal((await client.detail(id)).document.name,'本机仅修改文案');assert.equal(storage.length,0);
   // 新增跟随组后，来源再新增商品；依赖计算必须包括来源展开的最新商品。
   await api.db.query(`INSERT INTO ${shopId}_live.costs(goodsid,owner_shop,shared,erp,tax,attrs) VALUES('9900553',$1,false,30,31,'{}')`,[shopId]);
   await api.db.query(`UPDATE ${shopId}_live.sources SET version=version+1,attrs=attrs-'deletedAt'||'{"addonText":"新跟随方案","addonGoodsId":"9900553","addonPriceCents":9900,"addonQty":1}' WHERE source_id='fixture-local'`);
   const current=await client.detail(id),document={...current.document,addons:[{sourceId:'fixture-local',followPolicy:'follow',followAll:true,text:'',items:[]}]};
   const dependencies=await nasDependencies(client,document,current.dependencies);assert.ok(dependencies.costs['9900553']);
   await client.save('replace',id,{operation_id:crypto.randomUUID(),expected_version:current.version,document,dependencies:await nasDependencies(client,document)});
   const concurrent=build();await concurrent.open(id);concurrent.edit({...concurrent.read().document,name:'A 的草稿'});
   const b=await client.detail(id);await client.save('replace',id,{operation_id:crypto.randomUUID(),expected_version:b.version,dependencies:b.dependencies,document:{...b.document,name:'B 已保存'}});
   await api.db.query(`UPDATE ${shopId}_live.costs SET version=version+1,erp=erp+1 WHERE goodsid='100001'`);
   await assert.rejects(concurrent.save(),{code:'VERSION_CONFLICT'});assert.equal((await client.detail(id)).document.name,'B 已保存');assert.equal(concurrent.read().document.name,'A 的草稿');
   const otherStorage=memory();
   const fresh=createNasDraftController({client,storage:otherStorage,shopId,endpointId:'invalid'});await fresh.open(id);
   fresh.edit({...fresh.read().document,parts:[...fresh.read().document.parts,{lineId:'new-invalid',slot:'内存',name:'归档来源',goodsId:'',qty:1,sourceId:'invalid-archived'}]});
   await api.db.query(`INSERT INTO ${shopId}_live.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES('invalid-archived',$1,false,'','归档来源','{"deletedAt":"2026-11-24T00:00:00Z"}')`,[shopId]);
   await assert.rejects(fresh.save(),{code:'INVALID_DEPENDENCY'});assert.equal(fresh.read().pending,null);
  }
 }finally{await api.close();}
});
