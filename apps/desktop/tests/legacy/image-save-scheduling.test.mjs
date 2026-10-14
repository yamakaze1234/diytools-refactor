import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const schedule=app.slice(app.indexOf('function scheduleImageSave(){'),app.indexOf('function openConflict('));
const exportCode=app.slice(app.indexOf('async function exportCurrent(){'),app.indexOf('function filename('));

test('saving edited configurations schedules no image work and releases stale pending pins',()=>{
 const context={imageTimer:1,pendingImages:new Set(['a','b']),clearTimeout(){},setTimeout(){throw Error('No background image timer');},request(){throw Error('No cache writes');},renderPoster(){throw Error('No background render');}};
 vm.runInNewContext(schedule+';scheduleImageSave();',context);assert.equal(context.pendingImages.size,0);
 const binding=app.slice(app.indexOf("$('#save').onclick="),app.indexOf("$('#save').onclick=")+180);
 assert.doesNotMatch(binding,/saveImages|pendingImages.add/);assert.doesNotMatch(app,/request\('\/api\/image'/);
});

test('explicit export downloads the click-time draft directly without an application cache copy',async()=>{
 let config={id:'one',name:'first',layout:'long'},finish;const waits=new Promise(resolve=>finish=resolve),rendered=[],downloads=[];
 const context={current:()=>config,clone:structuredClone,$:()=>({value:'1400'}),defaultPosterWidth:()=>1000,dirty:true,savePromise:null,conflict:false,exportJobs:0,
 imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},renderPoster:async(c,w)=>{rendered.push([c,w]);await waits;return{canvas:'canvas'};},toBlob:async()=>({png:true}),filename:c=>c.name+'.png',downloadBlob:(blob,name)=>downloads.push({blob,name}),toast(){},scheduleImageSave(){},request(){throw Error('No intermediate disk cache');}};
 vm.runInNewContext(exportCode,context);const pending=context.exportCurrent();config.name='changed';finish();await pending;
 assert.equal(rendered[0][0].name,'first');assert.equal(rendered[0][1],1400);assert.equal(downloads[0].name,'first.png');assert.equal(context.exportJobs,0);
});

test('overflow export reports failure without downloading or saving a cached PNG',async()=>{
 const errors=[];const context={current:()=>({id:'one'}),clone:structuredClone,$:()=>({value:'0'}),defaultPosterWidth:()=>1000,dirty:false,savePromise:null,conflict:false,exportJobs:0,
 imageRenderGate:{run:async work=>work({beforeDraw:()=>{}})},renderPoster:async()=>({overflow:true}),downloadBlob(){throw Error('Unexpected download');},toast:text=>errors.push(text),scheduleImageSave(){}};
 vm.runInNewContext(exportCode,context);await context.exportCurrent();assert.match(errors[0],/超出/);assert.equal(context.exportJobs,0);
});


test('source update export validates current configuration and writes only the requested archive',async()=>{
 const source=await fs.readFile(new URL('../../public/workbench/source-sync-ui.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf(' async function exportAll(){'),source.indexOf(' async function applySelected('));
 const calls=[],config={id:'one',name:'test'},context={exportConfigs:[config],api:{flush:async()=>calls.push('flush'),validateImage:async c=>{assert.equal(c.id,'one');calls.push('validate');},download:()=>calls.push('download'),saveImage:()=>{throw Error('No image cache copy');}},sourceImageEntries:configs=>configs.map(config=>({config,name:'test.png'})),message(){},renderPoster:async()=>({canvas:{toBlob:done=>done({arrayBuffer:async()=>new ArrayBuffer(3)})}}),makeZip:files=>{assert.equal(files.length,2);return {};},TextEncoder,Uint8Array};
 vm.runInNewContext(code,context);await context.exportAll();assert.deepEqual(calls,['flush','validate','download']);
});
