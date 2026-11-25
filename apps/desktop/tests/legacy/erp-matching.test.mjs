// ERP 快照和附加规则离线测试，不调用真实登录或写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultErpExtrasForShop,normalizeErpDefaultExtras} from '../../public/workbench/erp-default-extras.js';
import {matchingSnapshot} from '../../public/workbench/erp-matching-model.js';
const config={id:'c',shopId:'intel',name:'配置1',shortName:'简称',spu:'001',skuId:'002',actualParts:[{goodsId:'1',qty:2,name:'CPU'},{specialComponent:true,slot:'显卡',qty:1},{goodsId:'2',qty:1,name:'【写配置用/不会出货】占位'}]};
test('三店首次预览使用各自固定明细，显式保存空表优先，恢复表单互不共享',()=>{
 const expected={intel:['29369','131060','7031','56020','50681'],gigabyte:['29369','131060','7031','56020','186552','46383'],jonsbo:['29369','131060','7031']};
 for(const [shopId,ids] of Object.entries(expected)){
  const defaults=defaultErpExtrasForShop(shopId);
  assert.deepEqual(defaults.map(row=>row.goodsId),ids);
  assert.ok(defaults.every(row=>row.qty===1&&row.name));
  assert.deepEqual(matchingSnapshot({...config,shopId},{}).extras,defaults);
  assert.deepEqual(matchingSnapshot({...config,shopId},{erpDefaultExtras:[]}).extras,[]);
  defaults[0].qty=9;assert.equal(defaultErpExtrasForShop(shopId)[0].qty,1);
 }
});
test('每店固定附加按精确 GoodID 合并正整数数量，不修改输入',()=>{
 const extras=[{goodsId:'12',qty:2,name:'电源线'},{goodsId:12,qty:3,name:'电源线'}],before=structuredClone(extras);
 assert.deepEqual(normalizeErpDefaultExtras(extras),[{goodsId:'12',qty:5,name:'电源线'}]);assert.deepEqual(extras,before);
 for(const value of [null,{},[{goodsId:1.5,qty:1,name:'x'}],[{goodsId:'1',qty:0,name:'x'}],[{goodsId:'1',qty:1,name:'\0'}]])assert.throws(()=>normalizeErpDefaultExtras(value));
});
test('冻结已保存实际配件、店铺与 SPU/SKU，特殊件只留排除标记',()=>{
 const snapshot=matchingSnapshot(config,{erpDefaultExtras:[{goodsId:'9',qty:1,name:'固定附加'}]},{version:'7'});
 assert.equal(snapshot.shopId,'76');assert.equal(snapshot.spu,'001');assert.equal(snapshot.sku,'002');assert.equal(snapshot.savedVersion,'7');assert.equal(snapshot.actualParts[1].special,true);
 assert.equal(snapshot.actualParts[0].qty,2);assert.deepEqual(snapshot.extras,[{goodsId:'9',qty:1,name:'固定附加'}]);
 for(const changes of [{skuId:''},{actualParts:[{specialComponent:true}]},{actualParts:[{goodsId:'1',qty:0,name:'CPU'}]}])assert.throws(()=>matchingSnapshot({...config,...changes},{}));
 assert.throws(()=>matchingSnapshot(config,{erpShopId:'99'}));
});
