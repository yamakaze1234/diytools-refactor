import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCloudRecord} from '../../public/workbench/cloud-protocol.js';

// 已发行 Python 端使用相同的长度、类型和数字 ID 边界；检查提交前即可拒绝不兼容记录。
test('cloud settings accept values at Python compatibility boundaries',()=>{
 for(const data of [{couponCents:0},{couponCents:123,serviceText:'中'.repeat(1000),erpShopId:'9'.repeat(30),erpShopName:'店'.repeat(200)},{couponCents:0,serviceText:'',erpShopId:'',erpShopName:''}]){
  assert.deepEqual(validateCloudRecord('settings','intel',data),data);
 }
});

test('cloud settings reject fields rejected by the released Python client',()=>{
 const invalid=[['serviceText','中'.repeat(1001)],['serviceText',null],['serviceText',3],['erpShopId','9'.repeat(31)],['erpShopId','ABC'],['erpShopId',123],['erpShopId',null],['erpShopName','店'.repeat(201)],['erpShopName',null],['erpShopName',3]];
 for(const [key,value] of invalid)assert.throws(()=>validateCloudRecord('settings','intel',{couponCents:0,[key]:value}),/无效/,key);
});
