import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceBothParts} from "../../public/workbench/replace-both-parts.js";
import {stockReplacementTasksPlan,inventoryCounts,configurationStock,checkInventory,componentStock,inventoryThreshold,stockReplacementPlan,validateStockReplacement} from '../../public/workbench/inventory-check-data.js';
import {applyReplacement,replacementDiff} from '../../public/workbench/global-batch.js';
const costs=[{goodsId:'100',stockAvailable:0,stockUpdatedAt:'2026-09-18T10:00:00Z'},{goodsId:'200',stockAvailable:5},{goodsId:'300',stockAvailable:6},{goodsId:'400',stockAvailable:null}];
const original={sourceId:'old',goodsId:'100',name:'旧 CPU',qty:2,slot:'CPU',posterVisible:false,erp:100,tax:120};
const config=(id,productId)=>({id,productId,shopId:'intel',product:productId,name:id,parts:[structuredClone(original)],addons:[{sourceId:'old',text:'原绑定加购',variantId:'old-variant'},{text:'独立服务'}]});
const replacement={sourceId:'new',shopId:'intel',goodsId:'300',name:'新 CPU',erp:200,tax:220,addonText:'新绑定加购',addonGoodsId:'200',addonPriceCents:1000,addonQty:1};
test('stock scan groups exact IDs and ignores specials, other shops, deleted and draft configs',()=>{
 const a=config('a','p'),b=config('b','q');a.parts.push({slot:'配件1',name:'免费服务',specialComponent:true,goodsId:''},{name:'低库存',goodsId:'200'},{name:'充足',goodsId:'300'},{name:'未知',goodsId:'400'});
 const report=checkInventory([a,b,{...config('x','x'),shopId:'jonsbo'},{...config('deleted','d'),deletedAt:'now'},{...config('draft','d'),emptyLinkDraft:true}],costs,'intel',5);
 assert.equal(report.linkCount,2);assert.equal(report.skippedSpecial,1);assert.equal(report.issues.length,3);assert.equal(report.issues[0].sources.length,2);assert.equal(report.issues[0].sources[0].slot,'CPU');assert.deepEqual(report.issues.map(r=>r.status),['out','low','unknown']);
 assert.equal(checkInventory([a],costs,'intel',4).issues.some(r=>r.goodsId==='200'),false);
});
test('unknown remains unknown: absent or duplicated inventory, null, strings and missing ERP records',()=>{
 for(const rows of [[],[{goodsId:'100',stockAvailable:null}],[{goodsId:'100',stockAvailable:''}],[{goodsId:'100',stockAvailable:'0'}],[{goodsId:'100',stockAvailable:0,erpMissing:true}],[costs[0],costs[0]]])assert.equal(componentStock('100',rows).status,'unknown');
 assert.equal(componentStock('100',[{goodsId:'100',stockAvailable:-2}]).status,'out');
 assert.equal(componentStock('0',[{goodsId:'0',stockAvailable:0}]).status,'unknown');
 const a=config('a','p');a.parts[0].stockAvailable=0;assert.equal(checkInventory([a],[],'intel').issues[0].status,'unknown');
 assert.throws(()=>inventoryThreshold(''),/阈值/);assert.throws(()=>inventoryThreshold('-1'),/阈值/);assert.throws(()=>inventoryThreshold('1.5'),/阈值/);assert.equal(inventoryThreshold('5'),5);
});
test('replacement affects only selected links and keeps quantity, hidden state and independent addons',()=>{
 const configs=[config('a','p'),config('b','q')],before=structuredClone(configs),report=checkInventory(configs,costs,'intel');
 const plan=stockReplacementPlan(configs,costs,[replacement],report,'100',['p'],'new');validateStockReplacement(plan,configs,costs,[replacement]);applyReplacement(plan,configs);
 assert.deepEqual(configs[1],before[1]);assert.equal(configs[0].parts[0].goodsId,'300');assert.equal(configs[0].parts[0].qty,2);assert.equal(configs[0].parts[0].posterVisible,false);assert.deepEqual(configs[0].addons,before[0].addons);assert.equal(configs[0].parts[0].upgrade,'新绑定加购');assert.ok(configs[0].addons.some(a=>a.text==='独立服务'));
});
test('multiple source descriptions for same goodsId are replaced together while preserving existing manual addons',()=>{
 const a=config('a','p');a.parts.push({...original,slot:'配件1',sourceId:'old2'});a.addons.push({sourceId:'old2',text:'第二条绑定'});
 const report=checkInventory([a],costs,'intel'),plan=stockReplacementPlan([a],costs,[replacement],report,'100',['p'],'new');
 assert.equal(plan.changes[0].after.parts.every(p=>p.sourceId==='new'),true);assert.deepEqual(plan.changes[0].after.addons,a.addons);
});
test('stale stock, changed replacement addon and concurrent config edits reject before any changes',()=>{
 const configs=[config('a','p'),config('b','q')],report=checkInventory(configs,costs,'intel'),plan=stockReplacementPlan(configs,costs,[replacement],report,'100',['p','q'],'new');
 assert.throws(()=>validateStockReplacement(plan,configs,[{...costs[0],stockAvailable:20}], [replacement]),/库存已变化/);
 assert.throws(()=>validateStockReplacement(plan,configs,costs,[{...replacement,addonText:'被修改'}]),/绑定加购已变化/);
 configs[1].price=600;assert.throws(()=>validateStockReplacement(plan,configs,costs,[replacement]),/配置已变化/);assert.equal(configs[0].parts[0].goodsId,'100');
 configs[1].parts[0].qty=3;assert.throws(()=>stockReplacementPlan(configs,costs,[replacement],report,'100',['p'],'new'),/使用情况已变化/);
});
test('special replacement preserves manual addon and unknown stock cannot be batch replaced here',()=>{
 const configs=[config('a','p')],report=checkInventory(configs,costs,'intel'),special={sourceId:'sp',shopId:'intel',specialComponent:true,goodsId:'',name:'不含 CPU'};
 const plan=stockReplacementPlan(configs,costs,[special],report,'100',['p'],'sp');assert.equal(plan.changes[0].after.parts[0].erp,0);assert.equal(plan.changes[0].after.addons.length,2);
 assert.throws(()=>stockReplacementPlan(configs,[],[replacement],checkInventory(configs,[],'intel'),'100',['p'],'new'),/低库存或无库存/);
 assert.throws(()=>stockReplacementPlan(configs,costs,[replacement],report,'100',[],'new'),/勾选/);
});


// 同一货号在多个槽位共用一份库存，缺失的待入数据也不能算作现货。
test('整机按合并后的实际用量分别计算最终与待入可销，旧快照保持未知',()=>{
 const configuration={parts:[],actualParts:[
  {goodsId:'1',name:'条A',qty:2},{goodsId:'1',name:'条B',qty:1},
  {goodsId:'2',name:'板',qty:1},{goodsId:'',name:'核显',specialComponent:true,qty:1},
 ]};
 const costs=[{goodsId:'1',stockAvailable:-1,stockIncomingAvailable:8},{goodsId:'2',stockAvailable:5,stockIncomingAvailable:5}];
 assert.deepEqual(configurationStock(configuration,costs),{stockAvailable:0,stockIncomingAvailable:2});
 assert.equal(componentStock('1',costs).value,-1);
 let old=structuredClone(costs);delete old[0].stockIncomingAvailable;
 assert.equal(configurationStock(configuration,old).stockIncomingAvailable,null);
 old[1].stockIncomingAvailable=-1;
 assert.equal(configurationStock(configuration,old).stockIncomingAvailable,0);
});
test('现货已空的配件在选择器和总表提示有货在途',async()=>{
 const {componentStockView}=await import('../../public/workbench/component-stock-view.js');
 const row={goodsId:'21',stockAvailable:0,stockIncomingAvailable:2};
 assert.match(componentStockView(row,[row]).label,/有货在途.*待入可销 2/);
 assert.doesNotMatch(componentStockView(row,[{...row,stockIncomingAvailable:null}]).label,/待入可销|在途/);
});

test('ERP 大类优先于部位，历史行回退部位、名称及其他配件',()=>{
 const c=config('a','p');
 c.parts=[
  {slot:'CPU',sourceId:'one',goodsId:'1',name:'型号一'},
  {slot:'CPU',sourceId:'two',goodsId:'2',name:'型号二'},
  {slot:'散热风扇',goodsId:'3',name:'型号三'},
  {slot:'配件1',goodsId:'4',name:'NVMe SSD'},
  {slot:'配件2',goodsId:'5',name:'未分类型号'}
 ];
 const costs=[{goodsId:'1',erpCategory:'固态硬盘',stockAvailable:0},{goodsId:'2',stockAvailable:2}];
 const sources=['one','two'].map((sourceId,index)=>({sourceId,goodsId:String(index+1),shopId:'intel',erpCategory:'显卡'}));
 const report=checkInventory([c,{...c,id:'b'}],costs,'intel',5,sources);
 assert.deepEqual(report.issues.map(i=>i.category),['硬盘','显卡','风扇','硬盘','其他配件']);
 assert.deepEqual(inventoryCounts(report.issues),{out:1,low:1,unknown:3});
});

test('库存替换任务只在展示部位写入手工名，实际 BOM 与默认替换一致',()=>{
 const c=config('a','p'),report=checkInventory([c],costs,'intel');
 const task={issueKey:'100',productIds:['p'],sourceId:'new',displayName:'  海报名称  '};
 const plan=stockReplacementTasksPlan([c],costs,[replacement],report,[task]);
 validateStockReplacement(plan,[c],costs,[replacement]);
 const after=plan.changes[0].after,expected=structuredClone(c);
 replaceBothParts(expected,'CPU',replacement);
 const defaultPlan=stockReplacementTasksPlan([c],costs,[replacement],report,[{...task,displayName:''}]);
 assert.deepEqual(after.actualParts,defaultPlan.changes[0].after.actualParts);
 assert.equal(after.parts[0].displayName,'海报名称');
 assert.equal(after.parts[0].sourceFollow.name.mode,'manual');
 assert.equal(after.parts[0].name,replacement.name);
 assert.match(replacementDiff(plan),/海报名称（实际：新 CPU）/);
 for(const displayName of [null,'  ',replacement.name]){
  const result=structuredClone(c);replaceBothParts(result,'CPU',replacement,null,{displayName});
  assert.deepEqual(result,expected);
 }
});
