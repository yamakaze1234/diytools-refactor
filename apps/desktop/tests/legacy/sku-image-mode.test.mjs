import test from 'node:test';
import assert from 'node:assert/strict';
import {skuImageMode,skuImageConfig,applySkuImageMode} from '../../public/workbench/sku-image-mode.js';
import {exportEntries} from '../../public/workbench/global-batch.js';
import {sourceImageEntries} from '../../public/workbench/source-sync-data.js';

// 旧自动填充值不能冒充人工选择；显式选择经过 JSON 保存后由全部导出入口复用。
test('默认补白，显式保存后跨入口一致，改回补白且不影响其他配置',()=>{
 const rows=['a','b'].map(id=>({id,productId:'link',product:'测试',spu:'123',skuMode:'dedicated',parts:[]}));
 assert.equal(skuImageMode(rows[0]),'padded');
 assert.equal(skuImageConfig(rows[0]).skuMode,'padded');
 const untouched=structuredClone(rows[1]);
 assert.deepEqual(applySkuImageMode(rows,['a'],'dedicated'),['a']);
 const reopened=JSON.parse(JSON.stringify(rows));
 for(const entries of [exportEntries(reopened,['link'],'square'),sourceImageEntries(reopened).filter(e=>e.config.layout==='square')]){
  assert.deepEqual(entries.map(e=>e.config.skuMode),['dedicated','padded']);
 }
 assert.deepEqual(applySkuImageMode(reopened,['a'],'saved'),[]);
 assert.equal(skuImageMode(reopened[0]),'dedicated');
 applySkuImageMode(reopened,['a'],'padded');assert.equal(skuImageMode(reopened[0]),'padded');
 assert.deepEqual(reopened[1],untouched);
});

test('目标丢失时整批拒绝，避免部分配置保存样式',()=>{
 const rows=[{id:'a'},{id:'b',deletedAt:'today'}],before=structuredClone(rows);
 assert.throws(()=>applySkuImageMode(rows,['a','b'],'dedicated'),/目标已变化/);
 assert.deepEqual(rows,before);
});
