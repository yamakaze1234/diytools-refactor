// 单条 SQL 在独立 PostgreSQL 内核验证，不连接真实 NAS 或使用数据库密码。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const [file]=process.argv.slice(2);
if(!file)throw Error('需要完整正式库 SQL 文件');
const sql=await readFile(file,'utf8'),base=new PGlite();
let image;
try{
 await assert.rejects(base.query(sql),/只允许在正式库/);
 assert.equal((await base.query("SELECT to_regnamespace('nas_import') IS NULL AS clean")).rows[0].clean,true);
 await base.exec('CREATE DATABASE diy_workbench');
 image=await base.dumpDataDir();
}finally{await base.close();}
const db=new PGlite({loadDataDir:image,database:'diy_workbench'});
try{
 await db.exec('CREATE SCHEMA nas_import; CREATE TABLE nas_import.neighbour_test(id int PRIMARY KEY); INSERT INTO nas_import.neighbour_test VALUES(1)');
 await assert.rejects(db.query(sql),/已有其他结构/);
 assert.equal((await db.query('SELECT id FROM nas_import.neighbour_test')).rows[0].id,1);
 await db.exec('DROP SCHEMA nas_import CASCADE'); // 只删除本地夹具。
 const suffix='END $production_intel_data$;\n';
 assert(sql.endsWith(suffix));
 const broken=sql.slice(0,-suffix.length)+"RAISE EXCEPTION '验收中的末尾回滚';\n"+suffix;
 await assert.rejects(db.query(broken),/验收中的末尾回滚/);
 assert.equal((await db.query("SELECT to_regnamespace('nas_import') IS NULL AND to_regnamespace('intel_live') IS NULL AS clean")).rows[0].clean,true);
 await db.query(sql);
 const stats=(await db.query(`SELECT
  (SELECT record_count FROM nas_import.batches)::int AS receiving,
  (SELECT count(*)::int FROM intel_live.configurations) AS configurations,
  (SELECT count(*)::int FROM intel_live.configuration_documents c JOIN nas_import.records r ON r.kind='configuration' AND r.record_id=c.configuration_id AND r.document=c.document) AS exact,
  (SELECT count(*)::int FROM intel_live.parts) AS parts,
  (SELECT count(*)::int FROM intel_live.sources) AS sources,
  (SELECT count(*)::int FROM intel_live.costs) AS costs,
  (SELECT count(*)::int FROM intel_live.gallery) AS gallery,
  (SELECT count(*)::int FROM intel_live.assets) AS assets,
  (SELECT count(*)::int FROM intel_live.templates) AS templates,
  (SELECT count(*)::int FROM intel_live.quotations WHERE amount_cents IS NOT NULL) AS matched_price,
  (SELECT count(*)::int FROM intel_live.quotations WHERE amount_cents IS NULL) AS missing_price,
  (SELECT count(*)::int FROM intel_live.publications WHERE published) AS published,
  to_regnamespace('nas_business') IS NULL AS no_access_roles,
  (SELECT count(*)::int FROM intel_live.configurations WHERE shop_id<>'intel') AS other_shop_configs`)).rows[0];
 assert.equal(stats.configurations,stats.exact);assert.equal(stats.published,0);assert.equal(stats.other_shop_configs,0);assert(stats.no_access_roles);
 assert.equal(stats.matched_price+stats.missing_price,stats.configurations);
 const receipt=(await db.query('SELECT batch_id,payload_sha256 FROM intel_live.bootstrap')).rows[0];
 const edited=(await db.query("UPDATE intel_live.configurations SET name='本地夹具验证重复执行保留' WHERE configuration_id=(SELECT min(configuration_id) FROM intel_live.configurations) RETURNING configuration_id")).rows[0].configuration_id;
 await db.query(sql);
 assert.equal((await db.query('SELECT name FROM intel_live.configurations WHERE configuration_id=$1',[edited])).rows[0].name,'本地夹具验证重复执行保留');
 console.log(JSON.stringify({status:'passed',singlePreparedStatement:true,wrongDatabaseRejected:true,foreignStructuresPreserved:true,allOrNothing:true,repeatedExecutionPreservesEdits:true,...receipt,...stats},null,2));
}finally{await db.close();}
