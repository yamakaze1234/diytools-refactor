/** 独立配置编辑页的数据转换：在可编辑字符串和以分保存的金额之间转换。 */
export interface Part { id: string; category: string; name: string; quantity: number; unitCostCents: number }
export interface Config { id: string; name: string; salePriceCents: number; revision: number; actualParts: Part[] }
export interface Summary { id: string; name: string; salePriceCents: number; revision: number }
export interface Detail { config: Config; undoCount: number }
export interface DraftPart { id: string; category: string; name: string; quantity: string; unitCost: string }
export interface Draft { name: string; salePrice: string; actualParts: DraftPart[] }

export const money = (cents: number) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 从配置创建表单草稿，避免直接修改已载入基线。 */
export const toDraft = (config: Config): Draft => ({ name: config.name, salePrice: (config.salePriceCents / 100).toFixed(2), actualParts: config.actualParts.map(p => ({ id: p.id, category: p.category, name: p.name, quantity: String(p.quantity), unitCost: (p.unitCostCents / 100).toFixed(2) })) });
/** 验证金额输入并转成整数分，避免浮点金额直接进入保存协议。 */
export function parseCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("金额需要为非负数，最多保留两位小数。");
  const [whole, decimal = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 1_000_000_000) throw new Error("金额不能超过 1000 万元。");
  return result;
}
/** 校验表单字段并在原配置基础上构造保存内容。 */
export function fromDraft(draft: Draft, baseline: Config): Config {
  if (!draft.name.trim() || draft.name.trim().length > 120) throw new Error("请填写 1–120 个字符的配置名称。");
  return { ...baseline, name: draft.name.trim(), salePriceCents: parseCents(draft.salePrice), actualParts: draft.actualParts.map(p => {
    if (!p.name.trim() || !p.category.trim()) throw new Error("请填写每行配件的类别和名称。");
    if (!/^\d+$/.test(p.quantity) || Number(p.quantity) < 1 || Number(p.quantity) > 999) throw new Error("配件数量需要是 1–999 的整数。");
    return { id: p.id, category: p.category.trim(), name: p.name.trim(), quantity: Number(p.quantity), unitCostCents: parseCents(p.unitCost) };
  }) };
}

// 仅用于浏览器只读外观预览，不参与桌面数据初始化或保存。
export const preview: Detail = { undoCount: 0, config: { id: "preview", name: "办公配置 · 样本预览", salePriceCents: 299900, revision: 1, actualParts: [
  {id:"cpu",category:"CPU",name:"示例处理器",quantity:1,unitCostCents:80000},
  {id:"board",category:"主板",name:"示例主板",quantity:1,unitCostCents:50000},
  {id:"ram",category:"内存",name:"示例内存 16GB",quantity:2,unitCostCents:20000},
  {id:"ssd",category:"硬盘",name:"示例固态 1TB",quantity:1,unitCostCents:35000},
  {id:"case",category:"机箱",name:"示例机箱",quantity:1,unitCostCents:20000},
  {id:"psu",category:"电源",name:"示例电源",quantity:1,unitCostCents:25000},
] } };
