import assert from 'node:assert/strict';
import test from 'node:test';
import {blankConfig,importTemplateConfigs,totals} from '../../public/workbench/core.js';
import {pricing,DEFAULT_PRICING_RULE} from '../../public/workbench/pricing.js';
import {parseIdPaste,planIdEdit,planPriceBatch,priceProfitRow,flagsFor,priceTail99} from '../../public/workbench/price-profit-model.js';
import {priceReportSheets} from '../../public/workbench/price-changes-export.js';
import {applyWorkspace,projectWorkspace} from '../../public/workbench/cloud-projection.js';
import {validateCloudRecord} from '../../public/workbench/cloud-protocol.js';
import {normalizeWorkspaceState} from '../../public/workbench/shops.js';

const fixture=(id='a',shopId='intel',productId='p')=>({id,shopId,productId,name:id,skuId:'00'+id.charCodeAt(0),spu:productId==='p'?'10':'20',price:1000,installment:6,actualParts:[{name:'CPU',goodsId:'1',qty:1,erp:500,tax:600}]});
const shopRule={...DEFAULT_PRICING_RULE,erpRate:5,taxRate:10,taxFixed:20,fee6:4.5};
const settings={coupon:100,pricingRule:shopRule};

test('继承、覆盖、已知零成本和未知数据共享一套利润口径',()=>{
 const c=fixture();
 assert.equal(pricing(c,settings).listPrice,1100);
 assert.equal(totals(c,settings).erpProfitAfter,405);
 assert.equal(totals(c,settings).taxProfitAfter,235);
 assert.equal(totals({...c,pricingRule:DEFAULT_PRICING_RULE},settings).taxProfitAfter,222);
 assert.equal(totals({...c,price:''},settings).erpProfitAfter,null);
 assert.equal(totals({...c,actualParts:[]},settings).taxProfitAfter,null);
 assert.equal(totals({...c,actualParts:[{...c.actualParts[0],erp:0,tax:null}]},settings).erpProfitAfter,905);
 assert.equal(totals({...c,actualParts:[{...c.actualParts[0],erp:0,tax:null}]},settings).taxProfitAfter,null);
 const penny=totals({price:'0.125',installment:6,actualParts:[{name:'CPU',qty:1,erp:0,tax:0}]},{pricingRule:{...shopRule,erpRate:4,fee6:4}});
 assert.equal(penny.erpProfitAfter,.11);
 const normalized=normalizeWorkspaceState({dataVersion:3,configs:[],shopSettings:{intel:{...settings,profitAlert:{mode:'rate',loss:0,target:24}}}});
 assert.deepEqual(normalized.shopSettings.intel.pricingRule,shopRule);
 assert.deepEqual(normalized.shopSettings.intel.profitAlert,{
  bases:['erp','tax'],erpProfit:{mode:'rate',loss:0,target:24},taxProfit:{mode:'rate',loss:0,target:24},
 });
 assert.equal(flagsFor(priceProfitRow(c,normalized.shopSettings.intel)).hits.target[0],'tax');
});

test('编号计划按给定可见顺序，保留长字符串；同一链接同步且冲突不产生部分计划',()=>{
 const a=fixture('a'),b=fixture('b'),c=fixture('c','intel','q'),d=fixture('d','jonsbo','p'),configs=[a,b,c,d];
 const initial=structuredClone(configs);
 const ids=parseIdPaste("SKU ID\r\n'00090071992547409931234\r\n003\r\n",'sku');
 assert.deepEqual(planIdEdit(configs,'sku',['b','a'],ids),[{id:'a',fields:{skuId:'003'}},{id:'b',fields:{skuId:'00090071992547409931234'}}]);
 assert.deepEqual(planIdEdit(configs,'spu',['b'],['00090071992547409931235']).map(x=>x.id),['a','b']);
 assert.throws(()=>planIdEdit(configs,'spu',['b','a'],['81','82']),/同一链接/);
 assert.throws(()=>planIdEdit(configs,'sku',['a','b'],['555',c.skuId]),/已有/);
 assert.throws(()=>planIdEdit(configs,'sku',['a'],ids),/可见/);
 assert.throws(()=>parseIdPaste('001\n1E25','sku'),/科学计数/);
 assert.deepEqual(configs,initial);
});

test('四种批量调价含精确目标验算，缺成本跳过，纯计划不改原配置',()=>{
 const c=fixture(),row=priceProfitRow(c,settings);
 const plan=(mode,input,rows=[row])=>planPriceBatch(rows,{mode,input,basis:'tax'});
 assert.equal(plan('delta','-100')[0].price,900);
 assert.equal(plan('ratio','10')[0].price,1100);
 for(const [mode,goal] of [['target',300],['margin',24]]){
  const next=plan(mode,goal)[0].price,actual=totals({...c,price:next},settings);
  assert.ok((mode==='margin'?actual.taxMargin:actual.taxProfitAfter)>=goal);
 }
 assert.match(plan('margin',95)[0].reason,/过高/);
 assert.match(plan('target',300,[priceProfitRow({...c,actualParts:[]},settings)])[0].reason,/缺少/);
 assert.equal(c.price,1000);
});

test('尾数 99 按核算保本价向上取整，缺少成本或超出上限时留空',()=>{
 const c=fixture(),row=priceProfitRow(c,settings);
 assert.equal(priceTail99(row),799);
 const noCost=priceProfitRow({...c,actualParts:[]},settings);
 assert.equal(priceTail99(noCost),null);
 const overLimit=priceProfitRow({...c,actualParts:[{...c.actualParts[0],tax:900000}]},settings);
 assert.equal(priceTail99(overLimit),null);
});

test('空链接模板接续占位，历史价格报表区分历史与现用扣点',()=>{
 const product={id:'p',shopId:'intel',name:'空链接',pricingRule:shopRule,installment:6,configs:[]};
 const draft={...blankConfig(null,product),emptyLinkDraft:true};
 product.configs=[draft];
 const imported=importTemplateConfigs([blankConfig(null,{id:'example'})],product);
 assert.equal(imported[0].name,'配置1');
 assert.deepEqual(imported[0].pricingRule,shopRule);
 const c=fixture(),old={...c,shopPricingRule:DEFAULT_PRICING_RULE};
 const batch={items:[],configs:[{before:old,after:old}],handled:[],at:'2026-01-01T00:00:00Z'};
 const report=priceReportSheets(batch,{configs:[c],settings:()=>settings})[2];
 const header=report.rows[0],row=report.rows[1];
 assert.equal(row[header.indexOf('核算利润-后')],222);
 assert.equal(row[header.indexOf('当前核算利润')],235);
});


test('云协议维持整数分，往返保留未定价、显式零、链接规则与店铺预警',()=>{
 const shop={...settings,profitAlert:{bases:['erp','tax'],erpProfit:{mode:'amount',loss:-15,target:300},taxProfit:{mode:'rate',loss:-2,target:30}}};
 const state=normalizeWorkspaceState({dataVersion:3,configs:[
  {...fixture('a'),price:null,parts:[],pricingRule:DEFAULT_PRICING_RULE},
  {...fixture('b'),price:0,parts:[]},
  {...fixture('c'),price:'',parts:[]},
 ],shopSettings:{intel:shop}});
 const records=projectWorkspace(state);
 for(const {type,id,data} of records)validateCloudRecord(type,id,data);
 for(const record of records.filter(r=>r.type==='configuration'))assert.equal(record.data.priceCents,0);
 const recovered=applyWorkspace(state,records);
 assert.deepEqual(recovered.configs.map(c=>c.price),[null,0,null]);
 assert.deepEqual(recovered.configs[0].pricingRule,DEFAULT_PRICING_RULE);
 assert.deepEqual(recovered.shopSettings.intel.profitAlert,shop.profitAlert);
 const row=priceProfitRow(fixture(),recovered.shopSettings.intel);
 assert.deepEqual(flagsFor(row).hits.target,['tax']);
 for(const basis of ['erp','tax']){
  const selected=priceProfitRow(fixture(),{...shop,profitAlert:{...shop.profitAlert,bases:[basis]}});
  assert.equal(flagsFor(selected).target,basis==='tax');
 }
 const both=priceProfitRow(fixture(),{...shop,profitAlert:{...shop.profitAlert,erpProfit:{mode:'amount',loss:0,target:500}}});
 assert.deepEqual(flagsFor(both).hits.target,['erp','tax']);
 assert.deepEqual(recovered.shopSettings.intel.pricingRule,shopRule);
});
