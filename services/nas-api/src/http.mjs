// HTTP 层统一验证身份、店铺范围及请求体；运行区与旧样本不会混读。
import {createServer} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {BlockList,isIPv4} from 'node:net';
import {randomUUID} from 'node:crypto';
import {Fault,requireValue} from './config.mjs';
import {authorize} from './store.mjs';
import {operationId} from './live-store.mjs';
import {readImageUpload} from './images.mjs';

const identifier=raw=>{
 let value;try{value=decodeURIComponent(raw);}catch{throw new Fault('INVALID_REQUEST',400);}
 requireValue(value.length>0&&value.length<=256&&value!=='.'&&value!=='..'&&!/[\x00-\x1f\x7f]/.test(value));
 return value;
};
const activityKinds=new Set(['configurations','sources','shared-sources','costs','addons','gallery','templates','settings','quotations','assets']);
function activityFilters({from=null,to=null,actor=null,kind=null}){
 const validDate=value=>{
  if(value===null)return true;
  if(typeof value!=='string'||!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))return false;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().startsWith(value+'T');
 };
 // UID 与认证层使用相同的文本边界，也接受系统清理标识。
 requireValue(validDate(from)&&validDate(to)&&(!from||!to||from<=to)&&
  (actor===null||(typeof actor==='string'&&actor.trim()===actor&&actor.length>0&&actor.length<=256&&!/[\x00-\x1f\x7f]/.test(actor)))&&
  (kind===null||activityKinds.has(kind)));
 return {from,to,actor,kind};
}
async function jsonBody(req,limit=1024*1024){
 requireValue(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''),'INVALID_CONTENT_TYPE',415);
 const parts=[];let size=0,tooLarge=false;
 requireValue(!req.headers['content-length']||Number(req.headers['content-length'])<=limit,'PAYLOAD_TOO_LARGE',413);
 for await(const piece of req){size+=piece.length;if(size>limit)tooLarge=true;else parts.push(piece);}
 requireValue(!tooLarge,'PAYLOAD_TOO_LARGE',413);
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
 catch{throw new Fault('INVALID_JSON',400);}
}
function capabilities(store,operations,dataSource){
 return {data_source:dataSource,configuration_writes:operations&&store?.writable===true,
  catalog_writes:operations&&store?.catalog?.writable===true,
  ...(store?.sharedSources?{shared_sources:operations}:{}),
  workspace_writes:operations&&store?.workspaceWritable===true,image_upload:operations&&!!store?.catalog?.writeImage};
}
export function createHandler({authenticate,store:defaultStore,shopStores=null,serveImage,clientOrigins=[],deploymentId=null,lanGallery=null,localAuth=null,authMode='cloud'}){
 const live=!!shopStores||typeof defaultStore?.lookupReceipt==='function';
 return async(req,res)=>{
  const requestId=randomUUID(),cors={};
  const send=(status,value)=>{
   if(res.headersSent){res.destroy();return;}
   res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId,
    ...(deploymentId?{'x-workbench-deployment':deploymentId}:{}),...cors});
   res.end(JSON.stringify({...value,request_id:requestId}));
  };
  try{
   const url=new URL(req.url,'http://localhost'),method=req.method;
   if(url.pathname==='/healthz'&&method==='GET')return send(200,{ok:true,checks:{process:true},...(deploymentId?{deployment_id:deploymentId}:{}),
    ...(localAuth?{auth_mode:authMode}:{})});
   if(url.pathname.startsWith('/case-gallery/v1/')){
    // 无账号入口在 TLS 的真实来源检查之后执行，只开放图库列表与在用原图。
    requireValue(lanGallery&&serveImage,'NOT_FOUND',404);
    if(url.pathname==='/case-gallery/v1/images'){
     requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
     return send(200,{ok:true,...await lanGallery.list(url.searchParams)});
    }
    const download=/^\/case-gallery\/v1\/download\/([0-9a-f]{64})\.(png|jpg|jpeg)$/.exec(url.pathname);
    requireValue(download,'NOT_FOUND',404);
    requireValue(method==='GET'||method==='HEAD','METHOD_NOT_ALLOWED',405);
    requireValue(!url.search,'INVALID_REQUEST',400);
    const [,sha,extension]=download;
    requireValue(await lanGallery.hasImage(sha,extension),'NOT_FOUND',404);
    return await serveImage(sha,extension,req,res,{download:true});
   }
   const image=/^\/images\/([0-9a-f]{64})\.(png|jpg|jpeg)$/.exec(url.pathname);
   if(image&&serveImage&&['GET','HEAD'].includes(method))return await serveImage(image[1],image[2],req,res);
   if(req.headers.origin&&clientOrigins.includes(req.headers.origin)){
    cors['access-control-allow-origin']=req.headers.origin;
    cors.vary='Origin';
   }
   if(method==='OPTIONS'){
    requireValue(cors['access-control-allow-origin']&&url.pathname.startsWith('/api/v1/'),'FORBIDDEN',403);
    res.writeHead(204,{...cors,'access-control-allow-methods':'GET, POST, PUT','access-control-allow-headers':'authorization,content-type'+(deploymentId?',x-workbench-deployment':''),'access-control-max-age':'300'});res.end();return;
   }
   // 正式服务在认证和任何读写前拒绝旧试验程序或错误环境；匿名原图仍按摘要访问。
   if(deploymentId)requireValue(req.headers['x-workbench-deployment']===deploymentId,'NAS_DEPLOYMENT_MISMATCH',409);
   if(url.pathname.startsWith('/api/v1/auth/')){
    // 登录凭据只允许原生 HTTPS 客户端提交，WebView 不直接持有令牌。
    requireValue(localAuth,'NOT_FOUND',404);
    requireValue(!req.headers.origin&&!url.search,'FORBIDDEN',403);
    requireValue(method==='POST','METHOD_NOT_ALLOWED',405);
    const body=await jsonBody(req,16*1024);
    switch(url.pathname.slice('/api/v1/auth/'.length)){
    case 'login': return send(200,{ok:true,...await localAuth.login(body,req.socket.remoteAddress)});
    case 'refresh': return send(200,{ok:true,...await localAuth.refresh(body)});
    case 'logout': return send(200,{ok:true,...await localAuth.logout(body)});
    case 'session': return send(200,{ok:true,...await localAuth.authenticate(req.headers.authorization)});
    default: throw new Fault('NOT_FOUND',404);
    }
   }
   const write=method==='POST'||method==='PUT';
   const member=await authenticate(req.headers.authorization,{fresh:live&&write});
   // 写请求额外在数据库事务内重新核对运营权限，读请求也不缓存本地授权。
   if(url.pathname==='/api/v1/me'){
    requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
    const shopCapabilities={};
    const roles=shopStores?(await Promise.all([...shopStores].map(async([shopId,store])=>{
     const local=(await store.roles(member)).filter(role=>role.shop_id===shopId);
     if(local.length)shopCapabilities[shopId]=capabilities(store,local.some(row=>row.role==='operations'),store.dataSource);
     return local;
    }))).flat():await defaultStore.roles(member);
    requireValue(roles.length,'FORBIDDEN',403);
    return send(200,{ok:true,uid:member.uid,workspace_id:member.workspaceId,shops:roles,...(deploymentId?{deployment_id:deploymentId}:{}),...(live?{
     ...capabilities(shopStores?shopStores.get('intel'):defaultStore,roles.some(r=>r.shop_id==='intel'&&r.role==='operations'),'intel_live'),
     ...(shopStores?{shop_capabilities:shopCapabilities}:{})
    }:{})});
   }
   if(!live)requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
   const prefixes=/^\/api\/v1\/(operations|sales)\//.exec(url.pathname);
   requireValue(prefixes,'NOT_FOUND',404);
   // 旧客户端默认使用英特尔；显式参数只能选已启动的一个店。
   const sales=prefixes[1]==='sales',shop=url.searchParams.get('shop_id')??'intel';
   if(sales)requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
   requireValue(url.searchParams.getAll('shop_id').length<=1);
   const store=shopStores?shopStores.get(shop):defaultStore;
   requireValue(store&&(!live||shopStores||shop==='intel'),'FORBIDDEN',403);
   authorize(await store.roles(member),shop,sales);
   const catalogRoute=live&&!sales&&/^\/api\/v1\/operations\/catalog\/(sources|addons|gallery|templates|assets|receipts|shared-sources)(?:\/([^/]+)(?:\/(archive|restore|copy|apply|purge))?)?$/.exec(url.pathname);
   const isUpload=catalogRoute?.[1]==='assets'&&!catalogRoute[2]&&method==='POST';
   const activityPage=live&&!sales&&url.pathname==='/api/v1/operations/workspace/activity';
   const allowed=activityPage?['shop_id','page','page_size','from','to','actor','kind']:catalogRoute?['shop_id',...(isUpload?['operation_id']:[])]:live&&!sales?['shop_id','limit','offset','search','archived']:['shop_id','limit','offset','search'];
   for(const key of url.searchParams.keys())requireValue(allowed.includes(key)&&url.searchParams.getAll(key).length===1);
   const workspaceRoute=live&&!sales&&/^\/api\/v1\/operations\/workspace\/(configurations|receipts|import-preview|costs|settings|quotations|activity|profit|source-usage|price-history)(?:\/([^/]+))?$/.exec(url.pathname);
   if(workspaceRoute){
    const [,kind,id]=workspaceRoute;
    requireValue(activityPage||[...url.searchParams.keys()].every(key=>key==='shop_id'));
    if(kind==='profit'){
     requireValue(method==='POST'&&['start','status','history','reset'].includes(id),'METHOD_NOT_ALLOWED',405);
     return send(200,{ok:true,data:await store.workspaceProfit(member,shop,id,await jsonBody(req))});
    }
    if(kind==='price-history'){
     requireValue(method==='POST'&&['list','detail','day','handle'].includes(id),'METHOD_NOT_ALLOWED',405);
     return send(200,{ok:true,data:await store.workspacePriceHistory(member,id,await jsonBody(req))});
    }
    if(kind==='receipts'){
     requireValue(method==='GET'&&id&&operationId(id),'METHOD_NOT_ALLOWED',405);
     return send(200,{ok:true,data:await store.workspaceReceipt(member,shop,id)});
    }
    if(kind==='activity'){
     if(id==='purge'){
      requireValue(method==='POST','METHOD_NOT_ALLOWED',405);
      requireValue(store.workspaceWritable,'WRITES_DISABLED',405);
      const body=await jsonBody(req,8192);
      requireValue(body&&typeof body==='object'&&!Array.isArray(body)&&
       Object.keys(body).every(key=>['from','to','actor','kind','dry_run'].includes(key))&&
       (!Object.hasOwn(body,'dry_run')||typeof body.dry_run==='boolean'));
      const data=await store.purgeWorkspaceActivity(member,shop,{...activityFilters(body),dryRun:body.dry_run??false});
      return send(200,{ok:true,data});
     }
     requireValue(method==='GET'&&!id,'METHOD_NOT_ALLOWED',405);
     if([...url.searchParams.keys()].some(key=>key!=='shop_id')){
      // 旧的无参数读保留数组合同，只有原操作记录界面走真实分页。
      const page=url.searchParams.get('page')??'0',size=url.searchParams.get('page_size')??'30';
      const filters=activityFilters({from:url.searchParams.get('from')||null,to:url.searchParams.get('to')||null,
       actor:url.searchParams.get('actor'),kind:url.searchParams.get('kind')});
      requireValue(/^\d{1,7}$/.test(page)&&/^\d{1,3}$/.test(size)&&Number(size)>=1&&Number(size)<=100);
      return send(200,{ok:true,data:await store.workspaceActivityPage(member,{...filters,page:Number(page),size:Number(size)})});
     }
     return send(200,{ok:true,data:await store.workspaceActivity(member,200)});
    }
    if(kind==='costs'&&id==='sync-preview'&&method==='GET')
     return send(200,{ok:true,data:await store.workspaceCostSyncSnapshot(member,shop)});
    if(kind==='quotations'&&method==='GET'&&id)
     return send(200,{ok:true,data:await store.workspaceQuotations(shop,identifier(id))});
    requireValue(method==='POST'&&!id,'METHOD_NOT_ALLOWED',405);
    if(kind==='source-usage')return send(200,{ok:true,data:await store.workspaceSourceUsage(shop,await jsonBody(req))});
    if(kind==='import-preview')return send(200,{ok:true,data:await store.workspaceImportPreview(await jsonBody(req))});
    if(kind!=='configurations')return send(200,{ok:true,data:await store.workspaceMaintain(member,shop,kind,await jsonBody(req),requestId)});
    return send(200,{ok:true,data:await store.workspaceBatch(member,shop,await jsonBody(req),requestId)});
   }
   if(catalogRoute){
    const kind=catalogRoute[1],id=catalogRoute[2]?identifier(catalogRoute[2]):null,extra=catalogRoute[3];
    requireValue(extra!=='purge'||kind==='sources','METHOD_NOT_ALLOWED',405);
    if(kind==='receipts'){
     requireValue(method==='GET'&&id&&!extra&&operationId(id),'METHOD_NOT_ALLOWED',405);
     return send(200,{ok:true,data:await store.catalog.receipt(member,shop,id)});
    }
    if(isUpload){
     requireValue(store.catalog.writable&&store.catalog.writeImage,'IMAGE_UPLOAD_DISABLED',405);
     const operation_id=url.searchParams.get('operation_id');requireValue(operationId(operation_id));
     const image=await readImageUpload(req);
     return send(201,{ok:true,data:await store.catalog.save(member,shop,kind,image.uri,'upload',{operation_id},requestId,image)});
    }
    requireValue(kind!=='assets','METHOD_NOT_ALLOWED',405);
    if(method==='GET'&&!extra)return send(200,{ok:true,data:await store.catalog.list(member,kind,id)});
    requireValue(store.catalog.writable,'WRITES_DISABLED',405);
    const action=method==='POST'&&id&&extra?extra:method==='POST'&&!id?'create':method==='PUT'&&id&&!extra?'replace':null;
    requireValue(action,'METHOD_NOT_ALLOWED',405);
    const body=await jsonBody(req);
    const entity=id||(kind==='sources'?body?.document?.sourceId:body?.document?.id);
    return send(action==='create'||action==='copy'?201:200,{ok:true,data:await store.catalog.save(member,shop,kind,entity,action,body,requestId)});
   }
   if(live&&!sales&&['/api/v1/operations/workspace-index','/api/v1/operations/workspace-catalog'].includes(url.pathname)){
    requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
    const data=url.pathname.endsWith('-index')?await store.workspaceIndex(shop):await store.workspaceCatalog(shop);
    return send(200,{ok:true,data});
   }
   const operationResource=live&&!sales&&/^\/api\/v1\/operations\/(save-receipts|sources|costs|templates|gallery)\/([^/]+)$/.exec(url.pathname);
   if(operationResource){
    requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
    const id=identifier(operationResource[2]),kind=operationResource[1];
    if(kind==='save-receipts')requireValue(operationId(id));
    const data=kind==='save-receipts'?await store.lookupReceipt(member,shop,id):await store.resource(shop,kind,id);
    return send(200,{ok:true,data});
   }
   const match=/^\/api\/v1\/(operations|sales)\/configurations(?:\/([^/]+)(?:\/(addons|design|archive|restore))?)?$/.exec(url.pathname);
   requireValue(match,'NOT_FOUND',404);
   const id=match[2]?identifier(match[2]):null,leaf=match[3];
   if(write){
    requireValue(live&&!sales,'METHOD_NOT_ALLOWED',405);
    const action=method==='POST'&&!id?'create':id&&method==='PUT'&&!leaf?'replace':
     id&&method==='PUT'&&leaf==='design'?'design':id&&method==='POST'&&['archive','restore'].includes(leaf)?leaf:null;
    requireValue(action,'METHOD_NOT_ALLOWED',405);
    requireValue(store.writable,'WRITES_DISABLED',405);
    const body=await jsonBody(req);
    const data=await store.save(member,shop,id||body?.document?.id,action,body,requestId);
    return send(action==='create'?201:200,{ok:true,data});
   }
   requireValue(method==='GET','METHOD_NOT_ALLOWED',405);
   requireValue(!leaf||leaf==='addons','METHOD_NOT_ALLOWED',405);
   const numeric=(key,fallback,max)=>{const raw=url.searchParams.get(key)??String(fallback);requireValue(/^\d+$/.test(raw));const n=Number(raw);requireValue(Number.isSafeInteger(n)&&n<=max);return n;};
   const limit=numeric('limit',50,100),offset=numeric('offset',0,1000000);requireValue(limit>0);
   const rawArchived=url.searchParams.get('archived');requireValue(rawArchived===null||['true','false'].includes(rawArchived));
   const archived=rawArchived==='true';
   const search=url.searchParams.get('search')||'';requireValue(search.length<=200);
   const data=id?(leaf?await store.addons(shop,id,sales):await store.detail(shop,id,sales,{archived})):await store.configurations(shop,{sales,limit,offset,search,archived});
   send(200,{ok:true,data});
  }catch(e){send(e instanceof Fault?e.status:503,{ok:false,error:e instanceof Fault?e.code:'SERVICE_UNAVAILABLE',...(e instanceof Fault&&e.details?{details:e.details}:{})});}
 };
}
export function lanAllowed(network,prefix){
 const allowed=new BlockList();
 allowed.addSubnet(network,prefix,'ipv4');
 // 仅接受真实 TCP 来源；客户端自报地址、转发头和其它网卡都不能放宽范围。
 return value=>{
  const ip=String(value||'').replace(/^::ffff:/i,'');
  return isIPv4(ip)&&allowed.check(ip,'ipv4');
 };
}
export function serve(deps,tls=null,{healthOnly=false}={}){
 const handler=createHandler({...deps,lanGallery:tls?deps.lanGallery:null});
 const server=tls?(()=>{const inside=lanAllowed(tls.network,tls.prefix);
  return createTlsServer({cert:tls.cert,key:tls.key,minVersion:'TLSv1.2'},(req,res)=>{
   if(!inside(req.socket.remoteAddress)){
    res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});res.end('{"ok":false,"error":"FORBIDDEN"}');return;
   }
   return handler(req,res);
  });
 })():createServer(healthOnly?(req,res)=>{
  // 启用内网 HTTPS 后，原回环端口保留健康探针，不能经旧代理转发运营接口。
  if(req.method==='GET'&&req.url==='/healthz')return handler(req,res);
  res.writeHead(404,{'content-type':'application/json','cache-control':'no-store'});res.end('{"ok":false,"error":"NOT_FOUND"}');
 }:handler);
 server.requestTimeout=15000;server.headersTimeout=10000;return server;
}
