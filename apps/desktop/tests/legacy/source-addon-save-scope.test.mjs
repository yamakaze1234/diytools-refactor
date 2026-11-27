import test from 'node:test';
import assert from 'node:assert/strict';
import {changedSourceText,editedSourceTextFields} from '../../public/workbench/source-diff-alert.js';

test('共用与本店修改检查名称和加购，保存后按别名核对实际变动',()=>{
 const own={sourceId:'common-alias',shopId:'intel',name:'旧共用名',addonText:'旧加购'};
 const custom={...own,sourceId:'store-alias',name:'本店独享',addonText:'本店独享'};
 const edit=edits=>editedSourceTextFields({row:own,managed:{id:'fixture',edits}},'intel');
 assert.deepEqual(edit({shared:{values:{name:'新名称'}}}),['name']);
 assert.deepEqual(edit({gigabyte:{values:{addon:{addonText:'外店升级'}}}}),[]);
 assert.deepEqual(edit({intel:{restore:['name','addon']}}),['name','upgrade']);
 const after=[
  {...own,name:'新名称',addonText:'新加购'},custom,
  {...own,sourceId:'hidden',deletedAt:'today'},{...own,sourceId:'unrelated',name:'其他修改'},
 ];
 const allowed=new Set(['common-alias','store-alias','hidden']);
 assert.deepEqual(changedSourceText([own,custom],after,row=>new Set(allowed.has(row.sourceId)?['name','upgrade']:[])),
  [{row:after[0],fields:['name','upgrade']}]);
 assert.deepEqual(changedSourceText([own],after.slice(0,1),()=>new Set(['name'])),[{row:after[0],fields:['name']}]);
});

test('单店恢复名称和清空加购分别纳入决策，外店与非文案改动跳过',()=>{
 const before={sourceId:'fixture',shopId:'intel',name:'配件',addonChoices:[{label:'原升级'}]};
 const edit=row=>editedSourceTextFields({before,row},'intel');
 assert.deepEqual(edit({...before,addonChoices:[]}),['upgrade']);
 assert.deepEqual(edit({...before,name:'新名称'}),['name']);
 assert.deepEqual(edit({...before,shopId:'gigabyte',addonChoices:[]}),[]);
 assert.deepEqual(edit({...before,tax:10}),[]);
});
