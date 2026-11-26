import test from 'node:test';
import assert from 'node:assert/strict';
import {moveLink,linkOrderValues,duplicateLinkConfigs} from '../../public/workbench/link-order.js';
import {productGroups} from '../../public/workbench/core.js';
const row=(id,productId,extra={})=>({id,shopId:'intel',productId,product:'链接'+productId,name:'配置'+id,workspaceOrder:0,parts:[],actualParts:[],addons:[],...extra});

test('整条链接移到目标链接前后，组内顺序和其他店铺不变',()=>{
 const rows=[row('a1','A'),row('a2','A'),row('b1','B'),row('g1','G',{shopId:'gigabyte'}),row('c1','C'),row('c2','C')],snapshot=structuredClone(rows);
 const before=moveLink(rows,{shopId:'intel',fromId:'C',toId:'A',after:false,draft:false});
 assert.deepEqual(before.map(c=>c.id),['c1','c2','a1','a2','b1','g1']);assert.deepEqual(rows,snapshot);
 const after=moveLink(rows,{shopId:'intel',fromId:'A',toId:'B',after:true,draft:false});
 assert.deepEqual(after.map(c=>c.id),['b1','a1','a2','g1','c1','c2']);
 assert.equal(moveLink(rows,{shopId:'intel',fromId:'A',toId:'B',after:false,draft:false}),null);
 assert.equal(moveLink(rows,{shopId:'intel',fromId:'A',toId:'A',draft:false}),null);
});

test('跨区拖动只改草稿标记，已删除行随链接移动但不改标记',()=>{
 const rows=[row('a1','A'),row('a2','A',{deletedAt:'2026-11-01'}),row('d1','D',{productDraft:true})];
 const toDraft=moveLink(rows,{shopId:'intel',fromId:'A',toId:'D',after:true,draft:true});
 assert.deepEqual(toDraft.map(c=>c.id),['d1','a1','a2']);
 assert.equal(toDraft[1].productDraft,true);assert.equal('productDraft' in toDraft[2],false);
 const back=moveLink(toDraft,{shopId:'intel',fromId:'A',toId:null,draft:false});
 assert.deepEqual(back.map(c=>c.id),['d1','a1','a2']);assert.equal('productDraft' in back[1],false);
 assert.equal(back[0],toDraft[0]);
});

test('NAS 排序值落在相邻链接之间，链接分组后顺序正确',()=>{
 const configs=[row('a1','A',{workspaceOrder:10}),row('a2','A',{workspaceOrder:11}),row('b1','B',{workspaceOrder:20}),row('c1','C',{workspaceOrder:30}),row('c2','C',{workspaceOrder:31})];
 const groups=productGroups(configs);
 const values=linkOrderValues(groups,'C','B',false);
 assert.ok(values[0]>11&&values[1]<20&&values[0]<values[1]);
 const moved=configs.map(c=>c.productId==='C'?{...c,workspaceOrder:values[c.id==='c1'?0:1]}:c).sort((x,y)=>x.workspaceOrder-y.workspaceOrder);
 assert.deepEqual(productGroups(moved).map(g=>g.id),['A','C','B']);
 assert.deepEqual(linkOrderValues(groups,'A','C',true),[131,231]);
 assert.deepEqual(linkOrderValues(groups,'C','A',false),[-190,-90]);
 assert.equal(linkOrderValues(groups,'B','A',true),null);
});

test('创建副本：新链接 ID、名称加副本、清平台标识并放入草稿区，原配置不变',()=>{
 const rows=[row('a1','A',{spu:'SPU1',productUrl:'https://x',skuId:'SKU1',productCategory:'日常',published:true,parts:[{slot:'CPU',name:'i5'}]}),row('a2','A',{deletedAt:'x'})],snapshot=structuredClone(rows);
 let n=0;const copies=duplicateLinkConfigs(rows,{productId:'NEW',newId:()=>'n'+(++n)});
 assert.equal(copies.length,1);assert.deepEqual(rows,snapshot);
 const [c]=copies;
 assert.equal(c.id,'n1');assert.equal(c.productId,'NEW');assert.equal(c.product,'链接A · 副本');
 assert.equal(c.spu,'');assert.equal(c.productUrl,'');assert.equal(c.skuId,'');assert.equal(c.productDraft,true);
 assert.equal(c.productCategory,'日常');assert.equal('published' in c,false);
 assert.deepEqual(c.parts,rows[0].parts);assert.notEqual(c.parts,rows[0].parts);
});
