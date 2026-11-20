import test from 'node:test';
import assert from 'node:assert/strict';
import {priceForTarget,snap99} from '../../public/workbench/batch-profit-price.js';
import {overviewTableTotals} from '../../public/workbench/overview-table-model.js';
import {pricing} from '../../public/workbench/pricing.js';
import {projectedRows,appendAccessoryRow,removeLastAccessoryRow} from '../../public/workbench/continuous-parts.js';

// 对照用户指定的分期/ERP口径，验证反推公式和未知成本边界。
const config={price:2000,installment:24,parts:[{slot:'CPU',goodsId:'1',qty:1,erp:1000,tax:1100}],actualParts:[{slot:'CPU',goodsId:'1',qty:1,erp:1000,tax:1100}],addons:[]};
test('ERP profit does not charge installments; inverse rounds to yuan',()=>{
 const result=overviewTableTotals(config,{erp:1000,tax:1100},pricing(config));
 assert.equal(result.erpProfit,960);assert.equal(result.taxProfit,556);
 assert.equal(priceForTarget(config,{},'erp',100),1122);
 assert.equal(priceForTarget(config,{},'tax',100),1493);
 assert.equal(priceForTarget({...config,actualParts:[{slot:'CPU',qty:1,erp:null,tax:null}]},{},'erp',100),null);
});
test('99 rule has the requested 49/50 boundary and zero-tail cancellation can remain false',()=>{
 assert.deepEqual([4000,4049,4050,4099,4100].map(snap99),[3999,3999,4099,4099,4099]);
 assert.equal(priceForTarget({...config,overviewPrice99:true},{},'erp',100),1099);
 assert.equal(priceForTarget({...config,overviewPrice99:false},{},'erp',100),1122);
});
test('empty accessories start hidden; reducing cannot remove filled upgrade or actual part',()=>{
 const c={parts:[],actualParts:[],addons:[]};assert.equal(projectedRows(c).length,9);
 assert.equal(appendAccessoryRow(c),'配件1');assert.equal(projectedRows(c).length,10);
 c.parts.push({slot:'配件1',name:'',upgrade:'保留文案',qty:1});
 assert.throws(()=>removeLastAccessoryRow(c),/还有内容/);
 c.parts=[];assert.equal(removeLastAccessoryRow(c),'配件1');assert.equal(projectedRows(c).length,9);
 c.actualParts=[{slot:'配件5',goodsId:'1',name:'已填',qty:1}];assert.ok(projectedRows(c).some(r=>r.slot==='配件5'));
});

// 隔着隐藏空行存在高编号配件时，每次只补一行，不能返回已有配件。
test('adding an accessory reveals only the next hidden slot or appends a fresh slot',()=>{
 const c={parts:[{slot:'配件5',name:'已填',qty:1}],actualParts:[]};
 const before=projectedRows(c).length;assert.equal(appendAccessoryRow(c),'配件1');assert.equal(projectedRows(c).length,before+1);
 c.overviewAccessoryLimit=4;assert.equal(appendAccessoryRow(c),'配件6');assert.ok(projectedRows(c).some(r=>r.slot==='配件6'));
});
