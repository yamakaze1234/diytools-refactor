import test from 'node:test';
import assert from 'node:assert/strict';
import {priceHistoryCurrent,priceHistorySnapshot} from '../src/price-history.mjs';
import {visibleNasCosts} from '../../../apps/desktop/public/workbench/nas-cost-overlay.js';
import {trackedProfit} from '../../../apps/desktop/public/workbench/price-changes.js';

test('涨跌明细的当前值与变动前后利润都采用总表的有效 ERP 成本',()=>{
 const goodsId='212618',part={goodsId,name:'固态硬盘',slot:'硬盘',qty:1,tax:560,erp:520};
 const config={id:'test',productId:'p',price:999,installment:0,actualParts:[part]};
 const original=structuredClone(config);
 const before={goodsId,name:part.name,erp:560.33864542,tax:560};
 const after={...before,nasErpOverride:true,erp:561};
 const args={configs:[config],linkConfigs:[config],settings:{},costs:new Map([[goodsId,before]])};
 const projected=row=>trackedProfit(visibleNasCosts(structuredClone(config),new Map([[goodsId,row]])),{});
 const current=priceHistoryCurrent(args)[0].loggedProfit;
 assert.equal(current.erp,41868);
 assert.deepEqual(current,projected(before));
 const snapshot=priceHistorySnapshot({...args,changes:new Map([[goodsId,{before,after}]])}).configs[0];
 assert.deepEqual(snapshot.before.loggedProfit,current);
 assert.deepEqual(snapshot.after.loggedProfit,projected(after));
 assert.equal(snapshot.after.loggedProfit.erp,41802);
 // 零价、显式缺价和未观察到的成本均与工作台一致，并保留原配置。
 for(const row of [{...before,erp:0},{...after,erp:null},{...before,erp:null},{...before,erpUnknown:true}]){
  const [result]=priceHistoryCurrent({...args,costs:new Map([[goodsId,row]])});
  assert.deepEqual(result.loggedProfit,projected(row));
 }
 assert.deepEqual(config,original);
});
