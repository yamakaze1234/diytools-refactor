import test from 'node:test';
import assert from 'node:assert/strict';
import {setConfigCost,resetConfigCost,hasConfigCost} from '../../public/workbench/config-cost.js';
import {applyManualCosts,mergeErp,validateSnapshot} from '../../public/workbench/erp-sync.js';
import {ensureActualParts,syncActualParts} from '../../public/workbench/actual-parts.js';
import {planSharedCostSync,planNasErpRows} from '../../public/workbench/nas-cost-overlay.js';
import {preferredSourceRows,sourcePart} from '../../public/workbench/source.js';
import {buildSourceSheet} from '../../public/workbench/source-sheet-model.js';
import {checkInventory} from '../../public/workbench/inventory-check-data.js';
import {maintenanceKind} from '../../public/workbench/source-maintenance-view.js';
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

// 同一个价格与库存基线下，仅类别变化也应可预览；旧 worker 不得覆盖历史分类。
test('ERP 分类在三店、单店及本机同步中区分省略、更新与清空',()=>{
 const row={goodsId:'1',name:'合成商品',sku:'S1',erp:8,stockAvailable:5,stockIncomingAvailable:1};
 const original={version:'v1',...row,erpCategory:'旧类别',erpOverride:true,nasErpOverride:true};
 const shops=['intel','gigabyte','jonsbo'];
 const stores=Object.fromEntries(shops.map(shop=>[shop,{'1':original}]));
 const snapshot={stores,common:{}};
 const single=new Map([['1',{version:'v1',document:original}]]);
 const state={sourceCatalog:[original],costSource:[original],configs:[]};
 for(const erpCategory of [undefined,'新类别',null]){
  const observed={...row,...(erpCategory===undefined?{}:{erpCategory})};
  const shared=planSharedCostSync(snapshot,[observed],'erp','intel');
  const local=planNasErpRows([observed],single,'erp','now');
  const merged=mergeErp(state,[observed],[],'now').next;
  for(const items of [merged.costSource,merged.sourceCatalog])
   assert.equal(items[0].erpCategory,erpCategory===undefined?'旧类别':erpCategory);
  if(erpCategory===undefined){
   assert.equal(shared.changes.length,0);
   assert.equal(local.changes.length,0);
   const changedStock={...observed,stockAvailable:7};
   assert.ok(!Object.hasOwn(planNasErpRows([changedStock],single,'erp','now').changes[0].fields,'erpCategory'));
   assert.ok(!Object.hasOwn(planSharedCostSync(snapshot,[changedStock],'erp','intel').changes[0].fields,'erpCategory'));
  }else{
   assert.equal(local.changes[0].fields.erpCategory,erpCategory);
   assert.equal(shared.changes[0].fields.erpCategory,erpCategory);
   assert.deepEqual(shared.examples.map(x=>[x.categoryBefore,x.categoryAfter]),shops.map(()=>['旧类别',erpCategory]));
  }
 }
 for(const erpCategory of [false,'长'.repeat(101),'无\u0085效']){
  const invalid={...row,erpCategory};
  assert.throws(()=>validateSnapshot({complete:true,total:1,rows:[invalid]}),/类别/);
  assert.throws(()=>planSharedCostSync(snapshot,[invalid],'erp','intel'),/类别/);
  assert.throws(()=>planNasErpRows([invalid],single,'erp','now'),/类别/);
 }
 const preferred=preferredSourceRows([original],[{...original,erpCategory:'新类别'}])[0];
 assert.equal(sourcePart(preferred).erpCategory,'新类别');
});

test('ERP 清空大类后换件、工作表和库存报告按部位归类；省略字段才沿用旧类别',()=>{
 const source={sourceId:'ssd',shopId:'intel',goodsId:'212618',name:'合成型号',erpCategory:'主板'};
 const config={id:'test',productId:'p',name:'合成配置',shopId:'intel',parts:[{...source,slot:'硬盘',qty:1}]};
 for(const [observation,expected] of [[{},'主板'],[{erpCategory:null},'硬盘'],[{erpCategory:'内存'},'内存']]){
  const costs=[{goodsId:source.goodsId,stockAvailable:0,...observation}];
  const [candidate]=preferredSourceRows([source],costs);
  assert.equal(sourcePart(candidate).erpCategory,Object.hasOwn(observation,'erpCategory')?observation.erpCategory:'主板');
  assert.equal(buildSourceSheet({rows:[source],costs,configs:[config]})[0].category,expected);
  assert.equal(checkInventory([config],costs,'intel',5,[source]).issues[0].category,expected);
  assert.equal(maintenanceKind(source,[config],costs),{'主板':'board','硬盘':'storageGb','内存':'memoryGb'}[expected]);
 }
 // 成本源未带类别时，已清空的来源也不能被配置里更老的副本覆盖。
 const costs=[{goodsId:source.goodsId,stockAvailable:0}];
 const clearedSource={...source,erpCategory:null};
 assert.equal(checkInventory([config],costs,'intel',5,[clearedSource]).issues[0].category,'硬盘');
 assert.equal(source.erpCategory,'主板');
});

test('单店预览区分尚未观察类别和已确认空类别，保持重复同步幂等',()=>{
 const row={goodsId:'1',name:'测试件',sku:'TEST',erp:45,stockAvailable:5};
 const versions=original=>new Map([[row.goodsId,{version:'1',document:{...original,nasErpOverride:true}}]]);
 const plan=(observed,original)=>planNasErpRows([observed],versions(original),'erp','now').changes;
 const cleared={...row,erpCategory:null};
 assert.deepEqual(plan(row,row),[]);
 assert.equal(plan(cleared,row)[0].fields.erpCategory,null);
 assert.deepEqual(plan(cleared,cleared),[]);
 assert.deepEqual(plan(row,cleared),[]);
});
