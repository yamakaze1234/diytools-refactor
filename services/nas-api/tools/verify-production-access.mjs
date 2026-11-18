// 验证正式的实际候选：独立 PostgreSQL、无部署/真实数据库操作、无凭据输出。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const [dataFile,accessFile,actorFile]=process.argv.slice(2);
const [data,install,uid]=await Promise.all([dataFile,accessFile,actorFile].map(path=>readFile(path,'utf8')));
const base=new PGlite();let image;
try{
 await assert.rejects(base.query(install),/只允许正式库/);
 await base.exec('CREATE DATABASE diy_workbench');
 await base.exec('CREATE ROLE diy_api_operations LOGIN');
 image=await base.dumpDataDir();
}catch{throw Error('隔离正式角色验证的初始环境失败');}
finally{await base.close();}
const db=new PGlite({loadDataDir:image,database:'diy_workbench'});
try{
 await db.query(data);
 const broken=install.replace('END $production_access$;',"RAISE EXCEPTION '隔离尾部回滚'; END $production_access$;");
 await assert.rejects(db.query(broken),/隔离尾部回滚/);
 const state=()=>db.query(`SELECT to_regnamespace('nas_business') IS NOT NULL AS schema_exists,
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_intel_production') AS role_exists`);
 assert.deepEqual((await state()).rows[0],{schema_exists:false,role_exists:false});
 await db.query(install);
 await assert.rejects(db.query(install),/已经存在/);
 const guards=(await db.query(`SELECT
   (SELECT count(*)::int FROM nas_business.members) AS members,
   (SELECT count(*)::int FROM nas_business.shop_roles WHERE workspace_id='workbench-main' AND uid=$1 AND shop_id='intel' AND role='operations') AS bound_members,
   (SELECT count(*)::int FROM intel_live.catalog_shared_editors) AS shared_delegates,
   (SELECT count(*)::int FROM intel_live.publications WHERE published) AS published,
   (SELECT count(*)::int FROM intel_live.intel_cost_overrides) AS cost_overrides,
   has_schema_privilege('diy_api_operations','intel_live','USAGE') AS trial_schema,
   has_schema_privilege('diy_api_intel_production','nas_import','USAGE') AS receipt_schema,
   has_table_privilege('diy_api_intel_production','nas_business.members','UPDATE') AS may_edit_members,
   (SELECT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    FROM pg_roles WHERE rolname='diy_api_intel_production') AS restricted_login`,[uid.trim()])).rows[0];
 assert.deepEqual(guards,{members:1,bound_members:1,shared_delegates:0,published:0,cost_overrides:0,trial_schema:false,receipt_schema:false,may_edit_members:false,restricted_login:true});
 await db.exec('BEGIN; SET LOCAL ROLE diy_api_intel_production;');
 try{
  assert.equal((await db.query('SELECT count(*)::int AS n FROM intel_live.shops')).rows[0].n,1);
  await db.query(`SELECT set_config('intel_live.catalog_workspace','workbench-main',true),set_config('intel_live.catalog_uid',$1,true)`,[uid.trim()]);
  assert.equal((await db.query('SELECT intel_live.catalog_is_operator() AS allowed')).rows[0].allowed,true);
  const cost=(await db.query('SELECT min(goodsid) AS goodsid FROM intel_live.costs')).rows[0].goodsid;
  await db.query(`INSERT INTO intel_live.intel_cost_overrides(goodsid,document,version) VALUES($1,'{"erp":null}',2)`,[cost]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM intel_live.intel_cost_overrides')).rows[0].n,1);
  assert.equal((await db.query("UPDATE intel_live.gallery SET version=version+1 WHERE owner_shop='shared' RETURNING gallery_id")).rows.length,0);
 }finally{await db.exec('ROLLBACK');}
 assert.equal((await db.query('SELECT count(*)::int AS n FROM intel_live.intel_cost_overrides')).rows[0].n,0);
 console.log(JSON.stringify({status:'passed',wrongDatabaseRejected:true,failedInstallAtomic:true,existingRoleNotReplaced:true,
  allowedIntelOverrideRolledBack:true,sharedUpdatesDenied:true,...guards},null,2));
}catch(error){console.error(JSON.stringify({status:'failed',sql_state:error.code||null,stage:'verification'}));process.exitCode=1;}
finally{await db.close();}
