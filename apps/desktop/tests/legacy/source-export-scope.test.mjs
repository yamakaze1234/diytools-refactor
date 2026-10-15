import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceExportEntries,applySourceSync} from '../../public/workbench/source-sync-data.js';

test('source export includes only active configurations of affected links and keeps ordinal filenames',()=>{
 const rows=['a','b','c','d','e'].map((id,i)=>({id,shopId:i===4?'jonsbo':'intel',productId:i===2?'other':'link',product:'同名链接',name:'配置'+(i+1),theme:'dark',...(i===3?{deletedAt:'deleted'}:{})}));
 const before=structuredClone(rows),changes=[{id:'b',before:rows[1]}];
 const all=sourceExportEntries(rows,changes,'intel','all'),changed=sourceExportEntries(rows,changes,'intel','changed');
 assert.deepEqual(all.map(e=>e.config.id),['a','a','b','b']);assert.deepEqual(changed.map(e=>e.config.id),['b','b']);assert.ok(changed.every(e=>e.name.endsWith('/2_配置2.png')));assert.deepEqual(rows,before);
});
test('source restore removes fields introduced by that update and rejects stale targets atomically',()=>{
 const configs=[{id:'a',shopId:'intel',parts:[],taxUpdatedAt:'new'},{id:'b',shopId:'intel',parts:[],taxUpdatedAt:'new'}];
 const changes=configs.map(c=>({id:c.id,before:structuredClone(c),after:{id:c.id,shopId:c.shopId,parts:[]}})),plan={shopId:'intel',sources:[],changes};
 configs[1].name='later';assert.throws(()=>applySourceSync(plan,configs,[]),/配置已变化/);assert.equal(configs[0].taxUpdatedAt,'new');delete configs[1].name;applySourceSync(plan,configs,[]);assert.ok(configs.every(c=>!Object.hasOwn(c,'taxUpdatedAt')));
});
