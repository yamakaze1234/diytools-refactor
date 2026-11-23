import test from 'node:test';
import assert from 'node:assert/strict';
import {addonPackInputs,addonPackRows,addonPackValidationIssue,assessAddonPack,validAddonPack} from '../../public/workbench/link-addon-packs.js';
import {createAddonPackDrafts} from '../../public/workbench/link-addon-drafts.js';
import {removePosterExtra} from '../../public/workbench/config-extras.js';
import {posterAddonEntries} from '../../public/workbench/poster.js';

const first={slot:'风扇',goodsId:'62999',name:'反叶风扇',qty:2,tax:20};
const config={id:'c',productId:'link',product:'示例链接',name:'配置1',spu:'10000000000001',skuId:'10000000000002',
 actualParts:[first,{...first,slot:'配件1',qty:1,taxOverride:{goodsId:'62999',value:15}}]};
const pack={id:'plan',productId:'link',name:'风扇升级',mode:'parts',priceCents:9900,copyMode:'preset',preset:'parts',customCopy:'',presetEdits:{},
 rules:[{kind:'replace',slot:'风扇',originalGoodsId:'62999',sourceId:'new',targetGoodsId:'375667',qtyMode:'fixed',qty:1}]};
const inputs=addonPackInputs([{sourceId:'new',goodsId:'375667',name:'连体风扇',tax:80,erp:77}],
 [{goodsId:'62999',tax:20,erp:18}]);

test('加购草稿和编辑基线随重开保留，按 NAS、账号与店铺隔离',()=>{
 const items=new Map(),storage={get length(){return items.size;},key:index=>[...items.keys()][index],
  getItem:key=>items.get(key),setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
 const scope=(shop,member='owner',nas='production')=>JSON.stringify([nas,member,shop]);
 const open=()=>createAddonPackDrafts(storage,scope('intel'));
 const draft={pack:{...pack,name:'留在本机的草稿'},base:pack};
 open().set(pack.id,draft);
 assert.deepEqual(open().get(pack.id),draft);
 for(const other of [scope('gigabyte'),scope('intel','another'),scope('intel','acceptance')])
  assert.equal(createAddonPackDrafts(storage,other).size,0);
 open().delete(pack.id);
 assert.equal(open().size,0);
});

test('链接加购按实际商品汇总数量和逐行成本，不修改原配置',()=>{
 const before=structuredClone(config);
 assert(validAddonPack(pack));
 const result=assessAddonPack(config,pack,inputs);
 assert.equal(result.lines[0].originalQty,3);
 assert.deepEqual(result.lines[0].oldCosts.map(row=>row.taxSubtotal),[4000,1500]);
 assert.equal(result.lines[0].newCost.erpSubtotal,7700);
 assert.equal(result.tax,2500);
 assert.equal(result.erp,2300);
 assert.equal(result.profit,7400);
 assert.deepEqual(config,before);
});

test('自动匹配隔离链接，数量可跟随，缺成本时方案仍可保存',()=>{
 assert(assessAddonPack({...config,productId:'other'},pack,inputs).issue);
 assert(assessAddonPack({...config,actualParts:[],parts:config.actualParts},pack,inputs).issue);
 const match={...pack,rules:[{...pack.rules[0],qtyMode:'match'}]};
 const missing=addonPackInputs([{sourceId:'new',goodsId:'375667',name:'连体风扇'}],[]);
 const result=assessAddonPack(config,match,missing);
 assert.equal(result.lines[0].qty,3);
 assert.equal(result.profit,null);
 assert(validAddonPack(match));
 assert(!validAddonPack({...pack,rules:[pack.rules[0],pack.rules[0]]}));
});

test('自定义文案原样出图，未定价或缺文案的草稿给出明确保存提示',()=>{
 const custom={...pack,copyMode:'custom',customCopy:'只显示这条文案'};
 assert.equal(addonPackRows(config,[custom],inputs)[0].text,'只显示这条文案');
 const staged={...custom,priceCents:null};
 assert.match(addonPackValidationIssue(staged),/客户补差/);
 assert(!validAddonPack(staged));
 assert.match(addonPackValidationIssue({...custom,customCopy:' '}),/配置图文案/);
 assert.match(addonPackValidationIssue({...pack,name:''}),/方案名称/);
 assert.match(addonPackValidationIssue({...pack,rules:[]}),/至少添加一项/);
 assert.match(addonPackValidationIssue({...pack,rules:[{...pack.rules[0],sourceId:''}]}),/请选择第 1 项的加购配件/);
 assert.match(addonPackValidationIssue({...pack,rules:[{...pack.rules[0],qty:0}]}),/固定数量/);
});

test('旧文案与新加购包同文时只绘一份，删旧行不移动或清除新方案文案',()=>{
 const model={modules:[{id:'addon',type:'addons',visible:true}],
  addons:[{text:'旧标题',note:'水冷和风扇'},{text:'另一个加购选项'}],
  posterAddonPacks:[
   {id:'text-only',mode:'text',text:'【颜值升级包】+499元\n水冷和风扇'},
   {id:'bundle',mode:'parts',text:'【颜值升级包】 ＋499元 水冷和风扇'}
  ],
  textStyles:{'addon.0.text':{text:'【颜值升级包】 +499元'},'addon.pack:bundle.text':{color:'#123456'}},
  textTransforms:{long:{'addon.0.text':{x:8},'addon.pack:bundle.text':{x:30}}}};
 const before=structuredClone(model);
 const view=()=>posterAddonEntries(model,'addon').map(row=>[row.index,row.entry.text]);
 assert.deepEqual(view(),[[1,'另一个加购选项'],['pack:bundle',model.posterAddonPacks[1].text]]);
 assert.deepEqual(model,before);
 removePosterExtra(model,'addons',0);
 model.posterAddonPacks.shift();
 assert.deepEqual(view(),[[0,'另一个加购选项'],['pack:bundle',before.posterAddonPacks[1].text]]);
 assert.deepEqual(model.textStyles,{'addon.pack:bundle.text':{color:'#123456'}});
 assert.deepEqual(model.textTransforms.long,{'addon.pack:bundle.text':{x:30}});
});

test('底部加购仅使用页签独立文案与链接加购包，保留原文案的样式索引和配件数据',()=>{
 const model={addons:[
  {text:'共用来源加购',sourceId:'cpu-source',priceCents:9900},
  {text:'配件结构化选配',choices:[]},
  '手写旧文案',
 ],textStyles:{'addon.0.text':{text:'旧版来源文案覆盖'}}};
 const before=structuredClone(model);
 assert.deepEqual(posterAddonEntries(model,'addon'),[{index:2,entry:{text:'手写旧文案',note:''}}]);
 assert.deepEqual(model,before);
 model.addons.pop();
 assert.deepEqual(posterAddonEntries(model,'addon'),[]);
 model.posterAddonPacks=[{id:'pack',mode:'text',text:'页签链接文案'}];
 assert.deepEqual(posterAddonEntries(model,'addon').map(({entry})=>entry.text),['页签链接文案']);
});
