import test from 'node:test';
import assert from 'node:assert/strict';
import {previewRasterWidth,renderPreviewPoster,PREVIEW_PIXEL_BUDGET} from '../../public/workbench/preview-resolution.js';
import {renderPoster,defaultPosterWidth} from '../../public/workbench/poster.js';
import {modulesDefault} from '../../public/workbench/core.js';
import {seed} from './fixtures/workspace.mjs';
import {suggestedName} from '../../public/workbench/legacy-names.js';
import {syncPosterShortName} from '../../public/workbench/short-name-poster.js';

test('generated short names reach preview and export in both formats and all headers',async t=>{
 canvasDOM(t);
 for(const layout of ['long','square','centered']){
  const c=config(layout==='square'?'square':'long');c.skuMode='dedicated';c.modules=modulesDefault('intel','light');
  if(layout==='centered')c.freeCanvasLayouts={long:{base:668,compact:true,centeredHeader:true}};
  c.posterSubtitle='旧摘要';c.textStyles={'header.subtitle':{text:'旧长图',size:18,color:'#123456'}};c.skuTextStyles={'header.subtitle':{text:'旧方图',size:16}};
  c.textTransforms={long:{'header.subtitle':{x:8,y:9}}};
  for(const nameFormat of ['default','compact']){
   c.nameFormat=nameFormat;c.shortNameAuto=true;c.shortName=suggestedName(c,nameFormat);syncPosterShortName(c);
   const preview=await renderPreviewPoster(c,{displayWidth:400}),exported=await renderPoster(c);
   assert.equal(preview.textRegions.find(r=>r.key==='header.subtitle')?.value,c.shortName,`${layout}/${nameFormat} preview`);
   assert.equal(exported.textRegions.find(r=>r.key==='header.subtitle')?.value,c.shortName,`${layout}/${nameFormat} export`);
  }
  assert.deepEqual(c.textStyles['header.subtitle'],{size:18,color:'#123456'});
  assert.deepEqual(c.skuTextStyles['header.subtitle'],{size:16});
  assert.deepEqual(c.textTransforms,{long:{'header.subtitle':{x:8,y:9}}});
 }
});

test('custom poster summary remains until explicitly reset and hidden summary stays hidden',async t=>{
 canvasDOM(t);const c=config('long');c.modules=modulesDefault('intel','light');c.shortName='新的维护表简称';c.posterSubtitle='独立图片摘要';
 assert.equal((await renderPoster(c)).textRegions.find(r=>r.key==='header.subtitle')?.value,'独立图片摘要');
 syncPosterShortName(c);
 assert.equal((await renderPoster(c)).textRegions.find(r=>r.key==='header.subtitle')?.value,c.shortName);
 c.posterFields={subtitle:false};syncPosterShortName(c);
 assert.equal((await renderPoster(c)).textRegions.some(r=>r.key==='header.subtitle'),false);
});

test('viewport and zoom raster targets honor DPR, export and pixel limits',()=>{
 assert.equal(previewRasterWidth({displayWidth:400,devicePixelRatio:2}),600);
 assert.equal(previewRasterWidth({displayWidth:1050,devicePixelRatio:2,exportWidth:1400}),1024);
 assert.equal(previewRasterWidth({displayWidth:800,exportWidth:500}),500);
 for(const ratio of [.1,1,2,10,22,100]){
  const width=previewRasterWidth({displayWidth:1400,devicePixelRatio:3,exportWidth:1400,geometry:{base:668,height:668*ratio}}),height=Math.ceil(width*ratio);
  assert.ok(width*height<=PREVIEW_PIXEL_BUDGET.maxPixels);assert.ok(Math.max(width,height)<=PREVIEW_PIXEL_BUDGET.maxSide);
 }
 assert.throws(()=>previewRasterWidth({geometry:{base:1,height:5000}}),/像素预算/);
});

function canvasDOM(t){
 const canvases=[];const previous=new Map();
 const ctx=()=>new Proxy({font:'16px sans-serif',measureText:text=>({width:String(text).length*8})},{get:(target,key)=>key in target?target[key]:(()=>{}),set:(target,key,value)=>{target[key]=value;return true;}});
 const document={fonts:{ready:Promise.resolve(),add(){}},createElement(){const context=ctx(),canvas={width:0,height:0,getContext:()=>context};canvases.push(canvas);return canvas;}};
 for(const [key,value]of Object.entries({document,FontFace:class{async load(){return this;}}})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 t.after(()=>{for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});return canvases;
}
const config=layout=>({...structuredClone(seed.configs[0]),layout,caseVisible:false,posterImages:[]});
const geometry=result=>({base:result.base,height:result.height,regions:result.regions,textRegions:result.textRegions,imageRegion:result.imageRegion,addedImageRegions:result.addedImageRegions,overflow:result.overflow,needed:result.needed});

test('preview uses the production layout unchanged while export dimensions stay explicit',async t=>{
 const canvases=canvasDOM(t),c=config('long');const exported=await renderPoster(c,1000);const before=JSON.stringify(c);const preview=await renderPreviewPoster(c,{displayWidth:360,devicePixelRatio:1.5});
 assert.equal(preview.canvas.width,540);assert.deepEqual(geometry(preview),geometry(exported));assert.equal(preview.exportWidth,1000);assert.equal(preview.previewLayout,'long');assert.equal(JSON.stringify(c),before);
 assert.ok(canvases.some(canvas=>canvas.width===160),'cold long preview probes at 160px');
 const zoomed=await renderPreviewPoster(c,{displayWidth:1050,devicePixelRatio:2,geometry:preview});assert.deepEqual(geometry(zoomed),geometry(exported));assert.equal(zoomed.canvas.width,1000);
 const afterExport=await renderPoster(c,defaultPosterWidth(c));assert.equal(afterExport.canvas.width,1000);assert.equal(afterExport.canvas.height,exported.canvas.height);
});

test('very long preview is bounded without changing layout coordinates or clipping',async t=>{
 canvasDOM(t);const c=config('long');c.modules=[{id:'custom',type:'custom',title:'长图',visible:true,text:Array.from({length:120},()=> '长图测试内容').join('\n'),size:22,weight:600,gap:16}];
 const exported=await renderPoster(c,1000),preview=await renderPreviewPoster(c,{displayWidth:700,devicePixelRatio:1.5});
 assert.deepEqual(geometry(preview),geometry(exported));assert.ok(preview.canvas.width*preview.canvas.height<=PREVIEW_PIXEL_BUDGET.maxPixels);assert.ok(preview.canvas.height<=PREVIEW_PIXEL_BUDGET.maxSide);assert.ok(preview.canvas.width<700);assert.ok(preview.redrawImages);assert.ok(preview.redrawLayout);
 t.diagnostic(`same long layout: export=${exported.canvas.width}x${exported.canvas.height}; preview=${preview.canvas.width}x${preview.canvas.height}; preview pixels=${preview.canvas.width*preview.canvas.height}.`);
});

test('dedicated and padded readonly squares retain square export and readonly behavior',async t=>{
 canvasDOM(t);
 for(const skuMode of ['dedicated','padded']){
  const c={...config('square'),skuMode},preview=await renderPreviewPoster(c,{displayWidth:400,devicePixelRatio:1.5}),exported=await renderPoster(c,1400);
  assert.equal(preview.canvas.width,600);assert.equal(preview.canvas.height,600);assert.equal(preview.exportWidth,1400);assert.equal(exported.canvas.width,1400);assert.equal(exported.canvas.height,1400);
  if(skuMode==='padded'){assert.equal(preview.readOnly,true);assert.deepEqual(preview.textRegions,[]);assert.deepEqual(preview.regions,[]);assert.equal(preview.redrawImages,undefined);}else assert.deepEqual(geometry(preview),geometry(exported));
 }
});
test('optional render admission runs after every material load and before layout/paint',async t=>{
 const canvases=canvasDOM(t),loaded=[],phases=[];const previous=Object.getOwnPropertyDescriptor(globalThis,'Image');Object.defineProperty(globalThis,'Image',{configurable:true,writable:true,value:class{
  constructor(){this.width=this.naturalWidth=100;this.height=this.naturalHeight=100;this.complete=false;}
  set src(url){queueMicrotask(()=>{this.complete=true;loaded.push(url);this.onload();});}
 }});t.after(()=>previous?Object.defineProperty(globalThis,'Image',previous):delete globalThis.Image);
 const c={...config('long'),modules:modulesDefault('intel','light'),caseVisible:true,caseImage:'/uploads/gate-case-test.png',posterImages:[{id:'layer',url:'/uploads/gate-layer-test.png',name:'图层',naturalWidth:100,naturalHeight:100,transforms:{}}]};
 const result=await renderPoster(c,1000,{beforeDraw:async phase=>{
  phases.push(phase);assert.deepEqual(loaded,['/uploads/gate-case-test.png','/uploads/gate-layer-test.png']);
  if(phase==='layout'){
   // Material loading checks origin-clean pixels before admission. Only these
   // 1px safety probes may exist; poster layout and painting must still wait.
   assert.equal(canvases.filter(canvas=>canvas.width===1&&canvas.height===1).length,loaded.length);
   assert.equal(canvases.filter(canvas=>canvas.width!==1||canvas.height!==1).length,0);
  }
 }});
 assert.deepEqual(phases,['layout','paint']);assert.equal(result.canvas.width,1000);assert.ok(result.imageRegion);assert.equal(result.addedImageRegions.length,1);
 const ungated=await renderPoster(c,1000);assert.deepEqual(geometry(result),geometry(ungated));assert.equal(result.canvas.height,ungated.canvas.height);
});
test('readonly padded square passes admission through detail and final padding phases',async t=>{
 canvasDOM(t);const phases=[];const c={...config('square'),skuMode:'padded'},gated=await renderPoster(c,1400,{beforeDraw:phase=>{phases.push(phase);}}),ungated=await renderPoster(c,1400);
 assert.deepEqual(phases,['layout','paint','padding']);assert.equal(gated.readOnly,true);assert.deepEqual(geometry(gated),geometry(ungated));assert.equal(gated.canvas.width,1400);assert.equal(gated.canvas.height,1400);
});
