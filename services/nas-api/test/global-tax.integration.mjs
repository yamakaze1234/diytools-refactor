// 真实三店结构和生产角色的隔离 HTTP 验证；只读取显式传入的合成 fixture，不连接正式服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成三店 SQL fixture 目录');
const shops=['intel','gigabyte','jonsbo'];

test('三店全局核算价事务：版本、原价恢复、持久标记、其他入口失效、审计和未知回执',async()=>{
 const errors=[];
 const api=await startSourceAcceptance({fixture,root:join(fixture,'global-tax-test-uploads'),
  authenticate:async header=>({uid:header||fixtureActor,workspaceId:fixtureWorkspace}),verifyError:error=>errors.push(error.message)});
 const call=async(shop,path,{body,status=200,method=body?'POST':'GET',actor=fixtureActor}={})=>{
  const response=await fetch(api.url+'/api/v1/operations/'+path+'?shop_id='+shop,{method,
   headers:{'x-workbench-deployment':fixtureDeployment,authorization:actor,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify({result,errors}));return result.data??result.error;
 };
 const readCosts=async()=>Object.fromEntries(await Promise.all(shops.map(async shop=>[shop,await call(shop,'costs/100001')])));
 const plan=async(fields)=>{const costs=await readCosts();return {operation_id:randomUUID(),changes:[{
  id:'100001',action:'global_tax',expected_version:costs.intel.version,
  expected_versions:Object.fromEntries(shops.map(shop=>[shop,costs[shop].version])),fields}]};};
 const global=body=>call('intel','workspace/costs',{body});
 const local=async(shop,tax,action='tax_edit')=>{
  const cost=await call(shop,'costs/100001');return call(shop,'workspace/costs',{body:{operation_id:randomUUID(),changes:[{
   id:'100001',action,expected_version:cost.version,fields:action==='erp_snapshot'?{erp:tax,stockAvailable:2}:{tax}}]}});
 };
 try{
  assert.equal(await call('intel','workspace/costs',{body:await plan({tax:25}),status:503}),'NAS_GLOBAL_TAX_NOT_INSTALLED');
  await api.db.exec(await readFile(new URL('../sql/020-workbench-global-tax.sql',import.meta.url),'utf8'));
  // 候选可重复安装，不能重置现有业务文档或恢复基线。
  await api.db.exec(await readFile(new URL('../sql/020-workbench-global-tax.sql',import.meta.url),'utf8'));
  await api.db.exec(await readFile(new URL('../sql/021-workbench-alias-addons.sql',import.meta.url),'utf8'));
  for(const [index,shop] of shops.entries())await local(shop,13+index);
  // 模拟旧版手改记录。补标记后金额、版本和审计回执全部保留。
  for(const shop of shops)await api.db.exec(`UPDATE ${shop}_live.intel_cost_overrides SET document=document-'nasManualTax';`);
  const oldManual=await readCosts();
  const migration=await readFile(new URL('../sql/023-shop-manual-tax.sql',import.meta.url),'utf8');
  await api.db.exec(migration);await api.db.exec(migration);
  for(const [shop,old] of Object.entries(oldManual)){
   const updated=await call(shop,'costs/100001');
   assert.deepEqual(updated,{...old,document:{...old.document,nasManualTax:true}});
  }
  // 与新价相同的独立覆盖会取消，其他覆盖应保留。
  await api.db.exec(`UPDATE intel_live.parts SET attrs=attrs||'{"tax":25,"taxOverride":{"goodsId":"100001","base":13,"value":25}}'
   WHERE part_kind='actual' AND goodsid='100001';
   UPDATE gigabyte_live.parts SET attrs=attrs||'{"tax":99,"taxOverride":{"goodsId":"100001","base":14,"value":99}}'
   WHERE part_kind='actual' AND goodsid='100001';`);
  const docBefore=await call('intel','configurations/fixture-overlap');
  const body=await plan({tax:25});
  const receipt=await global(body);
  assert.deepEqual(await global(body),receipt);
  assert.deepEqual(await call('intel','workspace/receipts/'+body.operation_id),receipt);
  assert.equal(Object.keys(receipt.changes[0].shop_versions).length,3);
  for(const [index,shop] of shops.entries()){
   const {document,version}=await call(shop,'costs/100001');
   assert.equal(document.tax,25);assert.equal(document.globalTax.base,13+index);
   assert.equal(document.globalTax.value,25);assert.equal(document.globalTax.by,fixtureActor);
   assert.ok(Number.isFinite(Date.parse(document.globalTax.at)));assert.equal(version,receipt.changes[0].shop_versions[shop]);
   const source=await call(shop,'sources/fixture-local');assert.equal(source.document.tax,25);
   const history=await call(shop,'workspace/price-history/list',{body:{}});assert.ok(history.batches.some(row=>row.message==='三店共用核算价维护'));
   const audit=await api.db.query(`SELECT count(*)::int AS n FROM ${shop}_live.workspace_audit WHERE operation_id=$1`,[body.operation_id]);
   assert.equal(audit.rows[0].n,1);
   const peerReceipt=await call(shop,'workspace/receipts/'+body.operation_id);
   assert.equal(peerReceipt.changes[0].version,version);assert.equal(peerReceipt.shop_id,shop);
  }
  const docAfter=await call('intel','configurations/fixture-overlap');
  assert.ok(BigInt(docAfter.version)>BigInt(docBefore.version));assert.equal(docAfter.document.actualParts[0].taxOverride,undefined);
  assert.equal((await call('gigabyte','configurations/fixture-overlap')).document.actualParts[0].taxOverride.value,99);
  await global(await plan({tax:30}));
  for(const [index,shop] of shops.entries())assert.equal((await call(shop,'costs/100001')).document.globalTax.base,13+index);
  await global(await plan({restore:true}));
  for(const [index,shop] of shops.entries()){
   const {document}=await call(shop,'costs/100001');assert.equal(document.tax,13+index);assert.equal(document.globalTax,undefined);
  }
  // 预览后任何一店更新都必须使整笔失败，其他店不能先提交。
  const stale=await plan({tax:100});await local('jonsbo',17);
  const before=await readCosts();
  assert.equal(await call('intel','workspace/costs',{body:stale,status:409}),'VERSION_CONFLICT');
  assert.deepEqual(await readCosts(),before);
  await global(await plan({tax:40}));
  await local('gigabyte',7,'erp_snapshot');
  assert.equal((await call('gigabyte','costs/100001')).document.globalTax,undefined);
  const brokenRestore=await plan({restore:true}),beforeRestore=await readCosts();
  assert.equal(await call('intel','workspace/costs',{body:brokenRestore,status:409}),'GLOBAL_TAX_RESTORE_CONFLICT');
  assert.deepEqual(await readCosts(),beforeRestore);
  await global(await plan({tax:45}));
  const shared=await call('intel','catalog/shared-sources/100001');
  await call('intel','catalog/shared-sources/100001',{method:'PUT',body:{operation_id:randomUUID(),expected_version:shared.version,
   document:{id:'100001',edits:{gigabyte:{values:{tax:46},restore:[]}}}}});
  assert.equal((await call('gigabyte','costs/100001')).document.globalTax,undefined);
  await global(await plan({tax:47}));
  await local('jonsbo',48,'tax_edit');
  assert.equal((await call('jonsbo','costs/100001')).document.globalTax,undefined);
  // 旧客户端发送的整批成本表计划也只更新普通行，手改行的原价与版本保持。
  const manual=await call('jonsbo','costs/100001'),ordinary=await call('jonsbo','costs/9900013');
  const importPlan={operation_id:randomUUID(),changes:[
   {id:'100001',action:'tax_file',expected_version:'1',fields:{tax:58}},
   {id:'9900013',action:'tax_file',expected_version:ordinary.version,fields:{tax:300}}]};
  const imported=await call('jonsbo','workspace/costs',{body:importPlan});
  assert.deepEqual(imported.changes[0],{id:'100001',version:manual.version,skipped:'manual_tax'});
  assert.deepEqual(await call('jonsbo','workspace/receipts/'+importPlan.operation_id),imported);
  assert.deepEqual(await call('jonsbo','costs/100001'),manual);
  const fileCost=await call('jonsbo','costs/9900013');
  assert.equal(fileCost.document.tax,300);assert.equal(fileCost.document.nasManualTax,false);
  await api.db.exec("UPDATE jonsbo_live.intel_cost_overrides SET document=document-'nasManualTax' WHERE goodsid='9900013'");
  await api.db.exec(migration);
  assert.deepEqual(await call('jonsbo','costs/9900013'),fileCost);
  await local('jonsbo',48,'tax_resume');
  const resumed=await call('jonsbo','costs/100001');
  assert.equal(resumed.document.nasManualTax,false);assert.equal(resumed.document.tax,48);
  await local('jonsbo',57,'tax_file');
  assert.equal((await call('jonsbo','costs/100001')).document.tax,57);
  // 任意店发起都使用其自身版本和回执，不能靠替换 shop 参数重用已提交编号。
  for(const shop of ['gigabyte','jonsbo']){
   const alternative=await plan({tax:49});alternative.changes[0].expected_version=alternative.changes[0].expected_versions[shop];
   const fromPeer=await call(shop,'workspace/costs',{body:alternative});
   assert.equal(fromPeer.shop_id,shop);assert.equal(fromPeer.changes[0].version,fromPeer.changes[0].shop_versions[shop]);
   assert.deepEqual(await call(shop,'workspace/costs',{body:alternative}),fromPeer);
  }
  // 无三店权限时不能借发起店权限写另外两家店。
  const denied=await plan({tax:55});
  await api.db.query("DELETE FROM nas_business.operation_group_shops WHERE workspace_id=$1 AND shop_id='jonsbo'",[fixtureWorkspace]);
  assert.equal(await call('intel','workspace/costs',{body:denied,status:403}),'FORBIDDEN');
 }finally{await api.close();}
});

test('新增配置字段在 NAS 保存、摘要和显式 false 上保留，并拒绝无效类型',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'global-tax-fields-test-uploads'),
  authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 const call=async(path,method='GET',body)=>{
  const response=await fetch(api.url+'/api/v1/operations/'+path,{method,headers:{'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'},
   body:body?JSON.stringify(body):undefined});return {status:response.status,...await response.json()};
 };
 try{
  let current=(await call('configurations/fixture-overlap')).data;
  const document={...current.document,productDraft:true,overviewPrice99:false,overviewAccessoryLimit:2};
  let result=await call('configurations/fixture-overlap','PUT',{operation_id:randomUUID(),expected_version:current.version,dependencies:current.dependencies,document});
  assert.equal(result.status,200,JSON.stringify(result));
  current=(await call('configurations/fixture-overlap')).data;
  assert.equal(current.document.productDraft,true);assert.equal(current.document.overviewPrice99,false);assert.equal(current.document.overviewAccessoryLimit,2);
  const summary=(await call('workspace-index')).data.summaries.find(row=>row.id===document.id);
  assert.equal(summary.productDraft,true);assert.equal(summary.overviewPrice99,false);assert.equal(summary.overviewAccessoryLimit,2);
  for(const patch of [{productDraft:1},{overviewPrice99:null},{overviewAccessoryLimit:6},{overviewAccessoryLimit:1.5}]){
   result=await call('configurations/fixture-overlap','PUT',{operation_id:randomUUID(),expected_version:current.version,
    dependencies:current.dependencies,document:{...current.document,...patch}});assert.equal(result.status,400,JSON.stringify(result));
  }
 }finally{await api.close();}
});
