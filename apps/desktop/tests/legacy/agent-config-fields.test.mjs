import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentPlan,validateAgentPlan} from '../../public/workbench/agent-changes.js';
const fixture=()=>({revision:1,configs:[{id:'c',shopId:'intel',spu:'123',shortName:'配置1',price:100,skuId:'',parts:[],actualParts:null,shortNameAuto:true,posterSubtitle:'保留',custom:{a:1}}]});
const request=()=>({shopId:'intel',action:{type:'configFields'},targets:[{configId:'c',expected:{spu:'123',shortName:'配置1',price:100,skuId:''},changes:{price:99.99,skuId:'90071992547409931234'}}]});
test('价格和长SKU精确更新，保留所有其他字段，输入不变且JSON回传可验证',()=>{
 const s=fixture(),before=structuredClone(s),r=request(),p=buildAgentPlan(s,r);
 assert.deepEqual(p.changes[0].after,{...s.configs[0],...r.targets[0].changes});assert.deepEqual(s,before);
 assert.equal(validateAgentPlan(s,JSON.parse(JSON.stringify(p))),true);
});
test('单独改价格、补SKU、零价格、无变化支持',()=>{
 for(const changes of [{price:0},{skuId:'00123'},{price:100}]){
  const r=request();r.targets[0].changes=changes;const p=buildAgentPlan(fixture(),r);
  assert.equal(p.changes.length,changes.price===100?0:1);
 }
});
test('拒绝非法金额、数值SKU、清空SKU、未知字段及缺少原值',()=>{
 for(const changes of [{price:-1},{price:1.001},{price:NaN},{price:Infinity},{price:'10'},{skuId:123},{skuId:''},{skuId:' 123'},{skuId:'abc'},{name:'x'},{}]){
  const r=request();r.targets[0].changes=changes;assert.throws(()=>buildAgentPlan(fixture(),r));
 }
 const r=request();delete r.targets[0].expected.price;assert.throws(()=>buildAgentPlan(fixture(),r));
});
test('拒绝原值/身份冲突、跨店、删除、部分加载、重复目标、超量和篡改计划',()=>{
 for(const patch of [{price:101},{skuId:'1'},{spu:'456'},{shortName:'改名'},{shopId:'other'},{deletedAt:'x'},{__workbenchSummary:true}]){
  const s=fixture();Object.assign(s.configs[0],patch);assert.throws(()=>buildAgentPlan(s,request()));
 }
 const r=request();r.targets.push(structuredClone(r.targets[0]));assert.throws(()=>buildAgentPlan(fixture(),r));
 r.targets=Array(65).fill(r.targets[0]);assert.throws(()=>buildAgentPlan(fixture(),r));
 const s=fixture(),p=buildAgentPlan(s,request());p.changes[0].after.custom.a=2;assert.throws(()=>validateAgentPlan(s,p));
 const p2=buildAgentPlan(s,request());s.revision++;assert.throws(()=>validateAgentPlan(s,p2));
});
test('拒绝同店SPU重复SKU，允许其他SPU或店铺相同SKU',()=>{
 for(const [spu,shopId,allowed] of [['123','intel',false],['456','intel',true],['123','other',true]]){
  const s=fixture();s.configs.push({...s.configs[0],id:'other',spu,shopId,skuId:'90071992547409931234'});
  if(allowed)assert.doesNotThrow(()=>buildAgentPlan(s,request()));else assert.throws(()=>buildAgentPlan(s,request()));
 }
});
