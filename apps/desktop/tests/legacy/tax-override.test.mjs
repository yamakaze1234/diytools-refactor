// 最新共用价、数量及特殊件必须在聚合与恢复范围中保持同一口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTaxOverrides,taxDelta} from '../../public/workbench/tax-override-model.js';
import {nasErrorText} from '../../public/workbench/nas-main-workspace.js';
import {createCacheCleanupBridge} from '../../public/workbench/cache-cleanup.js';
const part=(goodsId,value,qty=1)=>({slot:'内存',goodsId,name:'配件'+goodsId,qty,tax:value,taxOverride:{goodsId,value,base:5}});
test('单独核算价按最新共用价聚合，不使用过时的 part.tax 或 override.base，排除特殊件',()=>{
 const configs=[{id:'a',name:'配置1',productId:'p1',actualParts:[part('1',130,2),{...part('2',90),specialComponent:true}]},
 {id:'b',name:'配置2',productId:'p2',actualParts:[part('1',120),part('3',90)]},{id:'c',deletedAt:'now',actualParts:[part('3',100)]}];
 const s=summarizeTaxOverrides(configs,[{goodsId:'1',tax:120,name:'新共用内存'},{goodsId:'3',tax:100}]);
 assert.equal(s.count,2);assert.equal(s.itemCount,2);assert.equal(s.partCount,2);
 assert.equal(s.byConfig.get('a')[0].base,120);assert.equal(s.byConfig.get('a')[0].delta,20);assert.equal(taxDelta(s.lines),10);
 assert.equal(s.byConfig.get('b').length,1);
});
test('NAS 批量错误兼容 message，并在可得时列出配置名称',()=>{
 for(const error of [{code:'UNSAVED_DRAFT',details:{configuration_id:'a'}},Error('UNSAVED_DRAFT')]){
  const text=nasErrorText(error,[{id:'a',name:'配置5'}]);assert.match(text,/存在未保存的本地草稿.*先保存到服务端/);assert.doesNotMatch(text,/UNSAVED_DRAFT/);
 }
 assert.match(nasErrorText({code:'UNSAVED_DRAFT',details:{configuration_ids:['a']}},[{id:'a',name:'配置5'}]),/配置5/);
});
test('缓存清理草稿检查不依赖退出脏状态；明确保存或放弃后再次核验，未知回执阻断',async()=>{
 let drafts=[{id:'a',name:'配置1'}],blocker=null,saves=0,discards=0,clears=0;
 const bridge=createCacheCleanupBridge({flush:async()=>{},inspect:async()=>({drafts,blocker}),save:async()=>{saves++;drafts=[];},discard:async rows=>{assert.deepEqual(rows,drafts);discards++;drafts=[];},clearDerived:()=>clears++,reload:()=>{}});
 await assert.rejects(bridge.prepare('check'),/未保存/);assert.equal(saves+discards,0);
 await bridge.prepare('save');assert.equal(saves,1);drafts=[{id:'a'}];blocker='存在待确认提交';
 await assert.rejects(bridge.prepare('discard'),/待确认/);assert.equal(discards,0);blocker=null;
 await bridge.prepare('discard');assert.equal(discards,1);assert.equal(clears,0);bridge.reload();assert.equal(clears,1);
});
