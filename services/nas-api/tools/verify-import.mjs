// 使用真实 PostgreSQL 内核隔离执行完整导入，并验证重复、改动检测和失败回滚。
import {PGlite} from '@electric-sql/pglite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const [directory,dataDir]=process.argv.slice(2);
if(!directory||!dataDir)throw new Error('需要导入包目录和新的隔离测试目录');
const sql=await readFile(join(directory,'01-导入全店接收区.sql'),'utf8');
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
await mkdir(dataDir,{recursive:false});
const maintenance=new PGlite(dataDir);
try{
 await assert.rejects(maintenance.exec(sql),/只允许试验库/);
 assert.equal((await maintenance.query("SELECT to_regnamespace('nas_import') IS NULL AS clean")).rows[0].clean,true);
 await maintenance.exec('CREATE DATABASE diy_workbench_trial');
}finally{await maintenance.close();}
const db=new PGlite(dataDir,{database:'diy_workbench_trial'});
try{
 // 在最后一条校验后注入异常，证明整个接收区建表及数据均能回滚。
 const failure=sql.replace('END $full_import$;',"RAISE EXCEPTION '测试失败回滚'; END $full_import$;");
 await assert.rejects(db.exec(failure),/测试失败回滚/);
 assert.equal((await db.query("SELECT to_regnamespace('nas_import') IS NULL AS clean")).rows[0].clean,true);
 await db.exec(sql);
 const count=()=>db.query('SELECT count(*)::int AS n FROM nas_import.records');
 assert.equal((await count()).rows[0].n,manifest.receiving_records_count);
 await db.exec(sql);
 assert.equal((await count()).rows[0].n,manifest.receiving_records_count);
 await db.exec("UPDATE nas_import.records SET document=document || '{\"tamper_test\":true}' WHERE kind='shop'");
 await assert.rejects(db.exec(sql),/导入回读不一致/);
 const receipt={status:'local_validation_passed',records:manifest.receiving_records_count,batch_id:manifest.batch_id,wrongDatabaseRejected:true,atomicRollback:true,idempotent:true,tamperRejected:true};
 await writeFile(join(directory,'本地验证.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt));
}finally{await db.close();}
