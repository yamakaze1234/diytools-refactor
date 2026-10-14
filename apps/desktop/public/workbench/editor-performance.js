/** 编辑快照与回执应用：复用不可变基线，分片合并历史，保留当前可变编辑对象。 */
import {syncActualParts} from './actual-parts.js';
import {mergeEditingState,mergeEditingStateAsync,sameValue} from './workspace-ui-merge.js';

// IDs describe the edited configurations. An empty list is a global-only edit;
// null remains an explicit request to synchronize the complete workspace.
/** 只同步本次编辑涉及的展示配件；空 ID 列表表示只改全局数据，null 才表示全量。 */
export function syncDisplayParts(configs,baseline,ids=null){
 const targets=ids==null?null:new Set(ids);
 if(targets?.size===0)return;
 for(const config of configs){
  if(targets&&!targets.has(config.id))continue;
  syncActualParts(config,baseline.get(config.id));
  baseline.set(config.id,structuredClone(config.parts));
 }
}

// Activity is append-only server data. Editors replace the logs array on a
// receipt; they never mutate its rows. Keep it out of business clone/merge work.
export function withoutActivityLogs(state){const result={...state};delete result.logs;return result;}
/** 复制可编辑业务状态，追加式操作日志保持只读共享。 */
export function cloneEditorState(state){
 const result=structuredClone(withoutActivityLogs(state));
 if(Object.hasOwn(state,'logs'))result.logs=state.logs;
 return result;
}
// Only immutable accepted values may be shared. Changed values are captured
// independently of the live draft, including globals and unknown fields.
/** 与已接受基线比较，仅复制改变的值，保证快照不引用可变草稿。 */
export function captureEditorState(state,acceptedState){
 if(!acceptedState)return cloneEditorState(state);
 const result=capture(withoutActivityLogs(state),withoutActivityLogs(acceptedState));
 if(Object.hasOwn(state,'logs'))result.logs=state.logs;
 return result;
}
export function mergeEditorState(base,local,remote){
 const result=mergeEditingState(withoutActivityLogs(base),withoutActivityLogs(local),withoutActivityLogs(remote));
 preserveOtherDraftRoots(result,base,local,remote);
 if(Object.hasOwn(remote,'logs'))result.state.logs=remote.logs;
 return result;
}
/** 分片执行编辑状态三方合并，避免长时间占用界面线程。 */
export async function mergeEditorStateAsync(base,local,remote,options){
 const result=await mergeEditingStateAsync(withoutActivityLogs(base),withoutActivityLogs(local),withoutActivityLogs(remote),options);
 preserveOtherDraftRoots(result,base,local,remote);
 if(Object.hasOwn(remote,'logs'))result.state.logs=remote.logs;
 return result;
}
const managedRoots=new Set(['configs','templates','sourceCatalog','costSource','caseGallery','shopSettings','revision','updatedAt','logs','shops','dataVersion']);
function preserveOtherDraftRoots(result,base,local,remote){
 // These fields remain outside the write protocol. Keep a new unsupported
 // draft edit through receipt materialization, so the next save can reject
 // it explicitly instead of silently losing the input.
 for(const key of new Set([...Object.keys(base),...Object.keys(local)])){
  if(managedRoots.has(key)||sameValue(base[key],local[key]))continue;
  const merged=mergeEditingState({shopSettings:{[key]:base[key]}},{shopSettings:{[key]:local[key]}},{shopSettings:{[key]:remote[key]}});
  result.conflict||=merged.conflict;
  if(Object.hasOwn(merged.state.shopSettings,key))result.state[key]=merged.state.shopSettings[key];else delete result.state[key];
 }
}
// The draft remains editable while slices yield. Discard a result prepared
// across an input/undo event and retry from the latest draft and history.
/** 回执准备期间若发生输入或撤销，丢弃旧准备结果并从最新草稿重新合并。 */
export async function prepareSavedReceipt(sent,remote,{getState,getCounter,getStacks,options}){
 for(;;){
  const state=getState(),counter=getCounter(),stacks=getStacks().map(stack=>[...stack]);
  const live=await mergeEditorStateAsync(sent,state,remote,{...options,ownLocalRows:true});
  const rebased=[];
  for(const stack of stacks){const rows=[];for(const item of stack)rows.push(await rebaseHistorySnapshotAsync(item,sent,remote,options));rebased.push(rows);}
  const currentStacks=getStacks();
  if(state!==getState()||counter!==getCounter()||stacks.some((stack,index)=>stack.length!==currentStacks[index].length||stack.some((item,i)=>item!==currentStacks[index][i])))continue;
  return {live,rebased};
 }
}

// The editor and poster inspector bind callbacks to the live configuration,
// parts array and module objects. Replacing those while dirty leaves later
// input writing an orphan. Commit only after the receipt/stacks are stable;
// mutate owned draft objects, never immutable sent/accepted/history values.
/** 将回执内容写回已有编辑对象，避免输入控件继续引用已脱离状态的旧对象。 */
export function applySavedReceiptDraft(current,merged,sent){
 const retain=(draft,value,baseline,key)=>{
  if(draft===value)return draft;
  if(draft===baseline)return structuredClone(value);
  if(!draft||!value||typeof draft!=='object'||typeof value!=='object'||Array.isArray(draft)!==Array.isArray(value))return value;
  if(Array.isArray(value)){
   key??=['id','lineId','slot','sourceId','goodsId'].find(candidate=>[draft,value].every(rows=>rows.every(row=>row&&typeof row==='object'&&row[candidate]!=null)&&new Set(rows.map(row=>row[candidate])).size===rows.length));
   const before=key?new Map(draft.map(row=>[row[key],row])):null,saved=key?new Map((Array.isArray(baseline)?baseline:[]).filter(row=>row&&typeof row==='object'&&row[key]!=null).map(row=>[row[key],row])):null;
   const rows=value.map((row,index)=>retain(key?before.get(row[key]):draft[index],row,key?saved.get(row[key]):baseline?.[index]));
   draft.length=rows.length;for(let index=0;index<rows.length;index++)draft[index]=rows[index];return draft;
  }
  for(const name of Object.keys(draft))if(!Object.hasOwn(value,name))delete draft[name];
  for(const [name,item] of Object.entries(value))draft[name]=retain(draft[name],item,baseline?.[name]);
  return draft;
 };
 for(const [name,key] of Object.entries({configs:'id',templates:'id',sourceCatalog:'sourceId',costSource:'goodsId',caseGallery:'id',shopSettings:undefined}))merged[name]=retain(current[name],merged[name],sent[name],key);
 return merged;
}

// Captures share only immutable baselines/snapshots, never the mutable draft.
function capture(value,previous){
 if(value===previous)return previous;
 if(!value||!previous||typeof value!=='object'||typeof previous!=='object')return structuredClone(value);
 if(Array.isArray(value)){
  if(!Array.isArray(previous))return structuredClone(value);
  let result=value.length===previous.length?null:[];
  for(let i=0;i<value.length;i++){const next=capture(value[i],previous[i]);if(!result&&next!==previous[i])result=previous.slice(0,i);if(result)result.push(next);}
  return result||previous;
 }
 if(Array.isArray(previous))return structuredClone(value);
 const keys=Object.keys(value),defined=keys.filter(key=>value[key]!==undefined),oldDefined=Object.keys(previous).filter(key=>previous[key]!==undefined);
 let result=defined.length===oldDefined.length&&defined.every(key=>Object.hasOwn(previous,key)&&previous[key]!==undefined)?null:{};
 for(const key of keys){const next=capture(value[key],previous[key]);if(!result&&next!==previous[key])result={...previous};if(result)result[key]=next;}
 return result||previous;
}
export function captureHistorySnapshot(state,{active,activeShopId,selected},previous){
 const {caseGallery,configs,templates,sourceCatalog,costSource,shopSettings}=state;
 return capture({caseGallery,configs,templates,sourceCatalog,costSource,shopSettings,active,activeShopId,selected:[...selected]},isConfigHistorySnapshot(previous)?undefined:previous);
}
export const isConfigHistorySnapshot=snapshot=>snapshot?.historyScope==='configs';
/** 仅记录指定配置及选择状态，减少普通编辑的撤销快照大小。 */
export function captureConfigHistorySnapshot(state,{active,activeShopId,selected},ids,previous){
 const targets=new Set(ids);
 if(!targets.size||targets.has(null)||targets.has(undefined))return null;
 const configs=state.configs.filter(config=>targets.has(config.id));
 if(configs.length!==targets.size)return null;
 return capture({historyScope:'configs',configs,active,activeShopId,selected:[...selected]},isConfigHistorySnapshot(previous)?previous:undefined);
}
export function sameHistorySnapshot(before,after){
 return isConfigHistorySnapshot(before)===isConfigHistorySnapshot(after)&&sameValue(before,after);
}
/** 从全量或局部快照恢复编辑状态，保留未覆盖的其他配置。 */
export function restoreHistorySnapshot(state,snapshot){
 if(isConfigHistorySnapshot(snapshot)){
  const restored=new Map(structuredClone(snapshot.configs).map(config=>[config.id,config]));
  if([...restored.keys()].some(id=>!state.configs.some(config=>config.id===id)))throw Error('撤销目标已不存在，请先重新载入配置');
  return {...state,configs:state.configs.map(config=>restored.get(config.id)||config)};
 }
 const restored=structuredClone(snapshot);
 return {...state,...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,restored[key]]))};
}
export function rebaseHistorySnapshot(snapshot,sent,remote){
 if(isConfigHistorySnapshot(snapshot)){
  const ids=new Set(snapshot.configs.map(config=>config.id)),pick=state=>({configs:state.configs.filter(config=>ids.has(config.id)),shopSettings:{}});
  const receipt=pick(remote);
  const sentIds=new Set(sent.configs.map(config=>config.id)),remoteIds=new Set(receipt.configs.map(config=>config.id));
  // A local full operation may remove a placeholder; an earlier full undo
  // must restore it before this scoped entry can apply. A remote deletion of
  // a still-sent target is instead a concurrency conflict.
  if([...ids].some(id=>sentIds.has(id)&&!remoteIds.has(id)))return {snapshot,conflict:true};
  const result=mergeEditingState(pick(sent),{configs:snapshot.configs,shopSettings:{}},receipt);
  return {snapshot:{...snapshot,configs:result.state.configs},conflict:result.conflict};
 }
 const result=mergeEditingState(withoutActivityLogs(sent),snapshot,withoutActivityLogs(remote));
 // A receipt may normalize rows while preserving the sent list order. Keep
 // the undo snapshot's earlier order in that case (including add/remove undo).
 if(sameValue(sent.configs.map(config=>config.id),remote.configs.map(config=>config.id))){
  const rows=new Map(result.state.configs.map(config=>[config.id,config])),ordered=snapshot.configs.flatMap(config=>rows.has(config.id)?[rows.get(config.id)]:[]),seen=new Set(ordered.map(config=>config.id));
  result.state.configs=[...ordered,...result.state.configs.filter(config=>!seen.has(config.id))];
 }
 const fields=['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'];
 return {snapshot:{...Object.fromEntries(fields.map(key=>[key,result.state[key]])),active:snapshot.active,activeShopId:snapshot.activeShopId,selected:snapshot.selected},conflict:result.conflict};
}
/** 在新保存回执上重建撤销快照，保留用户自己的编辑变化。 */
export async function rebaseHistorySnapshotAsync(snapshot,sent,remote,options){
 if(isConfigHistorySnapshot(snapshot))return rebaseHistorySnapshot(snapshot,sent,remote);
 const result=await mergeEditorStateAsync(sent,snapshot,remote,options);
 if(sameValue(sent.configs.map(config=>config.id),remote.configs.map(config=>config.id))){
  const rows=new Map(result.state.configs.map(config=>[config.id,config])),ordered=snapshot.configs.flatMap(config=>rows.has(config.id)?[rows.get(config.id)]:[]),seen=new Set(ordered.map(config=>config.id));
  result.state.configs=[...ordered,...result.state.configs.filter(config=>!seen.has(config.id))];
 }
 const fields=['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'];
 return {snapshot:{...Object.fromEntries(fields.map(key=>[key,result.state[key]])),active:snapshot.active,activeShopId:snapshot.activeShopId,selected:snapshot.selected},conflict:result.conflict};
}
const byteCache=new WeakMap();
function rowBytes(value){
 if(value&&typeof value==='object'&&byteCache.has(value))return byteCache.get(value);
 const json=JSON.stringify(value),bytes=json===undefined?undefined:json.length*2;
 if(value&&typeof value==='object')byteCache.set(value,bytes);
 return bytes;
}
// The same UTF-16 JSON size used by the existing history limit, calculated
// once for each immutable value instead of serializing entire snapshots.
/** 估算历史快照的内存规模，用于控制撤销栈保留预算。 */
export function historySnapshotBytes(value){
 if(value&&typeof value==='object'){
  if(byteCache.has(value))return byteCache.get(value);
  let bytes;
  if(Array.isArray(value))bytes=4+Math.max(0,value.length-1)*2+value.reduce((sum,item)=>sum+(rowBytes(item)??8),0);
  else{const entries=Object.entries(value).filter(([,item])=>item!==undefined);bytes=4+Math.max(0,entries.length-1)*2+entries.reduce((sum,[key,item])=>sum+JSON.stringify(key).length*2+2+historySnapshotBytes(item),0);}
  byteCache.set(value,bytes);return bytes;
 }
 const json=JSON.stringify(value);return json===undefined?undefined:json.length*2;
}
