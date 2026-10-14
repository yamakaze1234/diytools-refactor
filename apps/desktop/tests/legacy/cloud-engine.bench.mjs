// Reproduce private-plan protocol/CAS measurements without remote writes.
// node --expose-gc --max-old-space-size=3072 <this-file> --plan <plan> --output <report>
// Native local CAS: CLOUD_BENCH_MODE=native CLOUD_BENCH_RPC_MODULE=<adapter.mjs>.
// The adapter must export isolated=true and request('load'|'status'|'commit',input).
// All cloud calls and image callbacks remain simulated in both modes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createCloudEngine} from '../../public/workbench/cloud-engine.js';
import {createCloudCheckpointCache} from '../../public/workbench/cloud-checkpoint-cache.js';

const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const planPath=path.resolve(option('--plan',path.join(root,'sandbox/windows-acceptance-20261013/cutover-preflight/20261013-131551-efa26469/bootstrap-plan.json')));
const mode=option('--mode',process.env.CLOUD_BENCH_MODE||'mock'),phase=option('--phase','all'),output=option('--output',process.env.CLOUD_BENCH_REPORT);
if(!['mock','native'].includes(mode)||!['all','read-only','upload'].includes(phase))throw Error('Unsupported benchmark mode or phase');
let raw=fs.readFileSync(planPath);
const source={bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')},beforeStat=fs.statSync(planPath);
const plan=JSON.parse(raw.toString('utf8'));raw=null;
const member={uid:plan.member.uid,workspaceId:plan.member.workspaceId};
let native;
if(mode==='native'){
 const modulePath=process.env.CLOUD_BENCH_RPC_MODULE;if(!modulePath)throw Error('Native local CAS requires an explicit isolated adapter');
 native=await import(pathToFileURL(path.resolve(modulePath)).href);
 if(native.isolated!==true||typeof native.request!=='function')throw Error('Native adapter must declare isolated=true and export request');
}
const results=[];
for(const upload of phase==='all'?[false,true]:[phase==='upload']){
 let current={state:plan.state,cloudVersion:1,document:{format:1,...plan.member,cursor:plan.cursor,records:plan.records,outbox:plan.outbox,materializedProjection:plan.materializedProjection}};
 let loads=0,statuses=0,commits=0,actions={},log=[],receipts=new Map(),initialCursor;
 const cache=createCloudCheckpointCache(async(action,input)=>{
  if(action==='status')statuses++;if(action==='load')loads++;if(action==='commit')commits++;
  if(native)return native.request(action,input);
  if(action==='status')return {session:{authenticated:true,member},checkpoint:{initialized:true,...member,cloudVersion:current.cloudVersion,workspaceRevision:current.state.revision}};
  if(action==='load')return structuredClone(current);
  if(action==='commit'){
   if(input.baseRevision!==current.state.revision||input.cloudVersion!==current.cloudVersion)throw Object.assign(Error('CAS'),{status:409});
   current={state:{...input.state,revision:current.state.revision+1},cloudVersion:current.cloudVersion+1,document:input.document};
   return {revision:current.state.revision,cloudVersion:current.cloudVersion};
  }
  throw Error('Unsupported local action');
 });
 const engine=createCloudEngine({...cache,async uploadAssets(){},async downloadAssets(){},async call(req){
  actions[req.action]=(actions[req.action]||0)+1;
  initialCursor??=(await cache.load()).document.cursor;
  if(req.action==='sync.pushBatch')return {ok:true,results:req.payload.requests.map(request=>{
   const p=request.payload;if(receipts.has(p.mutationId))return receipts.get(p.mutationId);
   const row={type:p.entityType,id:p.entityId,version:p.baseVersion+1,data:p.after,seq:initialCursor+log.length+1,mutationId:p.mutationId};log.push(row);
   const receipt={ok:true,mutationId:p.mutationId,record:row};receipts.set(p.mutationId,receipt);return receipt;
  })};
  if(req.action==='sync.receipt')return receipts.get(req.payload.mutationId)??{ok:false,code:'NOT_FOUND'};
  if(req.action==='sync.pull'){
   const head=req.payload.headSeq??initialCursor+log.length,rows=[];let bytes=0;
   for(const row of log){if(row.seq<=req.payload.cursor||row.seq>head)continue;const size=Buffer.byteLength(JSON.stringify(row.data));if(rows.length&&(rows.length>=100||bytes+size>450000))break;rows.push(row);bytes+=size;}
   const cursor=rows.at(-1)?.seq??req.payload.cursor;return {ok:true,headSeq:head,nextCursor:cursor,hasMore:cursor<head,changes:rows};
  }
  throw Error('Unsupported simulated cloud action');
 }});
 const start=performance.now();
 try{
  const result=await engine.run({member,upload});
  results.push({phase:upload?'all-pending-upload-pull':'read-only-empty-increment',ok:true,ms:+(performance.now()-start).toFixed(2),loads,statuses,commits,actions,pending:result.pending,uncertain:result.uncertain,peakRssMiB:+(process.resourceUsage().maxRSS/1024).toFixed(1),rssMiB:+(process.memoryUsage().rss/1048576).toFixed(1)});
 }catch(error){results.push({phase:upload?'upload':'read-only',ok:false,message:error.message,ms:+(performance.now()-start).toFixed(2),loads,statuses,commits,actions});}
 console.log(JSON.stringify(results.at(-1)));
 if(!results.at(-1).ok)break;if(global.gc)global.gc();
}
const afterStat=fs.statSync(planPath);
const report={format:1,measuredAt:new Date().toISOString(),mode,cloudNetwork:'simulated',localCas:mode==='native'?'isolated native adapter':'in-memory',imageIO:'simulated callbacks',source,configurations:plan.state.configs.length,records:plan.records.length,sourceStatUnchanged:beforeStat.size===afterStat.size&&beforeStat.mtimeMs===afterStat.mtimeMs,results,limits:['No production cloud or image writes','Node maxRSS is process cumulative peak','Native IPC serialization/SQLite excluded in mock mode']};
if(output){const target=path.resolve(output);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');}
if(results.some(r=>!r.ok)||!report.sourceStatUnchanged)process.exitCode=1;
