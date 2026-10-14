import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ordinarySaveChanges,ordinaryPresentationFields} from '../../public/workbench/batch-save.js';

const base=()=>({
 configs:[{id:'one',shopId:'intel',productId:'link',name:'旧名',price:100,parts:[{lineId:'cpu',goodsId:'123',qty:1}],actualParts:[],addons:[]}],
 templates:[{id:'template',name:'样例'}],sourceCatalog:[{sourceId:'source',goodsId:'123',name:'CPU'}],
 costSource:[{goodsId:'123',tax:10}],caseGallery:[{id:'picture',name:'机箱'}],
 shopSettings:{gigabyte:{coupon:0},intel:{coupon:0},jonsbo:{coupon:0}}
});

test('对象键重排和 undefined 默认值不阻止普通配置增量',()=>{
 const before=base(),after=structuredClone(before);
 after.shopSettings={intel:{coupon:0},gigabyte:{coupon:0},jonsbo:{coupon:0}};
 after.templates=[{name:'样例',id:'template'}];
 after.sourceCatalog=[{name:'CPU',goodsId:'123',sourceId:'source'}];
 after.costSource=[{tax:10,goodsId:'123'}];
 after.caseGallery=[{name:'机箱',id:'picture'}];
 after.configs[0]={price:100,name:'新名',id:'one',shopId:'intel',productId:'link',parts:[{qty:1,goodsId:'123',lineId:'cpu'}],addons:[],actualParts:[],temporary:undefined};
 const changes=ordinarySaveChanges(before,after);
 assert.equal(changes?.length,1);
 assert.equal(changes[0].after.name,'新名');
});

test('全局内容变化与数组重排仍回退完整保存',()=>{
 const before=base(),after=structuredClone(before);
 after.configs[0].name='新名';
 after.shopSettings.intel.coupon=10;
 assert.equal(ordinarySaveChanges(before,after),null);
 after.shopSettings.intel.coupon=0;
 after.sourceCatalog.push({sourceId:'second',goodsId:'124',name:'内存'});
 before.sourceCatalog.push({sourceId:'second',goodsId:'124',name:'内存'});
 after.sourceCatalog.reverse();
 assert.equal(ordinarySaveChanges(before,after),null);
});

test('目标配置非白名单字段的真实变化继续回退完整保存',()=>{
 const before=base(),after=structuredClone(before);
 after.configs[0].name='新名';
 after.configs[0].productId='other-link';
 assert.equal(ordinarySaveChanges(before,after),null);
});

test('配置样式契约与 Rust 允许字段完全一致',()=>{
 const rust=readFileSync(new URL('../../src-tauri/src/workbench_store.rs',import.meta.url),'utf8');
 const contract=rust.match(/const ORDINARY_PRESENTATION_FIELDS:.*?=\s*&\[([\s\S]*?)\];/);
 assert.ok(contract,'missing Rust presentation field contract');
 assert.deepEqual([...contract[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(m=>m[1]).sort(),[...ordinaryPresentationFields].sort());
 assert.equal(new Set(ordinaryPresentationFields).size,ordinaryPresentationFields.length);
});

test('海报文字/模块/机箱与添加图片拖动走单配置完整前后值增量',()=>{
 const before=base();before.configs[0].unknown={legacy:true,raw:'00123'};
 before.configs.push({...structuredClone(before.configs[0]),id:'two'});
 const after=structuredClone(before),c=after.configs[0];
 c.freeCanvasLayouts={long:{height:1200,base:700,autoWidth:false}};
 c.textTransforms={long:{'part.CPU.name':{x:123,y:456,scaleX:1,scaleY:1}}};
 c.moduleTransforms={long:{parts:{x:16,y:200,width:668,height:500}}};
 c.caseTransforms={long:{x:400,y:20,width:250,height:250}};
 c.posterImages=[{id:'image',url:'/uploads/new.png',naturalWidth:1000,naturalHeight:1000,transforms:{long:{x:16,y:600,width:120,height:120}}}];
 const changes=ordinarySaveChanges(before,after);
 assert.equal(changes.length,1);assert.equal(changes[0].id,'one');
 assert.strictEqual(changes[0].base,before.configs[0]);assert.strictEqual(changes[0].after,c);
 assert.deepEqual(changes[0].after.unknown,before.configs[0].unknown);
 assert.equal(JSON.stringify(changes).includes('sourceCatalog'),false);
});

test('每个明确的配置样式字段及恢复自动排版的字段移除均允许增量',()=>{
 for(const field of ordinaryPresentationFields){
  const before=base(),after=structuredClone(before);after.configs[0][field]={changed:true};
  assert.equal(ordinarySaveChanges(before,after)?.length,1,field);
  const reverted=structuredClone(after);delete reverted.configs[0][field];
  assert.equal(ordinarySaveChanges(after,reverted)?.length,1,`${field} removal`);
 }
});

test('未知字段变化与店铺/链接/删除/ID/排序边界仍阻止样式增量',()=>{
 for(const field of ['id','shopId','productId','product','productUrl','productCategory','productCardColor','spu','skuId','deletedAt','deletionSessionId','order','configOrder','unknown']){
  const before=base(),after=structuredClone(before);after.configs[0].textStyles={header:{color:'#abcdef'}};
  after.configs[0][field]='changed';assert.equal(ordinarySaveChanges(before,after),null,field);
 }
 for(const field of ['templates','sourceCatalog','costSource','caseGallery','shopSettings']){
  const before=base(),after=structuredClone(before);after.configs[0].caseImage='/uploads/new.png';
  after[field]=[];assert.equal(ordinarySaveChanges(before,after),null,field);
 }
 const before=base();before.configs.push({...structuredClone(before.configs[0]),id:'two'});
 for(const update of [rows=>rows.reverse(),rows=>rows.pop(),rows=>rows.push({...rows[0],id:'three'}),rows=>rows[1].id='one']){
  const after=structuredClone(before);after.configs[0].layout='square';update(after.configs);
  assert.equal(ordinarySaveChanges(before,after),null);
 }
});
