import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fieldState,sharedScopeRow} from '../../public/workbench/shared-source-editor.js';

const color='hardwareOverrides.color';
const stores={
 intel:[{sourceId:'intel1',fields:{name:'英特尔原名',[color]:'黑'},legacy:['name',color]}],
 gigabyte:[
  {sourceId:'gb1',fields:{name:'技嘉原名一'},legacy:['name']},
  {sourceId:'gb2',fields:{name:'技嘉原名二'},legacy:['name']},
 ],
 jonsbo:[{sourceId:'jb1',fields:{},legacy:[]}],
};
const entry={common:{name:'原共用名称'},stores};

test('共用字段列出仍覆盖的店铺，保留不同历史来源原值',()=>{
 const edits={shared:{values:{name:'新共用名称'},restore:[]}};
 assert.deepEqual(fieldState(entry,'shared','name','intel1',edits),{
  value:'新共用名称',label:'共用',inherited:true,overrideShops:['intel','gigabyte'],
 });
 assert.equal(fieldState(entry,'intel','name','intel1',edits).label,'保留店铺原值');
 assert.equal(fieldState(entry,'gigabyte','name','gb2',edits).label,'多个店铺原值');
 assert.equal(sharedScopeRow({sourceId:'intel1'},entry,'intel',edits).name,'英特尔原名');
 assert.equal(sharedScopeRow({sourceId:'jb1'},entry,'jonsbo',edits).name,'新共用名称');
});

test('共用颜色从待设转为待保存时，识别单店草稿和待恢复值',()=>{
 const before=fieldState(entry,'shared',color,'intel1');
 assert.equal(before.inherited,false);
 assert.deepEqual(before.overrideShops,['intel']);
 const edits={
  shared:{values:{[color]:'白'},restore:[]},
  intel:{values:{},restore:[color]},
  jonsbo:{values:{[color]:'黑'},restore:[]},
 };
 assert.deepEqual(fieldState(entry,'shared',color,'intel1',edits),{
  value:'白',label:'共用',inherited:true,overrideShops:['jonsbo'],
 });
 assert.deepEqual(fieldState(entry,'intel',color,'intel1',edits),{value:'白',label:'待恢复共用'});
 assert.equal(sharedScopeRow({sourceId:'intel1'},entry,'intel',edits).hardwareOverrides.color,'白');
 assert.equal(sharedScopeRow({sourceId:'jb1'},entry,'jonsbo',edits).hardwareOverrides.color,'黑');
});
