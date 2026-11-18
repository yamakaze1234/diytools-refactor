// 在独立 PGlite 验证 SQL 产物。不会连接 NAS、DBX 或现用客户端。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const [fixture,realRoot,realAccess]=process.argv.slice(2);
assert.ok(fixture,'需提供由 build-production-three-fixture.py 生成的隔离目录');
assert.equal(Boolean(realRoot),Boolean(realAccess),'真实快照仅在独立 PGlite 核验，须配合合成授权路径');
const shops=['gigabyte','jonsbo'],existing='fixture_existing01',approved='fixture_verified02',
 legacy='fixture_legacy03',disabled='fixture_disabled04',cid='fixture-overlap',ws='workbench-main',
 op='30000000-0000-4000-8000-000000000001',hash='a'.repeat(64);
const read=path=>readFile(path,'utf8');
const root=shop=>realRoot?join(realRoot,shop,'sql'):join(fixture,shop);
const manifests=Object.fromEntries(await Promise.all(shops.map(async shop=>[shop,JSON.parse(await read(join(root(shop),'manifest.json')))])));
const imports=Object.fromEntries(await Promise.all(shops.map(async shop=>[shop,await read(join(root(shop),'02-'+shop+'-import.sql'))])));
const accessDir=join(realAccess||fixture,'access');
const access=await read(join(accessDir,'04-install-three-operations-private.sql'));
const intel=await read(join(fixture,'intel-fixture.sql'));

let stage='initializing';
async function prepared(defaultName='diy_workbench'){
 const pg=new PGlite();
 try{
  await pg.exec('CREATE DATABASE '+defaultName);
  return new PGlite({loadDataDir:await pg.dumpDataDir(),database:defaultName});
 }finally{await pg.close();}
}
const isDenied=err=>err?.code==='42501';
const sample=(db,sql,bindings)=>db.query(sql,bindings).then(result=>result.rows[0]);
const all=(db,sql,bindings)=>db.query(sql,bindings).then(result=>result.rows);
async function roleSession(db,shop,uid,test,workspace=ws){
 await db.exec('BEGIN; SET LOCAL ROLE diy_api_'+shop+'_production;');
 try{
  if(uid)await db.query("SELECT set_config('"+shop+"_live.catalog_workspace',$1,true),set_config('"+shop+"_live.catalog_uid',$2,true)",[workspace,uid]);
  return await test();
 }finally{await db.exec('ROLLBACK');}
}
const suffix=(sql,tag,message)=>sql.replace('END $'+tag+'$;',"RAISE EXCEPTION '"+message+"'; END $"+tag+"$;");
const intelState=db=>sample(db,"SELECT (SELECT document FROM intel_live.configuration_documents WHERE configuration_id=$1) doc,"
 +" (SELECT version::int FROM intel_live.configurations WHERE configuration_id=$1) version,"
 +" (SELECT jsonb_agg(to_jsonb(r) ORDER BY uid) FROM nas_business.shop_roles r) roles,"
 +" (SELECT jsonb_agg(to_jsonb(g) ORDER BY uid) FROM intel_live.catalog_shared_editors g) delegates,"
 +" (SELECT proowner::text FROM pg_proc WHERE oid=to_regprocedure('intel_live.catalog_is_operator()')) owner,"
 +" (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('intel_live.catalog_is_operator()')) ops_acl,"
 +" (SELECT proowner::text FROM pg_proc WHERE oid=to_regprocedure('intel_live.set_quotation_publication(text,boolean)')) publish_owner,"
 +" (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('intel_live.set_quotation_publication(text,boolean)')) publish_acl",[cid]);
const estate=(db,shop)=>sample(db,"SELECT to_regnamespace($1) IS NOT NULL AS receiving,to_regnamespace($2) IS NOT NULL AS runtime,"
 +" to_regnamespace($3) IS NOT NULL AS access,to_regrole($4) IS NOT NULL AS role",[shop+'_import',shop+'_live',shop+'_access','diy_api_'+shop+'_production']);
const rawAccess=db=>sample(db,"SELECT to_regnamespace('intel_access') IS NOT NULL AS access,"
 +" to_regclass('nas_business.operation_groups') IS NOT NULL AS groups,"
 +" (SELECT count(*)::int FROM nas_business.members) AS members");
const qualified=shop=>shop+'_live';

async function verifyWriteGuards(db,shop,other){
 const live=qualified(shop), peer=qualified(other), config=realRoot
  ?(await sample(db,"SELECT configuration_id FROM "+live+".configurations WHERE coalesce(fields->>'productCategory','')<>'主机模板'"
   +" AND coalesce(fields->>'emptyLinkDraft','false')<>'true' ORDER BY configuration_id LIMIT 1")).configuration_id
  :cid;
 await roleSession(db,shop,null,async()=>{
  await assert.rejects(db.query('SELECT * FROM '+peer+'.configuration_documents LIMIT 1'),isDenied);
 });
 await roleSession(db,shop,null,async()=>{
  await assert.rejects(db.query('SELECT * FROM '+shop+'_import.records LIMIT 1'),isDenied);
 });
 await roleSession(db,shop,null,async()=>{
  await assert.rejects(db.query("INSERT INTO "+live+".products VALUES($1,'fixture-unauth-product')",[shop]),isDenied);
 });
 await roleSession(db,shop,legacy,async()=>{
  assert.equal((await sample(db,'SELECT '+live+'.catalog_is_operator() AS ok')).ok,false);
  assert.deepEqual(await all(db,'UPDATE '+live+'.configurations SET version=version+1 WHERE configuration_id=$1 RETURNING version',[config]),[]);
  assert.equal((await sample(db,'SELECT '+live+".profit_observe('history','{}') AS x")).x.error,'FORBIDDEN');
 });
 await roleSession(db,shop,approved,async()=>{
  assert.equal((await sample(db,'SELECT '+live+'.catalog_is_operator() AS ok')).ok,false);
 },'other-workspace');
 await roleSession(db,shop,approved,async()=>{
  assert.equal((await sample(db,'SELECT '+live+'.catalog_is_operator() AS ok')).ok,true);
  await assert.rejects(db.query("INSERT INTO "+live+".products VALUES($1,'fixture-cross-shop')",[other]),isDenied);
 });
 await roleSession(db,shop,approved,async()=>{
  await assert.rejects(db.query('SELECT '+peer+".operations_activity_page(NULL,NULL,0,30)"),isDenied);
 });
 await roleSession(db,shop,approved,async()=>{
  await assert.rejects(db.query("UPDATE "+shop+"_access.shop_roles SET role='sales'"),error=>isDenied(error)||/cannot update view/.test(error.message));
 });
 await roleSession(db,shop,approved,async()=>{
  await assert.rejects(db.query("INSERT INTO nas_business.operation_group_members VALUES($1,'dou-intel-operations','unapproved01')",[ws]),isDenied);
 });
 await roleSession(db,shop,approved,async()=>{
  await assert.rejects(db.query("INSERT INTO "+live+".catalog_shared_editors VALUES($1,$2,'gallery')",[ws,approved]),isDenied);
 });
 await roleSession(db,shop,approved,async()=>{
  await assert.rejects(db.query("INSERT INTO "+live+".save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result)"+
    " VALUES($1,$2,$3,$4,$5,$6,'{}')",[ws,existing,op,shop,config,hash]),isDenied);
 });
 await roleSession(db,shop,approved,async()=>{
  // 受限账号执行正常的本店修改及真实 RLS 过滤；验证后撤回所有记录。
  const current=await sample(db,"SELECT shop_id,version::int FROM "+live+".configurations WHERE configuration_id=$1",[config]);
  assert.equal(current.shop_id,shop);
  const next=current.version+1;
  assert.equal((await sample(db,"UPDATE "+live+".configurations SET version=version+1 WHERE configuration_id=$1 RETURNING version::int",[config])).version,next);
  await db.query("INSERT INTO "+live+".save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result)"+
    " VALUES($1,$2,$3,$4,$5,$6,'{}')",[ws,approved,op,shop,config,hash]);
  await db.query("INSERT INTO "+live+".audit_events(workspace_id,actor_uid,operation_id,shop_id,configuration_id,action,previous_version,next_version,request_id)"
   +" VALUES($1,$2,$3,$4,$5,'replace',$6,$7,$3)",[ws,approved,op,shop,config,current.version,next]);
  assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.save_receipts')).n,1);
  assert.equal((await sample(db,'SELECT '+live+'.operations_activity_page(NULL,NULL,0,30) AS x')).x.rows[0].own_operation,true);
  await db.query("SELECT set_config('"+live+".catalog_uid',$1,true)",[existing]);
  assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.save_receipts')).n,0);
  assert.equal((await sample(db,'SELECT '+live+'.operations_activity_page(NULL,NULL,0,30) AS x')).x.rows[0].own_operation,false);
  assert.equal((await sample(db,'SELECT '+live+'.set_quotation_publication($1,true) AS ok',[config])).ok,false);
  assert.equal((await sample(db,'SELECT '+live+'.set_quotation_publication($1,false) AS ok',[config])).ok,true);
  await db.query("INSERT INTO "+live+".intel_cost_overrides(goodsid,document,version) VALUES('100001','{\"tax\":10}',2)");
  assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.intel_cost_overrides')).n,1);
  const foreign=await all(db,'UPDATE '+live+'.sources SET version=version+1 WHERE owner_shop<>$1 OR shared RETURNING source_id',[shop]);
  assert.deepEqual(foreign,[]);
  const item={shop_id:shop,metric:'accounting',config_id:config,config_version:String(next),fingerprint:hash,valid:true,profit_cents:'5000',snapshot:{}};
  for(const [shopId,wanted] of [[other,'INVALID_REQUEST'],[shop,null]]){
   const data={requestId:op,scopeHash:hash,results:[{...item,shop_id:shopId}]};
   const result=(await sample(db,"SELECT "+live+".profit_observe('start',$1::jsonb) AS x",[JSON.stringify(data)])).x;
   if(wanted)assert.equal(result.error,wanted);else assert.match(result.runId,/^[a-f0-9-]{36}$/);
  }
  const price={operationId:op,message:'合成成本',items:[{goodsId:'100001'}],configs:[{before:{id:config,shopId:shop},after:{id:config,shopId:shop}}]};
  await db.query("SELECT "+live+".operations_price_history('append',$1::jsonb)",[JSON.stringify(price)]);
  assert.equal((await sample(db,"SELECT "+live+".operations_price_history('list','{}') AS x")).x.batches.length,1);
 });
 await roleSession(db,shop,approved,async()=>{
  const wrong={operationId:op,message:'合成成本',items:[{goodsId:'100001'}],configs:[{before:{id:config,shopId:other},after:{id:config,shopId:other}}]};
  await assert.rejects(db.query("SELECT "+live+".operations_price_history('append',$1::jsonb)",[JSON.stringify(wrong)]),/invalid price history payload/);
 });
 assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.save_receipts')).n,0);
 assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.price_history')).n,0);
 assert.equal((await sample(db,'SELECT count(*)::int n FROM '+live+'.profit_runs')).n,0);
}

let db;
try{
 const wrong=new PGlite();
 try{
  for(const sql of [...Object.values(imports),access])await assert.rejects(wrong.query(sql),/只允许正式库/);
 }finally{await wrong.close();}
 db=await prepared();
 stage='wrong instance';
 // 无英特尔 r8151 锚位时，同名空库不能接收。
 await assert.rejects(db.query(imports.gigabyte),/英特尔正式 r8151/);
 stage='Intel baseline';
 await db.exec(intel);
 const intelBefore=await intelState(db);
 const preflight=await sample(db,await read(new URL('../sql/015-production-expansion-preflight.sql',import.meta.url)));
 assert.equal(preflight.target_database,'diy_workbench');
 assert.equal(preflight.intel_bootstrap[0].source_revision,'8151');
 assert.equal(preflight.expanded_groups,false);
 assert.equal(preflight.intel_functions.length,6);
 assert.ok(preflight.intel_functions.every(p=>p.installer_is_owner&&p.pinned_path));
 assert.ok(preflight.targets.every(p=>!p.receiving_exists&&!p.runtime_exists&&!p.access_exists&&!p.service_role_exists));
 stage='store imports';
 const storeResults={};
 for(const shop of shops){
  if(!realRoot){
   await assert.rejects(db.query(imports[shop].replace(shop+' 商品',shop+' 替换')),/传输摘要不一致/);
   await assert.rejects(db.query(suffix(imports[shop],'add_'+shop+'_snapshot','隔离导入末尾失效')),/隔离导入末尾失效/);
   assert.deepEqual(await estate(db,shop),{receiving:false,runtime:false,access:false,role:false});
  }
  await db.query(imports[shop]);
  await assert.rejects(db.query(imports[shop]),/已存在/);
  const out=await sample(db,await read(join(root(shop),'03-'+shop+'-readback.sql'))),exp=manifests[shop];
  assert.equal(out.batch_id,exp.batch_id);
  assert.equal(out.payload_sha256,exp.payload_sha256);
  assert.equal(out.record_count,exp.receiving_records_count);
  assert.deepEqual(out.actual_by_kind,exp.counts);
  assert.deepEqual(out.expected_by_kind,exp.counts);
  assert.equal(out.active,exp.counts.configuration);
  for(const key of ['receiving_changed','runtime_document_mismatch','changed_after_import','published'])assert.equal(out[key],0,key);
  assert.equal(out.archived_in_receiving,exp.counts.archived_configuration);
  assert.equal(out.matched_quotes+out.unmatched_quotes,out.active);
  storeResults[shop]=out;
 }
 stage='access refusal and rollback';
 if(!realRoot){
  // 组织尚未核对真实成员。本次测试只验证启用、缺席及已停用形状的处理。
  await assert.rejects(db.query(access.replace(approved,disabled)),/成员的现有状态发生变化/);
  await assert.rejects(db.query(suffix(access,'install_three_operations','隔离权限末尾失效')),/隔离权限末尾失效/);
  assert.deepEqual(await rawAccess(db),{access:false,groups:false,members:3});
  for(const shop of shops)assert.deepEqual(await estate(db,shop),{receiving:true,runtime:true,access:false,role:false});
  assert.deepEqual(await intelState(db),intelBefore);
 }
 stage='access installation';
 await db.query(access);
 await assert.rejects(db.query(access),/已存在|不符合已核对状态/);
 assert.deepEqual(await intelState(db),intelBefore);
 const readback=await sample(db,await read(join(accessDir,'05-operations-readback.sql')));
 assert.equal(readback.enrolled_members,2);
 assert.equal(readback.enabled_members,2);
 assert.equal(readback.assigned_shops,3);
 assert.deepEqual(readback.group_operators_by_shop,{intel:2,gigabyte:2,jonsbo:2});
 for(const row of readback.isolation){
  for(const key of ['restricted_login','own_live','own_access','effective_roles_read','effective_roles_read_only','activity','profit_history','price_history'])
   assert.equal(row[key],true,row.shop_id+':'+key);
  for(const key of ['may_change_group','may_change_members'])assert.equal(row[key],false,row.shop_id+':'+key);
  for(const key of ['other_store_schemas','receiving_schemas'])assert.equal(row[key],0,row.shop_id+':'+key);
 }
 stage='role writes';
 await verifyWriteGuards(db,'gigabyte','jonsbo');
 await verifyWriteGuards(db,'jonsbo','gigabyte');
 stage='legacy publication authority';
 await roleSession(db,'intel',approved,async()=>{
  assert.equal((await sample(db,"SELECT intel_live.set_quotation_publication($1,true) ok",[cid])).ok,false);
 });
 await roleSession(db,'intel',legacy,async()=>{
  assert.equal((await sample(db,"SELECT intel_live.set_quotation_publication($1,true) ok",[cid])).ok,true);
 });
 stage='membership lifecycle';
 let active=()=>all(db,"SELECT shop_id,role FROM nas_business.group_shop_roles WHERE workspace_id=$1 AND uid=$2 ORDER BY shop_id",[ws,existing]);
 assert.equal((await active()).length,3);
 await db.query("UPDATE nas_business.members SET enabled=false WHERE workspace_id=$1 AND uid=$2",[ws,existing]);
 assert.deepEqual(await active(),[]);
 await roleSession(db,'intel',existing,async()=>assert.equal((await sample(db,'SELECT intel_live.catalog_is_operator() ok')).ok,false));
 await db.query("UPDATE nas_business.members SET enabled=true WHERE workspace_id=$1 AND uid=$2",[ws,existing]);
 await db.query("DELETE FROM nas_business.operation_group_members WHERE workspace_id=$1 AND uid=$2",[ws,existing]);
 assert.deepEqual(await active(),[]);
 assert.equal((await sample(db,'SELECT role FROM intel_access.shop_roles WHERE workspace_id=$1 AND uid=$2',[ws,existing])).role,'sales');
 await roleSession(db,'intel',legacy,async()=>assert.equal((await sample(db,"SELECT intel_live.catalog_can_write('shared',true,'gallery') ok")).ok,true));
 assert.deepEqual(await intelState(db),intelBefore);
 console.log(JSON.stringify({status:'passed',fixture:realRoot?'frozen_exports':'synthetic_collision',
  official_database_contacted:false,wrongDatabaseDenied:true,wrongInstanceDenied:true,appendOnlyReapplyDenied:true,
  transportTamperAndAtomicRollbacks:realRoot?null:true,immutableIntelOwnerAclLegacyRolesAndDelegation:true,
  authenticatedRoleWritesAndCrossStoreDenials:true,disabledAndRevokedMembersDenied:true,legacyDirectOnlyIntelPublication:true,stores:storeResults,access:readback},null,2));
}catch(error){
 console.error(JSON.stringify({status:'failed',stage,code:error.code||null,message:error.message.slice(0,340)}));
 process.exitCode=1;
}finally{if(db)await db.close();}
