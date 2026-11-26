// 服务端配置不接受请求覆盖；正式与试验使用不同库、运行身份和监听端口。
import {readFileSync} from 'node:fs';
import {BlockList,isIPv4} from 'node:net';
import {liveScopes} from './shop-scope.mjs';
export class Fault extends Error {constructor(code,status=400,details){super(code);this.code=code;this.status=status;this.details=details;}}
export const requireValue=(value,code='INVALID_REQUEST',status=400)=>{if(!value)throw new Fault(code,status);};
export function settings(env=process.env){
 const authMode=env.NAS_AUTH_MODE||'cloud';
 requireValue(['cloud','migration','local'].includes(authMode),'INVALID_AUTH_MODE');
 // 完成切换后，即使外部还留有旧配置，也无需读取腾讯云地址。
 const auth=authMode==='local'?null:new URL(env.AUTH_ORIGIN||'https://unconfigured.invalid');
 requireValue(!auth||auth.protocol==='https:'&&!auth.username&&!auth.password&&!auth.search&&!auth.hash&&auth.pathname==='/'&&!auth.hostname.endsWith('.invalid'),'INVALID_AUTH_ORIGIN');
 const profile=env.NAS_PROFILE||'trial',production=profile==='intel-production';
 requireValue(['trial','intel-production'].includes(profile),'INVALID_NAS_PROFILE');
 const database=production?'diy_workbench':'diy_workbench_trial';
 const deploymentId=production?env.NAS_DEPLOYMENT_ID:null;
 const batch=production?env.NAS_BOOTSTRAP_BATCH_ID:null;
 requireValue(env.WORKSPACE_ID&&env.PGDATABASE===database,'INVALID_DATABASE_OR_WORKSPACE');
 requireValue(!production||!/[\r\n]/.test(deploymentId||'')&&/^intel-production-[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(deploymentId||'')&&
  /^intel-\d+-[a-f0-9]{16}-[a-f0-9]{8}$/.test(batch||''),'INVALID_PRODUCTION_IDENTITY');
 const password=env.PGPASSWORD_FILE?readFileSync(env.PGPASSWORD_FILE,'utf8').trim():env.PGPASSWORD;
 requireValue(password&&env.PGUSER,'DATABASE_CREDENTIALS_REQUIRED');
 const port=Number(env.PORT||8080);requireValue(Number.isInteger(port)&&port>0&&port<=65535,'INVALID_PORT');
 const dataset=env.NAS_DATASET||'samples';
 requireValue(['samples','intel_live'].includes(dataset),'INVALID_DATASET');
 requireValue(!production||dataset==='intel_live'&&env.PGUSER==='diy_api_intel_production','INVALID_PRODUCTION_ROLE');
 const writable=env.NAS_ENABLE_WRITES==='true';
 requireValue(!writable||(dataset==='intel_live'&&env.PGUSER===(production?'diy_api_intel_production':'diy_api_operations')),'INVALID_WRITE_ROLE');
 const catalogWritable=env.NAS_ENABLE_CATALOG_WRITES==='true';
 requireValue(!catalogWritable||writable,'INVALID_WRITE_ROLE');
 const workspaceWritable=env.NAS_ENABLE_WORKSPACE_WRITES==='true';
 requireValue(!workspaceWritable||catalogWritable,'INVALID_WRITE_ROLE');
 // 只在已启用工作区写入的正式数据集启动清理；间隔以毫秒设置，防止 Node 计时器溢出。
 const retentionEnabled=env.NAS_ENABLE_RETENTION??'true';
 requireValue(['true','false'].includes(retentionEnabled),'INVALID_RETENTION_SETTINGS');
 const initialDelayMs=Number(env.NAS_RETENTION_INITIAL_DELAY_MS??60000),intervalMs=Number(env.NAS_RETENTION_INTERVAL_MS??3600000);
 requireValue(Number.isInteger(initialDelayMs)&&initialDelayMs>=0&&initialDelayMs<=2147483647&&Number.isInteger(intervalMs)&&intervalMs>=1&&intervalMs<=2147483647,'INVALID_RETENTION_SETTINGS');
 const retention=workspaceWritable&&dataset==='intel_live'&&retentionEnabled==='true'?{initialDelayMs,intervalMs,workspaceId:env.WORKSPACE_ID}:null;
 const tlsPaths=[env.NAS_TLS_CERT_FILE,env.NAS_TLS_KEY_FILE,env.NAS_TLS_LAN_CIDR,env.NAS_TLS_PORT];
 let tls=null;
 if([...tlsPaths,env.NAS_TLS_LISTEN_HOST].some(Boolean)){
  const [network,bits]=String(env.NAS_TLS_LAN_CIDR||'').split('/');
  const [a,b]=network.split('.').map(Number),privateLan=a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
  const tlsPort=Number(env.NAS_TLS_PORT);
  requireValue(tlsPaths.every(Boolean)&&isIPv4(network)&&privateLan&&/^(?:2[4-9]|3[0-2])$/.test(bits)&&
   env.NAS_TLS_LAN_CIDR===network+'/'+bits&&Number.isInteger(tlsPort)&&tlsPort>=1024&&tlsPort<=65535&&tlsPort!==port,
   'INVALID_LAN_TLS');
  if(env.NAS_TLS_LISTEN_HOST){
   const lan=new BlockList();lan.addSubnet(network,Number(bits),'ipv4');
   // 宿主网络避免Docker改写来源；回环和TLS必须各绑自己的地址。
   requireValue(env.LISTEN_HOST==='127.0.0.1'&&isIPv4(env.NAS_TLS_LISTEN_HOST)&&lan.check(env.NAS_TLS_LISTEN_HOST,'ipv4'),'INVALID_LAN_TLS_BIND');
  }
  tls={cert:readFileSync(env.NAS_TLS_CERT_FILE),key:readFileSync(env.NAS_TLS_KEY_FILE),
   network,prefix:Number(bits),port:tlsPort,host:env.NAS_TLS_LISTEN_HOST||env.LISTEN_HOST||'0.0.0.0'};
 }
 requireValue(!production||tls&&env.NAS_TLS_LISTEN_HOST&&tls.port!==18443&&port!==18080,
  'PRODUCTION_REQUIRES_SEPARATE_TLS_ENDPOINT');
 const clientOrigins=(env.NAS_CLIENT_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 for(const entry of clientOrigins){
  const parsed=new URL(entry);
  requireValue(entry==='tauri://localhost'||(parsed.origin===entry&&!parsed.username&&!parsed.password&&['http:','https:'].includes(parsed.protocol)),'INVALID_CLIENT_ORIGIN');
 }
 const pg={host:env.PGHOST||'postgres',port:Number(env.PGPORT||5432),database:env.PGDATABASE,user:env.PGUSER,password,max:4,connectionTimeoutMillis:5000,statement_timeout:10000,options:writable?'':'-c default_transaction_read_only=on'};
 const additionalShops=[];
 for(const scope of [liveScopes.gigabyte,liveScopes.jonsbo]){
  const [batch,passwordFile,imagesRoot,imagesWriteRoot]=['BOOTSTRAP_BATCH_ID','PASSWORD_FILE','IMAGE_ROOT','IMAGE_WRITE_ROOT'].map(name=>env[scope.envPrefix+name]);
  if(![batch,passwordFile,imagesRoot,imagesWriteRoot].some(value=>value!==undefined))continue;
  // 每个可选店是独立的正式运行区；缺一项也不准回退复用英特尔连接或目录。
  requireValue(production&&[batch,passwordFile,imagesRoot,imagesWriteRoot].every(Boolean)&&
   batch.startsWith(scope.shopId+'-')&&/^\d+-[a-f0-9]{16}-[a-f0-9]{8}$/.test(batch.slice(scope.shopId.length+1)),
   'INVALID_ADDITIONAL_SHOP_CONFIG');
  const password=readFileSync(passwordFile,'utf8').trim();
  requireValue(password,'DATABASE_CREDENTIALS_REQUIRED');
  requireValue(password!==pg.password&&additionalShops.every(shop=>shop.pg.password!==password),'STORE_CREDENTIALS_MUST_DIFFER');
  additionalShops.push({shopId:scope.shopId,batch,imagesRoot,imagesWriteRoot,pg:{...pg,user:scope.role,password}});
 }
 const lanCaseGallery=env.NAS_ENABLE_LAN_CASE_GALLERY==='true';
 requireValue(!lanCaseGallery||production&&!!tls&&additionalShops.length===2&&env.NAS_IMAGE_ROOT,'LAN_GALLERY_REQUIRES_THREE_STORE_TLS');
 const sharedGallery=env.NAS_ENABLE_SHARED_CASE_GALLERY==='true';
 requireValue(!sharedGallery||production&&additionalShops.length===2&&catalogWritable&&env.NAS_IMAGE_ROOT&&env.NAS_IMAGE_WRITE_ROOT,
  'SHARED_GALLERY_REQUIRES_THREE_STORE_WRITES');
 const sharedSources=env.NAS_ENABLE_SHARED_SOURCES==='true';
 requireValue(!sharedSources||production&&additionalShops.length===2&&workspaceWritable,'SHARED_SOURCES_REQUIRE_THREE_STORE_WRITES');
 requireValue(authMode==='cloud'||production&&writable&&tls&&additionalShops.length===2,'LOCAL_AUTH_REQUIRES_THREE_STORE_TLS');
 return {authMode,authOrigin:auth?.origin??null,workspace:env.WORKSPACE_ID,sessionCacheMs:30000,port,dataset,writable,clientOrigins,profile,deploymentId,batch,additionalShops,lanCaseGallery,sharedGallery,sharedSources,
  imagesRoot:env.NAS_IMAGE_ROOT||null,imagesWriteRoot:catalogWritable?env.NAS_IMAGE_WRITE_ROOT||null:null,catalogWritable,workspaceWritable,retention,
  host:env.LISTEN_HOST||'0.0.0.0',tls,pg};
}
