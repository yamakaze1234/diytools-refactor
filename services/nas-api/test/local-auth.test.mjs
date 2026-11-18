// 在进程内 PostgreSQL 用原成员 UID 演练登记、断开旧认证、三店保存和会话撤销。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {serve} from '../src/http.mjs';
import {createLocalAuth} from '../src/local-auth.mjs';
import {authenticateLegacyPassword} from '../src/auth.mjs';

test('沿用原账号激活后，三店保存、刷新与退出均可脱离原认证服务',async t=>{
 const initial=new PGlite();
 t.after(()=>initial.close());
 await initial.exec('CREATE DATABASE diy_workbench');
 const db=new PGlite({loadDataDir:await initial.dumpDataDir(),database:'diy_workbench'});
 t.after(()=>db.close());
 await db.exec(`
  CREATE ROLE diy_api_intel_production;
  CREATE ROLE diy_api_gigabyte_production;
  CREATE SCHEMA nas_business;
  CREATE TABLE nas_business.members(workspace_id text,uid text,enabled boolean,PRIMARY KEY(workspace_id,uid));
  INSERT INTO nas_business.members VALUES('fixture','original-id',true),('fixture','disabled-id',false);

 `);
 await db.exec(await readFile(new URL('../sql/019-nas-local-auth.sql',import.meta.url),'utf8'));
 const {rows:[rights]}=await db.query("SELECT has_schema_privilege('diy_api_gigabyte_production','nas_auth','USAGE') AS other_shop");
 assert.equal(rights.other_shop,false);
 await db.exec('SET ROLE diy_api_intel_production');
 let cloudCalls=0;
 const config={workspace:'fixture',authMode:'migration'};
 const auth=createLocalAuth(db,config,{legacy:async(_config,username,password)=>{
  ++cloudCalls;
  assert.equal(password,'fixture-only-password');
  return {uid:username==='Member'?'original-id':'disabled-id',name:'成员样本',memberId:'original-member-id'};
 }});
 const originalLogin=()=>auth.login({username:'Member',password:'fixture-only-password'},'127.0.0.1');
 const [member,secondDevice]=await Promise.all([originalLogin(),originalLogin()]);
 assert.equal(member.sub,'original-id');
 assert.equal(secondDevice.sub,member.sub);
 assert.notEqual(secondDevice.refresh_token,member.refresh_token);
 await assert.rejects(auth.login({username:'Disabled',password:'fixture-only-password'},'127.0.0.1'),{code:'UNAUTHENTICATED'});
 await assert.rejects(auth.login({username:'Member',password:'wrong'},'127.0.0.1'),{code:'UNAUTHENTICATED'});
 assert.equal(cloudCalls,3);
 const local=createLocalAuth(db,{...config,authMode:'local'},{legacy:()=>assert.fail('本地模式不能调用原认证服务')});
 const shops=['intel','gigabyte','jonsbo'],writes=[];
 const stores=new Map(shops.map(shop=>[shop,{writable:true,
  roles:async({uid})=>uid==='original-id'?[{shop_id:shop,role:'operations'}]:[],
  save:async(actor,shopId,id,action)=>{
   writes.push([actor.uid,shopId,id,action]);return {configuration_id:id};
  }
 }]));
 const deployment='intel-production-fixture';
 const server=serve({deploymentId:deployment,shopStores:stores,authMode:'local',localAuth:local,authenticate:local.authenticate});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=async(path,{method='POST',access,body={},origin}={})=>{
  const headers={'content-type':'application/json','x-workbench-deployment':deployment,
   ...(access?{authorization:'Bearer '+access}:{}),...(origin?{origin}:{})};
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers,
   ...(method==='GET'?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await request('/healthz',{method:'GET'})).body.auth_mode,'local');
 assert.equal((await request('/api/v1/auth/login',{origin:'http://invalid.example',body:{}})).status,403);
 assert.equal((await request('/api/v1/auth/login',{body:{username:'Unknown',password:'fixture-only-password'}})).status,401);
 const login=await request('/api/v1/auth/login',{body:{username:'member',password:'fixture-only-password'}});
 assert.equal(login.status,200);
 assert.equal(login.body.sub,member.sub);
 const access=login.body.access_token,refresh=login.body.refresh_token;
 const authSession=await request('/api/v1/auth/session',{access});
 assert.equal(authSession.body.memberId,'original-member-id');
 const me=await request('/api/v1/me',{method:'GET',access});
 assert.deepEqual(me.body.shops.map(row=>row.shop_id),shops);
 for(const shop of shops){
  const result=await request('/api/v1/operations/configurations/example?shop_id='+shop,{method:'PUT',access});
  assert.equal(result.status,200);
 }
 assert.deepEqual(writes,shops.map(shop=>['original-id',shop,'example','replace']));
 assert.equal((await request('/api/v1/operations/configurations/example?shop_id=intel',{method:'PUT',access:'old-cloud-token'})).status,401);
 const renew=()=>request('/api/v1/auth/refresh',{body:{grant_type:'refresh_token',refresh_token:refresh}});
 const results=await Promise.all([renew(),renew()]);
 assert.deepEqual(results.map(row=>row.status).sort(),[200,401]);
 const renewed=results.find(row=>row.status===200).body;
 assert.equal((await request('/api/v1/auth/session',{access})).status,401);
 assert.equal((await request('/api/v1/auth/session',{access:renewed.access_token})).status,200);
 assert.equal((await request('/api/v1/auth/logout',{body:{refresh_token:refresh}})).status,200);
 assert.equal((await request('/api/v1/auth/session',{access:renewed.access_token})).status,401);
 await db.exec("RESET ROLE; UPDATE nas_business.members SET enabled=false WHERE uid='original-id'; SET ROLE diy_api_intel_production");
 assert.equal((await request('/api/v1/auth/session',{access:member.access_token})).status,401);
 assert.equal(cloudCalls,3);
});

// 核对一次性迁移使用的是现有登录契约，并要求原令牌的主体和工作台成员一致。
test('原密码登记先用 signin，再以受核验的原 UID 绑定账号',async()=>{
 const uid='synthetic-existing-id',password='fixture-only-password';
 const calls=[];
 const config={authOrigin:'https://auth.fixture.invalid',workspace:'fixture'};
 const fetchImpl=async(url,options)=>{
  calls.push(new URL(url).pathname);
  const input=JSON.parse(options.body);
  if(url.endsWith('/signin')){
   assert.deepEqual(input,{username:'Member',password});
   return Response.json({token_type:'Bearer',access_token:'synthetic-token',sub:uid});
  }
  assert.equal(options.headers.authorization,'Bearer synthetic-token');
  assert.equal(input.action,'session.get');
  return Response.json({ok:true,uid,workspaceId:'fixture',memberId:'same-member'});
 };
 assert.deepEqual(await authenticateLegacyPassword(config,'Member',password,{fetchImpl}),
  {uid,workspaceId:'fixture',memberId:'same-member',name:''});
 assert.deepEqual(calls,['/auth/v1/signin','/v1/functions/workbenchApi']);
 await assert.rejects(authenticateLegacyPassword({...config,workspace:'other'},'Member',password,{fetchImpl}),{code:'FORBIDDEN'});
});
