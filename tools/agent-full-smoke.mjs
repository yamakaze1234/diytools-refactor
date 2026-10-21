/** 完整工作台 + CLI + 官方存储 + 原生任务/导出隔离端到端验收。 */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {dirname,resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {blankConfig} from '../apps/desktop/public/workbench/core.js';
import {normalizeWorkspaceState} from '../apps/desktop/public/workbench/shops.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),publicRoot=resolve(root,'apps/desktop/public');
assert.equal(process.argv.length,4,'node tools/agent-full-smoke.mjs HOST_EXE CLI_EXE');
const hostPath=resolve(process.argv[2]),cliPath=resolve(process.argv[3]);
const directory=resolve(root,'sandbox',`agent-full-smoke-${Date.now()}`);await mkdir(directory,{recursive:true});
const make=(id,name)=>{
 const c=blankConfig(null,{id:'synthetic-link',shopId:'intel',name:'隔离全链路主机',spu:'0001234',url:'https://example.invalid/product',installment:0},name);
 Object.assign(c,{id,shortName:'合成隔离配置',shortNameAuto:false,price:3999,caseVisible:false,showUpgrades:true,skuId:'',version:'隔离初始版',footer:'仅用于隔离端到端测试'});
 c.parts=[{slot:'CPU',name:'合成测试 CPU',sourceId:'src-cpu',goodsId:'00001',qty:1,erp:100,tax:110,upgrade:'INITIAL_DESC'},{slot:'内存',name:'合成 DDR5 16GB',sourceId:'src-ram',goodsId:'00002',qty:2,erp:150,tax:160,upgrade:''}];
 c.actualParts=structuredClone(c.parts);c.actualParts[0].name='实际 BOM CPU';return c;
};
const seed=normalizeWorkspaceState({dataVersion:3,revision:7,updatedAt:'2026-01-01T00:00:00Z',configs:[make('synthetic-first','配置1'),make('synthetic-selected','配置2')],templates:[],sourceCatalog:[],costSource:[],logs:[],caseGallery:[]});
await writeFile(resolve(directory,'source-state.json'),JSON.stringify(seed,null,2));
const report={directory,checks:[],pageErrors:[],httpErrors:[],cliCalls:[],jobs:[],scope:'Only isolated sandbox host, synthetic official-store database, original workbench bootstrap/app and Edge; no installed application or production data.'};
const host=spawn(hostPath,[directory,'--tasks'],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
let diagnostics='',browser,server,readyResolve,readyReject,fault=null;
const uiSession=randomUUID();let activeClaim=null;
const readyPromise=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),pending=[];
host.stderr.on('data',chunk=>diagnostics+=chunk);
const lines=createInterface({input:host.stdout});
lines.on('line',line=>{
 try{const value=JSON.parse(line);if(value.ready){readyResolve(value);return;}const next=pending.shift();if(!next)throw Error('Unexpected host reply');value.ok?next.resolve(value.value):next.reject(Error(value.error));}
 catch(error){readyReject(error);pending.shift()?.reject(error);}
});
host.once('error',readyReject);host.once('exit',code=>{const error=Error(`Host exited ${code}: ${diagnostics}`);readyReject(error);for(const p of pending.splice(0))p.reject(error);});
let sequence=Promise.resolve();
function rpc(input){const result=sequence.then(()=>new Promise((resolveReply,reject)=>{const timeout=setTimeout(()=>reject(Error(`Host RPC timeout: ${input.action}`)),45000);pending.push({resolve:value=>{clearTimeout(timeout);resolveReply(value);},reject:error=>{clearTimeout(timeout);reject(error);}});host.stdin.write(JSON.stringify(input)+'\n');}));sequence=result.catch(()=>{});return result;}
const exec=promisify(execFile),mime={'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf','.json':'application/json'};
const raw=async(method,path,body=null)=>rpc({action:'request',method,path,body:body===null?null:JSON.stringify(body)});
const api=async(method,path,body=null)=>{const response=await raw(method,path,body);assert.equal(response.status,200,`${path}: ${response.body}`);return JSON.parse(response.body);};
try{
 const ready=await Promise.race([readyPromise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(`Host startup timeout: ${diagnostics}`)),20000);timer.unref();})]);report.instance=ready.instance;
 const cli=async args=>{
  const {stdout,stderr}=await exec(cliPath,['--json','--instance',ready.instance,...args],{cwd:directory,windowsHide:true,timeout:15000});assert.equal(stderr,'');const envelope=JSON.parse(stdout);assert.equal(envelope.ok,true,stdout);report.cliCalls.push({args,response:envelope});return envelope.data;
 };
 server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   if(path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><meta charset="utf-8"><title>完整工作台隔离验收</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><script>window.installWorkbenchBridge=async frame=>{frame.workbenchAgentNative=(action,payload)=>window.smokeNative(action,payload);};</script><iframe src="/workbench/index.html"></iframe></html>');return;}
   if(path==='/catalog.json'||path==='/workbench/catalog.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end('[]');return;}
   if(path.startsWith('/api/')){
    let body='';for await(const chunk of req)body+=chunk;
    const simulate=path==='/api/configs/batch'&&fault?.remaining>0&&JSON.parse(body).operationId===fault.operationId?fault:null;
    if(simulate){simulate.remaining--;if(simulate.mode==='before'){report.faults??=[];report.faults.push({operationId:simulate.operationId,mode:'before',nativeWritten:false});res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic failure before official write'}));return;}}
    const response=await rpc({action:'request',method:req.method,path:url.pathname+url.search,body:body||null});
    if(simulate?.mode==='after'){assert.equal(response.status,200);report.faults??=[];report.faults.push({operationId:simulate.operationId,mode:'after',nativeWritten:true});res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic lost receipt after official write'}));return;}
    if(response.status>=400)report.httpErrors.push({method:req.method,path:url.pathname+url.search,status:response.status,body:response.body});
    res.writeHead(response.status,{'Content-Type':'application/json'});res.end(response.body);return;
   }
   const file=resolve(publicRoot,'.'+decodeURIComponent(path));if(!file.startsWith(publicRoot+sep)){res.writeHead(403);res.end();return;}
   res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));
  }catch(error){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
 page.on('pageerror',error=>report.pageErrors.push(error.message));
 await page.exposeFunction('smokeNative',(action,payload)=>rpc({action,...payload,session:uiSession,claimToken:activeClaim}));
 await page.goto(origin);const frame=page.frames().find(f=>f.url().includes('/workbench/index.html'));assert.ok(frame,'workbench iframe');
 await frame.waitForFunction(()=>window.workbenchReady&&typeof window.workbenchAgentExecute==='function',null,{timeout:45000});
 await frame.locator('#search').fill('配置2');await frame.locator('.config-item[data-id="synthetic-selected"]').click();
 await frame.locator('[data-config="version"]').waitFor({state:'visible'});
 await frame.waitForFunction(()=>!window.workbenchHasPendingChanges());
 const beforeDirty=await api('GET','/api/state?logs=none');
 await frame.locator('[data-config="version"]').fill('人工草稿隔离验证');
 const dirtyResult=await frame.evaluate(async()=>{try{await window.workbenchAgentExecute({id:'dirty-probe',method:'changes.preview',params:{request:{shopId:'intel',targets:[{configId:'synthetic-selected',partIndex:0}],action:{type:'displayName',value:'不可应用'}}}});return {unexpectedSuccess:true};}catch(error){return {code:error.code,message:error.message};}});
 assert.equal(dirtyResult.code,'UI_BUSY');report.dirtyGuard=dirtyResult;
 assert.equal((await api('GET','/api/state?logs=none')).revision,beforeDirty.revision);
 await page.screenshot({path:resolve(directory,'01-dirty-guard.png'),fullPage:true});
 await frame.locator('[data-config="version"]').blur();await frame.waitForFunction(()=>!window.workbenchHasPendingChanges(),null,{timeout:30000});
 report.checks.push('actual_user_input_dirty_guard_before_save');
 const task=async(args,operation,expected='succeeded')=>{
  await rpc({action:'ready',session:uiSession,connect:true});const queued=await cli(args);assert.ok(queued.jobId);assert.equal(queued.status,'queued');
  const job=await rpc({action:'claim',session:uiSession});assert.equal(job.id,queued.jobId);assert.ok(job.claimToken);activeClaim=job.claimToken;
  const execution=await frame.evaluate(async job=>{try{return {result:await window.workbenchAgentExecute(job)};}catch(error){return {error:{code:error.code||'UI_OPERATION_FAILED',message:error.message}};}},job);
  await rpc({action:'complete',session:uiSession,claimToken:job.claimToken,id:job.id,...execution});activeClaim=null;const final=await cli(['jobs','status','--operation-id',operation]);
  report.jobs.push(final);assert.equal(final.status,expected,JSON.stringify(final));return final;
 };
 const change=async(value,label)=>{
  const operation=randomUUID(),input=resolve(directory,`${label}.json`);await writeFile(input,JSON.stringify({shopId:'intel',targets:[{configId:'synthetic-selected',partIndex:0,expectedGoodsId:'00001'}],action:{type:'upgrade',value}}));
  const before=await api('GET','/api/state?logs=none');const preview=await task(['changes','preview','--input',input,'--operation-id',operation],operation);
  assert.equal((await api('GET','/api/state?logs=none')).revision,before.revision,'preview cannot save');
  const applyOperation=randomUUID(),applyArgs=['changes','apply','--plan-id',preview.result.planId,'--operation-id',applyOperation];
  const applied=await task(applyArgs,applyOperation);assert.equal(applied.result.localSave,'saved');
  const saved=await api('GET','/api/state?logs=none'),config=saved.configs.find(c=>c.id==='synthetic-selected');assert.equal(config.parts[0].upgrade,value);assert.ok(saved.revision>before.revision);
  const retry=await cli(applyArgs);assert.equal(retry.status,'succeeded');assert.equal((await api('GET','/api/state?logs=none')).revision,saved.revision,'retry must not increase revision');
  return {operation:applyOperation,revision:saved.revision,value};
 };
 const retryExperiment=async(mode,editAfter=false)=>{
  const previewOp=randomUUID(),input=resolve(directory,`retry-${mode}-${editAfter}.json`),value=`RETRY_${mode}_${editAfter}`;
  await writeFile(input,JSON.stringify({shopId:'intel',targets:[{configId:'synthetic-selected',partIndex:0}],action:{type:'upgrade',value}}));
  const preview=await task(['changes','preview','--input',input,'--operation-id',previewOp],previewOp),operation=randomUUID();
  const args=['changes','apply','--plan-id',preview.result.planId,'--operation-id',operation],before=await api('GET','/api/state?logs=none');
  fault={mode,operationId:operation,remaining:1};const failed=await task(args,operation,'failed');assert.ok(failed.error.message.includes('synthetic'));
  const afterFailure=await api('GET','/api/state?logs=none');assert.equal(afterFailure.revision,before.revision+(mode==='after'?1:0));
  assert.equal(await frame.evaluate(()=>window.workbenchHasPendingChanges()),true);
  if(editAfter){
   await frame.locator('[data-config="version"]').fill('失败后人工继续编辑');
   const refused=await task(args,operation,'failed');assert.equal(refused.error.code,'UI_BUSY');
   assert.equal(await frame.locator('[data-config="version"]').inputValue(),'失败后人工继续编辑');
   assert.equal((await api('GET','/api/state?logs=none')).revision,afterFailure.revision);
   await page.screenshot({path:resolve(directory,'retry-human-draft-preserved.png'),fullPage:true});
   await frame.locator('#save').click();await frame.waitForFunction(()=>!window.workbenchHasPendingChanges(),null,{timeout:30000});
   assert.equal((await api('GET','/api/state?logs=none')).configs.find(c=>c.id==='synthetic-selected').version,'失败后人工继续编辑');
   report.checks.push('failed_apply_retry_refuses_later_human_draft');
  }else{
   const retried=await task(args,operation);assert.equal(retried.result.localSave,'saved');
   await frame.waitForFunction(()=>!window.workbenchHasPendingChanges(),null,{timeout:5000});
   const confirmed=await api('GET','/api/state?logs=none');assert.equal(confirmed.revision,before.revision+1);assert.equal(confirmed.configs.find(c=>c.id==='synthetic-selected').parts[0].upgrade,value);
   report.checks.push(mode==='before'?'same_apply_retry_after_unwritten_503_succeeds':'same_apply_retry_after_lost_written_receipt_no_extra_revision');
  }
 };
 await retryExperiment('before');await retryExperiment('after');await retryExperiment('before',true);
 const first=await change('FIRST_DESC_SENTINEL','first-change');report.firstSave=first;
 await page.screenshot({path:resolve(directory,'02-first-save.png'),fullPage:true});
 const later=await change('LATER_DESC_SENTINEL','later-change');report.laterSave=later;
 await page.screenshot({path:resolve(directory,'03-later-save.png'),fullPage:true});
 report.checks.push('cli_preview_no_business_write','actual_app_description_apply_saved_to_official_store','same_operation_retry_no_revision_increase');
 await frame.waitForTimeout(500);
 await frame.evaluate(()=>{window.__agentExportText=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__agentExportText.push(String(text));return original.call(this,text,...args);};});
 const exportInput=resolve(directory,'export.json'),exportOperation=randomUUID(),output=resolve(directory,'export');
 await mkdir(output,{recursive:true});
 await writeFile(exportInput,JSON.stringify({sourceOperationId:first.operation,images:'both',report:true,outputDir:output}));
 const exported=await task(['export','--input',exportInput,'--operation-id',exportOperation],exportOperation);
 assert.equal(exported.result.localSave,'unchanged');assert.equal(exported.result.export,'completed');assert.equal(exported.result.revision,first.revision);
 const drawn=await frame.evaluate(()=>window.__agentExportText);report.exportCanvasText=drawn;
 assert.ok(drawn.some(t=>t.includes('FIRST_DESC_SENTINEL')),'saved operation snapshot must render original description');assert.ok(!drawn.some(t=>t.includes('LATER_DESC_SENTINEL')),'later saved description must not enter original snapshot export');
 const afterExport=await api('GET','/api/state?logs=none');assert.equal(afterExport.revision,later.revision);assert.equal(afterExport.configs.find(c=>c.id==='synthetic-selected').parts[0].upgrade,later.value);
 const paths=exported.result;for(const key of ['zipPath','reportPath','manifestPath']){assert.ok((await stat(paths[key])).size>0);}
 const manifest=JSON.parse(await readFile(paths.manifestPath,'utf8'));report.exportManifest=manifest;
 const html=await readFile(paths.reportPath,'utf8');assert.ok(html.includes('FIRST_DESC_SENTINEL')&&!html.includes('LATER_DESC_SENTINEL'));
 for(const file of manifest.files){const bytes=await readFile(resolve(paths.directory,file.name));assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);}
 await page.screenshot({path:resolve(directory,'04-after-export.png'),fullPage:true});
 const offline=await browser.newPage();offline.on('pageerror',error=>report.pageErrors.push(error.message));await offline.goto(pathToFileURL(paths.reportPath).href);
 await offline.waitForFunction(()=>[...document.images].every(i=>i.complete));const images=await offline.locator('img').evaluateAll(images=>images.map(i=>({src:i.getAttribute('src'),width:i.naturalWidth,height:i.naturalHeight})));
 assert.equal(images.length,2);assert.ok(images.every(i=>i.width>0&&i.height>0));assert.ok(images.every(i=>i.src.includes('2_')));report.offlineImages=images;
 await offline.screenshot({path:resolve(directory,'05-offline-report.png'),fullPage:true});
 const zipCheck=await promisify(execFile)('py',['-3','-X','utf8','-c','import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps(z.namelist(),ensure_ascii=False))',paths.zipPath],{encoding:'utf8',windowsHide:true});report.zipFiles=JSON.parse(zipCheck.stdout);assert.equal(report.zipFiles.filter(n=>n.endsWith('.png')).length,2);
 report.checks.push('native_write_finish_real_zip_manifest_report','native_manifest_bytes_sha256_match','original_operation_snapshot_after_later_save','export_does_not_save_or_sync','offline_report_two_png_load','native_zip_crc_valid');
 assert.deepEqual(report.pageErrors,[]);report.checks.push('no_pageerrors');report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;throw error;}
finally{
 await browser?.close();if(server)await new Promise(resolveClose=>server.close(resolveClose));
 host.stdin.end();await Promise.race([new Promise(resolveExit=>host.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);if(host.exitCode===null)host.kill();lines.close();
 report.hostDiagnostics=diagnostics;await writeFile(resolve(directory,'completion.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,directory,checks:report.checks,error:report.error}));
}
