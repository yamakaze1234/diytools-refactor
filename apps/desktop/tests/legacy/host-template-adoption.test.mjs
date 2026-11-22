/** 使用合成配置验证型号匹配、选号单和临时核算价回到正常同步。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {blankConfig} from '../../public/workbench/core.js';
import {erpCatalogIndex,erpDescription,partColor,searchErpParts} from '../../public/workbench/erp-part-description.js';
import {applyTemplateAppearance,editTemplate,gpuSpec,insertTemplateRow,newTemplateDraft,rankedTemplateGpus,
 templateCatalog,templateDirty,templateHistory,templateIssues,templateSelectionText} from '../../public/workbench/host-template-model.js';
import {draftLinkFromTemplate} from '../../public/workbench/template-library.js';
import {planNasErpRows} from '../../public/workbench/nas-cost-overlay.js';
const profile={id:'t',shopId:'intel',name:'测试模板',category:'主机模板',configs:[]};
const config=()=>blankConfig(null,profile);
const appearance=()=>({机箱:{name:'',qty:1},散热:{name:'',qty:1},风扇:{name:'',qty:1},accessories:[],changes:''});

test('ERP 主名保留参数，实物与展示提示按已知差异生成，星号不返回',()=>{
 const row={goodsId:'101',name:'缺货 JONSBO乔思伯 ZE-120W SI 正叶白（ARGB）'};
 const info=erpDescription(row,{name:'乔思伯 ZE-240BR 黑色'},row.name,'风扇');
 assert.equal(info.main,'乔思伯 ZE-120W SI 正叶白');
 assert.equal(info.spec,'ARGB');assert.deepEqual(info.tags,['缺货']);
 assert.equal(info.issues.length,3);
 const index=erpCatalogIndex([row,{goodsId:'102',name:'乔思伯*!'}]);
 assert.deepEqual(searchErpParts(index,'ＡＲＧＢ 白',new Set()).map(x=>x.goodsId),['101']);
 assert.equal(searchErpParts(index,'乔思伯',new Set(['101'])).length,0);
});

test('自动颜色忽略电源认证、瓦数和泛用散热名称，保留显式外观',()=>{
 const power='XPG 魔核 EF650 黑 新版 (白牌/直出/650W/EF650W-BKBCN/GB)';
 assert.equal(partColor(power),'黑');
 const info=erpDescription({goodsId:'103'},{name:'XPG 魔核 EF650 黑'},power,'电源');
 assert.deepEqual(info.issues,[]);
 assert.equal(info.raw,power);
 for(const [name,color] of [
  ['威刚 850W 白金牌 全模组',''],['威刚 850W 白金牌 白色','白'],
  ['威刚 850 W 80PLUS 白 全模组',''],['酷冷至尊 冰神G360 龙影2 PRO GOLD 黑金限定版','黑'],
  ['酷冷至尊 冰神G360',''],['九州风神 玄冰400',''],['冰魔方 360',''],['冰立方 240',''],['冰封 360',''],['寒冰 120',''],
  ['黑白可选',''],['白黑双色',''],['黑 / 白 可选',''],['白/黑 可选',''],['白盒',''],['黑盒',''],['黑神话联名',''],
 ])assert.equal(partColor(name),color,name);
});

test('显式颜色优先匹配主名，其次检查参数，冲突留空并保留风扇后缀识别',()=>{
 for(const [name,color] of [
  ['技嘉 B760M 冰雕','白'],['技嘉 RTX5070 冰猎鹰','白'],['技嘉 RTX5070 冰魔鹰','白'],['技嘉 RTX5070 雪鹰','白'],
  ['技嘉 RTX5070 魔鹰','黑'],['技嘉 RTX5070 魔鹰 白色','白'],['技嘉 冰猎鹰 黑色','黑'],
  ['技嘉 RTX5070 魔鹰（外壳 WHITE）','白'],['技嘉 RTX5070 BLACK（外壳（备选）白色）','黑'],
  ['技嘉 RTX5070 冰雕 白色 黑色',''],['技嘉 RTX5070（WHITE BLACK）',''],['WHITEBOX',''],
  ['乔思伯 ZE-120W','白'],['乔思伯 ZA-140WR','白'],['乔思伯 XA-420BR','黑'],
 ])assert.equal(partColor(name),color,name);
});

test('模板识别技嘉显卡编码和平台不兼容，优先使用有库存的匹配型号',()=>{
 assert.equal(gpuSpec({name:'技嘉 GV-N506TWF2OC-8GD 8G 双风扇'}).model,'5060TI');
 assert.equal(gpuSpec({name:'GV-N506TWF2OC-8GD'}).label,'RTX5060TI 8G 双风扇');
 assert.equal(gpuSpec({name:'华硕 DUAL-RX-7600-O8G'}).maker,'RX');
 assert.equal(gpuSpec({name:'GV-R907GRE'}).label,'RX9070GRE 12G');
 assert.equal(gpuSpec({name:'RTX 5090 D'}).label,'RTX5090D 32G');
 const item=config();
 item.parts.find(p=>p.slot==='CPU').name='AMD 9800X3D';
 item.parts.find(p=>p.slot==='主板').name='B860M DDR5';
 item.parts.find(p=>p.slot==='内存').name='16G DDR4';
 assert.deepEqual(templateIssues(item).map(i=>i.slots),[['CPU','主板'],['主板','内存']]);
 const options=templateCatalog([
  {sourceId:'a',goodsId:'201',name:'技嘉 RTX5060Ti 8G 双风扇 黑色',erp:9,stockAvailable:0},
  {sourceId:'b',goodsId:'202',name:'技嘉 RTX5060Ti 8G 双风扇 白色',erp:10,stockAvailable:4},
  {sourceId:'c',goodsId:'203',name:'RTX5060Ti 16G 三风扇',erp:1,stockAvailable:5},
 ]);
 assert.deepEqual(rankedTemplateGpus(options,gpuSpec(options[0]),'black').map(row=>row.sourceId),['b','a']);
});

test('模板只发送勾选项，撤销可恢复行，草稿不带旧链接平台身份',()=>{
 const first=config(),second=config();
 Object.assign(first,{skuId:'700',spu:'800',productUrl:'https://example.invalid',templatePlatform:'intel'});
 first.parts.find(p=>p.slot==='CPU').name='Intel 14600KF';
 second.parts.find(p=>p.slot==='CPU').name='AMD 9800X3D';
 const draft=newTemplateDraft({...profile,configs:[first,second]});
 editTemplate(draft,data=>insertTemplateRow(data,0,'intel',true));
 assert.equal(templateDirty(draft),true);
 templateHistory(draft);
 assert.equal(templateDirty(draft),false);
 const exterior=appearance();exterior.changes='第一套内存换白';
 const text=templateSelectionText(draft.data,new Set([first.id]),exterior);
 assert.match(text,/14600KF[\s\S]*第一套内存换白/);assert.doesNotMatch(text,/9800X3D/);
 const [added]=draftLinkFromTemplate([first],'intel','新链接');
 assert.equal(added.productDraft,true);assert.equal(added.productCategory,'');assert.equal(added.skuId,'');assert.equal(added.spu,'');
 assert.equal(added.productUrl,'');assert.notEqual(added.productId,profile.id);
 assert.equal(added.templatePlatform,undefined);
});

test('选定 RTX5070 时按当前店来源带上延长线并同步实际与展示槽',()=>{
 const item=config(),sources=[
  {goodsId:'200',sourceId:'gpu',name:'RTX5070 12G',tax:240,erp:220},
  {goodsId:'41283',sourceId:'cable',name:'24+16Pin 延长线',tax:16,erp:15},
 ];
 applyTemplateAppearance(item,sources,appearance(),'gpu');
 assert.equal(item.parts.find(row=>row.slot==='显卡').goodsId,'200');
 assert.equal(item.actualParts.find(row=>row.slot==='配件1').goodsId,'41283');
 assert.throws(()=>applyTemplateAppearance(item,sources,appearance(),'missing'),/货号已变化/);
});

test('临时价与表价相等也要接管，手工价跳过',()=>{
 const previous=new Map([
  ['1',{version:'1',document:{tax:50,nasTaxOverride:true,nasProvisionalTax:true}}],
  ['2',{version:'1',document:{tax:50,nasTaxOverride:true,nasManualTax:true}}],
 ]);
 const plan=planNasErpRows([{goods_id:'1',tax:50},{goods_id:'2',tax:60}],previous,'tax-file','2026-11-22');
 assert.deepEqual(plan.changes.map(row=>row.id),['1']);assert.equal(plan.protectedCount,1);
});

test('人工颜色优先用于主板显卡标签、其他配件差异及模板选卡，清空恢复自动',()=>{
 const gpu={sourceId:'manual',goodsId:'2',name:'RTX 5070 12GB 黑色',templateSlot:'显卡',hardwareOverrides:{color:'白'},stockAvailable:8,erp:3100};
 const other={sourceId:'auto',goodsId:'3',name:'RTX 5070 12GB 白色',templateSlot:'显卡',stockAvailable:8,erp:3200};
 assert.equal(erpDescription(gpu,null,gpu.name,'显卡').color,'白');
 assert.equal(erpDescription(gpu,null,gpu.name,'主板').color,'白');
 assert.equal(erpDescription(gpu,null,gpu.name,'内存').color,'');
 const fan={goodsId:'4',name:'ZE-240B 黑色',hardwareOverrides:{color:'白'}};
 const view=erpDescription(fan,{name:'ZE-240B 黑色'},fan.name,'风扇');
 assert.equal(view.color,'');
 assert.deepEqual(view.issues,['颜色：展示 黑，实物 白']);
 assert.equal(rankedTemplateGpus([other,gpu],gpuSpec(gpu),'white')[0].sourceId,'manual');
 const reset={...gpu,hardwareOverrides:undefined};
 assert.equal(erpDescription(reset,null,reset.name,'显卡').color,'黑');
 assert.equal(rankedTemplateGpus([other,reset],gpuSpec(gpu),'white')[0].sourceId,'auto');
});
