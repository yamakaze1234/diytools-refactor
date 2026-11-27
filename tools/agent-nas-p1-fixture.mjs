/** nas-acceptance 专用回环服务。保留现有三店合成种子，增加库存差异和 HTTP 计数。 */
import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import {subscribe} from 'node:diagnostics_channel';
import {appendFileSync,existsSync,readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Fault} from '../services/nas-api/src/config.mjs';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace} from '../services/nas-api/tools/shared-sources-acceptance.mjs';

const [fixture,data]=process.argv.slice(2).map(path=>resolve(path));
const secret=process.env.DIYTOOLS_ACCEPTANCE_TOKEN;
assert.match(secret??'',/^[0-9a-f-]{36}$/);
delete process.env.DIYTOOLS_ACCEPTANCE_TOKEN;
assert.ok(!existsSync(join(fixture,'real-samples.json')),'本脚手架使用合成样本');
await mkdir(data,{recursive:true});
const log=join(data,'p1-http.jsonl');
await writeFile(log,'');
subscribe('http.server.request.start',({request})=>{
  // 仅记录方法和路径，查看实际收包次数，避免记录账号票据及请求正文。
  appendFileSync(log,JSON.stringify({method:request.method,path:request.url.split('?')[0]})+'\n');
});
const expected=Buffer.from('Bearer '+secret);
const server=await startSourceAcceptance({fixture,folder:join(data,'pg'),root:join(data,'uploads'),
  tls:{key:await readFile(join(fixture,'test-key.pem')),cert:await readFile(join(fixture,'test-cert.pem')),network:'127.0.0.1',prefix:32},
  authenticate:async header=>{
    const actual=Buffer.from(header??'');
    if(expected.length!==actual.length||!timingSafeEqual(actual,expected))throw new Fault('UNAUTHENTICATED',401);
    return {uid:fixtureActor,workspaceId:fixtureWorkspace};
  },
});
// PGlite 只嵌入此进程。展示显卡可销 50，另一个实际 BOM 显卡可销为零。
await server.db.exec(`
  INSERT INTO intel_live.costs(goodsid,owner_shop,shared,erp,tax,attrs) VALUES
    ('997771','intel',false,200,200,'{"name":"合成展示显卡","stockAvailable":50}'),
    ('997772','intel',false,200,200,'{"name":"合成实际显卡","stockAvailable":0}')
    ON CONFLICT (goodsid) DO NOTHING;
  INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs) VALUES
    ('fixture-overlap','display',1,'fixture-line','显卡','997771','合成展示显卡',1,null,'{}'),
    ('fixture-overlap','actual',1,'fixture-line','显卡','997772','合成实际显卡',1,null,'{}')
    ON CONFLICT (configuration_id,part_kind,position) DO UPDATE SET
      slot=EXCLUDED.slot, goodsid=EXCLUDED.goodsid, name=EXCLUDED.name, source_id=null;
  INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
    SELECT 'fixture-overlap',kind,2,'fixture-follow','显卡',s.goodsid,s.name,1,s.source_id,'{}'::jsonb
    FROM intel_live.sources s CROSS JOIN (VALUES ('display'),('actual')) AS kinds(kind)
    WHERE s.source_id='fixture-cost-history'
    ON CONFLICT (configuration_id,part_kind,position) DO NOTHING;
`);
// 故障只挂在本进程的合成 store。来源已经正式保存时，下一次配置提交收到一次版本冲突。
const conflictMarker=join(data,'source-follow-conflict.txt');
const store=server.stores.get('intel'),saveBatch=store.workspaceBatch.bind(store);
let lastConflict=null;
store.workspaceBatch=async (...args)=>{
  const token=existsSync(conflictMarker)?readFileSync(conflictMarker,'utf8'):null;
  if(token&&token!==lastConflict){
    lastConflict=token;
    throw new Fault('VERSION_CONFLICT',409);
  }
  return saveBatch(...args);
};
const version=process.env.DIYTOOLS_P1_ACTIVITY_VERSION??'033';
assert.ok(['033','034'].includes(version));
const migrations=['020-workbench-global-tax','021-workbench-alias-addons','027-quotation-identity-invalidation','028-cross-shop-cost-sync','029-manual-tax-protection','030-incoming-stock','031-erp-category','033-source-default-tax-and-erp-name'];
if(version==='034')migrations.push('034-activity-filter-and-cleanup');
for(const name of migrations)await server.db.exec(await readFile(new URL('../services/nas-api/sql/'+name+'.sql',import.meta.url),'utf8'));
await writeFile(join(data,'p1-version.txt'),version);
const stop=()=>server.close().finally(()=>process.exit());
process.once('SIGTERM',stop);
process.stdin.on('end',stop);
process.stdin.resume();
process.stdout.write(server.url+'\n');
