/** 真实 Tauri 便携包隔离验收。只启动本脚本新建目录内的候选 EXE。 */
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
const directory=resolve(root,'sandbox',`agent-tauri-smoke-${Date.now()}`),portable=resolve(directory,'portable');
await mkdir(resolve(portable,'data'),{recursive:true});await mkdir(resolve(directory,'exports'));
const exe=resolve(portable,'DIYTools-Agent-Test.exe'),cliExe=resolve(portable,'diytools-agent.exe');
await copyFile(sourceExe,exe);await copyFile(sourceCli,cliExe);
await writeFile(resolve(portable,'diytools-portable.json'),JSON.stringify({mode:'portable',scope:'synthetic-native-agent-acceptance'}));
const config=blankConfig(null,{id:'synthetic-link',shopId:'intel',name:'隔离真实Tauri主机',spu:'0001234',url:'https://example.invalid/product',installment:0},'配置2');
Object.assign(config,{id:'synthetic-selected',shortName:'Tauri合成隔离配置',shortNameAuto:false,price:3999,caseVisible:false,showUpgrades:true,skuId:'',version:'隔离初始版',footer:'真实Tauri隔离测试'});
config.parts=[{slot:'CPU',name:'合成测试CPU',sourceId:'src-cpu',goodsId:'00001',qty:1,erp:100,tax:110,upgrade:'INITIAL_DESC'},{slot:'内存',name:'合成DDR5 16GB',sourceId:'src-ram',goodsId:'00002',qty:2,erp:150,tax:160,upgrade:''}];
config.actualParts=structuredClone(config.parts);config.actualParts[0].name='实际BOM CPU';
if(process.env.AGENT_TEST_THEME==='dark'){config.productTheme='dark';config.theme='light';}
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
 const exportOp=randomUUID(),exportInput=resolve(directory,'export.json');await writeFile(exportInput,JSON.stringify({sourceOperationId:applyOp,images:'both',report:true,outputDir:resolve(directory,'exports')}));
 const exported=await task(['export','--input',exportInput,'--operation-id',exportOp],exportOp);report.export=exported;
 for(const key of ['zipPath','reportPath','manifestPath'])assert.ok((await stat(exported.result[key])).size>0);
 const manifest=JSON.parse(await readFile(exported.result.manifestPath,'utf8'));for(const file of manifest.files){const bytes=await readFile(resolve(exported.result.directory,file.name));assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));}
 if(process.env.AGENT_TEST_THEME==='dark'){
  const darkPixels=[];for(const file of manifest.files){const bytes=await readFile(resolve(exported.result.directory,file.name));const count=await page.evaluate(async base64=>{const blob=await (await fetch('data:image/png;base64,'+base64)).blob(),img=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i]===16&&data[i+1]===45&&data[i+2]===80)count++;img.close();return count;},bytes.toString('base64'));assert.ok(count>1000,'Saved dark theme must render dark background');darkPixels.push({file:file.name,count});}report.darkTheme={darkPixels,savedThemeRetained:await frame.evaluate(async()=>{const state=await (await fetch('/api/state')).json();return state.configs.find(c=>c.id==='synthetic-selected').productTheme==='dark';})};assert.ok(report.darkTheme.savedThemeRetained);report.checks.push('agent_edit_and_both_exports_preserve_saved_dark_link_theme');
 }
 assert.equal(manifest.files.length,2);const html=await readFile(exported.result.reportPath,'utf8');assert.ok(html.includes('ACTUAL_TAURI_DESC_SENTINEL'));report.manifest=manifest;report.checks.push('actual_tauri_native_png_report_manifest_zip','native_png_signature_sha256_bytes');
 await page.screenshot({path:resolve(directory,'actual-tauri.png'),fullPage:true});
 const zipTest=await exec('pwsh.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead(${quote(exported.result.zipPath)});try{ $z.Entries | ForEach-Object { $s=$_.Open();try{$s.CopyTo([IO.Stream]::Null)}finally{$s.Dispose()} }; $z.Entries.FullName | ConvertTo-Json -Compress }finally{$z.Dispose()}`],{windowsHide:true,timeout:20000});report.zipEntries=JSON.parse(zipTest.stdout);assert.equal(report.zipEntries.filter(x=>x.endsWith('.png')).length,2);report.checks.push('independent_dotnet_zip_read');
 assert.deepEqual(report.pageErrors,[]);report.checks.push('no_pageerrors');
 const standalone=resolve(directory,'standalone');await mkdir(resolve(standalone,'data'),{recursive:true});
 await copyFile(exe,resolve(standalone,'DIYTools-Agent-Test.exe'));await copyFile(cliExe,resolve(standalone,'diytools-agent.exe'));
 await writeFile(resolve(standalone,'diytools-portable.json'),JSON.stringify({mode:'portable',scope:'synthetic-agent-local-test'}));
 await writeFile(resolve(standalone,'data','initial-state.json'),JSON.stringify(seed,null,2));await writeFile(resolve(standalone,'data','integrations.json'),JSON.stringify({version:1}));
 await writeFile(resolve(standalone,'start-agent.ps1'),String.raw`$ErrorActionPreference = 'Stop'
$env:DIYTOOLS_AGENT_ENABLED = '1'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $PSScriptRoot 'webview2-profile'
$taskProgram = Join-Path $PSScriptRoot 'DIYTools-Agent-Test.exe'
$taskProcess = Start-Process -FilePath $taskProgram -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Write-Output ('Agent instance: desktop-' + $taskProcess.Id)
Write-Output ('CLI: ' + (Join-Path $PSScriptRoot 'diytools-agent.exe'))
`);
 await writeFile(resolve(standalone,'TEST-ONLY.txt'),'本包仅含本次候选 EXE、Rust CLI 与纯合成种子，不含真实业务库、账号、凭据或云接入配置。\r\n运行 start-agent.ps1 后按输出的 desktop-PID 指定 CLI --instance。\r\nEXE 和 CLI 不依赖 Node.js、Python 或源码；桌面仍要求 Windows WebView2 Runtime。\r\n数据和 WebView2 状态只在本包目录生成；不安装、不替换现用程序。\r\n');
 const packageZip=resolve(directory,'DIYTools-Agent-Synthetic-Test.zip');
 await exec('pwsh.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory(${quote(standalone)},${quote(packageZip)})`],{windowsHide:true,timeout:120000});
 report.standalonePackage={directory:standalone,zipPath:packageZip,bytes:(await stat(packageZip)).size,sha256:createHash('sha256').update(await readFile(packageZip)).digest('hex')};report.checks.push('clean_synthetic_standalone_package_no_node_python');report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;throw e;}
finally {

 if(pid){try{
  // 仅关闭有工作台标题的主窗口；辅助 WebView 窗口收到 WM_CLOSE 会先破坏保存 IPC。
  const closeSource='using System; using System.Runtime.InteropServices; public static class AgentTestWindowClose { public delegate bool E(IntPtr h,IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(E f,IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); public static void Close(uint p){EnumWindows((h,l)=>{uint id;GetWindowThreadProcessId(h,out id);var title=new System.Text.StringBuilder(256);GetWindowText(h,title,256);if(id==p && title.ToString().StartsWith("DIY Tools"))PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);}}';
  const closed=await exec('pwsh.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p -and $p.Path -eq '${exe.replaceAll("'","''")}'){Add-Type -TypeDefinition '${closeSource}';[AgentTestWindowClose]::Close([uint32]$p.Id);if(-not $p.WaitForExit(10000)){$p.Kill();$p.WaitForExit();Write-Output 'forced-owned-test-process'}else{Write-Output 'normal-window-close'}}else{Write-Output 'already-exited'}`],{windowsHide:true,timeout:20000});report.shutdown=closed.stdout.trim();
 }catch(e){report.closeError=e.message;}}

 if(browser)await browser.close().catch(()=>{});
 await writeFile(resolve(directory,'completion.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,directory,checks:report.checks,error:report.error,closeError:report.closeError}));
}
