/** 共用来源沿用目录版本、操作编号和回执；真正的跨店写入由数据库事务完成。 */
import {Fault,requireValue} from './config.mjs';
import {
 sharedSourceKeys, sharedSourceAddonKeys, sourceGoodsId, sharedSpecialKey,
} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {sourceAddon,validateAddon} from '../../../apps/desktop/public/workbench/addon-data.js';
import {validateCapacities} from '../../../apps/desktop/public/workbench/component-capacity.js';
import {validateHardware} from '../../../apps/desktop/public/workbench/component-hardware.js';
import {excludedComponent} from '../../../apps/desktop/public/workbench/component-policy.js';

const scopes = ['shared','intel','gigabyte','jonsbo'];
const keys = new Set(sharedSourceKeys);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = (condition, field) => {
 if (!condition) throw new Fault('VALIDATION_FAILED',400,{field});
};

function validateFields(fields, special, scope) {
 const capacity = {}, hardware = {};
 for (const [key,value] of Object.entries(fields)) {
  valid(keys.has(key) && (!special || key === 'name'), key);
  if (key === 'name') {
   valid(typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 &&
    !excludedComponent({name:value}),key);
  } else if (key === 'tax') {
   valid(value === null || typeof value === 'number' && value >= 0 && value <= 100000000 &&
    Math.abs(value*100 - Math.round(value*100)) < 1e-6,key);
  } else if (key === 'addon') {
   valid(plain(value) && Object.keys(value).every(key=>sharedSourceAddonKeys.includes(key)),key);
   try { validateAddon(sourceAddon(Object.fromEntries(Object.entries(value).filter(([,v])=>v!=null)))); }
   catch { valid(false,key); }
  } else if (value !== null) {
   const [group,field] = key.split('.');
   (group === 'capacityOverrides' ? capacity : hardware)[field] = value;
  }
 }
 try { validateCapacities(capacity); validateHardware(hardware); }
 catch { valid(false,scope+'.fields'); }
}

export function validateSharedSourceEdit(id,document,create) {
 const special=sharedSpecialKey(id);
 valid(sourceGoodsId(id) || special,'document.id');
 valid(document.id===id && Object.keys(document).every(key=>['id','edits','erpName'].includes(key)),'document');
 valid(!Object.hasOwn(document,'erpName') || create && !special && typeof document.erpName==='string' &&
  document.erpName.length<=512 && !excludedComponent({erpName:document.erpName}),'document.erpName');
 const {edits} = document;
 valid(plain(edits) && Object.keys(edits).length>0,'document.edits');
 for (const [scope,change] of Object.entries(edits)) {
  valid(scopes.includes(scope) && plain(change) && Object.keys(change).every(key=>['values','restore'].includes(key)),scope);
  const {values,restore} = change;
  valid(plain(values) && Array.isArray(restore) && new Set(restore).size===restore.length &&
   restore.every(key=>keys.has(key) && (!special || key==='name') && !Object.hasOwn(values,key)) &&
   (scope!=='shared' || restore.length===0) && (Object.keys(values).length>0 || restore.length>0),scope);
  validateFields(values,special,scope);
 }
 if (create) valid(Object.keys(edits).length===1 && !!edits.shared?.values?.name,'document.name');
}

export async function listSharedSources(db,member,shop,id) {
 const {rows} = await db.query('SELECT * FROM workbench_sources.list($1,$2,$3,$4)',[shop,member.workspaceId,member.uid,id]);
 if (!id) return rows;
 requireValue(rows.length,'NOT_FOUND',404);
 return rows[0];
}

export async function writeSharedSource(db,member,shop,id,expected,document) {
 try {
  const {rows:[row]} = await db.query('SELECT workbench_sources.save($1,$2,$3,$4,$5,$6,$7) AS version',
   [shop,member.workspaceId,member.uid,id,expected,JSON.stringify(document.edits),document.erpName??null]);
  return row.version;
 } catch (err) {
  if (err.code!=='P0001') throw err;
  if (err.message==='FORBIDDEN') throw new Fault('FORBIDDEN',403);
  if (['CATALOG_EXISTS','VERSION_CONFLICT','SHARED_SOURCE_VALUE_REQUIRED'].includes(err.message)) throw new Fault(err.message,409);
  throw err;
 }
}
