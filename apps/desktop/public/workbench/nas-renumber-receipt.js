/** 新回执携带服务器实际修改的编号文案；旧回执只有名称，不能据此推断副标题。 */
import {NasApiError} from './nas-api-client.js';

const fieldPaths={
 shortName:['shortName'],posterSubtitle:['posterSubtitle'],
 textSubtitle:['textStyles','header.subtitle','text'],skuTextSubtitle:['skuTextStyles','header.subtitle','text']
};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateRenumberFields(row){
 if(!Object.hasOwn(row,'before_fields')&&!Object.hasOwn(row,'after_fields'))return;
 for(const fields of [row.before_fields,row.after_fields]){
  if(!object(fields)||Object.keys(fieldPaths).some(key=>Object.hasOwn(fields,key)&&typeof fields[key]!=='string'&&fields[key]!==null))
   throw new NasApiError('INVALID_API_RESPONSE');
 }
}
function setLeaf(document,path,before,after,keepEdits){
 let target=document;
 for(const key of path.slice(0,-1)){
  if(!object(target[key])){
   // 删除缺省文案不创建样式对象，用户清空整个样式后也不会复活旧的 text。
   if(after===undefined||keepEdits&&before!==undefined)return;
   target[key]={};
  }
  target=target[key];
 }
 const key=path.at(-1);
 if(keepEdits&&target[key]!==before)return;
 if(after===undefined)delete target[key];else target[key]=after;
}
export function applyNasRenumber(document,row,keepEdits=true){
 if(!document)return;
 validateRenumberFields(row);
 if(!keepEdits||document.name===row.before)document.name=row.name;
 if(!row.before_fields)return;
 for(const [key,path] of Object.entries(fieldPaths)){
  const before=row.before_fields[key],after=row.after_fields[key];
  if(keepEdits&&before===after)continue;
  setLeaf(document,path,before,after,keepEdits);
 }
}
