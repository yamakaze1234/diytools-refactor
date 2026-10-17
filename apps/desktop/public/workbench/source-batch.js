/** 输出源批量保存规则：统一处理来源修改及依赖配置的跟随更新。 */
import {shops} from './shops.js';
import {createConfigPartIndex} from './component-index.js';
import {followSourceChanges} from './source-follow.js';

// 批量输出源维护先在深拷贝上校验和更新，返回 next 供调用方保存；失败不修改传入的 state。
// 展示名称属于各店输出源，ERP 成本按 goodsId 跨店共用，核算价交由 applyManualCosts 统一更新。
import {clone} from './core.js';
import {sourceAddon,sourceAddonFields,validateAddon} from './addon-data.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';
import {excludedComponent} from './component-policy.js';
import {costRows,applyManualCosts} from './erp-sync.js';

const fields=['goodsId','name','tax','upgrade','specialComponent','addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems','addonOriginalQty','addonVariants','addonShowTogether','addonChoices'];
const view=row=>row?{...row,...sourceAddonFields(sourceAddon(row)),specialComponent:isSpecialComponent(row)}:null;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// 先完整构建批次；过期预览或无效记录使整批失败，不留下部分编辑。
/** 以同一时间点应用来源变更并汇总关联影响，供批量保存使用。 */
export function sourceBatch(state,changes,at=new Date().toISOString()){
 let skipped=0;const expanded=[];
 for(const change of changes){
  expanded.push(change);
  if(change.before||!change.targetShopIds)continue;
  for(const shopId of new Set(change.targetShopIds)){
   if(!shops.some(shop=>shop.id===shopId))throw Error('新增店铺无效');
   if(shopId===change.row.shopId)continue;
   const row={...clone(change.row),shopId,sourceId:change.row.sourceId+':'+shopId};
   const exists=[...state.sourceCatalog,...expanded.map(item=>item.row)].some(item=>item.shopId===shopId&&(isSpecialComponent(row)?isSpecialComponent(item)&&item.name===row.name:item.goodsId===row.goodsId));
   if(exists){skipped++;continue;}
   expanded.push({before:null,row});
  }
 }
 changes=expanded;
 const next=clone(state),seen=new Set(),taxes=new Map();
 for(const change of changes){
  const row=normalizeSpecialComponent(clone(change.row)),before=view(change.before);
  if(!row.sourceId||seen.has(row.sourceId))throw Error('输出源修改重复或缺少标识');
  seen.add(row.sourceId);
  const index=next.sourceCatalog.findIndex(r=>r.sourceId===row.sourceId),live=index<0?null:next.sourceCatalog[index];
  if(live?.deletedAt||live&&live.shopId!==row.shopId)throw Error('输出源已删除或店铺已变化，请重新打开后修改');
  if(!row.name?.trim())throw Error('请填写产品显示名称');
  if(excludedComponent(row)||next.costSource.some(r=>r.goodsId===row.goodsId&&excludedComponent(r)))throw Error('带 * 标记的配件不可加入输出源');
  if(!isSpecialComponent(row)){
   if(!/^\d+$/.test(row.goodsId))throw Error('请填写准确的数字 ERP ID');
   if(row.tax!==null&&(!Number.isFinite(row.tax)||row.tax<0||Math.abs(row.tax*100-Math.round(row.tax*100))>1e-6))throw Error('核算单价须为非负金额，最多两位小数');
   validateAddon(sourceAddon(row),{required:!!row.addonText?.trim(),costs:next.costSource});
   if(index<0&&next.sourceCatalog.some(r=>r.shopId===row.shopId&&r.goodsId===row.goodsId))throw Error('该店铺 ERP ID 已存在，请编辑已有记录');
  }
  const desired=view(row),current=view(live),patch={};
  if(current&&!isSpecialComponent(live))current.tax=next.costSource.find(r=>r.goodsId===live.goodsId)?.tax??live.tax;
  for(const key of fields){
   if(before&&equal(before[key],desired[key]))continue;
   if(current&&!equal(current[key],before?.[key])&&!equal(current[key],desired[key]))throw Error(`“${row.name}”已被更新，请保留草稿并重新核对`);
   patch[key]=clone(desired[key]);
  }
  if(!live&&before&&!isSpecialComponent(row))throw Error('输出源已不存在，请重新核对');
  const saved=normalizeSpecialComponent({...clone(live||row),...patch,updatedAt:at});
  if(!isSpecialComponent(row)&&(!before||!equal(before.tax,desired.tax))){
   if(taxes.has(row.goodsId)&&taxes.get(row.goodsId)!==row.tax)throw Error('同一 ERP ID 的共用核算价不一致');
   taxes.set(row.goodsId,row.tax);saved.taxUpdatedAt=at;
  }
  if(index<0)next.sourceCatalog.push(saved);else next.sourceCatalog[index]=saved;
 }
 next.costSource=costRows(next.sourceCatalog,next.costSource||[]);
 const erpIds=new Set();
 // ERP goodsId 在三店共用；仅在本批含 ERP 刷新时建反向引用，避免逐条重扫全部配置。
 let partIndex;
 for(const {row,before} of changes){
  if(isSpecialComponent(row)||!row.erpUpdatedAt||row.erpUpdatedAt===before?.erpUpdatedAt)continue;
  if(!Number.isFinite(Date.parse(row.erpUpdatedAt))||row.erp!==null&&(!Number.isFinite(row.erp)||row.erp<0))throw Error('ERP 查询价格或时间无效，请重新查询');
  const cost=next.costSource.find(r=>r.goodsId===row.goodsId);
  if(cost?.erpUpdatedAt&&Date.parse(cost.erpUpdatedAt)>Date.parse(row.erpUpdatedAt))continue;
  const values={erp:row.erp,erpName:row.erpName,erpUpdatedAt:row.erpUpdatedAt,erpUnknown:row.erp==null,erpMissing:false};
  if(cost)Object.assign(cost,values,{name:row.erpName||cost.name});
  for(const source of next.sourceCatalog)if(source.goodsId===row.goodsId)Object.assign(source,values);
  partIndex??=createConfigPartIndex(next.configs.filter(config=>!config.deletedAt),{includeSources:false});
  const updatedParts=new Set();
  for(const {config,part} of partIndex.byGoodsIdAny(row.goodsId)){
   if(config.deletedAt||isSpecialComponent(part))continue;
   if(!updatedParts.has(part)){Object.assign(part,values);updatedParts.add(part);}
   erpIds.add(config.id);
  }
 }
 const configIds=taxes.size?applyManualCosts(next,[...taxes].map(([goodsId,tax])=>({goodsId,tax})),at):[];
 const followed=followSourceChanges(next.configs,state.sourceCatalog,next.sourceCatalog,{captureChanges:true});
 return {next,configIds:[...new Set([...configIds,...erpIds,...followed.configIds])],autoUpdatedFields:followed.count,autoChanges:followed.autoChanges,count:changes.length,skipped};
}
