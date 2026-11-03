import test from 'node:test';
import assert from 'node:assert/strict';
import {inferBoardType,inferCaseType,boardCaseIssue,validateHardware,configHardwareIssues,applyHardwareMaintenance} from '../../public/workbench/component-hardware.js';
import {sourceBatch} from '../../public/workbench/source-batch.js';
import {sourcePart,bindSources} from '../../public/workbench/source.js';
import {suggestedName} from '../../public/workbench/legacy-names.js';
import {displayedAddon,attachAddonHardware,selectHardwareUpgrade,partHardwareWarning,addonHardwareWarning} from '../../public/workbench/hardware-upgrade.js';
import {displayUpgrade} from '../../public/workbench/memory-upgrade.js';
test('型号后缀识别，WIFI/GAMING/ICE 不干扰，特殊型号留待确认',()=>{
 for(const [name,type] of [['技嘉 B760M GAMING WIFI ICE','MATX'],['微星 B760I EDGE WIFI','ITX'],['华硕 Z890 GAMING WIFI','ATX'],['技嘉 X870E AORUS ELITE X3D','ATX'],['华硕 ROG STRIX B850-G GAMING WIFI S',null],['技嘉 X870E AORUS XTREME AI TOP',null],['B760BKB',null]])assert.equal(inferBoardType({name}),type,name);
});
test('机箱规格区分 MATX/EATX，ATX 电源不当作主板支持',()=>{
 for(const [name,type] of [['Q58(ITX/兼容SFX和ATX电源/Type-C)','ITX'],['Z20(M-ATX/支持240水冷)','MATX'],['机箱(E-ATX/顶置420)','E-ATX'],['机箱支持ATX电源',null]])assert.equal(inferCaseType({name}),type,name);
});
test('搭配错误、未知、手工支持列表优先，并分别检查展示和实际',()=>{
 const b={slot:'主板',goodsId:'1',name:'Z890'},box={slot:'机箱',goodsId:'2',name:'机箱 M-ATX'};
 assert.equal(boardCaseIssue(b,box).status,'error');assert.equal(boardCaseIssue(b,{name:'机箱'}).status,'unknown');assert.equal(boardCaseIssue(b,{...box,hardwareOverrides:{caseBoards:['ATX']}}).status,'ok');
 assert.equal(configHardwareIssues({parts:[b,box],actualParts:[b,box]}).length,2);
 assert.throws(()=>validateHardware({caseBoards:['BAD']}));
});
test('维护资料保存跟随同店配件，保留价格数量与手工简称，清空人工值回到自动',()=>{
 const row={sourceId:'s',shopId:'intel',goodsId:'1',name:'B760M',erp:10,tax:20};const part={...sourcePart(row),slot:'主板',qty:2};
 const state={configs:[{id:'c',shopId:'intel',parts:[part],actualParts:[structuredClone(part)],shortName:'手工名',shortNameAuto:false,addons:[]}],sourceCatalog:[row],costSource:[{...row}]};
 const result=sourceBatch(state,[{before:row,row:{...row,hardwareOverrides:{boardType:'ATX'}}}]);
 assert.equal(result.next.configs[0].parts[0].hardwareOverrides.boardType,'ATX');assert.equal(result.next.configs[0].actualParts[0].hardwareOverrides.boardType,'ATX');assert.equal(result.next.configs[0].parts[0].qty,2);assert.equal(result.next.configs[0].shortName,'手工名');assert.equal(state.configs[0].parts[0].hardwareOverrides,undefined);
 const saved=result.next.sourceCatalog[0];const reset=sourceBatch(result.next,[{before:saved,row:{...saved,hardwareOverrides:undefined}}]);assert.equal(reset.next.configs[0].parts[0].hardwareOverrides,undefined);assert.equal(reset.next.configs[0].parts[0].hardwareFacts.boardType,'MATX');
});
test('CPU维护简称用于生成配置名',()=>{const c={name:'配置1',parts:[{slot:'CPU',goodsId:'1',name:'Intel I5 14600KF',hardwareOverrides:{cpuName:'14700KF'},qty:1}]};assert.match(suggestedName(c),/14700KF/);});
test('混合加购只隐藏大板选项，换机箱恢复，原资料不修改',()=>{
 const a={sourceId:'s',text:'【+100元大板】【+50元小板】',choices:[{id:'a',goodsId:'3',qty:1,enabled:true,label:'大板',priceCents:10000},{id:'b',goodsId:'4',qty:1,enabled:true,label:'小板',priceCents:5000}]};
 const c={shopId:'intel',parts:[{slot:'机箱',goodsId:'2',name:'机箱 M-ATX'},{slot:'主板',goodsId:'1',sourceId:'s',upgrade:a.text}],addons:[a]};
 attachAddonHardware(c,[{shopId:'intel',goodsId:'3',name:'Z890'},{shopId:'intel',goodsId:'4',name:'B760M'}]);
 assert.equal(displayedAddon(a,c).text,'【+50元小板】');assert.equal(displayUpgrade(c.parts[1],c),'【+50元小板】');assert.equal(a.choices[0].enabled,true);
 c.parts[0].hardwareOverrides={caseBoards:['ATX','MATX']};assert.equal(displayedAddon(a,c).text,a.text);
});
test('未知加购不隐藏，原内存双条行为保持，空文本不留下独立说明',()=>{
 const c={parts:[{slot:'机箱',goodsId:'2',name:'机箱 M-ATX'}]};assert.equal(displayedAddon({text:'升级魔鹰'},c).text,'升级魔鹰');assert.equal(displayedAddon({text:'升级Z890',note:'附注',hardwareFacts:{boardType:'ATX'}},c).note,'');assert.equal(displayUpgrade({slot:'内存',qty:2,upgrade:'升级16G×2'},c),'');
});
test('批量补全保留历史价格精度、人工值及源内容；过期基线整批拒绝',()=>{
 const row={sourceId:'s',shopId:'intel',goodsId:'1',name:'B760M',tax:123.456,hardwareOverrides:{boardType:'ITX'}};
 const state={configs:[{id:'c',shopId:'intel',parts:[{...sourcePart(row),slot:'主板',qty:3}],addons:[]}],sourceCatalog:[row],costSource:[{goodsId:'1',tax:123.456}]};
 const changes=[{before:row,row:{...row,hardwareFacts:{boardType:'MATX'},name:'不得覆盖原名',tax:0}}];
 const result=applyHardwareMaintenance(state,changes);assert.equal(result.next.sourceCatalog[0].tax,123.456);assert.equal(result.next.sourceCatalog[0].name,'B760M');assert.equal(result.next.configs[0].parts[0].hardwareOverrides.boardType,'ITX');assert.deepEqual(result.next.costSource,state.costSource);
 assert.throws(()=>applyHardwareMaintenance(result.next,changes),/已变化/);
});
// 覆盖水冷误识别，并确认真正的主板升级仍执行兼容过滤。
test('升级过滤保留A090水冷，仅隐藏有主板依据的不兼容升级',()=>{
 const c={parts:[{slot:'机箱',goodsId:'2',name:'机箱 M-ATX'}]};
 const text='【双11限时福利|限时升级钛坦A090水冷+OLED曲面屏套件|展域同款】';
 assert.equal(displayUpgrade({slot:'散热',upgrade:text},c),text);
 assert.equal(displayedAddon({text},c).text,text);
 const a={text,choices:[{enabled:true,customText:true,label:text,hardwareName:'钛坦A090-240 水冷',hardwareFacts:{boardType:'ATX'}}]};
 assert.equal(displayedAddon(a,c).text,text);
 assert.equal(displayUpgrade({slot:'主板',upgrade:'【升级Z890】'},c),'');
 assert.equal(displayedAddon({text:'【升级Z890主板】'},c).text,'');
 assert.equal(displayedAddon({text:'【升级A090】'},c).text,'【升级A090】');
 assert.equal(displayUpgrade({slot:'散热',upgrade:'【升级Z890】'},c),'【升级Z890】');
 assert.equal(displayUpgrade({slot:'主板',upgrade:'【升级B760M】'},c),'【升级B760M】');
 assert.equal(a.choices[0].enabled,true);
});

// 用户选择覆盖展示过滤，但不修改实际配件、原文案或候选勾选状态。
test('手动展示主板升级可恢复默认，重载保留，修改文案或机箱需重新确认',()=>{
 const part={slot:'主板',goodsId:'1',upgrade:'【升级Z890】'};
 const c={parts:[part,{slot:'机箱',goodsId:'2',name:'M-ATX 机箱'}],addons:[]};
 assert.equal(displayUpgrade(part,c),'');
 selectHardwareUpgrade(part,c,true);
 assert.equal(displayUpgrade(part,c),part.upgrade);
 assert.equal(partHardwareWarning(part,c),true);
 const saved=JSON.parse(JSON.stringify(c));
 assert.equal(displayUpgrade(saved.parts[0],saved),part.upgrade);
 selectHardwareUpgrade(part,c,false);assert.equal(displayUpgrade(part,c),'');
 selectHardwareUpgrade(part,c,true);part.upgrade='【升级Z790】';assert.equal(displayUpgrade(part,c),'');
 selectHardwareUpgrade(part,c,true);c.parts[1].goodsId='new-case';assert.equal(displayUpgrade(part,c),'');
});
test('混合加购手动展示仅恢复已勾选选项，并保留兼容提示',()=>{
 const c={parts:[{slot:'机箱',goodsId:'2',name:'M-ATX 机箱'}]};
 const a={text:'【大板】【小板】',choices:[{enabled:true,customText:true,label:'【大板】',hardwareFacts:{boardType:'ATX'}},{enabled:true,customText:true,label:'【小板】',hardwareFacts:{boardType:'MATX'}},{enabled:false,customText:true,label:'不应显示',hardwareFacts:{boardType:'ATX'}}]};
 assert.equal(displayedAddon(a,c).text,'【小板】');selectHardwareUpgrade(a,c,true);
 assert.equal(displayedAddon(a,c).text,a.text);assert.equal(addonHardwareWarning(a,c),true);
 selectHardwareUpgrade(a,c,false);assert.equal(displayedAddon(a,c).text,'【小板】');
 assert.equal(a.choices[2].enabled,false);
});
