import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/workbench/workspace-sync-ui.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export async function bindWorkspaceSync','async function bindWorkspaceSync');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function harness({diagnosticExport,diagnosticText,save=async()=>{},stop=async()=>{},start=async()=>{},authenticated=true,configured=true,maintenance=async()=>({skipped:true}),fetcher=async()=>{throw Error('unexpected fetch');}}={}){
 const elements=new Map(),calls=[],messages=[],posted=[],intervals=[],dialogs=[];let options,historyOptions,legacyOptions;
 const node=()=>({textContent:'',title:'',disabled:false,hidden:false,dataset:{},open:true,focus(){},select(){},addEventListener(){},close(){this.open=false;calls.push('close');}});
 for(const id of ['#workspace-sync','#workspace-sync-status','#operator-open','#dialog'])elements.set(id,node());
 const view={session:{configured,authenticated,member:authenticated?{name:'成员'}:null},checkpoint:{initialized:true,conflicts:0},summary:{pending:2},running:false,automatic:true,error:null};
 const controller={status:()=>view,refresh:async()=>{calls.push('refresh');options.onChange(view);},start:async()=>{calls.push('start');await start();},tick:async()=>calls.push('tick'),run:async upload=>{calls.push(['run',upload]);view.automatic=true;options.onChange(view);},stop:async()=>{calls.push('stop');await stop();view.automatic=false;options.onChange(view);},logout:async()=>{calls.push('logout');view.session={authenticated:false,member:null};options.onChange(view);},pause:()=>{},deliver:async()=>{},conflicts:async()=>({rows:[],total:0})};
 const document={querySelector:selector=>elements.get(selector)||null,querySelectorAll:selector=>selector==='[data-cloud-idle]'?[...elements.values()].filter(n=>n.idle):[]};
 const parent={postMessage:(value,origin)=>posted.push({value,origin}),workbenchClosePending:false,workbenchUpdatePending:false};
 const context=vm.createContext({document,fetch:async(url,options)=>url.endsWith('/maintain')?{ok:true,json:maintenance}:fetcher(url,options),location:{origin:'http://workbench'},window:{parent,workbenchExportDiagnostics:diagnosticExport,workbenchDiagnosticText:diagnosticText,addEventListener(){}},setTimeout,clearInterval(){},setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},bindVersionHistory:opts=>{historyOptions=opts;return{open(){calls.push('history');},restore(){calls.push('restore');}};},bindLegacyHistory:opts=>{legacyOptions=opts;return{open(){calls.push('legacy');}};},createCloudWorker(){},createCloudController:opts=>{options=opts;return controller;}});
 vm.runInContext(source,context);
 const ui=await context.bindWorkspaceSync({flush:async()=>{calls.push('save');await save();},receive:async()=>true,esc:String,toast:text=>messages.push(text),openDialog:(title,html)=>{dialogs.push({title,html});for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)){const element=node();element.idle=match[0].includes('data-cloud-idle');elements.set('#'+match[1],element);}}});
 await new Promise(resolve=>setImmediate(resolve));
 return{ui,controller,view,options,elements,calls,messages,posted,intervals,dialogs,parent,historyOptions,legacyOptions};
}

test('Agent 手动同步返回真实 pending 与冲突，未知 pending 不转换为零',async()=>{
 const env=await harness();env.calls.length=0;
 let result=await env.ui.runAgent();assert.deepEqual(env.calls.find(Array.isArray),['run',true]);assert.equal(result.pending,2);
 env.view.summary={};result=await env.ui.runAgent();assert.equal(result.pending,null);
 env.view.summary={pending:0,conflicts:1};result=await env.ui.runAgent();assert.equal(result.conflicts,1);assert.equal(result.pending,0);
 env.view.error='synthetic error';assert.equal((await env.ui.runAgent()).error,'synthetic error');
});
test('startup sync is background work, 2-hour timer uses tick, panel has no manual plan controls',async()=>{
 const gate=deferred(),env=await harness({start:()=>gate.promise});assert(env.calls.includes('start'));assert.equal(env.intervals[0].ms,2*60*60*1000);
 await env.ui.open();const html=env.dialogs.at(-1).html;assert.match(html,/立即同步/);assert.doesNotMatch(html,/接入计划|云端游标|待确认请求|cloud-plan|cloud-login/);
 assert.equal(env.elements.get('#cloud-conflicts').hidden,true);env.view.checkpoint.conflicts=1;env.options.onChange(env.view);assert.equal(env.elements.get('#cloud-conflicts').hidden,false);
 await env.elements.get('#cloud-sync-now').onclick();assert.deepEqual(env.calls.find(c=>Array.isArray(c)),['run',true]);await env.intervals[0].fn();assert(env.calls.includes('tick'));gate.resolve();
});

test('unconfigured local workbench keeps history/cache and skips startup and periodic sync',async()=>{
 let maintenance=0;const env=await harness({configured:false,authenticated:false,maintenance:async()=>{maintenance++;return{skipped:true};}});
 assert(!env.calls.includes('start'));assert(!env.intervals.some(timer=>timer.ms===2*60*60*1000));assert.equal(maintenance,1);
 assert.equal(env.elements.get('#workspace-sync-status').textContent,'本机保存');
 assert.equal(env.elements.get('#operator-open').textContent,'本机工作台');
 await env.ui.open();const html=env.dialogs.at(-1).html;
 assert.match(html,/云同步未配置/);assert.match(html,/本机历史版本/);assert.doesNotMatch(html,/cloud-logout|cloud-sync-now|登录已失效/);
});
test('incidental expired status preserves iframe and editing; only protected explicit action signs out',async()=>{
 const env=await harness();env.view.session={authenticated:false,member:null};env.options.onChange(env.view);assert.equal(env.posted.length,0);
 await env.ui.open();assert.match(env.dialogs.at(-1).html,/保存并重新登录/);env.calls.length=0;await env.elements.get('#cloud-logout').onclick();
 assert.deepEqual(env.calls,['stop','save','logout']);assert.equal(env.posted.length,1);assert.equal(env.posted[0].value.type,'workbench-signed-out');assert.equal(env.posted[0].origin,'http://workbench');
});
test('failed save does not log out or detach the editing frame',async()=>{
 let fail=false;const env=await harness({save:async()=>{if(fail)throw Error('保存失败');}});await env.ui.open();fail=true;env.calls.length=0;await env.elements.get('#cloud-logout').onclick();
 assert.deepEqual(env.calls,['stop','save']);assert.equal(env.posted.length,0);assert.equal(env.elements.get('#cloud-message').textContent,'保存失败');
});
test('failed stop does not save/log out/detach and is visible',async()=>{
 const env=await harness({stop:async()=>{throw Error('停止失败');}});await env.ui.open();env.calls.length=0;await env.elements.get('#cloud-logout').onclick();
 assert.deepEqual(env.calls,['stop']);assert.equal(env.posted.length,0);assert.equal(env.elements.get('#cloud-message').textContent,'停止失败');
});
test('update/close protection blocks sync and sign-out controls',async()=>{
 const env=await harness();await env.ui.open();env.parent.workbenchUpdatePending=true;env.calls.length=0;await env.elements.get('#cloud-logout').onclick();assert.equal(env.calls.length,0);assert.equal(env.posted.length,0);assert.match(env.elements.get('#cloud-message').textContent,/等待/);
});


test('cache preview is read-only; clear saves first and reports reusable index content',async()=>{
 const requests=[];const env=await harness({fetcher:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('preview')?{count:5,bytes:3145728,categories:[{id:'update-backups',label:'历史更新备份',count:2,bytes:2097152}]}:{cleared:{count:5,bytes:3145728,index:{count:3},updates:{count:2,bytes:2097152}}}};}});
 await env.ui.open();assert.match(env.dialogs.at(-1).html,/每 2 小时/);await env.elements.get('#local-cache').onclick();
 assert.equal(requests.length,1);assert(requests[0].url.endsWith('/preview'));assert(!requests[0].options.method);
 assert.match(env.dialogs.at(-1).html,/历史记录、恢复草稿和原图均保留/);assert.match(env.dialogs.at(-1).html,/不会立即缩小/);
 assert.match(env.dialogs.at(-1).html,/历史更新备份：2 项，约 2.00 MiB/);assert.match(env.dialogs.at(-1).html,/只保留最近一次可回退备份/);
 env.calls.length=0;await env.elements.get('#cache-clear').onclick();assert.deepEqual(env.calls,['save']);assert.equal(requests[1].options.method,'POST');assert.equal(requests[1].options.body,'{}');assert.match(env.elements.get('#cache-message').textContent,/3 套配置索引已清理/);
 assert.match(env.elements.get('#cache-message').textContent,/2 个历史更新备份（2.00 MiB）/);
});

test('cache preview stays available during sync while clearing is blocked, then preserves a failed save',async()=>{
 let fail=false;const requests=[];const env=await harness({save:async()=>{if(fail)throw Error('草稿保存失败');},fetcher:async url=>{requests.push(url);return {ok:true,json:async()=>({count:1,bytes:10})};}});
 await env.ui.open();env.view.running=true;env.calls.length=0;await env.elements.get('#local-cache').onclick();assert.equal(requests.length,1);assert(!env.calls.includes('save'));
 await env.elements.get('#cache-clear').onclick();assert.equal(requests.length,1);assert.match(env.elements.get('#cache-message').textContent,/同步/);
 env.view.running=false;fail=true;await env.elements.get('#cache-clear').onclick();assert.equal(requests.length,1);assert.match(env.elements.get('#cache-message').textContent,/草稿保存失败/);assert.equal(env.elements.get('#cache-clear').disabled,false);
});

test('cache request failure shows no success and permits retry',async()=>{
 const env=await harness({fetcher:async url=>({ok:url.endsWith('preview'),json:async()=>url.endsWith('preview')?{count:1,bytes:1}:{error:'缓存事务失败'}})});
 await env.ui.open();await env.elements.get('#local-cache').onclick();await env.elements.get('#cache-clear').onclick();
 assert.equal(env.elements.get('#cache-message').textContent,'缓存事务失败');assert.equal(env.elements.get('#cache-clear').disabled,false);assert(!env.messages.some(x=>x.includes('已清理')));
});


test('cache maintenance checks on startup and hourly, skips active sync and close protection',async()=>{
 let checks=0;const env=await harness({maintenance:async()=>{checks++;return{skipped:true};}});
 assert.equal(checks,1);const timer=env.intervals.find(x=>x.ms===60*60*1000);assert(timer);
 env.view.running=true;await timer.fn();assert.equal(checks,1);env.view.running=false;env.parent.workbenchClosePending=true;await timer.fn();assert.equal(checks,1);
 env.parent.workbenchClosePending=false;await timer.fn();assert.equal(checks,2);
});


test('failed startup sync does not prevent local scheduled cleanup checks',async()=>{
 let checks=0;const env=await harness({start:async()=>{throw Error('离线');},maintenance:async()=>{checks++;return{skipped:true};}});
 assert.equal(checks,1);assert(env.messages.includes('离线'));
});

// 同步面板展示、浏览和收起不能依赖未结束的上传，也不能偷偷保存当前草稿。
test('running sync leaves local read entries and closing usable without stopping or flushing',async()=>{
 const env=await harness();env.view.running=true;env.calls.length=0;
 await env.ui.open();env.options.onChange(env.view);
 assert(!env.calls.includes('save'));assert(!env.calls.includes('refresh'));
 for(const id of ['#local-cache','#offline-history','#offline-restore','#offline-legacy-history','#cloud-close'])assert.equal(env.elements.get(id).disabled,false,id);
 assert.equal(env.elements.get('#cloud-sync-now').disabled,true);
 await env.elements.get('#offline-history').onclick();await env.elements.get('#offline-restore').onclick();await env.elements.get('#offline-legacy-history').onclick();await env.elements.get('#cloud-close').onclick();
 assert.deepEqual(env.calls,['history','restore','legacy','close']);
 assert.match(env.dialogs.at(-1).html,/关闭此窗口继续编辑/);
});

// 只有实际写操作持有互斥；同步、退出和失败路径都不能泄漏互斥状态。
test('history mutations block active sync and prevent sync starting until local write finishes',async()=>{
 const env=await harness();let writes=0;env.view.running=true;
 await assert.rejects(()=>env.historyOptions.runMutation(async()=>writes++),/同步正在后台/);
 assert.equal(writes,0);env.view.running=false;
 const gate=deferred();const write=env.legacyOptions.runMutation(async()=>{writes++;await gate.promise;});
 assert.equal(env.options.isBlocked(),true);
 await assert.rejects(()=>env.historyOptions.runMutation(async()=>writes++),/本机维护/);
 gate.resolve();await write;assert.equal(env.options.isBlocked(),false);assert.equal(writes,1);
 await assert.rejects(()=>env.historyOptions.runMutation(async()=>{throw Error('事务失败');}),/事务失败/);
 assert.equal(env.options.isBlocked(),false);
 env.parent.workbenchClosePending=true;
 await assert.rejects(()=>env.legacyOptions.runMutation(async()=>writes++),/保存、退出/);
 assert.equal(writes,1);
});

// 使用真实历史绑定验证：只读入口不保存，恢复写入仍经过同步互斥和草稿保存。
function historyHarness(kind,{fetcher,save=async()=>{}}={}){
 const file=kind==='version'?'version-history-ui.js':'legacy-history-ui.js',binding=kind==='version'?'bindVersionHistory':'bindLegacyHistory';
 const code=readFileSync(new URL('../public/workbench/'+file,import.meta.url),'utf8').replace('export function '+binding,'function '+binding);
 const nodes=[],elements=new Map(),requests=[],calls=[],messages=[],dialogs=[];let running=false;
 const dialog={open:false,close(){this.open=false;calls.push('close');}};elements.set('#dialog',dialog);
 const document={querySelector:key=>elements.get(key)||null,querySelectorAll:selector=>{const key=selector.slice(1,-1).replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return nodes.filter(node=>node.isConnected&&key in node.dataset);}};
 const openDialog=(title,html)=>{
  nodes.forEach(node=>node.isConnected=false);elements.clear();elements.set('#dialog',dialog);dialog.open=true;dialogs.push({title,html});
  for(const match of html.matchAll(/<[^>]+>/g)){
   const node={isConnected:true,dataset:{},textContent:'',disabled:/\bdisabled/.test(match[0]),checked:false,value:'测试命名'};
   for(const attr of match[0].matchAll(/(id|data-[a-z-]+)="([^"]*)"/g)){
    if(attr[1]==='id')elements.set('#'+attr[2],node);else node.dataset[attr[1].slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=attr[2];
   }
   nodes.push(node);
  }
 };
 const fetch=async(url,options)=>{const body=options?.body?JSON.parse(options.body):null;requests.push({url,body});let result=fetcher?await fetcher(url,body):undefined;
  if(result===undefined){
   if(url==='/api/versions')result={versions:[{id:'v1',revision:1,at:'2026-10-13',name:'命名版本',pinned:true}]};
   else if(url.endsWith('/status'))result={available:true,bytes:100,count:1};
   else if(url.endsWith('/versions'))result={versions:[{id:'v1',revision:1}],offset:0,limit:20,total:1};
   else if(url.endsWith('/preview'))result={id:'v1',hash:'hash',baseRevision:3,revision:1,changes:[{id:'c1',name:'配置1',type:'配置'}],offset:0,limit:20,total:1};
   else result={};
  }
  return{ok:true,json:async()=>result};
 };
 const context=vm.createContext({document,fetch});vm.runInContext(code,context);
 const ui=context[binding]({flush:async()=>{calls.push('save');await save();},receive:async()=>calls.push('receive'),openDialog,esc:String,toast:message=>messages.push(message),runMutation:async operation=>{calls.push('mutation');if(running)throw Error('同步正在后台进行');return operation();}});
 return{ui,elements,document,dialog,requests,calls,messages,dialogs,setRunning:value=>{running=value;}};
}

test('real local history preview remains read-only and restore blocks sync before saving or writing',async()=>{
 const env=historyHarness('version');env.setRunning(true);await env.ui.open();
 await env.document.querySelectorAll('[data-version]')[0].onclick();assert(!env.calls.includes('save'));
 await env.elements.get('#version-apply').onclick();assert.deepEqual(env.calls,['mutation']);assert(!env.requests.some(x=>x.url.endsWith('/restore')));assert.match(env.messages.at(-1),/同步/);
 env.setRunning(false);await env.elements.get('#version-apply').onclick();assert.deepEqual(env.calls,['mutation','mutation','save','close','receive']);assert.equal(env.requests.at(-1).body.baseRevision,3);
});

test('local history naming and deleting markers also acquire write protection',async()=>{
 const env=historyHarness('version');env.setRunning(true);await env.ui.open();await env.elements.get('#version-name').onclick();await env.elements.get('#version-name-save').onclick();
 assert(!env.calls.includes('save'));assert(!env.requests.some(x=>x.url.endsWith('/name')));
 await env.ui.open();await env.document.querySelectorAll('[data-delete-named]')[0].onclick();await env.elements.get('#version-delete-confirm').onclick();
 assert(!env.requests.some(x=>x.url.endsWith('/delete-named')));assert.deepEqual(env.calls,['mutation','mutation']);
});

test('closing local history while its read is pending does not reopen the modal',async()=>{
 const gate=deferred();const env=historyHarness('version',{fetcher:async url=>url==='/api/versions'?gate.promise:undefined});const pending=env.ui.open();env.dialog.close();gate.resolve({versions:[]});await pending;
 assert.equal(env.dialogs.length,1);assert.equal(env.dialog.open,false);assert.deepEqual(env.messages,[]);
});

test('real legacy history preview does not save, and only confirmation enters write protection',async()=>{
 const env=historyHarness('legacy');env.setRunning(true);await env.ui.open();await env.document.querySelectorAll('[data-legacy-version]')[0].onclick();
 assert(!env.calls.includes('save'));const selected=env.document.querySelectorAll('[data-legacy-select]')[0];selected.checked=true;selected.onchange();await env.elements.get('#legacy-restore').onclick();await env.elements.get('#legacy-confirm').onclick();
 assert.deepEqual(env.calls,['mutation']);assert(!env.requests.some(x=>x.url.endsWith('/restore')));
 env.setRunning(false);await env.elements.get('#legacy-confirm').onclick();assert.deepEqual(env.calls,['mutation','mutation','save','close','receive']);assert.deepEqual(env.requests.at(-1).body.configIds,['c1']);
});

test('local history restore stops after failed draft save, keeping the dialog and data',async()=>{
 const env=historyHarness('version',{save:async()=>{throw Error('草稿保存失败');}});await env.ui.open();await env.document.querySelectorAll('[data-version]')[0].onclick();await env.elements.get('#version-apply').onclick();
 assert(!env.requests.some(x=>x.url.endsWith('/restore')));assert.equal(env.dialog.open,true);assert.equal(env.elements.get('#version-apply').disabled,false);assert.equal(env.messages.at(-1),'草稿保存失败');
});

test('sync progress shows confirmed item counts and asset stages without invented percentages',async()=>{
 const env=await harness();await env.ui.open();env.view.running=true;env.options.onProgress({phase:'upload',count:40,completed:80});assert.match(env.elements.get('#cloud-message').textContent,/本批 40 项，已处理 80 项/);
 env.options.onProgress({phase:'assets-upload',count:3});assert.match(env.elements.get('#cloud-message').textContent,/上传原图：本批 3 张/);
 env.options.onProgress({phase:'assets-download',count:2});assert.match(env.elements.get('#cloud-message').textContent,/接收原图：本批 2 张/);
 env.options.onProgress({phase:'checkpoint'});assert.match(env.elements.get('#cloud-message').textContent,/保存同步结果/);
 env.options.onProgress({phase:'checkpoint-request',page:8,received:700,attempt:1});assert.match(env.elements.get('#cloud-message').textContent,/第 8 页，已接收 700 项/);
 env.options.onProgress({phase:'checkpoint-commit',received:19820});assert.match(env.elements.get('#cloud-message').textContent,/19820 项数据保存到本机/);
 env.options.onProgress({phase:'download',page:2,received:150,cursor:63000,total:63251});assert.match(env.elements.get('#cloud-message').textContent,/150 条变更.*同步序号 63000 \/ 63251/);assert.doesNotMatch(env.elements.get('#cloud-message').textContent,/undefined|%/);
});


test('closing a slow cache preview does not reopen the panel after it finishes',async()=>{
 const gate=deferred();const env=await harness({fetcher:async()=>({ok:true,json:()=>gate.promise})});await env.ui.open();const reading=env.elements.get('#local-cache').onclick();
 env.elements.get('#dialog').close();const count=env.dialogs.length;gate.resolve({count:1,bytes:1});await reading;assert.equal(env.dialogs.length,count);assert.equal(env.elements.get('#dialog').open,false);
});

// 同步卡住时导出不进入保存或同步互斥，取消/失败不能提示保存成功。
test('diagnostics export remains usable while sync runs and reports only confirmed save',async()=>{
 let mode='saved',calls=0;
 const env=await harness({diagnosticExport:async()=>{calls++;if(mode==='failed')throw Error('secret SQL error');return mode;}});
 env.view.running=true;await env.ui.open();const before=env.calls.length;
 const button=env.elements.get('#cloud-diagnostics');assert.equal(button.disabled,false);
 await button.onclick();assert.equal(calls,1);assert.match(env.messages.at(-1),/已保存/);
 assert(!env.calls.slice(before).includes('save'));assert(!env.calls.slice(before).includes('stop'));
 mode='cancelled';await button.onclick();assert.equal(env.messages.at(-1),'已取消导出');
 mode='failed';await button.onclick();assert.match(env.messages.at(-1),/尚未确认保存/);assert(!env.messages.at(-1).includes('secret'));assert.equal(button.disabled,false);
});


test('diagnostic text opens while export hangs without waiting for save or cloud',async()=>{
 const pending=deferred(),sample='{"privacy":"metadata-only","events":[]}';
 const env=await harness({diagnosticExport:()=>pending.promise,diagnosticText:()=>sample});
 await env.ui.open();env.calls.length=0;
 const exporting=env.elements.get('#cloud-diagnostics').onclick();
 assert.equal(env.elements.get('#cloud-diagnostics').disabled,true);
 env.elements.get('#cloud-diagnostic-text').onclick();
 assert.equal(env.elements.get('#diagnostic-text').value,sample);
 assert(!env.calls.includes('save'));assert(!env.calls.includes('stop'));
 pending.resolve('cancelled');await exporting;
});
