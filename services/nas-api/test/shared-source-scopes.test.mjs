// 新建配件的共用字段和单店差异必须保持独立，并在同一次目录创建中提交。
import test from 'node:test';
import assert from 'node:assert/strict';
import {newSharedScopeRow} from '../../../apps/desktop/public/workbench/shared-source-editor.js';
import {validateSharedSourceEdit} from '../src/shared-sources.mjs';

test('新配件范围投影保留身份，各店只覆盖明确填写的字段',()=>{
 const base={sourceId:'draft-id',shopId:'intel',goodsId:'990019',name:'',tax:null,erpName:'ERP 原名称'};
 const edits={shared:{values:{name:'三店名称',tax:100,'capacityOverrides.memoryGb':48,addon:{addonChoices:[{id:'c',goodsId:'',qty:1,label:'共用加购',enabled:true}]}},restore:[]},jonsbo:{values:{name:'乔思伯名称',tax:110,'capacityOverrides.memoryGb':64},restore:[]}};
 const before=structuredClone({base,edits});
 for(const shop of ['shared','intel','gigabyte','jonsbo']){
  const row=newSharedScopeRow(base,shop,edits);assert.equal(row.sourceId,base.sourceId);assert.equal(row.goodsId,base.goodsId);assert.equal(row.erpName,base.erpName);
  assert.equal(row.name,shop==='jonsbo'?'乔思伯名称':'三店名称');assert.equal(row.tax,shop==='jonsbo'?110:100);
  assert.equal(row.capacityOverrides.memoryGb,shop==='jonsbo'?64:48);assert.equal(row.addonChoices[0].label,'共用加购');
 }
 assert.deepEqual({base,edits},before);
});

test('创建必须有共用名称，可同时提交合法单店差异，仍拒绝无共用基线或非法范围字段',()=>{
 const document={id:'990019',edits:{shared:{values:{name:'共用名称',tax:100},restore:[]},jonsbo:{values:{name:'本店名称',tax:110},restore:[]}}};
 assert.doesNotThrow(()=>validateSharedSourceEdit(document.id,document,true));
 for(const edits of [{jonsbo:document.edits.jonsbo},{shared:{values:{tax:100},restore:[]}},{...document.edits,unknown:document.edits.jonsbo},{...document.edits,intel:{values:{tax:-1},restore:[]}}]){
  assert.throws(()=>validateSharedSourceEdit(document.id,{...document,edits},true),{code:'VALIDATION_FAILED'});
 }
});
