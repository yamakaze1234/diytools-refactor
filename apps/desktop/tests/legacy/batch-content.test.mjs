import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBatchContent,posterAddonTextRows} from '../../public/workbench/batch-content.js';
import {copyText} from '../../public/workbench/core.js';

test('同步版本保存新的自动简称，维护表复制也补正已存旧简称',()=>{
 const auto={name:'配置2',version:'进阶版',shortName:'旧简称',shortNameAuto:true,nameFormat:'compact',posterSubtitle:'自定义副标题',
  parts:[{slot:'CPU',name:'AMD Ryzen 7 9700X',goodsId:'1',qty:1}]};
 const autoInSavedData={...auto,version:'黑色'};
 const manual={...auto,shortNameAuto:false,shortName:'维护表人工简称'};
 const reference={version:'黑色'};
 applyBatchContent(reference,auto,{version:true});
 applyBatchContent(reference,manual,{version:true});
 assert.equal(auto.version,'黑色');
 assert.match(auto.shortName,/黑色$/);
 assert.equal(auto.posterSubtitle,'自定义副标题');
 assert.equal(manual.version,'黑色');
 assert.equal(manual.shortName,'维护表人工简称');
 assert.equal(copyText([autoInSavedData,manual],'name'),auto.shortName+'\r\n'+manual.shortName);
});
test('批量同步只替换底部文字，保留目标配件加购、旧组合商品和单独的福利选项',()=>{
 const linked={text:'目标配件加购',sourceId:'s',items:[{goodsId:'9',qty:2}],priceCents:9800,followPolicy:'follow',followAll:true};
 const multi={text:'目标多选加购',choices:[{goodsId:'8',qty:1,priceCents:1100}]};
 const reference={addons:[{...linked,text:'基准配件加购'},{...multi,text:'基准多选加购'},
  {text:'底部说明',note:'联系客户',goodsId:'1',priceCents:40000,items:[{goodsId:'1',qty:2}]},{text:'另一条文案'},{text:'  ',note:''}],benefits:[{text:'新福利'}]};
 const legacy={text:'旧组合',note:'旧备注',goodsId:'5',qty:3,priceCents:1200,items:[{goodsId:'5',qty:3}]};
 const target={parts:[{sourceId:'s',upgrade:'配件自己的旧加购'}],addons:[legacy,linked,multi],benefits:[{text:'旧福利'}],price:100,skuId:'123',
  textStyles:{'addons.0.text':{text:'自由编辑旧文案',color:'#abc'},'addons.1.text':{text:'配件自己的样式文字'},'addons.3.note':{text:'历史残留说明'}}};
 const unchanged=structuredClone(target);
 applyBatchContent(reference,target);
 assert.deepEqual(target,unchanged);
 assert.equal(posterAddonTextRows(reference).length,2);
 applyBatchContent(reference,target,{addons:true});
 assert.deepEqual(target.addons,[{...unchanged.addons[0],text:'底部说明',note:'联系客户'},{text:'另一条文案',note:'',items:[]},linked,multi]);
 assert.deepEqual(target.benefits,unchanged.benefits);
 assert.deepEqual(target.parts,unchanged.parts);
 assert.equal(target.price,100);
 assert.equal(target.skuId,'123');
 assert.deepEqual(target.textStyles,{'addons.0.text':{color:'#abc'},'addons.2.text':{text:'配件自己的样式文字'}});

 const afterAddons=structuredClone(target.addons);
 applyBatchContent(reference,target,{benefits:true});
 assert.deepEqual(target.addons,afterAddons);
 assert.deepEqual(target.benefits,reference.benefits);
 applyBatchContent({addons:[linked],benefits:[]},target,{addons:true});
 assert.deepEqual(target.addons,[{...unchanged.addons[0],text:'',note:''},linked,multi]);
 assert.deepEqual(target.benefits,reference.benefits);
});
