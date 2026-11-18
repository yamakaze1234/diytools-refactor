// 对生成的合成正式 SQL 做 HTTP 验收。仅使用进程内 PGlite，不能连接现网。
// 用法：node test/production-three-api.integration.mjs <sql-fixture>
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {PNG} from 'pngjs';
import {Fault} from '../src/config.mjs';
import {serve} from '../src/http.mjs';
import {LiveStore} from '../src/live-store.mjs';
import {scopedDatabase} from '../src/shop-scope.mjs';
import {combineImageHandlers,createImageHandler} from '../src/images.mjs';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 SQL 验收目录');

test('正式三店 HTTP：固定身份、同名配置与回执、目录、报价、成本、历史和权限撤销',async()=>{
 const bootstrap=new PGlite();
 let db,server;
 try{
  await bootstrap.exec('CREATE DATABASE diy_workbench');
  db=new PGlite({loadDataDir:await bootstrap.dumpDataDir(),database:'diy_workbench'});
  for(const name of ['intel-fixture.sql','gigabyte/02-gigabyte-import.sql','jonsbo/02-jonsbo-import.sql','access/04-install-three-operations-private.sql'])
   await db.exec(await readFile(join(fixture,name),'utf8'));
  let pending=Promise.resolve();
  // PGlite 是同一个本地连接，串行借用即可在每次查询和事务中按真实权限角色执行。
  const underRole=(shop,work)=>{
   const previous=pending;
   const next=previous.then(()=>work('diy_api_'+shop+'_production'));
   pending=next.catch(()=>{});
   return next;
  };
  const poolFor=shop=>({
   query(sql,args){return underRole(shop,async role=>{
    await db.exec('BEGIN; SET LOCAL ROLE '+role);
    try{return await db.query(sql,args);}finally{await db.exec('ROLLBACK');}
   });},
   connect(){
    return new Promise((resolve,reject)=>{
     underRole(shop,role=>new Promise(release=>{
      resolve({async query(sql,args){
       if(sql.startsWith('BEGIN')){
        await db.exec(sql);
        return db.exec('SET LOCAL ROLE '+role);
       }
       return db.query(sql,args);
      },release});
     })).catch(reject);
    });
   }
  });
  const databases=new Map(['intel','gigabyte','jonsbo'].map(shop=>[shop,scopedDatabase(poolFor(shop),shop)]));
  const uploads=[];
  const stores=new Map([...databases].map(([shop,db])=>[shop,new LiveStore(db,
   {shopId:shop,writable:true,catalogWritable:true,workspaceWritable:true,writeImage:async image=>uploads.push([shop,image.uri])})]));
  const serveImage=combineImageHandlers(['gigabyte','jonsbo'].map(shop=>createImageHandler(databases.get(shop),join(fixture,shop+'-source','assets'))));
  const user='fixture_existing01',legacy='fixture_legacy03',other='fixture_verified02',disabled='fixture_disabled04';
  server=serve({shopStores:stores,serveImage,deploymentId:'intel-production-fixture',
   authenticate:async header=>{
    const uid=header?.slice(7);
    if(![user,legacy,other,disabled].includes(uid))throw new Fault('UNAUTHENTICATED',401);
    return {uid,workspaceId:'workbench-main'};
   }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,url=origin+'/api/v1';
  const call=async(path,{shop,uid=user,method='GET',body=null,status=200,query={}}={})=>{
   const params=new URLSearchParams({...query,...(shop?{shop_id:shop}:{})});
   const res=await fetch(url+path+(params.size?'?'+params:''),{method,headers:{authorization:'Bearer '+uid,'x-workbench-deployment':'intel-production-fixture',
    'content-type':'application/json'},body:body===null?undefined:JSON.stringify(body)});
   const value=await res.json();
   assert.equal(res.status,status,JSON.stringify({path,shop,value}));
   return value.ok?(Object.hasOwn(value,'data')?value.data:value):value;
  };
  const route='/operations/configurations/fixture-overlap';
  const me=await call('/me');
  assert.deepEqual(me.shops.map(row=>row.shop_id),['intel','gigabyte','jonsbo']);
  assert.equal(me.shop_capabilities.gigabyte.data_source,'gigabyte_live');
  assert.deepEqual((await call('/me',{uid:legacy})).shops.map(row=>row.shop_id),['intel']);
  await call('/me',{uid:disabled,status:403});
  await call(route,{shop:'gigabyte',uid:legacy,status:403});
  const operation=randomUUID(),receipt='/operations/save-receipts/'+operation;
  for(const shop of ['gigabyte','jonsbo']){
   const detail=await call(route,{shop});
   assert.equal(detail.document.shopId,shop);
   await call(receipt,{shop,status:404});
   const result=await call(route,{shop,method:'PUT',body:{operation_id:operation,expected_version:detail.version,dependencies:detail.dependencies,
    document:{...detail.document,name:'隔离验证 '+shop,actualParts:detail.document.parts.map(part=>({...part,tax:13}))}}});
   assert.equal(result.shop_id,shop);
   assert.deepEqual(await call(receipt,{shop}),result);
   await call(receipt,{shop,uid:other,status:404});
   await call(receipt,{status:404});
  }
  const appliedId=randomUUID();
  for(const shop of ['gigabyte','jonsbo']){
   const current=await call(route,{shop});
   assert.equal(current.document.name,'隔离验证 '+shop);
   await call(route,{shop,method:'PUT',status:400,body:{operation_id:randomUUID(),expected_version:current.version,dependencies:current.dependencies,
    document:{...current.document,shopId:'intel'}}});
   const shared=await call('/operations/catalog/sources/fixture-shared',{shop});
   assert.equal(shared.editable,false);
   await call('/operations/catalog/sources/fixture-shared/archive',{shop,method:'POST',status:403,
    body:{operation_id:randomUUID(),expected_version:shared.version}});
   const local=await call('/operations/catalog/sources/fixture-local',{shop});
   assert.equal(local.editable,true);
   await call('/operations/catalog/sources/fixture-local',{shop,method:'PUT',body:{operation_id:randomUUID(),expected_version:local.version,
    document:{...local.document,name:'本店来源 '+shop}}});
   const publication=await call('/operations/workspace/quotations',{shop,method:'POST',status:403,
    body:{operation_id:randomUUID(),changes:[{id:current.document.id,action:'publish',expected_version:current.version}]}});
   assert.equal(publication.error,'SALES_PUBLICATION_DISABLED');
   const archived=await call(route+'/archive',{shop,method:'POST',body:{operation_id:randomUUID(),expected_version:current.version}});
   assert.equal(archived.archived,true);
   await call(route,{shop,status:404});
   assert.equal((await call(route,{shop,query:{archived:'true'}})).archived,true);
   const restored=await call(route+'/restore',{shop,method:'POST',body:{operation_id:randomUUID(),expected_version:archived.version}});
   assert.equal(restored.archived,false);
   const quote=await call('/operations/workspace/quotations',{shop,method:'POST',body:{operation_id:randomUUID(),
    changes:[{id:current.document.id,action:'select_workbook',expected_version:restored.version,spu:'98765',sku:'12345',
     amount_cents:'269900',workbook_sha256:'f'.repeat(64),workbook_row:2}]}});
   assert.equal(quote.changes[0].published,false);
   const amount=await call('/operations/workspace/quotations/fixture-overlap',{shop});
   assert.equal(amount.amount_cents,'269900');
   const template=await call('/operations/catalog/templates/fixture-template',{shop});
   const applied=await call('/operations/catalog/templates/fixture-template/apply',{shop,method:'POST',
    body:{operation_id:randomUUID(),expected_version:template.version,target_product_id:'fixture-link',target_configuration_id:current.document.id,
     expected_target_version:quote.changes[0].version,selection:[{source_id:'fixture-overlap',id:appliedId}]}});
   assert.deepEqual(applied.document.configuration_ids,[appliedId]);
   assert.equal((await call('/operations/configurations/'+appliedId,{shop})).document.shopId,shop);
   const cost=await call('/operations/workspace/costs',{shop,method:'POST',body:{operation_id:randomUUID(),
    changes:[{id:'100001',action:'tax_edit',expected_version:'1',fields:{tax:shop==='gigabyte'?20:30}}]}});
   assert.equal(cost.changes[0].version,'2');
   const priceList=await call('/operations/workspace/price-history/list',{shop,method:'POST',body:{}});
   assert.equal(priceList.batches.length,1);
   const priceDetail=await call('/operations/workspace/price-history/detail',{shop,method:'POST',body:{revision:priceList.batches[0].revision}});
   assert.equal(priceDetail.configs[0].after.shopId,shop);
   const gallery=await call('/operations/gallery/fixture-gallery',{shop});
   const sha=gallery.document.url.split('/').at(-1).split('.')[0];
   const expectedBytes=await readFile(join(fixture,shop+'-source','assets',sha));
   const publicImage=await fetch(origin+gallery.document.url);
   assert.equal(publicImage.status,200);assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()),expectedBytes);
   const png=PNG.sync.write({width:1,height:1,data:Buffer.from([100,120,150,255])});
   const upload=await fetch(url+'/operations/catalog/assets?shop_id='+shop+'&operation_id='+randomUUID(),{method:'POST',
    headers:{authorization:'Bearer '+user,'x-workbench-deployment':'intel-production-fixture','content-type':'image/png'},body:png});
   const uploaded=await upload.json();assert.equal(upload.status,201,JSON.stringify(uploaded));
   assert.equal(uploaded.data.shop_id,shop);
   assert.equal(uploaded.data.document.sha256,createHash('sha256').update(png).digest('hex'));
   const activity=await call('/operations/workspace/activity',{shop,query:{page:'0',page_size:'30'}});
   assert(activity.rows.some(row=>row.action==='restore'));
   assert.deepEqual(await call('/operations/workspace/profit/history',{shop,method:'POST',body:{shopId:shop}}),{runs:[]});
   const run=await call('/operations/workspace/profit/start',{shop,method:'POST',body:{shopId:shop,requestId:randomUUID(),configIds:[current.document.id]}});
   assert(run.runId);
   assert.equal((await call('/operations/workspace/profit/history',{shop,method:'POST',body:{shopId:shop}})).runs[0].shop_id,shop);
  }
  assert.deepEqual(uploads.map(([shop])=>shop),['gigabyte','jonsbo']);assert.equal(uploads[0][1],uploads[1][1]);
  for(const shop of ['gigabyte','jonsbo']){
   assert.equal((await call('/operations/catalog/sources/fixture-local',{shop})).document.name,'本店来源 '+shop);
   assert.equal((await call('/operations/costs/100001',{shop})).document.tax,shop==='gigabyte'?20:30);
  }
  await pending;
  await db.query("UPDATE nas_business.members SET enabled=false WHERE workspace_id='workbench-main' AND uid=$1",[user]);
  await call('/me',{status:403});
  await call(route,{shop:'jonsbo',status:403});
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await db?.close();
  await bootstrap.close();
 }
});
