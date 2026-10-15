import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudController} from '../../public/workbench/cloud-controller.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

test('batch resolution flushes and delivers once while paused, blocks duplicates and timer sync',async()=>{
 const gate=deferred(),calls=[];const {controller}=fixture({flush:async()=>{calls.push('flush');await gate.promise;},receive:async()=>{calls.push('receive');return true;},makeEngine:()=>({stop(){},run(){calls.push('run');},resolveMany:async items=>{calls.push(items);return{pending:0,conflicts:0,resolved:2};}})});
 await controller.refresh();controller.pause();const items=[{id:'a'},{id:'b'}],pending=controller.resolveMany(items);
 assert.equal(controller.status().running,true);await assert.rejects(controller.resolveMany(items),/等待/);await controller.tick();
 gate.resolve();await pending;assert.deepEqual(calls,['flush',items,'receive']);assert.equal(controller.status().running,false);assert.equal(controller.status().automatic,false);
});
test('pause during resolution flush prevents application and releases busy state',async()=>{
 const gate=deferred();let applied=false;const {controller}=fixture({flush:()=>gate.promise,makeEngine:()=>({stop(){},resolveMany:async()=>{applied=true;}})});
 await controller.refresh();const pending=controller.resolveMany([{id:'a'}]);await new Promise(r=>setImmediate(r));controller.pause();gate.resolve();await assert.rejects(pending,/暂停/);assert.equal(applied,false);assert.equal(controller.status().running,false);
});
test('failed batch save is retryable and does not report received or resolved data',async()=>{
 let fail=true,received=0;const {controller}=fixture({receive:async()=>{received++;},makeEngine:()=>({resolveMany:async()=>{if(fail)throw Error('磁盘失败');return{resolved:1};}})});
 await controller.refresh();await assert.rejects(controller.resolveMany([{id:'a'}]),/磁盘失败/);assert.equal(received,0);assert.equal(controller.status().running,false);
 fail=false;await controller.resolveMany([{id:'a'}]);assert.equal(received,1);
});
test('receipt after successful resolution remains successful if UI reread fails and reread retries later',async()=>{
 let receives=0,applied=0;const {controller}=fixture({receive:async()=>{if(++receives===1)throw Error('界面回读失败');return true;},makeEngine:()=>({resolveMany:async()=>{applied++;return{resolved:2,conflicts:0};}})});
 await controller.refresh();const result=await controller.resolveMany([{id:'a'},{id:'b'}]);assert.equal(result.resolved,2);assert.equal(controller.status().error,'界面回读失败');
 await controller.deliver();assert.equal(receives,2);assert.equal(applied,1);assert.equal(controller.status().running,false);
});
function fixture(overrides={}){
 const calls=[],runs=[];let authenticated=true;
 const member={uid:'u',workspaceId:'w',name:'member'};
 const controller=createCloudController({
  request:async(action,payload)=>{calls.push({action,payload});if(action==='logout')authenticated=false;if(action==='login')authenticated=true;return action==='status'?{session:{authenticated,member:authenticated?member:null},checkpoint:{initialized:true,uid:'u',workspaceId:'w'}}:{authenticated,member};},
  flush:async()=>calls.push({action:'flush'}),receive:async()=>true,
  makeEngine:()=>({run:async input=>{runs.push(input);return{pending:0};},stop:()=>calls.push({action:'stop'}),resolve:async()=>{}}),...overrides,
 });return{controller,calls,runs};
}
test('refresh and idle tick never authorize upload; explicit download is forwarded after flush/member refresh',async()=>{
 const {controller,calls,runs}=fixture();await controller.refresh();await controller.tick();assert.equal(runs.length,0);
 await controller.run(false);assert.equal(runs.length,1);assert.equal(runs[0].upload,false);
 assert.ok(calls.findIndex(r=>r.action==='flush')<calls.findIndex(r=>r.action==='resume'));
 await controller.tick();assert.equal(runs.length,1);
 await controller.automatic(true);await controller.tick();assert.equal(runs.length,2);assert.equal(runs[1].upload,true);
});
test('failure pauses automatic sync and keeps the saved edit available',async()=>{
 let writes=0;const {controller}=fixture({makeEngine:()=>({run:async()=>{writes++;throw Error('network lost');},stop(){}})});
 await controller.refresh();await controller.automatic(true);await assert.rejects(controller.tick(),/network lost/);
 assert.equal(controller.status().automatic,false);await controller.tick();assert.equal(writes,1);
 assert.equal(controller.status().error,'network lost');
});
test('pause while member refresh is in flight does not start a new upload',async()=>{
 const gate=deferred(),runs=[];
 const {controller}=fixture({request:async action=>action==='resume'?gate.promise:{session:{authenticated:true,member:{uid:'u',workspaceId:'w'}},checkpoint:{initialized:true,uid:'u',workspaceId:'w'}},makeEngine:()=>({run:async input=>runs.push(input),stop(){}})});
 await controller.refresh();const pending=controller.run(true);await new Promise(resolve=>setImmediate(resolve));controller.pause();gate.resolve({});await assert.rejects(pending,/暂停/);assert.equal(runs.length,0);
});
test('close waits for in-flight result and blocks timer; canceled close can be resumed manually',async()=>{
 const gate=deferred();let count=0;
 const {controller}=fixture({makeEngine:()=>({run:async()=>{count++;if(count===1)await gate.promise;return{pending:0};},stop(){}})});
 await controller.refresh();const running=controller.run();const duplicate=controller.run(false);assert.equal(duplicate,running);
 await new Promise(resolve=>setImmediate(resolve));let stopped=false;const stop=controller.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
 gate.resolve();await Promise.all([running,stop]);await controller.tick();assert.equal(count,1);await controller.run();assert.equal(count,2);
});
test('login credentials are not retained in view; account mismatch prevents synchronization',async()=>{
 const {controller}=fixture();await controller.login('member','test-secret');assert.ok(!JSON.stringify(controller.status()).includes('test-secret'));
 const other=fixture({request:async()=>({session:{authenticated:true,member:{uid:'different',workspaceId:'w'}},checkpoint:{initialized:true,uid:'u',workspaceId:'w'}})});
 await other.controller.refresh();await assert.rejects(other.controller.run(),/所属成员/);assert.equal(other.runs.length,0);
});
test('UI receipt is retried when editing/dialog defers it, without a second cloud run',async()=>{
 let delivered=0;const {controller,runs}=fixture({receive:async()=>++delivered>2});await controller.refresh();await controller.run(false);assert.equal(delivered,2);await controller.tick();assert.equal(delivered,3);assert.equal(runs.length,1);
});

function startupFixture({authenticated=true,initialized=false,onRequest,onFlush,onRun,onVerifyAssets,receive,isBlocked}={}){
 const calls=[],runs=[],views=[],member={uid:'u',workspaceId:'w',name:'成员'},backend={authenticated,initialized,uid:'u',workspaceId:'w'};
 const controller=createCloudController({
  async request(action,payload){calls.push({action,payload});const override=await onRequest?.(action,payload,backend);if(override!==undefined)return override;
   if(action==='login')backend.authenticated=true;if(action==='logout')backend.authenticated=false;if(action==='connect'){if(!backend.authenticated)throw Error('not authenticated');backend.initialized=true;}
   if(action==='status')return{session:{authenticated:backend.authenticated,member:backend.authenticated?member:null},checkpoint:{initialized:backend.initialized,uid:backend.initialized?backend.uid:null,workspaceId:backend.initialized?backend.workspaceId:null}};
   return{authenticated:backend.authenticated,member:backend.authenticated?member:null};
  },async flush(){calls.push({action:'flush'});await onFlush?.();},receive:async()=>{calls.push({action:'receive'});return receive?receive():true;},isBlocked,
  onChange:view=>views.push(structuredClone(view)),makeEngine:()=>({async run(input){runs.push(input);calls.push({action:'engine'});await onRun?.(input);return{pending:0};},...(onVerifyAssets?{async verifyAssets(){calls.push({action:'assets'});return onVerifyAssets(backend);}}:{}),stop:()=>calls.push({action:'stop'}),resolve:async()=>{}}),
 });return{controller,calls,runs,views,backend};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('startup authenticates existing session, connects bundled data, then syncs automatically once',async()=>{
 const {controller,calls,runs}=startupFixture();const first=controller.start(),second=controller.start();assert.equal(first,second);await first;
 const actions=calls.map(r=>r.action);assert.ok(actions.indexOf('flush')<actions.indexOf('resume'));assert.ok(actions.indexOf('resume')<actions.indexOf('connect'));assert.ok(actions.indexOf('connect')<actions.indexOf('engine'));assert.ok(actions.indexOf('receive')<actions.indexOf('engine'));
 assert.equal(actions.filter(r=>r==='connect').length,1);assert.equal(actions.includes('planPreview'),false);assert.equal(actions.includes('planApply'),false);assert.equal(runs.length,1);assert.equal(runs[0].upload,true);assert.equal(controller.status().automatic,true);
 await controller.start();assert.equal(runs.length,1);await controller.tick();assert.equal(runs.length,2);assert.equal(calls.filter(r=>r.action==='connect').length,1);
});
test('unauthenticated startup only reads status and never connects, flushes or uploads',async()=>{
 const {controller,calls,runs}=startupFixture({authenticated:false});await controller.start();assert.deepEqual(calls.map(r=>r.action),['status']);assert.equal(runs.length,0);assert.equal(controller.status().automatic,false);await assert.rejects(controller.run(),/登录/);assert.equal(calls.length,1);
});
test('initialized startup checks member without importing bootstrap again',async()=>{
 const {controller,calls,runs}=startupFixture({initialized:true});await controller.start();assert.equal(calls.some(r=>r.action==='connect'),false);assert.equal(runs.length,1);assert.equal(controller.status().automatic,true);
});
test('manual login directly connects and synchronizes; no password survives in emitted state',async()=>{
 const {controller,calls,runs,views}=startupFixture({authenticated:false});await controller.start();await controller.login('成员','synthetic-password');
 assert.ok(calls.findIndex(r=>r.action==='login')<calls.findIndex(r=>r.action==='connect'));assert.equal(runs.length,1);assert.equal(runs[0].upload,true);assert.equal(controller.status().automatic,true);assert.ok(!JSON.stringify(views).includes('synthetic-password'));assert.ok(!JSON.stringify(controller.status()).includes('synthetic-password'));
});
test('connect failure pauses automatic flow and manual retry resumes without plan UI',async()=>{
 let fail=true;const {controller,calls,runs}=startupFixture({onRequest(action){if(action==='connect'&&fail){fail=false;throw Error('bundled connection unavailable');}}});
 await assert.rejects(controller.start(),/bundled connection/);assert.equal(runs.length,0);assert.equal(controller.status().automatic,false);await controller.tick();assert.equal(calls.filter(r=>r.action==='connect').length,1);
 await controller.connectAndSync();assert.equal(calls.filter(r=>r.action==='connect').length,2);assert.equal(runs.length,1);assert.equal(controller.status().automatic,true);assert.equal(calls.some(r=>r.action==='planPreview'||r.action==='planApply'),false);
});
test('startup failure after connection can retry idempotently without another import',async()=>{
 let fail=true;const {controller,calls,runs}=startupFixture({onRun(){if(fail){fail=false;throw Error('network unavailable');}}});
 await assert.rejects(controller.start(),/network unavailable/);assert.equal(controller.status().checkpoint.initialized,true);assert.equal(controller.status().automatic,false);await controller.run();assert.equal(runs.length,2);assert.equal(calls.filter(r=>r.action==='connect').length,1);assert.equal(controller.status().automatic,true);
});
test('pause during startup status ignores the late session and prevents connection',async()=>{
 const gate=deferred();let once=true;const {controller,calls,runs}=startupFixture({onRequest(action){if(action==='status'&&once){once=false;return gate.promise;}}});
 const starting=controller.start();controller.pause();gate.resolve({session:{authenticated:true,member:{uid:'u',workspaceId:'w'}},checkpoint:{initialized:false}});await assert.rejects(starting,/暂停/);
 assert.equal(controller.status().session.authenticated,false);assert.equal(controller.status().automatic,false);assert.equal(calls.some(r=>r.action==='connect'||r.action==='resume'),false);assert.equal(runs.length,0);
});
test('pause during flush prevents resume/connect; explicit manual upload resumes automatic mode',async()=>{
 const gate=deferred();let once=true;const {controller,calls,runs}=startupFixture({onFlush(){if(once){once=false;return gate.promise;}}});const starting=controller.start();await settle();controller.pause();gate.resolve();await assert.rejects(starting,/暂停/);assert.equal(calls.some(r=>r.action==='resume'||r.action==='connect'),false);assert.equal(runs.length,0);await controller.run();assert.equal(runs.length,1);assert.equal(controller.status().automatic,true);
});
test('pause during connect permits local completion but never starts a late upload',async()=>{
 const gate=deferred();let once=true;const {controller,calls,runs}=startupFixture({onRequest(action){if(action==='connect'&&once){once=false;return gate.promise;}}});const starting=controller.start();await settle();controller.pause();gate.resolve();await assert.rejects(starting,/暂停/);assert.equal(runs.length,0);assert.equal(controller.status().automatic,false);
 await controller.run();assert.equal(calls.filter(r=>r.action==='connect').length,1);assert.equal(runs.length,1);assert.equal(controller.status().automatic,true);
});
test('pause during late successful login neither connects nor restarts automatic mode',async()=>{
 const gate=deferred();const {controller,calls,runs}=startupFixture({authenticated:false,onRequest(action){if(action==='login')return gate.promise;}});const login=controller.login('member','synthetic-password');await settle();controller.pause();gate.resolve({authenticated:true,member:{uid:'u',workspaceId:'w'}});await assert.rejects(login,/暂停/);assert.equal(runs.length,0);assert.equal(calls.some(r=>r.action==='connect'||r.action==='resume'),false);assert.equal(controller.status().automatic,false);
});
test('logout waits for late login and signs out after it, never connecting in between',async()=>{
 const gate=deferred();const {controller,calls,runs,backend}=startupFixture({authenticated:false,onRequest(action){if(action==='login')return gate.promise;}});const login=controller.login('member','synthetic-password');await settle();const logout=controller.logout();const rejected=assert.rejects(login,/暂停/);await settle();assert.equal(calls.some(r=>r.action==='logout'),false);gate.resolve();await Promise.all([rejected,logout]);assert.equal(backend.authenticated,false);assert.equal(controller.status().session.authenticated,false);assert.equal(controller.status().automatic,false);assert.equal(runs.length,0);assert.equal(calls.some(r=>r.action==='connect'),false);assert.ok(calls.findIndex(r=>r.action==='login')<calls.findIndex(r=>r.action==='logout'));
});
test('account mismatch after connect rejects before engine and keeps automatic paused',async()=>{
 const {controller,runs}=startupFixture({onRequest(action,payload,backend){if(action==='connect')backend.uid='different';}});await assert.rejects(controller.start(),/所属成员/);assert.equal(runs.length,0);assert.equal(controller.status().automatic,false);
});
test('double manual sync shares one connect and one engine run',async()=>{
 const gate=deferred();const {controller,calls,runs}=startupFixture({onRequest(action){if(action==='connect')return gate.promise;}});await controller.refresh();const first=controller.connectAndSync(),second=controller.run();assert.equal(first,second);await settle();gate.resolve();await first;assert.equal(calls.filter(r=>r.action==='connect').length,1);assert.equal(runs.length,1);
});
test('paused startup remains idempotent; read-only manual run does not restore uploads',async()=>{
 const {controller,runs}=startupFixture({initialized:true});await controller.start();controller.pause();await controller.start();await controller.tick();assert.equal(runs.length,1);assert.equal(controller.status().automatic,false);await controller.run(false);assert.equal(runs[1].upload,false);assert.equal(controller.status().automatic,false);await controller.run(true);assert.equal(controller.status().automatic,true);
});
test('pending logout is single flight and cannot race a new login or sync',async()=>{
 const gate=deferred();const {controller,calls,runs}=startupFixture({initialized:true,onRequest(action){if(action==='logout')return gate.promise;}});await controller.refresh();const first=controller.logout(),second=controller.logout();assert.equal(first,second);await settle();await assert.rejects(controller.login('member','synthetic-password'),/退出登录/);await assert.rejects(controller.run(),/退出登录/);gate.resolve();await first;assert.equal(calls.filter(r=>r.action==='logout').length,1);assert.equal(calls.some(r=>r.action==='login'||r.action==='connect'),false);assert.equal(runs.length,0);
});
test('close cancellation waits for an already requested logout to finish',async()=>{
 const gate=deferred();const {controller,calls}=startupFixture({initialized:true,onRequest(action){if(action==='logout')return gate.promise;}});await controller.refresh();const logout=controller.logout();await settle();let closed=false;const stop=controller.stop().then(()=>{closed=true;});await settle();assert.equal(closed,false);gate.resolve();await Promise.all([logout,stop]);assert.equal(closed,true);assert.equal(calls.filter(r=>r.action==='logout').length,1);assert.equal(controller.status().session.authenticated,false);
});
test('first automatic sync verifies complete baseline images once; logout resets verification',async()=>{
 let verified=0;const {controller,calls,runs}=startupFixture({onVerifyAssets(){verified++;return {images:74};}});await controller.start();assert.equal(verified,1);assert.ok(calls.findIndex(r=>r.action==='connect')<calls.findIndex(r=>r.action==='assets'));assert.ok(calls.findIndex(r=>r.action==='assets')<calls.findIndex(r=>r.action==='engine'));await controller.tick();await controller.run();assert.equal(verified,1);assert.equal(runs.length,3);await controller.logout();await controller.login('member','synthetic-password');assert.equal(verified,2);assert.equal(runs.length,4);
});
test('baseline image failure prevents cloud run and is rechecked on manual retry',async()=>{
 let attempts=0;const {controller,runs}=startupFixture({onVerifyAssets(){if(++attempts===1)throw Error('baseline image download failed');return {images:74};}});await assert.rejects(controller.start(),/baseline image/);assert.equal(attempts,1);assert.equal(runs.length,0);assert.equal(controller.status().automatic,false);await controller.tick();assert.equal(attempts,1);await controller.run();assert.equal(attempts,2);assert.equal(runs.length,1);await controller.run();assert.equal(attempts,2);assert.equal(controller.status().automatic,true);
});
