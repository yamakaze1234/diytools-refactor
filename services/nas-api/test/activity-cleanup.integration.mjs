// 用三店正式角色和合成数据跑回环 HTTP；PGlite 仅在内存创建。
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startSourceAcceptance,fixtureWorkspace,fixtureActor,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成验收 SQL fixture 目录');
const shopIds=['intel','gigabyte','jonsbo'],peer='fixture_verified02',outside='other-workspace';
const migration=name=>readFile(new URL('../sql/'+name,import.meta.url),'utf8');

test('034 三店活动：旧库降级、成员名、禁止越界、三类审计清理和默认期限',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'activity-uploads'),
  authenticate:async header=>({workspaceId:fixtureWorkspace,uid:header?.includes('outsider')?'outsider':fixtureActor,name:'本机显示名'})});
 const {db}=api;
 const endpoint=async(shop,query={},body,token='fixture')=>{
  const route=`/api/v1/operations/workspace/activity${body?'/purge':''}?`+new URLSearchParams({shop_id:shop,...query});
  const res=await fetch(api.url+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'x-workbench-deployment':fixtureDeployment,
   ...(body&&{'content-type':'application/json'})},...(body&&{body:JSON.stringify(body)})});
  const value=await res.json();return [res.status,value.data??value.error];
 };
 const business=async shop=>{
  const tables=['configurations','costs','sources','gallery','templates','quotations','intel_cost_overrides'];
  return Promise.all(tables.map(async table=>(await db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) data FROM ${shop}_live.${table} t`)).rows[0].data));
 };
 try{
  const old=[...await endpoint('gigabyte',{page:0})];
  assert.equal(old[0],200,JSON.stringify(old));assert.equal('operators' in old[1],false);
  assert.deepEqual(await endpoint('gigabyte',{actor:peer}),[503,'NAS_ACTIVITY_NOT_INSTALLED']);
  assert.deepEqual(await endpoint('gigabyte',{}, {dry_run:true}),[503,'NAS_ACTIVITY_NOT_INSTALLED']);
  assert.equal(await api.stores.get('jonsbo').purgeExpiredActivity(fixtureWorkspace),null);
  await db.exec(await migration('019-nas-local-auth.sql'));
  for(const [uid,name] of [[fixtureActor,'当前运营'],[peer,'协作运营']]){
   await db.query(`INSERT INTO nas_auth.accounts(workspace_id,uid,username_key,member_id,display_name,password_salt,password_hash)
    VALUES($1,$2,$2,$2,$3,decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'))`,[fixtureWorkspace,uid,name]);
  }
  await db.query(`INSERT INTO nas_business.members VALUES ($1,$2,true)`,[outside,peer]);
  await db.query(`INSERT INTO nas_auth.accounts(workspace_id,uid,username_key,member_id,display_name,password_salt,password_hash)
   VALUES($1,$2,$2,$2,'其他工作区同 UID',decode(repeat('00',16),'hex'),decode(repeat('00',32),'hex'))`,[outside,peer]);
  const before=[];
  for(const shop of shopIds){
   const ns=shop+'_live';
   const config=randomUUID(),source=randomUUID(),sharedSource=randomUUID(),gallery=randomUUID(),template=randomUUID(),
    costs=randomUUID(),recent=randomUUID(),other=randomUUID(),expired=randomUUID(),kept=randomUUID();
   const hash='0'.repeat(64);
   await db.query(`INSERT INTO ${ns}.save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result,created_at)
    VALUES($1,$2,$3,$4,'fixture-overlap',$5,'{}',now()-interval '2 days')`,[fixtureWorkspace,peer,config,shop,hash]);
   await db.query(`INSERT INTO ${ns}.audit_events VALUES($1,$2,$3,$4,'fixture-overlap','replace',1,2,gen_random_uuid(),now()-interval '2 days')`,
    [fixtureWorkspace,peer,config,shop]);
   for(const [op,kind,id] of [[source,'sources','fixture-local'],[sharedSource,'shared-sources','100001'],
    [gallery,'gallery','fixture-gallery'],[template,'templates','fixture-template']]){
    await db.query(`INSERT INTO ${ns}.catalog_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,resource_id,request_sha256,result,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'{}',now()-interval '2 days')`,[fixtureWorkspace,peer,op,shop,kind,id,hash]);
    await db.query(`INSERT INTO ${ns}.catalog_audit VALUES($1,$2,$3,'replace',1,2,gen_random_uuid(),now()-interval '2 days')`,
     [fixtureWorkspace,peer,op]);
   }
   for(const [ws,uid,days,op,kind] of [
    [fixtureWorkspace,peer,2,costs,'costs'],[fixtureWorkspace,peer,0,recent,'quotations'],
    [outside,peer,31,other,'costs'],[fixtureWorkspace,'system:retention',31,expired,'configurations'],
    [fixtureWorkspace,fixtureActor,29,kept,'costs'],
   ]){
    await db.query(`INSERT INTO ${ns}.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result,created_at)
     VALUES($1,$2,$3,$4,$5,$6,'{}',now()-make_interval(days=>$7))`,[ws,uid,op,shop,kind,hash,days]);
    const rows=op===costs?[['100001','erp_sync'],['9900011','erp_sync'],['9900013','tax_file_skipped']]:
     op===recent?[['fixture-overlap','select_workbook']]:op===expired?[['expired-config','purge']]:[['100001','tax_edit']];
    for(const [i,[id,action]] of rows.entries())await db.query(
     `INSERT INTO ${ns}.workspace_audit VALUES($1,$2,$3,$4,$5,$6,1,2,gen_random_uuid(),now()-make_interval(days=>$7))`,
     [ws,uid,op,i+1,id,action,days]);
   }
   before.push(await business(shop));
  }
  const sql=await migration('034-activity-filter-and-cleanup.sql');
  await db.exec(sql);await db.exec(sql);
  for(const shop of shopIds){
   const ns=shop+'_live',role='diy_api_'+shop+'_production',different=shopIds.find(id=>id!==shop)+'_live';
   const {rows:[grants]}=await db.query(`SELECT
    has_function_privilege($1,'${ns}.operations_activity_query(date,date,integer,integer,text,text)','EXECUTE') own,
    has_function_privilege($1,'${different}.operations_activity_query(date,date,integer,integer,text,text)','EXECUTE') peer,
    has_table_privilege($1,'${ns}.audit_events','DELETE') OR has_table_privilege($1,'${ns}.catalog_receipts','DELETE') OR
    has_table_privilege($1,'${ns}.workspace_audit','DELETE') direct`,[role]);
   assert.deepEqual(grants,{own:true,peer:false,direct:false});
   const [status,data]=await endpoint(shop,{page:0});
   assert.equal(status,200);assert.equal(data.total,9);
   assert.deepEqual(data.operators,[{uid:fixtureActor,name:'当前运营',own:true},{uid:peer,name:'协作运营',own:false},
    {uid:'system:retention',name:'系统定时清理',own:false}]);
   const configRows=data.rows.filter(row=>row.resource_id==='fixture-overlap');
   assert.equal(configRows.length,2);assert.ok(configRows.every(row=>row.product_name==='测试整机'&&row.resource_name===shop+' 商品'));
   assert.deepEqual(data.rows.filter(row=>['sources','gallery','templates'].includes(row.kind)).map(row=>row.resource_name).sort(),
    [shop+' 来源','外观档案','模板'].sort());
   const [,sourceRows]=await endpoint(shop,{kind:'sources'});
   assert.equal(sourceRows.total,2);
   assert.equal(sourceRows.rows.find(row=>row.kind==='shared-sources').resource_name,shop+' 来源');
   assert.equal(data.rows.find(row=>row.action==='purge').object_exists,false);
   const [,filtered]=await endpoint(shop,{actor:peer,kind:'costs'});
   assert.equal(filtered.total,1);const [batch]=filtered.rows;
   assert.deepEqual([batch.operator,batch.action,batch.item_count,batch.updated_count,batch.skipped_count,batch.samples.length],['协作运营','erp_sync',3,2,1,3]);
  }
  for(const query of [{actor:''},{actor:' x'},{actor:'\n'},{kind:'invalid'},{from:'2026-02-30'},{to:'bad'}])
   assert.deepEqual(await endpoint('intel',query),[400,'INVALID_REQUEST']);
  assert.deepEqual(await endpoint('intel',{}, {dry_run:'false'}),[400,'INVALID_REQUEST']);
  assert.deepEqual(await endpoint('intel',{}, {dry_run:true},'outsider'),[403,'FORBIDDEN']);
  assert.deepEqual(await endpoint('intel',{}, {actor:peer,dry_run:true}),[200,{audit_count:9,batch_count:7,receipt_count:6}]);
  assert.deepEqual(await endpoint('intel',{}, {actor:peer,dry_run:false}),[200,{audit_count:9,batch_count:7,receipt_count:6}]);
  assert.equal((await endpoint('gigabyte',{page:0}))[1].total,9);
  assert.deepEqual(await api.stores.get('intel').purgeExpiredActivity(fixtureWorkspace),{purged_audits:1,purged_receipts:1});
  assert.deepEqual((await endpoint('intel',{page:0}))[1].rows.map(r=>r.action),['tax_edit']);
  const remaining=(await db.query(`SELECT workspace_id,kind FROM intel_live.workspace_receipts ORDER BY workspace_id,kind`)).rows;
  assert.deepEqual(remaining,[{workspace_id:outside,kind:'costs'},{workspace_id:fixtureWorkspace,kind:'costs'},{workspace_id:fixtureWorkspace,kind:'quotations'}]);
  for(const [i,shop] of shopIds.entries())assert.deepEqual(await business(shop),before[i]);
  api.stores.get('intel').workspaceWritable=false;
  assert.deepEqual(await endpoint('intel',{}, {dry_run:true}),[405,'WRITES_DISABLED']);
 }finally{await api.close();}
});
