/** SKU 固定样式：旧 skuMode 曾自动填为 dedicated，不能代表人工选择。 */
export function skuImageMode(config){return config?.skuExportMode==='dedicated'?'dedicated':'padded';}

/** 导出仅克隆样式；保存选择由界面经既有工作区事务完成。 */
export function skuImageConfig(config,mode=null){
 const selected=['padded','dedicated'].includes(mode)?mode:skuImageMode(config);
 return {...structuredClone(config),skuMode:selected,skuExportMode:selected};
}

/** 只保存指定目标的显式选择，不改变版式、业务内容或其他配置。 */
export function applySkuImageMode(configs,ids,mode){
 if(!['padded','dedicated'].includes(mode))return [];
 const wanted=new Set(ids),targets=configs.filter(c=>wanted.has(c.id)&&!c.deletedAt);
 if(targets.length!==wanted.size)throw Error('导出目标已变化，请重新选择配置');
 const changed=[];
 for(const c of targets){if(c.skuExportMode===mode&&c.skuMode===mode)continue;c.skuExportMode=mode;c.skuMode=mode;changed.push(c.id);}
 return changed;
}
