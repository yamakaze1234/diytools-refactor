/** 隔离真实 Tauri：Agent 保存、正常关闭、重启、重连与回执幂等验收。 */
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {blankConfig} from '../apps/desktop/public/workbench/core.js';
import {normalizeWorkspaceState} from '../apps/desktop/public/workbench/shops.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.argv.length,4,'node tools/agent-tauri-smoke.mjs DESKTOP_EXE CLI_EXE');
const sourceExe=resolve(process.argv[2]),sourceCli=resolve(process.argv[3]);
const directory=resolve(root,'sandbox',`agent-lifecycle-${Date.now()}`),portable=resolve(directory,'portable');
await mkdir(resolve(portable,'data'),{recursive:true});await mkdir(resolve(directory,'exports'));
const exe=resolve(portable,'DIYTools-Agent-Test.exe'),cliExe=resolve(portable,'diytools-agent.exe');
await copyFile(sourceExe,exe);await copyFile(sourceCli,cliExe);
await writeFile(resolve(portable,'diytools-portable.json'),JSON.stringify({mode:'portable',scope:'synthetic-native-agent-acceptance'}));
const config=blankConfig(null,{id:'synthetic-link',shopId:'intel',name:'隔离真实Tauri主机',spu:'0001234',url:'https://example.invalid/product',installment:0},'配置2');
Object.assign(config,{id:'synthetic-selected',shortName:'Tauri合成隔离配置',shortNameAuto:false,price:3999,caseVisible:false,showUpgrades:true,skuId:'',version:'隔离初始版',footer:'真实Tauri隔离测试'});
config.parts=[{slot:'CPU',name:'合成测试CPU',sourceId:'src-cpu',goodsId:'00001',qty:1,erp:100,tax:110,upgrade:'INITIAL_DESC'},{slot:'内存',name:'合成DDR5 16GB',sourceId:'src-ram',goodsId:'00002',qty:2,erp:150,tax:160,upgrade:''}];
config.actualParts=structuredClone(config.parts);config.actualParts[0].name='实际BOM CPU';
const seed=normalizeWorkspaceState({dataVersion:3,revision:7,updatedAt:'2026-01-01T00:00:00Z',configs:[config],templates:[],sourceCatalog:[],costSource:[],logs:[],caseGallery:[]});
await writeFile(resolve(portable,'data','initial-state.json'),JSON.stringify(seed,null,2));
await writeFile(resolve(portable,'data','integrations.json'),JSON.stringify({version:1}));
const exec=promisify(execFile),report={directory,portable,checks:[],pageErrors:[],cliCalls:[],jobs:[],scope:'Actual packaged Tauri/WebView2 + native named pipe + synthetic portable data only. No installed app, production data, credentials, cloud login or sync.'};
let browser,pid;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
 report.artifacts=[];for(const path of [exe,cliExe]){const bytes=await readFile(path);report.artifacts.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await exec(exe,['--verify-embedded-assets',resolve(directory,'embedded-assets.json')],{windowsHide:true,timeout:20000});
 report.embeddedAssets=JSON.parse(await readFile(resolve(directory,'embedded-assets.json'),'utf8'));assert.equal(report.embeddedAssets.status,'verified');report.checks.push('standalone_embedded_assets_probe');
 const net=await import('node:net');const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 const command=`$env:DIYTOOLS_AGENT_ENABLED='1';$env:WEBVIEW2_USER_DATA_FOLDER=${quote(resolve(portable,'webview2-profile'))};$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${quote(`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --host-resolver-rules="MAP * ~NOTFOUND" --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1 --disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`)};$p=Start-Process -FilePath ${quote(exe)} -WorkingDirectory ${quote(portable)} -WindowStyle Hidden -PassThru;$p.Id`;
 const launch=await exec('pwsh.exe',['-NoProfile','-Command',command],{windowsHide:true,timeout:20000});pid=Number(launch.stdout.trim());assert.ok(Number.isInteger(pid)&&pid>0);report.pid=pid;report.instance=`desktop-${pid}`;
 const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
 for(let attempt=0;attempt<120;attempt++){try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}}catch{}await delay(500);}
 assert.ok(browser,'Dedicated WebView2 CDP endpoint did not start');
 const context=browser.contexts()[0];const page=context.pages()[0];assert.ok(page,'Tauri page missing');page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('iframe'),null,{timeout:45000});
 let frame;for(let attempt=0;attempt<90;attempt++){frame=page.frames().find(f=>f.url().includes('/workbench/index.html'));if(frame)break;await delay(500);}assert.ok(frame,'Original workbench iframe missing');
 await frame.waitForFunction(()=>window.workbenchReady&&typeof window.workbenchAgentExecute==='function',null,{timeout:60000});
 const source=await frame.evaluate(()=>({url:location.href,ready:window.workbenchReady,native:typeof window.workbenchAgentNative,execute:typeof window.workbenchAgentExecute}));report.bridge=source;assert.equal(source.native,'function');await delay(2000);
 const cli=async args=>{const {stdout,stderr}=await exec(cliExe,['--json','--instance',report.instance,...args],{cwd:directory,windowsHide:true,timeout:20000});assert.equal(stderr,'');const envelope=JSON.parse(stdout);assert.equal(envelope.ok,true,stdout);report.cliCalls.push({args,response:envelope});return envelope.data;};
 const status=await cli(['status']);report.nativeStatus=status;assert.equal(status.readOnly,false);report.checks.push('actual_webview2_tauri_bridge_and_agent_pipe');
 const initial=await cli(['configs','get','--config-id','synthetic-selected']);report.initial=initial;report.checks.push('synthetic_portable_store_available');
 async function task(args,operation){const queued=await cli(args);assert.ok(queued.jobId);let latest;for(let attempt=0;attempt<180;attempt++){latest=await cli(['jobs','status','--operation-id',operation]);if(['succeeded','failed','interrupted'].includes(latest.status))break;await delay(500);}report.jobs.push(latest);assert.equal(latest.status,'succeeded',JSON.stringify(latest));return latest;}
 const previewOp=randomUUID(),input=resolve(directory,'change.json');await writeFile(input,JSON.stringify({shopId:'intel',targets:[{configId:'synthetic-selected',partIndex:0,expectedGoodsId:'00001'}],action:{type:'upgrade',value:'ACTUAL_TAURI_DESC_SENTINEL'}}));
 const before=await cli(['configs','get','--config-id','synthetic-selected']);
 const preview=await task(['changes','preview','--input',input,'--operation-id',previewOp],previewOp);
 const afterPreview=await cli(['configs','get','--config-id','synthetic-selected']);assert.equal(afterPreview.revision,before.revision);report.checks.push('actual_tauri_preview_without_save');
 const applyOp=randomUUID(),applyArgs=['changes','apply','--plan-id',preview.result.planId,'--operation-id',applyOp];const applied=await task(applyArgs,applyOp);assert.equal(applied.result.localSave,'saved');
 const saved=await cli(['configs','get','--config-id','synthetic-selected']);report.saved=saved;assert.ok(JSON.stringify(saved).includes('ACTUAL_TAURI_DESC_SENTINEL'));const retry=await cli(applyArgs);assert.equal(retry.status,'succeeded');assert.equal((await cli(['configs','get','--config-id','synthetic-selected'])).revision,saved.revision);report.checks.push('actual_tauri_apply_local_receipt','actual_tauri_same_operation_no_second_save');

 report.closeMethod=process.env.AGENT_TEST_OS_CLOSE==='1'?'main-window-WM_CLOSE':'Tauri-window-close';report.beforeClose=await frame.evaluate(()=>({pending:window.workbenchHasPendingChanges?.(),busy:window.workbenchAgentBusy,body:document.body.innerText.slice(-500)}));
 if(process.env.AGENT_TEST_OS_CLOSE==='1'){
 const osSource='using System; using System.Runtime.InteropServices; public static class LifecycleClose { public delegate bool E(IntPtr h,IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(E f,IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); public static void Close(uint p){EnumWindows((h,l)=>{uint id;GetWindowThreadProcessId(h,out id);var title=new System.Text.StringBuilder(256);GetWindowText(h,title,256);if(id==p && title.ToString().StartsWith("DIY Tools"))PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);}}';
 await exec('pwsh.exe',['-NoProfile','-Command',`Add-Type -TypeDefinition '${osSource}';[LifecycleClose]::Close([uint32]${pid})`],{windowsHide:true,timeout:15000});
 }else{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));}
 await delay(12000);
 report.closeState=await page.evaluate(()=>({pending:window.workbenchClosePending,body:document.body.innerText})).catch(e=>({closed:true,error:e.message}));
 const alive=await exec('pwsh.exe',['-NoProfile','-Command',`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`],{windowsHide:true});
 report.aliveAfterClose=alive.stdout.trim();assert.equal(report.aliveAfterClose,'False',JSON.stringify(report.closeState));
 report.checks.push('normal_close_after_agent_save');pid=null;
 await browser.close().catch(()=>{});
 const second=await exec('pwsh.exe',['-NoProfile','-Command',command],{windowsHide:true,timeout:20000});pid=Number(second.stdout.trim());report.restartPid=pid;report.instance=`desktop-${pid}`;
 for(let n=0;n<90;n++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await delay(500);}}
 const page2=browser.contexts()[0].pages()[0];await page2.waitForFunction(()=>document.querySelector('iframe'),null,{timeout:45000});
 let frame2;for(let n=0;n<90;n++){frame2=page2.frames().find(f=>f.url().includes('/workbench/index.html'));if(frame2)break;await delay(500);}
 await frame2.waitForFunction(()=>window.workbenchReady&&typeof window.workbenchAgentExecute==='function',null,{timeout:60000});await delay(1500);
 const persisted=await cli(['configs','get','--config-id','synthetic-selected']);assert.deepEqual(persisted,saved);
 assert.equal((await cli(['status'])).readOnly,false);
 const resumed=await cli(applyArgs);assert.equal(resumed.status,'succeeded');assert.equal((await cli(['configs','get','--config-id','synthetic-selected'])).revision,saved.revision);
 const freshOp=randomUUID();await task(['changes','preview','--input',input,'--operation-id',freshOp],freshOp);
 report.checks.push('restart_saved_content_and_revision_preserved','new_pipe_instance_reconnect','persisted_receipt_idempotent_after_restart','restarted_ui_accepts_new_job');
 await page2.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}));
 let stopped=false;for(let n=0;n<30;n++){const r=await exec('pwsh.exe',['-NoProfile','-Command',`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`],{windowsHide:true});if(r.stdout.trim()==='False'){stopped=true;break;}await delay(500);}
 assert.ok(stopped,'Second normal close timed out');report.checks.push('second_normal_close');pid=null;report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;process.exitCode=1;}
finally{if(browser)await browser.close().catch(()=>{});await writeFile(resolve(directory,'completion.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,directory,pid,error:report.error,closeState:report.closeState}));}
