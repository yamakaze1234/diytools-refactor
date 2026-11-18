// 使用实际接收包验证独立运行模型；只打开隔离的 PostgreSQL 内核。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const [receivingPath]=process.argv.slice(2);
if(!receivingPath)throw Error('需要完整接收区SQL文件路径');
const sql=await readFile(new URL('../sql/003-intel-live.sql',import.meta.url),'utf8');
const db=new PGlite();
let options;
try{
 await assert.rejects(db.exec(sql),/运行结构只允许试验库/);
 assert.equal((await db.query("SELECT to_regnamespace('intel_live') IS NULL AS clean")).rows[0].clean,true);
 await db.exec('CREATE DATABASE diy_workbench_trial');
 options={loadDataDir:await db.dumpDataDir(),database:'diy_workbench_trial'};
}finally{await db.close();}
const trial=new PGlite(options);
try{
 await trial.exec(await readFile(receivingPath,'utf8'));
 await trial.exec("UPDATE nas_import.records SET document=document||'{\"tamper\":1}' WHERE kind='shop'");
 await assert.rejects(trial.exec(sql),/接收区数据未通过摘要核对/);
 assert.equal((await trial.query("SELECT to_regnamespace('intel_live') IS NULL AS clean")).rows[0].clean,true);
 await trial.exec("UPDATE nas_import.records SET document=document-'tamper' WHERE kind='shop'");
 const failAtEnd=sql.replace('END $intel_runtime$;',"RAISE EXCEPTION '测试：运行初始化末尾失败'; END $intel_runtime$;");
 await assert.rejects(trial.exec(failAtEnd),/运行初始化末尾失败/);
 assert.equal((await trial.query("SELECT to_regnamespace('intel_live') IS NULL AS clean")).rows[0].clean,true);
 await trial.exec(sql);
 const {rows:[stats]}=await trial.query(`SELECT
  (SELECT count(*)::int FROM intel_live.configurations) AS configurations,
  (SELECT count(*)::int FROM intel_live.parts) AS parts,
  (SELECT count(*)::int FROM intel_live.addons) AS addons,
  (SELECT count(*)::int FROM intel_live.sources) AS sources,
  (SELECT count(*)::int FROM intel_live.costs) AS costs,
  (SELECT count(*)::int FROM intel_live.assets) AS assets,
  (SELECT count(*)::int FROM intel_live.gallery) AS gallery,
  (SELECT count(*)::int FROM intel_live.templates) AS templates,
  (SELECT count(*)::int FROM intel_live.configurations WHERE sku='') AS missing_sku,
  (SELECT count(*)::int FROM intel_live.configurations WHERE spu='') AS missing_spu,
  (SELECT count(*)::int FROM intel_live.quotations WHERE amount_cents IS NULL) AS missing_price,
  (SELECT count(*)::int FROM intel_live.publications WHERE published) AS published,
  (SELECT count(*)::int FROM intel_live.configuration_documents c
   JOIN nas_import.records r ON r.kind='configuration' AND r.record_id=c.configuration_id AND r.document=c.document) AS exact`);
 const {rows:[batch]}=await trial.query('SELECT batch_id,payload_sha256 FROM intel_live.bootstrap');
 assert.equal(stats.configurations,stats.exact);
 assert.equal(stats.published,0);
 const updated=(await trial.query("UPDATE intel_live.configurations SET name='隔离回读' WHERE configuration_id=(SELECT min(configuration_id) FROM intel_live.configurations) RETURNING configuration_id")).rows[0].configuration_id;
 await trial.exec(sql);
 assert.equal((await trial.query('SELECT name FROM intel_live.configurations WHERE configuration_id=$1',[updated])).rows[0].name,'隔离回读');
 console.log(JSON.stringify({status:'passed',...batch,...stats,wrongDatabaseRejected:true,atomicRollback:true,repeatPreservesEdits:true},null,2));
}finally{await trial.close();}
