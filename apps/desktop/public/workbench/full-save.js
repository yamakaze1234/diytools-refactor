/** 完整工作区保存：校验详情已加载，遇到版本推进时三方合并并有限重试。 */
import {assertCompleteWorkspace} from './lazy-workspace.js';
import {mergeEditorStateAsync,withoutActivityLogs} from './editor-performance.js';

// Keep the original request snapshot immutable. A background receive can move
// the stored revision while an editor is open; only overlapping business edits
// require a choice. Every retry still uses the backend's atomic revision check.
/** 保留最初草稿快照；只自动合并非重叠更新，同字段冲突或持续并发时返回可恢复错误。 */
export async function saveFullState(request,base,snapshot,{operator,message},maxAttempts=4){
 assertCompleteWorkspace(base);assertCompleteWorkspace(snapshot);
 let baseline=base,desired=snapshot;
 for(let attempt=0;attempt<maxAttempts;attempt++){
  try{return await request('/api/state',{method:'POST',body:JSON.stringify({
   omitLogs:true,baseRevision:baseline.revision,baseState:withoutActivityLogs(baseline),
   ...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,desired[key]])),operator,message,
  })});}
  catch(error){
   if(error.status!==409)throw error;
   const remote=await request('/api/state?logs=none');
   if(remote.revision===baseline.revision)throw error;
   const merged=await mergeEditorStateAsync(baseline,desired,remote);
   if(merged.conflict)throw Object.assign(Error('同一内容在本机与同步版本中都有修改，请比较后选择；当前输入已保留。'),{status:409});
   if(attempt===maxAttempts-1)throw Object.assign(Error('同步仍在更新数据，本机草稿已保留，请稍后重试保存。'),{code:'SAVE_RETRY_LATER'});
   baseline=remote;desired=merged.state;
  }
 }
}
