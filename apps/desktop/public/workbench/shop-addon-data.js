/** 跨店加购数据规则：生成店铺对应行并核验各店加购修改。 */
import {sourceAddon,sourceAddonFields,validateAddon} from './addon-data.js';
/** 将原始加购项映射到店铺行，供界面逐店编辑。 */
export function shopAddonRows(rows,original,shops){return shops.map(shop=>{const matches=rows.filter(r=>!r.deletedAt&&r.shopId===shop.id&&r.goodsId===original.goodsId);const row=shop.id===original.shopId?original:matches.length===1?matches[0]:null;return {shop,row,reason:matches.length>1?'本店存在多个同 ID 输出源，请先核对':'本店暂无此配件输出源'};});}
/** 检查店铺目标、修改项和成本资料的一致性。 */
export function validateShopAddonChanges(rows,changes,costs){
 const seen=new Set();return changes.map(change=>{if(seen.has(change.sourceId))throw Error('重复的店铺加购修改');seen.add(change.sourceId);const row=rows.find(r=>r.sourceId===change.sourceId&&!r.deletedAt);if(!row||row.shopId!==change.shopId||JSON.stringify(sourceAddonFields(sourceAddon(row)))!==JSON.stringify(change.before))throw Error('店铺加购已变化，请重置后重新修改');const addon={...sourceAddon(row),...change.addon};validateAddon(addon,{required:!!addon.text.trim(),costs});return {row,fields:sourceAddonFields(addon)};});
}
