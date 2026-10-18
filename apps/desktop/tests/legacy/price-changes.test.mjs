import test from 'node:test';
import assert from 'node:assert/strict';
import {priceMovement,trackedProfit,filterPriceItems,linkKey} from '../../public/workbench/price-changes.js';
const row=(a,b)=>({goodsId:'1',name:'内存',slots:['内存'],before:{erp:a},after:{erp:b}});
test('涨幅边界、零旧价、首次与缺失分离',()=>{
 assert.equal(priceMovement(row(10000,10500)).kind,'high');assert.equal(priceMovement(row(10000,10499)).kind,'up');
 assert.equal(priceMovement(row(10000,0)).percent,-100);assert.equal(priceMovement(row(0,100)).percent,null);
 assert.equal(priceMovement(row(null,100)).kind,'first');assert.equal(priceMovement(row(100,null)).kind,'missing');
});
test('实际BOM、数量和分期利润与现有口径一致',()=>{
 const c={price:1000,installment:12,parts:[{name:'展示',erp:999,tax:999,qty:1}],actualParts:[{name:'实际',goodsId:'1',erp:100,tax:110,qty:2}]};
 assert.deepEqual(trackedProfit(c),{tax:58000,erp:72000,fallback:false});
 c.actualParts[0].erpUnknown=true;assert.deepEqual(trackedProfit(c),{tax:58000,erp:70000,fallback:true});
 c.actualParts[0].tax=null;assert.equal(trackedProfit(c).tax,null);assert.equal(trackedProfit(c).erp,null);
 c.actualParts=[];assert.equal(trackedProfit(c).tax,null);
});
test('配件类型、幅度、编码组合筛选且跨店链接不合并',()=>{
 assert.equal(filterPriceItems([row(10000,11000),{...row(10000,9000),slots:['显卡']}],{slot:'内存',band:'high',search:'1'}).length,1);
 assert.notEqual(linkKey({shopId:'a',productId:'1'}),linkKey({shopId:'b',productId:'1'}));
});
