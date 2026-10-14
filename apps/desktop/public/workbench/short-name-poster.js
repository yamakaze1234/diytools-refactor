/** 配置简称与海报标题联动：维护自动简称，同时尊重手工文案。 */
import {suggestedName} from './legacy-names.js';

/** 计算当前配置用于海报的简称。 */
export function posterShortName(config){
 if(config.posterFields?.subtitle===false)return '';
 return config.posterSubtitle??config.shortName??suggestedName(config,config.nameFormat||'compact');
}

// Explicit name changes resume name following without resetting poster styling.
/** 明确修改简称后清除旧副标题文字覆盖，让海报重新跟随配置简称。 */
export function syncPosterShortName(config){
 delete config.posterSubtitle;
 for(const styles of [config.textStyles,config.skuTextStyles]){
  if(styles?.['header.subtitle'])delete styles['header.subtitle'].text;
 }
}
