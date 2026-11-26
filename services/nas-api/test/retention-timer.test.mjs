import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {settings} from '../src/config.mjs';
import {startRetention} from '../src/retention.mjs';

const env={WORKSPACE_ID:'test',AUTH_ORIGIN:'https://fixture.test',PGDATABASE:'diy_workbench_trial',PGUSER:'diy_api_operations',
 PGPASSWORD:'test-only',NAS_DATASET:'intel_live',NAS_ENABLE_WRITES:'true',NAS_ENABLE_CATALOG_WRITES:'true',NAS_ENABLE_WORKSPACE_WRITES:'true'};
test('定时清理只对可写的独立运行区启用，默认一分钟后开始、每小时一次',()=>{
 assert.deepEqual(settings(env).retention,{workspaceId:'test',initialDelayMs:60000,intervalMs:3600000});
 assert.equal(settings({...env,NAS_ENABLE_WORKSPACE_WRITES:'false'}).retention,null);
 assert.equal(settings({...env,NAS_ENABLE_RETENTION:'false'}).retention,null);
 assert.throws(()=>settings({...env,NAS_RETENTION_INTERVAL_MS:'0'}),/INVALID_RETENTION_SETTINGS/);
 assert.deepEqual(settings({...env,NAS_RETENTION_INITIAL_DELAY_MS:'5',NAS_RETENTION_INTERVAL_MS:'100'}).retention,
  {workspaceId:'test',initialDelayMs:5,intervalMs:100});
});

test('各店轮巡不重叠，单店失败不影响下一店；停止时等待在途请求，及时取消下一轮',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const calls=[],logs=[];
 let release;
 const waiting=new Promise(resolve=>{release=resolve;});
 const stores=new Map([
  ['intel',{async purgeExpiredRetention(workspace){calls.push(workspace+'/intel');await waiting;throw Error('敏感内部错误');}}],
  ['jonsbo',{async purgeExpiredRetention(workspace){calls.push(workspace+'/jonsbo');}}],
 ]);
 const stop=startRetention(stores,{workspaceId:'w',initialDelayMs:10,intervalMs:20},text=>logs.push(text));
 t.mock.timers.tick(9);assert.deepEqual(calls,[]);
 t.mock.timers.tick(1);t.mock.timers.tick(60);assert.deepEqual(calls,['w/intel']);
 release();await setImmediate();assert.deepEqual(calls,['w/intel','w/jonsbo']);
 assert.equal(logs.length,1);assert.match(logs[0],/intel/);assert.doesNotMatch(logs[0],/敏感/);
 t.mock.timers.tick(20);await setImmediate();assert.equal(calls.length,4);
 await stop();t.mock.timers.tick(1000);await setImmediate();assert.equal(calls.length,4);
 let releaseShutdown;
 const pending=new Promise(resolve=>{releaseShutdown=resolve;});
 const close=startRetention([['intel',{purgeExpiredRetention:()=>pending}],['other',{purgeExpiredRetention:()=>assert.fail('关停后不应再发起请求')}]],
  {workspaceId:'w',initialDelayMs:0,intervalMs:100});
 t.mock.timers.tick(0);let finished=false;
 const stopped=close().then(()=>{finished=true;});await setImmediate();assert.equal(finished,false);
 releaseShutdown();await stopped;assert.equal(finished,true);
});
