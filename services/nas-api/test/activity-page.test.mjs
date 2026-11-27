// 使用已安装的隔离 PostgreSQL 内核核对真实 SQL、角色授权与跨 200 条的完整分页。
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const sql=name=>readFile(new URL('../sql/'+name,import.meta.url),'utf8');
const migration=await sql('009-operations-activity-page.sql');
const migration034=await sql('034-activity-filter-and-cleanup.sql');
const call=(db,args=[null,null,0,30])=>db.query('SELECT intel_live.operations_activity_page($1::date,$2::date,$3::integer,$4::integer) data',args).then(result=>result.rows[0].data);
const bind=(db,workspace,actor)=>db.query("SELECT set_config('intel_live.catalog_workspace',$1,false),set_config('intel_live.catalog_uid',$2,false)",[workspace,actor]);
const trial='diy_workbench_trial',formal='diy_workbench',trialRole='diy_api_operations',formalRole='diy_api_intel_production';

async function fixture(name,role){
 const root=new PGlite();
 await root.exec('CREATE DATABASE '+name);
 const db=new PGlite({loadDataDir:await root.dumpDataDir(),database:name});
 await root.close();
 const prepare=text=>name===trial?text:text.replaceAll(trial,formal).replaceAll(trialRole,formalRole);
 try{
  await db.exec(`CREATE SCHEMA nas_import;
   CREATE TABLE nas_import.batches(batch_id text PRIMARY KEY,manifest jsonb,payload_sha256 text,record_count integer);
   CREATE TABLE nas_import.records(batch_id text,kind text,record_id text,owner_shop text,shared boolean,document jsonb,stored_md5 text);
   INSERT INTO nas_import.batches VALUES('example','{"shop_id":"intel"}',repeat('0',64),2);
   INSERT INTO nas_import.records SELECT 'example',kind,'intel','intel',false,'{}',md5('{}') FROM unnest(ARRAY['shop','settings']) kind;
   CREATE SCHEMA nas_business;
   CREATE TABLE nas_business.members(workspace_id text,uid text,enabled boolean,PRIMARY KEY(workspace_id,uid));
   CREATE TABLE nas_business.shop_roles(workspace_id text,uid text,shop_id text,role text);
   INSERT INTO nas_business.members VALUES ('w','alice',true),('w','bob',true),('w','reader',true),('other','eve',true),('w','disabled',false);
   INSERT INTO nas_business.shop_roles VALUES ('w','alice','intel','operations'),('w','bob','intel','operations'),
    ('w','reader','intel','sales'),('other','eve','intel','operations'),('w','disabled','intel','operations');`);
  await db.exec(prepare(await sql('003-intel-live.sql')));
  await db.exec(prepare((await sql('004-runtime-operations.template.sql')).replace('__SET_RANDOM_PASSWORD__','fixture-no-network-'+name+'-test-only')));
  await db.exec(prepare(await sql('006-catalog-management.sql')));
  await db.exec(prepare(await sql('007-workspace-operations.sql')));
  const other=role===trialRole?formalRole:trialRole;
  await db.exec('CREATE ROLE '+other+'; CREATE ROLE activity_reader; GRANT USAGE ON SCHEMA intel_live TO activity_reader,'+other);
  await db.exec(migration);
  return db;
 }catch(error){await db.close();throw error;}
}

test('正式库只授予独立正式角色：同工作区跨成员、跨审计表、日期边界和完整分页',async()=>{
 const db=await fixture(formal,formalRole);
 try{
  await db.exec(`INSERT INTO intel_live.products VALUES('intel','p');
   INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,fields,design)
    VALUES('config','intel','p','合成配置','','',0,'{}','{}');
   INSERT INTO intel_live.save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result)
    VALUES('w','bob','00000000-0000-4000-8000-000000000001','intel','config',repeat('0',64),'{}');
   INSERT INTO intel_live.audit_events VALUES('w','bob','00000000-0000-4000-8000-000000000001','intel','config','replace',1,2,
    '00000000-0000-4000-8000-000000000090','2026-11-16 16:00:00+00');
   INSERT INTO intel_live.catalog_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,resource_id,request_sha256,result)
    VALUES('w','alice','00000000-0000-4000-8000-000000000002','intel','sources','source',repeat('0',64),'{}');
   INSERT INTO intel_live.catalog_audit VALUES('w','alice','00000000-0000-4000-8000-000000000002','replace',1,2,
    '00000000-0000-4000-8000-000000000090','2026-11-17 15:59:59+00');
   INSERT INTO intel_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result) VALUES
    ('w','alice','00000000-0000-4000-8000-000000000003','intel','costs',repeat('0',64),'{}'),
    ('w','bob','00000000-0000-4000-8000-000000000004','intel','costs',repeat('0',64),'{}'),
    ('other','eve','00000000-0000-4000-8000-000000000005','intel','costs',repeat('0',64),'{}');
   INSERT INTO intel_live.workspace_audit SELECT 'w','alice','00000000-0000-4000-8000-000000000003',i,'cost-'||lpad(i::text,3,'0'),
    'tax_edit',1,2,'00000000-0000-4000-8000-000000000090','2026-11-17 08:00:00+00' FROM generate_series(1,220) i;
   INSERT INTO intel_live.workspace_audit VALUES
    ('w','bob','00000000-0000-4000-8000-000000000004',1,'previous-day','tax_edit',1,2,'00000000-0000-4000-8000-000000000090','2026-11-16 15:59:59+00'),
    ('w','bob','00000000-0000-4000-8000-000000000004',2,'next-day','tax_edit',1,2,'00000000-0000-4000-8000-000000000090','2026-11-17 16:00:00+00'),
    ('other','eve','00000000-0000-4000-8000-000000000005',1,'other-workspace','tax_edit',1,2,'00000000-0000-4000-8000-000000000090','2026-11-17 08:00:00+00');`);
  await db.exec(migration);
  const signature='intel_live.operations_activity_page(date,date,integer,integer)';
  const grants=await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') granted FROM unnest(ARRAY[$1]::text[]) r",[formalRole,signature]);
  assert.equal(grants.rows[0].granted,true);
  for(const denied of [trialRole,'activity_reader']){
   await db.exec('SET ROLE '+denied);
   await assert.rejects(()=>call(db),{code:'42501'});
   await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE '+formalRole);
  assert.deepEqual(await call(db),{rows:[],total:0,page:0,pageSize:30});
  await bind(db,'w','alice');
  const day='2026-11-17',rows=[];
  for(let page=0;page<8;page++){
   const result=await call(db,[day,day,page,30]);
   assert.equal(result.page,page);assert.equal(result.pageSize,30);assert.equal(result.total,222);
   rows.push(...result.rows);
  }
  assert.equal(new Set(rows.map(r=>r.resource_id)).size,222);
  assert.equal(rows[0].resource_id,'source');assert.equal(rows[0].own_operation,true);
  assert.equal(rows[1].resource_id,'cost-001');assert.equal(rows.at(-2).resource_id,'cost-220');
  assert.equal(rows.at(-1).resource_name,'合成配置');assert.equal(rows.at(-1).own_operation,false);
  assert.equal(rows.at(-1).next_version,'2');assert.equal('actor_uid' in rows[0],false);
  const last=await call(db,[day,day,999,30]);assert.equal(last.page,7);assert.equal(last.rows.length,12);
  assert.equal((await call(db)).total,224);
  assert.equal((await db.query('SELECT count(*)::integer n FROM intel_live.operations_activity(200)')).rows[0].n,200);
  await bind(db,'w','reader');assert.equal((await call(db)).total,0);
  await bind(db,'w','disabled');assert.equal((await call(db)).total,0);
  await bind(db,'other','eve');assert.deepEqual((await call(db)).rows.map(r=>r.resource_id),['other-workspace']);
 }finally{await db.close();}
});

test('试验库独立授予试验角色，非目标数据库拒绝部署',async()=>{
 const db=await fixture(trial,trialRole);
 try{
  const result=await db.query(`SELECT has_function_privilege($1,$3,'EXECUTE') allowed,has_function_privilege($2,$3,'EXECUTE') denied`,
   [trialRole,formalRole,'intel_live.operations_activity_page(date,date,integer,integer)']);
  assert.deepEqual(result.rows,[{allowed:true,denied:false}]);
 }finally{await db.close();}
 const wrong=new PGlite();
 try{await assert.rejects(()=>wrong.exec(migration),/只允许英特尔正式库或试验库/);}finally{await wrong.close();}
});

test('034 兼容无认证表的试验库，清理按工作区与成本批次匹配并保护近期回执',async()=>{
 const db=await fixture(trial,trialRole);
 try{
  await db.exec(migration034);
  await db.exec(migration034);
  await db.exec(`INSERT INTO intel_live.sources VALUES ('s1','intel',false,'101','测试散热器','{}',1);
   INSERT INTO intel_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result,created_at) VALUES
    ('w','alice','00000000-0000-4000-8000-000000000011','intel','costs',repeat('0',64),'{}',now()-interval '2 days'),
    ('w','bob','00000000-0000-4000-8000-000000000012','intel','costs',repeat('0',64),'{}',now()),
    ('other','eve','00000000-0000-4000-8000-000000000013','intel','costs',repeat('0',64),'{}',now()-interval '31 days'),
    ('w','system:retention','00000000-0000-4000-8000-000000000014','intel','configurations',repeat('0',64),'{}',now()-interval '31 days');
   INSERT INTO intel_live.workspace_audit VALUES
    ('w','alice','00000000-0000-4000-8000-000000000011',1,'101','tax_file_skipped',1,2,gen_random_uuid(),'2026-11-16 15:59:59+00'),
    ('w','alice','00000000-0000-4000-8000-000000000011',2,'102','tax_sync',1,2,gen_random_uuid(),'2026-11-16 16:00:00+00'),
    ('w','bob','00000000-0000-4000-8000-000000000012',1,'101','global_tax',1,3,gen_random_uuid(),'2026-11-16 16:00:00+00'),
    ('other','eve','00000000-0000-4000-8000-000000000013',1,'102','tax_edit',1,2,gen_random_uuid(),now()-interval '31 days'),
    ('w','system:retention','00000000-0000-4000-8000-000000000014',1,'removed','purge',1,2,gen_random_uuid(),now()-interval '31 days');`);
  await db.exec('SET ROLE '+trialRole);
  const query=async(args=[null,null,0,30,null,null])=>(await db.query('SELECT intel_live.operations_activity_query($1,$2,$3,$4,$5,$6) data',args)).rows[0].data;
  const purge=async(dry)=>(await db.query("SELECT intel_live.purge_operations_activity('intel','2026-11-17','2026-11-17',NULL,'costs',$1) data",[dry])).rows[0].data;
  await assert.rejects(query(),{code:'42501'});
  await bind(db,'w','alice');
  const result=await query(),batch=result.rows.find(row=>row.batch),single=result.rows.find(row=>row.action==='global_tax');
  assert.equal(result.total,3);
  assert.deepEqual(result.operators,[{uid:'alice',name:'alice',own:true},{uid:'bob',name:'bob',own:false},
   {uid:'system:retention',name:'系统定时清理',own:false}]);
  assert.deepEqual([batch.item_count,batch.updated_count,batch.skipped_count,batch.action],[2,1,1,'tax_sync']);
  assert.deepEqual(batch.samples,[{id:'102',name:null},{id:'101',name:'测试散热器'}]);
  assert.deepEqual([single.resource_id,single.resource_name,single.object_exists],['101','测试散热器',true]);
  assert.equal(result.rows.find(row=>row.action==='purge').object_exists,false);
  assert.equal((await query(['2026-11-17','2026-11-17',0,30,'alice','costs'])).total,1);
  assert.equal((await query(['2026-11-16','2026-11-16',0,30,'alice','costs'])).total,0);
  assert.equal((await query([null,null,0,30,'eve',null])).total,0);
  assert.equal((await call(db)).total,4);
  assert.ok((await call(db)).rows.every(row=>!('actor_uid' in row)));
  await assert.rejects(db.query("SELECT intel_live.purge_operations_activity('jonsbo')"),{code:'42501'});
  await assert.rejects(db.query('DELETE FROM intel_live.workspace_audit'),{code:'42501'});
  assert.deepEqual(await purge(true),{audit_count:3,batch_count:2,receipt_count:1});
  assert.equal((await query()).total,3);
  assert.deepEqual(await purge(false),{audit_count:3,batch_count:2,receipt_count:1});
  assert.deepEqual((await db.query("SELECT intel_live.purge_expired_activity('intel') data")).rows[0].data,{purged_audits:1,purged_receipts:1});
  assert.equal((await query()).total,0);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT actor_uid FROM intel_live.workspace_receipts ORDER BY actor_uid')).rows,[{actor_uid:'bob'},{actor_uid:'eve'}]);
  assert.equal((await db.query('SELECT name FROM intel_live.sources')).rows[0].name,'测试散热器');
 }finally{await db.close();}
});
