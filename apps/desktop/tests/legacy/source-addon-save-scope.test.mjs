import test from 'node:test';
import assert from 'node:assert/strict';
import {changedAddonSources,editsShopAddons} from '../../public/workbench/source-diff-alert.js';

test('共享草稿只检查本店生效的加购修改或恢复，按历史别名比较保存后的值',()=>{
 const own={sourceId:'common-alias',shopId:'intel',addonText:'旧加购'};
 const custom={...own,sourceId:'store-alias',addonText:'本店独享'};
 const edit=edits=>editsShopAddons({row:own,managed:{id:'fixture',edits}},'intel');
 assert.equal(edit({shared:{values:{name:'新名称'}}}),false);
 assert.equal(edit({gigabyte:{values:{addon:{addonText:'外店升级'}}}}),false);
 assert.equal(edit({intel:{restore:['addon']}}),true);
 assert.equal(edit({shared:{values:{addon:{}}}}),true);
 const after=[{...own,addonText:'新加购'},custom,{...own,sourceId:'hidden',deletedAt:'today'}];
 assert.deepEqual(changedAddonSources([own,custom],after),[after[0]]);
});

test('单店清空加购触发决策检查，只改名称、外店加购和新增无加购不触发',()=>{
 const before={sourceId:'fixture',shopId:'intel',name:'配件',addonChoices:[{label:'原升级'}]};
 const edit=row=>editsShopAddons({before,row},'intel');
 assert.equal(edit({...before,addonChoices:[]}),true);
 assert.equal(edit({...before,name:'新名称'}),false);
 assert.equal(edit({...before,shopId:'gigabyte',addonChoices:[]}),false);
 assert.equal(editsShopAddons({before:null,row:{name:'新增配件',shopId:'intel'}},'intel'),false);
});
