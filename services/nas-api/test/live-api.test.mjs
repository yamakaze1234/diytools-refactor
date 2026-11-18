// 通过真实 PG 内核执行 HTTP 编辑回执、权限拒绝、完整回读和回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {request as testHttp} from 'node:http';
import {PNG} from 'pngjs';
import {PGlite} from '@electric-sql/pglite';
import {LiveStore} from '../src/live-store.mjs';
import {serve} from '../src/http.mjs';
import {Fault} from '../src/config.mjs';

const setup=new PGlite();
await setup.exec('CREATE DATABASE diy_workbench_trial');
const db=new PGlite({loadDataDir:await setup.dumpDataDir(),database:'diy_workbench_trial'});
await setup.close();
const source={sourceId:'source-one',shopId:'intel',goodsId:'00012',name:'来源',addonChoices:[{id:'a1',enabled:true,customText:true}]};
const document={id:'config-one',shopId:'intel',productId:'group-one',name:'测试配置',skuId:'000567',spu:'000123',
 workspaceOrder:100,price:123.45,parts:[{lineId:'d',slot:'CPU',goodsId:'00012',name:'展示',qty:1,sourceId:'source-one',erp:2}],
 actualParts:[{lineId:'a',slot:'CPU',goodsId:'',name:'实际',qty:2}],addons:[{text:'手工备注展示',priceCents:null,items:[]}],
 modules:[],posterFields:{name:false},productCardColor:'#123456',compat:{x:null,z:0}};
const assetSha='a'.repeat(64),assetUri='/uploads/'+assetSha+'.png';
const input=[
 ['shop','intel','intel',false,{id:'intel'}],['settings','intel','intel',false,{}],
 ['configuration',document.id,'intel',false,document],['source',source.sourceId,'intel',false,source],
 ['cost','00012','shared',false,{goodsId:'00012',erp:null,tax:0}],
 ['asset',assetUri,'shared',true,{file:'assets/'+assetSha,uri:assetUri,sha256:assetSha,size:128}],
 ['gallery','sample-gallery','shared',false,{id:'sample-gallery',url:assetUri,name:'共用原图',brand:'品牌',model:'型号',color:'黑',edition:'基础'}],
 ['template','sample-template','intel',false,{id:'sample-template',shopId:'intel',name:'初始模板',configs:[document]}],
 ['quotation',document.id,'intel',false,{configuration_id:document.id,workbook_sha256:'1'.repeat(64),source:'maintenance',sheet:'综合表',
  status:'matched',amount_cents:'70000',workbench_price_cents:'12345',difference_cents:'57655',workbook_rows:[5]}],
];
await db.exec("CREATE SCHEMA nas_import; CREATE TABLE nas_import.batches(batch_id text primary key,manifest jsonb,payload_sha256 text,record_count integer); CREATE TABLE nas_import.records(batch_id text,kind text,record_id text,owner_shop text,shared boolean,document jsonb,stored_md5 text);");
await db.query("INSERT INTO nas_import.batches VALUES('test','{\"shop_id\":\"intel\"}',$1,$2)",['0'.repeat(64),input.length]);
for(const [kind,id,owner,shared,doc] of input)
 await db.query("INSERT INTO nas_import.records SELECT 'test',$1,$2,$3,$4,$5::jsonb,md5(($5::jsonb)::text)",[kind,id,owner,shared,JSON.stringify(doc)]);
await db.exec(await readFile(new URL('../sql/003-intel-live.sql',import.meta.url),'utf8'));
await db.exec("CREATE SCHEMA nas_business; CREATE TABLE nas_business.members(workspace_id text,uid text,enabled boolean,PRIMARY KEY(workspace_id,uid)); CREATE TABLE nas_business.shop_roles(workspace_id text,uid text,shop_id text,role text); INSERT INTO nas_business.members VALUES('w','op',true),('w','other',true),('w','sales',true); INSERT INTO nas_business.shop_roles VALUES('w','op','intel','operations'),('w','other','intel','operations'),('w','sales','intel','sales');");
const role=await readFile(new URL('../sql/004-runtime-operations.template.sql',import.meta.url),'utf8');
await db.exec(role.replace('__SET_RANDOM_PASSWORD__','isolated-test-role-secret-without-external-access'));
let pending=Promise.resolve(),roleTx=()=>false;
const pool={query:db.query.bind(db),async connect(){
 // PGlite 单链接，序列化借用；并发业务由生产 PG 的同订单及同配置事务锁控制。
 const wait=pending;let unlock;
 pending=new Promise(resolve=>{unlock=resolve;});await wait;
 return {query:async(sql,args)=>{
  const result=await db.query(sql,args);
  if(sql==='BEGIN'&&roleTx())await db.exec('SET LOCAL ROLE diy_api_operations');
  return result;
 },release:unlock};
}};
const store=new LiveStore(pool,{writable:true});
const auth=[];
let holdAuth=null;
const srv=serve({store,authenticate:async(h,options)=>{
 const uid=h?.slice(7);if(!['op','other','sales'].includes(uid))throw new Fault('UNAUTHENTICATED',401);
 if(holdAuth&&options.fresh){const gate=holdAuth;holdAuth=null;await gate();}
 auth.push({uid,fresh:options.fresh});return {uid,workspaceId:'w'};
}});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const hostname='http://127.0.0.1:'+srv.address().port;
async function request(relative='',{method='GET',body,member='op',role='operations',type='application/json'}={}){
 // 操作系统分配的回环端口有时属于浏览器禁用端口；该隔离 HTTP 测试无需浏览器端口策略。
 return new Promise((resolve,reject)=>{
  const req=testHttp(hostname+'/api/v1/'+role+'/'+relative,{method,
   headers:{'content-type':type,authorization:'Bearer '+member}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
   response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});
  });
  req.on('error',reject);req.end(Buffer.isBuffer(body)||body===undefined?body:JSON.stringify(body));
 });
}
const item='configurations/'+document.id;
const get=async()=> (await request(item)).body.data;
test.after(async()=>{await new Promise(r=>srv.close(r));await db.close();});

test('运营详情完整回组，销售未发布为不可见且无权访问运营明细',async()=>{
 const detail=await get();assert.deepEqual(detail.document,document);
 assert.equal(detail.version,'1');assert.deepEqual(detail.dependencies,{sources:{'source-one':'1'},costs:{'00012':'1'}});
 assert.equal((await request(item,{member:'sales'})).status,403);
 assert.equal((await request(item,{member:'sales',role:'sales'})).status,404);
 const src=await request('sources/source-one');assert.deepEqual(src.body.data.document,source);
});
test('仅有限后台权限下提交并回读同一回执，其他成员不能查询回执',async()=>{
 const current=await get(),operation_id=randomUUID(),body={operation_id,expected_version:'1',dependencies:current.dependencies,document:{...current.document,name:'修改名称',price:111,caseImage:assetUri}};
 roleTx=()=>true;
 try{
  const result=await request(item,{method:'PUT',body});assert.equal(result.status,200,JSON.stringify(result.body));
  const replay=await request(item,{method:'PUT',body});assert.deepEqual(replay.body.data,result.body.data);
  const clash=await request(item,{method:'PUT',body:{...body,document:{...body.document,name:'另一个正文'}}});assert.equal(clash.body.error,'OPERATION_REUSED');
  const stale=await request(item,{method:'PUT',body:{...body,operation_id:randomUUID()}});assert.equal(stale.body.error,'VERSION_CONFLICT');assert.equal(stale.body.details.current_version,'2');
  const report=await request('save-receipts/'+operation_id);assert.deepEqual(report.body.data,result.body.data);
  const forbidden=await request('save-receipts/'+operation_id,{member:'other'});assert.equal(forbidden.status,404);
  assert.equal((await get()).final_price_cents,'70000');
  assert.equal((await get()).image_url,'/images/'+assetSha+'.png');
  const {_unused,...actor}=(await db.query('SELECT actor_uid,previous_version::text,next_version::text FROM intel_live.audit_events')).rows[0];assert.deepEqual(actor,{actor_uid:'op',previous_version:'1',next_version:'2'});
  assert(auth.some(x=>x.fresh));
 }finally{roleTx=()=>false;}
});
test('校验共享版本、素材、身份和角色；拒绝后没有部分记录或回执',async()=>{
 const current=await get(),base={expected_version:current.version,dependencies:current.dependencies,document:current.document};
 const reject=async(override,path=item,member='op')=>{
  const operation_id=randomUUID(),res=await request(path,{method:'PUT',member,body:{operation_id,...override}});
  assert.equal((await request('save-receipts/'+operation_id)).status,404);
  return res.body.error;
 };
 assert.equal(await reject({...base,dependencies:{...base.dependencies,costs:{'00012':'2'}}}),'DEPENDENCY_CONFLICT');
 assert.equal(await reject({...base,document:{...base.document,skuId:'new'}}),'QUOTATION_REVIEW_REQUIRED');
 assert.equal(await reject({expected_version:current.version,design:{caseImage:'/uploads/unknown.png'}},item+'/design'),'VALIDATION_FAILED');
 assert.equal(await reject(base,item,'sales'),'FORBIDDEN');
 assert.deepEqual(await get(),current);
});
test('软删除撤下发布，恢复不会重新发布；新建不填未知售价',async()=>{
 await db.query('INSERT INTO intel_live.publications VALUES($1,true)',[document.id]);
 const sales=()=>request(item,{member:'sales',role:'sales'});
 const visible=await sales();assert.equal(visible.status,200);
 assert.deepEqual(visible.body.data.parts,[{slot:'CPU',name:'展示',qty:1}]);
 assert(!Object.hasOwn(visible.body.data,'document'));
 const old=await get();
 roleTx=()=>true;
 try{
  const requestChange=(leaf,version)=>request(item+'/'+leaf,{method:'POST',body:{operation_id:randomUUID(),expected_version:version}});
  const archived=await requestChange('archive',old.version);assert.equal(archived.status,200,JSON.stringify(archived.body));
  assert.equal((await sales()).status,404);
  assert.equal((await request(item+'?archived=true')).body.data.archived,true);
  assert.equal((await requestChange('restore',archived.body.data.version)).status,200);
  assert.equal((await sales()).status,404);
  const newDoc={...document,id:'new',skuId:'',spu:'',productId:'new-product'};
  const created=await request('configurations',{method:'POST',body:{operation_id:randomUUID(),document:newDoc,dependencies:old.dependencies}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const fresh=(await request('configurations/new')).body.data;assert.equal(fresh.final_price_cents,null);assert.equal(fresh.quotation_status,'not_selected');
 }finally{roleTx=()=>false;}
});
test('写角色不能改接收区、成本、现选报价、权限表或直接发布',async()=>{
 await db.exec('SET ROLE diy_api_operations');
 try{for(const sql of ['SELECT count(*) FROM nas_import.records','UPDATE intel_live.costs SET tax=0','UPDATE intel_live.quotations SET amount_cents=0','UPDATE nas_business.members SET enabled=true','UPDATE intel_live.publications SET published=true','CREATE TABLE intel_live.disallowed(id int)'])await assert.rejects(db.query(sql),/permission denied|权限/);}
 finally{await db.exec('RESET ROLE');}
});
test('主编辑器的目录只开放必要读取权限，摘要不会混入完整文档或内部成本',async()=>{
 const sql=await readFile(new URL('../sql/005-main-editor-catalog-read.sql',import.meta.url),'utf8');
 await db.exec('SET ROLE diy_api_operations');
 try{await assert.rejects(db.query('SELECT settings FROM intel_live.shops'),/permission denied/);}
 finally{await db.exec('RESET ROLE');}
 await db.exec(sql);await db.exec(sql);
 await db.exec('SET ROLE diy_api_operations');
 try{
  const index=await request('workspace-index');
  assert.equal(index.status,200,JSON.stringify(index.body));
  const summary=index.body.data.summaries.find(c=>c.id===document.id);
  assert.equal(summary.productCardColor,'#123456');assert.equal(summary.parts[0].goodsId,'00012');
  assert(!Object.hasOwn(summary.parts[0],'erp'));assert(!Object.hasOwn(summary,'actualParts'));
  const catalog=await request('workspace-catalog');
  assert.equal(catalog.status,200,JSON.stringify(catalog.body));
  assert.deepEqual(catalog.body.data.shopSettings,{intel:{}});
  assert(catalog.body.data.sourceCatalog.some(row=>row.sourceId==='source-one'));
  await assert.rejects(db.query("UPDATE intel_live.shops SET settings='{}'"),/permission denied/);
 }finally{await db.exec('RESET ROLE');}
 assert.equal((await request('workspace-catalog',{member:'sales'})).status,403);
});
test('目录写入：最小角色、共享权限、回执幂等、完整加购快照、模板和图片引用保护',async()=>{
 const sql=await readFile(new URL('../sql/006-catalog-management.sql',import.meta.url),'utf8');
 await db.query(sql);await db.query(sql);
 store.catalog.writable=true;
 // 在测试连接中装入实际有限角色，禁止服务层以数据库所有者隐式绕过策略。
 roleTx=()=>true;
 try{
  const path='catalog/';
  const write=(relative,body,method='PUT',member='op')=>request(path+relative,{method,member,body});
  const op=randomUUID();
  const shared=(await request(path+'gallery/sample-gallery')).body.data;
  assert.equal(shared.owner_shop,'shared');assert.equal(shared.shared,false);assert.equal(shared.editable,false);
  assert.equal((await write('gallery/sample-gallery',{operation_id:op,expected_version:'1',document:shared.document})).body.error,'CATALOG_SHARED_READ_ONLY');
  const copy=await write('gallery/sample-gallery/copy',{operation_id:randomUUID(),expected_version:'1',target_id:'intel-gallery'},'POST');
  assert.equal(copy.status,201,JSON.stringify(copy.body));
  const privateCopy=(await request(path+'gallery/intel-gallery')).body.data;
  assert.equal(privateCopy.owner_shop,'intel');assert.equal(privateCopy.editable,true);assert.equal(privateCopy.document.url,assetUri);
  const control={operation_id:randomUUID(),expected_version:'1',document:{...privateCopy.document,name:'新名'}};
  const saved=await write('gallery/intel-gallery',control);
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual((await write('gallery/intel-gallery',control)).body.data,saved.body.data);
  assert.equal((await write('gallery/intel-gallery',{...control,document:{...control.document,name:'变更正文'}})).body.error,'OPERATION_REUSED');
  assert.equal((await write('gallery/intel-gallery/archive',{operation_id:randomUUID(),expected_version:'2'},'POST')).body.error,'CATALOG_IN_USE');
  assert.equal((await request(path+'receipts/'+control.operation_id,{member:'other'})).status,404);
  assert.equal((await write('gallery/intel-gallery',control,'PUT','sales')).status,403);
  const template=(await request(path+'templates/sample-template')).body.data;
  const t=await write('templates/sample-template',{operation_id:randomUUID(),expected_version:'1',document:{...template.document,name:'改模板名'}});
  assert.equal(t.status,200,JSON.stringify(t.body));assert.deepEqual(t.body.data.document.configs,template.document.configs);
  const addon=(await request(path+'addons/source-one')).body.data;
  const changed=await write('addons/source-one',{operation_id:randomUUID(),expected_version:addon.version,
   document:{sourceId:'source-one',shopId:'intel',addonText:'调整定义',addonPriceCents:null,addonChoices:[]}});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  assert.deepEqual((await get()).document.addons,document.addons);
  const sourceDoc=(await request(path+'sources/source-one')).body.data;
  assert.equal(sourceDoc.document.addonPriceCents,null);assert.deepEqual(sourceDoc.document.addonChoices,[]);
  assert.equal((await write('sources/source-one/archive',{operation_id:randomUUID(),expected_version:sourceDoc.version},'POST')).body.error,'CATALOG_IN_USE');
  await db.query("INSERT INTO intel_live.catalog_shared_editors VALUES('w','op','gallery')");
  assert.equal((await request(path+'gallery/sample-gallery')).body.data.editable,true);
  assert.equal((await write('gallery/sample-gallery',{operation_id:randomUUID(),expected_version:'1',document:{...shared.document,name:'共享受托'}})).status,200);
  await db.query("DELETE FROM intel_live.catalog_shared_editors WHERE uid='op'");
  assert.equal((await write('gallery/sample-gallery',{operation_id:randomUUID(),expected_version:'2',document:shared.document})).body.error,'CATALOG_SHARED_READ_ONLY');
  const counts=(await db.query("SELECT (SELECT count(*) FROM intel_live.catalog_receipts)::int AS receipts,(SELECT count(*) FROM intel_live.catalog_audit)::int AS audits")).rows[0];
  assert.deepEqual(counts,{receipts:5,audits:5});
 }finally{roleTx=()=>false;store.catalog.writable=false;}
});

test('显式跟随与快照分离，销售看有效结构化加购，来源改版阻止旧依赖提交',async()=>{
 const sql=await readFile(new URL('../sql/006-catalog-management.sql',import.meta.url),'utf8');
 await db.query(sql);store.catalog.writable=true;
 roleTx=()=>true;
 try{
  const update=async(text,amount,expected)=>{
   const response=await request('catalog/addons/source-one',{method:'PUT',body:{operation_id:randomUUID(),expected_version:expected,
    document:{sourceId:'source-one',shopId:'intel',addonText:text,addonNote:'私有说明',
     addonGoodsId:'00012',addonPriceCents:amount,addonQty:2,addonOriginalQty:1}}});
   assert.equal(response.status,200,JSON.stringify(response.body));return response.body.data;
  };
  const initial=(await request('catalog/addons/source-one')).body.data.version,first=await update('初次共享定义',1500,initial);
  const detail=await get();
  const snapshot={text:'历史已保存文案',items:[{goodsId:'00012',qty:3}],priceCents:2500};
  const follow={text:'初次人工快照',sourceId:'source-one',followPolicy:'follow',items:[{goodsId:'00012',qty:4}],priceCents:3100};
  const result=await request(item,{method:'PUT',body:{operation_id:randomUUID(),expected_version:detail.version,dependencies:detail.dependencies,
   document:{...detail.document,addons:[snapshot,follow]}}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const baseline=await get();assert.deepEqual(baseline.document.addons,[snapshot,follow]);assert.equal(baseline.effective_addons[1].addon.text,'初次共享定义');
  await update('共享定义新版本',1700,first.version);
  const changed=await get();assert.deepEqual(changed.document.addons,[snapshot,follow]);assert.equal(changed.effective_addons[1].addon.text,'共享定义新版本');
  assert.equal(changed.effective_addons[1].addon.items[0].qty,2);assert.equal(changed.effective_addons[0].addon.items[0].qty,3);
  const stale=await request(item,{method:'PUT',body:{operation_id:randomUUID(),expected_version:baseline.version,dependencies:baseline.dependencies,
   document:{...baseline.document,name:'旧依赖应失败'}}});
  assert.equal(stale.body.error,'DEPENDENCY_CONFLICT');
  await db.query('UPDATE intel_live.publications SET published=true WHERE configuration_id=$1',[document.id]);
  const sales=(await request(item+'/addons',{member:'sales',role:'sales'})).body.data;
  assert.deepEqual(sales.map(x=>[x.description,x.additional_price_cents,x.items[0].qty]),[['历史已保存文案','2500',3],['共享定义新版本','1700',2]]);
  assert.doesNotMatch(JSON.stringify(sales),/私有说明|sourceId|erp|tax/);
  const blockedArchive=await request('catalog/sources/source-one/archive',{method:'POST',body:{operation_id:randomUUID(),expected_version:changed.dependencies.sources['source-one']}});
  assert.equal(blockedArchive.body.error,'CATALOG_IN_USE');
  const disabled=await request('catalog/addons/source-one',{method:'PUT',body:{operation_id:randomUUID(),expected_version:changed.dependencies.sources['source-one'],
   document:{sourceId:'source-one',shopId:'intel',addonChoices:[{id:'disabled',label:'已停用',enabled:false,goodsId:'00012',qty:2,priceCents:1700}]}}});
  assert.equal(disabled.status,200,JSON.stringify(disabled.body));
  const noOffers=await get();
  assert.deepEqual(noOffers.document.addons,[snapshot,follow]);assert.equal(noOffers.effective_addons[1].available,false);
  const staleDisabled=await request(item,{method:'PUT',body:{operation_id:randomUUID(),expected_version:changed.version,dependencies:changed.dependencies,
   document:{...changed.document,name:'停用后旧依赖应失败'}}});
  assert.equal(staleDisabled.body.error,'DEPENDENCY_CONFLICT');
  assert.deepEqual((await request(item+'/addons',{member:'sales',role:'sales'})).body.data.map(x=>x.description),['历史已保存文案']);
 }finally{roleTx=()=>false;store.catalog.writable=false;}
});
test('图片上传完整解码、按原申请号返回回执、以摘要登记并保护历史引用',async()=>{
 await db.query(await readFile(new URL('../sql/006-catalog-management.sql',import.meta.url),'utf8'));
 store.catalog.writable=true;roleTx=()=>true;
 const written=[];
 store.catalog.writeImage=async image=>{written.push(image);};
 try{
  const png=new PNG({width:1,height:1});png.data.fill(170);
  const bytes=PNG.sync.write(png),digest=createHash('sha256').update(bytes).digest('hex'),url='/uploads/'+digest+'.png';
  const op=randomUUID(),upload=(id,body,member='op')=>request('catalog/assets?operation_id='+id,{method:'POST',body,type:'image/png',member});
  assert.equal((await upload(randomUUID(),bytes,'sales')).status,403);
  assert.equal((await upload(randomUUID(),bytes.subarray(0,40))).body.error,'INVALID_IMAGE');
  const result=await upload(op,bytes);assert.equal(result.status,201,JSON.stringify(result.body));
  assert.deepEqual(result.body.data.document,{url,sha256:digest,mime:'image/png',width:1,height:1});
  assert.deepEqual((await upload(op,bytes)).body.data,result.body.data);
  assert.deepEqual((await request('catalog/receipts/'+op)).body.data,result.body.data);
  assert.equal(written.length,1);assert(written[0].bytes.equals(bytes));
  const old=(await request('catalog/gallery/sample-gallery')).body.data;
  await db.query("INSERT INTO intel_live.catalog_shared_editors VALUES('w','op','gallery') ON CONFLICT DO NOTHING");
  const replacement=await request('catalog/gallery/sample-gallery',{method:'PUT',body:{operation_id:randomUUID(),expected_version:old.version,document:{...old.document,url}}});
  assert.equal(replacement.status,200,JSON.stringify(replacement.body));
  assert.equal((await get()).document.caseImage,assetUri);
  assert.deepEqual((await db.query('SELECT legacy_uri FROM intel_live.assets ORDER BY legacy_uri')).rows.map(a=>a.legacy_uri).sort(),[url,assetUri].sort());
 }finally{
  await db.query("DELETE FROM intel_live.catalog_shared_editors WHERE uid='op'");
  roleTx=()=>false;store.catalog.writable=false;store.catalog.writeImage=null;
 }
});
test('以当前模板版本和已操作目标配置版本整组应用，失败完全回滚，不复用平台SKU或报价',async()=>{
 await db.query(await readFile(new URL('../sql/006-catalog-management.sql',import.meta.url),'utf8'));
 store.catalog.writable=true;roleTx=()=>true;
 try{
  const base=await get(),template=(await request('catalog/templates/sample-template')).body.data;
  const generated=randomUUID(),reused=randomUUID();
  const body={operation_id:randomUUID(),expected_version:template.version,target_product_id:base.document.productId,
   target_configuration_id:base.document.id,expected_target_version:base.version,
   selection:[{source_id:template.document.configs[0].id,id:generated},{source_id:'missing',id:reused}]};
  const act=body=>request('catalog/templates/sample-template/apply',{method:'POST',body});
  const bad=await act(body);assert.equal(bad.body.error,'VALIDATION_FAILED');
  assert.equal((await request('configurations/'+generated)).status,404);
  const stale=await act({...body,operation_id:randomUUID(),expected_target_version:'1',selection:body.selection.slice(0,1)});
  assert.equal(stale.body.error,'VERSION_CONFLICT');
  const good={...body,operation_id:randomUUID(),selection:body.selection.slice(0,1)};
  const response=await act(good);
  assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body.data.document.configuration_ids,[generated]);
  assert.deepEqual((await act(good)).body.data,response.body.data);
  const saved=(await request('configurations/'+generated)).body.data;
  assert.equal(saved.document.productId,base.document.productId);assert.equal(saved.document.skuId,'');assert.equal(saved.document.spu,base.document.spu);
  assert.equal(saved.final_price_cents,null);assert.deepEqual(saved.document.compat,template.document.configs[0].compat);
  assert.equal((await request('catalog/templates/sample-template')).body.data.version,template.version);
 }finally{roleTx=()=>false;store.catalog.writable=false;}
});

test('工作区批量整批回滚、回执一致、成员和跨接口操作号隔离',async()=>{
 const sql=await readFile(new URL('../sql/007-workspace-operations.sql',import.meta.url),'utf8');
 await db.query(sql);await db.query(sql);
 store.workspaceWritable=true;store.catalog.workspaceWritable=true;store.catalog.writable=true;roleTx=()=>true;
 try{
  const first=randomUUID(),second=randomUUID(),op=randomUUID(),groupId=randomUUID();
  const payload={operation_id:op,group:{product_id:groupId,configuration_ids:[]},changes:[first,second].map(id=>({id,action:'create',
   document:{id,productId:groupId,shopId:'intel',name:'批量样本',skuId:'',spu:'',price:0,workspaceOrder:20,parts:[],actualParts:[],addons:[],modules:[],unknown:{x:null,z:0}},
   dependencies:{costs:{},sources:{}}}))};
  const send=(body,member='op')=>request('workspace/configurations',{method:'POST',member,body});
  const bad={...payload,changes:[payload.changes[0],{id:second,action:'archive',expected_version:'1'}]};
  assert.equal((await send(bad)).status,404);
  assert.equal((await request('configurations/'+first)).status,404);
  assert.equal((await request('workspace/receipts/'+op)).status,404);
  const done=await send(payload);assert.equal(done.status,200,JSON.stringify(done.body));
  assert.deepEqual(done.body.data,(await send(payload)).body.data);
  assert.deepEqual(done.body.data,(await request('workspace/receipts/'+op)).body.data);
  assert.equal((await request('workspace/receipts/'+op,{member:'other'})).status,404);
  assert.equal((await send({...payload,operation_id:randomUUID()},'sales')).status,403);
  assert.equal((await send({...payload,operation_id:randomUUID()})).body.error,'PRODUCT_MEMBERS_CHANGED');
  assert.equal((await request('configurations/'+first+'/archive',{method:'POST',body:{operation_id:op,expected_version:'1'}})).body.error,'OPERATION_REUSED');
  const archived=await send({operation_id:randomUUID(),changes:[first,second].map(id=>({id,action:'archive',expected_version:'1'}))});
  assert.equal(archived.status,200,JSON.stringify(archived.body));
  assert.deepEqual(archived.body.data.changes.map(r=>r.archived),[true,true]);
  assert.deepEqual((await request('configurations/'+first+'?archived=true')).body.data.document.unknown,{x:null,z:0});
  const receiptRows=(await db.query('SELECT count(*)::int AS total FROM intel_live.workspace_audit WHERE operation_id=$1',[op])).rows;
  assert.equal(receiptRows[0].total,2);
 }finally{roleTx=()=>false;store.workspaceWritable=false;store.catalog.workspaceWritable=false;store.catalog.writable=false;}
});

test('原 HTTP 写仍在途中且查到404时，原编号重放只产生一个版本和一条审计',async()=>{
 const id=randomUUID(),operation_id=randomUUID(),target='configurations/'+id;
 const document={id,shopId:'intel',productId:randomUUID(),name:'隔离配置',spu:'',skuId:'',price:null,workspaceOrder:800,parts:[],actualParts:[],addons:[]};
 const dependencies={sources:{},costs:{}};
 const created=await request('configurations',{method:'POST',body:{operation_id:randomUUID(),document,dependencies}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const body={operation_id,expected_version:created.body.data.version,dependencies,document:{...document,name:'仍在途的原提交'}};
 let release,arrive;
 const inFlight=new Promise(resolve=>{arrive=resolve;});
 // 在 HTTP 认证段暂停原请求，模拟网络中间层延迟。隔离 PGlite 不模拟双连接锁等待。
 holdAuth=()=>new Promise(resolve=>{release=resolve;arrive();});
 const original=request(target,{method:'PUT',body});
 try{
  await inFlight;
  assert.equal((await request('save-receipts/'+operation_id)).status,404);
  const replay=await request(target,{method:'PUT',body});
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  release();
  const late=await original;
  assert.equal(late.status,200);assert.deepEqual(late.body.data,replay.body.data);
  assert.equal((await request(target)).body.data.version,'2');
  const counts=(await db.query(`SELECT
   (SELECT count(*)::int FROM intel_live.save_receipts WHERE operation_id=$1) AS receipts,
   (SELECT count(*)::int FROM intel_live.audit_events WHERE operation_id=$1) AS audits`,[operation_id])).rows[0];
  assert.deepEqual(counts,{receipts:1,audits:1});
 }finally{holdAuth=null;release?.();await original;}
});

test('更新成本后按实际 BOM 保存价格前后、原编号去重、NAS 检测使用工作台到手价',async()=>{
 const migration=await readFile(new URL('../sql/011-operations-price-history.sql',import.meta.url),'utf8');
 await db.query(migration);await db.query(migration);
 await db.query(await readFile(new URL('../sql/010-profit-observations.sql',import.meta.url),'utf8'));
 store.workspaceWritable=true;store.catalog.workspaceWritable=true;roleTx=()=>true;
 try{
  const id=randomUUID(),part={lineId:'cpu',slot:'CPU',goodsId:'00012',name:'测试配件',qty:2,erp:null,tax:0};
  const created=await request('configurations',{method:'POST',body:{operation_id:randomUUID(),
   document:{id,shopId:'intel',productId:randomUUID(),name:'测试价格观察',skuId:'',spu:'',price:300,workspaceOrder:50,parts:[],actualParts:[part],addons:[]},
   dependencies:{sources:{},costs:{'00012':'1'}}}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const changes={operation_id:randomUUID(),changes:[{id:'00012',action:'tax_edit',expected_version:'1',fields:{tax:10}}]};
  const write=body=>request('workspace/costs',{method:'POST',body});
  const result=await write(changes);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.deepEqual((await write(changes)).body.data,result.body.data);
  const read=(action,body={},member='op')=>request('workspace/price-history/'+action,{method:'POST',body,member});
  const list=await read('list',{},'other');assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.data.batches.length,1);
  const revision=list.body.data.batches[0].revision;
  const detail=(await read('detail',{revision})).body.data;
  const line=detail.items.find(item=>item.goodsId==='00012');
  assert.deepEqual([line.before.tax,line.after.tax],[0,1000]);assert(line.configIds.includes(id));
  const row=detail.configs.find(row=>row.after.id===id);
  assert.equal(row.after.price,300);assert.equal(row.before.loggedProfit.tax-row.after.loggedProfit.tax,2000);
  assert.equal((await read('handle',{revision,configId:id,handled:true},'other')).status,200);
  assert((await read('detail',{revision})).body.data.handled.includes(id));
  assert.equal((await read('list',{},'sales')).status,403);
  assert.equal((await read('day')).body.data.baselineKnown,false);
  assert((await request('workspace/source-usage',{method:'POST',body:{sources:[],goods:['00012']}})).body.data.includes(id));
  const start=await request('workspace/profit/start',{method:'POST',body:{shopId:'intel',requestId:randomUUID(),configIds:[id]}});
  assert.equal(start.status,200,JSON.stringify(start.body));
  const checked=await request('workspace/profit/status',{method:'POST',body:{shopId:'intel',runId:start.body.data.runId}});
  assert.equal(checked.status,200,JSON.stringify(checked.body));
  assert.equal(checked.body.data.results[0].snapshot.priceCents,30000);
  assert.equal(checked.body.data.results[0].cost_cents,2000);
  const rollback=await write({operation_id:randomUUID(),changes:[{...changes.changes[0],expected_version:'2',fields:{tax:20}},
   {id:'00013',action:'tax_edit',expected_version:'99',fields:{tax:20}}]});
  assert.equal(rollback.status,409);assert.equal((await read('list')).body.data.batches.length,1);
 }finally{roleTx=()=>false;store.workspaceWritable=false;store.catalog.workspaceWritable=false;}
});

test('模板简称保留人工值，仅成功应用的同一事务归档空白占位',async()=>{
 store.workspaceWritable=true;store.catalog.workspaceWritable=true;store.catalog.writable=true;roleTx=()=>true;
 try{
  const target=randomUUID(),productId=randomUUID(),configId=randomUUID(),path='catalog/templates/sample-template';
  const blank={id:target,shopId:'intel',productId,name:'空白占位',skuId:'',spu:'',price:null,workspaceOrder:1,parts:[],actualParts:[],addons:[],benefits:[],emptyLinkDraft:true};
  const created=await request('configurations',{method:'POST',body:{operation_id:randomUUID(),document:blank,dependencies:{sources:{},costs:{}}}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const original=(await request(path)).body.data;
  const template={...original.document,configs:original.document.configs.map(c=>({...c,shortName:'人工模板简称',shortNameAuto:false}))};
  const saved=await request(path,{method:'PUT',body:{operation_id:randomUUID(),expected_version:original.version,document:template}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const body={operation_id:randomUUID(),expected_version:saved.body.data.version,target_product_id:productId,target_configuration_id:target,
   expected_target_version:'1',selection:[{id:configId,source_id:template.configs[0].id}],name_format:'compact',replace_manual_names:false,archive_empty_target:true};
  const send=data=>request(path+'/apply',{method:'POST',body:data});
  assert.equal((await send({...body,expected_target_version:'9'})).status,409);
  assert.equal((await request('configurations/'+target)).status,200);
  const applied=await send(body);assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(applied.body.data.document.archived_placeholder_id,target);
  assert.deepEqual((await send(body)).body.data,applied.body.data);
  assert.equal((await request('configurations/'+target)).status,404);
  const archived=(await request('configurations/'+target+'?archived=true')).body.data;
  assert.equal(archived.version,'2');assert(archived.archived_at);
  const made=(await request('configurations/'+configId)).body.data.document;
  assert.equal(made.name,'配置1');assert.equal(made.shortName,'人工模板简称');assert.equal(made.skuId,'');
 }finally{roleTx=()=>false;store.workspaceWritable=false;store.catalog.workspaceWritable=false;store.catalog.writable=false;}
});
