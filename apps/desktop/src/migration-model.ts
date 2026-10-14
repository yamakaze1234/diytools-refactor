/** 迁移审阅模型：统一配置名称、删除状态、路径校验、分组和分页。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LegacyConfig = { id: string; [key: string]: JsonValue };
export interface ImportedSummary { id: string; sourceLabel: string; configCount: number }
export interface ImportedDetail { id: string; revision: number; undoCount: number; state: { configs: LegacyConfig[]; [key: string]: JsonValue } }
export interface ImportPreview { token: string; sourceLabel: string; configCount: number; activeCount: number; shopCount: number; issues: string[] }
export interface ImportResult { workspaceId: string; alreadyImported: boolean }
export interface LinkGroup { key: string; label: string; configs: LegacyConfig[] }
export interface ShopGroup { key: string; label: string; links: LinkGroup[] }

export function textValue(value: JsonValue | undefined): string {
  if (value === undefined) return "未提供";
  if (value === null) return "null";
  return typeof value === "string" ? value || "（空字符串）" : typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function isDeleted(config: LegacyConfig): boolean { return Boolean(config.deletedAt); }
export function configName(config: LegacyConfig): string { return typeof config.name === "string" ? config.name : "（未命名配置）"; }
/** 校验迁移审阅中允许编辑的名称。 */
export function validName(name: string): boolean { return name.trim().length > 0 && Array.from(name).length <= 120; }
/** 确认导入包路径是本机绝对路径，防止相对路径产生歧义。 */
export function isAbsoluteBundlePath(path: string): boolean { return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/]|\/)/.test(path); }
/** 按链接身份整理迁移配置，供审阅界面分组显示。 */
export function groupConfigs(configs: LegacyConfig[]): ShopGroup[] {
  const shops = new Map<string, ShopGroup>();
  const linkMaps = new Map<string, Map<string, LinkGroup>>();
  for (const config of configs) {
    const shopKey = JSON.stringify([config.shopId === undefined ? "missing" : "value", config.shopId ?? null]);
    let shop = shops.get(shopKey);
    if (!shop) { shop = { key: shopKey, label: config.shopId === undefined ? "未提供店铺" : `店铺 ${textValue(config.shopId)}`, links: [] }; shops.set(shopKey, shop); linkMaps.set(shopKey, new Map()); }
    const missingSpu = config.spu === undefined || config.spu === null || config.spu === "";
    const linkIdentity = config.productId || `legacy:${String(config.spu || config.product || config.id)}`;
    const linkKey = JSON.stringify(linkIdentity);
    const productLabel = config.product ? textValue(config.product) : "未命名商品链接";
    const spuLabel = missingSpu ? "未绑定 SPU" : `SPU ${textValue(config.spu)}`;
    const links = linkMaps.get(shopKey)!;
    let link = links.get(linkKey);
    if (!link) { link = { key: linkKey, label: `${productLabel} · ${spuLabel} · 链接 ID ${textValue(linkIdentity)}`, configs: [] }; shop.links.push(link); links.set(linkKey, link); }
    link.configs.push(config);
  }
  return [...shops.values()];
}
/** 使用用户搜索词筛选待审阅配置。 */
export function filterConfigs(configs: LegacyConfig[], search: string): LegacyConfig[] {
  const query = search.trim().toLocaleLowerCase();
  return configs.filter(config => [configName(config), config.id, textValue(config.skuId), textValue(config.product)].some(value => value.toLocaleLowerCase().includes(query)));
}
export const PAGE_SIZE = 50;
/** 对大配置集合分页，只向页面提供当前页内容。 */
export function pageItems<T>(items: T[], page: number): T[] { return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE); }


