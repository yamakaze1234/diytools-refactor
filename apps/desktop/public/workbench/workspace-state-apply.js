/** 工作区载入准备：按统一顺序完成店铺、模板、实际配件和来源跟随兼容。 */
import {normalizeWorkspaceStateAsync} from './shops.js';
import {sourceCatalog,bindSources,alignDisplaySourceNames} from './source.js';
import {costRows} from './erp-sync.js';
import {normalizeProducts} from './core.js';
import {createSourceIndex} from './component-index.js';
import {finishStateWorkAsync,yieldStateWork} from './state-work.js';

// Prepare away from the live draft. The caller checks its edit counter again
// before applying; input during normalization must never be overwritten.
/** 将接口状态准备为可编辑状态，允许调用方提供分片调度选项。 */
export async function prepareWorkspaceState(input,baseCatalog=[],options={}){
 const state=await normalizeWorkspaceStateAsync(input,baseCatalog,options),yieldWork=options.yieldWork||yieldStateWork;
 const catalog=sourceCatalog(state.sourceCatalog);await yieldWork();
 state.costSource=costRows(catalog,state.costSource||[]);await yieldWork();
 const sourceIndex=createSourceIndex(catalog);
 function* bind(){
  // Reuse an index within a small chunk without scanning every source per row.
  for(let index=0;index<state.configs.length;index+=32){
   const rows=state.configs.slice(index,index+32);
   bindSources(rows,catalog,sourceIndex);alignDisplaySourceNames(rows,catalog,sourceIndex);normalizeProducts(rows);yield;
  }
 }
 await finishStateWorkAsync(bind(),options);
 return {state,catalog};
}
