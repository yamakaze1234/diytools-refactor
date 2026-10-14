import {sameValue} from './workspace-ui-merge.js';

// 列表刷新只处理已载入的详情；未点击的配置仍然只有摘要，不扩大全量加载范围。
// 原始基线用于识别远端修改，规范化基线用于区分用户输入与默认字段补齐。
export function planCompactRefresh({base,local,normalizedBase,remote,prepared,metadataChanged,dirty,active,editing}){
 const before=new Map(base.map(row=>[row.id,row])),draft=new Map(local.map(row=>[row.id,row]));
 const normalized=new Map(normalizedBase.map(row=>[row.id,row])),latest=new Map(remote.map(row=>[row.id,row]));
 // 未经服务器确认的新建记录不属于本次远端快照，不能随列表刷新被丢弃。
 if(local.some(row=>!before.has(row.id)))return null;
 const changed=new Set(local.filter(row=>!sameValue(before.get(row.id),latest.get(row.id))).map(row=>row.id));
 // 来源/成本等公共资料变化可能改变当前配置的派生字段；有草稿时留给保存流程比较。
 if(dirty&&metadataChanged)return null;
 // 即使输入事件尚未触发，也不在聚焦输入框时替换当前编辑器（包括输入法组合阶段）。
 if(editing&&(metadataChanged||changed.has(active)))return null;
 for(const id of changed){
  if(dirty&&!sameValue(draft.get(id),normalized.get(id)))return null;
 }
 const configs=prepared.map(row=>!metadataChanged&&!changed.has(row.id)&&draft.has(row.id)?draft.get(row.id):row);
 return {configs,changed,keepEditor:!metadataChanged&&!changed.has(active)};
}

// 版本号和时间是同步标记，变化本身不意味着公共业务资料发生变化。
export function sameWorkspaceMetadata(before,after){
 const business=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['revision','updatedAt','logs','configs'].includes(key)));
 return sameValue(business(before),business(after));
}
