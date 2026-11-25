// 内置项只在店铺首次使用或手动恢复时生成，每次返回独立表单数据。
const commonExtras=[
 ['29369','装机服务-主订单'],['131060','十字强磁螺丝刀'],['7031','技嘉 AORUS 鼠标垫']
];
const networkCable=['56020','3米千兆网线'];
const defaultItems={
 intel:[...commonExtras,networkCable,['50681','力镁 T25 背光键鼠(黑色)']],
 gigabyte:[...commonExtras,networkCable,['186552','傲器 AMG100 机械键盘+游戏鼠标(套装)'],['46383','电脑长条音箱 款式随机(音响/USB有线/3.5接口)']],
 jonsbo:commonExtras
};
export function defaultErpExtrasForShop(shopId){
 const key=({76:'intel',32:'gigabyte',33:'jonsbo'})[shopId]??shopId;
 return (Object.hasOwn(defaultItems,key)?defaultItems[key]:[]).map(([goodsId,name])=>({goodsId,name,qty:1}));
}
export function shopErpExtras(shopId,settings){
 return settings.erpDefaultExtras===undefined?defaultErpExtrasForShop(shopId):normalizeErpDefaultExtras(settings.erpDefaultExtras);
}
/** 每店固定附加只保存通用商品身份；相同 GoodID 合并，不包含机箱条件规则。 */
export function normalizeErpDefaultExtras(value){
 if(!Array.isArray(value)||value.length>200)throw Error('ERP 固定附加必须为不超过 200 项的数组。');
 const rows=new Map();
 for(const item of value){
  if(!item||typeof item!=='object'||!['string','number'].includes(typeof item.goodsId)||typeof item.goodsId==='number'&&!Number.isSafeInteger(item.goodsId))throw Error('固定附加 GoodID 必须为正整数。');
  const id=String(item.goodsId);if(!/^[1-9]\d{0,19}$/.test(id))throw Error('固定附加 GoodID 必须为正整数。');
  if(!Number.isSafeInteger(item.qty)||item.qty<1||item.qty>1000000)throw Error('固定附加数量必须为正整数。');
  if(typeof item.name!=='string'||!item.name.trim()||item.name.length>200||/[\x00-\x1f\x7f]/.test(item.name))throw Error('固定附加 ERP 配件名称无效。');
  const row=rows.get(id)||{goodsId:id,name:item.name.trim(),qty:0};row.qty+=item.qty;if(row.qty>1000000)throw Error('固定附加合并数量超过允许范围。');rows.set(id,row);
 }
 return [...rows.values()];
}
