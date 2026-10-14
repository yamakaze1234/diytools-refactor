import test from 'node:test';
import assert from 'node:assert/strict';
import {setConfigCost,resetConfigCost,hasConfigCost} from '../../public/workbench/config-cost.js';
import {applyManualCosts,mergeErp} from '../../public/workbench/erp-sync.js';
import {ensureActualParts,syncActualParts} from '../../public/workbench/actual-parts.js';
import {totals} from '../../public/workbench/core.js';
import {normalizeWorkspaceState} from '../../public/workbench/shops.js';
import {seed} from './fixtures/workspace.mjs';


test('独立价格只影响当前实际行，保留数量、ERP价、源价和其他配置；支持零价和恢复',()=>{
 const c=structuredClone(seed.configs[0]);ensureActualParts(c);
 const original=structuredClone(c),p=c.actualParts[0],old=p.tax;
 setConfigCost(p,'0');assert.equal(hasConfigCost(p),true);
 assert.deepEqual(c.parts,original.parts);assert.equal(p.erp,original.actualParts[0].erp);
 assert.equal(totals(c).tax,totals(original).tax-old*p.qty);
 for(const value of ['',-1,'1.234','NaN'])assert.throws(()=>setConfigCost(p,value));
 const before=structuredClone(c.parts);c.parts[0].qty=2;syncActualParts(c,before);
 assert.equal(c.actualParts[0].tax,0);assert.equal(hasConfigCost(c.actualParts[0]),true);
 resetConfigCost(c.actualParts[0]);assert.equal(c.actualParts[0].tax,old);assert.equal(hasConfigCost(c.actualParts[0]),false);
});
test('共用成本更新、ERP快照合并保留独立价；恢复取最新共用价',()=>{
 const c=structuredClone(seed.configs[0]);ensureActualParts(c);const p=c.actualParts[0];
 const s=normalizeWorkspaceState({...structuredClone(seed),configs:[c],templates:[],sourceCatalog:[],costSource:[{goodsId:p.goodsId,name:p.name,tax:p.tax,erp:p.erp}]});
 const row=s.configs[0].actualParts[0];setConfigCost(row,'123.45');
 applyManualCosts(s,[{goodsId:p.goodsId,tax:999}]);assert.equal(row.tax,123.45);assert.equal(row.taxOverride.base,999);
 const refreshed=mergeErp(s,[{goodsId:p.goodsId,name:p.name,erp:800,stockAvailable:5}],[],'now').next;
 const loaded=structuredClone(refreshed);const actual=loaded.configs[0].actualParts[0];
 assert.equal(actual.tax,123.45);assert.equal(hasConfigCost(actual),true);assert.equal(actual.erp,800);
 resetConfigCost(actual,loaded.costSource);assert.equal(actual.tax,999);
});
