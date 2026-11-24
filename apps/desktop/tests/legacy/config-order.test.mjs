import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreConfigOrder,planConfigRenumber,applyConfigRenumber,renumberConfigPrefix,configAfterRemoval} from '../../public/workbench/config-order.js';
import {suggestedName} from '../../public/workbench/legacy-names.js';
test('按明确顺序还原，随机ID和配置10不影响顺序',()=>{
 const configs=Array.from({length:20},(_,i)=>({id:String(20-i).padStart(2,'0'),shopId:'intel',productId:'p',name:'配置'+(i+1),price:0,parts:[],wpsImport:{lineStart:i*19+1}}));
 const state={configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 assert.deepEqual(restoreConfigOrder([...configs].reverse()).map(c=>c.id),configs.map(c=>c.id));
});

test('重新编号保留后缀、跳过特殊名称和已删除项，且不修改输入',()=>{
 const rows=['配置1','颜值升级包','配置五：16G / 1T','配置9 · 32G','16G','配置套餐','配置12'].map((name,i)=>({id:String(i),name,...(i===6?{deletedAt:'2026-10-25'}:{})}));
 const before=structuredClone(rows),plan=planConfigRenumber(rows);
 assert.deepEqual(plan.map(r=>r.after),['配置1','颜值升级包','配置2：16G / 1T','配置3 · 32G','16G','配置套餐']);
 assert.deepEqual(rows,before);
 assert.deepEqual(planConfigRenumber(plan.map(r=>({id:r.id,name:r.after}))).filter(r=>r.before!==r.after),[]);
});

test('删除后优先本链接下一套、上一套，整链删除才切邻链，全部删除返回空',()=>{
 const rows=['a','b','c','d'].map((id,i)=>({id,shopId:'intel',productId:i<3?'p':'q'}));
 assert.equal(configAfterRemoval(rows,'b',['b']),'c');
 assert.equal(configAfterRemoval(rows,'c',['c']),'b');
 assert.equal(configAfterRemoval(rows,'b',['a']),'b');
 assert.equal(configAfterRemoval(rows,'a',['a','b','c']),'d');
 assert.equal(configAfterRemoval(rows,'b',rows.map(r=>r.id)),null);
});

test('重新编号同步更新自动简称、手工简称前缀与海报副标题编号，并保留自定义文案',()=>{
 assert.equal(renumberConfigPrefix('配置6：270K+无卡+16G+1T | 豪华版',7),'配置7：270K+无卡+16G+1T | 豪华版');
 assert.equal(renumberConfigPrefix('旗舰水冷主机',7),'旗舰水冷主机');
 const configs=[
  {
   id:'auto',name:'配置5',version:'豪华版',shortName:'配置5：270K+无卡+16G+1T丨豪华版',shortNameAuto:true,nameFormat:'compact',
   posterSubtitle:'配置5：270K+无卡+16G+1T丨豪华版',
   textStyles:{'header.subtitle':{text:'配置5：270K+无卡+16G+1T丨豪华版',size:16}},
   parts:[{slot:'CPU',name:'英特尔 酷睿 Ultra 7 270K Plus 24核24线程',goodsId:'1',qty:1},{slot:'内存',name:'16G',goodsId:'2',qty:1},{slot:'硬盘',name:'1T',goodsId:'3',qty:1},{slot:'显卡',name:'无卡',goodsId:'0',qty:1}],
  },
  {
   id:'manual',name:'配置2',version:'豪华版',shortName:'配置6：270K+无卡+16G+1T | 豪华版',shortNameAuto:false,
   posterSubtitle:'配置6：270K+无卡+16G+1T | 豪华版',
   skuTextStyles:{'header.subtitle':{text:'配置6 · 特惠版',color:'#111'}},
   parts:[],
  },
  {
   id:'custom',name:'配置9',version:'旗舰版',shortName:'旗舰定制款',shortNameAuto:false,
   posterSubtitle:'双十一爆款推荐',
   parts:[],
  },
  {
   id:'special',name:'颜值升级包',version:'',shortName:'配置9：特殊展示',shortNameAuto:false,
   posterSubtitle:'配置9：特殊展示',
   parts:[],
  },
 ];
 const plan=planConfigRenumber(configs);
 assert.equal(plan[0].after,'配置1');
 assert.equal(plan[1].before,'配置2');
 assert.equal(plan[1].after,'配置2');
 assert.equal(plan[1].shortNameChanged,true);
 assert.equal(plan[1].shortNameAfter,'配置2：270K+无卡+16G+1T | 豪华版');
 assert.equal(plan[2].after,'配置3');
 assert.equal(plan[3].skipped,true);
 for(let i=0;i<configs.length;i++)applyConfigRenumber(configs[i],plan[i],suggestedName);
 assert.equal(configs[0].name,'配置1');
 assert.equal(configs[0].shortName,'配置1：270K+无卡+16G+1T丨豪华版');
 assert.equal(configs[0].posterSubtitle,undefined);
 assert.equal(configs[0].textStyles['header.subtitle'].text,undefined);
 assert.equal(configs[0].textStyles['header.subtitle'].size,16);
 assert.equal(configs[1].name,'配置2');
 assert.equal(configs[1].shortName,'配置2：270K+无卡+16G+1T | 豪华版');
 assert.equal(configs[1].posterSubtitle,undefined);
 assert.equal(configs[1].skuTextStyles['header.subtitle'].text,'配置2 · 特惠版');
 assert.equal(configs[1].skuTextStyles['header.subtitle'].color,'#111');
 assert.equal(configs[2].name,'配置3');
 assert.equal(configs[2].shortName,'旗舰定制款');
 assert.equal(configs[2].posterSubtitle,'双十一爆款推荐');
 assert.equal(configs[3].name,'颜值升级包');
 assert.equal(configs[3].shortName,'配置9：特殊展示');
 assert.equal(configs[3].posterSubtitle,'配置9：特殊展示');
});
