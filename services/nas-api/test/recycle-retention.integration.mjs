// 仅接受现有合成验收 SQL；各测试在进程内 PGlite 实例执行，不读取连接配置。
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace} from '../tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成验收 SQL fixture 目录');
const shops=['intel','gigabyte','jonsbo'];
const migration=await readFile(new URL('../sql/032-recycle-retention.sql',import.meta.url),'utf8');

test('三店回收站权限、引用与孤儿别名保护、期限及审计完整性',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'cost-sync-uploads')});
 const db=api.db,query=(sql,args)=>db.query(sql,args);
 async function asRole(shop,sql,args=[],operator=true){
  await db.exec('BEGIN; SET LOCAL ROLE diy_api_'+shop+'_production');
  try{
   if(operator)await query(`SELECT set_config('${shop}_live.catalog_workspace',$1,true),set_config('${shop}_live.catalog_uid',$2,true)`,[fixtureWorkspace,fixtureActor]);
   const {rows}=await query(sql,args);await db.exec('COMMIT');return rows;
  }catch(error){await db.exec('ROLLBACK');throw error;}
 }
 const source=(shop,id,date,shared=false)=>query(`INSERT INTO ${shop}_live.sources(source_id,owner_shop,shared,goodsid,name,attrs)
  VALUES($1,$2,$3,'8990001',$1,$4)`,[id,shared?'shared':shop,shared,JSON.stringify(date?{deletedAt:date}:{})]);
 const config=(shop,id,days)=>query(`INSERT INTO ${shop}_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,fields,design,archived_at)
  SELECT $1,shop_id,product_id,$1,'','',1,'{}','{}',now()-make_interval(days=>$2) FROM ${shop}_live.configurations WHERE configuration_id='fixture-overlap'`,[id,days]);
 const purgeSource=(shop,id,version=1)=>asRole(shop,`SELECT ${shop}_live.purge_deleted_source($1,$2,$3)`,[shop,id,version]);
 const purgeConfig=(shop,id,version=1)=>asRole(shop,`SELECT ${shop}_live.purge_archived_configuration($1,$2,$3)`,[shop,id,version]);
 const count=async(table,key,value)=>(await query(`SELECT count(*)::int n FROM ${table} WHERE ${key}=$1`,[value])).rows[0].n;
 const old='2020-01-01T00:00:00Z',young=new Date().toISOString();
 try{
  await db.exec(migration);
  await db.exec(migration);
  for(const shop of shops){
   const ns=shop+'_live';
   const [grants]=await asRole(shop,`SELECT has_table_privilege(current_user,'${ns}.configurations','DELETE') configs,
    has_table_privilege(current_user,'${ns}.sources','DELETE') sources,
    has_function_privilege(current_user,'${ns}.retention_delete_source(text,bigint,boolean,boolean)','EXECUTE') bypass,
    has_function_privilege(current_user,'${ns}.purge_expired_retention(text,integer,integer)','EXECUTE') sweep`);
   assert.deepEqual(grants,{configs:false,sources:false,bypass:false,sweep:true});
   const other=shops.find(s=>s!==shop);
   await assert.rejects(asRole(shop,`SELECT ${other}_live.purge_expired_retention($1)`,[other]),{code:'42501'});
   await assert.rejects(asRole(shop,`SELECT ${ns}.purge_expired_retention($1)`,[other]),{message:'FORBIDDEN'});
   await assert.rejects(asRole(shop,`SELECT ${ns}.purge_expired_retention($1,0,1)`,[shop]),{message:'INVALID_RETENTION'});
   await assert.rejects(asRole(shop,`SELECT ${ns}.purge_deleted_source($1,'missing',1)`,[shop],false),{message:'FORBIDDEN'});
  }

  // 不允许删活配置、过期版本或越店目标；实际删除只影响该配置及子表。
  await config('intel','retention-manual',1);await config('intel','retention-live',null);
  await assert.rejects(purgeConfig('intel','retention-live'),{message:'INVALID_CONFIGURATION_STATE'});
  await assert.rejects(purgeConfig('intel','retention-manual',2),{message:'VERSION_CONFLICT'});
  await assert.rejects(purgeConfig('gigabyte','retention-manual'),{message:'NOT_FOUND'});
  await db.exec(`INSERT INTO intel_live.parts VALUES('retention-manual','actual',1,'p','CPU','1','CPU',1,NULL,'{}');
   INSERT INTO intel_live.addons VALUES('retention-manual',1,'{}','[]');
   INSERT INTO intel_live.quotations(configuration_id,workbook_sha256,source,sheet,status,workbook_rows)
    VALUES('retention-manual',repeat('a',64),'test','test','unmatched','[]');
   INSERT INTO intel_live.intel_quotation_overrides(configuration_id,sku,spu,amount_cents,workbook_sha256,workbook_row,version)
    VALUES('retention-manual','1','2',100,repeat('a',64),1,1);
   INSERT INTO intel_live.publications VALUES('retention-manual',false);
   INSERT INTO intel_live.assets VALUES('retention-image',repeat('e',64),'png',1)`);
  const receipt=randomUUID();
  await query(`INSERT INTO intel_live.save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result)
   VALUES('test','tester',$1,'intel','retention-manual',repeat('e',64),'{}')`,[receipt]);
  await query(`INSERT INTO intel_live.audit_events(workspace_id,actor_uid,operation_id,shop_id,configuration_id,action,next_version,request_id)
   VALUES('test','tester',$1,'intel','retention-manual','archive',1,$1)`,[receipt]);
  await query(`INSERT INTO intel_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
   VALUES('test','tester',$1,'intel','configurations',repeat('e',64),'{}')`,[receipt]);
  await query(`INSERT INTO intel_live.workspace_audit(workspace_id,actor_uid,operation_id,position,resource_id,action,next_version,request_id)
   VALUES('test','tester',$1,1,'retention-manual','archive',1,$1)`,[receipt]);
  await purgeConfig('intel','retention-manual');
  for(const table of ['configurations','parts','addons','quotations','intel_quotation_overrides','publications'])
   assert.equal(await count('intel_live.'+table,'configuration_id','retention-manual'),0);

  // 同名字符串的备注不是引用；展示、实际和加购重复指同配置时只计一次。
  const refs='retention-bound';
  for(const [id,date] of [[refs,old],['retention-free',old],['retention-released',old],['retention-new',young],['retention-bad','2000-02-31'],
   ['retention-active',null],['retention-last-alias',old]])await source('intel',id,date);
  await source('intel','retention-shared',old,true);
  // 英特尔共享源沿用显式维护委托，定时任务不继承人工委托。
  await source('intel','retention-shared-manual',young,true);
  await query('DELETE FROM intel_live.catalog_shared_editors WHERE workspace_id=$1 AND uid=$2 AND resource_kind=$3',[fixtureWorkspace,fixtureActor,'sources']);
  await assert.rejects(purgeSource('intel','retention-shared-manual'),{message:'FORBIDDEN'});
  await query("INSERT INTO intel_live.catalog_shared_editors VALUES($1,$2,'sources')",[fixtureWorkspace,fixtureActor]);
  await purgeSource('intel','retention-shared-manual');
  await source('gigabyte','retention-free',old);
  await config('intel','retention-young-config',2);await config('intel','retention-old-config',8);
  await query(`INSERT INTO intel_live.parts VALUES('retention-live','actual',1,'p','CPU','1','CPU',1,$1,'{}'),
   ('retention-old-config','actual',1,'p','CPU','1','CPU',1,'retention-released','{}')`,[refs]);
  await query(`INSERT INTO intel_live.addons VALUES('retention-live',1,$1,$2),
   ('retention-young-config',1,'{}',$2)`,[JSON.stringify({sourceId:refs}),JSON.stringify([{source_id:refs,goodsId:'retention-free'}])]);
  await query(`INSERT INTO intel_live.templates(template_id,shop_id,name,configurations,attrs)
   VALUES('retention-template','intel','test',$1,'{}')`,[JSON.stringify([{parts:[{sourceId:refs}],note:'retention-free'}])]);
  const references=await asRole('intel','SELECT * FROM intel_live.deleted_source_references($1,$2) ORDER BY source_id',['intel',[refs,'retention-free','retention-active']]);
  assert.deepEqual(references,[{source_id:refs,configurations:2,templates:1},{source_id:'retention-free',configurations:0,templates:0}]);
  await assert.rejects(purgeSource('intel',refs),e=>{
   assert.deepEqual(JSON.parse(e.detail),{templates:1,configurations:2});return e.message==='CATALOG_IN_USE';
  });
  await assert.rejects(purgeSource('intel','retention-active'),{message:'INVALID_CATALOG_STATE'});
  await assert.rejects(purgeSource('intel','retention-free',2),{message:'VERSION_CONFLICT'});
  await query(`INSERT INTO workbench_sources.entries(id,fields) VALUES('8990007','{}'),('8990008','{}')`);
  await query(`INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id) VALUES
   ('8990007','intel','retention-free'),('8990007','gigabyte','retention-free'),('8990008','intel','retention-last-alias')`);
  await purgeSource('intel','retention-free');
  assert.equal(await count('workbench_sources.aliases','entry_id','8990007'),1);
  assert.equal(await count('workbench_sources.entries','id','8990007'),1);
  assert.equal((await query("SELECT version::int FROM workbench_sources.entries WHERE id='8990007'")).rows[0].version,2);
  assert.equal(await count('gigabyte_live.sources','source_id','retention-free'),1);
  // 删除先提交后，另一事务不能用旧选项重新建立 JSON 引用。
  await assert.rejects(query(`UPDATE intel_live.templates SET configurations='[{"parts":[{"sourceId":"retention-free"}]}]'
   WHERE template_id='retention-template'`),{message:'INVALID_DEPENDENCY'});
  await assert.rejects(query(`INSERT INTO intel_live.addons VALUES('retention-live',2,'{"sourceId":"retention-free"}','[]')`),{message:'INVALID_DEPENDENCY'});
  // 旧快照加购可能携带从未绑定过本库来源的键；整套保存仍可以带回原加购。
  await query(`INSERT INTO intel_live.addons VALUES('retention-live',2,'{"sourceId":"historical-offline-key"}','[]')`);
  await assert.rejects(asRole('intel','SELECT * FROM intel_live.retention_purged_source_keys'),{code:'42501'});
  const [summary]=await asRole('intel',"SELECT intel_live.purge_expired_retention('intel') result",[],false);
  assert.deepEqual(summary.result,{purged_configs:1,purged_sources:2,skipped_referenced_sources:1});
  assert.equal(await count('workbench_sources.entries','id','8990008'),0);
  for(const id of ['retention-active','retention-bad','retention-new',refs,'retention-shared'])
   assert.equal(await count('intel_live.sources','source_id',id),1);
  assert.equal(await count('intel_live.configurations','configuration_id','retention-old-config'),0);
  assert.equal(await count('intel_live.configurations','configuration_id','retention-young-config'),1);
  for(const table of ['audit_events','save_receipts','workspace_audit','workspace_receipts'])
   assert.equal(await count('intel_live.'+table,'operation_id',receipt),1);
  assert.equal(await count('intel_live.assets','legacy_uri','retention-image'),1);
  for(const table of ['catalog_audit','workspace_audit']){
   const {rows}=await query(`SELECT action FROM intel_live.${table} WHERE actor_uid='system:retention'`);
   assert.deepEqual(rows,Array.from({length:table==='catalog_audit'?2:1},()=>({action:'purge'})));
  }
  // 原来源确实重建时，同名标记不能挡住真实存在的配件。
  await source('intel','retention-free',null);
  await query(`INSERT INTO intel_live.addons VALUES('retention-live',3,'{"sourceId":"retention-free"}','[]')`);
  assert.equal(await count('intel_live.sources','source_id','retention-free'),1);
 }finally{await api.close();}
});
