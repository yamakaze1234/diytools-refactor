import test from 'node:test';
import assert from 'node:assert/strict';
import {projectedRows,copyRows,planPasteRows,appendAccessoryRow,planRemoveRow} from '../../public/workbench/continuous-parts.js';

const catalog=['cpu','gpu','extra','actual'].map((id,i)=>({sourceId:id,goodsId:`g-${id}`,shopId:'intel',name:id,erp:100+i,tax:120+i,stockAvailable:10}));
const part=(id,slot,extra={})=>({...catalog.find(row=>row.sourceId===id),slot,qty:1,upgrade:'',...extra});
const config=()=>({shopId:'intel',parts:[part('cpu','CPU'),part('gpu','显卡'),part('extra','配件6'),part('extra','CPU')],actualParts:[part('actual','CPU'),part('gpu','显卡'),part('extra','配件7')],addons:[{sourceId:'cpu',text:'cpu addon'},{sourceId:'actual',text:'actual addon'}]});

test('projection includes numbered extra rows without filling storage or losing duplicates',()=>{
 const c=config(),snapshot=structuredClone(c),rows=projectedRows(c);
 assert.equal(rows.length,16);assert.equal(rows[13].slot,'配件5');assert.equal(rows[15].slot,'配件7');assert.equal(rows[1].part,null);
 assert.deepEqual(rows.extras.parts.map(p=>p.slot),['CPU']);assert.deepEqual(rows.extras.actualParts.map(p=>p.slot),[]);
 assert.deepEqual(c,snapshot);
});

test('copy is independent, sorted, and includes independent actual row and associated addons',()=>{
 const c=config(),payload=copyRows(c,[5,0,0,1]);
 assert.equal(payload.rows.length,3);assert.equal(payload.rows[0].part.sourceId,'cpu');assert.equal(payload.rows[0].actual.sourceId,'actual');
 assert.equal(payload.rows[0].addons.length,2);payload.rows[0].part.name='mutated';assert.equal(c.parts[0].name,'cpu');
});

test('mixed slots paste into arbitrary slots atomically and retain extra rows',()=>{
 const c=config(),snapshot=structuredClone(c),payload=copyRows(c,[0,1,5]),after=planPasteRows(c,9,payload,catalog),rows=projectedRows(after);
 assert.equal(rows[9].part.slot,'配件1');assert.equal(rows[9].part.sourceId,'cpu');assert.equal(rows[9].actual.sourceId,'actual');
 assert.equal(rows[10].part,null);assert.equal(rows[11].part.sourceId,'gpu');
 assert.deepEqual(projectedRows(after).extras,beforeExtras(c));assert.deepEqual(c,snapshot);
});
const beforeExtras=c=>structuredClone(projectedRows(c).extras);

test('empty rows clear both columns but leave duplicate slots and unrelated addons',()=>{
 const c=config(),payload=copyRows(c,[1]),after=planPasteRows(c,0,payload,catalog);
 assert.equal(after.parts.filter(p=>p.slot==='CPU').length,1);assert.equal(after.parts.find(p=>p.slot==='CPU').sourceId,'extra');
 assert.equal(after.actualParts.some(p=>p.slot==='CPU'),false);assert.equal(after.addons.length,0);
});

test('out of range and cross shop reject entire operation',()=>{
 const c=config(),before=structuredClone(c),payload=copyRows(c,[0,5]);
 assert.throws(()=>planPasteRows(c,15,payload,catalog),/剩余行数/);
 assert.throws(()=>planPasteRows({...c,shopId:'other'},0,payload,catalog),/跨店铺/);
 assert.deepEqual(c,before);
});

test('missing, deleted, mismatched and excluded sources reject without partial write',()=>{
 for(const invalid of [catalog.filter(r=>r.sourceId!=='gpu'),catalog.map(r=>r.sourceId==='gpu'?{...r,deletedAt:'today'}:r),catalog.map(r=>r.sourceId==='gpu'?{...r,goodsId:'different'}:r),catalog.map(r=>r.sourceId==='gpu'?{...r,name:'* excluded'}:r)]){
  const c=config(),before=structuredClone(c);
  assert.throws(()=>planPasteRows(c,7,copyRows(c,[0,5]),invalid));assert.deepEqual(c,before);
 }
});

test('refreshes current costs while preserving manual source following, tax override and display attributes',()=>{
 const c=config();Object.assign(c.parts[0],{displayName:'custom',qty:2,upgrade:'upgrade',sourceFollow:{sourceId:'cpu',name:{mode:'manual'}},name:'manual'});
 Object.assign(c.actualParts[0],{taxOverride:{value:88},tax:88,qty:3});
 const after=planPasteRows(c,3,copyRows(c,[0]),catalog),row=projectedRows(after)[3];
 assert.equal(row.part.name,'manual');assert.equal(row.part.displayName,'custom');assert.equal(row.part.qty,2);assert.equal(row.part.erp,100);
 assert.equal(row.actual.tax,88);assert.equal(row.actual.qty,3);assert.equal(row.actual.sourceId,'actual');assert.deepEqual(row.actual.taxOverride,{value:88});
 assert.equal(row.actual.displayName,undefined);
});

test('legacy actual fallback is cloned before display edits and full fourteen-row transfer works',()=>{
 const c=config();delete c.actualParts;const before=structuredClone(c),payload=copyRows(c,Array.from({length:14},(_,i)=>i));
 const after=planPasteRows(c,0,payload,catalog);
 assert.equal(projectedRows(after)[0].actual.sourceId,'cpu');assert.notEqual(after.parts[0],after.actualParts[0]);assert.deepEqual(c,before);
 assert.equal(after.parts.find(p=>p.slot==='配件6').sourceId,'extra');
});

test('invalid row indexes and unrelated addon payload are rejected',()=>{
 const c=config();assert.throws(()=>copyRows(c,[-1]));assert.throws(()=>copyRows(c,[16]));
 const payload=copyRows(c,[0]);payload.rows[0].addons.push({sourceId:'foreign',text:'invalid'});
 assert.throws(()=>planPasteRows(c,1,payload,catalog),/加购/);
});

test('add accessories 6, 7 and 8, copy into them and clear without removing explicit rows',()=>{
 const c={shopId:'intel',parts:[part('cpu','CPU')]};
 assert.equal(projectedRows(c).length,14);
 for(const n of [6,7,8])assert.equal(appendAccessoryRow(c),`配件${n}`);
 assert.equal(projectedRows(c).length,17);assert.notEqual(c.parts[0],c.actualParts[0]);
 const filled=planPasteRows(c,16,copyRows(c,[0]),catalog);
 assert.equal(projectedRows(filled)[16].part.sourceId,'cpu');assert.equal(projectedRows(filled)[16].actual.slot,'配件8');
 const cleared=planPasteRows(filled,16,copyRows(c,[1]),catalog);
 assert.equal(projectedRows(cleared).length,17);assert.equal(projectedRows(cleared)[16].part.name,'');
 assert.equal(appendAccessoryRow(cleared),'配件9');
});

test('remove extra rows without renumbering, and keep source addons used by another row',()=>{
 const c={shopId:'intel',parts:[part('cpu','CPU'),part('gpu','配件6'),part('gpu','配件7'),part('extra','配件8')],actualParts:[part('actual','配件6')],addons:[{sourceId:'gpu'},{sourceId:'actual'},{sourceId:'extra'}]};
 const before=structuredClone(c),after=planRemoveRow(c,'配件6');
 assert.deepEqual(c,before);assert.deepEqual(projectedRows(after).slice(14).map(r=>r.slot),['配件7','配件8']);
 assert.equal(after.actualParts.length,0);assert.deepEqual(after.addons.map(a=>a.sourceId),['gpu','extra']);
 assert.equal(appendAccessoryRow(after),'配件9');assert.throws(()=>planRemoveRow(after,'配件6'),/已变化/);
});
test('clear fixed row preserves placeholder and handles legacy actual fallback and duplicate rows',()=>{
 const c={parts:[part('cpu','CPU'),part('gpu','CPU')],addons:[{sourceId:'cpu'},{sourceId:'gpu'}]};
 const after=planRemoveRow(c,'CPU');assert.equal(after.parts[0].sourceId,'gpu');assert.equal(after.actualParts[0].sourceId,'gpu');
 const empty=planRemoveRow(after,'CPU');assert.equal(projectedRows(empty).length,14);assert.equal(projectedRows(empty)[0].part,null);assert.deepEqual(empty.addons,[]);
});
