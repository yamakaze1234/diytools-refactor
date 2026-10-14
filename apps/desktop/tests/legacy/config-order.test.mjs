import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreConfigOrder} from '../../public/workbench/config-order.js';
test('按明确顺序还原，随机ID和配置10不影响顺序',()=>{
 const configs=Array.from({length:20},(_,i)=>({id:String(20-i).padStart(2,'0'),shopId:'intel',productId:'p',name:'配置'+(i+1),price:0,parts:[],wpsImport:{lineStart:i*19+1}}));
 const state={configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 assert.deepEqual(restoreConfigOrder([...configs].reverse()).map(c=>c.id),configs.map(c=>c.id));
});
