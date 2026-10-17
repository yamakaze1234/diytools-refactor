import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceBatch} from '../public/workbench/source-batch.js';
import {sourceFollowPlan,initializeSourceFollow} from '../public/workbench/source-follow.js';
import {sourceUpgradeDescription} from '../public/workbench/source.js';
export function fixture(){
 const row={sourceId:'s',shopId:'intel',goodsId:'1',name:'技嘉显卡',erp:650,tax:650,addonText:'【+499元升级显卡】',addonChoices:[{id:'choice',goodsId:'2',qty:1,priceCents:49900,label:'升级显卡',enabled:true}]};
 const config=id=>({id,shopId:'intel',productId:'p',product:'测试链接',name:'配置'+id,parts:[{sourceId:'s',goodsId:'1',slot:'显卡',name:row.name,erp:650,tax:650,qty:1,upgrade:sourceUpgradeDescription(row)}],actualParts:[{slot:'显卡',goodsId:'1',qty:1,tax:650}],addons:[{text:'人工加购保留'}]});
 const configs=[config('auto'),config('manual')];configs[1].parts[0].upgrade='手动文案';initializeSourceFollow(configs,[row]);
 const state={sourceCatalog:[row],costSource:[{goodsId:'1',name:row.name,erp:650,tax:650},{goodsId:'2',name:'新显卡',erp:1000,tax:1000}],configs};
 const next=structuredClone(row);next.addonChoices[0].priceCents=59900;next.addonText=sourceUpgradeDescription(next);
 return {state,row,next};
}
test('saved addon price change captures automatic before/after while keeping manual confirmation and business input intact',()=>{
 const {state,row,next}=fixture(),before=structuredClone(state),result=sourceBatch(state,[{before:row,row:next}]);
 assert.deepEqual(state,before);assert.equal(result.autoUpdatedFields,1);assert.equal(result.autoChanges.length,1);
 const change=result.autoChanges[0];assert.equal(change.id,'auto');assert.equal(change.details[0].field,'upgrade');assert.match(change.details[0].before,/499元/);assert.match(change.details[0].after,/599元/);
 assert.match(result.next.configs[0].parts[0].upgrade,/599元/);assert.equal(result.next.configs[1].parts[0].upgrade,'手动文案');
 const pending=sourceFollowPlan(result.next.configs,result.next.sourceCatalog,['upgrade'],'intel');assert.deepEqual(pending.changes.map(c=>c.id),['manual']);
 for(let i=0;i<2;i++){assert.deepEqual(result.next.configs[i].actualParts,before.configs[i].actualParts);assert.deepEqual(result.next.configs[i].addons,before.configs[i].addons);}
});
test('a save without an effective description change does not invent an automatic receipt',()=>{
 const {state,row}=fixture(),result=sourceBatch(state,[{before:row,row:structuredClone(row)}]);assert.deepEqual(result.autoChanges,[]);assert.equal(result.autoUpdatedFields,0);
});
