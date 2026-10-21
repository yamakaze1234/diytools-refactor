/** 独立 CLI → Windows 管道 → 原生只读查询的合成数据验收，不打开真实工作台。 */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [hostPath,cliPath]=process.argv.slice(2).map(path=>resolve(path));
assert(hostPath&&cliPath,'用法：node tools/agent-entry-smoke.mjs HOST_EXE CLI_EXE');
assert.equal(process.platform,'win32','此验收需要 Windows 命名管道');
const directory=resolve(root,'sandbox',`agent-entry-smoke-${Date.now()}`);
mkdirSync(directory,{recursive:true});
const database=resolve(directory,'workbench.sqlite');
const db=new DatabaseSync(database);
db.exec('CREATE TABLE workbench_metadata(id INTEGER PRIMARY KEY,document TEXT NOT NULL); CREATE TABLE workbench_configs(id TEXT PRIMARY KEY,position INTEGER NOT NULL,document TEXT NOT NULL)');
db.prepare('INSERT INTO workbench_metadata VALUES(1,?)').run(JSON.stringify({
  revision:7,updatedAt:'2026-01-01T00:00:00Z',secretToken:'must-not-leak'
}));
const rows=[
  {id:'intel-actual',shopId:'intel',productId:'link-1',product:'测试链接',name:'测试配置',skuId:'',spu:'0001',parts:[{slot:'内存',goodsId:'other',name:'展示名称'}],actualParts:[{slot:'内存',goodsId:'401748',name:'实际内存',qty:2,tax:200}],token:'must-not-leak'},
  {id:'intel-empty',shopId:'intel',parts:[{goodsId:'401748'}],actualParts:[]},
  {id:'other-store',shopId:'jonsbo',parts:[{goodsId:'401748'}]},
  {id:'intel-legacy',shopId:'intel',parts:[{goodsId:'401748'}]},
];
rows.forEach((row,i)=>db.prepare('INSERT INTO workbench_configs VALUES(?,?,?)').run(row.id,i,JSON.stringify(row)));
db.close();
const hash=()=>createHash('sha256').update(readFileSync(database)).digest('hex');
const before=hash();
const host=spawn(hostPath,[directory],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
let diagnostics='';host.stderr.on('data',chunk=>{diagnostics+=chunk;});
const report={directory,checks:[]};
try{
  const ready=await new Promise((resolveReady,reject)=>{
    const timeout=setTimeout(()=>reject(Error(`测试宿主启动超时 ${diagnostics}`)),20000);
    host.once('error',error=>{clearTimeout(timeout);reject(error);});
    host.once('exit',code=>{clearTimeout(timeout);reject(Error(`测试宿主退出 ${code} ${diagnostics}`));});
    const lines=createInterface({input:host.stdout});
    lines.once('line',line=>{clearTimeout(timeout);lines.close();resolveReady(JSON.parse(line));});
  });
  assert.equal(ready.ready,true);
  const run=(args,expectedCode=0)=>{
    let stdout,code=0;
    try{stdout=execFileSync(cliPath,['--json','--instance',ready.instance,...args],{cwd:directory,encoding:'utf8',timeout:15000,windowsHide:true});}
    catch(error){stdout=error.stdout;code=error.status;}
    assert.equal(code,expectedCode,stdout);
    const value=JSON.parse(stdout);
    assert(!stdout.includes('must-not-leak'));
    assert.equal(value.ok,expectedCode===0);
    return value;
  };
  const status=run(['status']);
  assert.equal(status.data.savedRevision,7);
  assert.equal(status.data.readOnly,true);
  assert.equal(status.data.unsavedChanges,'unknown');
  report.checks.push('status_saved_snapshot');
  const shops=run(['shops','list']);
  assert(shops.data.shops.some(shop=>shop.id==='intel'));
  report.checks.push('shops_discovery');
  const page=run(['configs','find','--shop-id','intel','--goods-id','401748','--limit','1']);
  assert.equal(page.data.items.length,1);
  assert.equal(page.data.items[0].id,'intel-actual');
  assert.equal(page.data.hasMore,true);
  const next=run(['configs','find','--shop-id','intel','--goods-id','401748','--limit','1','--offset',String(page.data.nextOffset),'--revision',String(page.data.revision)]);
  assert.deepEqual(next.data.items.map(row=>row.id),['intel-legacy']);
  assert.equal(next.data.hasMore,false);
  report.checks.push('store_and_actual_bom_filter','revision_pagination');
  const detail=run(['configs','get','--config-id','intel-actual']);
  assert.equal(detail.data.config.skuId,'');
  assert.equal(detail.data.config.actualParts[0].qty,2);
  report.checks.push('detail_missing_sku_preserved');
  const stale=run(['configs','find','--offset','1','--revision','6'],1);
  assert.equal(stale.error.code,'REVISION_CONFLICT');
  report.checks.push('stale_revision_rejected');
  const unknown=run(['configs','get','--config-id','missing'],1);
  assert.equal(unknown.error.code,'NOT_FOUND');
  report.checks.push('missing_id_error');
  assert.equal(hash(),before,'查询不得改动业务库');
  report.databaseSha256=before;
  report.checks.push('database_hash_unchanged');
} finally {
  host.stdin.end();
  await new Promise(resolveExit=>{
    if(host.exitCode!==null)return resolveExit();
    const timer=setTimeout(()=>{host.kill();resolveExit();},10000);
    host.once('exit',()=>{clearTimeout(timer);resolveExit();});
  });
}
writeFileSync(resolve(directory,'verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
