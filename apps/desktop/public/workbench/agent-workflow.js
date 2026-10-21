/** Agent 长任务运行在现有编辑器中，保存、渲染与同步各自返回真实状态。 */
import {buildAgentPlan,validateAgentPlan} from './agent-changes.js';
import {exportAgentSnapshot} from './agent-export.js';
import {normalizeProducts} from './core.js';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
function savedSnapshot(saved,ids,revision=saved.revision){
 const selected=new Set(ids),key=c=>JSON.stringify([c.shopId||'intel',c.productId||c.product||c.spu||'']);
 // 仅在副本计算旧链接身份，保存快照正文保持原样。
 const groups=new Map(normalizeProducts(structuredClone(saved.configs)).map(c=>[c.id,key(c)]));
 const links=new Set(saved.configs.filter(c=>selected.has(c.id)).map(c=>groups.get(c.id)));
 if(saved.configs.filter(c=>selected.has(c.id)).length!==selected.size)fail('SAVE_UNCONFIRMED','保存快照缺少目标配置');
 return {configs:structuredClone(saved.configs.filter(c=>selected.has(c.id)||links.has(groups.get(c.id)))),revision,configIds:[...selected]};
}
function appliedResult(plan,baseline,rawReceipt){
 const receipt=structuredClone(rawReceipt);
 if(!receipt||!Number.isSafeInteger(receipt.revision)||receipt.revision<plan.baseRevision||!Array.isArray(receipt.configs))fail('SAVE_UNCONFIRMED','保存回执未确认，请按原 operationId 查询任务');
 const saved=new Map(receipt.configs.map(c=>[c.id,c]));
 if(saved.size!==receipt.configs.length||plan.changes.some(change=>!saved.has(change.id)))fail('SAVE_UNCONFIRMED','保存回执缺少目标配置，请按原 operationId 查询任务');
 const configs=baseline.configs.map(c=>structuredClone(saved.get(c.id)||c));
 return {localSave:'saved',revision:receipt.revision,receipt,snapshot:{configs,revision:receipt.revision,configIds:baseline.configIds}};
}
export function createAgentWorkflow(api){
 let running=false;
 return async job=>{
  if(running)fail('UI_BUSY','已有 Agent 任务正在执行');
  // 仅宿主证明原操作草稿从失败起未被编辑时，才允许重放其冻结请求。
  const resume=api.resumePending?.(job);
  // 原生注入的官方保存回执只用于确认已落盘；不清理或重写后续人工草稿。
  if(job?.method==='changes.apply'&&job.params?.savedReceipt&&!resume){
   const receipt=structuredClone(job.params.savedReceipt),snapshot=job.params.savedSnapshot;
   if(!Number.isSafeInteger(receipt.revision)||receipt.revision<0||!Array.isArray(receipt.configs))fail('SAVE_UNCONFIRMED','原生保存回执格式无效');
   if(snapshot&&(!Array.isArray(snapshot.configs)||snapshot.revision!==receipt.revision))fail('SAVE_UNCONFIRMED','原生保存快照格式无效');
   return {localSave:'saved',revision:receipt.revision,receipt,...(snapshot?{snapshot:structuredClone(snapshot)}:{})};
  }
  if(api.blocked()&&!resume)fail('UI_BUSY','当前存在未保存输入、弹窗、同步或退出操作，请完成后重试');
  if(!job||typeof job!=='object'||typeof job.method!=='string')fail('INVALID_PARAMS','Agent 任务格式无效');
  if(!['sync.run','changes.preview','changes.apply','export.start'].includes(job.method))fail('METHOD_NOT_FOUND','不支持此 Agent 任务');
  if(!job.params||typeof job.params!=='object'||Array.isArray(job.params))fail('INVALID_PARAMS','任务参数必须为对象');
  if(job.method==='changes.apply'&&(typeof job.params.operationId!=='string'||!job.params.operationId.trim()))fail('INVALID_PARAMS','保存必须提供 operationId');
  running=true;
  let release=()=>{};
  try{
   release=api.lock(job.method!=='sync.run');
   if(resume){const {receipt,baseline}=await resume();return appliedResult(job.params.plan,baseline,receipt);}
   if(job.method==='sync.run'){
    const result=await api.sync();
    if(!result||result.error||result.running||result.conflicts||result.pending!==0)fail('SYNC_INCOMPLETE','同步尚未完成或仍有冲突，请在工作台处理');
    return {localSave:'unchanged',cloudSync:'completed',status:result};
   }
   // 固定快照导出不依赖当前编辑器内容；其他任务先载入完整工作区。
   if(job.method==='export.start'&&job.params.snapshot){
    return await exportSnapshot(job,job.params.snapshot);
   }
   await api.load();
   if(api.blocked())fail('UI_BUSY','准备过程中工作区发生变化，请重试');
   const state=api.state();
   if(job.method==='changes.preview'){
    const plan=buildAgentPlan(state,job.params.request);
    const saved=structuredClone(api.savedState());
    if(saved.revision!==plan.baseRevision)fail('REVISION_CONFLICT','保存快照版本已变化，请重新预览');
    const exportContext=savedSnapshot(saved,plan.baselines.map(c=>c.id));
    return {plan,summary:plan.summary,exportContext,localSave:'unchanged'};
   }
   if(job.method==='changes.apply'){
    const plan=job.params.plan;
    validateAgentPlan(state,plan);
    const savedBefore=structuredClone(api.savedState());
    if(savedBefore.revision!==plan.baseRevision)fail('REVISION_CONFLICT','保存快照版本已变化，请重新预览');
    if(!plan.changes.length)return {localSave:'unchanged',revision:savedBefore.revision,snapshot:savedSnapshot(savedBefore,plan.baselines.map(c=>c.id))};
    const baseline=savedSnapshot(savedBefore,plan.changes.map(c=>c.id));
    return appliedResult(plan,baseline,await api.apply(plan,job.params.operationId,baseline));
   }
   if(job.method==='export.start'){
    const saved=structuredClone(api.savedState());
    if(job.params.revision!==saved.revision)fail('REVISION_CONFLICT','导出版本已变化，请重新查询');
    return await exportSnapshot(job,{configs:saved.configs,revision:saved.revision});
   }
   fail('METHOD_NOT_FOUND','不支持此 Agent 任务');
  }finally{try{release();}finally{running=false;}}
 };
 async function exportSnapshot(job,snapshot){
  return exportAgentSnapshot({...snapshot,params:{...job.params,configIds:job.params.configIds??snapshot.configIds},
   progress:p=>api.native('progress',{id:job.id,...p}),
   writeFile:file=>api.native('export.write',{jobId:job.id,...file}),
   finish:result=>api.native('export.finish',{jobId:job.id,...result})});
 }
}
