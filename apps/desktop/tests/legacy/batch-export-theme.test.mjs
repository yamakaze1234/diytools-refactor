import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {numberedImageEntries,imageArchiveName} from '../../public/workbench/image-export-order.js';
import {exportEntries} from '../../public/workbench/global-batch.js';

const source=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function batchExportFull(){'),source.indexOf('// 使用完整配置和本机成本数据执行利润检查。'));
const configs=()=>['light','dark'].map((theme,i)=>({id:String(i),name:`配置${i+1}`,productId:'link',product:'测试链接',shopId:'intel',spu:'123',theme,layout:'long',skuMode:i?'padded':'dedicated',palette:{bg:i?'#111111':'#ffffff'}}));

for(const activeTheme of ['light','dark'])test(`批量入口当前选中${activeTheme}，每套仍保留各自主题与SKU样式`,async()=>{
 const rows=configs(),before=structuredClone(rows);let task;
 const context={chosen:()=>rows,current:()=>({...rows.find(c=>c.theme===activeTheme),layout:'square'}),clone:structuredClone,
  $:()=>({value:'1400'}),defaultPosterWidth:()=>1400,numberedImageEntries,imageArchiveName,dirty:false,savePromise:null,conflict:false,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),exportJobs:0,
  startImageExportTask:options=>{task=options;return {done:Promise.resolve()};},downloadBlob:()=>{},toast:message=>{assert.doesNotMatch(message,/Error/);},scheduleImageSave:()=>{}};
 await vm.runInNewContext(body+'\nbatchExportFull()',context);
 assert.ok(task);
 assert.deepEqual(task.entries.map(e=>e.config.theme),['light','dark']);
 assert.deepEqual(task.entries.map(e=>e.config.skuMode),['dedicated','padded']);
 assert.ok(task.entries.every(e=>e.config.layout==='square'));
 assert.equal(task.entries[1].config.palette.bg,'#111111');
 assert.deepEqual(task.report.entries.map(e=>e.theme),['light','dark']);
 rows[1].palette.bg='#changed';assert.equal(task.entries[1].config.palette.bg,'#111111');
 rows[1].palette.bg=before[1].palette.bg;assert.deepEqual(rows,before);
});

test('批量修改后全部与仅变动导出均保留深色配置',()=>{
 for(const configIds of [null,['1']]){
  const entries=exportEntries(configs(),['link'],'both',{configIds});
  const dark=entries.filter(e=>e.config.id==='1');assert.equal(dark.length,2);
  for(const e of dark){assert.equal(e.config.theme,'dark');assert.equal(e.config.skuMode,'padded');assert.equal(e.config.palette.bg,'#111111');}
 }
});
