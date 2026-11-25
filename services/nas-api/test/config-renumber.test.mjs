import test from 'node:test';
import assert from 'node:assert/strict';
import {renumberFields,renumberProduct} from '../src/config-renumber.mjs';

test('编号回执仅投影四个叶值，区分缺键、空串和显式 null',()=>{
 assert.deepEqual(renumberFields({shortName:'',posterSubtitle:null,textStyles:{'header.subtitle':{size:18}},
  skuTextStyles:{'header.subtitle':{text:'配置五丨小图',color:'#222'}}}),
 {shortName:'',posterSubtitle:null,skuTextSubtitle:'配置五丨小图'});
});

test('链接编号已连续时只获取行锁，不取配件明细或推进版本',async()=>{
 const calls=[],db={query:async(sql,args)=>{
  calls.push({sql,args});
  return {rows:[{id:'a',name:'配置1',fields:{shortNameAuto:true},design:{}},{id:'b',name:'主推款',fields:{},design:{}}]};
 }};
 assert.deepEqual(await renumberProduct(db,'intel','link'),[]);
 assert.equal(calls.length,1);assert.match(calls[0].sql,/FOR UPDATE/);assert.deepEqual(calls[0].args,['intel','link']);
});
