import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeSourceFollow,markSourceFieldManual,followSourceChanges,sourceFollowPlan} from '../../public/workbench/source-follow.js';
import {applySourceSync} from '../../public/workbench/source-sync-data.js';

const row=(name='A',upgrade='old',shopId='intel')=>({sourceId:'s',goodsId:'1',shopId,name,upgrade,tax:10});
const config=(name='A',upgrade='old',shopId='intel')=>({id:'c',productId:'p',product:'Product',name:'Config',shopId,parts:[{sourceId:'s',goodsId:'1',slot:'CPU',name,upgrade,tax:10}],actualParts:[{name:'cost'}],addons:[{text:'manual addon'}]});

test('source changes automatically follow both fields while preserving actual parts and addons',()=>{
 const c=config(),before=structuredClone(c);initializeSourceFollow([c],[row()]);
 const result=followSourceChanges([c],[row()],[row('B','new')]);
 assert.deepEqual(result,{configIds:['c'],count:2});assert.equal(c.parts[0].name,'B');assert.equal(c.parts[0].upgrade,'new');
 assert.deepEqual(c.actualParts,before.actualParts);assert.deepEqual(c.addons,before.addons);
});
test('manual edits and manual clearing are protected; source model still aligns',()=>{
 const c=config();initializeSourceFollow([c],[row()]);
 c.parts[0].displayName='Custom';markSourceFieldManual(c.parts[0],'name');
 c.parts[0].upgrade='';markSourceFieldManual(c.parts[0],'upgrade');
 assert.equal(followSourceChanges([c],[row()],[row('B','new')]).count,0);
 assert.equal(c.parts[0].name,'B');assert.equal(c.parts[0].displayName,'Custom');assert.equal(c.parts[0].upgrade,'');
 assert.equal(sourceFollowPlan([c],[row('B','new')],['name','upgrade'],'intel').changes[0].details.length,2);
});
test('unknown legacy differences including blank upgrade are manual; equal legacy fields follow',()=>{
 const c=config('Legacy','');initializeSourceFollow([c],[row()]);
 assert.equal(c.parts[0].sourceFollow.name.mode,'manual');assert.equal(c.parts[0].sourceFollow.upgrade.mode,'manual');
 const same=config();initializeSourceFollow([same],[row()]);assert.equal(same.parts[0].sourceFollow.name.mode,'follow');
 followSourceChanges([c],[row()],[row('B','new')]);assert.equal(c.parts[0].displayName,'Legacy');assert.equal(c.parts[0].upgrade,'');
});
test('edits bypassing explicit marker are detected and preserve cleared text',()=>{
 const c=config();initializeSourceFollow([c],[row()]);c.parts[0].upgrade='';
 followSourceChanges([c],[row()],[row('B','new')]);assert.equal(c.parts[0].upgrade,'');assert.equal(c.parts[0].sourceFollow.upgrade.mode,'manual');
});
test('confirmation restores following and plan does not mutate input',()=>{
 const c=config('Custom',''),rows=[row()],snapshot=structuredClone(c),sourceSnapshot=structuredClone(rows);
 const plan=sourceFollowPlan([c],rows,['name','upgrade'],'intel');assert.deepEqual(c,snapshot);assert.deepEqual(rows,sourceSnapshot);
 applySourceSync(plan,[c],rows);assert.equal(c.parts[0].name,'A');assert.equal(c.parts[0].upgrade,'old');assert.equal(c.parts[0].displayName,undefined);
 followSourceChanges([c],rows,[row('B','new')]);assert.equal(c.parts[0].name,'B');assert.equal(c.parts[0].upgrade,'new');
});
test('ignore suppresses only current source value and future source changes reappear',()=>{
 const c=config('Custom','');let rows=[row()];const plan=sourceFollowPlan([c],rows,['name','upgrade'],'intel',{action:'ignore'});
 applySourceSync(plan,[c],rows);assert.equal(c.parts[0].name,'Custom');assert.equal(c.parts[0].upgrade,'');assert.equal(sourceFollowPlan([c],rows,['name','upgrade'],'intel').changes.length,0);
 const next=[row('B','new')];followSourceChanges([c],rows,next);assert.equal(sourceFollowPlan([c],next,['name','upgrade'],'intel').changes[0].details.length,2);
 followSourceChanges([c],next,rows);assert.equal(sourceFollowPlan([c],rows,['name','upgrade'],'intel').changes[0].details.length,2);
});
test('shop, deleted and goods matching isolate plans; duplicate slots have distinct selection keys',()=>{
 const c=config('Custom','');c.parts.push({...c.parts[0]});const foreign=config('Other','','jonsbo'),deleted={...config('Gone',''),id:'deleted',deletedAt:'now'},mismatch={...config('Mismatch',''),id:'mismatch'};mismatch.parts[0].goodsId='2';
 const plan=sourceFollowPlan([c,foreign,deleted,mismatch],[row()],['name'],'intel');assert.equal(plan.changes.length,1);assert.equal(new Set(plan.changes[0].details.map(d=>d.key)).size,2);
 const single=sourceFollowPlan([c],[row()],['name'],'intel',{keys:[plan.changes[0].details[1].key]});assert.equal(single.changes[0].after.parts[0].name,'Custom');assert.equal(single.changes[0].after.parts[1].name,'A');
 assert.equal(sourceFollowPlan([c],[{...row(),deletedAt:'now'}],['name'],'intel').changes.length,0);
});
test('explicit new follow state accepts empty upgrade and tax remains confirm-only',()=>{
 const c=config('A','');c.parts[0].sourceFollow={sourceId:'s',name:{mode:'follow',value:'A',sourceValue:'A'},upgrade:{mode:'follow',value:'',sourceValue:'old'}};
 followSourceChanges([c],[row()],[{...row('B','new'),tax:20}]);assert.equal(c.parts[0].upgrade,'new');assert.equal(c.parts[0].tax,10);
 const plan=sourceFollowPlan([c],[{...row('B','new'),tax:20}],['tax'],'intel');assert.equal(plan.changes[0].after.parts[0].tax,20);
});
test('special source without goodsId follows and unchanged source does not overwrite manual values',()=>{
 const c=config();delete c.parts[0].goodsId;const old={...row(),goodsId:'',specialComponent:true},next={...old,name:'B'};
 initializeSourceFollow([c],[old]);followSourceChanges([c],[old],[next]);assert.equal(c.parts[0].name,'B');
 c.parts[0].upgrade='mine';markSourceFieldManual(c.parts[0],'upgrade');followSourceChanges([c],[next],[next]);assert.equal(c.parts[0].upgrade,'mine');
});
test('full three-shop catalogs only touch references to changed display source content',()=>{
 const shops=['intel','jonsbo','gigabyte'];
 const rows=shops.map(shop=>({...row('A','old',shop),sourceId:`s-${shop}`}));
 const configs=shops.map(shop=>{const c=config('A','old',shop);c.id=`c-${shop}`;c.parts[0].sourceId=`s-${shop}`;return c;});
 // Include an unaligned legacy model to catch accidental alignment in another shop.
 configs[1].parts[0].name='legacy';
 const snapshot=structuredClone(configs),next=structuredClone(rows);next[0].name='B';
 const result=followSourceChanges(configs,rows,next);
 assert.deepEqual(result,{configIds:['c-intel'],count:1});
 assert.deepEqual(configs.slice(1),snapshot.slice(1));assert.equal(configs[0].parts[0].name,'B');
 const taxOnly=structuredClone(rows);taxOnly.forEach(r=>r.tax=20);
 const untouched=structuredClone(snapshot);
 assert.deepEqual(followSourceChanges(untouched,rows,taxOnly),{configIds:[],count:0});
 assert.deepEqual(untouched,snapshot);assert.equal(untouched[0].parts[0].sourceFollow,undefined);
});
