/** 只复制本次选中的内容类别到目标配置。 */
/** 按用户选择复制配置内容，避免批量操作带入未勾选的加购、福利或版本字段。 */
export function applyBatchContent(reference,target,{addons=false,benefits=false,version=false}={}){
 if(version)target.version=reference.version||'';
 if(addons){
  target.addons=structuredClone(reference.addons||[]);
  for(const addon of target.addons)if(addon.sourceId&&!target.parts.some(p=>p.sourceId===addon.sourceId))delete addon.sourceId;
 }
 if(benefits)target.benefits=structuredClone(reference.benefits||[]);
 return target;
}
