import test from 'node:test';
import assert from 'node:assert/strict';
import {replacementTasksPlan,upgradeDescriptionTasksPlan,applyReplacement,replacementDiff} from '../../public/workbench/global-batch.js';
import {checkInventory,stockReplacementTasksPlan,validateStockReplacement} from '../../public/workbench/inventory-check-data.js';
import {captureBatchRevert,batchRevertPlan} from '../../public/workbench/batch-revert.js';
const row=(id)=>({sourceId:'s'+id,goodsId:id,shopId:'intel',name:'配件'+id,erp:100,tax:110,addonText:'加购'+id});
const part=(id,slot,qty=1)=>({...row(id),slot,qty});
const config=(id='c',productId='p')=>({id,productId,shopId:'intel',product:productId,name:id,parts:[part('1','CPU'),part('2','内存',2)],actualParts:[part('2','内存',4),part('1','CPU')],addons:[{text:'独立服务'}]});
const costs=['1','2'].map(goodsId=>({goodsId,stockAvailable:0})),catalog=[row('3'),row('4')];
const tasks=()=>['1','2'].map((id,i)=>({partKey:'id:'+id,productIds:['p'],replacement:catalog[i],qty:null}));
const stockTasks=()=>['1','2'].map((id,i)=>({issueKey:id,productIds:['p'],sourceId:catalog[i].sourceId}));

test('库存两任务同时替换展示及独立实际清单，按部位对齐而不是行号，保留数量和无关链接',()=>{
 const configs=[config(),config('other','q')],before=structuredClone(configs),report=checkInventory(configs,costs,'intel');
 const plan=stockReplacementTasksPlan(configs,costs,catalog,report,stockTasks());
 assert.equal(plan.taskCount,2);assert.equal(plan.changes.length,1);assert.deepEqual(configs,before);
 validateStockReplacement(plan,configs,costs,catalog);applyReplacement(plan,configs);
 assert.deepEqual(configs[0].parts.map(p=>p.goodsId),['3','4']);assert.deepEqual(configs[0].actualParts.map(p=>p.goodsId),['4','3']);
 assert.equal(configs[0].parts[1].qty,2);assert.equal(configs[0].actualParts[0].qty,4);assert.deepEqual(configs[0].addons,before[0].addons);assert.deepEqual(configs[1],before[1]);
 assert.match(replacementDiff(plan),/展示配件 · CPU/);assert.match(replacementDiff(plan),/实际配置 · 内存/);
});
test('库存实际型号与展示型号不同，仍按部位一起替换并清除旧展示别名',()=>{
 const c=config();Object.assign(c.parts[0],row('99'),{displayName:'旧别名',posterVisible:false});
 const plan=stockReplacementTasksPlan([c],costs,catalog,checkInventory([c],costs,'intel'),[stockTasks()[0]]);
 const after=plan.changes[0].after;assert.equal(after.parts[0].goodsId,'3');assert.equal(after.actualParts[1].goodsId,'3');assert.equal(after.parts[0].displayName,undefined);assert.equal(after.parts[0].posterVisible,false);
});
test('旧数据没有实际清单时，两任务合并补齐实际清单',()=>{
 const c=config();delete c.actualParts;
 const plan=replacementTasksPlan([c],tasks());assert.deepEqual(plan.changes[0].after.actualParts.map(p=>p.goodsId),['3','4']);
});
test('同一配置不同部位合并一次保存和还原，任一并发修改阻止整批应用',()=>{
 const configs=[config()],before=structuredClone(configs),plan=replacementTasksPlan(configs,tasks());
 applyReplacement(plan,configs);const records=captureBatchRevert(plan,configs);assert.deepEqual(configs[0].parts.map(p=>p.goodsId),['3','4']);
 applyReplacement(batchRevertPlan(records,configs),configs);assert.deepEqual(configs,before);
 configs[0].price=100;assert.throws(()=>applyReplacement(plan,configs),/配置已变化/);assert.equal(configs[0].parts[0].goodsId,'1');
});
test('重叠替换任务冲突时拒绝全部，重复同目标同新配件去重',()=>{
 const configs=[config()],a=tasks()[0];
 assert.throws(()=>replacementTasksPlan(configs,[a,{...a,replacement:catalog[1]}]),/冲突/);
 assert.throws(()=>replacementTasksPlan(configs,[a,{...a,qty:2}]),/冲突/);
 assert.equal(replacementTasksPlan(configs,[a,a]).changes.length,1);assert.equal(configs[0].parts[0].goodsId,'1');
 const report=checkInventory(configs,costs,'intel');assert.throws(()=>stockReplacementTasksPlan(configs,costs,catalog,report,[stockTasks()[0],{...stockTasks()[0],sourceId:'s4'}]),/冲突/);
});
test('库存任务任一来源或库存过期，整个计划不能保存',()=>{
 const configs=[config()],plan=stockReplacementTasksPlan(configs,costs,catalog,checkInventory(configs,costs,'intel'),stockTasks());
 assert.throws(()=>validateStockReplacement(plan,configs,[costs[0],{...costs[1],stockAvailable:9}],catalog),/库存已变化/);
 assert.throws(()=>validateStockReplacement(plan,configs,costs,[catalog[0],{...catalog[1],addonText:'已变化'}]),/新配件或绑定加购已变化/);
 assert.equal(configs[0].parts[0].goodsId,'1');
});
test('展示名称多任务独立限定链接和配置，可清空别名，保持实际清单与加购',()=>{
 const configs=[config(),config('other','q')],before=structuredClone(configs);configs[1].parts[1].displayName='待恢复';
 const plan=upgradeDescriptionTasksPlan(configs,[{partKeys:['id:1'],productIds:['p'],description:'展示CPU'},{partKeys:['id:2'],productIds:['q'],description:''}],'displayName');
 applyReplacement(plan,configs);assert.equal(configs[0].parts[0].displayName,'展示CPU');assert.equal(configs[1].parts[1].displayName,undefined);
 assert.deepEqual(configs[0].actualParts,before[0].actualParts);assert.deepEqual(configs[0].addons,before[0].addons);
 assert.throws(()=>upgradeDescriptionTasksPlan(configs,[{partKeys:['id:1'],productIds:['p'],description:'x'.repeat(201)}],'displayName'),/200/);
});
test('缺失展示部位补上对应配件，重复部位阻止猜测替换',()=>{
 const c=config();c.parts.splice(0,1);const report=checkInventory([c],costs,'intel');
 const after=stockReplacementTasksPlan([c],costs,catalog,report,[stockTasks()[0]]).changes[0].after;
 assert.equal(after.parts.find(p=>p.slot==='CPU').goodsId,'3');
 c.parts.push(part('1','CPU'),part('1','CPU'));assert.throws(()=>stockReplacementTasksPlan([c],costs,catalog,checkInventory([c],costs,'intel'),[stockTasks()[0]]),/重复部位/);
});
