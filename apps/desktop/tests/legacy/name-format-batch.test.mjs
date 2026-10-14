import test from 'node:test';
import assert from 'node:assert/strict';
import {nameFormatPlan,applyNameFormatPlan,mountNameFormatPreview} from '../../public/workbench/name-format-batch.js';
import {suggestedName} from '../../public/workbench/legacy-names.js';
import {captureConfigHistorySnapshot,restoreHistorySnapshot} from '../../public/workbench/editor-performance.js';

const config=(id='a',extras={})=>({id,shopId:'intel',productId:'link',product:'商品',name:'配置三',version:'进阶版',spu:'123',skuId:'456',price:8799,shortName:'原简称',shortNameAuto:true,nameFormat:'compact',parts:[{slot:'CPU',name:'Intel Core i5 13400F',goodsId:'1',qty:1},{slot:'显卡',name:'RTX 5060 8GB',goodsId:'2',qty:1},{slot:'内存',name:'DDR5 16GB',goodsId:'3',qty:2},{slot:'硬盘',name:'NVME 1TB',goodsId:'4',qty:1}],...extras});

test('两种现有格式预览无副作用，应用仅改变显式配置的简称属性',()=>{
 for(const format of ['compact','default']){
  const selected=config(),other=config('b'),foreign=config('c',{shopId:'jonsbo'}),before=structuredClone(selected),otherBefore=structuredClone(other),foreignBefore=structuredClone(foreign);
  const plan=nameFormatPlan([selected],{format,shopId:'intel'});
  assert.deepEqual(selected,before);assert.equal(plan.rows[0].after,suggestedName(selected,format));
  assert.deepEqual(applyNameFormatPlan(plan,[selected,other,foreign]),['a']);
  assert.deepEqual(selected,{...before,shortName:suggestedName(before,format),nameFormat:format,shortNameAuto:true});assert.deepEqual(other,otherBefore);assert.deepEqual(foreign,foreignBefore);
 }
});

test('默认保留手动简称及其图片文本，显式覆盖才恢复自动跟随',()=>{
 const manual=config('m',{shortNameAuto:false,shortName:'人工自定义',posterSubtitle:'海报专用摘要',textStyles:{'header.subtitle':{text:'旧图文字',size:23,x:44}}}),before=structuredClone(manual);
 const preserve=nameFormatPlan([manual],{format:'default'});assert.equal(preserve.rows[0].preserved,true);assert.deepEqual(applyNameFormatPlan(preserve,[manual]),[]);assert.deepEqual(manual,before);
 const replace=nameFormatPlan([manual],{format:'default',replaceManual:true});assert.deepEqual(applyNameFormatPlan(replace,[manual]),['m']);assert.equal(manual.shortNameAuto,true);assert.equal(manual.shortName,suggestedName(manual,'default'));assert.equal(manual.posterSubtitle,undefined);assert.deepEqual(manual.textStyles['header.subtitle'],{size:23,x:44});
});

test('旧配置未记录自动标记时保守保留已有手动名称，空简称可生成',()=>{
 const manual=config('m',{shortNameAuto:undefined}),empty=config('e',{shortNameAuto:false,shortName:''});const plan=nameFormatPlan([manual,empty]);assert.equal(plan.rows[0].preserved,true);assert.equal(plan.rows[1].preserved,false);assert.deepEqual(applyNameFormatPlan(plan,[manual,empty]),['e']);
});

test('自动简称重新生成清除图片文本覆盖并保留布局、字号和显示设置',()=>{
 const c=config('a',{posterSubtitle:'旧摘要',posterFields:{subtitle:false},textStyles:{'header.subtitle':{text:'旧长图',size:15,x:12},'header.name':{text:'专用标题'}},skuTextStyles:{'header.subtitle':{text:'旧方图',size:21,y:32}}});applyNameFormatPlan(nameFormatPlan([c]),[c]);assert.equal(c.posterSubtitle,undefined);assert.deepEqual(c.posterFields,{subtitle:false});assert.deepEqual(c.textStyles,{'header.subtitle':{size:15,x:12},'header.name':{text:'专用标题'}});assert.deepEqual(c.skuTextStyles,{'header.subtitle':{size:21,y:32}});
});

test('空范围、跨店、重复、已删除配置以及未知格式拒绝预览',()=>{
 for(const [configs,options] of [[[],{}],[[config(),config('b',{shopId:'jonsbo'})],{}],[[config(),config()],{}],[[config('a',{deletedAt:'2026-10-12'})],{}],[[config()],{format:'third'}]])assert.throws(()=>nameFormatPlan(configs,options));
});

test('预览后名称、版本、配件、简称或自动标记改变均拒绝整批，不部分应用',()=>{
 for(const mutate of [c=>c.name='配置四',c=>c.version='旗舰版',c=>c.parts[0].name='Intel 225F',c=>c.parts[2].qty=1,c=>c.shortName='新手动简称',c=>c.shortNameAuto=false,c=>c.shopId='jonsbo',c=>c.deletedAt='2026-10-12']){
  const first=config(),second=config('b'),plan=nameFormatPlan([first,second],{format:'default'}),firstBefore=structuredClone(first);mutate(second);assert.throws(()=>applyNameFormatPlan(plan,[first,second]),/变化/);assert.deepEqual(first,firstBefore);
 }
 const c=config(),plan=nameFormatPlan([c]);assert.throws(()=>applyNameFormatPlan(plan,[]),/变化/);
});

test('无关价格改变不覆盖新价格，生成的名称仍可按既有撤销记录恢复',()=>{
 const c=config(),workspace={configs:[c]},snapshot=captureConfigHistorySnapshot(workspace,{active:'a',activeShopId:'intel',selected:new Set(['a'])},['a']),plan=nameFormatPlan([c],{format:'default'});c.price=8999;applyNameFormatPlan(plan,[c]);assert.equal(c.price,8999);const restored=restoreHistorySnapshot(workspace,snapshot);assert.equal(restored.configs[0].shortName,'原简称');assert.equal(restored.configs[0].nameFormat,'compact');
});

test('新建和WPS导入后的配置均按同一次选择生成，不改变标题版本和平台编号',()=>{
 const configs=[config('new',{shortName:'',shortNameAuto:true}),config('wps',{name:'配置十',version:'豪华版',shortName:'',shortNameAuto:true})],before=structuredClone(configs);applyNameFormatPlan(nameFormatPlan(configs,{format:'default'}),configs);configs.forEach((c,i)=>{assert.equal(c.shortName,suggestedName(before[i],'default'));for(const key of ['name','version','spu','skuId','price','parts'])assert.deepEqual(c[key],before[i][key]);});
});

test('预览控件先预览再应用，改变格式或覆盖选项使预览失效',()=>{
 const elements=new Map(['format','manual','preview','status','results'].map(key=>[`[data-batch-name-${key}]`,{value:'compact',checked:false,textContent:'',innerHTML:''}]));
 const container={innerHTML:'',querySelector:key=>elements.get(key)},c=config(),messages=[];
 const control=mountNameFormatPreview(container,{getConfigs:()=>[c],shopId:'intel',esc:String,toast:message=>messages.push(message)});
 assert.throws(()=>control.read(),/先预览/);control.preview();assert.equal(control.read().format,'compact');elements.get('[data-batch-name-format]').value='default';elements.get('[data-batch-name-format]').onchange();assert.throws(()=>control.read(),/先预览/);control.preview();assert.equal(control.read().format,'default');elements.get('[data-batch-name-manual]').checked=true;elements.get('[data-batch-name-manual]').onchange();assert.throws(()=>control.read(),/先预览/);assert.deepEqual(messages,[]);
});

test('创建控件直接应用当前所选格式，不增加预览步骤；输入变化后读取新值',()=>{
 const elements=new Map(['format','manual','preview','status','results'].map(key=>[`[data-batch-name-${key}]`,{value:'compact',checked:false,textContent:'',innerHTML:''}]));const c=config(),container={innerHTML:'',querySelector:key=>elements.get(key)};
 const control=mountNameFormatPreview(container,{getConfigs:()=>[c],shopId:'intel',esc:String,toast:assert.fail,requirePreview:false});
 elements.get('[data-batch-name-format]').value='default';let plan=control.read();assert.equal(plan.format,'default');assert.equal(plan.rows[0].after,suggestedName(c,'default'));c.name='配置九';plan=control.read();assert.match(plan.rows[0].after,/配置9/);
});
