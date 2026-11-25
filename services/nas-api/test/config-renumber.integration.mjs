// 通过真实 HTTP 和隔离的三店 PGlite 验收归档、恢复、幂等回执和事务回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {suggestedName} from '../../../apps/desktop/public/workbench/legacy-names.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定隔离合成 SQL fixture 目录');

test('归档和恢复中间配置一次同步简称与两种海报，单次递增版本并保留无关 JSONB',async()=>{
 const errors=[],api=await startSourceAcceptance({fixture,root:join(tmpdir(),'nas-renumber-'+randomUUID()),
  authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace}),verifyError:error=>errors.push(error.message)});
 async function call(shop,path,body,status=200){
  const response=await fetch(api.url+'/api/v1/operations/'+path+'?shop_id='+shop,{
   method:body?'POST':'GET',headers:{'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'},
   body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify({result,errors}));return result.data;
 }
 try{
  for(const shop of ['intel','gigabyte','jonsbo']){
   const detail=id=>call(shop,'configurations/'+id),readBatch=body=>call(shop,'workspace/configurations',body);
   const seed=await detail((await call(shop,'workspace-index')).summaries[0].id);
   const ids=Array.from({length:4},()=>randomUUID()),product=randomUUID(),schema=shop+'_live';
   const changes=ids.map((id,index)=>{
    const label='配置'+(index+1),auto=index===2,shortName=label+(auto?'：旧自动':'：手工原文');
    const document={...structuredClone(seed.document),id,productId:product,workspaceOrder:index,skuId:'',spu:'',name:label,
     nameFormat:'compact',shortNameAuto:auto,shortName,posterSubtitle:auto?shortName:label+'—大图副标题',
     textStyles:{'header.subtitle':{text:auto?label+'丨排版':shortName,size:18},'header.other':{text:'配置5 原文不变'}},
     skuTextStyles:{'header.subtitle':{text:auto?shortName:label+' · 小图',color:'#555'}}};
    document.parts=[{...document.parts[0],slot:'CPU',name:'Intel Core i9-14900K',hardwareOverrides:{cpuName:'14900K'}}];
    return {action:'create',id,document,dependencies:seed.dependencies};
   });
   await readBatch({operation_id:randomUUID(),changes});
   // 旧数据中可能有 JS 数值无法无损往返的字段，两种样式中只允许改副标题文本。
   await api.db.query(`UPDATE ${schema}.configurations SET fields=fields||'{"opaque":9007199254740993123}'::jsonb,
    design=jsonb_set(design,'{textStyles,header.subtitle,opaque}','9007199254740993123'::jsonb) WHERE product_id=$1`,[product]);
   const first=await detail(ids[0]);
   let targetVersion='1';
   for(const [action,manualNumber,autoNumber,prior] of [['archive',3,2,'1'],['restore',4,3,'2']]){
    const oldAuto=(await detail(ids[2])).document,oldManual=(await detail(ids[3])).document;
    const body={operation_id:randomUUID(),changes:[{action,id:ids[1],expected_version:targetVersion}]};
    const receipt=await readBatch(body),next=(BigInt(prior)+1n).toString();
    assert.deepEqual(await readBatch(body),receipt);
    assert.deepEqual(await call(shop,'workspace/receipts/'+body.operation_id),receipt);
    assert.equal(receipt.changes[0].version,next);
    targetVersion=next;
    const changed=receipt.changes[0].reordered;
    assert.deepEqual(changed.map(r=>r.configuration_id),ids.slice(2));
    const [autoRow,manualRow]=changed;
    for(const row of changed){assert.equal(row.previous_version,prior);assert.equal(row.version,next);}
    const auto=await detail(ids[2]),manual=await detail(ids[3]);
    const autoName='配置'+autoNumber,manualName='配置'+manualNumber;
    const autoShort=suggestedName({...oldAuto,name:autoName},'compact');
    assert.match(autoShort,/14900K/i);
    assert.equal(auto.version,next);
    assert.equal(auto.document.name,autoName);assert.equal(auto.document.shortName,autoShort);
    assert.ok(!Object.hasOwn(auto.document,'posterSubtitle'));
    assert.equal(auto.document.textStyles['header.subtitle'].text,autoName+'丨排版');
    assert.ok(!Object.hasOwn(auto.document.skuTextStyles['header.subtitle'],'text'));
    assert.equal(auto.document.skuTextStyles['header.subtitle'].color,'#555');
    assert.equal(autoRow.before,oldAuto.name);assert.equal(autoRow.name,autoName);
    assert.deepEqual(autoRow.before_fields,{shortName:oldAuto.shortName,textSubtitle:oldAuto.textStyles['header.subtitle'].text,
     ...(action==='archive'?{posterSubtitle:oldAuto.shortName,skuTextSubtitle:oldAuto.shortName}:{})});
    assert.deepEqual(autoRow.after_fields,{shortName:autoShort,textSubtitle:autoName+'丨排版'});
    assert.equal(manual.version,next);assert.equal(manual.document.name,manualName);
    assert.equal(manual.document.shortName,manualName+'：手工原文');
    assert.equal(manual.document.posterSubtitle,manualName+'—大图副标题');
    assert.equal(manual.document.skuTextStyles['header.subtitle'].text,manualName+' · 小图');
    assert.ok(!Object.hasOwn(manual.document.textStyles['header.subtitle'],'text'));
    assert.equal(manual.document.textStyles['header.subtitle'].size,18);
    assert.equal(manual.document.textStyles['header.other'].text,'配置5 原文不变');
    assert.deepEqual(manualRow.before_fields,{shortName:oldManual.shortName,posterSubtitle:oldManual.posterSubtitle,
     skuTextSubtitle:oldManual.skuTextStyles['header.subtitle'].text,...(action==='archive'?{textSubtitle:oldManual.shortName}:{})});
    assert.deepEqual(manualRow.after_fields,{shortName:manual.document.shortName,posterSubtitle:manual.document.posterSubtitle,skuTextSubtitle:manual.document.skuTextStyles['header.subtitle'].text});
    assert.deepEqual(await detail(ids[0]),first);
    const {rows}=await api.db.query(`SELECT fields->>'opaque' AS f,design#>>'{textStyles,header.subtitle,opaque}' AS d
     FROM ${schema}.configurations WHERE product_id=$1`,[product]);
    assert.ok(rows.every(r=>r.f==='9007199254740993123'&&r.d===r.f));
   }
   // 在隔离数据中使最后一项版本溢出，确认先前的归档、自动更名和回执均随整个事务回滚。
   await api.db.query(`UPDATE ${schema}.configurations SET version=9223372036854775807 WHERE configuration_id=$1`,[ids[3]]);
   const before=await Promise.all(ids.map(detail)),failedOp=randomUUID();
   await call(shop,'workspace/configurations',{operation_id:failedOp,changes:[{id:ids[1],action:'archive',expected_version:targetVersion}]},503);
   assert.match(errors.at(-1),/bigint out of range/);
   assert.deepEqual(await Promise.all(ids.map(detail)),before);
   await call(shop,'workspace/receipts/'+failedOp,undefined,404);
  }
 }finally{await api.close();}
});
