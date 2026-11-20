/** 总表的三店操作：完整读影响范围，正文先持久化，未知结果只查原回执。 */
import {nasPlanStorage,buildNasOperationPlan} from './nas-operation-plan.js';
import {nasDependencies} from './nas-draft-controller.js';
import {receiptNotFound,originalVersionRejected,migrationNotInstalled} from './nas-api-client.js';
import {upgradeAddonDefinition,upgradeAddonDescription,upgradeAddonSummary,structuredUpgradeSourceDocument,applyStructuredUpgrade} from './upgrade-addon-sync.js';
const shops=['intel','gigabyte','jonsbo'];
const names={intel:'英特尔',gigabyte:'技嘉',jonsbo:'乔思伯'};
const clone=value=>structuredClone(value);
const ordinary=c=>!c.deletedAt&&c.productCategory!=='主机模板'&&!c.emptyLinkDraft;
const fmt=value=>value==null?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const version=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// 目录和工作区的旧接口各有一个明确的回执缺失码；只有显式重试才据此重放原正文。
const missingReceipt=error=>receiptNotFound(error)||error?.status===404&&error.code==='RECEIPT_NOT_FOUND';
const effectiveAddon=(common,alias)=>clone(Object.hasOwn(alias.fields??{},'addon')?alias.fields.addon:common.addon??{});

/** 每个别名保留完整原规则，仅替换顶层文案；同店多条历史来源不能共用第一条的商品资料。 */
export function globalUpgradeSourceDocument(source,text){
 const common=source.document.common,stores=source.document.stores;
 return {id:source.document.id,edits:{shared:{values:{addon:{...(common.addon??{}),addonText:text}},restore:[]}},
  alias_edits:Object.fromEntries(shops.map(shop=>[shop,Object.fromEntries((stores[shop]??[]).map(alias=>
   [alias.sourceId,{addon:{...effectiveAddon(common,alias),addonText:text}}]))]))};
}

/** 统一现有展示文案并显式跟随顶层文本，不改变配置加购的商品快照或选配规则。 */
export function applyGlobalUpgradeText(document,goodsId,text,aliases){
 const doc=clone(document);
 for(const part of doc.parts)if(part.goodsId===goodsId){
  if(!String(part.upgrade??'').trim())delete part.overviewAddonHidden;
  part.upgrade=text;
  if(!part.sourceFollow||part.sourceFollow.sourceId!==part.sourceId)part.sourceFollow={sourceId:part.sourceId};
  part.sourceFollow.upgrade=aliases.some(alias=>alias.sourceId===part.sourceId)?
   {mode:'follow',value:text,sourceValue:text,textOnly:true}:{mode:'manual',value:text};
 }
 return doc;
}

/** 回执决定后续可接续的版本，禁止仅凭 operation_id 或任意字符串版本宣布已保存。 */
export function verifyOverviewReceipt(op,receipt){
 const fail=()=>{throw Error('保存回执未核实，请查询原操作');};
 if(!plain(receipt)||receipt.operation_id!==op.body.operation_id||receipt.shop_id!==op.shop)fail();
 if(op.kind==='source'){
  if(receipt.kind!=='shared-sources'||receipt.resource_id!==op.id||receipt.archived!==false||
   !version(receipt.version)||BigInt(receipt.version)!==BigInt(op.body.expected_version)+1n||receipt.document?.id!==op.id)fail();
  const versions=receipt.document.source_versions;
  if(!plain(versions)||Object.keys(versions).length!==3)fail();
  for(const shop of shops){
   if(!plain(versions[shop])||JSON.stringify(Object.keys(versions[shop]).sort())!==JSON.stringify([...op.sourceIdsByShop[shop]].sort())||
    Object.values(versions[shop]).some(value=>!version(value)))fail();
  }
 }else{
  if(receipt.kind!=='configurations'||!Array.isArray(receipt.changes)||receipt.changes.length!==op.body.changes.length)fail();
  for(const [index,row] of receipt.changes.entries()){
   const expected=op.body.changes[index];
   if(!plain(row)||row.configuration_id!==expected.id||row.archived!==false||!version(row.version)||
    BigInt(row.version)!==BigInt(expected.expected_version)+1n)fail();
  }
 }
 return receipt;
}

/** 正文只在 ready 阶段接续本计划确认的源版本；其他人的后续版本必须重新预览。 */
export async function prepareOverviewConfigOperation(op,sourceOp,client){
 const confirmed=verifyOverviewReceipt(sourceOp,sourceOp.receipt).document.source_versions[op.shop];
 const reads=new Map();
 for(const change of op.body.changes)for(const id of op.sourceIds)if(Object.hasOwn(change.dependencies.sources,id)){
  if(!version(confirmed[id]))throw Error('原计划没有这条输出源的确认版本，请重新预览');
  if(!reads.has(id))reads.set(id,client.resource('sources',id));
  const current=await reads.get(id);
  if(current.version!==confirmed[id])throw Error('输出源在本计划之后又被修改，请结束计划后重新预览');
  change.dependencies.sources[id]=confirmed[id];
 }
}

/** 本地进度必须属于当前部署和成员，完成状态也要能由完整原回执证明。 */
export function validateOverviewJob(job,scope){
 if(!plain(job)||![1,2].includes(job.format)||job.scope!==scope||!uuid(job.id)||!Array.isArray(job.operations)||!job.operations.length)
  throw Error('原加购计划格式无法核验，请保留记录并重新核对');
 const seen=new Set();
 for(const [index,op] of job.operations.entries()){
  if(!plain(op)||!shops.includes(op.shop)||!['ready','unknown','rejected','done'].includes(op.status)||!plain(op.body)||
   !uuid(op.body.operation_id)||seen.has(op.body.operation_id))throw Error('原加购计划内容无法核验');
  seen.add(op.body.operation_id);
  if(index===0){
   if(op.kind!=='source'||!version(op.body.expected_version)||op.body.document?.id!==op.id||!plain(op.sourceIdsByShop)||
    !shops.every(shop=>Array.isArray(op.sourceIdsByShop[shop])&&op.sourceIdsByShop[shop].every(id=>typeof id==='string'&&id)))throw Error('原输出源计划无法核验');
   if(job.format===2&&op.body.document.addon_sync!==true)throw Error('原完整加购计划无法核验');
  }else if(op.kind!=='configs'||!Array.isArray(op.sourceIds)||!Array.isArray(op.body.changes)||!op.body.changes.length||op.body.changes.some(c=>
   c.action!=='replace'||!version(c.expected_version)||c.document?.id!==c.id||c.document?.shopId!==op.shop||
   !plain(c.dependencies?.sources)||!plain(c.dependencies?.costs)))throw Error('原配置计划无法核验');
  if(op.status==='done')verifyOverviewReceipt(op,op.receipt);
 }
 return job;
}
export function createNasOverviewActions(api){
 const storage=api.storage??nasPlanStorage(),key=()=> 'overview-upgrade:'+api.workspace.sharedPreviewScope();
 let busy=false,preparing=false;
 async function readShop(shop,goodsId){
  const access=await api.workspace.agentAccess(shop);access.assertWritable();
  const [head,catalog,ids]=await Promise.all([access.client.workspaceIndex(),access.client.workspaceCatalog(),access.client.sourceUsage([],goodsId?[goodsId]:[])]);
  const documents=[];
  for(let i=0;i<ids.length;i+=6)documents.push(...await Promise.all(ids.slice(i,i+6).map(id=>access.client.detail(id))));
  if((await access.client.workspaceIndex()).revision!==head.revision)throw Error('读取期间配置已变化，请重新预览');
  return {shop,access,head,catalog,documents:documents.filter(row=>ordinary(row.document))};
 }
 const counts=rows=>`${new Set(rows.map(c=>c.productId)).size} 个链接 · ${rows.length} 套配置`;
 async function tax(goodsId,value,name,restore){
  const snapshot=await Promise.all(shops.map(shop=>readShop(shop,goodsId)));
  const records=snapshot.map(s=>({...s,cost:s.catalog.costSource.find(r=>r.goodsId===goodsId)}));
  if(restore&&records.every(s=>!s.cost?.globalTax))throw Error('没有可恢复的全局改价记录');
  if(restore&&records.some(s=>!s.cost?.globalTax||s.cost.globalTax.value!==s.cost.tax))throw Error('部分店铺价格已由其他入口更新，原全局恢复记录已失效');
  if(!restore&&(!Number.isFinite(value)||value<0))throw Error('核算价须为有效的非负金额');
  const versions=Object.fromEntries(records.map(s=>[s.shop,s.catalog.costVersions[goodsId]??null]));
  const impact=records.map(s=>`<li><b>${names[s.shop]}</b>：${counts(s.documents.map(r=>r.document))}；¥${fmt(s.cost?.tax)} → ¥${fmt(restore?s.cost?.globalTax?.base??s.cost?.tax:value)}</li>`).join('');
  api.openDialog(restore?'全局恢复成本表价格':'应用到全局核算价',`<div class="gtax"><p><strong>${api.esc(name)}</strong><br>GoodID ${api.esc(goodsId)}</p><p>三店共用核算价。不同的配置独立核算价保留，与目标价相同的独立价取消。</p><ul>${impact}</ul><div class="actions"><button id="gtax-cancel">取消</button><button id="gtax-apply" class="primary">${restore?'全局恢复':'应用到全局'}</button></div></div>`);
  document.querySelector('#gtax-cancel').onclick=api.closeDialog;
  document.querySelector('#gtax-apply').onclick=async event=>{
   const button=event.currentTarget;button.disabled=true;
   try{
    // 全局成本会使配置版本更新；先明确保存当前这套输入，再核对影响配置是否还有其它草稿。
    await api.saveCurrent();
    for(const s of records)await s.access.assertDrafts(s.documents.map(r=>r.document.id));
    const shop=api.workspace.shop();
    const result=await api.saveCosts([{id:goodsId,action:'global_tax',expected_version:versions[shop],expected_versions:versions,fields:restore?{restore:true}:{tax:value}}]);
    if(result){api.closeDialog();api.toast(restore?'已恢复三店核算价':'已应用到三店核算价');}
   }catch(error){api.toast(error.message);}finally{button.disabled=false;}
  };
 }
 async function pending(){const job=await storage.get(key());return job?validateOverviewJob(job,api.workspace.sharedPreviewScope()):null;}
 function showJob(job){
  validateOverviewJob(job,api.workspace.sharedPreviewScope());
  const done=job.operations.filter(row=>row.status==='done').length,unknown=job.operations.some(row=>row.status==='unknown');
  api.openDialog('三店加购保存进度',`<p role="status">已确认 ${done} / ${job.operations.length} 批。${unknown?'存在结果未知的原操作，先查询回执。':'确认后继续未完成的原计划。'}</p>${job.format===1?'<p class="error">这是升级前的仅文案计划，保留原请求核实；完成或结束后请重新预览完整加购同步。</p>':''}<p class="hint">已完成的批次已生效；原计划保存在本机，同账号重新打开可继续。</p><div class="actions"><button id="overview-job-continue">${unknown?'查询原回执':'继续原计划'}</button>${unknown?'<button id="overview-job-retry">查证后重试原操作</button>':'<button id="overview-job-discard">结束并重新预览</button>'}</div>`);
  document.querySelector('#overview-job-continue').onclick=()=>run(job,false).catch(error=>api.toast(error.message));
  document.querySelector('#overview-job-retry')?.addEventListener('click',()=>run(job,true).catch(error=>api.toast(error.message)));
  document.querySelector('#overview-job-discard')?.addEventListener('click',async()=>{
   if(busy)return;const latest=await pending();
   if(!latest||latest.id!==job.id)return;
   if(latest.operations.some(op=>op.status==='unknown'))return api.toast('请先核对原未知操作的结果');
   await storage.put(key(),null);api.closeDialog();
  });
 }
 async function run(job,retry){
  if(busy)return;busy=true;
  const execute=async()=>{const unlock=api.lock();try{
   // 只运行磁盘上最后的检查点，不能由旧弹窗里的对象覆盖已经确认的新进度。
   const latest=await pending();if(!latest||latest.id!==job.id)throw Error('原计划已结束或发生变化，请重新打开');job=latest;
   const recovery=job.operations.some(op=>op.status==='unknown');
   for(const op of job.operations){
    if(op.status==='done')continue;
    const access=await api.workspace.agentAccess(op.shop);access.assertWritable();const client=access.client;
    let receipt;
    if(op.status==='unknown'){
     try{receipt=await (op.kind==='source'?client.catalogReceipt(op.body.operation_id):client.workspaceReceipt(op.body.operation_id));}
     catch(error){if(!retry||!missingReceipt(error))throw error;}
    }
    if(!receipt){
     if(op.status==='rejected')throw Error('原计划被拒绝，请结束计划后重新预览');
     if(op.kind==='configs'){
      await access.assertDrafts(op.body.changes.map(c=>c.id));
      // 仅更新本计划已改过的输出源依赖，成本等其他依赖保留原版本。
      if(op.status==='ready')await prepareOverviewConfigOperation(op,job.operations[0],client);
     }
     const replaying=op.status==='unknown';
     op.status='unknown';await storage.put(key(),job);
     try{receipt=op.kind==='source'?await client.saveCatalog('shared-sources',op.id,'replace',op.body):await client.workspaceWrite('configurations',op.body);}
     catch(error){
      // 重放遭拒不能证明原在途请求失败；沿用普通队列的原版本冲突判定，保留原号查询路径。
      if((error.status>=400&&error.status<500||migrationNotInstalled(error))&&(!replaying||originalVersionRejected(error))){op.status='rejected';op.error=error.code;await storage.put(key(),job);}
      throw error;
     }
    }
    verifyOverviewReceipt(op,receipt);
    op.status='done';op.receipt=receipt;await storage.put(key(),job);
    // 查询或重试只处理原未知批次；后续未发送批次留待明确点击“继续原计划”。
    if(recovery)break;
   }
   if(job.operations.every(op=>op.status==='done')){
    await api.refresh();await storage.put(key(),null);api.closeDialog();api.toast('三店加购及输出源已保存');
   }
  }finally{unlock();const left=await pending();if(left)showJob(left);}};
  try{
   // 多个窗口按同一个持久计划排队，避免迟到的检查点覆盖另一个窗口的新进度。
   const mutex=api.jobLock??globalThis.navigator?.locks;
   return await (mutex?mutex.request('diy-nas-overview:'+key(),execute):execute());
  }finally{busy=false;}
 }
 async function upgrade(id,slot,scope){
  const prior=await pending();if(prior){showJob(prior);return;}
  const src=api.currentDocument(id),part=src?.parts.find(p=>p.slot===slot);
  if(!part)throw Error('请先选择展示配件');
  if(scope!=='all'){
   const access=await api.workspace.agentAccess(src.shopId);access.assertWritable();
   let sourceId=part.sourceId;
   if(!sourceId){const catalog=await access.client.workspaceCatalog(),matches=catalog.sourceCatalog.filter(row=>!row.deletedAt&&(part.goodsId?row.goodsId===part.goodsId:row.name===part.name));
    if(matches.length!==1)throw Error('无法唯一匹配加购输出源，请先选择来源配件');sourceId=matches[0].sourceId;}
   const origin=await access.client.resource('sources',sourceId);
   await api.linkUpgrade(src,part,upgradeAddonDefinition(origin.document),{id:sourceId,goodsId:origin.document.goodsId,version:origin.version,client:access.client});return;
  }
  if(!part.goodsId)throw Error('全局加购需要准确 GoodID，请先绑定配件');
  const snapshots=await Promise.all(shops.map(shop=>readShop(shop,part.goodsId)));
  const access=snapshots.find(s=>s.shop===src.shopId).access;
  const source=await access.client.catalog('shared-sources',part.goodsId);
  const common=source.document.common,stores=source.document.stores;
  const origin=stores[src.shopId]?.find(alias=>alias.sourceId===part.sourceId);
  if(!origin)throw Error('当前配件未关联三店共用输出源，请先选择来源配件');
  const definition=upgradeAddonDefinition({sourceId:origin.sourceId,...effectiveAddon(common,origin)}),text=upgradeAddonDescription(definition);
  const missing=[],operations=[],documents=[];
  for(const s of snapshots){
   const aliases=stores[s.shop]||[];if(!aliases.length)missing.push(names[s.shop]);
   for(const row of s.documents){
    const doc=applyStructuredUpgrade(row.document,part,definition,{scope:'all',sources:s.catalog.sourceCatalog,follow:true});
    if(JSON.stringify(doc)!==JSON.stringify(row.document))documents.push({shop:s.shop,version:row.version,dependencies:row.dependencies,document:doc});
   }
  }
  // 完整加购定义写入共用源并移除该字段的单店覆盖，其它配件资料原样保留。
  operations.push({kind:'source',shop:src.shopId,id:part.goodsId,status:'ready',
   sourceIdsByShop:Object.fromEntries(shops.map(shop=>[shop,(stores[shop]??[]).map(alias=>alias.sourceId)])),
   body:{operation_id:crypto.randomUUID(),expected_version:source.version,document:structuredUpgradeSourceDocument(source,definition)}});
  for(const s of snapshots){
   const rows=documents.filter(r=>r.shop===s.shop);await s.access.assertDrafts(rows.map(r=>r.document.id).filter(value=>value!==id||s.shop!==src.shopId));
   // 当前输入通过原工作台保存，不把显示层兼容值作为跨店写入正文。
   const changes=await Promise.all(rows.map(async r=>({id:r.document.id,action:'replace',expected_version:r.version,document:r.document,
    dependencies:await nasDependencies(s.access.client,r.document,r.dependencies)})));
   if(changes.length)for(const batch of buildNasOperationPlan('configurations',changes).batches)operations.push({kind:'configs',shop:s.shop,status:'ready',sourceIds:(stores[s.shop]||[]).map(a=>a.sourceId),body:batch.body});
  }
  api.openDialog('加购应用到全局（三店）',`<div class="gtax"><p><strong>${api.esc(part.displayName||part.name)}</strong> · GoodID ${api.esc(part.goodsId)}</p><p class="addon-sync-summary">${api.esc(upgradeAddonSummary(definition))}</p><ul>${snapshots.map(s=>`<li>${names[s.shop]}：${counts(documents.filter(r=>r.shop===s.shop).map(r=>r.document))}</li>`).join('')}</ul><p>原文示例：${documents.slice(0,6).map(r=>api.esc(snapshots.find(s=>s.shop===r.shop).documents.find(s=>s.document.id===r.document.id).document.parts.find(p=>p.goodsId===part.goodsId)?.upgrade||'（空）')).join('；')}</p>${missing.length?`<p class="error">${missing.join('、')}没有这个配件的输出源，相关配置保留完整加购快照；关联来源后才可自动跟随。</p>`:''}<p class="hint">将统一三店该配件的加购商品、数量、替换数量、价格和选配项，并替换原有加购方案。已有配置与新配置跟随输出源；先保存来源，再逐店保存配置，每批独立生效，进度可恢复。</p><div class="actions"><button id="gup-cancel">取消</button><button id="gup-apply" class="primary">应用到全局（三店）</button></div></div>`);
  document.querySelector('#gup-cancel').onclick=api.closeDialog;
  document.querySelector('#gup-apply').onclick=async event=>{
   if(busy||preparing)return;preparing=true;const button=event?.currentTarget;if(button)button.disabled=true;
   try{
    if(await pending())throw Error('已有三店加购计划，请先处理原计划');
    await api.saveCurrent();
    // 当前套的保存会增加版本，计划接续这份已确认回执，其他套仍保留预览时版本。
    const current=await access.client.detail(id);
    for(const op of operations.filter(o=>o.kind==='configs'&&o.shop===src.shopId))for(const c of op.body.changes)if(c.id===id){
     c.expected_version=current.version;c.document=applyStructuredUpgrade(current.document,part,definition,{scope:'all',sources:snapshots.find(s=>s.shop===src.shopId).catalog.sourceCatalog,follow:true});
     c.dependencies=await nasDependencies(access.client,c.document,current.dependencies);
    }
    const job={format:2,id:crypto.randomUUID(),scope:api.workspace.sharedPreviewScope(),operations};
    validateOverviewJob(job,job.scope);
    const persist=async()=>{if(await pending())throw Error('已有三店加购计划，请先处理原计划');await storage.put(key(),job);};
    const mutex=api.jobLock??globalThis.navigator?.locks;
    await (mutex?mutex.request('diy-nas-overview:'+key(),persist):persist());await run(job,false);
   }catch(error){api.toast(error.message);}finally{preparing=false;if(button)button.disabled=false;}
  };
 }
 return {tax,upgrade,pending,showJob,async resume(retry=false){const job=await pending();if(job)return run(job,retry);}};
}
