import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {exportSourceImages} from '../../public/workbench/source-sync-export.js';
import {exportSingleImage} from '../../public/workbench/single-image-export.js';
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const schedule=app.slice(app.indexOf('function scheduleImageSave(){'),app.indexOf('function openConflict('));
const exportCode=app.slice(app.indexOf('async function exportCurrent(){'),app.indexOf('function filename('))+app.slice(app.indexOf('async function exportConfiguredImages('),app.indexOf('// 使用完整配置和本机成本数据执行利润检查。'));

test('saving edited configurations schedules no image work and releases stale pending pins',()=>{
 const context={imageTimer:1,pendingImages:new Set(['a','b']),clearTimeout(){},setTimeout(){throw Error('No background image timer');},request(){throw Error('No cache writes');},renderPoster(){throw Error('No background render');}};
 vm.runInNewContext('var nasMain=false;\n'+schedule+';scheduleImageSave();',context);assert.equal(context.pendingImages.size,0);
 const binding=app.slice(app.indexOf("$('#save').onclick="),app.indexOf("$('#save').onclick=")+180);
 assert.doesNotMatch(binding,/saveImages|pendingImages.add/);assert.doesNotMatch(app,/request\('\/api\/image'/);
});

test('explicit export downloads the click-time draft directly without an application cache copy',async()=>{
 let config={id:'one',name:'first',layout:'long'},finish;const waits=new Promise(resolve=>finish=resolve),rendered=[],downloads=[];
 const context={exportSingleImage:(blob,name,options)=>exportSingleImage(blob,name,{...options,saveFolder:async()=>null}),current:()=>config,clone:structuredClone,$:()=>({value:'1400'}),defaultPosterWidth:()=>1000,dirty:true,savePromise:null,conflict:false,exportJobs:0,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),numberedImageEntries:rows=>rows.map(config=>({config,name:'test.png'})),imageExportOptions:()=>({kind:'long',skuMode:'dedicated',width:1400}),filename:c=>(c.name||'test')+'.png',
 withAddonPackText:config=>config,addonPackDrafts:new Map(),imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},drawPoster:async(c,w)=>{rendered.push([c,w]);await waits;return{canvas:{width:1400,height:1000}};},toBlob:async()=>new Blob(['png']),downloadBlob:(blob,name)=>downloads.push({blob,name}),toast(){},scheduleImageSave(){},request(){throw Error('No intermediate disk cache');}};
 vm.runInNewContext('var nasMain=false;\n'+exportCode,context);const pending=context.exportCurrent();config.name='changed';finish();await pending;
 assert.equal(rendered[0][0].name,'first');assert.equal(rendered[0][1],1400);assert.equal(downloads[0].name,'first.png');assert.equal(context.exportJobs,0);
});

test('overflow export reports failure without downloading or saving a cached PNG',async()=>{
 // 渲染器即使溢出也返回画布，模拟真实返回值以覆盖失败后的资源释放。
 const errors=[];const context={current:()=>({id:'one'}),clone:structuredClone,$:()=>({value:'0'}),defaultPosterWidth:()=>1000,dirty:false,savePromise:null,conflict:false,exportJobs:0,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),numberedImageEntries:rows=>rows.map(config=>({config,name:'test.png'})),imageExportOptions:()=>({kind:'long',skuMode:'dedicated',width:1400}),filename:c=>(c.name||'test')+'.png',
 withAddonPackText:config=>config,addonPackDrafts:new Map(),imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},drawPoster:async()=>({overflow:true,canvas:{width:1400,height:1000}}),downloadBlob(){throw Error('Unexpected download');},toast:text=>errors.push(text),scheduleImageSave(){}};
 vm.runInNewContext('var nasMain=false;\n'+exportCode,context);await context.exportCurrent();assert.match(errors[0],/超出/);assert.equal(context.exportJobs,0);
});


test('输出源导图先读取当前店铺的渲染配置，只交付所选图型，不写配置与图片缓存',async()=>{
 const calls=[],config={id:'one',shopId:'intel',name:'配置1',product:'测试链接',productId:'p'};
 const api={prepareExport:async()=>{calls.push('读取');return [config];},renderImage:async row=>{
  calls.push(row.layout);return {canvas:{width:1,height:1,toBlob:callback=>callback(new Blob(['png']))}};
 },saveFolder:async files=>{calls.push(files.map(f=>f.name));return {ok:true,directory:'test'};}};
 const result=await exportSourceImages(api,[config],'intel',{scope:'changed',layouts:['square'],skuMode:'padded'},()=>{});
 assert.equal(result.phase,'completed');assert.equal(calls[0],'读取');assert.equal(calls[1],'square');
 assert.equal(calls[2].length,2);assert.match(calls[2][0],/sku图/);assert.equal(calls[2][1],'导出清单.json');
 assert.equal(config.layout,undefined);assert.equal(config.skuExportMode,undefined);
});
