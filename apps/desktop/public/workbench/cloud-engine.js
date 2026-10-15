/** 云同步协议状态机：处理持久待提交队列、连续分页和三方合并；网络鉴权与 SQLite 原子提交由注入接口负责。 */
// Pure protocol state machine. Rust owns authenticated HTTP and atomic SQLite CAS.
import {equal,mergeRecord,recordKey,safeInteger,validateCloudRecord} from './cloud-protocol.js';
import {projectWorkspace,applyWorkspace,mergeWorkspaceEdit} from './cloud-projection.js';
import {stripLocalErp,keepCloudType} from './cloud-erp-policy.js';
import {initializeActualParts} from './actual-parts.js';

const copy=value=>structuredClone(value);
const envelope=(action,payload={})=>({protocolVersion:2,action,requestId:crypto.randomUUID(),payload});
const fail=(message,code)=>Object.assign(Error(message),code?{code}:{});
/** 逐层比较协议值，不构造整份规范字符串；缺字段、undefined 与 null 仍遵循原 canonical 语义。 */
export function equivalent(a,b,context='root'){
  if(Array.isArray(a)||Array.isArray(b)){
    if(!Array.isArray(a)||!Array.isArray(b))return false;
    // 原 canonical 的数组 join 对空洞/函数有特殊行为，罕见非 JSON 数组交回原实现处理。
    for(const values of [a,b])for(let i=0;i<values.length;i++)if(!(i in values)||['function','symbol'].includes(typeof values[i]))return equal(a,b);
    return a.length===b.length&&a.every((value,i)=>equivalent(value,b[i],'array'));
  }
  if(a&&typeof a==='object'||b&&typeof b==='object'){
    if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.propertyIsEnumerable.call(b,key)&&equivalent(a[key],b[key],'object'));
  }
  // undefined 的规范值是文字 undefined；NaN/Infinity 与 null 则一直由原 JSON 规则归一为 null。
  const token=value=>value===undefined?'undefined':JSON.stringify(value);
  return context==='object'?String(token(a))===String(token(b)):token(a)===token(b);
}
const DRAFT_CHANGED=Symbol('draftChanged');
const replaceRow=(doc,old,next)=>{doc.records[doc.records.indexOf(old)]=next;if(!equivalent(old.draft,next.draft))doc[DRAFT_CHANGED]=true;return next;};
const sameRows=(a,b)=>a.length===b.length&&a.every((row,i)=>row===b[i]);
const documentChanged=(doc,old)=>Object.keys({...old,...doc}).some(key=>key==='records'||key==='outbox'?!sameRows(doc[key],old[key]):doc[key]!==old[key]);
const index=rows=>new Map(rows.map(r=>[recordKey(r.type,r.id),r]));
const assetUrls=records=>{const urls=new Set();const walk=v=>{if(typeof v==='string'&&v.startsWith('/uploads/'))urls.add(v);else if(v&&typeof v==='object')for(const child of Object.values(v))walk(child);};for(const r of records)walk(r.data??r.draft??r.payload?.after);return [...urls].sort();};

function validateRemote(row){
  if(!row||!safeInteger(row.version,1))throw fail('云端记录版本无效');
  if(!keepCloudType(row.type))return row;
  const cleaned={...row,data:stripLocalErp(row.data)};validateCloudRecord(cleaned.type,cleaned.id,cleaned.data);return cleaned;
}
function validateRequest(req,doc){
  const p=req?.payload;
  if(req?.protocolVersion!==2||req.action!=='sync.push'||typeof req.requestId!=='string'||!p||typeof p.mutationId!=='string'||p.mutationId.length<16||p.mutationId.length>100||typeof p.deviceId!=='string'||!p.deviceId||!safeInteger(p.baseVersion))throw fail('持久云端提交格式无效');
  validateCloudRecord(p.entityType,p.entityId,p.after);
  if(!doc.records.some(r=>r.type===p.entityType&&r.id===p.entityId))throw fail('持久提交没有对应记录');
}
/** 在使用同步快照前检查成员归属、记录版本、重复实体和待提交队列。 */
function validateDocument(doc,member){
  if(!doc||doc.format!==1||typeof doc.workspaceId!=='string'||!doc.workspaceId||typeof doc.uid!=='string'||!doc.uid||typeof doc.deviceId!=='string'||!doc.deviceId||!safeInteger(doc.cursor)||!Array.isArray(doc.records)||!Array.isArray(doc.outbox)||!Array.isArray(doc.materializedProjection))throw fail('云端同步资料未初始化或格式无效');
  if(member&&(doc.workspaceId!==member.workspaceId||doc.uid!==member.uid))throw fail('当前成员与本机云端资料不一致','OWNER_MISMATCH');
  const seen=new Set();for(const r of doc.records){validateCloudRecord(r.type,r.id,r.draft);if(r.base!==null)validateCloudRecord(r.type,r.id,r.base);if(!safeInteger(r.version)||r.version===0&&r.base!==null||r.version>0&&r.base===null)throw fail('云端记录基线版本无效');const key=recordKey(r.type,r.id);if(seen.has(key))throw fail('云端同步资料含重复记录');seen.add(key);if(r.conflict){const remote=validateRemote(r.conflict.remote);if(remote.type!==r.type||remote.id!==r.id||!Array.isArray(r.conflict.fields))throw fail('云端冲突版本无效');}}
  const mutations=new Set(),entities=new Set();for(const req of doc.outbox){validateRequest(req,doc);const p=req.payload,key=recordKey(p.entityType,p.entityId);if(mutations.has(p.mutationId)||entities.has(key))throw fail('云端队列含重复提交');mutations.add(p.mutationId);entities.add(key);}
  const projected=new Set();for(const r of doc.materializedProjection){validateCloudRecord(r.type,r.id,r.data);const key=recordKey(r.type,r.id);if(projected.has(key))throw fail('云端物化基线含重复记录');projected.add(key);}
}
/** 把工作台相对物化基线的新编辑合入同步草稿，保留真实重叠修改为冲突。 */
function aligned(snapshot,at){
  const {state,document:doc}=snapshot,baseline=index(doc.materializedProjection),current=index(projectWorkspace(state)),records=index(doc.records),costIds=(state.costSource||[]).map(r=>r.goodsId);
  for(const key of new Set([...baseline.keys(),...current.keys()])){
    const before=baseline.get(key)?.data,fresh=current.get(key),old=records.get(key);
    if(equivalent(before,fresh?.data))continue;
    const type=fresh?.type??baseline.get(key).type,id=fresh?.id??baseline.get(key).id;
    const data=fresh?.data??{...copy(before),deletedAt:at};
    const merged=old?mergeWorkspaceEdit(type,before??null,data,old.draft,costIds):{value:data,fields:[]};
    if(merged.fields.length)throw fail('本机同步基线字段已变化，请比较后重试：'+merged.fields.join('、'),'LOCAL_BASE_CONFLICT');
    validateCloudRecord(type,id,merged.value);
    if(old)records.set(key,replaceRow(doc,old,{...old,draft:merged.value}));else{const row={type,id,base:null,version:0,draft:merged.value,conflict:null};doc.records.push(row);records.set(key,row);doc[DRAFT_CHANGED]=true;}
  }
}
/** 仅在完整工作区根记录已存在时回建工作台，避免首次下载中途清空配置。 */
function materialized(snapshot){
  const {state,document:doc}=snapshot;
  // A not-yet-complete first download must not turn an empty record set into state.
  if(doc.records.some(r=>r.type==='workspace_meta'&&r.id==='root'))snapshot.state=initializeActualParts(applyWorkspace(state,doc.records));
  doc.materializedProjection=projectWorkspace(snapshot.state);
}
/** 按云端版本接收记录；未确认的本地提交必须先核实，才允许推进同一实体。 */
function receive(doc,input){
  const remote=validateRemote(input);if(!keepCloudType(remote.type))return;
  const old=doc.records.find(r=>r.type===remote.type&&r.id===remote.id);
  if(!old){doc.records.push({type:remote.type,id:remote.id,base:copy(remote.data),draft:copy(remote.data),version:remote.version,conflict:null});doc[DRAFT_CHANGED]=true;return;}
  const row={...old};
  if(remote.version===row.version&&!equal(remote.data,row.base))throw fail('同一云端记录版本携带不同内容');
  if(remote.version<=row.version)return;
  if(doc.outbox.some(req=>req.payload.entityType===row.type&&req.payload.entityId===row.id))throw fail('先核实待确认提交，再接收该记录');
  const merged=mergeRecord(row.base,row.draft,remote.data);
  if(row.conflict||merged.fields.length)row.conflict={...(row.conflict||{}),code:'CONFLICT',fields:[...new Set([...(row.conflict?.fields||[]),...merged.fields])],remote:copy(remote),base:copy(row.base),local:copy(merged.value)};
  row.base=copy(remote.data);row.version=remote.version;row.draft=merged.value;
  replaceRow(doc,old,row);
}
/** 检查分页序号连续性与游标边界，任何缺页都不能被当作同步完成。 */
function validatePage(page,cursor,head){
  if(!page?.ok||!safeInteger(page.headSeq)||page.headSeq<cursor||head!==undefined&&page.headSeq!==head||!safeInteger(page.nextCursor)||!Array.isArray(page.changes)||typeof page.hasMore!=='boolean')throw fail(page?.message||page?.code||'同步分页格式无效');
  let last=cursor;for(const row of page.changes){if(row.seq!==last+1||row.seq>page.headSeq)throw fail('云端同步序号不连续');validateRemote(row);last=row.seq;}
  if(page.nextCursor!==last||page.hasMore&&!page.changes.length||page.hasMore!==(last<page.headSeq))throw fail('云端同步游标不完整');
}
/** 按 mutationId 核验批量回执，确认成功的提交才从持久队列移除。 */
function acknowledge(doc,requests,results){
  if(!Array.isArray(results)||results.length!==requests.length)throw fail('云端批次回执数量不一致');
  const failures=[];
  for(let i=0;i<requests.length;i++){
    try{
    const req=requests[i],p=req.payload,result=results[i];
    if(!result||result.mutationId!==undefined&&result.mutationId!==p.mutationId)throw fail('云端回执提交 ID 不一致');
    if(!result.ok&&result.code!=='CONFLICT')throw fail(result.message||result.code||'提交結果待确认',result.code);
    const remote=validateRemote(result.code==='CONFLICT'?result.remote:result.record);
    if(remote.type!==p.entityType||remote.id!==p.entityId||remote.version<p.baseVersion)throw fail('云端回执记录身份或版本不一致');
    const pending=doc.outbox.find(r=>r.payload.mutationId===p.mutationId);
    if(!pending)continue; // Another successful CAS may already have consumed this exact result.
    if(!equal(pending,req))throw fail('云端回执与持久提交不一致');
    const old=doc.records.find(r=>r.type===p.entityType&&r.id===p.entityId),row={...old};
    if(remote.version<row.version)throw fail('云端回执版本发生回退');
    if(remote.version===row.version&&!equal(remote.data,row.base))throw fail('云端回执同一版本内容发生变化');
    const merged=mergeRecord(result.code==='CONFLICT'?row.base:p.after,row.draft,remote.data);
    row.base=copy(remote.data);row.version=remote.version;row.draft=merged.value;
    row.conflict=merged.fields.length?{code:'CONFLICT',fields:merged.fields,base:result.code==='CONFLICT'?copy(result.base):copy(p.after),local:copy(merged.value),remote:copy(remote)}:null;
    replaceRow(doc,old,row);
    doc.outbox=doc.outbox.filter(r=>r.payload.mutationId!==p.mutationId);
    }catch(error){failures.push(error);}
  }
  return failures;
}

/** 创建可暂停的同步引擎，单轮任务共享状态，避免并发重复推送。 */
export function createCloudEngine({load,commit,call,uploadAssets,downloadAssets,onProgress=()=>{}}){
  let running=null,lastError=null,lastSyncedAt=null,activeMember=null,stopRequested=false,activeUpload=false,verifiedVersion=null,alignedRevision=null,alignedVersion=null;
  // 原图 URL 由内容 SHA 定址；同轮已成功校验的结果可复用，下一轮必须重新确认。
  const uploadedAssets=new Set(),downloadedAssets=new Set();
  let uploadedRecords=0,uploadBatchLimit=50;
  const boundary=()=>{if(stopRequested)throw fail('同步已暂停，本机修改和待确认提交已保留','SYNC_STOPPED');};
  // load supplies a detached native snapshot. cloudVersion guards all document
  // writes, so repeated reads of that version need no full record revalidation.
  const read=async member=>{const value=await load();if(!value.state||!safeInteger(value.state.revision)||!safeInteger(value.cloudVersion))throw fail('本机同步快照格式无效');if(!value.document)throw fail('云端同步资料未初始化或格式无效');if(member&&(value.document.workspaceId!==member.workspaceId||value.document.uid!==member.uid))throw fail('当前成员与本机云端资料不一致','OWNER_MISMATCH');if(verifiedVersion!==value.cloudVersion){validateDocument(value.document,member);verifiedVersion=value.cloudVersion;}return {...value};};
  /** 以本机 revision 和 cloudVersion 双重基线提交；并发写入发生时重新读取并重试。 */
  async function transact(member,change,at=new Date().toISOString()){
    for(let attempt=0;attempt<8;attempt++){
      const snapshot=await read(member),original={...snapshot},isAligned=alignedRevision===snapshot.state.revision&&alignedVersion===snapshot.cloudVersion;
      if(isAligned&&!change)return snapshot;
      snapshot.document={...original.document,records:[...original.document.records],outbox:[...original.document.outbox]};if(!isAligned)aligned(snapshot,at);change?.(snapshot.document,snapshot.state);
      if(!documentChanged(snapshot.document,original.document)){alignedRevision=original.state.revision;alignedVersion=original.cloudVersion;return original;}
      // Every changed row was validated by align/receive/ack. Metadata-only
      // commits (mint/consume outbox, deadline) need no full state rebuilding.
      if(snapshot.document[DRAFT_CHANGED])materialized(snapshot);
      delete snapshot.document[DRAFT_CHANGED];
      try{const receipt=await commit({baseRevision:original.state.revision,cloudVersion:original.cloudVersion,document:snapshot.document,state:snapshot.state});if(!safeInteger(receipt?.revision)||!safeInteger(receipt?.cloudVersion)||receipt.cloudVersion<=original.cloudVersion)throw fail('本机同步保存回执无效');snapshot.state={...snapshot.state,revision:receipt.revision};snapshot.cloudVersion=receipt.cloudVersion;verifiedVersion=receipt.cloudVersion;alignedRevision=receipt.revision;alignedVersion=receipt.cloudVersion;return snapshot;}
      catch(error){if(error.status!==409)throw error;}
    }
    throw fail('本机编辑持续变化，本轮同步暂缓，修改已保留','CAS_BUSY');
  }
  /** 先确保记录引用的原图可用，再提交引用它们的业务记录。 */
  async function ensureAssets(snapshot,requests){
    const referenced=assetUrls(requests);
    for(const url of referenced)if(!/^\/uploads\/[a-f0-9]{64}\.(?:png|jpg)$/.test(url))throw fail('待同步原图路径无效');
    const urls=referenced.filter(url=>!uploadedAssets.has(url));
    if(!urls.length)return;
    if(!uploadAssets)throw fail('原图上传尚未接通，待同步记录保留在本机','ASSETS_UNAVAILABLE');
    onProgress({phase:'assets-upload',count:urls.length});
    await uploadAssets({member:{...activeMember},urls});
    for(const url of urls)uploadedAssets.add(url);
  }
  async function ensureDownloads(snapshot,records){
    const referenced=assetUrls(records);
    for(const url of referenced)if(!/^\/uploads\/[a-f0-9]{64}\.(?:png|jpg)$/.test(url))throw fail('接收原图路径无效');
    const urls=referenced.filter(url=>!downloadedAssets.has(url));
    if(!urls.length)return;
    if(!downloadAssets)throw fail('原图下载尚未接通，已保留原同步游标','ASSETS_UNAVAILABLE');
    onProgress({phase:'assets-download',count:urls.length});
    await downloadAssets({member:{...activeMember},urls});
    for(const url of urls)downloadedAssets.add(url);
  }
  async function upload(uncertainOnly){
    for(let i=0;i<1000;i++){
      boundary();
      let snapshot=await transact(activeMember);
      if(!snapshot.document.outbox.length){
        if(uncertainOnly)return;
        const pending=snapshot.document.records.filter(r=>!r.conflict&&!equivalent(r.base,r.draft)).sort((a,b)=>(a.type==='workspace_meta')-(b.type==='workspace_meta'));
        if(!pending.length)return;
        if(pending[0].type==='workspace_meta'&&snapshot.document.records.some(r=>r.conflict))return;
        // 先固定本批的持久请求，再只校验该批图片；失败时保留同一 mutationId，不能阻塞于后续批次的图片。
        snapshot=await transact(activeMember,doc=>{
          if(doc.outbox.length)return;
          const rows=doc.records.filter(r=>!r.conflict&&!equivalent(r.base,r.draft)).sort((a,b)=>(a.type==='workspace_meta')-(b.type==='workspace_meta'));let bytes=0;
          for(const row of rows){if(row.type==='workspace_meta'&&doc.records.some(r=>r.conflict))continue;
            const req=envelope('sync.push',{mutationId:crypto.randomUUID(),deviceId:doc.deviceId,entityType:row.type,entityId:row.id,baseVersion:row.version,after:copy(row.draft)}),size=new TextEncoder().encode(JSON.stringify(req)).length;
            if(doc.outbox.length&&(doc.outbox.length>=50||bytes+size>210000))break;doc.outbox.push(req);bytes+=size;
          }
        });
        if(!snapshot.document.outbox.length)continue;
      }
      boundary();
      const requests=[];let requestBytes=0;for(const req of snapshot.document.outbox){const size=new TextEncoder().encode(JSON.stringify(req)).length;if(requests.length&&(requests.length>=uploadBatchLimit||requestBytes+size>210000))break;requests.push(copy(req));requestBytes+=size;}await ensureAssets(snapshot,requests);
      boundary();
      onProgress({phase:'upload',count:requests.length,completed:uploadedRecords});
      const response=await call(envelope('sync.pushBatch',{requests}));
      if(!response?.ok){
        // 数据库整批失败时缩小传输批次；队列中的请求、正文和 mutationId 保持原样。
        // 服务端可能已提交但丢失回执，重发仍须依赖原提交 ID 的幂等回执。
        if(response?.code==='DATABASE_UNAVAILABLE'&&requests.length>1){
          uploadBatchLimit=Math.max(1,Math.floor(requests.length/2));
          continue;
        }
        throw fail(response?.message||response?.code||'云端批次结果无效',response?.code);
      }
      // Reject malformed association before downloading anything. Confirmed rows
      // may be committed while failures remain immutable in the outbox.
      const preview={...snapshot.document,records:[...snapshot.document.records],outbox:[...snapshot.document.outbox]};acknowledge(preview,requests,response.results);
      const outstanding=new Set(preview.outbox.map(r=>r.payload.mutationId));
      await ensureDownloads(snapshot,response.results.flatMap((result,i)=>outstanding.has(requests[i].payload.mutationId)?[]:[result.code==='CONFLICT'?result.remote:result.record]));
      let failures;
      await transact(activeMember,doc=>{failures=acknowledge(doc,requests,response.results);});
      // 已处理计数只在本机回执落盘后推进；失败和取消不会伪装成已完成。
      uploadedRecords+=requests.length-failures.length;
      if(failures.length)throw failures[0];
      boundary();
    }
    throw fail('本轮上传达到上限，请继续同步');
  }
  async function checkpoint(){
    for(let attempt=0;attempt<3;attempt++){
      let seq,cursor=null,rows=[],keys=new Set(),restart=false;
      for(let i=0;i<5000;i++){
        boundary();
        const snapshot=await transact(activeMember);if(snapshot.document.outbox.length)throw fail('待确认提交不能跳过检查点');
        onProgress({phase:'checkpoint-request',page:i+1,received:rows.length,attempt:attempt+1});
        const part=await call(envelope('sync.snapshot',{cursor,limit:100,...(seq===undefined?{}:{checkpointSeq:seq})}));
        if(part?.code==='SNAPSHOT_CHANGED'){restart=true;break;}
        if(!part?.ok||!safeInteger(part.checkpointSeq)||!Array.isArray(part.records)||typeof part.hasMore!=='boolean'||seq!==undefined&&seq!==part.checkpointSeq)throw fail(part?.message||part?.code||'云端检查点分页无效');
        seq??=part.checkpointSeq;if(seq<snapshot.document.cursor)throw fail('云端检查点版本回退');
        let previous=cursor;
        for(const input of part.records){const row=validateRemote(input),key=[row.type,row.id];if(typeof row.type!=='string'||typeof row.id!=='string'||previous&&(row.type<previous[0]||row.type===previous[0]&&row.id<=previous[1])||keys.has(recordKey(row.type,row.id)))throw fail('云端检查点记录重复或顺序无效');keys.add(recordKey(row.type,row.id));previous=key;rows.push(copy(row));}
        if(part.hasMore&&(!part.records.length||!Array.isArray(part.nextCursor)||part.nextCursor.length!==2)||part.records.length&&!equal(part.nextCursor,previous)||!part.records.length&&!equal(part.nextCursor,cursor))throw fail('云端检查点游标无效');
        cursor=part.nextCursor;onProgress({phase:'checkpoint',page:i+1,received:rows.length});
        if(!part.hasMore){await ensureDownloads(snapshot,rows);boundary();onProgress({phase:'checkpoint-commit',received:rows.length});await transact(activeMember,doc=>{if(doc.outbox.length)throw fail('待确认提交不能接收检查点');if(seq<doc.cursor)throw fail('云端检查点版本回退');for(const row of rows)receive(doc,row);doc.cursor=seq;});return;}
      }
      if(!restart)throw fail('云端检查点分页达到上限');
    }
    throw fail('云端检查点持续变化，请稍后同步');
  }
  async function pull(firstPass=false){
    let head,received=0;
    // 空目录直接读取当前实体快照，避免从序号 0 重放多年修改并逐页重建整库。
    // 离线草稿或待确认请求仍走原合并路径；快照完整校验后才原子落盘。
    const initial=await transact(activeMember),doc=initial.document;
    const pristine=doc.cursor===0&&!doc.records.length&&!doc.outbox.length&&!doc.materializedProjection.length;
    // 旧客户端可能已拉了一部分历史。仅首次空目录接入、从未完成同步、无草稿或冲突时
    // 转为快照续接；迁移库与已完成同步的客户端不改变增量策略。
    const partialFirstDownload=doc.origin==='empty-workspace'&&doc.lastSyncedAt==null&&!doc.outbox.length
      &&doc.records.every(row=>!row.conflict&&equivalent(row.base,row.draft))
      &&equivalent(projectWorkspace(initial.state),doc.materializedProjection);
    if(firstPass&&(pristine||partialFirstDownload))await checkpoint();
    for(let i=0;i<5000;i++){
      boundary();
      const snapshot=await transact(activeMember),cursor=snapshot.document.cursor;
      onProgress({phase:'download-request',page:i+1,received,cursor});
      const page=await call(envelope('sync.pull',{cursor,limit:100,...(head===undefined?{}:{headSeq:head})}));
      if(page?.code==='SNAPSHOT_REQUIRED'){await checkpoint();head=undefined;continue;}
      validatePage(page,cursor,head);head??=page.headSeq;
      await ensureDownloads(snapshot,page.changes);
      await transact(activeMember,doc=>{if(doc.cursor!==cursor){if(doc.cursor>=page.nextCursor)return;throw fail('请求期间同步游标已变化');}for(const row of page.changes)receive(doc,row);doc.cursor=page.nextCursor;});
      received+=page.changes.length;onProgress({phase:'download',page:i+1,received,cursor:page.nextCursor,total:head});if(!page.hasMore)return;
    }
    throw fail('本轮同步分页达到上限');
  }
  async function receiptsOnly(){
    for(let i=0;i<1000;i++){
      boundary();const snapshot=await transact(activeMember),req=snapshot.document.outbox[0];if(!req)return;
      const response=await call(envelope('sync.receipt',{mutationId:req.payload.mutationId}));
      const preview={...snapshot.document,records:[...snapshot.document.records],outbox:[...snapshot.document.outbox]},errors=acknowledge(preview,[req],[response]);
      if(errors.length)throw errors[0];
      await ensureDownloads(snapshot,[response.code==='CONFLICT'?response.remote:response.record]);
      await transact(activeMember,doc=>{const errors=acknowledge(doc,[req],[response]);if(errors.length)throw errors[0];});
    }
    throw fail('待确认回执较多，请继续读取');
  }
  const summarize=(snapshot,{includeConflicts=false}={})=>{const doc=snapshot.document;return {workspaceId:doc.workspaceId,uid:doc.uid,deviceId:doc.deviceId,cursor:doc.cursor,pending:doc.records.filter(r=>!equivalent(r.base,r.draft)).length,localChanges:alignedRevision===snapshot.state.revision&&alignedVersion===snapshot.cloudVersion?false:!equivalent(projectWorkspace(snapshot.state),doc.materializedProjection),uncertain:doc.outbox.length,conflicts:doc.records.filter(r=>r.conflict).length,...(includeConflicts?{conflictRecords:copy(doc.records.filter(r=>r.conflict))}:{}),running:!!running,stopRequested,lastError,lastSyncedAt:lastSyncedAt??doc.lastSyncedAt??null};};
  const status=async options=>summarize(await read(activeMember),options);
  const run=({member,upload:allowUpload=true})=>{
    if(running){if(member?.uid!==activeMember?.uid||member?.workspaceId!==activeMember?.workspaceId)return Promise.reject(fail('另一成员同步尚未结束'));if(activeUpload!==allowUpload)return Promise.reject(fail('另一同步模式正在运行，请先暂停'));return running;}
    uploadedAssets.clear();downloadedAssets.clear();uploadedRecords=0;
    activeMember=copy(member);activeUpload=allowUpload;stopRequested=false;running=(async()=>{try{if(!member?.uid||!member?.workspaceId)throw fail('请先登录有效成员');await transact(activeMember);boundary();if(allowUpload)await upload(true);else await receiptsOnly();await pull(true);if(allowUpload){await upload(false);await pull();}boundary();await transact(activeMember,doc=>{doc.lastSyncedAt=new Date().toISOString();});lastError=null;lastSyncedAt=new Date().toISOString();return {...await status(),running:false};}catch(error){lastError=error.message;throw error;}finally{running=null;}})();return running;
  };
  // 比较页的快照保留在 Worker；短令牌避免把整份配置再次往返传输。
  const conflictPreviews=new Map();
  async function conflicts(){
    const snapshot=await read(activeMember);
    // 比较纳入已保存但尚未同步的新编辑，预览本身不落库。
    snapshot.document={...snapshot.document,records:[...snapshot.document.records],outbox:[...snapshot.document.outbox]};
    const at=new Date().toISOString();aligned(snapshot,at);
    const all=snapshot.document.records.filter(row=>row.conflict);
    conflictPreviews.clear();
    const rows=all.slice(0,100).map(row=>{
      const token=crypto.randomUUID();
      conflictPreviews.set(token,{uid:snapshot.document.uid,workspaceId:snapshot.document.workspaceId,at,row:copy(row)});
      return {...copy(row),token};
    });
    return {rows,total:all.length};
  }
  async function resolveMany(selections){
    if(running)throw fail('请等待本轮同步结束');
    if(!Array.isArray(selections)||!selections.length||selections.length>100)throw fail('请选择当前页的冲突');
    const snapshot=await read(activeMember),member={uid:snapshot.document.uid,workspaceId:snapshot.document.workspaceId},seen=new Set();
    const expected=selections.map(item=>{
      const preview=conflictPreviews.get(item.token),key=recordKey(item.type,item.id);
      if(!['local','remote'].includes(item.choice)||seen.has(key))throw fail('选择的版本或配置重复，请重新选择');
      seen.add(key);
      if(!preview||preview.uid!==member.uid||preview.workspaceId!==member.workspaceId||preview.row.type!==item.type||preview.row.id!==item.id)throw fail('比较已过期，请刷新后重新比较');
      return {...item,expected:preview.row,at:preview.at};
    });
    const saved=await transact(member,doc=>{
      // 先检查整批；任一条在预览后发生变化，整批不写入。
      const changes=expected.map(item=>{
        const old=doc.records.find(r=>r.type===item.type&&r.id===item.id);
        if(!old?.conflict||!equivalent(old.conflict,item.expected.conflict)||!equivalent(old.draft,item.expected.draft))throw fail('冲突或本机内容已变化，请刷新后重新比较');
        if(doc.outbox.some(r=>r.payload.entityType===item.type&&r.payload.entityId===item.id))throw fail('请先核实待确认提交');
        const remote=validateRemote(old.conflict.remote);
        return {old,row:{...old,draft:item.choice==='remote'?copy(remote.data):old.draft,base:copy(remote.data),version:remote.version,conflict:null}};
      });
      for(const {old,row} of changes)replaceRow(doc,old,row);
    },expected[0].at);
    for(const item of expected)conflictPreviews.delete(item.token);
    return {...summarize(saved),resolved:expected.length};
  }
  async function resolve(type,id,choice){
    if(running)throw fail('请等待本轮同步结束');if(!['local','remote'].includes(choice))throw fail('请选择保留的版本');
    const member=activeMember??{uid:(await read()).document.uid,workspaceId:(await read()).document.workspaceId};
    const expected=copy((await read(member)).document.records.find(r=>r.type===type&&r.id===id)?.conflict);
    await transact(member,doc=>{const old=doc.records.find(r=>r.type===type&&r.id===id);if(!old?.conflict||!equal(old.conflict,expected))throw fail('冲突已变化，请刷新后重新比较');if(doc.outbox.some(r=>r.payload.entityType===type&&r.payload.entityId===id))throw fail('请先核实待确认提交');const row={...old},remote=validateRemote(row.conflict.remote);if(choice==='remote')row.draft=copy(remote.data);row.base=copy(remote.data);row.version=remote.version;row.conflict=null;replaceRow(doc,old,row);});return status();
  }
  return {run,status,conflicts,resolve,resolveMany,stop:()=>{stopRequested=true;},cancel:()=>{stopRequested=true;}};
}
