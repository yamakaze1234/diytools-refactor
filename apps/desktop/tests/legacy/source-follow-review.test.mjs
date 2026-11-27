import test from 'node:test';
import assert from 'node:assert/strict';
import {followPendingSourcePlan,initializeSourceFollow,sourceFollowPlan,sourceFollowSummary,IGNORED_RETENTION_MS} from '../../public/workbench/source-follow.js';
import {applySourceSync,sourceExportEntries,SourceChangeSession} from '../../public/workbench/source-sync-data.js';
import {sourceBatch} from '../../public/workbench/source-batch.js';
import {withCurrentSharedSource} from '../../public/workbench/shared-source-fields.js';

const now=Date.parse('2026-11-26T10:00:00Z');
const source={shopId:'intel',sourceId:'s',goodsId:'123',name:'配件',tax:10,addonText:'旧文案'};
const changed={...source,name:'新配件',addonText:'新文案',updatedAt:new Date(now).toISOString()};
const config=(id,upgrade=source.addonText)=>({id,shopId:'intel',productId:'link',name:id,actualParts:[],addons:[],
 parts:[{sourceId:'s',goodsId:'123',name:source.name,slot:'硬盘',upgrade,tax:10}]});
const review=(configs,row,options)=>sourceFollowPlan(configs,[row],['upgrade'],'intel',{now,...options});

test('来源保存先按变动前的旧值识别历史配置，只延后加购，不影响自动改名',()=>{
 const before={configs:[config('a'),config('b','手工')],sourceCatalog:[source],costSource:[]};
 const {next}=sourceBatch(before,[{before:source,row:changed}],changed.updatedAt,{deferUpgrade:true});
 assert.deepEqual(next.configs.map(c=>c.parts[0].upgrade),['旧文案','手工']);
 assert.deepEqual(next.configs.map(c=>c.parts[0].name),['新配件','新配件']);
 assert.equal(next.sourceCatalog[0].updatedAt,changed.updatedAt);
 const plan=review(next.configs,changed);
 assert.deepEqual(plan.changes.map(c=>c.details[0].kind),['follow','manual']);
 assert.ok(plan.changes.every(c=>c.details[0].changedAt===changed.updatedAt&&c.details[0].sourceName==='新配件'));
 assert.equal(review(next.configs,{...changed,updatedAt:undefined}).changes[0].details[0].changedAt,null);
});

test('重新载入 NAS 共用输出源保留图片原文及跟随模式',()=>{
 const c=config('a');initializeSourceFollow([c],[source]);
 withCurrentSharedSource(c,new Map([['s',{...changed,sharedSourceId:'123'}]]),{deferText:true});
 assert.equal(c.parts[0].name,source.name);assert.equal(c.parts[0].upgrade,'旧文案');
 const details=sourceFollowPlan([c],[changed],['name','upgrade'],'intel').changes[0].details;
 assert.deepEqual(details.map(d=>d.kind),['follow','follow']);
});

test('跟随和人工都能忽略或恢复，七天到期仍静默，换新值重新提醒',()=>{
 const configs=[config('a'),config('b','人工稿')];
 initializeSourceFollow(configs,[source]);
 const ignore=review(configs,changed,{action:'ignore'});
 applySourceSync(ignore,configs,[changed]);
 assert.deepEqual(configs.map(c=>c.parts[0].upgrade),['旧文案','人工稿']);
 for(const [i,c] of configs.entries()){
  const record=c.parts[0].sourceFollow.upgrade;
  assert.equal(record.mode,i?'manual':'follow');assert.equal(record.ignoredSourceValue,'新文案');
  assert.equal(record.ignoredAt,new Date(now).toISOString());
 }
 assert.equal(review(configs,changed).changes.length,0);
 for(const [offset,days] of [[0,7],[86400001,6],[IGNORED_RETENTION_MS-1,1]]){
  const history=review(configs,changed,{includeIgnored:true,now:now+offset});
  assert.ok(history.changes.every(c=>c.details[0].ignored&&c.details[0].daysLeft===days));
  assert.equal(history.changes.length,2);
 }
 assert.equal(review(configs,changed,{includeIgnored:true,now:now+IGNORED_RETENTION_MS}).changes.length,0);
 assert.equal(review(configs,changed,{now:now+IGNORED_RETENTION_MS}).changes.length,0);
 const legacy=structuredClone(configs);delete legacy[0].parts[0].sourceFollow.upgrade.ignoredAt;
 assert.equal(review(legacy,changed,{includeIgnored:true}).changes.length,1);
 const key=ignore.changes[1].details[0].key;
 applySourceSync(review(configs,changed,{keys:[key],action:'unignore'}),configs,[changed]);
 assert.equal(review(configs,changed).changes[0].id,'b');
 assert.equal(configs[1].parts[0].sourceFollow.upgrade.mode,'manual');
 assert.ok(!Object.hasOwn(configs[1].parts[0].sourceFollow.upgrade,'ignoredAt'));
 const newest={...changed,addonText:'又有改动'};
 initializeSourceFollow(configs,[newest]);
 for(const c of configs){
  assert.ok(!Object.hasOwn(c.parts[0].sourceFollow.upgrade,'ignoredSourceValue'));
  assert.ok(!Object.hasOwn(c.parts[0].sourceFollow.upgrade,'ignoredAt'));
 }
 assert.equal(review(configs,newest).changes.length,2);
});

test('保存后计划按店和来源去重计数，混合配置只写跟随行',()=>{
 const both=config('a');both.parts.push({...both.parts[0],upgrade:'人工稿'});
 const second=config('b'); const ignored=config('ignored');
 const foreign={...config('foreign'),shopId:'jonsbo'},otherSource=config('other');
 otherSource.parts[0].sourceId='other';
 const configs=[both,second,ignored,foreign,otherSource];
 initializeSourceFollow(configs,[source]);
 applySourceSync(review([ignored],changed,{action:'ignore'}),[ignored],[changed]);
 const before=structuredClone(configs),rows=[changed,{...changed,sourceId:'other'}];
 const plan=followPendingSourcePlan(configs,rows,'intel',{fieldsBySource:new Map([['s',['upgrade']]])});
 assert.deepEqual(configs,before);
 assert.deepEqual([plan.followConfigCount,plan.followLinkCount,plan.manualConfigCount,plan.manualLinkCount],[2,1,1,1]);
 assert.deepEqual(plan.changes.map(c=>c.id),['a','b']);
 assert.ok(plan.changes.every(c=>c.details.every(d=>d.kind==='follow'&&!d.ignored)));
 applySourceSync(plan,configs,rows);
 assert.deepEqual(both.parts[1],before[0].parts[1]);assert.deepEqual(configs.slice(2),before.slice(2));
 assert.equal(both.parts[0].upgrade,'新文案');
 assert.equal(followPendingSourcePlan(configs,rows,'intel',{fieldsBySource:new Map()}).changes.length,0);
});

test('纯图片导出按图型过滤，不采用差异或改变原配置',()=>{
 const c=config('a'),before=structuredClone(c);
 const entries=sourceExportEntries([c],[{id:'a',before:c}],'intel','changed',null,['square']);
 assert.deepEqual(entries.map(e=>e.config.layout),['square']);
 assert.equal(entries[0].config.parts[0].upgrade,'旧文案');assert.deepEqual(c,before);
});

test('维护角标与待确认明细同口径，取最近的有效来源变动时间',()=>{
 const a=config('a'),b=config('b');
 b.parts[0].sourceId='b';
 const second={...changed,sourceId:'b',updatedAt:'2026-11-26T11:00:00Z'};
 const rows=[changed,second],configs=[a,b];
 const summary=()=>sourceFollowSummary(configs,rows,'intel',{fields:['upgrade'],now});
 assert.deepEqual(summary(),{count:2,latestChangedAt:second.updatedAt});
 applySourceSync(review([b],second,{action:'ignore'}),configs,rows);
 assert.deepEqual(summary(),{count:1,latestChangedAt:changed.updatedAt});
 applySourceSync(review([a],changed),configs,rows);
 assert.deepEqual(summary(),{count:0,latestChangedAt:null});
 applySourceSync(review([b],second,{action:'unignore'}),configs,rows);
 assert.deepEqual(summary(),{count:1,latestChangedAt:second.updatedAt});
});

test('纯核算价差异不进文案提醒，显式核对时可以采用、不能忽略',()=>{
 const c=config('a'),row={...source,tax:15,updatedAt:changed.updatedAt};
 assert.deepEqual(sourceFollowSummary([c],[row],'intel'),{count:0,latestChangedAt:null});
 const tax=options=>sourceFollowPlan([c],[row],['tax'],'intel',options);
 assert.equal(tax({action:'ignore'}).changes.length,0);
 assert.deepEqual(tax().changes[0].details.map(d=>[d.field,d.before,d.after]),[['tax',10,15]]);
 applySourceSync(tax(),[c],[row]);
 assert.equal(c.parts[0].tax,15);assert.equal(tax().changes.length,0);
});

test('本次变动按本店配置累计，重复保存去重计数并保留补导范围',()=>{
 const a=config('a'),b=config('b'),foreign={...config('foreign'),shopId:'jonsbo'};
 const session=new SourceChangeSession('intel');
 const record=(c,oldText,newText)=>({id:c.id,name:c.name,product:c.product,before:c,
  details:[{slot:'硬盘',field:'upgrade',partIndex:0,before:oldText,after:newText}]});
 const first=record(a,'旧','改一');
 session.record([first,record(foreign,'外店旧','外店新')]);
 session.record();
 session.record([record(a,'改一','改二'),record(b,'旧','新')]);
 assert.equal(session.count,2);
 assert.deepEqual(session.records.map(c=>[c.id,c.details.map(d=>d.after)]),[['a',['改一','改二']],['b',['新']]]);
 assert.equal(first.details.length,1);
 const entries=sourceExportEntries([a,b,foreign],session.records,'intel');
 assert.deepEqual(entries.map(e=>[e.config.id,e.config.layout]),[['a','long'],['a','square'],['b','long'],['b','square']]);
 assert.equal(new SourceChangeSession('intel').count,0);
});

test('刚保存的名称使用旧有效名称识别跟随，混合计划保护人工字段与其他来源差异',()=>{
 const follow=config('follow'),custom=config('custom'),other=config('other');
 custom.parts[0].displayName='独享展示名';
 other.parts[0].sourceId='other';
 initializeSourceFollow([custom],[source]);
 const next={...changed,name:'新名称'},otherRow={...next,sourceId:'other'};
 const rows=[next,otherRow],configs=[follow,custom,other];
 const plan=followPendingSourcePlan(configs,rows,'intel',{
  fieldsBySource:new Map([['s',['name']],['other',['upgrade']]]),previousRows:[source,{...source,sourceId:'other'}],
 });
 assert.deepEqual(plan.fields,['name','upgrade']);
 assert.deepEqual(plan.changes.map(({id,details})=>[id,details.map(detail=>detail.field)]),[['follow',['name']],['other',['upgrade']]]);
 assert.equal(plan.manualConfigCount,1);
 applySourceSync(plan,configs,rows);
 assert.equal(follow.parts[0].name,'新名称');
 assert.equal(follow.parts[0].upgrade,source.addonText);
 assert.equal(custom.parts[0].displayName,'独享展示名');
 assert.equal(other.parts[0].name,source.name);
});
