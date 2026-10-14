import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartupLoginController,requestStartupCloud,trustedWorkbenchSignOut} from '../src/startup-login-controller.ts';
const member={uid:'u',workspaceId:'w',name:'成员'};
const answer=value=>({status:200,body:JSON.stringify(value)});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function fixture(handle,desktop=true,{firstUse=()=>answer({required:false}),buildMigrationPlan}={}){const calls=[],states=[];const controller=createStartupLoginController({desktop,buildMigrationPlan,onState:s=>states.push(s),invoke:async(command,args)=>{calls.push({command,...args});return args.action==='firstUseStatus'?firstUse():handle(args.action,JSON.parse(args.payloadJson));}});return{controller,calls,states};}

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
 assert.equal(env.controller.status().phase,'ready');assert.deepEqual(env.calls.map(c=>c.action),['status','firstUseStatus','connect']);
});
test('connect failure retains authenticated identity; retry does not ask for password or login again',async()=>{
 let connects=0;const env=fixture((action,payload)=>{if(action==='login'){assert.equal(payload.username,'account');assert.equal(payload.password,'memory-only');return answer({authenticated:true,member});}if(++connects===1)throw Error('准备失败');return answer({initialized:true});});
 await env.controller.login(' account ','memory-only');assert.equal(env.controller.status().phase,'preparing');
 assert.equal(env.controller.status().session.authenticated,true);assert.equal(env.controller.status().error,'准备失败');
 assert(!JSON.stringify(env.controller.status()).includes('memory-only'));await env.controller.retry();
 assert.equal(env.controller.status().phase,'ready');assert.deepEqual(env.calls.map(c=>c.action),['login','firstUseStatus','connect','firstUseStatus','connect']);
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

function firstUseFixture({migrate,connect,required=()=>true}={}){
 return fixture(action=>{
  if(action==='status')return answer({session:{authenticated:true,member}});
  if(action==='login')return answer({authenticated:true,member});
  if(action==='migrateLegacy')return migrate?.()??answer({cancelled:true});
  if(action==='connect')return connect?.()??answer({initialized:true});
  if(action==='logout')return answer({authenticated:false,member:null});
  assert.fail('unexpected action '+action);
 },true,{firstUse:()=>answer({required:required()})});
}
test('first login and saved session both wait for explicit source selection; retry never starts cloud download',async()=>{
 for(const method of ['initialize','login']){
  const env=firstUseFixture();await env.controller[method]('account','secret');
  assert.equal(env.controller.status().phase,'choosing-data');assert.equal(env.controller.status().firstUse,true);
  assert.equal(env.controller.status().busy,false);assert(!env.states.some(s=>s.phase==='ready'));
  await env.controller.retry();assert.equal(env.controller.status().phase,'choosing-data');
  assert(!env.calls.some(c=>['connect','migrateLegacy'].includes(c.action)));
 }
});
test('cloud choice binds empty workspace and verifies persistence before entering editor',async()=>{
 let initialized=false;const env=firstUseFixture({required:()=>!initialized,connect:()=>{initialized=true;return answer({initialized:true});}});
 await env.controller.initialize();await env.controller.chooseData('cloud');
 assert.equal(env.controller.status().phase,'ready');assert.equal(env.controller.status().firstUse,false);
 assert.deepEqual(env.calls.map(c=>c.action),['status','firstUseStatus','connect','firstUseStatus','connect']);
 assert(!env.calls.some(c=>c.action==='migrateLegacy'));
});
test('cancelled directory picker leaves cloud binding and editor untouched',async()=>{
 const env=firstUseFixture();await env.controller.initialize();await env.controller.chooseData('legacy');
 assert.equal(env.controller.status().phase,'choosing-data');assert.equal(env.controller.status().error,'');
 assert(!env.calls.some(c=>c.action==='connect'));assert(!env.states.some(s=>s.phase==='ready'));
 assert.equal(env.calls.find(c=>c.action==='migrateLegacy').payloadJson,'{}');
});
test('migration failure preserves selection and can retry the same source successfully',async()=>{
 let attempts=0,initialized=false;const env=firstUseFixture({required:()=>!initialized,migrate:()=>{
  if(++attempts===1)throw Error('旧资料所属工作区与登录成员不一致');
  initialized=true;return answer({initialized:true});
 }});
 await env.controller.initialize();await env.controller.chooseData('legacy');
 assert.equal(env.controller.status().phase,'choosing-data');assert.match(env.controller.status().error,/工作区/);
 assert(!env.states.some(s=>s.phase==='ready'));
 await env.controller.chooseData('legacy');assert.equal(env.controller.status().phase,'ready');assert.equal(attempts,2);
});
test('duplicate choice cannot start a second import or switch to cloud during migration',async()=>{
 const gate=deferred();let initialized=false;const env=firstUseFixture({required:()=>!initialized,migrate:()=>gate.promise});
 await env.controller.initialize();const first=env.controller.chooseData('legacy'),second=env.controller.chooseData('cloud');
 assert.equal(first,second);assert.equal(env.controller.status().busy,true);
 assert.equal(env.calls.filter(c=>c.action==='migrateLegacy').length,1);assert(!env.calls.some(c=>c.action==='connect'));
 initialized=true;gate.resolve(answer({initialized:true}));await first;assert.equal(env.controller.status().phase,'ready');
});
test('malformed first-use status and unconfirmed migration cannot release editor',async()=>{
 for(const value of [{},{required:'false'},{required:null}]){
  const env=fixture(()=>answer({session:{authenticated:true,member}}),true,{firstUse:()=>answer(value)});
  await env.controller.initialize();assert.notEqual(env.controller.status().phase,'ready');assert.match(env.controller.status().error,/未确认/);
  assert(!env.calls.some(c=>c.action==='connect'));
 }
 for(const result of [{},{initialized:false},{initialized:true}]){
  const env=firstUseFixture({migrate:()=>answer(result)});await env.controller.initialize();await env.controller.chooseData('legacy');
  assert.equal(env.controller.status().phase,'choosing-data');assert(env.controller.status().error);assert(!env.states.some(s=>s.phase==='ready'));
 }
});
test('disposal during selection suppresses late follow-up calls and editor release',async()=>{
 const gate=deferred(),env=firstUseFixture({migrate:()=>gate.promise});await env.controller.initialize();
 const flight=env.controller.chooseData('legacy');env.controller.dispose();gate.resolve(answer({initialized:true}));await flight;
 assert.deepEqual(env.calls.map(c=>c.action),['status','firstUseStatus','migrateLegacy']);assert(!env.states.some(s=>s.phase==='ready'));
});
test('logout clears first-use state and prevents unauthenticated import',async()=>{
 const env=firstUseFixture();await env.controller.initialize();await env.controller.logout();await env.controller.chooseData('legacy');
 assert.equal(env.controller.status().phase,'signed-out');assert.equal(env.controller.status().firstUse,false);
 assert(!env.calls.some(c=>c.action==='migrateLegacy'));
});
test('two-phase import never applies before projection completes and verifies the committed binding',async()=>{
 const gate=deferred();let initialized=false;
 const prepared={prepared:true,token:'native-token',state:{},records:[],outbox:[],sourceBound:false};
 const plan={token:'native-token',records:[],materializedProjection:[]};
 const env=fixture((action,payload)=>{
  if(action==='status')return answer({session:{authenticated:true,member}});
  if(action==='migrateLegacy')return answer(prepared);
  if(action==='migrateLegacyApply'){assert.deepEqual(payload,plan);initialized=true;return answer({initialized:true});}
  if(action==='connect')return answer({initialized:true});
  assert.fail(action);
 },true,{firstUse:()=>answer({required:!initialized}),buildMigrationPlan:async value=>{assert.deepEqual(value,prepared);await gate.promise;return plan;}});
 await env.controller.initialize();const flight=env.controller.chooseData('legacy');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(env.controller.status().busy,true);assert(!env.calls.some(c=>c.action==='migrateLegacyApply'));
 gate.resolve();await flight;assert.equal(env.controller.status().phase,'ready');
 assert.deepEqual(env.calls.map(c=>c.action),['status','firstUseStatus','migrateLegacy','migrateLegacyApply','firstUseStatus','connect']);
});
test('failed projection never writes native state or starts cloud sync',async()=>{
 const env=fixture(action=>action==='status'?answer({session:{authenticated:true,member}}):answer({prepared:true,token:'native-token'}),true,{firstUse:()=>answer({required:true}),buildMigrationPlan:()=>{throw Error('旧版保存与同步草稿有重叠冲突');}});
 await env.controller.initialize();await env.controller.chooseData('legacy');
 assert.equal(env.controller.status().phase,'choosing-data');assert.match(env.controller.status().error,/重叠冲突/);
 assert(!env.calls.some(c=>['migrateLegacyApply','connect','call'].includes(c.action)));
});
