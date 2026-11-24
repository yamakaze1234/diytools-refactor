/** 配件三方比较覆盖行身份、字段归属、增删重排与安全输出。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {nasConfigConflictRows,nasConfigConflictHtml} from '../../public/workbench/nas-conflict-view.js';
const part={lineId:'memory',slot:'内存',name:'16G 内存',goodsId:'100',sourceId:'source-a',qty:1};
const base={id:'c',name:'配置1',price:5000,parts:[part],actualParts:[{...part}],addons:[]};
const compare=(draft,remote)=>({base,draft,remote:{document:remote}});
test('实际配件字段逐项列出原值、本机和服务器值，并区分双方冲突',()=>{
 const draft=structuredClone(base),remote=structuredClone(base);draft.actualParts[0].name='本机 32G';remote.actualParts[0].name='服务器 48G';remote.actualParts[0].goodsId='200';remote.actualParts[0].qty=2;draft.price=5200;
 const rows=nasConfigConflictRows(compare(draft,remote));
 assert.deepEqual(rows.find(row=>row.field.endsWith('· 名称')),{field:'实际配件 · 内存（第 1 项） · 名称',base:'16G 内存',local:'本机 32G',remote:'服务器 48G',kind:'conflict'});
 assert.equal(rows.find(row=>row.field.endsWith('ERP 商品 ID')).kind,'remote');assert.equal(rows.find(row=>row.field==='到手价').kind,'local');
 assert(!rows.some(row=>row.field.startsWith('展示配件')));
});
test('配件重排仍按行号对齐；增加和移除配件均有明细',()=>{
 const second={...part,lineId:'ssd',slot:'硬盘',name:'1TB',goodsId:'300'},before={...base,parts:[part,second]},draft=structuredClone(before),remote=structuredClone(before);
 draft.parts.reverse();remote.parts[0].qty=2;
 let rows=nasConfigConflictRows({base:before,draft,remote:{document:remote}});
 assert.equal(rows.filter(row=>row.field.endsWith('数量')).length,1);assert.equal(rows.find(row=>row.field.endsWith('数量')).local,'1');assert(rows.some(row=>row.field.endsWith('行顺序')));
 draft.parts.splice(1,1);remote.parts.push({...second,lineId:'fan',slot:'风扇'});
 rows=nasConfigConflictRows({base:before,draft,remote:{document:remote}});assert(rows.some(row=>row.field.includes('内存')&&row.local==='无此配件'));assert(rows.some(row=>row.field.includes('风扇')&&row.remote==='存在'));
});
test('加购、字段删除及双方同值变更可见，完全相同不列噪声',()=>{
 const draft={...base,name:'同名',addons:[{text:'本机加购',priceCents:19900,items:[]}]},remote={...base,name:'同名'};delete remote.price;
 const rows=nasConfigConflictRows(compare(draft,remote));assert.equal(rows.find(row=>row.field==='名称').kind,'same');assert.equal(rows.find(row=>row.field==='到手价').remote,'未设置');
 assert(rows.some(row=>row.local==='¥ 199.00'));assert.deepEqual(nasConfigConflictRows(compare(base,base)),[]);
});
test('冲突表展示配件/字段和三列值，对业务字符串进行 HTML 转义',()=>{
 const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const html=nasConfigConflictHtml(compare({...base,name:'<img onerror=alert(1)>'},{...base,name:'服务器'}),esc);
 assert(html.includes('开始编辑时'));assert(html.includes('本机草稿'));assert(html.includes('服务器最新'));assert(html.includes('双方修改冲突'));
 assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert.match(nasConfigConflictHtml(compare(base,base),esc),/配置内容没有差异/);
});
