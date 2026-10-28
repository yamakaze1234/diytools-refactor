import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {exportSingleImage} from '../../public/workbench/single-image-export.js';
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const schedule=app.slice(app.indexOf('function scheduleImageSave(){'),app.indexOf('function openConflict('));
const exportCode=app.slice(app.indexOf('async function exportCurrent(){'),app.indexOf('function filename('))+app.slice(app.indexOf('async function exportConfiguredImages('),app.indexOf('// 使用完整配置和本机成本数据执行利润检查。'));

test('saving edited configurations schedules no image work and releases stale pending pins',()=>{
 const context={imageTimer:1,pendingImages:new Set(['a','b']),clearTimeout(){},setTimeout(){throw Error('No background image timer');},request(){throw Error('No cache writes');},renderPoster(){throw Error('No background render');}};
 vm.runInNewContext(schedule+';scheduleImageSave();',context);assert.equal(context.pendingImages.size,0);
 const binding=app.slice(app.indexOf("$('#save').onclick="),app.indexOf("$('#save').onclick=")+180);
 assert.doesNotMatch(binding,/saveImages|pendingImages.add/);assert.doesNotMatch(app,/request\('\/api\/image'/);
});

test('explicit export downloads the click-time draft directly without an application cache copy',async()=>{
 let config={id:'one',name:'first',layout:'long'},finish;const waits=new Promise(resolve=>finish=resolve),rendered=[],downloads=[];
 const context={exportSingleImage:(blob,name,options)=>exportSingleImage(blob,name,{...options,saveFolder:async()=>null}),current:()=>config,clone:structuredClone,$:()=>({value:'1400'}),defaultPosterWidth:()=>1000,dirty:true,savePromise:null,conflict:false,exportJobs:0,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),numberedImageEntries:rows=>rows.map(config=>({config,name:'test.png'})),imageExportOptions:()=>({kind:'long',skuMode:'dedicated',width:1400}),filename:c=>(c.name||'test')+'.png',
 imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},renderPoster:async(c,w)=>{rendered.push([c,w]);await waits;return{canvas:'canvas'};},toBlob:async()=>new Blob(['png']),downloadBlob:(blob,name)=>downloads.push({blob,name}),toast(){},scheduleImageSave(){},request(){throw Error('No intermediate disk cache');}};
 vm.runInNewContext(exportCode,context);const pending=context.exportCurrent();config.name='changed';finish();await pending;
 assert.equal(rendered[0][0].name,'first');assert.equal(rendered[0][1],1400);assert.equal(downloads[0].name,'first.png');assert.equal(context.exportJobs,0);
});

test('overflow export reports failure without downloading or saving a cached PNG',async()=>{
 const errors=[];const context={current:()=>({id:'one'}),clone:structuredClone,$:()=>({value:'0'}),defaultPosterWidth:()=>1000,dirty:false,savePromise:null,conflict:false,exportJobs:0,state:{revision:1},activeShopId:'intel',currentShop:()=>({name:'测试'}),numberedImageEntries:rows=>rows.map(config=>({config,name:'test.png'})),imageExportOptions:()=>({kind:'long',skuMode:'dedicated',width:1400}),filename:c=>(c.name||'test')+'.png',
 imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},renderPoster:async()=>({overflow:true}),downloadBlob(){throw Error('Unexpected download');},toast:text=>errors.push(text),scheduleImageSave(){}};
 vm.runInNewContext(exportCode,context);await context.exportCurrent();assert.match(errors[0],/超出/);assert.equal(context.exportJobs,0);
});


test('source update export flushes and submits a folder task without writing image cache',async()=>{
 const source=await fs.readFile(new URL('../../public/workbench/source-sync-ui.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf(' async function exportAll(){'),source.indexOf(' async function applySelected('));
 const calls=[],config={id:'one',name:'test'},changes=[{id:'one'}],context={exportBatch:{changes,shopId:'intel'},$:()=>({value:'changed'}),api:{flush:async()=>calls.push('flush'),getConfigs:()=>[config],saveImage:()=>{throw Error('No image cache copy');}},sourceExportEntries:(configs,chosen,shopId,scope)=>{assert.deepEqual(configs,[config]);assert.equal(chosen,changes);assert.equal(shopId,'intel');assert.equal(scope,'changed');return [{config,name:'test.png'}];},message(){},startImageExportTask:options=>{calls.push('task');assert.equal(options.entries[0].config,config);assert.match(options.name,/本店输出源更新图片/);return {done:Promise.resolve('saved')};}};
 vm.runInNewContext(code,context);assert.equal(await context.exportAll(),'saved');assert.deepEqual(calls,['flush','task']);
});
