// 完整加购同步覆盖真实计价字段、来源身份、默认选择与后续跟随，全部使用合成商品。
import test from 'node:test';
import assert from 'node:assert/strict';
import {upgradeAddonDefinition,applyStructuredUpgrade,structuredUpgradeSourceDocument} from '../../public/workbench/upgrade-addon-sync.js';
import {effectiveNasAddons,addonCheck,detachAddonFollow,addonBatchPlan,addonKey} from '../../public/workbench/addon-data.js';
import {withCurrentSharedSource} from '../../public/workbench/shared-source-fields.js';
import {replaceSourcePart} from '../../public/workbench/source.js';
const row={sourceId:'s',sharedSourceId:'1',goodsId:'1',name:'原内存',addonText:'【+199元升级内存】',addonGoodsId:'2',addonQty:2,addonOriginalQty:1,addonPriceCents:19900};
const config=()=>({id:'c',shopId:'intel',productId:'p',name:'配置1',price:1999,parts:[{lineId:'p',slot:'内存',sourceId:'s',goodsId:'1',name:row.name,qty:1,upgrade:row.addonText}],
 actualParts:[{lineId:'a',slot:'内存',sourceId:'s',goodsId:'1',name:row.name,qty:1,tax:100,erp:100}],
 addons:[{sourceId:'s',text:row.addonText,goodsId:'9',qty:1,priceCents:9900,items:[{goodsId:'9',qty:1}]},{text:'独立加购',goodsId:'8',priceCents:800,items:[{goodsId:'8',qty:1}]}]});
test('本链接即使文案相同仍替换真实商品、数量、金额；其它加购、BOM和到手价保留',()=>{
 const before=config(),definition=upgradeAddonDefinition(row),after=applyStructuredUpgrade(before,before.parts[0],definition,{sources:[row]});
 assert.equal(after.addons[0].text,'独立加购');const synced=after.addons.find(a=>a.sourceId==='s');
 assert.deepEqual(synced.items,[{goodsId:'2',qty:2}]);assert.equal(synced.priceCents,19900);assert.equal(synced.originalQty,1);assert.equal(synced.followPolicy,'snapshot');
 assert.deepEqual(after.actualParts,before.actualParts);assert.equal(after.price,before.price);assert.notDeepEqual(after,before);
 assert.equal(before.addons[0].goodsId,'9');
 const check=addonCheck(synced,[{goodsId:'2',tax:120,erp:120}],after.actualParts);assert.equal(check.fields[0].diffCents,5900);
});
test('本链接按来源ID匹配，不顺带改同GoodID的另一来源；全局按GoodID重绑本店来源',()=>{
 const before=config();before.parts.push({...before.parts[0],lineId:'q',sourceId:'another',slot:'配件1'});
 const definition=upgradeAddonDefinition(row),local=applyStructuredUpgrade(before,before.parts[0],definition,{sources:[row]});
 assert.equal(local.addons.filter(a=>a.sourceId==='another').length,0);
 const global=applyStructuredUpgrade(before,before.parts[0],definition,{scope:'all',follow:true,sources:[row,{...row,sourceId:'another'}]});
 for(const id of ['s','another']){const a=global.addons.find(a=>a.sourceId===id);assert.equal(a.followAll,true);assert.equal(a.priceCents,19900);}
 assert.equal(global.parts[0].sourceFollow.upgrade.structured,true);assert.equal(global.parts[0].sourceFollow.upgrade.textOnly,undefined);
});
test('全局只修改共用加购定义并解除各店该字段覆盖，不携带名称和成本修改',()=>{
 const source={document:{id:'1'}},result=structuredUpgradeSourceDocument(source,upgradeAddonDefinition(row));
 assert.equal(result.addon_sync,true);assert.deepEqual(Object.keys(result.edits.shared.values),['addon']);
 for(const shop of ['intel','gigabyte','jonsbo'])assert.deepEqual(result.edits[shop],{values:{},restore:['addon']});
});
test('完整跟随组新增移除方案时按当前来源解析，独立快照保留且不重复报价',()=>{
 const before=config(),updated=applyStructuredUpgrade(before,before.parts[0],upgradeAddonDefinition(row),{scope:'all',follow:true,sources:[row]});
 const next={...row,addonGoodsId:'3',addonQty:3,addonPriceCents:29900,addonVariants:[{variantId:'v',text:'另一个方案',goodsId:'4',qty:2,priceCents:9900,showTogether:true}],addonShowTogether:true};
 const results=effectiveNasAddons(updated.addons,new Map([['s',next]]));
 assert.deepEqual(results.map(r=>r.addon.goodsId),['8','3','4']);assert.equal(results[1].addon.qty,3);assert.equal(results[1].addon.priceCents,29900);
 const empty={...row,addonText:'',addonGoodsId:'',addonChoices:[]};
 assert.equal(effectiveNasAddons(updated.addons,new Map([['s',empty]])).length,1);
 const current=structuredClone(updated);withCurrentSharedSource(current,new Map([['s',empty]]));
 assert.equal(current.addons.length,1);withCurrentSharedSource(current,new Map([['s',next]]));assert.equal(current.addons.length,3);
 assert.equal(effectiveNasAddons(updated.addons,new Map()).find(r=>r.addon.sourceId==='s').available,false);
});
test('选择共用来源的新配置同时有真实加购组，既有不相关方案保持原样',()=>{
 const next=config();next.addons=next.addons.filter(a=>!a.sourceId);replaceSourcePart(next,0,row);
 assert.equal(next.addons.find(a=>a.sourceId==='s').followAll,true);assert.equal(next.addons.find(a=>a.sourceId==='s').priceCents,19900);
 assert.equal(next.parts[0].sourceFollow.upgrade.structured,true);assert.equal(next.addons[0].goodsId,'8');
});
test('多选项价格和数量按来源字段同步，显示文案不被反解析成金额',()=>{
 const source={...row,addonChoices:[{id:'a',enabled:true,goodsId:'2',qty:4,originalQty:2,priceCents:12345,label:'升级内存'}]};
 const definition=upgradeAddonDefinition(source);assert.equal(definition.addonText,'【+123.45元升级内存】');
 const result=applyStructuredUpgrade(config(),config().parts[0],definition,{sources:[source]});
 assert.equal(result.addons.find(a=>a.sourceId==='s').choices[0].priceCents,12345);assert.equal(result.addons.find(a=>a.sourceId==='s').choices[0].qty,4);
 assert.throws(()=>upgradeAddonDefinition({...row,addonPriceCents:null}),/加购价/);
});
test('缺少来源ID时按GoodID匹配并唯一绑定；原实际BOM与数量保留',()=>{
 const before=config();delete before.parts[0].sourceId;
 const result=applyStructuredUpgrade(before,before.parts[0],upgradeAddonDefinition(row),{sources:[row]});
 assert.equal(result.parts[0].sourceId,'s');assert.deepEqual(result.actualParts,before.actualParts);
 assert.equal(result.addons.find(a=>a.sourceId==='s').qty,2);
});
test('多方案保持各自文案，汇总只用于配件展示；移除及快照退出后不重建整组',()=>{
 const source={...row,addonText:'主方案',addonShowTogether:true,addonVariants:[{variantId:'v',text:'第二方案',goodsId:'3',qty:1,priceCents:39900,showTogether:true}]};
 const definition=upgradeAddonDefinition(source);assert.equal(definition.addonText,'主方案');
 const c=applyStructuredUpgrade(config(),config().parts[0],definition,{scope:'all',follow:true,sources:[source]});
 assert.equal(c.parts[0].upgrade,'主方案第二方案');assert.deepEqual(c.addons.filter(a=>a.sourceId==='s').map(a=>a.text),['主方案','第二方案']);
 c.addons=c.addons.filter(a=>a.sourceId!=='s');detachAddonFollow(c,'s');
 withCurrentSharedSource(c,new Map([['s',source]]));assert.equal(c.addons.filter(a=>a.sourceId==='s').length,0);assert.equal(c.parts[0].upgrade,'');
 const d=applyStructuredUpgrade(config(),config().parts[0],definition,{scope:'all',follow:true,sources:[source]});
 const first=d.addons.find(a=>a.sourceId==='s');first.followPolicy='snapshot';delete first.followAll;detachAddonFollow(d,'s');
 withCurrentSharedSource(d,new Map([['s',{...source,addonPriceCents:99900}]]));assert.equal(d.addons.find(a=>a.sourceId==='s').priceCents,19900);
 assert.ok(d.addons.filter(a=>a.sourceId==='s').every(a=>!a.followAll));
});
test('批量表单不改内容时保留整组跟随，实际改文案后才变为本机快照',()=>{
 const source={...row,addonText:'主方案',addonShowTogether:true,addonVariants:[{variantId:'v',text:'第二方案',goodsId:'3',qty:1,priceCents:39900,showTogether:true}]};
 const c=applyStructuredUpgrade(config(),config().parts[0],upgradeAddonDefinition(source),{scope:'all',follow:true,sources:[source]});
 const variant=c.addons.find(a=>a.variantId==='v'),costs=[{goodsId:'2',tax:120},{goodsId:'3',tax:200}];
 assert.equal(addonBatchPlan([c],addonKey(variant),{...variant,note:''},{costs}).changes.length,0);
 const plan=addonBatchPlan([c],addonKey(variant),{...variant,text:'本链接手工方案',note:''},{costs});
 assert.equal(plan.changes.length,1);assert.ok(plan.changes[0].after.addons.filter(a=>a.sourceId==='s').every(a=>a.followPolicy==='snapshot'&&!a.followAll));
});
