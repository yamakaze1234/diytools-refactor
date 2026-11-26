import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceSheetCategories,sourceSheetCategory,buildSourceSheet,sourceSheetView,sourceSheetMatches,editSourceSheetField,
 createSourceSheetDraft,sourceSheetChanges,sourceSheetEffective,sheetTaxInput,sourceSheetRestorePlan,
 promoteSourceSheetField,sourceSheetNavCounts,sheetAddonItems,sourceSheetTaxCompare} from '../../public/workbench/source-sheet-model.js';

const shops=['intel','gigabyte','jonsbo'];
const alias=(sourceId,fields={},legacy=[])=>({sourceId,fields,legacy});
const source=(sourceId,shopId,name)=>({sourceId,shopId,name,goodsId:'501',tax:100});
const entry={id:'501',version:'25',common:{name:'共用 DDR5 16GB',tax:100,addon:{addonText:'升级硬盘',addonGoodsId:'502'}},
 stores:{intel:[alias('i',{name:'英特尔原名'})],gigabyte:[alias('g',{tax:102})],
  jonsbo:[alias('j1',{name:'乔思伯甲'},['name']),alias('j2',{name:'乔思伯乙'},['name'])]}};
const costs=[{goodsId:'501',name:'DDR5 内存（16GB）',erp:88,stockAvailable:9},{goodsId:'502',name:'停产 NVMe 1TB',erp:350,stockAvailable:10}];
const rows=[source('i','intel','英特尔原名'),source('g','gigabyte','共用 DDR5 16GB'),source('j1','jonsbo','乔思伯甲'),source('j2','jonsbo','乔思伯乙')];
const model=()=>buildSourceSheet({rows,entries:[entry],costs,shops,configs:[{
 id:'config',shopId:'intel',parts:[{sourceId:'i',goodsId:'501',slot:'内存'}],
 actualParts:[{sourceId:'i',goodsId:'501',slot:'内存'}],
}]})[0];

test('全部分类按 ERP 分类、引用槽位与名称推断，普通未知配件和特殊配件分开',()=>{
 const cases=[
  [{name:'Intel i5-14600KF'},'CPU'],[{name:'B760M 主板'},'主板'],[{name:'RTX 5070'},'显卡'],
  [{erpCategory:'存储',name:'DDR 5'},'硬盘'],[{name:'DDR5'},'内存'],[{name:'一体式水冷'},'散热'],
  [{name:'ARGB 风扇'},'风扇'],[{name:'乔思伯机箱'},'机箱'],[{name:'850W'},'电源'],
  [{name:'转接线'},'线材/扩展'],[{name:'标签卡'},'其他配件'],[{name:'没有独显',specialComponent:true},'特殊配件'],
 ];
 assert.equal(sourceSheetCategories.length,cases.length+1);
 for(const [row,expected] of cases)assert.equal(sourceSheetCategory(row),expected);
 assert.equal(sourceSheetCategory({name:'RTX 5070'},['配件1','主板']),'主板');
 for(const name of ['定制包网模组线(CPU+主板+显卡)','显卡延长线','CPU 转接线','显卡支架'])
  assert.equal(sourceSheetCategory({name}),'线材/扩展');
 assert.equal(sourceSheetCategory({name:'CPU 风冷散热器'}),'散热');
});

test('共用投影保留历史值，结合规格、跨店名称和升级目标筛选',()=>{
 const row=sourceSheetView(model());
 assert.equal(row.common.name,'共用 DDR5 16GB');
 assert.equal(row.references,1);
 assert.deepEqual(row.differences.map(diff=>[diff.scope,diff.fields]),[['intel',['name']],['gigabyte',['tax']],['jonsbo',['name']]]);
 for(const args of [{query:'乔思伯乙'},{query:'502 16gb'},{query:'NVMe 1TB'},{filter:'addons'},{filter:'different'},{filter:'unavailable'}])
  assert.equal(sourceSheetMatches(row,args),true);
 assert.equal(sourceSheetMatches(row,{category:'显卡'}),false);
 assert.equal(sourceSheetMatches(row,{filter:'missing-tax'}),false);
 assert.equal(sourceSheetMatches(row,{filter:'pending'}),false);
});

test('升级行情读取目标货号，区分缺货、未知和核算价回退',()=>{
 const index=Map.groupBy([
  {goodsId:'502',erpName:'停产 NVMe 1TB（零售）',name:'店铺别名',erp:314.25,stockAvailable:0,stockIncomingAvailable:8},
  {goodsId:'503',name:'仅有核算价',tax:18},
 ],row=>row.goodsId);
 const choices=['502','503','504',''].map(goodsId=>({goodsId,label:'文案',enabled:false}));
 const [part,fallback,missing,note]=sheetAddonItems({addonChoices:choices},index);
 assert.equal(part.targetRawName,'停产 NVMe 1TB（零售）');
 assert.equal(part.targetName,'NVMe 1TB');
 assert.equal(part.targetErp,31425);
 assert.deepEqual([part.targetStock.value,part.targetStock.incoming,part.targetStock.status],[0,8,'out']);
 assert.deepEqual(part.targetTags,['停产']);
 assert.equal(part.unavailable,true);
 assert.equal(part.enabled,false);
 assert.equal(fallback.targetErp,null);
 assert.deepEqual([missing.targetName,missing.targetErp,missing.targetStock.value,missing.unavailable],['',null,null,false]);
 assert.deepEqual(note,{goodsId:'',text:'文案',enabled:false,unavailable:false});
 // 旧版单货号加购仍使用同一份行情。
 const [legacy]=sheetAddonItems({addonGoodsId:'502',addonText:'升级硬盘'},index);
 assert.equal(legacy.targetErp,part.targetErp);
 assert.deepEqual(legacy.targetStock,part.targetStock);
});

test('共用改价与单店恢复共用生成同一版本约束事务',()=>{
 const item=model();
 let draft=editSourceSheetField(item,undefined,'shared','tax',112.5);
 draft=editSourceSheetField(item,draft,'intel','name',null,{restore:true});
 draft=editSourceSheetField(item,draft,'jonsbo','name','乔思伯指定展示名');
 const view=sourceSheetView(item,draft),[change]=sourceSheetChanges(item,draft);
 assert.equal(view.scopeRows.get('intel').name,view.common.name);
 assert.equal(view.scopeRows.get('gigabyte').tax,102);
 assert.equal(view.scopeRows.get('jonsbo').name,'乔思伯指定展示名');
 assert.equal(change.managed.version,'25');
 assert.deepEqual(change.managed.edits.intel.restore,['name']);
 assert.equal(change.managed.edits.gigabyte,undefined);
 assert.deepEqual(change.managed.edits.jonsbo.values,{name:'乔思伯指定展示名'});
 assert.equal(sourceSheetMatches(view,{filter:'pending'}),true);
 assert.equal(sheetTaxInput(''),null);
 assert.equal(sheetTaxInput('0'),0);
 assert.throws(()=>sheetTaxInput('-2'),/非负/);
});

test('空共用值保护独享价与名称，草稿中的共用值和显式自动识别可用于恢复',()=>{
 const item=model();
 item.entry={...item.entry,common:{tax:null,'hardwareOverrides.color':null},stores:{
  intel:[alias('i',{tax:1390,name:'英特尔名称','hardwareOverrides.color':'白','capacityOverrides.memoryGb':32})],
  jonsbo:[alias('j1',{tax:1400,name:'乔思伯名称'})],
 }};
 const before=sourceSheetView(item);
 assert.deepEqual(sourceSheetRestorePlan(before),{
  targets:[{scope:'intel',field:'hardwareOverrides.color'}],
  blocked:['name','tax','capacityOverrides.memoryGb'],
 });
 assert.equal(editSourceSheetField(item,undefined,'intel','tax',null,{restore:true}),undefined);
 assert.equal(editSourceSheetField(item,undefined,'intel','name',null,{restore:true}),undefined);
 const named=editSourceSheetField(item,undefined,'shared','name','共用名称');
 const restored=editSourceSheetField(item,named,'intel','name',null,{restore:true});
 assert.equal(sourceSheetView(item,restored).scopeRows.get('intel').name,'共用名称');
 const repriced=editSourceSheetField(item,restored,'shared','tax',0);
 const priced=sourceSheetView(item,repriced);
 assert.equal(priced.common.tax,0);
 assert.equal(priced.scopeRows.get('intel').tax,1390);
 assert.equal(priced.scopeRows.get('jonsbo').tax,1400);
 assert.equal(sourceSheetRestorePlan(priced).targets.filter(target=>target.field==='tax').length,2);
 assert.equal(sourceSheetView(item,editSourceSheetField(item,repriced,'shared','tax',null)).scopeRows.get('intel').tax,1390);
 const mergedName=promoteSourceSheetField(item,undefined,'name','乔思伯名称');
 assert.equal(sourceSheetView(item,mergedName).scopeRows.get('intel').name,'乔思伯名称');
 assert.equal(sourceSheetView(item,mergedName).scopeRows.get('intel').tax,1390);
 const mergedTax=promoteSourceSheetField(item,undefined,'tax',1400);
 assert.equal(sourceSheetView(item,mergedTax).scopeRows.get('intel').tax,1400);
 assert.equal(sourceSheetView(item,mergedTax).scopeRows.get('intel').name,'英特尔名称');
 const details=editSourceSheetField(item,undefined,'intel','hardwareOverrides.color',null,{restore:true});
 assert.deepEqual(sourceSheetChanges(item,details)[0].managed.edits.intel.restore,['hardwareOverrides.color']);
});

test('核算价按分比较，缺价、无 ERP 和特殊配件分别处理',()=>{
 for(const [tax,erp,status,diffCents] of [[100.12,10000,'high',12],[0,101,'low',-101],['2.35',235,'equal',0],
  [null,0,'missing',0],[' ',0,'missing',0],[1,null,'none',0]]){
  assert.deepEqual(sourceSheetTaxCompare(tax,erp),{status,diffCents});
 }
 const {item,draft}=createSourceSheetDraft({},{shop:'intel',special:true});
 assert.deepEqual(sourceSheetView(item,draft).taxCompare,{status:'none',diffCents:0});
});

test('价差分段与分类、快捷筛选和关键词相交，各组计数忽略本组选项',()=>{
 const item=model(),high=sourceSheetView(item),low=sourceSheetView(item,editSourceSheetField(item,undefined,'shared','tax',50));
 const rows=[high,low,{...high,category:'CPU'},{...low,search:'其他'}, {...low,differences:[]}];
 const selection={category:'内存',query:'501',filter:'different',priceFilter:'low'};
 assert.deepEqual(rows.filter(row=>sourceSheetMatches(row,selection)),[low]);
 assert.equal(sourceSheetMatches(low,{...selection,filter:'tax-high'}),false);
 assert.equal(sourceSheetMatches(high,{filter:'tax-high'}),true);
 assert.equal(sourceSheetMatches(low,{filter:'tax-low'}),true);
 const counts=sourceSheetNavCounts(rows,selection);
 assert.deepEqual(Object.fromEntries(counts.priceFilters),{all:2,high:1,low:1});
 assert.deepEqual([counts.categories.get('内存'),counts.categories.get('CPU'),counts.filters.get('active'),counts.filters.get('tax-high')],[1,0,2,0]);
});

test('快捷筛选分别统计当前分类和关键词，草稿投影改变差异、缺价与待保存数量',()=>{
 const item=model();
 item.entry={...item.entry,common:{},stores:{gigabyte:[alias('g',{tax:12})]}};
 const draft=editSourceSheetField(item,undefined,'shared','tax',15);
 const view=sourceSheetView(item),saved=sourceSheetView(item,draft);
 const archived={...view,base:{...view.base,deletedAt:'2026-01-01'}},other={...view,category:'CPU'};
 const count=row=>Object.fromEntries(sourceSheetNavCounts([row,archived,other],{category:'内存',query:'501',filter:'different'}).filters);
 assert.deepEqual(count(view),{active:1,different:1,addons:0,unavailable:0,'missing-tax':1,'tax-high':0,'tax-low':0,pending:0,deleted:1});
 assert.deepEqual(count(saved),{active:1,different:1,addons:0,unavailable:0,'missing-tax':0,'tax-high':0,'tax-low':1,pending:1,deleted:1});
});

test('ERP 新增在草稿中使用清洗名称、参考价和观察值，跨店创建保持原请求契约',()=>{
 const item={goodsId:'503',name:'缺货 合成 NVMe SSD（2TB）',stockAvailable:0,stockIncomingAvailable:8,erp:23};
 const {item:created,draft}=createSourceSheetDraft(item,{shop:'intel',shops,managed:true,tax:90.099999,sourceId:'draft'});
 assert.equal(created.base.name,'合成 NVMe SSD');
 assert.equal(created.base.tax,90.1);
 assert.equal(created.base.stockIncomingAvailable,8);
 assert.equal(created.category,'硬盘');
 assert.equal(sourceSheetView(created,draft).unavailable,true);
 const [change]=sourceSheetChanges(created,draft);
 assert.equal(change.before,null);
 assert.equal(change.managed.version,null);
 assert.deepEqual(change.managed.edits.shared.values,{name:'合成 NVMe SSD',tax:90.1});
 assert.equal(change.managed.erpName,item.name);
 assert.throws(()=>createSourceSheetDraft({...item,name:'排除品 ＊！'},{shop:'intel'}),/不可加入/);
});

test('本机与单店只修改已经授权的来源，未改别名、停用状态和成本不被重写',()=>{
 const [item]=buildSourceSheet({rows:[...rows,{...source('deleted','intel','停用'),deletedAt:'2026-01-01'}],shops});
 const draft=editSourceSheetField(item,undefined,'shared','name','本机共用新名');
 assert.deepEqual(sourceSheetChanges(item,draft).map(c=>[c.row.sourceId,c.row.name]),[['i','本机共用新名']]);
 assert.equal(sourceSheetEffective(item,draft,rows[3]).name,'乔思伯乙');
 const single=buildSourceSheet({rows,entries:[entry],shops:['intel']})[0];
 const changed=editSourceSheetField(single,undefined,'intel','name','本店新名称');
 assert.deepEqual(Object.keys(sourceSheetChanges(single,changed)[0].managed.edits),['intel']);
 assert.equal(sourceSheetView(single).differences.length,0);
 const archived=buildSourceSheet({rows:[{...rows[0],deletedAt:'2026-01-01'}],shops:['intel']})[0];
 assert.equal(sourceSheetMatches(sourceSheetView(archived),{filter:'deleted'}),true);
 assert.equal(sourceSheetMatches(sourceSheetView(archived)),false);
});
