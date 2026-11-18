// 长期服务入口；启动前核对实际库和已批准的独立正式批次。
import pg from 'pg';
import {realpath,stat} from 'node:fs/promises';
import {relative,isAbsolute,sep} from 'node:path';
import {settings} from './config.mjs';
import {createAuth} from './auth.mjs';
import {Store} from './store.mjs';
import {LiveStore} from './live-store.mjs';
import {createImageHandler,createImageWriter,combineImageHandlers} from './images.mjs';
import {serve} from './http.mjs';
import {scopedDatabase} from './shop-scope.mjs';
import {createLanCaseGallery} from './lan-case-gallery.mjs';
const pools=[];
const servers=[];
const listen=(server,port,host)=>new Promise((resolve,reject)=>{
 server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});
});
const nested=(parent,child)=>{
 const path=relative(parent,child);
 return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);
};
async function checkImageRoots(shops){
 const roots=[];
 for(const raw of shops.flatMap(shop=>[shop.imagesRoot,shop.imagesWriteRoot]).filter(Boolean)){
  const path=await realpath(raw),info=await stat(path,{bigint:true});
  // 既拒绝父子目录和符号链接别名，也拒绝指向同一目录的独立挂载。
  if(!info.isDirectory()||roots.some(root=>nested(root.path,path)||nested(path,root.path)||root.dev===info.dev&&root.ino===info.ino))
   throw Error('overlapping image roots');
  roots.push({path,dev:info.dev,ino:info.ino});
 }
}
function connect(pgConfig){
 const pool=new pg.Pool(pgConfig);
 pools.push(pool);
 // 空闲连接断开不会终止整台服务；带业务请求的连接错误仍由当前请求处理。
 pool.on('error',()=>console.error('数据库空闲连接已断开'));
 return pool;
}
try {
 const config=settings();
 const live=config.dataset==='intel_live';
 const groupAccess=config.additionalShops.length>0;
 const profiles=[{...config,shopId:'intel'},...config.additionalShops];
 if(groupAccess)await checkImageRoots(profiles);
 const shopStores=new Map(),imageHandlers=[],galleryDatabases=new Map();
 let store;
 for(const profile of profiles){
  const pool=connect(profile.pg);
  const db=live?scopedDatabase(pool,profile.shopId,{groupAccess}):pool;
  const result=await db.query('SELECT current_database() AS name,current_user AS role');
  if(result.rows[0]?.name!==profile.pg.database||result.rows[0]?.role!==profile.pg.user)throw Error('wrong database or runtime role');
  await db.query('SELECT workspace_id FROM nas_business.members LIMIT 0');
  await db.query('SELECT shop_id,role FROM nas_business.shop_roles LIMIT 0');
  if(live){
   const state=await db.query('SELECT shop_id,batch_id FROM intel_live.bootstrap WHERE shop_id=$1',[profile.shopId]);
   if(state.rows.length!==1||profile.batch&&state.rows[0].batch_id!==profile.batch)throw Error('missing or wrong live bootstrap');
   if(config.catalogWritable||profile.shopId!=='intel')await db.query('SELECT resource_kind FROM intel_live.catalog_shared_editors LIMIT 0');
   if(config.workspaceWritable)await db.query('SELECT operation_id FROM intel_live.workspace_receipts LIMIT 0');
   if(config.sharedGallery){
    await db.query('SELECT gallery_id FROM workbench_gallery.catalog LIMIT 0');
    await db.query('SELECT configurations FROM workbench_gallery.image_references(NULL) WHERE false');
    const {rows:[{installed}]}=await db.query(`SELECT EXISTS(
     SELECT 1 FROM pg_trigger WHERE tgrelid='intel_live.gallery'::regclass AND tgname='share_gallery_original'
      AND tgenabled IN ('O','A') AND tgfoid='workbench_gallery.publish_gallery_asset()'::regprocedure
    ) AS installed`);
    if(!installed)throw Error('missing shared gallery trigger');
   }
   if(config.sharedSources){
    const {rows:[{installed}]}=await db.query("SELECT has_function_privilege('workbench_sources.list(text,text,text,text)','EXECUTE') AS installed");
    if(!installed)throw Error('missing shared source catalog');
   }
   shopStores.set(profile.shopId,new LiveStore(db,{shopId:profile.shopId,writable:config.writable,catalogWritable:config.catalogWritable,
    workspaceWritable:config.workspaceWritable,sharedGallery:config.sharedGallery,sharedSources:config.sharedSources,
    writeImage:config.catalogWritable?createImageWriter(profile.imagesWriteRoot,profile.imagesRoot):null}));
   if(profile.imagesRoot||profile.imagesWriteRoot)imageHandlers.push(createImageHandler(db,profile.imagesRoot,profile.imagesWriteRoot));
   if(config.lanCaseGallery)galleryDatabases.set(profile.shopId,db);
  }else store=new Store(db);
 }
 const handlers={authenticate:createAuth(config),store,shopStores:live?shopStores:null,clientOrigins:config.clientOrigins,deploymentId:config.deploymentId,
  serveImage:combineImageHandlers(imageHandlers),lanGallery:config.lanCaseGallery?createLanCaseGallery(galleryDatabases):null};
 servers.push(serve(handlers,null,{healthOnly:!!config.tls}));
 if(config.tls)servers.push(serve(handlers,config.tls));
 await Promise.all(servers.map((server,i)=>listen(server,i===0?config.port:config.tls.port,i===0?config.host:config.tls.host)));
 console.log(config.tls?'NAS business API ready · LAN TLS enabled':'NAS business API ready');
 const stop=async()=>{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));await Promise.all(pools.map(pool=>pool.end()));process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}catch {
 for(const server of servers)server.close();
 await Promise.allSettled(pools.map(pool=>pool.end()));console.error('启动失败：请核对目标库、导入批次、挂载和监听配置');process.exitCode=1;
}
