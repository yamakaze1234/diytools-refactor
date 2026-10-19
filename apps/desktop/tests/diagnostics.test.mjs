import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticLog,diagnostics,diagnosticCode,diagnosticText,trackDiagnostic,cloudDiagnosticStage,exportDiagnostics} from '../src/diagnostics.ts';

test('white-list metadata drops credentials, raw errors, SQL paths and business payloads',async()=>{
 const privateText='password=never-secret token=never-token uid=never-user Server=never-server 配置=never-config';
 const log=createDiagnosticLog(3);log.begin(privateText)(privateText,500);
 const snapshot=JSON.stringify(log.snapshot(privateText));
 for(const secret of ['never-secret','never-token','never-user','never-server','never-config'])assert(!snapshot.includes(secret));
 assert.equal(log.snapshot('0.2.8').events[0].stage,'unknown');
 assert.equal(log.snapshot('bad').version,'unknown');
 assert.equal(diagnosticCode('SQLITE_BUSY '+privateText),'DATABASE_BUSY');
 assert.equal(diagnosticCode('超过 512 MiB '+privateText),'SIZE_LIMIT');
 assert.equal(diagnosticCode({name:'TimeoutError',message:privateText}),'TIMEOUT');
 assert.equal(diagnosticCode({name:'AbortError',message:privateText}),'CANCELLED');
});
test('bounded session records retain pending operation and increasing elapsed time',async()=>{
 const log=createDiagnosticLog(3);const finish=log.begin('legacy-read');
 for(let i=0;i<8;i++)log.begin('cloud-commit')();
 await new Promise(resolve=>setTimeout(resolve,10));
 const before=log.snapshot('0.2.8');assert.equal(before.events.length,3);assert.equal(before.dropped,6);
 assert.equal(before.events[0].phase,'running');assert(before.events[0].elapsedMs>=5);
 finish(Error('timeout'));finish();assert.equal(log.snapshot('0.2.8').events[0].code,'TIMEOUT');
});
test('tracking preserves native result while logging safe HTTP errors and rejected exceptions',async()=>{
 const response={status:503,body:JSON.stringify({error:'连接失败 secret-credentials',state:{password:'secret-credentials'}})};
 assert.equal(await trackDiagnostic('cloud-pull',async()=>response),response);
 await assert.rejects(trackDiagnostic('legacy-read',async()=>{throw Error('超过 512 MiB secret-path');}));
 const text=JSON.stringify(diagnostics.snapshot('0.2.8'));assert(!text.includes('secret-'));assert(text.includes('NETWORK_FAILED'));assert(text.includes('SIZE_LIMIT'));
 assert.equal(cloudDiagnosticStage('call','{"action":"sync.pull","payload":{"password":"secret"}}'),'cloud-pull');
 assert.equal(cloudDiagnosticStage('call','{"action":"sync.snapshot"}'),'cloud-checkpoint');
 assert.equal(cloudDiagnosticStage('call','{"action":"sync.pushBatch"}'),'cloud-push');
});
test('export requires native saved file acknowledgement and handles cancellation/failure',async()=>{
 let captured;
 assert.equal(await exportDiagnostics(async(command,args)=>{assert.equal(command,'workbench_export_folder');captured=args.payload;return{ok:true,files:['diagnostics.json']};},'0.2.8'),'saved');
 const json=JSON.parse(Buffer.from(captured.files[0].base64,'base64').toString('utf8'));assert.equal(json.version,'0.2.8');assert.equal(json.privacy,'metadata-only');
 assert.equal(await exportDiagnostics(async()=>({cancelled:true}),'0.2.8'),'cancelled');
 await assert.rejects(exportDiagnostics(async()=>({ok:true,files:[]}),'0.2.8'));
 await assert.rejects(exportDiagnostics(async()=>{throw Error('native denied');},'0.2.8'));
});

test('stalled native export times out, keeps text available and reuses the pending export',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let settle,calls=0;
 const invoke=async command=>{assert.equal(command,'workbench_export_folder');calls++;return new Promise(resolve=>{settle=resolve;});};
 const first=exportDiagnostics(invoke);
 const rejected=assert.rejects(first,/尚未确认/);
 t.mock.timers.tick(30000);await rejected;
 const text=JSON.parse(diagnosticText());assert.match(text.version,/^\d+\.\d+\.\d+$/);
 assert(text.events.some(e=>e.stage==='diagnostic-export'&&e.phase==='running'));
 const retry=exportDiagnostics(invoke);assert.equal(calls,1);
 settle({ok:true,files:['diagnostics.json']});assert.equal(await retry,'saved');
 assert.equal(calls,1);
});
