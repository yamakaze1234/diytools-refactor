import test from 'node:test';
import assert from 'node:assert/strict';
import {posterExtraRows,editPosterExtra,addPosterExtra,removePosterExtra,setPosterExtraVisible} from '../../public/workbench/config-extras.js';
import {applySharedTaxEdit} from '../../public/workbench/shared-source-editor.js';

test('独立文字加购保留原有商品成本字段，新增记录满足 NAS 的 items 合同',()=>{
 const source={sourceId:'cpu-source',text:'来源加购',goodsId:'123',qty:2,priceCents:9900,followAll:true};
 const config={addons:[structuredClone(source),{text:'豪华升级包',note:'机箱升级',index:99,goodsId:'456',qty:1,priceCents:39900,items:[{goodsId:'456',qty:1}]}],benefits:[],modules:[{type:'addons',visible:false},{type:'benefits',visible:false}],actualParts:[{goodsId:'123',tax:950}],price:3999};
 const before=structuredClone(config);assert.deepEqual(posterExtraRows(config,'addons').map(row=>row.index),[1]);
 editPosterExtra(config,'addons',1,'text','【豪华颜值升级 +399元 联系客服加购】\n视觉无断点');
 assert.deepEqual(config.addons[0],source);assert.equal(config.addons[1].priceCents,39900);assert.equal(config.addons[1].index,99);assert.deepEqual(config.actualParts,before.actualParts);assert.equal(config.price,before.price);
 assert.throws(()=>editPosterExtra(config,'addons',0,'text','不可改来源加购'),/配置总表/);
 addPosterExtra(config,'addons');assert.deepEqual(config.addons.at(-1),{text:'',note:'',items:[]});assert.equal(config.modules[0].visible,true);
 editPosterExtra(config,'addons',2,'text','联系客服加购');removePosterExtra(config,'addons',2);assert.equal(config.addons.length,2);
 addPosterExtra(config,'benefits');editPosterExtra(config,'benefits',0,'text','免费装机测试\n专属售后');assert.equal(config.modules[1].visible,true);
});

test('明确修改共用核算价只恢复三店 tax，保留名称、加购和其他待提交字段',()=>{
 const edits={shared:{values:{name:'共用名称'},restore:[]},intel:{values:{tax:1290,name:'本店名称',addon:{addonText:'本店加购'}},restore:['hardwareOverrides.cpuName']},gigabyte:{values:{tax:1300},restore:[]}};
 applySharedTaxEdit(edits,1320);
 assert.equal(edits.shared.values.tax,1320);assert.equal(edits.shared.values.name,'共用名称');
 assert.deepEqual(edits.intel.values,{name:'本店名称',addon:{addonText:'本店加购'}});
 assert.deepEqual(edits.intel.restore,['hardwareOverrides.cpuName','tax']);
 for(const shop of ['intel','gigabyte','jonsbo']){assert.ok(edits[shop].restore.includes('tax'));assert.ok(!Object.hasOwn(edits[shop].values,'tax'));}
});

test('旧配置缺少加购福利模块时补齐默认模块，保留其它模块、未知字段和条目身份',()=>{
 const custom={id:'benefits',type:'custom',text:'保留自定义内容',visible:true,unknown:{legacy:'原字段'}};
 const service={id:'service',type:'service',text:'原服务',visible:false,unknownStyle:7};
 const config={shopId:'intel',theme:'dark',modules:[structuredClone(custom),structuredClone(service)],
  addons:[{id:'legacy-addon',text:'旧升级包',goodsId:'000456',qty:2,priceCents:9900,unknown:true}],benefits:[],unknownConfig:{keep:1}};
 const before=structuredClone(config),customRef=config.modules[0],serviceRef=config.modules[1];
 addPosterExtra(config,'benefits');addPosterExtra(config,'addons');
 assert.equal(config.modules.filter(module=>module.type==='benefits').length,1);
 assert.equal(config.modules.filter(module=>module.type==='addons').length,1);
 assert.equal(config.modules.find(module=>module.type==='benefits').visible,true);
 assert.equal(config.modules.find(module=>module.type==='addons').visible,true);
 assert.equal(config.modules.find(module=>module.type==='benefits').id,'benefits-new');
 assert.deepEqual(config.modules.filter(module=>['custom','service'].includes(module.type)),before.modules);
 assert.equal(config.modules.find(module=>module.type==='custom'),customRef);assert.equal(config.modules.at(-1),serviceRef);
 assert.deepEqual(config.addons[0],before.addons[0]);assert.deepEqual(config.unknownConfig,before.unknownConfig);
 setPosterExtraVisible(config,'benefits',false);assert.equal(config.modules.find(module=>module.type==='benefits').visible,false);
 setPosterExtraVisible(config,'benefits',true);assert.equal(config.modules.filter(module=>module.type==='benefits').length,1);
 // 保存重开仍有真正可绘制的模块，不依赖界面的临时勾选状态。
 const reopened=JSON.parse(JSON.stringify(config));assert.equal(reopened.modules.find(module=>module.type==='benefits').visible,true);
});

test('明确开启缺失模块可恢复旧文字，未保存模块数组仍沿用全部默认模块',()=>{
 const config={shopId:'jonsbo',theme:'light',modules:[],addons:[],benefits:[{text:'已有福利',note:'保留备注',id:'old-benefit'}]};
 assert.equal(setPosterExtraVisible(config,'benefits',false),null);assert.deepEqual(config.modules,[]);
 const before=structuredClone(config.benefits);setPosterExtraVisible(config,'benefits',true);
 assert.equal(config.modules.length,1);assert.equal(config.modules[0].type,'benefits');assert.deepEqual(config.benefits,before);
 const implicit={shopId:'intel',theme:'dark'};setPosterExtraVisible(implicit,'addons',true);
 assert.deepEqual(implicit.modules.map(module=>module.type),['header','parts','addons','benefits','service','footer']);
 assert.throws(()=>setPosterExtraVisible(config,'parts',true),/无效/);
});
