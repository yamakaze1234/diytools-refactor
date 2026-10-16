import {suggestedName} from './legacy-names.js';

// Navigation uses format two without overwriting saved names or versions.
export function configurationHardwareSummary(config){
 return suggestedName({...config,name:'',version:''},'compact').replace(/^配置：/,'');
}
export function configurationSummaryText(config){
 return configurationHardwareSummary(config).replaceAll('+','\u200b＋');
}
export function configurationSummaryHtml(config,esc){
 const text=configurationHardwareSummary(config);
 return `<small class="config-hardware-summary" title="${esc(text)}" aria-label="CPU、显卡、内存、硬盘：${esc(text)}">${esc(configurationSummaryText(config))}</small>`;
}
