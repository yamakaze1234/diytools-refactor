import {Fault,requireValue} from './config.mjs';
import {moneyCents,productInstallment} from '../../../apps/desktop/public/workbench/pricing.js';
import {trackedProfit} from '../../../apps/desktop/public/workbench/price-changes.js';

const effective=(part,row)=>row?{...part,
 // 与实际 BOM 的核算规则一致：配置独立价优先于店铺成本。
 ...(row.nasTaxOverride&&!(part.taxOverride?.goodsId===part.goodsId&&Number.isFinite(part.taxOverride.value))?{tax:row.tax}:{}),
 ...(row.nasErpOverride?{erp:row.erp,erpMissing:row.erpMissing,erpUnknown:row.erpUnknown}:{})}:part;
const priceRow=row=>({tax:moneyCents(row?.tax),erp:row?.erpMissing===true||row?.erpUnknown===true?null:moneyCents(row?.erp)});
const compact=(c,parts,settings,linkConfigs)=>({id:c.id,shopId:c.shopId,productId:c.productId,product:c.product,name:c.name,productUrl:c.productUrl,price:c.price,
 loggedProfit:trackedProfit({...c,actualParts:parts},{...settings,linkInstallment:productInstallment(linkConfigs.filter(row=>row.productId===c.productId))})});
export const priceHistoryCurrent=({configs,linkConfigs,settings,costs})=>configs.map(c=>
 compact(c,(c.actualParts??c.parts??[]).map(part=>effective(part,costs.get(part.goodsId))),settings,linkConfigs));

/** 从成本写入前后和同事务已保存实际 BOM 得到历史值，不从现时零售价反推旧利润。 */
export function priceHistorySnapshot({changes,configs,linkConfigs,settings,costs}){
 const items=new Map();
 for(const [goodsId,{before,after}] of changes){
  const b=priceRow(before),a=priceRow(after);
  if(b.tax!==a.tax||b.erp!==a.erp)items.set(goodsId,{goodsId,name:after.name||before?.name||goodsId,before:b,after:a,slots:[],configIds:[]});
 }
 const snapshots=[];
 for(const c of configs){
  const parts=c.actualParts??c.parts??[],hit=parts.filter(part=>items.has(part.goodsId));
  if(!hit.length)continue;
  for(const part of hit){
   const item=items.get(part.goodsId);
   if(part.slot&&!item.slots.includes(part.slot))item.slots.push(part.slot);
   if(!item.configIds.includes(c.id))item.configIds.push(c.id);
  }
  const snapshot=phase=>compact(c,parts.map(part=>effective(part,changes.has(part.goodsId)?changes.get(part.goodsId)[phase]:costs.get(part.goodsId))),settings,linkConfigs);
  snapshots.push({before:snapshot('before'),after:snapshot('after')});
 }
 return {items:[...items.values()],configs:snapshots};
}

export async function priceHistoryAction(db,action,args){
 try{
  const {rows:[row]}=await db.query('SELECT intel_live.operations_price_history($1,$2::jsonb) AS data',[action,JSON.stringify(args)]);
  requireValue(row?.data&&!row.data.missing,'NOT_FOUND',404);return row.data;
 }catch(error){
  if(error.code==='42883')throw new Fault('NAS_PRICE_HISTORY_NOT_INSTALLED',503);
  throw error;
 }
}
