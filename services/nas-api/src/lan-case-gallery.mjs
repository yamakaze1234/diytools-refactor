import {createHash} from 'node:crypto';
import {requireValue} from './config.mjs';

const fields = ['brand', 'model', 'color', 'edition'];
const defaults = ['待分类', '待分类', '待分类', '通用'];
const allowedParams = new Set([...fields, 'q', 'view', 'limit', 'cursor']);
const collator = new Intl.Collator('zh-CN', {numeric: true});

// 只查询各运行区当前可用的图库，不读取配置图片、任意文档字段或已归档资料。
const activeGallery = `FROM intel_live.gallery g JOIN intel_live.assets a USING (legacy_uri)
 WHERE (g.owner_shop=$1 OR g.owner_shop='shared' OR g.shared) AND g.attrs->>'deletedAt' IS NULL`;

function categoryGroups(items, depth = 0) {
 const groups = Map.groupBy(items, item => item.categoryPath[depth]);
 const field = fields[depth];
 return [...groups.keys()].sort(collator.compare).map(label => {
  if (field === 'edition') return label;
  return {[field]: label, [fields[depth + 1] + 's']: categoryGroups(groups.get(label), depth + 1)};
 });
}

function publicImage(row) {
 const labels = fields.map(field => row[field].trim());
 const categoryPath = labels.map((label, i) => label || defaults[i]);
 // 同一分类下的同一原图跨店合并。同一分类里的不同原图全部保留。
 const id = createHash('sha256').update(JSON.stringify([...categoryPath, row.sha256, row.extension])).digest('hex');
 const downloadUrl = '/case-gallery/v1/download/' + row.sha256 + '.' + row.extension;
 return {id, name: row.name || categoryPath.join(' '), brand: labels[0], model: labels[1],
  color: labels[2], edition: labels[3], categoryPath, downloadUrl};
}

export function createLanCaseGallery(databases) {
 const shops = [...databases];
 return {
  async list(params) {
   for (const key of params.keys()) {
    const value = params.get(key);
    requireValue(allowedParams.has(key) && params.getAll(key).length === 1 && value.length <= 160 &&
     !/[\u0000-\u001f\u007f]/.test(value));
   }
   const view = params.get('view') ?? 'images', limit = params.get('limit') ?? '100', cursor = params.get('cursor');
   requireValue(['images', 'categories'].includes(view) && /^(?:[1-9][0-9]?|100)$/.test(limit) &&
    (cursor === null || /^[a-f0-9]{64}$/.test(cursor)));
   requireValue(view !== 'categories' || !params.has('limit') && cursor === null);
   const filters = fields.map(field => (params.get(field) ?? '').trim().toLowerCase());
   const words = (params.get('q') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
   const results = await Promise.all(shops.map(([shop, db]) => db.query(
    `SELECT g.brand,g.model,g.color,g.edition,g.attrs->>'name' AS name,a.sha256,a.extension ${activeGallery} ORDER BY g.gallery_id`, [shop])));
   const unique = new Map();
   for (const {rows} of results) {
    for (const row of rows) {
     const item = publicImage(row);
     if (!filters.every((filter, i) => !filter || item.categoryPath[i].toLowerCase() === filter)) continue;
     const searchable = [item.name, ...item.categoryPath].join(' ').toLowerCase();
     if (words.every(word => searchable.includes(word)) && !unique.has(item.id)) unique.set(item.id, item);
    }
   }
   const images = [...unique.values()];
   if (view === 'categories') {
    const enums = Object.fromEntries(fields.map((field, i) =>
     [field + 's', [...new Set(images.map(item => item.categoryPath[i]))].sort(collator.compare)]));
    return {view, imageCount: images.length, enums, categories: categoryGroups(images)};
   }
   // 按稳定的公开标识分页，已删除的游标对应记录也不会令下一页回到开头。
   const page = [...unique.keys()].sort().filter(id => cursor === null || id > cursor).slice(0, Number(limit) + 1);
   const hasMore = page.length > Number(limit);
   const items = page.slice(0, Number(limit)).map(id => unique.get(id));
   return {items, total: images.length, hasMore, nextCursor: hasMore ? items.at(-1).id : null};
  },
  async hasImage(sha, extension) {
   const results = await Promise.all(shops.map(([shop, db]) => db.query(
    `SELECT 1 ${activeGallery} AND a.sha256=$2 AND a.extension=$3 LIMIT 1`, [shop, sha, extension])));
   return results.some(result => result.rows.length > 0);
  }
 };
}
