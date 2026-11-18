/** 管理员离线审查与一次性安装。隔离测试复用同一安装函数。 */
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual as equal} from 'node:util';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {sourceFields, sourceGoodsId} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {excludedComponent} from '../../../apps/desktop/public/workbench/component-policy.js';
import {createHash} from 'node:crypto';

const shops = ['intel','gigabyte','jonsbo'];
const aliasKey = ({shop_id, source_id}) => JSON.stringify([shop_id,source_id]);
const oldAddon = value => sourceFields(value ?? {}).addon;

/** 只有冻结证据与所有有关的现值及来源身份吻合时，才采用最近人工值。 */
function proven(field, rows, history) {
 const resolution = history?.fields[field];
 if (resolution?.status !== 'latest-manual' ||
  rows.some(row => field === 'tax' ? row.cost_edited : row.source_version !== '1')) return;
 const oldAliases = history.aliases.map(({shop,sourceId}) => aliasKey({shop_id:shop,source_id:sourceId})).sort();
 if (!equal(rows.map(aliasKey).sort(),oldAliases)) return;
 const normalize = field === 'addon' ? oldAddon : value => value;
 if (!rows.every(row => {
  const prior = resolution.perShop[row.shop_id];
  return prior && Object.hasOwn(prior,'current') && equal(row.fields[field], normalize(prior.current));
 })) return;
 return {value:normalize(resolution.value)};
}

export function planSharedSources(observed, preview = {}) {
 const history = new Map((preview.records ?? []).map(row => [row.goodsId,row]));
 const rows = observed.flatMap(row => {
  const doc = row.document;
  if (doc.specialComponent === true && doc.name?.trim()) {
   const key = 'special:' + createHash('md5').update(doc.name).digest('hex');
   return [{...row,key,fields:{name:doc.name}}];
  }
  if (!sourceGoodsId(doc.goodsId) || excludedComponent(doc)) return [];
  return [{...row,key:doc.goodsId,fields:sourceFields(doc)}];
 });
 return [...Map.groupBy(rows,row => row.key)].map(([id,aliases]) => {
  const common = {};
  const stores = aliases.map(row => ({shop_id:row.shop_id,source_id:row.source_id,fields:{},legacy:[]}));
  for (const field of Object.keys(aliases[0].fields)) {
   const first = aliases[0].fields[field];
   const latest = aliases.every(row => equal(row.fields[field],first)) ? {value:first} : proven(field,aliases,history.get(id));
   if (latest) common[field] = latest.value;
   else for (const [index,row] of aliases.entries()) {
    stores[index].fields[field] = row.fields[field];
    stores[index].legacy.push(field);
   }
  }
  // 新店补可选来源；有分歧的字段保持待维护，既有店的老主键全部保留。
  for (const shop of shops) if (!stores.some(row => row.shop_id === shop)) {
   stores.push({shop_id:shop,source_id:'shared-src:'+id,fields:{},legacy:[]});
  }
  return {id,common,stores};
 });
}

export async function installSharedSources(db, preview, {verify = false} = {}) {
 const sql = await readFile(new URL('../sql/017-shared-sources.sql', import.meta.url),'utf8');
 await db.query('BEGIN');
 try {
  // PG 的多语句脚本通过无参数查询执行。PGlite 测试使用 exec。
  await (db.exec ? db.exec(sql) : db.query(sql));
  const snapshot = await db.query('SELECT * FROM workbench_sources.snapshot()');
  const plan = planSharedSources(snapshot.rows,preview);
  await db.query(`INSERT INTO workbench_sources.entries(id,fields)
   SELECT p->>'id',p->'common' FROM jsonb_array_elements($1::jsonb) p`,[JSON.stringify(plan)]);
  await db.query(`INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id,fields,legacy)
   SELECT p->>'id',a->>'shop_id',a->>'source_id',a->'fields',a->'legacy'
   FROM jsonb_array_elements($1::jsonb) p CROSS JOIN LATERAL jsonb_array_elements(p->'stores') a`,[JSON.stringify(plan)]);
  await db.query("SELECT workbench_sources.project(id,ARRAY['intel','gigabyte','jonsbo'],NULL) FROM workbench_sources.entries ORDER BY id");
  await db.query(verify ? 'ROLLBACK' : 'COMMIT');
  return {entries:plan.length, withLegacy:plan.filter(row => row.stores.some(alias => alias.legacy.length)).length,
   aliases:plan.reduce((total,row) => total + row.stores.length,0)};
 } catch (err) {
  await db.query('ROLLBACK');
  throw err;
 }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
 const [mode, previewPath] = process.argv.slice(2);
 if (!['--verify','--apply'].includes(mode) || !previewPath) throw Error('用法：node install-shared-sources.mjs --verify|--apply <已验收的迁移预演 JSON>');
 const preview = JSON.parse(await readFile(previewPath,'utf8'));
 const db = new pg.Client();
 await db.connect();
 try { console.log(JSON.stringify(await installSharedSources(db,preview,{verify:mode === '--verify'}))); }
 finally { await db.end(); }
}
