import test from 'node:test';
import assert from 'node:assert/strict';
import {priceInventoryBadge} from '../../public/workbench/price-profit-ui.js';
import {stockTaskEditor} from '../../public/workbench/inventory-check-tasks.js';
import {checkInventory,stockReplacementTasksPlan} from '../../public/workbench/inventory-check-data.js';
import {effectiveNasAddons} from '../../public/workbench/addon-data.js';
import {replacementTasksPlan} from '../../public/workbench/global-batch.js';

const config=(id,parts)=>({id,shopId:'intel',productId:'link',product:'样例链接',name:id,parts,actualParts:structuredClone(parts),addons:[]});
const part=(slot,id)=>({slot,sourceId:'old-'+id,goodsId:id,name:'型号 '+id,qty:2});
const stock=(goodsId,stockAvailable)=>({goodsId,stockAvailable});
const source=(id,goodsId,fields={})=>({sourceId:id,shopId:'intel',goodsId,name:'样例 '+id,...fields});

test('价格页未知数量与巡检按货号去重，全部已确认有货才显示正常',()=>{
 const configs=[config('配置一',[part('CPU','1'),part('硬盘','2')]),config('配置二',[part('CPU','1')])];
 assert.deepEqual(priceInventoryBadge(configs,[],'intel',5),{status:'unknown',text:'库存未知 2'});
 assert.deepEqual(priceInventoryBadge(configs,[stock('1',15),stock('2',20)],'intel',5),{status:'ok',text:'正常'});
});

test('默认同类现货候选识别 ERP 原名、型号和本店实际部位，不借用异店或冲突部位',()=>{
 const catalog=[source('erp','11',{erpName:'产品 (D4/3200)'}),source('model','12',{erpModel:'DDR5 6000'}),
  source('slot','13'),source('foreign','14'),source('conflict','15'),source('out','16',{erpName:'DDR4 3200'})];
 const configs=[config('本店',[part('内存','13'),part('CPU','15')]),config('也在用',[part('内存','15')]),
  {...config('异店',[part('内存','14')]),shopId:'jonsbo'}];
 const nodes=new Map(),$=selector=>{
  if(!nodes.has(selector))nodes.set(selector,{});
  return nodes.get(selector);
 };
 const editor=stockTaskEditor({$,esc:String,getCatalog:()=>catalog,getCosts:()=>catalog.map(r=>stock(r.goodsId,r.sourceId==='out'?0:35)),
  getConfigs:()=>configs,shop:{id:'intel'},invalidate(){},drawReport(){}});
 editor.reset(5);
 editor.open({key:'1',goodsId:'1',category:'内存',name:'原内存',status:'out',value:0,sources:[]});
 assert.deepEqual([...$('#stock-picker').innerHTML.matchAll(/data-product-id="([^"]+)"/g)].map(match=>match[1]),['erp','model','slot']);
 assert.equal(editor.active.sourceId,'erp');
});

// 两个旧来源分别绑定商品，同时保留一个独立服务；销售展开只读取提交的加购数组。
const shared=(id,goodsId,addonGoodsId,price)=>source(id,goodsId,{sharedSourceId:goodsId,
 addonText:'加购 '+goodsId,addonGoodsId,addonPriceCents:price,addonQty:1});
const first=shared('new-A','21','201',6600),second=shared('new-B','22','202',8800);
const manual={text:'装机服务',goodsId:'99',qty:1,priceCents:500};
const oldAddon=id=>({sourceId:'old-'+id,text:'原加购 '+id,goodsId:'1'+id,priceCents:1000,qty:1});

test('库存双侧替换同时更新销售加购，独立服务和仍在别的展示槽位使用的来源继续保留',()=>{
 const c=config('配件',[part('CPU','1'),{...part('配件1','9'),sourceId:'old-1'}]);
 c.addons=[manual,oldAddon('1')];
 // 巡检只替换货号 1，对相同旧来源的另一个展示槽位保留其加购组。
 const configs=[c],costs=[stock('1',0),stock('9',10),stock('21',40)],catalog=[first];
 const task={issueKey:'1',productIds:['link'],sourceId:'new-A',displayName:'海报名'};
 const plan=stockReplacementTasksPlan(configs,costs,catalog,checkInventory(configs,costs,'intel'),[task]);
 const after=plan.changes[0].after;
 assert.deepEqual(after.addons.slice(0,2),[manual,oldAddon('1')]);
 assert.deepEqual(after.addons.map(a=>a.sourceId),[undefined,'old-1','new-A']);
 assert.equal(after.parts[0].displayName,'海报名');
 assert.equal(after.actualParts[0].displayName,undefined);
 assert.equal(after.actualParts[0].goodsId,'21');
 assert.deepEqual(c.addons,[manual,oldAddon('1')]);
});

test('库存与全局的多任务替换分别保存新来源加购，换件前的组不会混入销售报价',()=>{
 const c=config('双任务',[part('CPU','1'),part('内存','2')]),configs=[c];
 c.addons=[oldAddon('1'),manual,oldAddon('2')];
 const costs=[stock('1',0),stock('2',2),stock('21',40),stock('22',60)],catalog=[first,second];
 const tasks=c.parts.map((p,i)=>({issueKey:p.goodsId,productIds:['link'],sourceId:catalog[i].sourceId}));
 const stockPlan=stockReplacementTasksPlan(configs,costs,catalog,checkInventory(configs,costs,'intel'),tasks);
 const globalPlan=replacementTasksPlan(configs,c.parts.map((p,i)=>({partKey:'id:'+p.goodsId,productIds:['link'],replacement:catalog[i],qty:null})));
 for(const plan of [stockPlan,globalPlan]){
  const after=plan.changes[0].after;
  assert.deepEqual(after.parts.map(p=>p.sourceId),['new-A','new-B']);
  assert.deepEqual(after.actualParts.map(p=>p.sourceId),['new-A','new-B']);
  assert.deepEqual(after.addons.map(a=>a.sourceId),[undefined,'new-A','new-B']);
  assert.deepEqual(after.addons[0],manual);
  const sale=effectiveNasAddons(after.addons,new Map(catalog.map(r=>[r.sourceId,r])));
  assert.deepEqual(sale.map(({addon})=>[addon.goodsId,addon.priceCents]),[['99',500],['201',6600],['202',8800]]);
 }
 assert.deepEqual(c.addons,[oldAddon('1'),manual,oldAddon('2')]);
});

test('换入本地普通或特殊配件后，移除已失去引用的跟随组，保留独立服务和人工加购',()=>{
 const c=config('退回本地',[part('内存','1'),part('配件1','2')]);
 const local=source('local','31'),special=source('special','',{specialComponent:true});
 const chosen={...oldAddon('2'),followPolicy:'snapshot'};
 c.addons=[{...oldAddon('1'),followPolicy:'follow',followAll:true},manual,{...oldAddon('2'),followPolicy:'follow',followAll:true},chosen];
 const costs=[stock('1',0),stock('2',0),stock('31',10)],catalog=[local,special];
 const tasks=c.parts.map((p,i)=>({issueKey:p.goodsId,productIds:['link'],sourceId:catalog[i].sourceId}));
 const plan=stockReplacementTasksPlan([c],costs,catalog,checkInventory([c],costs,'intel'),tasks);
 assert.deepEqual(plan.changes[0].after.addons,[manual,chosen]);
 for(const [i,task] of tasks.entries()){
  const one=stockReplacementTasksPlan([c],costs,catalog,checkInventory([c],costs,'intel'),[task]).changes[0].after;
  assert.equal(one.addons.some(a=>a.followPolicy==='follow'&&a.sourceId===c.parts[i].sourceId),false);
  assert.ok(one.addons.some(a=>a.followPolicy==='follow'&&a.sourceId===c.parts[1-i].sourceId));
 }
});
