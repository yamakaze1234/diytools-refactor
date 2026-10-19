/** 用户明确修改的到手价优先保存；其他字段继续使用原三方冲突检查。 */
import {mergeEditorState} from './editor-performance.js';
import {sameValue} from './workspace-ui-merge.js';

export function mergePriceSaveConflict(base,local,remote){
 const drafts=new Map((local.configs||[]).map(c=>[c.id,c])),latest=new Map((remote.configs||[]).map(c=>[c.id,c]));
 let priceOverrides=0;
 const configs=(base.configs||[]).map(before=>{
  const draft=drafts.get(before.id),saved=latest.get(before.id);
  if(!draft||!saved||before.deletedAt||draft.deletedAt||saved.deletedAt||
   ['shopId','productId'].some(key=>!sameValue(before[key],draft[key])||!sameValue(before[key],saved[key]))||
   typeof draft.price!=='number'||!Number.isFinite(draft.price)||draft.price<0||sameValue(before.price,draft.price))return before;
  const adjusted={...before};let overridden=false;
  // 导入时间属于本次价格操作；未修改的旧时间仍由正常合并处理。
  for(const field of ['price','priceImportedAt']){
   if(sameValue(before[field],draft[field]))continue;
   if(!sameValue(before[field],saved[field])&&!sameValue(draft[field],saved[field]))overridden=true;
   if(Object.hasOwn(saved,field))adjusted[field]=saved[field];else delete adjusted[field];
  }
  if(overridden)priceOverrides++;
  return adjusted;
 });
 return {...mergeEditorState({...base,configs},local,remote),priceOverrides};
}
