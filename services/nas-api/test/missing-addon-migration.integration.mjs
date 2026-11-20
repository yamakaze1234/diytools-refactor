// 缺少021时给出明确兼容性错误；安装到合成库后原编号可成功提交且只生效一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../../../apps/desktop/public/workbench/nas-api-client.js';
const fixture=process.argv[2];if(!fixture)throw Error('请指定合成 fixture 目录');
test('完整加购缺021时不写入并返回安装提示，安装后原编号提交和重放均正确',async()=>{
 const api=await startSourceAcceptance({fixture,root:join(fixture,'missing-addon-migration-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
 const client=createNasApiClient({shopId:'intel',nativeRequest:(path,options)=>fetch(api.url+path,{...options,headers:{...options.headers,'x-workbench-deployment':fixtureDeployment}})});client.bindIdentity(fixtureWorkspace,fixtureActor);
 try{
  const before=await client.catalog('shared-sources','100001'),body={operation_id:randomUUID(),expected_version:before.version,document:{id:'100001',addon_sync:true,edits:{shared:{values:{addon:{addonText:'完整加购',addonGoodsId:'100001',addonQty:2,addonPriceCents:19900}},restore:[]},...Object.fromEntries(['intel','gigabyte','jonsbo'].map(shop=>[shop,{values:{},restore:['addon']}]))}}};
  await assert.rejects(client.saveCatalog('shared-sources','100001','replace',body),{code:'NAS_GLOBAL_UPGRADE_NOT_INSTALLED'});
  assert.deepEqual(await client.catalog('shared-sources','100001'),before);
  await api.db.exec(await readFile(new URL('../sql/021-workbench-alias-addons.sql',import.meta.url),'utf8'));
  const receipt=await client.saveCatalog('shared-sources','100001','replace',body);assert.equal(receipt.version,(BigInt(before.version)+1n).toString());
  assert.deepEqual(Object.keys(receipt.document.source_versions.intel).sort(),before.document.stores.intel.map(row=>row.sourceId).sort());
  assert.deepEqual(await client.saveCatalog('shared-sources','100001','replace',body),receipt);
 }finally{await api.close();}
});
