// 验证运行身份只有读取能力，不能修改业务或成员授权。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('运行角色仅能读取明确授予的表，不能修改或创建表',async()=>{
 const db=new PGlite();
 try{
 await db.exec('CREATE SCHEMA intel_v2;CREATE SCHEMA nas_business;REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
 for(const table of ['configurations','products','configuration_prices','configuration_parts','configuration_addons','addon_options','addon_items','components'])await db.exec(`CREATE TABLE intel_v2.${table}(id int)`);
 for(const table of ['members','shop_roles','sales_publications'])await db.exec(`CREATE TABLE nas_business.${table}(id int)`);
 await db.exec('CREATE TABLE intel_v2.private_extra(id int);');
 const name=(await db.query('SELECT current_database() AS name')).rows[0].name;
 let sql=await readFile(new URL('../sql/002-runtime-reader.template.sql',import.meta.url),'utf8');
 sql=sql.replace("runtime_password text := '__SET_RANDOM_PASSWORD__'","runtime_password text := 'isolated-test-password'").replaceAll('diy_workbench_trial',name);
 await db.exec(sql);
 await db.exec('SET ROLE diy_api_reader');
 await db.query('SELECT id FROM nas_business.members');
 await assert.rejects(db.exec('INSERT INTO nas_business.members VALUES(1)'),/permission denied/);
 await assert.rejects(db.exec('INSERT INTO intel_v2.configurations VALUES(1)'),/permission denied/);
 await assert.rejects(db.query('SELECT id FROM intel_v2.private_extra'),/permission denied/);
 await assert.rejects(db.exec('CREATE TABLE intel_v2.forbidden(id int)'),/permission denied/);
 await db.exec('RESET ROLE');
 await assert.rejects(db.exec(sql),/角色已存在/);
 }finally{await db.close();}
});
