/** 已启动的本机合成 NAS 桌面、真实 Windows 管道、MCP stdio 与 Tauri 权限验收。 */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile,realpath,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {checkNasWrites} from './agent-nas-write-smoke.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const connectionPath=await realpath(process.argv[2]);
const port=Number(process.argv[3]);
assert.ok(Number.isInteger(port)&&port>0&&port<65536,'需要验收 WebView2 的回环调试端口');
const folder=dirname(connectionPath);
assert.ok((await stat(join(folder,'验收服务','fixture','test-ca.pem'))).isFile());
const activityVersion=(await readFile(join(folder,'acceptance-data/p1-version.txt'),'utf8')).trim();
assert.ok(['033','034'].includes(activityVersion));
const requests=async()=> (await readFile(join(folder,'acceptance-data/p1-http.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const info=JSON.parse(await readFile(connectionPath,'utf8'));
const cliPath=await realpath(info.cli);
assert.equal(dirname(cliPath),folder);
const cli=args=>JSON.parse(execFileSync(cliPath,['--json','--instance',info.instance,...args],{encoding:'utf8',windowsHide:true,timeout:15000})).data;
const doctor=cli(['doctor']);
assert.equal(doctor.status.snapshot,'nasSaved');
assert.equal(doctor.status.account.uid,'fixture_existing01');
assert.equal(doctor.status.agentPermissionVersion,1);
assert.deepEqual(Object.keys(doctor.status.shopCapabilities).sort(),['gigabyte','intel','jonsbo']);

const {chromium}=createRequire(join(root,'apps/desktop/package.json'))('playwright');
const endpoint='http://127.0.0.1:'+port;
const webDeadline=Date.now()+20000;
let browser,page;
while(Date.now()<webDeadline&&!page){
  if(!browser){
    try{browser=await chromium.connectOverCDP(endpoint,{timeout:1500});}catch{await delay(200);continue;}
  }
  page=browser.contexts()[0]?.pages().find(p=>new URL(p.url()).hostname==='tauri.localhost');
  if(!page)await delay(200);
}
assert.ok(page,'需要实际 Tauri 工作台');
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke&&Array.from(document.querySelectorAll('iframe')).some(frame=>frame.contentWindow?.workbenchReady),undefined,{timeout:30000});
const native=(name,params={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[name,params]);
const initial=await native('agent_permissions_get');
assert.equal(initial.instance,info.instance);
assert.equal(initial.available,true);
assert.ok(initial.enabled&&initial.permissions.readInventoryActivity&&initial.permissions.readSources);
const set=patch=>native('agent_permissions_set',{scopeKey:initial.scopeKey,patch});
const processMcp=spawn(cliPath,['mcp','--connection',connectionPath,'--follow-workbench'],{windowsHide:true,stdio:['pipe','pipe','inherit']});
const output=createInterface({input:processMcp.stdout})[Symbol.asyncIterator]();
let nextId=0;
async function rpc(method,params={}){
  const id=++nextId;
  processMcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  // 连续读取同一个 stdio 会话，可验证中途撤权及稳定目录。
  let timer;
  try {
    const record=await Promise.race([output.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MCP 超时 '+method)),18000);})]);
    assert.ok(!record.done);
    const packet=JSON.parse(record.value);
    assert.equal(packet.id,id);
    assert.equal(packet.error,undefined,JSON.stringify(packet.error));
    return packet.result;
  } finally {clearTimeout(timer);}
}
async function tool(name,args={},error=null){
  const result=await rpc('tools/call',{name,arguments:args});
  const response=JSON.parse(result.content[0].text);
  if(error){assert.equal(result.isError,true);assert.equal(response.error.code,error);return response.error;}
  assert.equal(response.ok,true,JSON.stringify(response.error));
  return response.data;
}

async function finished(job){
  const deadline=Date.now()+20000;
  while(['queued','running'].includes(job.status)&&Date.now()<deadline){
    await delay(200);
    job=await tool('workbench_jobs_status',{jobId:job.jobId});
  }
  return job;
}

try{
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'p1-native-smoke',version:'1'}});
  processMcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const catalog=await rpc('tools/list');
  for(const shopId of ['intel','gigabyte','jonsbo']){
    const configs=await tool('workbench_configs_find',{shopId,query:'测'});
    assert.ok(configs.items.some(item=>item.shopId===shopId));
    const first=await tool('workbench_sources_find',{shopId,limit:1});
    assert.equal(first.items.length,1);
    const detail=await tool('workbench_sources_get',{shopId,sourceId:first.items[0].sourceId});
    assert.equal(detail.source.goodsId,first.items[0].goodsId);
    const second=await tool('workbench_sources_find',{shopId,offset:first.nextOffset,limit:1,revision:first.revision});
    assert.equal(second.revision,first.revision);
    assert.notEqual(second.items[0].sourceId,first.items[0].sourceId);
    assert.ok(Array.isArray((await tool('workbench_activity_list',{shopId,pageSize:1})).rows));
  }
  const shopId='intel';
  const filtered={shopId,kind:'settings',actor:'fixture_existing01',pageSize:1};
  if(activityVersion==='033')await tool('workbench_activity_list',filtered,'UNSUPPORTED_FILTER');
  else assert.ok(Array.isArray((await tool('workbench_activity_list',filtered)).rows));
  const operationId=randomUUID();
  const start=await tool('workbench_inventory_check',{shopId,operationId,productId:'fixture-link',limit:1,waitMs:4000});
  const result=await finished(start);
  assert.equal(result.status,'succeeded',JSON.stringify(result.error));
  const summary=await tool('workbench_jobs_status',{operationId});
  assert.equal(summary.jobId,start.jobId);
  assert.equal(summary.result.items,undefined);
  const firstPage=await tool('workbench_inventory_check',{jobId:start.jobId,offset:0,limit:1});
  assert.equal(firstPage.result.items[0].goodsId,'997772');
  assert.equal(firstPage.result.items[0].status,'out');
  const snapshot=await tool('workbench_inventory_check',{jobId:start.jobId,offset:1,limit:1});
  assert.equal(snapshot.result.checkedAt,summary.result.checkedAt);
  assert.equal(snapshot.result.total,summary.result.total);
  assert.ok(Array.isArray(snapshot.result.items));
  await set({readInventoryActivity:false});
  const view=await tool('workbench_status');
  assert.ok(!view.capabilities.includes('inventory.check')&&!view.shopCapabilities.intel.includes('activity.list'));
  const redacted=(await tool('workbench_sources_find',{shopId,limit:1})).items[0];
  assert.equal(redacted.stockRedacted,true);
  assert.equal(redacted.stockAvailable,null);
  assert.equal(redacted.stockIncomingAvailable,null);
  assert.equal(redacted.stockStatus,undefined);
  await tool('workbench_inventory_check',{jobId:start.jobId},'PERMISSION_DENIED');
  await tool('workbench_activity_list',{shopId},'PERMISSION_DENIED');
  // 用真实 Tauri 设置开启导出，只核对能力交集，整个巡检不提交业务修改。
  await set({allowExport:true});
  assert.ok((await tool('workbench_status')).capabilities.includes('export.start'));
  assert.deepEqual(await rpc('tools/list'),catalog);
  await set({writeConfigs:true});
  const configId='fixture-overlap';
  const detail=await tool('workbench_configs_get',{shopId,configId});
  const prepared=await finished(await tool('workbench_changes_preview',{operationId:randomUUID(),waitMs:1000,
    request:{shopId,targets:[{configId,partIndex:0}],action:{type:'displayName',value:'撤权探针'}}}));
  assert.equal(prepared.status,'succeeded',JSON.stringify(prepared.error));
  const frame=page.frames().find(f=>f.url().includes('/workbench/'));
  assert.ok(frame);
  // 仅在合成 WebView 暂停已领取的任务。放行后执行完整的原生提交前检查。
  await frame.evaluate(()=>{
    const execute=window.workbenchAgentExecute;
    window.workbenchAgentExecute=async job=>{
      if(job.method==='changes.apply'){
        window.workbenchAgentExecute=execute;
        await new Promise(resume=>window.releaseP1Claim=resume);
      }
      return execute(job);
    };
  });
  const before=(await requests()).length;
  const apply=await tool('workbench_changes_apply',{operationId:randomUUID(),planId:prepared.result.planId});
  assert.equal(apply.status,'queued');
  await frame.waitForFunction(()=>typeof window.releaseP1Claim==='function',undefined,{timeout:12000});
  await set({writeConfigs:false});
  await frame.evaluate(()=>window.releaseP1Claim());
  const rejected=await finished(apply);
  assert.equal(rejected.status,'failed',JSON.stringify(rejected));
  assert.equal(rejected.error.code,'PERMISSION_REVOKED');
  assert.equal((await tool('workbench_configs_get',{shopId,configId})).config.nasVersion,detail.config.nasVersion);
  const after=(await requests()).slice(before);
  assert.ok(after.some(item=>item.path==='/api/v1/me'),'服务端应记录到权限复核请求');
  assert.equal(after.filter(item=>item.method==='POST'&&item.path==='/api/v1/operations/workspace/configurations').length,0);
  console.log('三店 NAS '+activityVersion+'：三店目录、实际 BOM、库存同快照分页、权限撤销和脱敏通过；已领取保存被拒，服务端新增配置 POST 为 0');
  await checkNasWrites({folder,tool,finished,set,cli,requests});
} finally {
  try{await set(initial.permissions);}
  finally {
    const stopped=once(processMcp,'exit');
    processMcp.stdin.end();
    await stopped;
    await browser.close();
  }
}
