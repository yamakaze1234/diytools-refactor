// 浏览器 ERP 作用域只能由宿主配置来源绑定，客户端上报不能切换服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ErpJobs} from '../public/workbench/erp-sync.js';
const sample={clientId:'fixture-client',account:'tester',warehouse:'公司大库',depotId:'1'};
test('missing configured ERP origin rejects browser identity',()=>{
 const jobs=new ErpJobs(()=>null);
 assert.throws(()=>jobs.identity({...sample,origin:'https://erp.example.test'}),/尚未配置/);
});
test('browser identity binds configured HTTPS origin and retains cross-source protection',()=>{
 let origin='https://erp.example.test',scope=null;
 const jobs=new ErpJobs(()=>scope,()=>origin);
 scope=jobs.identity({...sample,origin:'https://other.example.test'});
 assert.equal(scope,'https://erp.example.test|tester|1');
 origin='https://other.example.test';assert.throws(()=>jobs.identity(sample),/不一致/);
 origin='http://erp.example.test';assert.throws(()=>jobs.identity(sample),/地址无效/);
});
