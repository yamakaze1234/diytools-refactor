/** 预览版式设置：规范版式输入并统一应用到选中配置。 */
// A shop shares its output view; artwork and business fields stay per configuration.
/** 将界面版式值转换为受支持的配置格式。 */
export function normalizePosterView(value){
 if(!value||!['long','square'].includes(value.layout))return null;
 return {layout:value.layout,skuMode:value.skuMode==='padded'?'padded':'dedicated'};
}

/** 把同一版式选择应用到目标配置集合。 */
export function applyPosterView(configs,value){
 const view=normalizePosterView(value),ids=[];
 if(!view)return ids;
 for(const config of configs){
  if(config.deletedAt||config.layout===view.layout&&(config.skuMode||'dedicated')===view.skuMode)continue;
  Object.assign(config,view);ids.push(config.id);
 }
 return ids;
}
