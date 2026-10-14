/** 特殊配件占位规则：识别无独显等预设项，统一其成本与 ERP 绑定语义。 */
export const specialComponentNames=[
 '不含显卡，可咨询客服加装独显使用',
 '支持一对一直播装机 从无到有尽收眼底 包装全保留',
 '全新Intel ARC Xe核显 支持8K 60HZ视频输出',
 '支持DIY升级改配 联系客服核算差价',
 'intel UHD770 超核心显卡'
];
/** 判断配件是否属于内置特殊项，供核算和导出跳过普通商品校验。 */
export const isSpecialComponent=row=>row?.specialComponent===true;
/** 规范特殊项的固定字段，避免混入普通商品的成本缓存。 */
export function normalizeSpecialComponent(row){
 if(!isSpecialComponent(row))return row;
 return {...row,goodsId:'',erp:0,tax:0,erpUnknown:false,erpMissing:false,erpName:'',stockAvailable:null,stockUpdatedAt:null,stockSource:null,erpUpdatedAt:null};
}
// Defaults are virtual until edited, so an empty new workspace can still receive cloud data.
/** 为店铺候选列表补入可选择的特殊配件。 */
export function withSpecialPresets(rows,shopId){
 const ids=new Set(rows.map(r=>r.sourceId));
 return [...rows,...specialComponentNames.map((name,i)=>normalizeSpecialComponent({sourceId:`special:${shopId}:${i+1}`,shopId,specialComponent:true,goodsId:'',name,originalName:name,upgrade:'',addonText:'',addonNote:''})).filter(r=>!ids.has(r.sourceId))];
}
