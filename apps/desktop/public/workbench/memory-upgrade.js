/** 判断配件升级描述是否表示内存容量翻倍。 */
/** 内存升级文案规则：集中识别翻倍升级及海报展示内容。 */
export const doubleMemoryUpgrade=p=>p?.slot==='内存'&&Number(p.qty)===2&&/[＊*×]\s*2(?!\d)/.test(p.upgrade||'');
export const memoryUpgradeKey=p=>JSON.stringify([p.sourceId||'',p.goodsId||'',p.upgrade||'']);
/** 返回该配件需要对外展示的升级文案。 */
export const displayUpgrade=p=>doubleMemoryUpgrade(p)&&p.memoryUpgradeConfirmed!==memoryUpgradeKey(p)?'':p.upgrade||'';
