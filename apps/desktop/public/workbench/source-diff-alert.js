import {sourceFields} from './shared-source-fields.js';
import {sameNasDocument} from './nas-main-workspace.js';

const textFields = [['name','name'],['upgrade','addon']];

/** 共用修改、本店覆盖与恢复都可能改变有效文案，外店独享改动不纳入本店。 */
export function editedSourceTextFields(change,shop){
 if(change.managed)return textFields.filter(([,key])=>['shared',shop].some(scope=>{
  const edit=change.managed.edits[scope];
  return Object.hasOwn(edit?.values??{},key)||edit?.restore?.includes(key);
 })).map(([field])=>field);
 if((change.row.shopId||'intel')!==shop)return [];
 const before=sourceFields(change.before??{}),after=sourceFields(change.row);
 return textFields.filter(([,key])=>!sameNasDocument(before[key],after[key])).map(([field])=>field);
}

/** 按历史别名比较保存前后的有效值，每条来源只处理本次提交的字段。 */
export function changedSourceText(before,after,fieldsForRow){
 const previous=new Map(before.map(row=>[row.sourceId,sourceFields(row)]));
 return after.flatMap(row=>{
  if(row.deletedAt)return [];
  const old=previous.get(row.sourceId)??sourceFields({}),next=sourceFields(row),edited=fieldsForRow(row);
  const fields=textFields.filter(([field,key])=>edited.has(field)&&!sameNasDocument(old[key],next[key])).map(([field])=>field);
  return fields.length?[{row,fields}]:[];
 });
}

/** 主栏和已打开的工作表接收同一次通知；重新挂载的组件也能读取最近的值。 */
export function publishSourceSummary(doc,shop,{count,latestChangedAt}){
 const stamp=new Date(latestChangedAt),pad=value=>String(value).padStart(2,'0');
 const time=latestChangedAt&&Number.isFinite(stamp.getTime())?
  `${pad(stamp.getMonth()+1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`:'';
 const data=doc.body.dataset;
 if(data.sourceDiffShop===shop&&data.sourceDiffCount===String(count)&&data.sourceDiffTime===time)return;
 Object.assign(data,{sourceDiffShop:shop,sourceDiffCount:String(count),sourceDiffTime:time});
 doc.dispatchEvent(new CustomEvent('source-diff-change',{detail:{shop,count,latestChangedAt}}));
}
