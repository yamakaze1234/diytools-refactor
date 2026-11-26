import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createContinuousWorkbench} from '../../public/workbench/continuous-workbench.js';
import {sourcesFor} from '../../public/workbench/shops.js';
import {sourceCatalog} from '../../public/workbench/source.js';
import {visibleNasCosts} from '../../public/workbench/nas-cost-overlay.js';

const goodsId='212618',erp=560.33864542;
const part={sourceId:'ssd',goodsId,slot:'硬盘',name:'测试硬盘',erp:520,tax:560,qty:1};

test('总表候选、点选及两种粘贴使用目标店有效价；展示和利润跟随目录换版',t=>{
 const config={id:'c',shopId:'jonsbo',productId:'p',price:1000,installment:0,parts:[{...part}],actualParts:[{...part}],addons:[]};
 const state={sourceCatalog:[{...part,shopId:config.shopId},{...part,shopId:'intel',name:'其他店'},
  {...part,shopId:config.shopId,sourceId:'removed',deletedAt:'today'},
  {...part,shopId:config.shopId,sourceId:'excluded',name:'*!停用配件'}],
  costSource:[{goodsId,erp,tax:560,stockAvailable:501,erpCategory:'固态硬盘'}]};
 // 使用生产装配的回调，避免测试自己接好正确目录而遗漏 app.js 的回归。
 const app=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const callback=app.split('createContinuousWorkbench({').at(-1).match(/^ catalog:(.*),$/m)[1];
 const catalog=runInNewContext('('+callback+')',{state,activeShopId:'intel',sourcesFor,sourceCatalog,currentCatalog:()=>sourcesFor(state,'intel')});
 const dom={body:{},addEventListener(){},querySelector:()=>({after(){}}),createElement:()=>({ownerDocument:dom})};
 t.after(()=>{delete globalThis.document;});
 globalThis.document=dom;
 let model;
 const workbench=createContinuousWorkbench({
  current:()=>config,configs:()=>[config],available:()=>[config],selected:()=>new Set(),
  catalog,costs:()=>state.costSource,catalogVersion:()=>JSON.stringify(state),settings:()=>({}),
  canUndo:()=>false,canRedo:()=>false,renderCard:(_,value)=>{model=value;},
  update:(_,edit)=>edit(config),toast(){}
 });
 const show=()=>{workbench.renderCard(null,config.id);return model.configs[0];};
 const before=structuredClone(config);
 const view=show(),disk=view.rows.find(row=>row.slot==='硬盘');
 assert.equal(disk.actual.erp,erp);
 assert.equal(disk.part.erp,erp);
 assert.equal(view.raw.erp,560.34);
 assert.equal(view.totals.erpProfit,419.66);
 assert.deepEqual(config,before);
 const candidate=model.catalog.find(row=>row.sourceId==='ssd');
 assert.equal(candidate.shopId,'jonsbo');
 assert.equal(candidate.erp,erp);
 assert.equal(candidate.tax,560);
 assert.equal(candidate.stock.value,501);
 assert.equal(candidate.erpCategory,'固态硬盘');
 assert.equal(model.catalog.some(row=>['removed','excluded'].includes(row.sourceId)),false);
 assert.ok(model.catalog.some(row=>row.specialComponent&&row.erp===0));
 for(const slot of ['内存','显卡','电源']){
  const index=view.rows.find(row=>row.slot===slot).index;
  if(slot==='内存')assert.equal(model.pick('c',slot,true,'ssd'),true);
  if(slot==='显卡')model.pasteActual('c',index,0,goodsId);
  if(slot==='电源')assert.equal(model.paste('c',index,model.copy('c',[disk.index])),true);
  const actual=config.actualParts.find(row=>row.slot===slot);
  assert.equal(actual.erp,erp);assert.equal(actual.stockAvailable,501);
 }
 const previous=show();
 state.costSource[0].erp=600;
 const next=show();
 assert.equal(next.rows.find(row=>row.slot==='硬盘').actual.erp,600);
 assert.equal(previous.raw.erp,2241.36);assert.equal(next.raw.erp,2400);
 assert.equal(next.totals.erpProfit,-1420);
 assert.equal(model.priceForProfit('c','erp',50),2500);
 // 旧特殊项即使误带普通货号和金额，行价和利润也仍按零计算。
 const special={...part,slot:'显卡',specialComponent:true};
 config.parts=[{...special}];config.actualParts=[{...special}];
 const free=show();
 assert.equal(free.rows.find(row=>row.slot==='显卡').actual.erp,0);
 assert.equal(free.raw.erp,0);assert.equal(free.totals.erpProfit,980);
 assert.equal(config.actualParts[0].erp,520);
});

test('旧目录数值、同步空值、明确零、空货号和特殊配件分别处理',()=>{
 const overlay=(row,overrides={})=>{
  const actual={...part,...overrides};
  visibleNasCosts({actualParts:[actual]},new Map([[actual.goodsId,row]]));
  return actual;
 };
 assert.equal(overlay({erp}).erp,erp);
 assert.equal(overlay({erp:0}).erp,0);
 assert.equal(overlay({erp:null}).erp,520);
 assert.equal(overlay({erp:null,nasErpOverride:true}).erp,null);
 assert.equal(overlay({erp:null,nasErpOverride:true}).erpUnknown,true);
 assert.equal(overlay({erp,erpMissing:true}).erpMissing,true);
 assert.equal(overlay({erp},{goodsId:''}).erp,520);
 assert.equal(overlay({erp},{specialComponent:true,erp:0}).erp,0);
});
