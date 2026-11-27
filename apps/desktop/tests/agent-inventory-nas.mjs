/** 用合成三店数据库和真实业务 HTTP 接口核验巡检读取实际 BOM 及按链接收窄范围。 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createNasAgentWorkflow} from '../public/workbench/nas-agent-workflow.js';
import {createNasApiClient} from '../public/workbench/nas-api-client.js';
import {fixtureActor,fixtureWorkspace,fixtureDeployment,startSourceAcceptance} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成三店 SQL fixture 目录');
const api=await startSourceAcceptance({fixture,root:join(fixture,'inventory-check-uploads'),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
try{
 // 展示显卡库存充足，只有实际使用的另一张显卡缺货。SQL 仅在新建的内存库执行。
 await api.db.exec(`UPDATE intel_live.parts SET slot='显卡',name='展示显卡' WHERE part_kind='display';
  UPDATE intel_live.parts SET slot='显卡',name='实际显卡',goodsid='9900011',source_id='fixture-cost-history' WHERE part_kind='actual';
  UPDATE intel_live.costs SET attrs=attrs||'{"stockAvailable":0,"stockIncomingAvailable":9}' WHERE goodsid='9900011';`);
 const requests=[];
 const client=createNasApiClient({shopId:'intel',nativeRequest:(path,options)=>{
  requests.push({method:options.method,path});
  return fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}});
 }});
 const run=createNasAgentWorkflow({access:async shop=>{assert.equal(shop,'intel');return {client};},
  blocked:()=>true,lock:()=>{throw Error('只读任务不应锁定正在编辑的工作台');}});
 const check=params=>run({method:'inventory.check',params:{shopId:'intel',...params}});
 const full=await check({});
 assert.equal(full.total,1);
 assert.deepEqual(full.counts,{out:1,low:0,unknown:0});
 assert.deepEqual([full.items[0].goodsId,full.items[0].value,full.items[0].incoming],['9900011',0,9]);
 assert.equal(full.items[0].affectedConfigCount,1);
 assert.equal(full.items[0].affectedLinks[0].id,'fixture-link');
 const perLink=await check({productId:'fixture-link'});
 assert.deepEqual(perLink.items,full.items);
 requests.length=0;
 const empty=await check({productId:'other-link'});
 assert.equal(empty.configCount,0);
 assert.ok(requests.every(req=>!req.path.includes('/configurations/')));
 assert.ok(requests.every(req=>req.method==='GET'));
 const filtered=await check({status:'low'});
 assert.equal(filtered.total,0);assert.deepEqual(filtered.counts,full.counts);
 console.log(JSON.stringify({actualBom:true,fullShop:true,linkScoped:true,emptyScopeDetailReads:0}));
}finally{await api.close();}
