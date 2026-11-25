// 合成配置覆盖同一业务文档的四个入口；不接触实际店铺或业务数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {totals,productGroups} from '../../public/workbench/core.js';
import {pricing,DEFAULT_PRICING_RULE} from '../../public/workbench/pricing.js';
import {overviewTableTotals,PROFIT_FORMULA_VERSION} from '../../public/workbench/overview-table-model.js';
import {priceProfitRow,flagsFor,planPriceMatrix} from '../../public/workbench/price-profit-model.js';
import {buildNasProfitReport} from '../../public/workbench/nas-profit-check.js';
import {trackedProfit} from '../../public/workbench/price-changes.js';
import {parseStandardProduct,planStandardProduct,applyStandardProduct,exportStandardProduct} from '../../public/workbench/product-standard.js';

const settings={coupon:400,pricingRule:{...DEFAULT_PRICING_RULE,erpRate:30,taxRate:40,erpFixed:800,taxFixed:900,fee6:3.25,fee12:6.75,fee24:20}};
const fixture=(id='a')=>({id,shopId:'intel',productId:'link',product:'合成链接',name:'配置5',shortName:'手工简称',shortNameAuto:false,
 spu:'123',skuId:id==='a'?'100':'101',price:2999,installment:0,overviewFeeRate:5.125,
 parts:[{slot:'CPU',goodsId:'1',name:'展示',qty:2,erp:500,tax:600}],
 actualParts:[{slot:'CPU',goodsId:'1',name:'实际',qty:2,erp:500,tax:600},{slot:'显卡',name:'核显',specialComponent:true,qty:null,erp:null,tax:null}]});

for(const [term,fee] of [[0,0],[6,97.47],[12,202.43],[24,299.9]])test(`${term}期：价格、总表、NAS检测、价格追踪利润一致`,()=>{
 const c={...fixture(),installment:term},quote=pricing(c,settings),raw=totals(c,settings),overview=overviewTableTotals(c,raw,quote);
 const row=priceProfitRow(c,settings),report=buildNasProfitReport({shopId:'intel',configIds:[c.id],configs:[c],settings}).results[0];
 // 手算成本费率：1200 + 1200×5.125% +100 =1361.50；ERP不扣任何分期。
 assert.equal(overview.fee,1361.5);assert.equal(quote.fee,fee);
 assert.equal(row.metrics.taxProfitAfter,Math.round((2999-1361.5-fee)*100)/100);
 assert.equal(row.metrics.erpProfitAfter,1939.02);
 assert.equal(overview.taxProfit,row.metrics.taxProfitAfter);assert.equal(overview.erpProfit,row.metrics.erpProfitAfter);
 assert.equal(report.profit_cents,Math.round(overview.taxProfit*100));assert.equal(report.snapshot.formulaVersion,PROFIT_FORMULA_VERSION);
 assert.equal(report.snapshot.overviewFeeRate,5.125);
 assert.deepEqual(trackedProfit(c,settings),{tax:report.profit_cents,erp:193902,fallback:false});
 assert.equal(quote.listPrice,3399);
});

test('仅特殊配件按0元，不出现缺价、ERP未识别或独立价提醒',()=>{
 const c={...fixture(),actualParts:[{specialComponent:true,name:'特殊项',erp:null,tax:null,qty:null,taxOverride:{goodsId:'',value:500}}]};
 const row=priceProfitRow(c,settings);assert.equal(row.metrics.tax,0);assert.equal(row.metrics.erp,0);
 assert.equal(flagsFor(row).missing,false);assert.equal(flagsFor(row).fallback,false);
 assert.equal(row.metrics.taxProfitAfter,2899);
 assert.equal(buildNasProfitReport({shopId:'intel',configIds:[c.id],configs:[c],settings}).results[0].profit_cents,289900);
});

test('矩阵一次计划验证最终SPU+SKU，可交换、跨店复用，错误不修改原文档',()=>{
 const a={...fixture(),shortNameAuto:true},b=fixture('b'),other={...fixture('x'),shopId:'jonsbo'},configs=[a,b,other],before=structuredClone(configs);
 const plan=planPriceMatrix(configs,['a','b'],['spu','sku','shortName',null,'price','rate'],[
  ['456','101','甲','只读忽略','3000','4'],['456','100','乙','','3100','6']
 ],()=>settings);
 assert.equal(plan.length,2);assert.equal(plan[0].fields.shortNameAuto,false);assert.equal(plan[0].fields.overviewFeeRate,4);
 assert.throws(()=>planPriceMatrix(configs,['a','b'],['sku'],[['101'],['101']],()=>settings),/SPU \+ SKU/);
 assert.throws(()=>planPriceMatrix(configs,['a'],['sku'],[['1E+18']],()=>settings),/科学计数法/);
 assert.throws(()=>planPriceMatrix(configs,['a'],['rate'],[['31']],()=>settings),/0–30/);
 assert.throws(()=>planPriceMatrix(configs,['a'],['spu'],[['789'],['789']],()=>settings),/可见/);
 assert.deepEqual(configs,before);
});

test('单格SPU广播整链，利润输入按总表反推，旧配置名称保持原序号',()=>{
 const a=fixture(),b=fixture('b'),rows=[a,b];
 const spu=planPriceMatrix(rows,['a'],['spu'],[['456']],()=>settings);assert.deepEqual(spu.map(c=>c.id),['a','b']);
 const plan=planPriceMatrix(rows,['a'],['taxTarget'],[['500']],()=>settings);
 assert.equal(plan[0].fields.price,1862);assert.equal(a.name,'配置5');
 const rounded=planPriceMatrix([{...a,overviewPrice99:true}],['a'],['erpTarget'],[['500']],()=>settings);
 assert.equal(rounded[0].fields.price,1499);
});

test('商品标准表SKU名称映射简称，店铺券往返，重新编号继续使用配置名称',()=>{
 const c=fixture(),state={configs:[c],shopSettings:{intel:settings},sourceCatalog:[],costSource:[]};
 const product=productGroups(state.configs)[0];
 const exported=exportStandardProduct(state,product,{erpShopId:'232810'});
 assert.equal(exported.SKU['100'].SKU名称,'手工简称');assert.equal(exported.SKU['100'].SKU价格,3399);
 exported.SKU['100'].SKU名称='新SKU文案';exported.SKU['100'].SKU价格=3599;
 const input=parseStandardProduct(exported),options={prices:true,erpShopId:'232810'};
 const plan=planStandardProduct(input,state,product,options);
 assert.deepEqual(plan.errors,[]);const result=applyStandardProduct(plan,state,product).next.configs[0];
 assert.equal(result.shortName,'新SKU文案');assert.equal(result.shortNameAuto,false);assert.equal(result.price,3199);
 assert.equal(result.name,'配置5');assert.equal(result.posterSubtitle,undefined);
 input.SKU['100'].SKU名称=null;
 const blankNamePlan=planStandardProduct(input,state,product,options);
 assert.equal(applyStandardProduct(blankNamePlan,state,product).next.configs[0].shortName,'手工简称');
 const legacy={...c};delete legacy.shortName;
 assert.equal(exportStandardProduct({...state,configs:[legacy]},product,{erpShopId:'232810'}).SKU['100'].SKU名称,'配置5');
});
