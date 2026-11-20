/** Windows 验收包的回环服务。使用合成三店数据、实际业务 API 与生产角色定义。 */
import {readFile, mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Fault} from '../src/config.mjs';
import {serve} from '../src/http.mjs';
import {LiveStore} from '../src/live-store.mjs';
import {combineImageHandlers,createImageHandler,createImageWriter} from '../src/images.mjs';
import {scopedDatabase} from '../src/shop-scope.mjs';
import {createLanCaseGallery} from '../src/lan-case-gallery.mjs';
import {installSharedSources} from './install-shared-sources.mjs';
import {seedRealSamples} from './real-samples-acceptance.mjs';

const shops = ['intel','gigabyte','jonsbo'];
export const fixtureActor = 'fixture_existing01';
export const fixtureWorkspace = 'workbench-main';
export const fixtureDeployment = 'intel-production-acceptance';

async function seed(db,fixture,sharedSources) {
 for (const file of ['intel-fixture.sql','gigabyte/02-gigabyte-import.sql','jonsbo/02-jonsbo-import.sql',
  'access/04-install-three-operations-private.sql']) await db.exec(await readFile(join(fixture,file),'utf8'));
 let realSamples=null;
 try{realSamples=JSON.parse(await readFile(join(fixture,'real-samples.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 // 正常验收使用合成数据；显式附带真实抽样文件时只导入样本，不连正式服务。
 if(realSamples)await seedRealSamples(db,realSamples);
 else for (const [index,shop] of shops.entries()) {
  await db.query(`INSERT INTO ${shop}_live.sources (source_id,owner_shop,shared,goodsid,name,attrs)
   VALUES ('fixture-cost-history',$1,false,'9900011','测试显卡（含店铺原值）',$2),
          ('fixture-addon-choices',$1,false,'9900012','测试配件（两项加购）',$3)`,[shop,
   JSON.stringify({shopId:shop,tax:220+10*index}),
   JSON.stringify({shopId:shop,tax:160,addonChoices:[
    {id:'fixture-text',goodsId:'',label:'可咨询客服升级',enabled:true,qty:1,originalQty:1,priceCents:null},
    {id:'fixture-add',goodsId:'100001',label:'升级测试配件',enabled:true,qty:1,originalQty:1,priceCents:9900},
   ]})]);
  await db.query(`INSERT INTO ${shop}_live.costs(goodsid,owner_shop,shared,erp,tax,attrs)
   VALUES ('9900011',$1,false,218,$2,'{"name":"测试显卡","stockAvailable":10}'),
          ('9900013',$1,false,314.25,325.50,'{"name":"验收内存","stockAvailable":7}')`,[shop,220+10*index]);
  await db.query(`UPDATE ${shop}_live.costs SET attrs=attrs||'{"name":"测试 CPU","stockAvailable":20}' WHERE goodsid='100001'`);
  await db.query(`UPDATE ${shop}_live.configurations SET fields=fields||'{"product":"测试整机","version":"配置1"}'`);
  await db.query(`INSERT INTO ${shop}_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
   SELECT configuration_id,'actual',position,line_id,slot,goodsid,name,qty,source_id,attrs FROM ${shop}_live.parts WHERE part_kind='display'`);
 }
 await db.exec(await readFile(new URL('../sql/016-shared-case-gallery.sql',import.meta.url),'utf8'));
 if(sharedSources)await installSharedSources(db,{});
 if(realSamples){
  await db.exec(await readFile(new URL('../sql/020-workbench-global-tax.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../sql/021-workbench-alias-addons.sql',import.meta.url),'utf8'));
 }
}

async function openFixture(fixture,folder,sharedSources) {
 const options = folder ? {dataDir:folder} : {};
 const bootstrap = new PGlite(options);
 if (!(await bootstrap.query("SELECT 1 FROM pg_database WHERE datname='diy_workbench'")).rows.length)
  await bootstrap.exec('CREATE DATABASE diy_workbench');
 const loadDataDir = folder ? undefined : await bootstrap.dumpDataDir();
 await bootstrap.close();
 const db = new PGlite({...options,database:'diy_workbench',loadDataDir});
 if (!(await db.query("SELECT to_regclass('intel_live.sources') AS installed")).rows[0].installed)
  await seed(db,fixture,sharedSources);
 return db;
}

export async function startSourceAcceptance({fixture,folder,root,authenticate,tls,verifyError=()=>{},onStartupRequest=null,sharedSources=true}) {
 const db = await openFixture(fixture,folder,sharedSources);
 // 已试用的本机库只修正保存函数，保留用户配置、来源和草稿，不重新导入样本。
 if(sharedSources)await db.exec(await readFile(new URL('../sql/022-shared-source-field-preservation.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../sql/023-shop-manual-tax.sql',import.meta.url),'utf8'));
 let pending = Promise.resolve();
 // PGlite 验收库只使用一个连接，真实 PostgreSQL 使用各店池及各自运行角色。
 const underRole = task => {
  const next = pending.then(task); pending = next.catch(()=>{}); return next;
 };
 const pool = shop => ({
  async query(sql,args) {
   return underRole(async()=>{
    await db.exec('BEGIN; SET LOCAL ROLE diy_api_'+shop+'_production');
    try { return await db.query(sql,args); } finally { await db.exec('ROLLBACK'); }
   });
  },
  connect() {
   return new Promise((resolve,reject)=>{
    underRole(()=>new Promise(release=>resolve({async query(sql,args){
     if (sql.startsWith('BEGIN')) {
      await db.exec(sql);
      return db.exec('SET LOCAL ROLE diy_api_'+shop+'_production');
     }
     try { return await db.query(sql,args); }
     catch(error) { verifyError(error); throw error; }
    },release}))).catch(reject);
   });
  },
 });
 const databases = new Map(), stores = new Map(), handlers = [];
 for (const shop of shops) {
  const scoped = scopedDatabase(pool(shop),shop), upload = join(root,shop);
  await mkdir(upload,{recursive:true});
  const original = join(fixture,shop+'-source','assets');
  const writer = createImageWriter(upload,original);
  stores.set(shop,new LiveStore(scoped,{shopId:shop,writable:true,catalogWritable:true,workspaceWritable:true,
   sharedGallery:true,sharedSources,writeImage:writer}));
  databases.set(shop,scoped);
  handlers.push(createImageHandler(scoped,original,upload));
 }
 const server = serve({authenticate,shopStores:stores,deploymentId:fixtureDeployment,
  serveImage:combineImageHandlers(handlers),lanGallery:createLanCaseGallery(databases)},tls);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 if (onStartupRequest) {
  const reported=new Set();
  server.on('request',(req,res)=>{
   const path=req.url.split('?')[0];
   if (!['/healthz','/api/v1/me','/api/v1/operations/workspace-index','/api/v1/operations/workspace-catalog'].includes(path) ||
    reported.has(path)) return;
   reported.add(path);
   res.once('finish',()=>onStartupRequest(path,res.statusCode));
  });
 }
 const port = server.address().port;
 return {url:(tls?'https:':'http:')+'//127.0.0.1:'+port, db, stores,
  async close() {
   await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
   await pending;
   await db.close();
  }};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
 const [fixture, data] = process.argv.slice(2).map(path => resolve(path));
 const secret = process.env.DIYTOOLS_ACCEPTANCE_TOKEN;
 if (!/^[0-9a-f-]{36}$/.test(secret??'')) throw Error('缺少本机验收会话标识');
 delete process.env.DIYTOOLS_ACCEPTANCE_TOKEN;
 await mkdir(data,{recursive:true});
 const tls = {key:await readFile(join(fixture,'test-key.pem')),cert:await readFile(join(fixture,'test-cert.pem')),
  network:'127.0.0.1',prefix:32};
 const acceptance = await startSourceAcceptance({fixture,folder:join(data,'pg'),root:join(data,'uploads'),tls,
  onStartupRequest:(path,status)=>console.error(status,path),
  authenticate:async header=>{
   const actual = Buffer.from(header??''), expected = Buffer.from('Bearer '+secret);
   if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new Fault('UNAUTHENTICATED',401);
   return {uid:fixtureActor,workspaceId:fixtureWorkspace};
  }});
 const stop = ()=>acceptance.close().finally(()=>process.exit());
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 // 启动端持有 stdin。工作台退出后让验收数据库正常关档。
 process.stdin.on('end',stop);
 process.stdin.resume();
 process.stdout.write(acceptance.url+'\n');
}
