import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNasProfitReport} from '../../public/workbench/nas-profit-check.js';

const config=(id,fields={})=>({id,shopId:'intel',productId:id,name:id,product:'链接',price:300,installment:0,
 parts:[{name:'只用于展示',qty:1,tax:9999}],actualParts:[{name:'实际配件',slot:'CPU',qty:1,tax:0}],...fields});
const report=(configs,settings={},linkConfigs=configs)=>buildNasProfitReport({shopId:'intel',configIds:configs.map(c=>c.id),configs,settings,linkConfigs});

test('利润检测用实际 BOM 和精确分期扣费用，独立核算价要求商品 ID 原文一致',()=>{
 const c=config('a',{price:350,installment:6,priceBasis:'workbook',final_price_cents:'1234',actualParts:[
  {qty:'2',slot:'CPU',name:'实际配件',goodsId:'0003',tax:999,taxOverride:{goodsId:'0003',value:100}},
  {qty:1,name:'不算成本',specialComponent:true},{qty:1,name:'零价配件',goodsId:'0004',tax:0,taxOverride:{goodsId:'4',value:200}}
 ]});
 const outcome=report([c]),[row]=outcome.results;
 assert.equal(row.valid,true);assert.equal(outcome.run.erpCollected,false);
 assert.equal(row.profit_cents,2270);assert.equal(row.cost_cents,20000);
 assert.equal(row.snapshot.priceCents,35000);assert.equal(row.snapshot.feeCents,1330);
 assert.equal(row.snapshot.parts.map(p=>p.goodsId).join(','),'0003,0004');
});

test('缺值、零价、严格亏损门槛和同链接其它分期分别处理',()=>{
 const row=(tax,price=100)=>config(String(tax),{price,actualParts:[{name:'实际配件',qty:1,tax}]});
 const [missing,zero,exact,loss]=report([row(null),row(0),row(400),row(400.01)],{pricingRule:{taxRate:0,taxFixed:0}}).results;
 assert.equal(missing.profit_cents,null);assert.match(missing.reason,/含税价缺失/);
 assert.equal(zero.profit_cents,10000);assert.equal(exact.profit_cents,-30000);assert.equal(exact.loss,false);assert.equal(loss.loss,true);
 const a=config('a',{productId:'same-product',installment:6}),b=config('b',{productId:'same-product',installment:0});
 assert.match(report([a],{},[a,b]).results[0].reason,/分期无效/);
 assert.match(report([config('empty',{actualParts:[]})]).results[0].reason,/没有实际成本配件/);
 assert.throws(()=>report([config('template',{productCategory:'主机模板'})]),/范围|已变化/);
});
