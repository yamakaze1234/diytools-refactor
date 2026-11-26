import {sourceFields} from './shared-source-fields.js';
import {sameNasDocument} from './nas-main-workspace.js';

/** 共用值与单店恢复都可能改变本店加购；仅改名称或外店独享值的草稿不触发决策窗。 */
export function editsShopAddons(change,shop){
 if(change.managed)return ['shared',shop].some(scope=>{
  const edit=change.managed.edits[scope];
  return Object.hasOwn(edit?.values??{},'addon')||edit?.restore?.includes('addon');
 });
 return (change.row.shopId||'intel')===shop&&!sameNasDocument(sourceFields(change.before??{}).addon,sourceFields(change.row).addon);
}

/** 比较保存前后当前店的有效升级项。共用来源的本店覆盖或历史别名需逐条核对。 */
export function changedAddonSources(before,after){
 const previous=new Map(before.map(row=>[row.sourceId,sourceFields(row).addon]));
 return after.filter(row=>!row.deletedAt&&!sameNasDocument(previous.get(row.sourceId)??{},sourceFields(row).addon));
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
