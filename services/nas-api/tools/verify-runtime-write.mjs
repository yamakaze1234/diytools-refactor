// 使用已配置的有限后台账号，验证业务事务可执行并强制回滚，不留下配置或回执。
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {LiveStore} from '../src/live-store.mjs';

async function verify(){
 const env=process.env;
 if(env.PGDATABASE!=='diy_workbench_trial'||env.PGUSER!=='diy_api_operations'||!env.PGHOST||!env.PGPASSWORD_FILE)
  throw Error('只能使用已授权的试验库后台写账号');
 const pool=new pg.Pool({connectionTimeoutMillis:5000,statement_timeout:10000,password:(await readFile(env.PGPASSWORD_FILE,'utf8')).trim()});
 try{
  const {rows:[identity]}=await pool.query('SELECT current_database() AS database,current_user AS db_role');
  assert.equal(identity.database,'diy_workbench_trial');assert.equal(identity.db_role,'diy_api_operations');
  const {rows:[count]}=await pool.query("SELECT count(*)::int AS rows FROM intel_live.configurations WHERE shop_id='intel'");
  const {rows:[member]}=await pool.query("SELECT m.workspace_id AS \"workspaceId\",m.uid FROM nas_business.members m JOIN nas_business.shop_roles r USING(workspace_id,uid) WHERE m.enabled AND r.shop_id='intel' AND r.role='operations' ORDER BY m.uid LIMIT 1");
  assert(member,'需要已授权运营成员');
  let rollbackVerified=false;
  const probeId='rollback-probe-'+randomUUID();
  const operation=randomUUID();
  const rollbackPool={query:pool.query.bind(pool),async connect(){
   const connection=await pool.connect();
   return {release:()=>connection.release(),async query(query,args){
    if(query==='COMMIT'){
     // 先在事务内部核对完整回执和配置，再用 ROLLBACK 替代任何提交。
     const {rows:[inside]}=await connection.query("SELECT c.name,c.version::text,r.result FROM intel_live.configurations c JOIN intel_live.save_receipts r USING(configuration_id) WHERE c.configuration_id=$1 AND r.operation_id=$2",[probeId,operation]);
     assert.equal(inside.version,'1');assert.equal(inside.result.operation_id,operation);
     assert.equal((await connection.query('ROLLBACK')).command,'ROLLBACK');
     rollbackVerified=true;
     return {command:'ROLLBACK',rows:[]};
    }
    return connection.query(query,args);
   }};
  }};
  const store=new LiveStore(rollbackPool,{writable:true});
  const body={operation_id:operation,dependencies:{sources:{},costs:{}},document:{id:probeId,name:'试验环境回滚验证',
   productId:probeId,shopId:'intel',spu:'',skuId:'',price:0,workspaceOrder:0,parts:[],actualParts:[],addons:[]}};
  const result=await store.save(member,'intel',probeId,'create',body,randomUUID());
  const {rows:[persist]}=await pool.query('SELECT EXISTS(SELECT 1 FROM intel_live.configurations WHERE configuration_id=$1) AS configuration, EXISTS(SELECT 1 FROM intel_live.save_receipts WHERE operation_id=$2) AS receipt',[probeId,operation]);
  assert.equal(result.version,'1');assert.equal(rollbackVerified,true);
  assert.deepEqual(persist,{configuration:false,receipt:false});
  console.log(JSON.stringify({status:'passed',...identity,existing_configurations:count.rows,
   business_transaction_reached_receipt:true,rollback_verified:true,configuration_persisted:false,receipt_persisted:false}));
 }finally{await pool.end();}
}
try{await verify();}catch(error){
 // 不打印连接详情、账号元数据、查询正文及含凭据的配置。
 console.error('试验写入回滚验证失败：'+(typeof error.code==='string'?error.code:'CHECK_FAILED'));
 process.exitCode=1;
}
