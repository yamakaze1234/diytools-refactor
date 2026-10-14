import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartupLoginController,requestStartupCloud,trustedWorkbenchSignOut} from '../src/startup-login-controller.ts';
const member={uid:'u',workspaceId:'w',name:'成员'};
const answer=value=>({status:200,body:JSON.stringify(value)});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function fixture(handle,desktop=true){const calls=[],states=[];const controller=createStartupLoginController({desktop,onState:s=>states.push(s),invoke:async(command,args)=>{calls.push({command,...args});return handle(args.action,JSON.parse(args.payloadJson));}});return{controller,calls,states};}

test('unauthenticated startup never connects or releases the editor',async()=>{
 const env=fixture(()=>answer({session:{authenticated:false,member:null}}));await env.controller.initialize();
 assert.equal(env.controller.status().phase,'signed-out');assert.deepEqual(env.calls.map(c=>c.action),['status']);
 assert(!env.states.some(state=>state.phase==='ready'));
});

test('missing local cloud configuration opens local workbench without connect or login',async()=>{
 for(const result of [{configured:false,session:{authenticated:false,member:null}},{session:{configured:false,authenticated:false,member:null,code:'CLOUD_NOT_CONFIGURED'}}]){
  const env=fixture(()=>answer(result));await env.controller.initialize();
  assert.equal(env.controller.status().phase,'ready');assert.equal(env.controller.status().localOnly,true);
  assert.equal(env.controller.status().session.authenticated,false);assert.deepEqual(env.calls.map(c=>c.action),['status']);
 }
});

test('configured service outage does not bypass login as local mode',async()=>{
 const env=fixture(()=>{throw Error('连接超时');});await env.controller.initialize();
 assert.equal(env.controller.status().phase,'signed-out');assert.equal(env.controller.status().localOnly,false);
 assert.equal(env.controller.status().error,'连接超时');
});
test('authenticated startup holds the editor until connect succeeds',async()=>{
 const gate=deferred(),env=fixture(action=>action==='status'?answer({session:{authenticated:true,member}}):gate.promise);
 const pending=env.controller.initialize();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(env.controller.status().phase,'preparing');assert.equal(env.controller.status().busy,true);
 assert(!env.states.some(state=>state.phase==='ready'));gate.resolve(answer({initialized:true}));await pending;
 assert.equal(env.controller.status().phase,'ready');assert.deepEqual(env.calls.map(c=>c.action),['status','connect']);
});
test('connect failure retains authenticated identity; retry does not ask for password or login again',async()=>{
 let connects=0;const env=fixture((action,payload)=>{if(action==='login'){assert.equal(payload.username,'account');assert.equal(payload.password,'memory-only');return answer({authenticated:true,member});}if(++connects===1)throw Error('准备失败');return answer({initialized:true});});
 await env.controller.login(' account ','memory-only');assert.equal(env.controller.status().phase,'preparing');
 assert.equal(env.controller.status().session.authenticated,true);assert.equal(env.controller.status().error,'准备失败');
 assert(!JSON.stringify(env.controller.status()).includes('memory-only'));await env.controller.retry();
 assert.equal(env.controller.status().phase,'ready');assert.deepEqual(env.calls.map(c=>c.action),['login','connect','connect']);
});
test('invalid login does not connect and keeps a visible error',async()=>{
 const env=fixture(()=>({status:401,body:'{"error":"账号或密码不正确"}'}));await env.controller.login('account','secret');
 assert.equal(env.controller.status().phase,'signed-out');assert.equal(env.controller.status().error,'账号或密码不正确');assert.deepEqual(env.calls.map(c=>c.action),['login']);
});
test('duplicate submit shares a flight, disposal prevents late login from connecting/mounting',async()=>{
 const gate=deferred(),env=fixture(()=>gate.promise);const first=env.controller.login('one','first');const second=env.controller.login('two','second');
 assert.equal(first,second);assert.equal(env.calls.length,1);env.controller.dispose();gate.resolve(answer({authenticated:true,member}));await first;
 assert.deepEqual(env.calls.map(c=>c.action),['login']);assert(!env.states.some(state=>state.phase==='ready'));
});
test('browser preview never authenticates or calls native interfaces',async()=>{
 const env=fixture(()=>assert.fail('native call in browser'),false);await env.controller.initialize();await env.controller.login('account','secret');assert.equal(env.controller.status().phase,'signed-out');assert.equal(env.calls.length,0);
});
test('malformed native response cannot acknowledge login success',async()=>{
 for(const response of [{status:200,body:'bad'},{status:200,body:'[]'},{status:200,body:'null'},{status:0,body:'{}'}])await assert.rejects(requestStartupCloud(async()=>response,'login'),/格式无效/);
});
test('sign-out message must be from the current iframe and same origin',()=>{
 const frame={},other={},origin='http://workbench';const event={source:frame,origin,data:{type:'workbench-signed-out'}};
 assert.equal(trustedWorkbenchSignOut(event,frame,origin),true);
 assert.equal(trustedWorkbenchSignOut({...event,source:other},frame,origin),false);
 assert.equal(trustedWorkbenchSignOut({...event,origin:'http://other'},frame,origin),false);
 assert.equal(trustedWorkbenchSignOut({...event,source:null},null,origin),false);
});
