/** 局部保存追踪：由编辑入口明确申报配置 ID，依靠不可变基线与变更代次决定能否安全增量保存。 */
import {captureEditorState} from './editor-performance.js';
import {sameValue} from './workspace-ui-merge.js';

const drafts=new WeakMap(),captures=new WeakMap();
// shops is the fixed client registry and dataVersion is its normalization
// marker. The existing API does not write these derived, read-only fields.
const metadata=new Set(['revision','updatedAt','logs','shops','dataVersion']);
const editingFields=new Set(['configs','templates','sourceCatalog','costSource','caseGallery','shopSettings']);
const businessKeys=(a,b)=>[...new Set([...Object.keys(a||{}),...Object.keys(b||{})])].filter(key=>!metadata.has(key));
export const sameCapturedBusinessState=(a,b)=>businessKeys(a,b).every(key=>a?.[key]===b?.[key]);
// The existing full API writes six editing fields. Decline changed unknown
// roots rather than silently dropping them or expanding that API contract.
export const unsupportedSaveRootChanges=(base,snapshot)=>base?businessKeys(base,snapshot).filter(key=>!editingFields.has(key)&&!sameValue(base[key],snapshot[key])):[];
const get=state=>{let scope=drafts.get(state);if(!scope){scope={full:true,reason:'unconfirmed draft',generation:0,declared:new Set(),versions:new Map()};drafts.set(state,scope);}return scope;};

// This is an explicit editor-call contract, not a raw-object mutation observer.
// Every unaudited/global mutation must invalidate before a later local edit.
// In-place nested writes outside declared targets cannot be detected here.
/** 全局或未审计修改使局部追踪失效，后续保存必须重新完整捕获。 */
export function invalidateSaveScope(state,reason){if(!state)return;const scope=get(state);scope.full=true;scope.reason=reason;scope.generation++;scope.declared.clear();}
/** 在修改发生前登记合法目标，基线不一致时主动退回完整保存。 */
export function declareSaveScope(state,base,ids){
 const scope=get(state),targets=new Set(ids);
 if(!base||!targets.size||targets.has(null)||targets.has(undefined)||targets.size!==state.configs.filter(row=>targets.has(row.id)).length){invalidateSaveScope(state,'invalid checkpoint targets');return;}
 if(scope.base&&scope.base!==base){invalidateSaveScope(state,'accepted baseline replaced');return;}
 for(const id of targets)scope.declared.add(id);
}
/** 为已登记配置记录编辑代次；未申报修改不能走局部保存捷径。 */
export function changeSaveScope(state,base,ids){
 const scope=get(state);scope.generation++;
 if(scope.full)return;
 if(scope.base!==base||!ids.length||ids.some(id=>!scope.declared.has(id))){invalidateSaveScope(state,'changed without matching declaration');return;}
 for(const id of ids)scope.versions.set(id,scope.generation);
}
/** 局部历史恢复继承原追踪；未知恢复范围使下一次保存回到完整路径。 */
export function transferSaveScope(before,after,base,ids){
 const scope=get(before);
 if(ids===null||scope.full||scope.base!==base){invalidateSaveScope(after,'full or unconfirmed history restore');return;}
 // Local history restoration changes only known rows; unrelated references
 // and collection order are preserved by restoreHistorySnapshot.
 drafts.set(after,{...scope,declared:new Set([...scope.declared,...ids]),versions:new Map(scope.versions)});
}
/** 确认目标外根对象、列表结构和未编辑行引用都保持不变。 */
function guard(state,scope){
 const keys=Object.keys(state).filter(key=>!metadata.has(key));
 if(keys.length!==scope.keys.length||keys.some(key=>!scope.keys.includes(key)))return false;
 for(const key of keys)if(key!=='configs'&&state[key]!==scope.values[key])return false;
 if(state.configs.length!==scope.rows.length)return false;
 return state.configs.every((row,index)=>row.id===scope.base.configs[index].id&&(scope.versions.has(row.id)||row===scope.rows[index]));
}
/** 只在范围追踪和结构守卫均通过时复制已改配置，否则捕获完整业务状态。 */
export function captureSaveSnapshot(state,base){
 const scope=get(state);let snapshot,ids=null;
 if(!scope.full&&scope.versions.size>0&&scope.base===base&&guard(state,scope)){
  ids=[...scope.versions.keys()];const targets=new Set(ids);
  let configs=null;
  for(let index=0;index<state.configs.length;index++){
   if(!targets.has(state.configs[index].id))continue;
   const after=captureEditorState({configs:[state.configs[index]]},{configs:[base.configs[index]]}).configs[0];
   if(after!==base.configs[index]){configs??=base.configs.slice();configs[index]=after;}
  }
  snapshot={...base,configs:configs||base.configs};
  for(const key of ['revision','updatedAt','logs'])if(Object.hasOwn(state,key))snapshot[key]=state[key];
 }else{
  if(!scope.full)invalidateSaveScope(state,scope.versions.size?'draft structure or collection reference changed':'capture without tracked edits');
  snapshot=captureEditorState(state,base);
 }
 captures.set(snapshot,{owner:state,generation:scope.generation,ids,versions:new Map(scope.versions)});
 return snapshot;
}
export const saveSnapshotIds=snapshot=>captures.get(snapshot)?.ids??null;
/** 按回执对应代次清除已确认修改，保存期间新增的编辑继续保留。 */
export function acknowledgeSaveScope(state,base,snapshot,dirty){
 const ticket=captures.get(snapshot),scope=get(state);
 if(!ticket||ticket.owner!==state)return;
 if(!dirty&&ticket.generation===scope.generation){
  scope.full=false;scope.reason='confirmed capture';scope.versions.clear();
 }else if(scope.full||ticket.ids===null)return;
 else for(const [id,version] of ticket.versions)if(scope.versions.get(id)===version)scope.versions.delete(id);
 scope.base=base;scope.keys=Object.keys(state).filter(key=>!metadata.has(key));
 scope.values={...state};scope.rows=state.configs.slice();
}
export function saveScopeStatus(state){const scope=get(state);return {full:scope.full,reason:scope.reason,ids:[...scope.versions.keys()],declared:[...scope.declared]};}
