import {isSpecialComponent} from './special-components.js';

/** 将店铺有效成本应用到配件副本，供总表、草稿提交和 NAS 历史利润共用。 */
export function applyNasPartCost(part,row,erpOnly=false){
 if(!row||!part.goodsId||isSpecialComponent(part))return part;
 // 有同步标记时可明确清空旧价；历史成本没有标记时只采纳有效数值，零也是有效成本。
 if(row.nasErpOverride||Number.isFinite(row.erp)&&row.erp>=0){
  part.erp=row.erp??null;
  part.erpMissing=!row.nasErpOverride&&row.erpMissing===true;
  part.erpUnknown=part.erp===null||(!row.nasErpOverride&&row.erpUnknown===true);
 }
 if(!erpOnly&&row.nasTaxOverride&&!(part.taxOverride?.goodsId===part.goodsId&&Number.isFinite(part.taxOverride.value)))
  part.tax=row.tax;
 return part;
}
