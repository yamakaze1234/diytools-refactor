import {sourceExportEntries} from './source-sync-data.js';
import {startImageExportTask} from './image-export-tasks.js';

/** 两种弹窗使用相同的图片范围与版式。这些选择仅作用于本次导出快照。 */
export function exportOptionsHtml({prompt=false,count=0}={}){
 const long=prompt?'prompt-exp-long':'diff-exp-long',square=prompt?'prompt-exp-square':'diff-exp-square';
 return `<div class="sd-image-types">${prompt?'<span>导出图型</span>':''}<label><input id="${long}" data-layout="long" type="checkbox" checked>配置图</label><label><input id="${square}" data-layout="square" type="checkbox" checked>SKU 图</label></div>
 <div class="sd-select-pair"><label>${prompt?'<span>导出范围</span>':''}<select id="${prompt?'prompt-export-scope':'source-export-scope'}" data-export-scope aria-label="导出范围"><option value="changed">${prompt?'仅本次更新的 '+count+' 套配置':'仅已选变动配置'}</option><option value="all">相关链接全部配置</option></select></label>
 <label>${prompt?'<span>SKU 图样式</span>':''}<select id="${prompt?'prompt-sku-mode':'source-sku-mode'}" data-sku-mode aria-label="SKU 图样式"><option value="saved">${prompt?'按配置样式（默认补白 1:1）':'SKU：按配置'}</option><option value="padded">统一补白至 1:1</option><option value="dedicated">统一专用 SKU 缩略图</option></select></label></div>`;
}

export function readExportOptions(root){
 return {
  layouts:[...root.querySelectorAll('[data-layout]:checked')].map(el=>el.dataset.layout),
  skuMode:root.querySelector('[data-sku-mode]').value,
  scope:root.querySelector('[data-export-scope]').value
 };
}

/** 单独导图只读当前配置。范围为全链接时先由工作区加载同链接全部配置。 */
export async function exportSourceImages(api,changes,shopId,{layouts,skuMode,scope},status){
 const configs=await api.prepareExport?.(changes,scope,shopId)??api.getConfigs();
 const entries=sourceExportEntries(configs,changes,shopId,scope,skuMode,layouts);
 const task=startImageExportTask({entries,name:`本店输出源更新图片_${Date.now()}`,title:'输出源配置导图',
  renderImage:api.renderImage,saveFolder:api.saveFolder,download:api.download,status});
 return task.done;
}
