/** 云共享字段边界：排除本机 ERP 库存及派生数据，并过滤旧 ERP 快照记录类型。 */
export const localErpFields=['erp','stockAvailable','stockUpdatedAt','stockSource','erpUpdatedAt','erpImportedAt','erpMissing','erpUnknown','erpName','localInventoryOnly'];
const fields=new Set(localErpFields);
/** 排除旧 ERP 分块与快照类型；其余记录仍须经过协议层校验。 */
export const keepCloudType=type=>!['erp_chunk','erp_snapshot'].includes(type);
/** 递归剔除仅应留在本机的 ERP 字段，供投影和协议校验复用。 */
export function stripLocalErp(value){
 if(Array.isArray(value))return value.map(stripLocalErp);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!fields.has(key)).map(([key,v])=>[key,stripLocalErp(v)]));
}
export const localErpPolicy={keep:keepCloudType,clean:stripLocalErp};
