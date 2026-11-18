// 正式库管理员为已有成员设置 NAS 密码。新密码只从标准输入读取。
import pg from 'pg';
import {hashPassword,normalizeUsername} from '../src/local-auth.mjs';

const [workspace,uid,username,name]=process.argv.slice(2);
let client;
try{
 if(process.argv.length!==6||!workspace||!uid||!name||process.env.PGDATABASE!=='diy_workbench')
  throw Error('invalid arguments');
 const key=normalizeUsername(username);
 const chunks=[];
 let size=0;
 for await(const chunk of process.stdin){
  size+=chunk.length;
  if(size>4098)throw Error('invalid password size');
  chunks.push(chunk);
 }
 const bytes=Buffer.concat(chunks);
 const password=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r?\n$/,'');
 bytes.fill(0);
 for(const chunk of chunks)chunk.fill(0);
 if(Array.from(password).length<12)throw Error('password is too short');
 const {salt,hash}=await hashPassword(password);
 client=new pg.Client({connectionTimeoutMillis:5000,statement_timeout:10000});
 await client.connect();
 const {rows:[target]}=await client.query('SELECT current_database() AS database');
 if(target.database!=='diy_workbench')throw Error('database mismatch');
 await client.query('BEGIN');
 const {rows:[account]}=await client.query(`
  INSERT INTO nas_auth.accounts(workspace_id,uid,username_key,member_id,display_name,password_salt,password_hash)
  SELECT workspace_id,uid,$3,uid,$4,$5,$6 FROM nas_business.members
  WHERE workspace_id=$1 AND uid=$2 AND enabled
  ON CONFLICT (workspace_id,uid) DO UPDATE SET password_salt=EXCLUDED.password_salt,password_hash=EXCLUDED.password_hash
  WHERE accounts.username_key=EXCLUDED.username_key RETURNING uid`,
 [workspace,uid,key,name,salt,hash]);
 if(!account)throw Error('member or username mismatch');
 await client.query('DELETE FROM nas_auth.sessions WHERE workspace_id=$1 AND uid=$2',[workspace,uid]);
 await client.query('COMMIT');
 console.log('NAS 密码已设置，现有设备会话已撤销。');
}catch{
 // 不打印连接串、用户名、密码或数据库返回的参数。
 if(client)await client.query('ROLLBACK').catch(()=>{});
 console.error('设置失败。请核对正式数据库、管理员权限、成员与原用户名，并使用至少 12 个字符的新密码。');
 process.exitCode=1;
}finally{if(client)await client.end().catch(()=>{});}
