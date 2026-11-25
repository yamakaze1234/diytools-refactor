/** 勾选配置只读取已保存实际配件；价格表不持久化或自动查询 ERP 匹配状态。 */
import {isSpecialComponent} from './special-components.js';
import {shopErpExtras} from './erp-default-extras.js';
export function matchingSnapshot(config,settings,{version=null,costs=[]}={}){
 const shopId=String(settings.erpShopId||{intel:'76',gigabyte:'32',jonsbo:'33'}[config.shopId]||'');
 if(!['76','32','33'].includes(shopId))throw Error('请核对 ERP 店铺 ID（76 / 32 / 33）。');
 for(const [label,value] of [['SPU',config.spu],['SKU',config.skuId]])if(!/^\d{1,24}$/.test(value??''))throw Error(`${config.name} 的 ${label} 无效，请先保存正确编号。`);
 const index=new Map(costs.map(row=>[String(row.goodsId),row]));
 const actualParts=(config.actualParts??[]).map(part=>({goodsId:String(part.goodsId??''),qty:Number(part.qty),name:part.name??'',erpName:index.get(String(part.goodsId))?.name||part.erpName||part.name||'',special:isSpecialComponent(part)}));
 const shipped=actualParts.filter(p=>!p.special&&!p.erpName.includes('【写配置用/不会出货】'));
 if(!shipped.length)throw Error(`${config.name} 排除特殊件后没有实际出货配件。`);
 for(const part of shipped)if(!/^[1-9]\d{0,19}$/.test(part.goodsId)||!Number.isSafeInteger(part.qty)||part.qty<1)throw Error(`${config.name} 的出货配件 GoodID 或数量无效。`);
 return {configId:config.id,localShopId:config.shopId,shopId,spu:config.spu,sku:config.skuId,name:config.shortName||config.name,saved:true,savedVersion:version,
  actualParts,extras:shopErpExtras(config.shopId,settings)};
}
export const matchingStamp=items=>JSON.stringify(items);

export async function erpMatchingRequest(input){
 if(window.workbenchErpRequest){try{return await window.workbenchErpRequest(input);}catch(error){throw error instanceof Error?error:Error(typeof error==='string'?error:'本机 ERP 请求未完成。');}}
 // 浏览器验收使用同一协议的 mock 路由；正式客户端由上方原生桥接固定 worker。
 const response=await fetch('/api/erp-matching',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok||result.ok===false)throw Error(result.error?.message||result.error||'本机 ERP 请求未完成。');return result.result??result;
}
