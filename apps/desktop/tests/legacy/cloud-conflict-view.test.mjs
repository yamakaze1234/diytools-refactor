import test from 'node:test';
import assert from 'node:assert/strict';
import {conflictDifferences,conflictCard} from '../../public/workbench/cloud-conflict-view.js';
test('parts match by lineId and show quantity, text, removal and reordering without unchanged noise',()=>{
 const a={parts:[{lineId:'a',slot:'显卡',qty:1,name:'显卡A'},{lineId:'b',slot:'硬盘',qty:1,upgrade:'加229元'}],name:'相同'};
 const b={parts:[{lineId:'b',slot:'硬盘',qty:2,upgrade:'加299元'},{lineId:'a',slot:'显卡',qty:1,name:'显卡A'}],name:'相同'};
 const diff=conflictDifferences(a,b);assert.equal(diff.length,3);assert.ok(diff.some(d=>d.field.endsWith('顺序')));assert.ok(diff.some(d=>d.local==='加229元'&&d.remote==='加299元'));
 assert.ok(!diff.some(d=>d.local==='显卡A'));assert.ok(conflictDifferences(a,{parts:[a.parts[0]],name:'相同'}).some(d=>d.remote==='未设置'));
});
test('missing null empty arrays deletion and type changes stay distinguishable',()=>{
 assert.equal(conflictDifferences({x:null},{}).length,1);assert.equal(conflictDifferences({x:[]},{x:{}}).length,2);
 assert.ok(conflictDifferences({name:'本机'},null).some(d=>d.field.includes('内容类型')));
 assert.deepEqual(conflictDifferences({priceCents:129900},{priceCents:139900})[0],{field:'到手价',local:'¥ 1299.00',remote:'¥ 1399.00'});
});
test('cards escape user text and omit unchanged full records',()=>{
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html=conflictCard({type:'configuration',draft:{name:'<img onerror=x>',parts:[],unchanged:'private-large-value'},conflict:{remote:{data:{name:'云端',parts:[],unchanged:'private-large-value'}}}},0,esc);
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('<pre>'));assert.ok(!html.includes('private-large-value'));assert.match(html,/本机版本/);assert.match(html,/云端版本/);
});
