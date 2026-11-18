// 验证正式边界使用合成设置和独立回环 HTTP，不接触真实数据库和身份。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {settings} from '../src/config.mjs';
import {serve} from '../src/http.mjs';
import {Fault} from '../src/config.mjs';
import {combineImageHandlers} from '../src/images.mjs';
const self=fileURLToPath(import.meta.url);
const production={NAS_PROFILE:'intel-production',NAS_DATASET:'intel_live',PGDATABASE:'diy_workbench',PGUSER:'diy_api_intel_production',
 WORKSPACE_ID:'workbench-main',AUTH_ORIGIN:'https://accounts.test.local',PGPASSWORD:'fixture-only',NAS_ENABLE_WRITES:'true',
 NAS_DEPLOYMENT_ID:'intel-production-v1',NAS_BOOTSTRAP_BATCH_ID:'intel-8151-9824e38b051851d8-fd417cd8',NAS_TLS_CERT_FILE:self,NAS_TLS_KEY_FILE:self,
 NAS_TLS_LAN_CIDR:'192.168.50.0/24',NAS_TLS_LISTEN_HOST:'192.168.50.10',NAS_TLS_PORT:'19443',LISTEN_HOST:'127.0.0.1',PORT:'19080'};

test('正式运行必须绑定独立角色、库、批次、TLS 端口和部署标识',()=>{
 const config=settings(production);assert.equal(config.pg.database,'diy_workbench');assert.equal(config.pg.user,'diy_api_intel_production');
 assert.equal(config.deploymentId,'intel-production-v1');assert.equal(config.tls.port,19443);
 for(const change of [{NAS_PROFILE:''},{PGDATABASE:'diy_workbench_trial'},{PGUSER:'diy_api_operations'},
  {NAS_TLS_PORT:'18443'},{PORT:'18080'},{NAS_TLS_LISTEN_HOST:''},{NAS_DEPLOYMENT_ID:'intel-production-v1\n'},{NAS_BOOTSTRAP_BATCH_ID:''}]){
  assert.throws(()=>settings({...production,...change}),undefined,JSON.stringify(change));
 }
 const trial=settings({...production,NAS_PROFILE:'trial',PGDATABASE:'diy_workbench_trial',PGUSER:'diy_api_operations'});
 assert.equal(trial.deploymentId,null);assert.equal(trial.pg.database,'diy_workbench_trial');
});

test('新增店铺配置必须完整且只绑定固定正式身份与本店批次',()=>{
 const env={...production,NAS_GIGABYTE_BOOTSTRAP_BATCH_ID:'gigabyte-7-1234567890abcdef-12345678',
  NAS_GIGABYTE_PASSWORD_FILE:self,NAS_GIGABYTE_IMAGE_ROOT:'/migration/gigabyte',NAS_GIGABYTE_IMAGE_WRITE_ROOT:'/uploads/gigabyte'};
 const config=settings(env);
 assert.equal(config.additionalShops.length,1);
 const [shop]=config.additionalShops;
 assert.equal(shop.shopId,'gigabyte');assert.equal(shop.pg.user,'diy_api_gigabyte_production');
 assert.equal(shop.pg.database,'diy_workbench');assert.equal(shop.imagesWriteRoot,'/uploads/gigabyte');
 assert.equal(settings(production).additionalShops.length,0);
 for(const change of [{NAS_GIGABYTE_IMAGE_ROOT:''},{NAS_GIGABYTE_BOOTSTRAP_BATCH_ID:production.NAS_BOOTSTRAP_BATCH_ID},
  {NAS_PROFILE:'trial',PGDATABASE:'diy_workbench_trial',PGUSER:'diy_api_operations'}]){
  assert.throws(()=>settings({...env,...change}),/INVALID_ADDITIONAL_SHOP_CONFIG/);
 }
 assert.throws(()=>settings({...env,NAS_JONSBO_BOOTSTRAP_BATCH_ID:'jonsbo-7-1234567890abcdef-12345678',
  NAS_JONSBO_PASSWORD_FILE:self,NAS_JONSBO_IMAGE_ROOT:'/migration/jonsbo',NAS_JONSBO_IMAGE_WRITE_ROOT:'/uploads/jonsbo'}),/STORE_CREDENTIALS_MUST_DIFFER/);
});

test('正式 HTTPS handler 只在正确部署标识时进入认证，原图匿名边界保留',async()=>{
 let auth=0,image=0;
 const server=serve({deploymentId:production.NAS_DEPLOYMENT_ID,store:{async roles(){return [{shop_id:'intel',role:'operations'}];}},
  authenticate:async()=>{auth++;return {uid:'synthetic',workspaceId:'w'};},serveImage:async(_hash,_extension,_req,res)=>{image++;res.end('fixture');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const health=await fetch(url+'/healthz');assert.equal(health.headers.get('x-workbench-deployment'),production.NAS_DEPLOYMENT_ID);
  assert.equal((await health.json()).deployment_id,production.NAS_DEPLOYMENT_ID);
  for(const header of [{},{'x-workbench-deployment':'trial'}]){
   const response=await fetch(url+'/api/v1/me',{headers:header});assert.equal(response.status,409);assert.equal((await response.json()).error,'NAS_DEPLOYMENT_MISMATCH');
  }
  assert.equal(auth,0);
  const me=await fetch(url+'/api/v1/me',{headers:{'x-workbench-deployment':production.NAS_DEPLOYMENT_ID}});
  assert.equal(me.status,200);assert.equal((await me.json()).deployment_id,production.NAS_DEPLOYMENT_ID);assert.equal(auth,1);
  assert.equal((await fetch(url+'/images/'+'a'.repeat(64)+'.png')).status,200);assert.equal(image,1);assert.equal(auth,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('未指定店铺沿用英特尔；非空店铺必须授权，不能使用其他店的同名资源',async()=>{
 const visited=[];
 const operator=shop=>({shop_id:shop,role:'operations'});
 const buildStore=(shop,uids)=>({
  dataSource:shop+'_live',writable:true,workspaceWritable:true,catalog:{writable:true,writeImage:async()=>{}},
  async roles({uid}){visited.push(['roles',shop]);return uids.includes(uid)?[operator(shop)]:[];},
  async detail(requestShop,id){visited.push(['detail',shop]);return {shop,requestShop,id};}
 });
 const shopStores=new Map([['intel',buildStore('intel',['legacy','operator'])],['gigabyte',buildStore('gigabyte',['operator'])],
  ['jonsbo',buildStore('jonsbo',['operator'])]]);
 const deploymentId=production.NAS_DEPLOYMENT_ID;
 const server=serve({deploymentId,shopStores,authenticate:async header=>({uid:header.slice(7),workspaceId:'w'})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/v1';
 const call=async(path,uid='operator')=>{
  const resp=await fetch(base+path,{headers:{'x-workbench-deployment':deploymentId,authorization:'Bearer '+uid}});
  return {status:resp.status,...await resp.json()};
 };
 const path='/operations/configurations/overlap';
 try{
  const me=await call('/me');
  assert.deepEqual(me.shops,[operator('intel'),operator('gigabyte'),operator('jonsbo')]);
  assert.equal(me.data_source,'intel_live');
  assert.equal(me.configuration_writes,true);
  assert.deepEqual(me.shop_capabilities.jonsbo,{data_source:'jonsbo_live',configuration_writes:true,catalog_writes:true,workspace_writes:true,image_upload:true});
  assert.deepEqual(Object.keys((await call('/me','legacy')).shop_capabilities),['intel']);
  visited.length=0;
  assert.equal((await call(path)).data.shop,'intel');
  assert.deepEqual(visited,[['roles','intel'],['detail','intel']]);
  assert.deepEqual((await call(path+'?shop_id=gigabyte')).data,{shop:'gigabyte',requestShop:'gigabyte',id:'overlap'});
  assert.equal((await call(path+'?shop_id=jonsbo','legacy')).status,403);
  for(const query of ['?shop_id=','?shop_id=__proto__','?shop_id=intel_live','?shop_id=gigabyte_access'])
   assert.equal((await call(path+query)).status,403);
  assert.equal((await call(path+'?shop_id=intel&shop_id=gigabyte')).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('公开摘要只在第一家店无有效字节时继续寻找，已发送响应不能改走其他店',async()=>{
 const events=[],req={},res={headersSent:false};
 const handler=combineImageHandlers([
  async()=>{events.push('missing');throw new Fault('NOT_FOUND',404);},
  async()=>{events.push('invalid');throw new Fault('IMAGE_UNAVAILABLE',404);},
  async(sha,extension,request,response)=>{events.push('valid');assert.deepEqual([sha,extension,request,response],['sha','png',req,res]);}
 ]);
 await handler('sha','png',req,res);
 assert.deepEqual(events,['missing','invalid','valid']);
 const partial=combineImageHandlers([
  async()=>{res.headersSent=true;throw Error('断开');},
  async()=>{assert.fail('不能发送第二次响应');}
 ]);
 await assert.rejects(partial('sha','png',req,res),/断开/);
});
