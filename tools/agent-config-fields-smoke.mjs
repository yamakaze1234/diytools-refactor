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
import {verifyMcpExports} from './agent-mcp-export-acceptance.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),publicRoot=resolve(root,'apps/desktop/public');
const exportCheck=process.argv[4]==='--mcp-export';
const useMcp=process.argv[4]==='--mcp'||exportCheck;
assert.ok(process.argv.length===4||(process.argv.length===5&&useMcp),'node tools/agent-config-fields-smoke.mjs HOST_EXE CLI_EXE [--mcp|--mcp-export]');
const hostPath=resolve(process.argv[2]),cliPath=resolve(process.argv[3]);
const directory=resolve(root,'sandbox',`agent-full-smoke-${Date.now()}`);await mkdir(directory,{recursive:true});
const make=(id,name)=>{
 const c=blankConfig(null,{id:'synthetic-link',shopId:'intel',name:'隔离全链路主机',spu:'0001234',url:'https://example.invalid/product',installment:0},name);
 Object.assign(c,{id,shortName:'合成隔离配置',shortNameAuto:false,price:3999,caseVisible:false,showUpgrades:true,skuId:'',version:'隔离初始版',footer:'仅用于隔离端到端测试'});
 c.parts=[{slot:'CPU',name:'合成测试 CPU',sourceId:'src-cpu',goodsId:'00001',qty:1,erp:100,tax:110,upgrade:'INITIAL_DESC'},{slot:'内存',name:'合成 DDR5 16GB',sourceId:'src-ram',goodsId:'00002',qty:2,erp:150,tax:160,upgrade:''}];
 c.actualParts=structuredClone(c.parts);c.actualParts[0].name='实际 BOM CPU';return c;
};
// 混合旧 SKU 样式，验收导出不会继承专属排版或改写保存配置。
const configs=[make('synthetic-first','配置1'),make('synthetic-selected','配置2')];
if(exportCheck){configs[0].skuMode='dedicated';configs[1].skuMode='padded';configs.push(make('synthetic-unset','配置3'));delete configs[2].skuMode;}
const seed=normalizeWorkspaceState({dataVersion:3,revision:7,updatedAt:'2026-01-01T00:00:00Z',configs,templates:[],sourceCatalog:[],costSource:[],logs:[],caseGallery:[]});
await writeFile(resolve(directory,'source-state.json'),JSON.stringify(seed,null,2));
const report={directory,checks:[],pageErrors:[],httpErrors:[],cliCalls:[],jobs:[],scope:'Only isolated sandbox host, synthetic official-store database, original workbench bootstrap/app and Edge; no installed application or production data.'};
const host=spawn(hostPath,[directory,'--tasks'],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
let diagnostics='',browser,server,readyResolve,readyReject,fault=null,mcp,mcpLines;
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
 // 可选 MCP 路径复用下方同一组真实 UI 与 SQLite 断言，不复制业务测试。
 let mcpRequest;
 if(useMcp){
  mcp=spawn(cliPath,['--instance',ready.instance,'mcp','--allow-writes',...(exportCheck?['--allow-export']:[])],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let counter=0;const requests=new Map();let mcpDiagnostics='';
  mcp.stderr.on('data',chunk=>mcpDiagnostics+=chunk);
  mcpLines=createInterface({input:mcp.stdout});
  mcpLines.on('line',line=>{const reply=JSON.parse(line),pending=requests.get(reply.id);if(pending){requests.delete(reply.id);clearTimeout(pending.timer);reply.error?pending.reject(Error(JSON.stringify(reply.error))):pending.resolve(reply.result);}});
  const failAll=error=>{for(const pending of requests.values()){clearTimeout(pending.timer);pending.reject(error);}requests.clear();};
  mcp.on('error',failAll);mcp.on('exit',code=>failAll(Error(`MCP exited ${code}: ${mcpDiagnostics}`)));
  mcpRequest=(method,params)=>new Promise((resolve,reject)=>{const id=++counter,timer=setTimeout(()=>{requests.delete(id);reject(Error(`MCP timeout: ${method}`));},15000);requests.set(id,{resolve,reject,timer});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const initialized=await mcpRequest('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'isolated-workbench-test',version:'1'}});
  assert.equal(initialized.protocolVersion,'2025-11-25');mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await mcpRequest('tools/list',{});assert.equal(tools.tools.length,exportCheck?8:7);report.transport='mcp-stdio-to-windows-pipe';
 }
 const cli=async args=>{
  if(useMcp){
   const option=name=>args[args.indexOf(name)+1];let name,argumentsValue;
   if(args[0]==='changes'&&args[1]==='preview'){name='workbench_changes_preview';argumentsValue={request:JSON.parse(await readFile(option('--input'),'utf8')),operationId:option('--operation-id')};}
   else if(args[0]==='changes'&&args[1]==='apply'){name='workbench_changes_apply';argumentsValue={planId:option('--plan-id'),operationId:option('--operation-id')};}
   else if(args[0]==='jobs'){name='workbench_jobs_status';argumentsValue={operationId:option('--operation-id')};}
   else if(args[0]==='configs'&&args[1]==='get'){name='workbench_configs_get';argumentsValue={configId:option('--config-id')};}
   else if(args[0]==='export'){name='workbench_export_start';argumentsValue={...JSON.parse(await readFile(option('--input'),'utf8')),operationId:option('--operation-id')};}
   else throw Error(`Unmapped smoke command: ${args}`);
   const result=await mcpRequest('tools/call',{name,arguments:argumentsValue});assert.equal(result.isError,false,JSON.stringify(result));
   const envelope=JSON.parse(result.content[0].text);assert.equal(envelope.ok,true);report.cliCalls.push({transport:'mcp',name,arguments:argumentsValue,response:envelope});return envelope.data;
  }
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

 if(exportCheck)await verifyMcpExports({task,cli,api,frame,directory,report});
 const before=await api('GET','/api/state?logs=none');
 const selected=before.configs.find(c=>c.id==='synthetic-selected');
 const input=resolve(directory,'price-sku.json'),op=randomUUID();
 await writeFile(input,JSON.stringify({shopId:'intel',action:{type:'configFields'},targets:[{configId:selected.id,expected:{spu:selected.spu,shortName:selected.shortName,price:selected.price,skuId:selected.skuId},changes:{price:3888.88,skuId:'90071992547409931234'}}]}));
 const preview=await task(['changes','preview','--input',input,'--operation-id',op],op);
 assert.equal((await api('GET','/api/state?logs=none')).revision,before.revision);
 const applyOp=randomUUID(),args=['changes','apply','--plan-id',preview.result.planId,'--operation-id',applyOp];
 const result=await task(args,applyOp);assert.equal(result.result.localSave,'saved');
 const after=await api('GET','/api/state?logs=none'),saved=after.configs.find(c=>c.id===selected.id);
 assert.equal(saved.price,3888.88);assert.equal(saved.skuId,'90071992547409931234');
 assert.deepEqual({...saved,price:selected.price,skuId:selected.skuId},selected);
 assert.deepEqual(after.configs.filter(c=>c.id!==selected.id),before.configs.filter(c=>c.id!==selected.id));
 const retried=await cli(args);assert.equal(retried.status,'succeeded');
 assert.equal((await api('GET','/api/state?logs=none')).revision,after.revision);
 await page.reload();const reopened=page.frames().find(f=>f.url().includes('/workbench/index.html'));
 await reopened.waitForFunction(()=>window.workbenchReady,null,{timeout:45000});
 const readback=await cli(['configs','get','--config-id',selected.id]);
 report.readback=readback;report.beforeRevision=before.revision;report.afterRevision=after.revision;
 assert.ok(JSON.stringify(readback).includes('90071992547409931234'));
 if(exportCheck){assert.equal((await api('GET','/api/state?logs=none')).configs.find(c=>c.id===selected.id).skuExportMode,'padded');report.checks.push('saved_sku_style_survives_reload');}
 assert.deepEqual(report.pageErrors,[]);report.checks.push('configFields_cli_preview_apply','official_sqlite_price_sku_readback','all_other_fields_and_configs_unchanged','same_operation_id_no_duplicate_save','reload_and_cli_readback');report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;throw error;}
finally{
 if(mcp){mcp.stdin.end();await Promise.race([new Promise(resolveExit=>mcp.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);if(mcp.exitCode===null)mcp.kill();mcpLines.close();}
 await browser?.close();if(server)await new Promise(resolveClose=>server.close(resolveClose));
 host.stdin.end();await Promise.race([new Promise(resolveExit=>host.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);if(host.exitCode===null)host.kill();lines.close();
 report.hostDiagnostics=diagnostics;await writeFile(resolve(directory,'completion.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,directory,checks:report.checks,error:report.error}));
}
