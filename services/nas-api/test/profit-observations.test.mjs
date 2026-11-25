// 测试使用内存隔离 PostgreSQL；没有读取业务库、ERP、凭据或历史。
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {runNasProfit} from '../src/profit-store.mjs';

const migration=await readFile(new URL('../sql/010-profit-observations.sql',import.meta.url),'utf8');
const formal='diy_workbench',trial='diy_workbench_trial',formalRole='diy_api_intel_production',trialRole='diy_api_operations';
const setActor=(db,ws,uid)=>db.query("SELECT set_config('intel_live.catalog_workspace',$1,false),set_config('intel_live.catalog_uid',$2,false)",[ws,uid]);
async function fixture(name,role){
 const origin=new PGlite();await origin.exec('CREATE DATABASE '+name);
 const db=new PGlite({loadDataDir:await origin.dumpDataDir(),database:name});await origin.close();
 try{
  await db.exec(`CREATE ROLE ${formalRole}; CREATE ROLE ${trialRole}; CREATE ROLE nas_sales_role;
   CREATE SCHEMA intel_live; REVOKE ALL ON SCHEMA intel_live FROM PUBLIC;
   GRANT USAGE ON SCHEMA intel_live TO ${formalRole},${trialRole},nas_sales_role;
   CREATE TABLE intel_live.bootstrap(shop_id text PRIMARY KEY); INSERT INTO intel_live.bootstrap VALUES('intel');
   CREATE TABLE intel_live.configurations(configuration_id text PRIMARY KEY,shop_id text,version bigint,archived_at timestamptz,fields jsonb);
   INSERT INTO intel_live.configurations SELECT 'config-'||lpad(i::text,2,'0'),'intel',1,NULL,'{}' FROM generate_series(1,61)i;
   CREATE FUNCTION intel_live.catalog_is_operator() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT current_setting('intel_live.catalog_workspace',true) IN ('first','second') AND
           current_setting('intel_live.catalog_uid',true) IN ('operator','other-operator') $$;
   REVOKE ALL ON FUNCTION intel_live.catalog_is_operator() FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION intel_live.catalog_is_operator() TO ${role};`);
  await db.exec(migration);return db;
 }catch(error){await db.close();throw error;}
}
const price=(id,tax,version='1')=>({id,shopId:'intel',name:id,product:'测试链接',productId:'product',nasVersion:version,installment:0,price:1000,overviewFeeRate:0,
 parts:[{name:'展示项',tax:0,qty:1}],actualParts:[{name:'实际件',slot:'CPU',goodsId:'00003',tax,qty:1}]});
const rules={pricingRule:{taxRate:0,taxFixed:0}};

test('正式隔离库保存检测、推进有效基准，校验最新快照重设及原编号幂等',async()=>{
 const db=await fixture(formal,formalRole);
 try{
  const signature='intel_live.profit_observe(text,jsonb)';
  assert.deepEqual((await db.query("SELECT has_function_privilege($1,$3,'EXECUTE') allowed,has_function_privilege($2,$3,'EXECUTE') trial",[formalRole,trialRole,signature])).rows,[{allowed:true,trial:false}]);
  await db.exec('SET ROLE '+formalRole);
  await assert.rejects(()=>db.query('SELECT * FROM intel_live.profit_observations'),{code:'42501'});
  let tax=500,stale=null,loads=0;
  const read=async ids=>{loads++;return {configs:ids.map(id=>price(id,tax,id===stale?'2':'1')),settings:rules};};
  const call=(action,input={})=>runNasProfit(db,action,{shopId:'intel',...input},read);
  const configId='config-01',start=(requestId=randomUUID(),configIds=[configId])=>call('start',{requestId,configIds});
  const status=(runId,offset)=>call('status',{runId,...(offset?{offset}:{})});
  const reset=(resultId,requestId=randomUUID())=>call('reset',{requestId,configId,metric:'accounting',resultId});
  await assert.rejects(()=>call('history'),{code:'FORBIDDEN'});
  await setActor(db,'first','operator');
  assert.deepEqual(await call('history'),{runs:[]});
  const repeat=randomUUID(),first=await start(repeat);assert.deepEqual(await start(repeat),first);assert.equal(loads,1);
  const before=(await status(first.runId)).results[0];assert.equal(before.profit_cents,40000);assert.equal(before.previous_delta_cents,null);
  assert.equal(before.snapshot.overviewFeeRate,0);assert.equal(before.snapshot.formulaVersion,'overview-cost-rate-v1');
  assert.equal(before.snapshot.parts[0].name,'实际件');assert.equal((await status(first.runId)).run.erpCollected,false);
  await assert.rejects(()=>start(repeat,['config-02']),{code:'OPERATION_REUSED'});
  tax=600;const exact=(await status((await start()).runId)).results[0];
  assert.equal(exact.anchor_delta_cents,-10000);assert.equal(exact.changed,false);
  tax=null;const missing=(await status((await start()).runId)).results[0];
  assert.equal(missing.valid,false);assert.equal(missing.profit_cents,null);assert.match(missing.reason,/含税价缺失/);
  await assert.rejects(()=>reset(exact.id),{code:'PROFIT_RESULT_STALE'});
  tax=700.01;const changed=(await status((await start()).runId)).results[0];
  assert.equal(changed.previous_delta_cents,-10001);assert.equal(changed.anchor_delta_cents,-20001);assert.equal(changed.changed,true);
  tax=705;await assert.rejects(()=>reset(changed.id),{code:'PROFIT_RESULT_STALE'});
  tax=700.01;const resetId=randomUUID();assert.deepEqual(await reset(changed.id,resetId),{ok:true});
  tax=800;assert.deepEqual(await reset(changed.id,resetId),{ok:true});
  const next=(await status((await start()).runId)).results[0];
  assert.equal(next.anchor_delta_cents,-9999);assert.equal(next.changed,false);
  await assert.rejects(()=>reset(changed.id),{code:'PROFIT_RESULT_STALE'});
  const history=(await call('history')).runs;
  assert.equal(history.length,5);assert.equal(history[0].id!==first.runId,true);
  await setActor(db,'first','other-operator');assert.equal((await call('history')).runs.length,5);
  await setActor(db,'second','operator');assert.equal((await call('history')).runs.length,0);await assert.rejects(()=>status(first.runId),{code:'NOT_FOUND'});
  await setActor(db,'first','operator');stale='config-02';
  await assert.rejects(()=>start(randomUUID(),['config-01','config-02']),{code:'VERSION_CONFLICT'});
  assert.equal((await call('history')).runs.length,5);
  stale=null;
  // 在第二条观察入库时注入真实数据库异常，验证第一条和检测任务同时回滚。
  await db.exec('RESET ROLE');
  await db.exec(`CREATE FUNCTION intel_live.test_reject_later() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.configuration_id='config-02' THEN RAISE EXCEPTION '模拟末条写入失败'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER test_profit_failure BEFORE INSERT ON intel_live.profit_observations FOR EACH ROW EXECUTE FUNCTION intel_live.test_reject_later();`);
  await db.exec('SET ROLE '+formalRole);
  await assert.rejects(()=>start(randomUUID(),['config-01','config-02']),/模拟末条写入失败/);
  assert.equal((await call('history')).runs.length,5);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::integer n FROM intel_live.profit_observations')).rows[0].n,5);
  await db.exec('DROP TRIGGER test_profit_failure ON intel_live.profit_observations; SET ROLE '+formalRole);
  const all=Array.from({length:61},(_,i)=>'config-'+String(i+1).padStart(2,'0'));
  const batch=await start(randomUUID(),all),head=await status(batch.runId),tail=await status(batch.runId,head.nextOffset);
  assert.equal(head.results.length,60);assert.equal(tail.results.length,1);assert.equal(tail.nextOffset,null);
  assert.equal(new Set([...head.results,...tail.results].map(row=>row.config_id)).size,61);
  await db.exec('RESET ROLE');await db.exec("UPDATE intel_live.configurations SET version=2 WHERE configuration_id='config-01'");
  await db.exec('SET ROLE '+formalRole);assert.equal((await status(batch.runId)).results[0].configUpdated,true);
 }finally{await db.close();}
});

test('试验角色隔离且其它库被安装守卫拒绝',async()=>{
 const db=await fixture(trial,trialRole);
 try{
  const result=await db.query("SELECT has_function_privilege($1,$3,'EXECUTE') allowed,has_function_privilege($2,$3,'EXECUTE') formal",[trialRole,formalRole,'intel_live.profit_observe(text,jsonb)']);
  assert.deepEqual(result.rows,[{allowed:true,formal:false}]);
 }finally{await db.close();}
 const wrong=new PGlite();
 try{await assert.rejects(()=>wrong.exec(migration),/只允许英特尔正式库或试验库/);}finally{await wrong.close();}
});

test('运营费率进入服务端快照指纹，旧检测不能跨费率重设基准',async()=>{
 const db=await fixture(formal,formalRole);
 try{
  await db.exec('SET ROLE '+formalRole);await setActor(db,'first','operator');
  let rate=4;
  const load=async()=>({configs:[{...price('config-01',500),overviewFeeRate:rate}],settings:rules});
  const call=(action,input)=>runNasProfit(db,action,{shopId:'intel',...input},load);
  const first=await call('start',{requestId:randomUUID(),configIds:['config-01']});
  const row=(await call('status',{runId:first.runId})).results[0];
  assert.equal(row.profit_cents,38000);assert.equal(row.snapshot.overviewFeeRate,4);
  assert.equal(row.snapshot.formulaVersion,'overview-cost-rate-v1');
  rate=8;
  await assert.rejects(()=>call('reset',{requestId:randomUUID(),configId:'config-01',metric:'accounting',resultId:row.id}),{code:'PROFIT_RESULT_STALE'});
  const second=await call('start',{requestId:randomUUID(),configIds:['config-01']});
  assert.equal((await call('status',{runId:second.runId})).results[0].profit_cents,36000);
 }finally{await db.close();}
});
