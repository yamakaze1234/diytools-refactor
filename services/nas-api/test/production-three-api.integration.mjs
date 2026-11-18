// 对生成的合成正式 SQL 做 HTTP 验收。仅使用进程内 PGlite，不能连接现网。
// 用法：node test/production-three-api.integration.mjs <sql-fixture> [test-key.pem test-cert.pem]
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {request} from 'node:https';
import {PGlite} from '@electric-sql/pglite';
import {PNG} from 'pngjs';
import {Fault} from '../src/config.mjs';
import {createLocalAuth} from '../src/local-auth.mjs';
import {createHandler,serve} from '../src/http.mjs';
import {LiveStore} from '../src/live-store.mjs';
import {scopedDatabase} from '../src/shop-scope.mjs';
import {combineImageHandlers,createImageHandler,createImageWriter} from '../src/images.mjs';
import {createLanCaseGallery} from '../src/lan-case-gallery.mjs';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 SQL 验收目录');

test('正式三店 HTTP：固定身份、同名配置与回执、目录、报价、成本、历史和权限撤销',async()=>{
 const bootstrap=new PGlite();
 let db,server,galleryServer,outsideServer,authServer;
 try{
  await bootstrap.exec('CREATE DATABASE diy_workbench');
  db=new PGlite({loadDataDir:await bootstrap.dumpDataDir(),database:'diy_workbench'});
  for(const name of ['intel-fixture.sql','gigabyte/02-gigabyte-import.sql','jonsbo/02-jonsbo-import.sql','access/04-install-three-operations-private.sql'])
   await db.exec(await readFile(join(fixture,name),'utf8'));
  const sharedGallerySql=await readFile(new URL('../sql/016-shared-case-gallery.sql',import.meta.url),'utf8');
  await db.exec(sharedGallerySql);
  await db.exec(sharedGallerySql);
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
  const shops=['intel','gigabyte','jonsbo'];
  const databases=new Map(shops.map(shop=>[shop,scopedDatabase(poolFor(shop),shop)]));
  const uploadRoots=new Map(shops.map(shop=>[shop,join(fixture,shop+'-gallery-uploads')]));
  await Promise.all([...uploadRoots.values()].map(root=>mkdir(root,{recursive:true})));
  const uploads=[];
  const stores=new Map([...databases].map(([shop,db])=>[shop,new LiveStore(db,
   {shopId:shop,writable:true,catalogWritable:true,workspaceWritable:true,sharedGallery:true,writeImage:async image=>{
    uploads.push([shop,image.uri]);
    await createImageWriter(uploadRoots.get(shop),null)(image);
   }})]));
  const serveImage=combineImageHandlers(shops.map(shop=>createImageHandler(databases.get(shop),
   shop==='intel'?null:join(fixture,shop+'-source','assets'),uploadRoots.get(shop))));
  const user='fixture_existing01',legacy='fixture_legacy03',other='fixture_verified02',disabled='fixture_disabled04';
  const deps={shopStores:stores,serveImage,deploymentId:'intel-production-fixture',lanGallery:createLanCaseGallery(databases),
   authenticate:async header=>{
    const uid=header?.slice(7);
    if(![user,legacy,other,disabled].includes(uid))throw new Fault('UNAUTHENTICATED',401);
    return {uid,workspaceId:'workbench-main'};
   }};
  server=serve(deps);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,url=origin+'/api/v1';
  const [, , , testKey, testCert]=process.argv;
  const tls=testCert?{key:await readFile(testKey),cert:await readFile(testCert),network:'127.0.0.0',prefix:24}:null;
  // 有测试证书时覆盖真实 TCP/TLS 门禁；无证书也验证同一个路由和真实角色的 SQL。
  galleryServer=tls?serve(deps,tls):createServer(createHandler(deps));
  await new Promise(resolve=>galleryServer.listen(0,'127.0.0.1',resolve));
  const galleryOrigin=(tls?'https:':'http:')+'//127.0.0.1:'+galleryServer.address().port;
  const galleryRequest=async(path,method='GET',headers={},base=galleryOrigin)=>{
   if(!tls){
    const res=await fetch(base+path,{method,headers});
    return {status:res.status,body:Buffer.from(await res.arrayBuffer()),headers:Object.fromEntries(res.headers)};
   }
   return await new Promise((resolve,reject)=>{
    const req=request(base+path,{method,headers,ca:tls.cert},res=>{
     const chunks=[];
     res.on('data',chunk=>chunks.push(chunk));
     res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));
     res.on('error',reject);
    });
    req.on('error',reject);
    req.end();
   });
  };
  const galleryPath='/case-gallery/v1/images';
  if(tls){
   outsideServer=serve(deps,{...tls,network:'192.0.2.0'});
   await new Promise(resolve=>outsideServer.listen(0,'127.0.0.1',resolve));
   const outsideOrigin='https://127.0.0.1:'+outsideServer.address().port;
   assert.equal((await galleryRequest(galleryPath,'GET',{'x-forwarded-for':'192.0.2.20'},outsideOrigin)).status,403);
  }
  const galleryList=async query=>{
   const result=await galleryRequest(galleryPath+'?'+new URLSearchParams(query));
   assert.equal(result.status,200,result.body.toString());
   return JSON.parse(result.body);
  };
  assert.equal((await fetch(origin+galleryPath)).status,404);
  assert.equal((await galleryRequest(galleryPath,'POST')).status,405);
  assert.equal((await galleryRequest(galleryPath+'?shop_id=intel')).status,400);
  assert.equal((await galleryRequest(galleryPath+'?view=categories&limit=3')).status,400);
  assert.equal((await galleryRequest(galleryPath+'?model=A&model=B')).status,400);
  assert.equal((await galleryRequest('/api/v1/me','GET',{'x-workbench-deployment':'intel-production-fixture'})).status,401);
  // 同一份原图模拟跨店重复，仍保留相同机箱分类下的三张不同原图。
  await db.exec(`
   INSERT INTO jonsbo_live.gallery(gallery_id,owner_shop,shared,legacy_uri,brand,model,color,edition,attrs)
    SELECT 'fixture-duplicate','jonsbo',false,legacy_uri,brand,model,color,edition,attrs||'{"hidden":"fixture-internal"}'::jsonb
    FROM intel_live.gallery WHERE gallery_id='fixture-gallery'`);
  const categories=await galleryList({view:'categories',model:'m'});
  assert.equal(categories.imageCount,3);
  assert.deepEqual(categories.categories,[{brand:'测试',models:[{model:'M',colors:[{color:'待分类',editions:['通用']}]}]}]);
  const first=await galleryList({edition:'通用',q:'测试 M',limit:1});
  const rest=await galleryList({edition:'通用',q:'测试 M',cursor:first.nextCursor});
  assert.equal(first.total,3);
  assert.equal(rest.nextCursor,null);
  assert.equal(new Set([...first.items,...rest.items].map(item=>item.id)).size,3);
  assert.deepEqual(Object.keys(first.items[0]),['id','name','brand','model','color','edition','categoryPath','downloadUrl']);
  const galleryAsset=JSON.parse(await readFile(join(fixture,'gigabyte-source','assets.json'),'utf8'))[0];
  const downloadUrl=[...first.items,...rest.items].find(item=>item.downloadUrl.includes(galleryAsset.sha256)).downloadUrl;
  const original=await galleryRequest(downloadUrl);
  assert.equal(original.status,200);
  assert.equal(original.headers['cache-control'],'no-store');
  assert.match(original.headers['content-disposition'],/^attachment;/);
  assert.equal(createHash('sha256').update(original.body).digest('hex'),galleryAsset.sha256);
  const head=await galleryRequest(downloadUrl,'HEAD');
  assert.equal(head.status,200);
  assert.equal(head.body.length,0);
  await db.exec(`UPDATE gigabyte_live.gallery SET attrs=attrs||'{"deletedAt":"2026-11-18T00:00:00.000Z"}'::jsonb
   WHERE gallery_id='fixture-gallery'`);
  assert.equal((await galleryRequest(downloadUrl)).status,404);
  assert.equal((await galleryList({})).total,2);
  assert.equal((await fetch(origin+'/images/'+galleryAsset.sha256+'.png')).status,200);
  await db.exec("UPDATE gigabyte_live.gallery SET attrs=attrs-'deletedAt' WHERE gallery_id='fixture-gallery'");
  const call=async(path,{shop,uid=user,method='GET',body=null,status=200,query={},base=url}={})=>{
   const params=new URLSearchParams({...query,...(shop?{shop_id:shop}:{})});
   const res=await fetch(base+path+(params.size?'?'+params:''),{method,headers:{authorization:'Bearer '+uid,'x-workbench-deployment':'intel-production-fixture',
    'content-type':'application/json'},body:body===null?undefined:JSON.stringify(body)});
   const value=await res.json();
   assert.equal(res.status,status,JSON.stringify({path,shop,value}));
   return value.ok?(Object.hasOwn(value,'data')?value.data:value):value;
  };
  const route='/operations/configurations/fixture-overlap';
  const uploadGalleryImage=async(shop,channel)=>{
   const bytes=PNG.sync.write({width:1,height:1,data:Buffer.from([65,90,channel,255])});
   const response=await fetch(url+'/operations/catalog/assets?shop_id='+shop+'&operation_id='+randomUUID(),{method:'POST',
    headers:{authorization:'Bearer '+user,'x-workbench-deployment':'intel-production-fixture','content-type':'image/png'},body:bytes});
   const result=await response.json();
   assert.equal(response.status,201,JSON.stringify(result));
   assert.equal(result.data.document.sha256,createHash('sha256').update(bytes).digest('hex'));
   return {asset:result.data.document,bytes};
  };
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
  for(const [index,owner] of shops.entries()){
   const [firstShop,secondShop]=shops.filter(shop=>shop!==owner);
   const {asset,bytes}=await uploadGalleryImage(owner,170+index);
   const catalog='/operations/catalog/gallery';
   const id=randomUUID(),item={id,name:'三店共用验证',brand:'测试品牌',model:'共用机箱',color:'白色',edition:owner,url:asset.url};
   assert.equal((await call(catalog,{shop:firstShop})).some(row=>row.document.url===asset.url),false);
   const operation_id=randomUUID();
   const created=await call(catalog,{shop:owner,method:'POST',status:201,body:{operation_id,document:item}});
   assert.equal((await call(catalog,{shop:owner,method:'POST',status:201,body:{operation_id,document:item}})).resource_id,id);
   const own=(await call(catalog,{shop:owner})).find(row=>row.id===id);
   assert.equal(own.editable,true);
   for(const shop of [firstShop,secondShop]){
    const all=await call(catalog,{shop});
    const row=all.find(entry=>entry.document.url===asset.url);
    assert.equal(row.editable,false);
    assert.match(row.id,/^shared-gallery:/);
    assert.equal(row.document.edition,owner);
    const workspace=await call('/operations/workspace-catalog',{shop});
    assert(workspace.caseGallery.some(entry=>entry.id===row.id&&entry.url===asset.url));
    const original=await call('/operations/gallery/'+encodeURIComponent(row.id),{shop});
    const readback=await fetch(origin+original.document.url);
    assert.deepEqual(Buffer.from(await readback.arrayBuffer()),bytes);
    const detail=await call(route,{shop});
    if(shop===firstShop){
     await call('/operations/workspace/configurations',{shop,method:'POST',body:{operation_id:randomUUID(),
      changes:[{id:detail.document.id,action:'replace',expected_version:detail.version,dependencies:detail.dependencies,
       document:{...detail.document,caseImage:row.document.url}}]}});
    }else{
     await call(route+'/design',{shop,method:'PUT',body:{operation_id:randomUUID(),expected_version:detail.version,design:{caseImage:row.document.url}}});
    }
    assert.equal((await call(route,{shop})).document.caseImage,asset.url);
    const attempted=await call(catalog+'/'+encodeURIComponent(row.id)+'/archive',{shop,method:'POST',status:403,
     body:{operation_id:randomUUID(),expected_version:row.version}});
    assert.equal(attempted.error,'CATALOG_SHARED_READ_ONLY');
   }
   for(const [shop,root] of uploadRoots){
    assert.equal((await readdir(root)).includes(asset.sha256),shop===owner);
   }
   const refs=await call(catalog+'/'+id,{shop:owner});
   assert.equal(refs.references.configurations,2);
   const archive=await call(catalog+'/'+id+'/archive',{shop:owner,method:'POST',status:409,
    body:{operation_id:randomUUID(),expected_version:created.version}});
   assert.equal(archive.error,'CATALOG_IN_USE');
   const replacement=await uploadGalleryImage(owner,200+index);
   const changed=await call(catalog+'/'+id,{shop:owner,method:'PUT',
    body:{operation_id:randomUUID(),expected_version:created.version,document:{...item,url:replacement.asset.url}}});
   assert.equal(changed.document.url,replacement.asset.url);
   for(const shop of [firstShop,secondShop]){
    assert((await call(catalog,{shop})).some(row=>row.document.url===replacement.asset.url));
    assert.equal((await call(route,{shop})).document.caseImage,asset.url);
   }
   const archived=await call(catalog+'/'+id+'/archive',{shop:owner,method:'POST',
    body:{operation_id:randomUUID(),expected_version:changed.version}});
   assert(!(await call(catalog,{shop:firstShop})).some(row=>row.document.url===replacement.asset.url));
   await call(catalog+'/'+id+'/restore',{shop:owner,method:'POST',body:{operation_id:randomUUID(),expected_version:archived.version}});
   assert((await call(catalog,{shop:secondShop})).some(row=>row.document.url===replacement.asset.url));
  }

  // 在同一份正式角色和配置样本上切到 NAS 会话，逐店验证真实写入及回执。
  await pending;
  await db.exec(await readFile(new URL('../sql/019-nas-local-auth.sql',import.meta.url),'utf8'));
  const authDb={query(sql,args){
   return underRole('intel',async role=>{
    await db.exec('BEGIN; SET LOCAL ROLE '+role);
    try{const result=await db.query(sql,args);await db.exec('COMMIT');return result;}
    catch(error){await db.exec('ROLLBACK');throw error;}
   });
  }};
  const config={workspace:'workbench-main',authMode:'migration'};
  const credential={username:'fixture-operator',password:'only-synthetic-fixture-password'};
  const migration=createLocalAuth(authDb,config,{legacy:async()=>({uid:user,memberId:user,name:'合成运营'})});
  assert.equal((await migration.login(credential,'127.0.0.1')).sub,user);
  const localAuth=createLocalAuth(authDb,{...config,authMode:'local'},
   {legacy:()=>assert.fail('本地认证不得调用原身份服务')});
  authServer=serve({...deps,authMode:'local',localAuth,authenticate:localAuth.authenticate});
  await new Promise(resolve=>authServer.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+authServer.address().port+'/api/v1';
  const session=await call('/auth/login',{base,method:'POST',body:credential});
  assert.equal(session.sub,user);
  const actor={base,uid:session.access_token};
  assert.deepEqual((await call('/me',actor)).shops,me.shops);
  await call('/me',{base,status:401});
  for(const shop of shops){
   const detail=await call(route,{...actor,shop});
   const name='NAS 登录隔离保存 '+shop,operation_id=randomUUID();
   const result=await call(route,{...actor,shop,method:'PUT',body:{
    operation_id,expected_version:detail.version,dependencies:detail.dependencies,document:{...detail.document,name}}});
   assert.equal(result.shop_id,shop);
   assert.deepEqual(await call('/operations/save-receipts/'+operation_id,{...actor,shop}),result);
   assert.equal((await call(route,{...actor,shop})).document.name,name);
  }
  await pending;
  await db.query("UPDATE nas_business.members SET enabled=false WHERE workspace_id='workbench-main' AND uid=$1",[user]);
  await call('/me',{status:403});
  await call(route,{shop:'jonsbo',status:403});
  await call('/me',{...actor,status:401});
 }finally{
  if(authServer)await new Promise(resolve=>authServer.close(resolve));
  if(outsideServer)await new Promise(resolve=>outsideServer.close(resolve));
  if(galleryServer)await new Promise(resolve=>galleryServer.close(resolve));
  if(server)await new Promise(resolve=>server.close(resolve));
  await db?.close();
  await bootstrap.close();
 }
});
