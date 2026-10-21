import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installAgentBridge} from '../../src/legacy/agent-bridge.ts';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function windowFixture(execute=async()=>({ok:true})){
 const timers=new Map(),events=new Map();let id=0;
 const target={crypto:globalThis.crypto,structuredClone:globalThis.structuredClone,workbenchReady:true,workbenchAgentExecute:execute,setInterval:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),addEventListener:(name,fn)=>events.set(name,fn)};
 return {target,timers,events,tick:async ms=>{for(const value of [...timers.values()])if(value.ms===ms)value.fn();await settle();}};
}

test('父realm任务通过目标realm structuredClone后再交给严格对象校验',async()=>{
 const realm=vm.createContext({});
 const targetClone=vm.runInContext('(value)=>JSON.parse(JSON.stringify(value))',realm);
 const execute=vm.runInContext('(job)=>{if(Object.getPrototypeOf(job.params.request)!==Object.prototype)throw Error("请求必须为对象");return {realmAccepted:true};}',realm);
 const f=windowFixture(execute),completions=[];let claimed=false,clones=0;
 f.target.structuredClone=value=>{clones++;return targetClone(value);};
 installAgentBridge(f.target,async(_command,{action,payload})=>{
  if(action==='claim'&&!claimed){claimed=true;return {id:'realm-job',claimToken:'token',params:{request:{shopId:'intel',targets:[],action:{type:'quantity',quantity:2}}}};}
  if(action==='complete')completions.push(payload);return null;
 });
 await f.tick(750);assert.equal(clones,1);assert.equal(completions[0].result.realmAccepted,true);assert.equal(completions[0].error,null);
});

test('桥接握手一次、heartbeat不重连，所有任务调用绑定同session与claimToken',async()=>{
 const f=windowFixture(),calls=[];let claimed=false;
 f.target.workbenchAgentExecute=async job=>{await f.target.workbenchAgentNative('progress',{id:job.id,phase:'rendering',completed:1,total:1});return {localSave:'saved'};};
 installAgentBridge(f.target,async(_command,{action,payload})=>{calls.push({action,payload});if(action==='claim'&&!claimed){claimed=true;return {id:'job',method:'changes.apply',claimToken:'claim-1',params:{}};}return null;});
 await f.tick(750);await f.tick(5000);await f.tick(750);
 const ready=calls.filter(c=>c.action==='ready');assert.equal(ready[0].payload.connect,true);assert.equal(ready[1].payload.connect,undefined);
 const session=ready[0].payload.sessionId;assert.match(session,/^[0-9a-f-]{36}$/);assert.ok(calls.every(c=>c.payload.sessionId===session));
 assert.equal(calls.find(c=>c.action==='progress').payload.claimToken,'claim-1');assert.equal(calls.find(c=>c.action==='complete').payload.claimToken,'claim-1');
 assert.equal(calls.filter(c=>c.action==='ready'&&c.payload.connect).length,1);
});

test('complete网络失败只重传相同session/token回执，不重复执行任务',async()=>{
 let executions=0,attempts=0;const f=windowFixture(async()=>{executions++;return {localSave:'saved'};}),completions=[];
 installAgentBridge(f.target,async(_command,{action,payload})=>{
  if(action==='claim')return {id:'job',claimToken:'original-token',params:{}};
  if(action==='complete'){completions.push(structuredClone(payload));if(++attempts===1)throw Error('network');}
  return null;
 });
 await f.tick(750);assert.equal(executions,1);await f.tick(750);assert.equal(executions,1);assert.equal(completions.length,2);assert.deepEqual(completions[0],completions[1]);
});

test('服务端已完成但IPC确认丢失后重传获确认，随后能领取下一任务',async()=>{
 const executed=[],committed=new Map(),attempts=[];let lost=false;
 const queued=[{id:'first',claimToken:'token-first',params:{}},{id:'second',claimToken:'token-second',params:{}}];
 const f=windowFixture(async job=>{executed.push(job.id);return {localSave:'unchanged'};});
 installAgentBridge(f.target,async(_command,{action,payload})=>{
  if(action==='claim')return queued.shift()??null;
  if(action==='complete'){
   attempts.push(structuredClone(payload));
   if(committed.has(payload.id))assert.deepEqual(committed.get(payload.id),payload);
   else committed.set(payload.id,structuredClone(payload));
   if(!lost){lost=true;throw Error('服务器已落盘，但IPC响应丢失');}
  }
  return null;
 });
 await f.tick(750);assert.deepEqual(executed,['first']);assert.ok(committed.has('first'));
 await f.tick(750);assert.deepEqual(executed,['first']);assert.deepEqual(attempts[0],attempts[1]);
 await f.tick(750);assert.deepEqual(executed,['first','second']);assert.ok(committed.has('second'));
});

test('页面重载使用新session，旧任务迟到回执仍携带旧session/token而不能冒充新领取',async()=>{
 let finish;const old=windowFixture(()=>new Promise(resolve=>{finish=resolve;})),fresh=windowFixture();const calls=[];let active=null;
 const invoke=async(_command,{action,payload})=>{
  calls.push({action,payload});if(action==='ready'&&payload.connect)active=payload.sessionId;
  if(action==='claim')return payload.sessionId===active?{id:'same-job',claimToken:payload.sessionId,params:{}}:null;
  if(action==='complete'&&payload.sessionId!==active)throw Error('UI_SESSION_STALE');return null;
 };
 installAgentBridge(old.target,invoke);await old.tick(750);const oldSession=active;old.events.get('unload')();
 installAgentBridge(fresh.target,invoke);await fresh.tick(750);const newSession=active;assert.notEqual(newSession,oldSession);
 finish({localSave:'saved'});await settle();
 const late=calls.filter(c=>c.action==='complete'&&c.payload.sessionId===oldSession);assert.equal(late.length,1);assert.equal(late[0].payload.claimToken,oldSession);
 const before=calls.length;await old.tick(750);await old.tick(5000);assert.equal(calls.length,before);
});
