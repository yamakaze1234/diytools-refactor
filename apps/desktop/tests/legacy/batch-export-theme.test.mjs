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
 assert.deepEqual(task.entries.map(e=>e.name),['1_配置1.png','2_配置2.png']);
 assert.deepEqual(task.entries.map(e=>e.config.theme),['light','dark']);
 assert.deepEqual(task.entries.map(e=>e.config.skuMode),['dedicated','padded']);
 assert.ok(task.entries.every(e=>e.config.layout==='square'));
 assert.equal(task.entries[1].config.palette.bg,'#111111');
 assert.deepEqual(task.report.entries.map(e=>e.theme),['light','dark']);
 rows[1].palette.bg='#changed';assert.equal(task.entries[1].config.palette.bg,'#111111');
 rows[1].palette.bg=before[1].palette.bg;assert.deepEqual(rows,before);
});

test('普通批量命名按链接分别编号，保留配置号，重名链接不覆盖',()=>{
 const rows=[{id:'a2',name:'配置2',productId:'a',product:'同名'},
  {id:'a1',name:'配置1',productId:'a',product:'同名'},
  {id:'a3',name:'配置1',productId:'a',product:'同名'},
  {id:'b',name:'配置三',productId:'b',product:'同名'}];
 const before=structuredClone(rows),entries=numberedImageEntries(rows,'long');
 assert.deepEqual(entries.map(e=>e.name),['同名_配置图/1_配置1.png','同名_配置图/2_配置1.png','同名_配置图/3_配置2.png','同名_2_配置图/1_配置三.png']);
 assert.deepEqual(rows,before);
 assert.equal(numberedImageEntries([{name:'自定义',productId:'a'}],'square')[0].name,'1_配置1.png');
});

test('仅勾选一套的批量入口也用统一文件名且保留该套主题',async()=>{
 const row=configs()[1];let saved;
 const context={chosen:()=>[row],current:()=>configs()[0],clone:structuredClone,$:()=>({value:'1000'}),defaultPosterWidth:()=>1000,numberedImageEntries,imageArchiveName,dirty:false,savePromise:null,conflict:false,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),exportJobs:0,
 imageRenderGate:{run:fn=>fn({})},renderPoster:async c=>{assert.equal(c.theme,'dark');return {canvas:{}};},toBlob:async()=>new Blob(['png']),exportSingleImage:async(blob,name)=>{saved=name;return 'saved';},downloadBlob:()=>{},toast:()=>{},scheduleImageSave:()=>{}};
 await vm.runInNewContext(body+'\nbatchExportFull()',context);
 assert.equal(saved,'1_配置2.png');
});

test('批量修改后全部与仅变动导出均保留深色配置',()=>{
 for(const configIds of [null,['1']]){
  const entries=exportEntries(configs(),['link'],'both',{configIds});
  const dark=entries.filter(e=>e.config.id==='1');assert.equal(dark.length,2);
  for(const e of dark){assert.equal(e.config.theme,'dark');assert.equal(e.config.skuMode,'padded');assert.equal(e.config.palette.bg,'#111111');}
 }
});
