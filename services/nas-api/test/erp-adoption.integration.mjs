/** 使用隔离三店 fixture 检查真实 HTTP、目录回执和临时核算价迁移。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 fixture 目录');

const authenticate=async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace});
function connect(api,shop){
 const client=createNasApiClient({shopId:shop,nativeRequest:(path,options)=>fetch(api.url+path,
  {...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});
 client.bindIdentity(fixtureWorkspace,fixtureActor);
 return client;
}
const request=(id,erp=125,extra={})=>({operation_id:randomUUID(),document:{id,name:'ERP 测试配件',
 erpAdoption:{name:'ERP 测试配件（参数）',erp,sku:'TEST',stockAvailable:6,...extra}}});
const create=(client,id,payload=request(id))=>client.saveCatalog('shared-sources',id,'create',payload);
const cost=(client,id)=>client.resource('costs',id);
const adoptionSql=new URL('../sql/024-shop-erp-adoption.sql',import.meta.url);

test('ERP 新品本店创建、原号回执、沿用已有价和正常补表',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'erp-adoption-uploads'),authenticate,erpAdoption:false});
 const intel=connect(api,'intel'),jonsbo=connect(api,'jonsbo'),gigabyte=connect(api,'gigabyte');
 async function tablePrice(id,tax){
  const row=await cost(intel,id);
  return intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:[
   {id,action:'tax_file',expected_version:row.version,fields:{tax,taxUpdatedAt:'2026-11-22T00:00:00.000Z'}},
  ]});
 }
 try{
  const fresh='9900611';
  await assert.rejects(create(intel,fresh),{code:'NAS_ERP_ADOPTION_NOT_INSTALLED'});
  await api.db.exec(await readFile(adoptionSql,'utf8'));
  const body=request(fresh),saved=await create(intel,fresh,body);
  assert.equal(saved.document.reused,false);
  assert.deepEqual(await create(intel,fresh,body),saved);
  assert.equal((await create(intel,fresh,request(fresh,180))).document.sourceId,saved.document.sourceId);
  assert.deepEqual(Object.keys((await intel.catalog('shared-sources',fresh)).document.stores),['intel']);
  await assert.rejects(jonsbo.resource('sources',saved.document.sourceId),{code:'NOT_FOUND'});
  await assert.rejects(cost(gigabyte,fresh),{code:'NOT_FOUND'});
  assert.equal((await cost(intel,fresh)).document.tax,125);
  assert.equal((await cost(intel,fresh)).document.nasProvisionalTax,true);
  // 验收启动时自动安装颜色投影；ERP/成本更新保持人工色，清空只移除颜色键。
  const sourceId=saved.document.sourceId;
  const colorField='hardwareOverrides.color';
  async function setHardware(values){
   const current=await intel.catalog('shared-sources',fresh);
   return intel.saveCatalog('shared-sources',fresh,'replace',{operation_id:randomUUID(),expected_version:current.version,
    document:{id:fresh,edits:{intel:{values,restore:[]}}}});
  }
  const source=async()=>(await intel.resource('sources',sourceId)).document;
  await assert.rejects(setHardware({[colorField]:'蓝'}),{code:'VALIDATION_FAILED'});
  await setHardware({[colorField]:'黑','hardwareOverrides.boardType':'MATX'});
  assert.deepEqual((await source()).hardwareOverrides,{color:'黑',boardType:'MATX'});
  const erpBefore=await cost(intel,fresh);
  await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:[{
   id:fresh,action:'erp_snapshot',expected_version:erpBefore.version,fields:{erp:128,stockAvailable:7,name:'ERP 主板 白色'},
  }]});
  const renamed=await cost(intel,fresh);
  assert.deepEqual([renamed.document.erp,renamed.document.name,renamed.document.erpName],[128,'ERP 主板 白色','ERP 主板 白色']);
  await intel.workspaceWrite('costs',{operation_id:randomUUID(),changes:[{
   id:fresh,action:'erp_snapshot',expected_version:renamed.version,fields:{erp:128,stockAvailable:8},
  }]});
  assert.equal((await cost(intel,fresh)).document.erpName,'ERP 主板 白色');
  assert.equal((await source()).hardwareOverrides.color,'黑');
  await tablePrice(fresh,125);
  assert.equal((await cost(intel,fresh)).document.nasProvisionalTax,undefined);
  await tablePrice(fresh,130);
  assert.equal((await cost(intel,fresh)).document.tax,130);
  assert.equal((await source()).tax,130);
  assert.equal((await source()).hardwareOverrides.color,'黑');
  await setHardware({[colorField]:null});
  const clear=await api.db.query("SELECT attrs->'hardwareOverrides' AS hardware FROM intel_live.sources WHERE source_id=$1",[sourceId]);
  assert.deepEqual(clear.rows[0].hardware,{boardType:'MATX'});
  await tablePrice(fresh,135);
  assert.deepEqual((await source()).hardwareOverrides,{boardType:'MATX'});
  await assert.rejects(jonsbo.resource('sources',sourceId),{code:'NOT_FOUND'});

  const existing='9900612';
  await api.db.query('INSERT INTO intel_live.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,9)',
   [existing,JSON.stringify({goodsId:existing,erp:100,tax:0,nasTaxOverride:true,nasManualTax:true})]);
  const original=await cost(intel,existing);
  await create(intel,existing,request(existing,125,{tableTax:400}));
  assert.deepEqual(await cost(intel,existing),original);
  assert.equal((await tablePrice(existing,220)).changes[0].skipped,'manual_tax');
  assert.deepEqual(await cost(intel,existing),original);

  const manual='9900613',created=await create(intel,manual);
  await intel.saveCatalog('shared-sources',manual,'replace',{operation_id:randomUUID(),expected_version:created.version,document:{
   id:manual,edits:{intel:{values:{tax:145},restore:[]}},
  }});
  assert.equal((await cost(intel,manual)).document.nasManualTax,true);
  assert.equal((await tablePrice(manual,300)).changes[0].skipped,'manual_tax');
  assert.equal((await cost(intel,manual)).document.tax,145);

  const listed='9900614';
  await create(intel,listed,request(listed,125,{tableTax:0}));
  assert.equal((await cost(intel,listed)).document.tax,0);
  assert.equal((await cost(intel,listed)).document.nasProvisionalTax,false);
  await assert.rejects(create(intel,'9900615',{...request('9900615'),document:{...request('9900615').document,name:'带星号*'}}),{code:'VALIDATION_FAILED'});
 }finally{await api.close();}
});

test('ERP 跨店建源立即继承共用属性，保留各店 ERP 信息与临时核算价',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'erp-adoption-uploads'),authenticate,erpAdoption:false});
 const intel=connect(api,'intel'),jonsbo=connect(api,'jonsbo'),gigabyte=connect(api,'gigabyte');
 try{
  // 模拟先前已装 024、也已有跨店属性及店铺维护数据的数据库。
  await api.db.exec(await readFile(adoptionSql,'utf8'));
  const id='9900616';
  const a=(await create(intel,id,request(id,110,{tableTax:145}))).document.sourceId;
  const c=(await create(jonsbo,id,request(id,220,{tableTax:265}))).document.sourceId;
  const shared=(await intel.catalog('shared-sources',id));
  const hardware={color:'白',cpuName:'14600KF',gpuName:'RTX 5070',boardType:'MATX',caseBoards:['MATX','ITX']};
  const capacities={memoryGb:32,vramGb:12,storageGb:1024};
  const choices=[{id:'one',enabled:true,goodsId:'',label:'可咨询客服加购',qty:1,originalQty:1,priceCents:null}];
  const addon={addonChoices:choices,addonText:choices[0].label};
  const values={addon,tax:499};
  for(const [group,fields] of Object.entries({hardwareOverrides:hardware,capacityOverrides:capacities}))
   for(const [key,value] of Object.entries(fields))values[group+'.'+key]=value;
  await intel.saveCatalog('shared-sources',id,'replace',{operation_id:randomUUID(),expected_version:shared.version,document:{
   id,edits:{shared:{values,restore:[]},intel:{values:{'hardwareOverrides.color':'黑'},restore:[]}},
  }});
  const existing=()=>Promise.all([intel.resource('sources',a),cost(intel,id),jonsbo.resource('sources',c),cost(jonsbo,id)]);
  const before=await existing();
  assert.equal(before[0].document.hardwareOverrides.color,'黑');
  assert.equal(before[1].document.tax,145);
  assert.equal(before[3].document.tax,265);
  await assert.rejects(cost(gigabyte,id),{code:'NOT_FOUND'});

  const upgrade=await readFile(new URL('../sql/026-erp-adoption-shared-fields.sql',import.meta.url),'utf8');
  await api.db.exec(upgrade);
  await api.db.exec(upgrade);
  const erpName='技嘉店实物验收名称';
  const time=Date.now();
  const {document:receipt}=await create(gigabyte,id,request(id,321,{name:erpName}));
  const {document:row}=await gigabyte.resource('sources',receipt.sourceId);
  assert.equal(row.erp,321);
  assert.equal(row.erpName,erpName);
  assert.equal(row.createdFrom,'erp');
  assert.ok(Date.parse(row.createdAt)>=time-1000&&Date.parse(row.createdAt)<=Date.now()+1000);
  assert.equal(row.name,'ERP 测试配件');
  assert.equal(row.tax,321);
  assert.deepEqual(row.hardwareOverrides,hardware);
  assert.deepEqual(row.capacityOverrides,capacities);
  assert.equal(row.addonText,addon.addonText);
  assert.deepEqual(row.addonChoices,choices);
  const {document:price}=await cost(gigabyte,id);
  assert.equal(price.erp,321);
  assert.equal(price.tax,321);
  assert.equal(price.nasProvisionalTax,true);
  assert.equal(price.nasManualTax,false);
  assert.deepEqual(await existing(),before);
 }finally{await api.close();}
});
