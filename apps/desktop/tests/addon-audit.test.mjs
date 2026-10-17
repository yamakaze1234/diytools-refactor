import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAddonAudit,filterAddonAudit} from '../public/workbench/addon-audit.js';

const source=(id,patch={})=>({sourceId:id,shopId:'intel',goodsId:'1',name:id,erp:650,tax:650,addonText:'【+799元升级内存】',addonGoodsId:'2',addonPriceCents:79900,addonQty:2,...patch});
const cost={goodsId:'2',name:'升级内存',erp:750,tax:750};
test('audit preserves existing severity thresholds, flattens choices, and excludes deleted/empty sources without mutation',()=>{
 const rows=[source('danger'),source('warning',{erp:700}),source('pending',{tax:null}),source('ok',{addonPriceCents:90000}),source('deleted',{deletedAt:'now'}),source('empty',{addonText:''}),source('choices',{addonChoices:[{id:'a',label:'升级内存',goodsId:'2',qty:2,priceCents:79900,enabled:false},{id:'b',label:'升级内存',goodsId:'2',qty:1,priceCents:79900,enabled:true}]})];
 const before=structuredClone(rows),checks=buildAddonAudit(rows,[cost],[]);
 assert.equal(checks.length,6);assert.deepEqual(checks.slice(0,4).map(c=>c.result.severity),['danger','danger','warning','pending']);
 assert.equal(checks.find(c=>c.row.sourceId==='danger').result.fields[0].diffCents,-5100);
 assert.deepEqual(rows,before);assert.equal(checks.filter(c=>c.row.sourceId==='choices').length,2);
});
test('category uses exact source identity before same-shop goods ID fallback and keeps unknown sources visible',()=>{
 const rows=[source('exact'),source('fallback'),source('unknown',{goodsId:'99'})];
 const configs=[{shopId:'intel',parts:[{sourceId:'exact',goodsId:'1',slot:'内存'}]},{shopId:'other',parts:[{goodsId:'1',slot:'显卡'}]},{shopId:'intel',deletedAt:'now',parts:[{sourceId:'unknown',goodsId:'99',slot:'CPU'}]}];
 const checks=buildAddonAudit(rows,[cost],configs);
 assert.deepEqual(checks.map(c=>c.categories),[['内存'],['内存'],['未分类']]);
});
test('combined status, slot and case-insensitive search filters intersect without dropping multi-slot items',()=>{
 const checks=buildAddonAudit([source('exact'),source('unknown',{goodsId:'99',addonPriceCents:90000})],[cost],[{shopId:'intel',parts:[{sourceId:'exact',slot:'内存'},{sourceId:'exact',slot:'配件1'}]}]);
 assert.equal(checks.length,2);
 for(const category of ['内存','配件1'])assert.equal(filterAddonAudit(checks,{status:'danger',category,query:'升级内存'}).length,1);
 assert.equal(filterAddonAudit(checks,{status:'ok',category:'内存'}).length,0);
 assert.equal(filterAddonAudit(checks,{query:'EXACT'}).length,1);
 assert.equal(filterAddonAudit(checks,{category:'未分类',query:'99'}).length,1);
});
