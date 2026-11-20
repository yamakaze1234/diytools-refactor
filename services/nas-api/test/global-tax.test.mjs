import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGlobalTax} from '../src/global-tax.mjs';

const item=()=>({id:'100001',action:'global_tax',expected_version:'1',
 expected_versions:{intel:'1',gigabyte:'2',jonsbo:null},fields:{tax:123.45}});

test('全局核算价只接受完整三店版本和明确金额或恢复，客户端不能伪造标记',()=>{
 assert.doesNotThrow(()=>validateGlobalTax(item(),'intel'));
 assert.doesNotThrow(()=>validateGlobalTax({...item(),fields:{restore:true}},'intel'));
 for(const patch of [{expected_version:'2'},{expected_versions:{intel:'1',gigabyte:'2'}},
  {expected_versions:{intel:'1',gigabyte:'2',jonsbo:'0'}},{fields:{tax:-1}},{fields:{tax:1.001}},
  {fields:{restore:false}},{fields:{tax:1,restore:true}},{fields:{tax:1,globalTax:{base:0}}},
  {expected_versions:{intel:'1',gigabyte:'2',jonsbo:null,other:'1'}}]){
  assert.throws(()=>validateGlobalTax({...item(),...patch},'intel'),{code:'VALIDATION_FAILED'});
 }
});
