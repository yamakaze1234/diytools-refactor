import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreConfigOrder,planConfigRenumber} from '../../public/workbench/config-order.js';
test('按明确顺序还原，随机ID和配置10不影响顺序',()=>{
 const configs=Array.from({length:20},(_,i)=>({id:String(20-i).padStart(2,'0'),shopId:'intel',productId:'p',name:'配置'+(i+1),price:0,parts:[],wpsImport:{lineStart:i*19+1}}));
 const state={configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 assert.deepEqual(restoreConfigOrder([...configs].reverse()).map(c=>c.id),configs.map(c=>c.id));
});

test('重新编号保留后缀、跳过特殊名称和已删除项，且不修改输入',()=>{
 const rows=['配置1','颜值升级包','配置五：16G / 1T','配置9 · 32G','16G','配置套餐','配置12'].map((name,i)=>({id:String(i),name,...(i===6?{deletedAt:'2026-10-25'}:{})}));
 const before=structuredClone(rows),plan=planConfigRenumber(rows);
 assert.deepEqual(plan.map(r=>r.after),['配置1','颜值升级包','配置2：16G / 1T','配置3 · 32G','16G','配置套餐']);
 assert.deepEqual(rows,before);
 assert.deepEqual(planConfigRenumber(plan.map(r=>({id:r.id,name:r.after}))).filter(r=>r.before!==r.after),[]);
});
