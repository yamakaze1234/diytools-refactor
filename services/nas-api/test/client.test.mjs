// 客户端必须保留金额精度、每次读取令牌，并明确区分拒绝与网络失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';

test('客户端支持子路径、转义实体ID，金额和版本保持文本',async()=>{
 const calls=[];
 const client=createNasApiClient({baseUrl:'https://example.test/workbench-api',getToken:()=> 'token',fetchImpl:async(url,options)=>{
  calls.push({url,options});return Response.json({ok:true,data:{version:'9007199254740993',final_price_cents:'9007199254740995'}});
 }});
 const result=await client.detail('id/with?chars');
 assert.equal(calls[0].url.pathname,'/workbench-api/api/v1/operations/configurations/id%2Fwith%3Fchars');
 assert.equal(calls[0].url.searchParams.get('shop_id'),'intel');
 assert.equal(calls[0].options.redirect,'error');
 assert.equal(result.final_price_cents,'9007199254740995');
});

test('换账号后不复用旧令牌，注销后不发送请求',async()=>{
 let token='first';const tokens=[];
 const client=createNasApiClient({baseUrl:'https://example.test',getToken:()=>token,fetchImpl:async(url,options)=>{tokens.push(options.headers.authorization);return Response.json({ok:true});}});
 await client.me();token='second';await client.me();token='';
 await assert.rejects(client.me(),{code:'UNAUTHENTICATED'});
 assert.deepEqual(tokens,['Bearer first','Bearer second']);
});

test('权限拒绝及超时均不自动重试，不显示原始服务错误',async()=>{
 let calls=0;
 const denied=createNasApiClient({baseUrl:'https://example.test',getToken:()=> 'token',fetchImpl:async()=>{calls++;return Response.json({ok:false,error:'FORBIDDEN'},{status:403});}});
 await assert.rejects(denied.list(),{code:'FORBIDDEN',status:403});assert.equal(calls,1);
 const timeout=createNasApiClient({baseUrl:'https://example.test',getToken:()=> 'token',timeoutMs:5,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private information'))))});
 await assert.rejects(timeout.me(),{code:'REQUEST_TIMEOUT'});
});

test('拒绝明文地址、路径穿越和越界分页',async()=>{
 assert.throws(()=>createNasApiClient({baseUrl:'http://example.test',getToken:()=> 'token'}),{code:'INVALID_API_URL'});
 const client=createNasApiClient({baseUrl:'https://example.test',getToken:()=>{throw new Error('不应请求')}});
 await assert.rejects(client.detail('..'),{code:'INVALID_IDENTIFIER'});
 await assert.rejects(client.list({limit:101}),{code:'INVALID_QUERY'});
});

test('仅保留已回滚的缺迁移错误，其它服务端5xx仍为未知结果',async()=>{
 for(const [code,expected]of [['NAS_GLOBAL_TAX_NOT_INSTALLED','NAS_GLOBAL_TAX_NOT_INSTALLED'],['NAS_GLOBAL_UPGRADE_NOT_INSTALLED','NAS_GLOBAL_UPGRADE_NOT_INSTALLED'],['SERVICE_UNAVAILABLE','SAVE_STATUS_UNKNOWN']]){
  const client=createNasApiClient({shopId:'intel',nativeRequest:async()=>Response.json({ok:false,error:code},{status:503})});
  await assert.rejects(client.workspaceWrite('costs',{}),{code:expected,status:503});
 }
});
