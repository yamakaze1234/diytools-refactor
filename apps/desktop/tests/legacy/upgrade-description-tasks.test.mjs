import test from 'node:test';
import assert from 'node:assert/strict';
import {upgradeDescriptionTasksPlan,applyReplacement} from '../../public/workbench/global-batch.js';
import {captureBatchRevert,batchRevertPlan} from '../../public/workbench/batch-revert.js';

const configs=()=>['a','b','c'].map((id,i)=>({id,productId:i===2?'q':'p',product:i===2?'链接乙':'链接甲',name:id,price:5000,parts:[{slot:'散热',goodsId:'10',name:'原散热',qty:1,upgrade:'旧散热描述'},{slot:'电源',goodsId:'20',name:'原电源',qty:1,upgrade:'旧电源描述'}],actualParts:[{slot:'散热',goodsId:'10',qty:1}],addons:[{text:'人工加购'}]}));
const task=(part,description,extra={})=>({partKeys:['id:'+part],productIds:['p'],description,...extra});

test('多任务合并同一配置的不同配件文案，一次应用并一次还原，保留实际配置和人工加购',()=>{
 const rows=configs(),before=structuredClone(rows);
 const plan=upgradeDescriptionTasksPlan(rows,[task('10','新散热'),task('20','新电源')]);
 assert.deepEqual(rows,before);assert.equal(plan.changes.length,2);assert.equal(plan.taskCount,2);
 applyReplacement(plan,rows);
 for(const row of rows.slice(0,2)){assert.equal(row.parts[0].upgrade,'新散热');assert.equal(row.parts[1].upgrade,'新电源');assert.deepEqual(row.actualParts,before[0].actualParts);assert.deepEqual(row.addons,before[0].addons);assert.equal(row.price,5000);}
 assert.deepEqual(rows[2],before[2]);
 const undo=batchRevertPlan(captureBatchRevert(plan,rows),rows);applyReplacement(undo,rows);assert.deepEqual(rows,before);
});

test('不同任务独立限定配置、链接、类型和旧描述，空文案可清除',()=>{
 const rows=configs();rows[1].parts[0].upgrade='其他描述';
 const plan=upgradeDescriptionTasksPlan(rows,[task('10','',{descriptionQuery:'旧散热',slot:'散热'}),task('20','跨链接电源',{productIds:['q'],configIds:['c']})]);
 applyReplacement(plan,rows);
 assert.equal(rows[0].parts[0].upgrade,'');assert.equal(rows[1].parts[0].upgrade,'其他描述');assert.equal(rows[2].parts[1].upgrade,'跨链接电源');assert.equal(rows[0].parts[1].upgrade,'旧电源描述');
});

test('重复目标同文案去重，不同文案含原值均报冲突，预览不改输入',()=>{
 const rows=configs(),before=structuredClone(rows);
 assert.equal(upgradeDescriptionTasksPlan(rows,[task('10','新文案'),task('10','新文案')]).changes.length,2);
 for(const value of ['另一描述','旧散热描述'])assert.throws(()=>upgradeDescriptionTasksPlan(rows,[task('10','新文案'),task('10',value)]),/任务 1 与 任务 2.*冲突/);
 assert.deepEqual(rows,before);
});

test('空任务或失效范围不能静默跳过，过期配置阻止整批应用',()=>{
 const rows=configs();
 assert.throws(()=>upgradeDescriptionTasksPlan(rows,[]),/添加修改任务/);
 assert.throws(()=>upgradeDescriptionTasksPlan(rows,[task('10','新'),task('20','新',{partKeys:[]})]),/任务 2.*原配件/);
 assert.throws(()=>upgradeDescriptionTasksPlan(rows,[task('10','新',{productIds:[]})]),/选择影响的链接/);
 assert.throws(()=>upgradeDescriptionTasksPlan(rows,[task('10','新',{configIds:[]})]),/没有匹配配置/);
 const plan=upgradeDescriptionTasksPlan(rows,[task('10','新'),task('20','另一个新')]);rows[1].price=6000;
 assert.throws(()=>applyReplacement(plan,rows),/配置已变化/);assert.equal(rows[0].parts[0].upgrade,'旧散热描述');
});
