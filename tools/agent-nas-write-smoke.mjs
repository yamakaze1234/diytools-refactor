/** 合成三店 NAS 的草稿新建、来源正式保存和部分成功续做验收。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function checkNasWrites({folder,tool,finished,set,cli,requests}){
  const shopId='intel';
  const getConfig=configId=>tool('workbench_configs_get',{shopId,configId});
  const checked=async job=>{
    const final=await finished(job);
    assert.equal(final.status,'succeeded',JSON.stringify(final));
    return final.result;
  };
  const draftLabel='合成新建草稿 '+randomUUID().slice(0,8);
  const draft={shopId,mode:'new_draft_link',productName:draftLabel,configs:[{
    name:'验收配置',price:1699,parts:[{sourceId:'fixture-local',slot:'CPU',qty:1}],
    actualParts:[{sourceId:'fixture-cost-history',slot:'显卡',qty:2}],
  }]};
  await set({writeDraftConfigs:false,writeSources:false});
  await tool('workbench_draft_preview',{request:draft,operationId:randomUUID()},'PERMISSION_DENIED');
  await set({writeDraftConfigs:true});
  const input=join(folder,'draft-request.json');
  await writeFile(input,JSON.stringify(draft));
  const preview=await checked(cli(['draft','preview','--input',input,'--operation-id',randomUUID(),'--wait-ms','1400']));
  const draftApply={operationId:randomUUID(),planId:preview.planId,waitMs:1500};
  const draftSaved=await checked(await tool('workbench_draft_apply',draftApply));
  assert.equal(draftSaved.nasSave,'saved');
  assert.equal(draftSaved.receipt.operation_id,draftApply.operationId);
  const configId=draftSaved.configIds[0];
  const {config}=await getConfig(configId);
  assert.equal(config.productDraft,true);
  assert.equal(config.productId,draftSaved.productId);
  assert.equal(config.product,draftLabel);
  assert.ok(!config.spu&&!config.skuId);
  assert.equal(config.parts[0].sourceId,'fixture-local');
  assert.equal(config.actualParts[0].sourceId,'fixture-cost-history');
  assert.equal(config.actualParts[0].qty,2);
  const replayed=await checked(await tool('workbench_draft_apply',draftApply));
  assert.deepEqual(replayed.configIds,draftSaved.configIds);
  assert.equal((await getConfig(configId)).config.nasVersion,config.nasVersion);

  // 测试夹具为 fixture-overlap 同时添加了会随来源变化的展示/实际配件。
  const sourceId='fixture-cost-history';
  const rename='已通过单店保存 '+randomUUID().slice(0,8);
  const request={shopId,scope:'shop',action:'edit',sourceId,fields:{name:rename},followConfigs:true};
  await tool('workbench_sources_preview',{request,operationId:randomUUID()},'PERMISSION_DENIED');
  await set({readInventoryActivity:true,writeConfigs:true,writeSources:true,writeSourcesFollowConfigs:true});
  const plan=await checked(await tool('workbench_sources_preview',{request,operationId:randomUUID(),waitMs:2000}));
  const apply={planId:plan.planId,operationId:randomUUID()};
  const getSource=async()=>(await tool('workbench_sources_get',{shopId,sourceId})).source;
  const original=await getSource();
  assert.notEqual(original.name,rename);
  await writeFile(join(folder,'acceptance-data/source-follow-conflict.txt'),randomUUID());
  const partial=await finished(await tool('workbench_sources_apply',{...apply,waitMs:1500}));
  assert.equal(partial.status,'failed',JSON.stringify(partial));
  assert.equal(partial.result?.partialSuccess,true,JSON.stringify(partial));
  assert.equal(partial.result.confirmedSteps.length,1);
  assert.equal(partial.result.confirmedSteps[0].kind,'catalog');
  assert.equal(partial.result.remainingSteps[0].kind,'configurations');
  const written=await getSource();
  assert.equal(written.name,rename);
  assert.notEqual(written.version,original.version);
  const since=(await requests()).length;
  // 接受同一冻结计划，已确认来源写入跳过，原配置步骤沿用自己的业务编号。
  const recovered=await checked(cli(['sources','apply','--plan-id',apply.planId,'--operation-id',apply.operationId,'--wait-ms','1800']));
  assert.equal(recovered.nasSave,'saved');
  assert.equal((await getSource()).version,written.version);
  const after=(await requests()).slice(since);
  assert.equal(after.filter(row=>row.method!=='GET'&&row.path.includes('/operations/catalog/')).length,0);
  assert.ok(after.some(row=>row.method==='POST'&&row.path==='/api/v1/operations/workspace/configurations'));
  const followed=(await getConfig('fixture-overlap')).config.parts.find(p=>p.sourceId===sourceId);
  assert.equal(followed.displayName??followed.name,rename);
  console.log('新草稿落库回读、草稿回执重放、来源保存后配置冲突及原操作编号续做通过；来源版本仅推进一次');
}
