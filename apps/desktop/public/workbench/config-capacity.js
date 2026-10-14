/** 店铺配置数量限制：新建和批量导入共用容量提示与最终校验。 */
// Each shop has an independent quota; recoverable deleted rows do not consume it.
export const MAX_CONFIGS_PER_SHOP=8000;
/** 结合当前店铺配置量和拟新增数量返回容量提示。 */
export function configCapacityMessage(configs,shopId,added=0){
 const count=configs.filter(c=>!c.deletedAt&&(c.shopId||'intel')===shopId).length;
 return count+added>MAX_CONFIGS_PER_SHOP?`本店最多保存 ${MAX_CONFIGS_PER_SHOP} 套在用配置（当前 ${count} 套，本次新增 ${added} 套）`:'';
}
/** 检查各店铺配置规模，阻止超过容量约束的状态进入保存。 */
export function validateConfigCapacity(configs){
 for(const shopId of new Set(configs.map(c=>c.shopId||'intel'))){const message=configCapacityMessage(configs,shopId);if(message)throw Error(message);}
 return true;
}
