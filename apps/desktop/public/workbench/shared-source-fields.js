/** 共用目录只维护人工字段，ERP 实时报价、库存及旧配置引用仍使用原有记录。 */
import {copyHardware} from './component-hardware.js';
import {copyCapacity} from './component-capacity.js';
import {effectiveNasAddons,selectedSourceAddons} from './addon-data.js';
export const sharedSourceAddonKeys = [
 'addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems',
 'addonOriginalQty','addonVariants','addonShowTogether','addonChoices','addonMode',
];
export const sharedSourceLabels = {
 name:'显示名称', tax:'含税核算单价', addon:'多选加购',
 'capacityOverrides.memoryGb':'内存容量', 'capacityOverrides.vramGb':'显存容量', 'capacityOverrides.storageGb':'硬盘容量',
 'hardwareOverrides.cpuName':'CPU 简称', 'hardwareOverrides.gpuName':'显卡简称',
 'hardwareOverrides.boardType':'主板板型', 'hardwareOverrides.caseBoards':'机箱支持板型',
};
export const sharedSourceKeys = Object.keys(sharedSourceLabels);
export const sourceGoodsId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export const sharedSpecialKey = value => typeof value === 'string' && /^special:[0-9a-f-]{32,36}$/.test(value);

export function sourceFields(row) {
 const fields = {
  name: row.name || null,
  tax: row.tax ?? null,
  addon: Object.fromEntries(sharedSourceAddonKeys.flatMap(key => row[key] == null || row[key] === '' ? [] : [[key, row[key]]])),
 };
 for (const key of sharedSourceKeys.slice(3)) {
  const [group, field] = key.split('.');
  fields[key] = row[group]?.[field] ?? null;
 }
 return fields;
}

/** 用所选范围的人工字段构造表单值，缺失的共用字段显示为空。 */
export function withSourceFields(row, fields) {
 const next = {...row, name: fields.name ?? '', tax: fields.tax ?? null};
 for (const key of sharedSourceAddonKeys) delete next[key];
 Object.assign(next, fields.addon ?? {});
 for (const group of ['capacityOverrides','hardwareOverrides']) {
  const entries = sharedSourceKeys.filter(key => key.startsWith(group + '.') && fields[key] != null);
  next[group] = entries.length ? Object.fromEntries(entries.map(key => [key.split('.')[1], fields[key]])) : undefined;
 }
 return next;
}

/** 只刷新已明确跟随来源的展示资料，配置写入仍使用工作台原有草稿投影。 */
export function withCurrentSharedSource(config,byId) {
 config.addons=effectiveNasAddons(config.addons,byId,config.parts).map(row=>row.addon);
 for (const part of [...config.parts,...config.actualParts]) {
  const source = byId.get(part.sourceId);
  if (!source?.sharedSourceId || source.deletedAt || source.goodsId!==part.goodsId) continue;
  copyCapacity(source,part);
  copyHardware(source,part);
  const follow = part.sourceFollow;
  if (follow?.sourceId!==source.sourceId) continue;
  if (follow.name?.mode==='follow' && follow.name.value===(part.displayName||part.name)) {
   part.name=source.name;
   delete part.displayName;
   follow.name={mode:'follow',value:source.name,sourceValue:source.name};
  }
  if (follow.upgrade?.mode==='follow' && follow.upgrade.value===(part.upgrade??'')) {
   // 总表统一的是展示文案，选配商品及计价规则保持原样；显式文案跟随直接读取来源 addonText。
   const textOnly=follow.upgrade.textOnly===true;
   const text = textOnly?String(source.addonText??''):selectedSourceAddons(source,config.addons.filter(addon=>addon.sourceId===part.sourceId))
    .map(addon=>addon.text?.trim()).filter(Boolean).join('');
   // 没有维护加购的历史来源仍允许原配置展示自己的说明。
   if (text || source.addonChoices!==undefined || textOnly) {
    part.upgrade=text;
   follow.upgrade={mode:'follow',value:text,sourceValue:text,...(textOnly?{textOnly:true}:{}),...(follow.upgrade.structured===true?{structured:true}:{})};
   }
  }
 }
 return config;
}
