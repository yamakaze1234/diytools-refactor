/** 云同步基础协议：稳定序列化、实体身份校验及字段级三方合并。 */
import {validateAddon,sourceAddon} from './addon-data.js';
// 共享的记录比较与三方合并规则；客户端负责持久化、网络请求和重试。
// 协议 v1 中“缺字段”、null 与带 deletedAt 的墓碑是不同状态。
export const PROTOCOL_VERSION = 2;
export const clone = value => value === undefined ? undefined : structuredClone(value);
/** 将数据转为稳定的规范形式，保证等价对象可参与一致比较。 */
export function canonical(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const equal = (a, b) => canonical(a) === canonical(b);
export const recordKey = (type, id) => JSON.stringify([type, id]);
/** 比较共同基线、本地草稿和远端记录；不重叠修改合并，重叠字段返回冲突信息。 */
export function mergeRecord(base, local, remote) {
  // 返回合并值及冲突字段；同字段双方都改动时保留本地草稿并显式标冲突。
  if (equal(local, base)) return {value: clone(remote), fields: []};
  if (equal(remote, base) || equal(local, remote)) return {value: clone(local), fields: []};
  if (!base || !local || !remote || local.deletedAt !== base.deletedAt || remote.deletedAt !== base.deletedAt) {
    return {value: clone(local), fields: ['$record']};
  }
  const value = clone(remote), fields = [];
  // 数组（尤其 parts）按字段整体处理；同一数组的并发修改不逐配件自动合并。
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    if (equal(local[key], base[key])) continue;
    if (equal(remote[key], base[key]) || equal(local[key], remote[key])) {
      if (Object.hasOwn(local, key)) value[key] = clone(local[key]); else delete value[key];
    } else { fields.push(key); if (Object.hasOwn(local, key)) value[key] = clone(local[key]); else delete value[key]; }
  }
  return {value, fields};
}

const types=new Set(['configuration','component','source','template','settings','gallery','workspace_meta']);
export const safeInteger=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
/** 校验记录类型、ID 和数据形状，拒绝无法安全进入同步状态机的输入。 */
export function validateCloudRecord(type,id,data){
  if(!types.has(type)||typeof id!=='string'||!id||id.length>200||!data||typeof data!=='object'||Array.isArray(data))throw Error('云端记录格式无效');
  if(new TextEncoder().encode(JSON.stringify(data)).length>250000||Object.keys(data).some(k=>['__proto__','constructor','prototype'].includes(k)))throw Error('云端记录字段或大小无效');
  if(data.deletedAt!=null&&!Number.isFinite(Date.parse(data.deletedAt)))throw Error('云端删除时间无效');
  if(type==='configuration'){
    if(data.id!==id||!['intel','gigabyte','jonsbo'].includes(data.shopId)||!safeInteger(data.priceCents)||!Array.isArray(data.parts))throw Error('云端配置格式无效');
    if(data.actualParts!==undefined&&!Array.isArray(data.actualParts))throw Error('云端实际配置格式无效');
    for(const rows of [data.parts,...(data.actualParts!==undefined?[data.actualParts]:[])]){const seen=new Set();for(const p of rows){if(!p||typeof p.lineId!=='string'||!p.lineId||seen.has(p.lineId)||typeof p.goodsId!=='string'||!safeInteger(p.qty)||p.goodsId&&p.qty<1)throw Error('云端配件行格式无效');seen.add(p.lineId);}}
    for(const key of ['spu','skuId'])if(data[key]!==undefined&&typeof data[key]!=='string')throw Error('平台 ID 必须是字符串');
    for(const addon of data.addons||[])validateAddon(addon);
  }
  if(type==='component'&&(typeof data.goodsId!=='string'||!/^\d{1,20}$/.test(data.goodsId)||typeof data.erpScopeId!=='string'||!data.erpScopeId||id!==data.erpScopeId+'|'+data.goodsId||data.taxCents!==null&&!safeInteger(data.taxCents)))throw Error('云端共享成本格式无效');
  if(type==='source'&&(data.sourceId!==id||typeof data.goodsId!=='string'||!['intel','gigabyte','jonsbo'].includes(data.shopId)))throw Error('云端输出源格式无效');
  if(type==='source')validateAddon(sourceAddon(data));
  if(type==='settings'&&(!['intel','gigabyte','jonsbo'].includes(id)||!safeInteger(data.couponCents)))throw Error('云端店设置格式无效');
  if(['template','gallery'].includes(type)&&data.id!==id)throw Error('云端记录 ID 不一致');
  if(type==='workspace_meta'&&(id!=='root'||data.format!==2))throw Error('云端工作区标记无效');
  return data;
}
