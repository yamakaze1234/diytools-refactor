import test from 'node:test';
import assert from 'node:assert/strict';
import {captureBatchRevert,batchRevertPlan} from '../../public/workbench/batch-revert.js';
const before={id:'a',productId:'p',shopId:'intel',name:'配置1',price:100,parts:[{slot:'显卡',goodsId:'old'}],actualParts:[{slot:'显卡',goodsId:'old'}]};
const saved={...before,parts:[{slot:'显卡',goodsId:'new'}],actualParts:[{slot:'显卡',goodsId:'new'}]};
const record=()=>captureBatchRevert({changes:[{id:'a',productId:'p',before,after:saved}]},[saved]);
test('批量还原保留后续其他字段修改，不修改输入',()=>{
 const current=structuredClone({...saved,price:200}),snapshot=structuredClone(current);
 const plan=batchRevertPlan(record(),[current]);assert.equal(plan.undo,true);assert.equal(plan.changes.length,1);
 assert.deepEqual(plan.changes[0].after,{...before,price:200});assert.deepEqual(current,snapshot);
 assert.equal(batchRevertPlan(record(),[{...before,price:200}]).changes.length,0);
});
test('批量还原拒绝同字段后改、删除与跨链接移动',()=>{
 for(const current of [{...saved,parts:[{slot:'显卡',goodsId:'third'}]},{...saved,deletedAt:'now'},{...saved,productId:'q'}])assert.throws(()=>batchRevertPlan(record(),[current]));
 assert.throws(()=>batchRevertPlan(record(),[]));
});
