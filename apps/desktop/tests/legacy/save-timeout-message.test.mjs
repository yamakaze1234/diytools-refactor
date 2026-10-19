import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const requestCode=source.split('\n').find(line=>line.startsWith('async function request('));
test('save timeout is an unconfirmed result and never fabricates a receipt or retry',async()=>{
 let calls=0;
 const timeout=new DOMException('signal timed out','TimeoutError');
 const context=vm.createContext({AbortSignal,fetch:async()=>{calls++;throw timeout;}});
 vm.runInContext(requestCode,context);
 for(const url of ['/api/state','/api/configs/batch','/api/configs/patch']){
  await assert.rejects(context.request(url,{method:'POST',body:'{}'}),error=>error.name==='TimeoutError'&&/尚未确认是否写入/.test(error.message)&&/输入已保留/.test(error.message));
 }
 assert.equal(calls,3);
 await assert.rejects(context.request('/api/state'),error=>error===timeout);
});
