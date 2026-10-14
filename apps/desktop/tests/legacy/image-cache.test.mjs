import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=(await fs.readFile(new URL('../../public/workbench/image-cache.js',import.meta.url),'utf8')).replaceAll('export ','');
function cache({blocked=false}={}){
 const loads=[],probes=[];
 class Image {
  complete=false;naturalWidth=0;naturalHeight=0;
  set src(value){this.url=value;loads.push({url:value,crossOrigin:this.crossOrigin});this.tainted=blocked||this.crossOrigin!=='anonymous';queueMicrotask(()=>{this.complete=true;this.naturalWidth=this.naturalHeight=2;this.onload();});}
 }
 const context={Image,setTimeout,clearTimeout,resolveWorkbenchAsset:url=>'http://workbench-asset.localhost'+url,document:{createElement(){let image;return{getContext:()=>({drawImage(value){image=value;},getImageData(){probes.push(image);if(image.tainted)throw new DOMException('Tainted canvases may not be exported','SecurityError');return{};}})};}}};
 vm.runInNewContext(source,context);return{...context,loads,probes};
}
const decoded=tainted=>({complete:true,naturalWidth:2,naturalHeight:2,tainted});

test('tainted gallery thumbnail is not reused; one CORS load serves all 19 exports',async()=>{
 const c=cache(),thumbnail=decoded(true);
 assert.equal(c.rememberImage('/uploads/case.png',thumbnail),false);
 const rendered=await Promise.all(Array.from({length:19},()=>c.getImage('/uploads/case.png')));
 assert.equal(c.loads.length,1);assert.equal(c.loads[0].crossOrigin,'anonymous');
 assert.ok(rendered.every(image=>image===rendered[0]&&!image.tainted));assert.notEqual(rendered[0],thumbnail);
});

test('decoded clean upload and CORS gallery images remain reusable without new decoding',async()=>{
 const c=cache(),image=decoded(false);
 assert.equal(c.rememberImage('/uploads/clean.png',image),true);
 assert.equal(c.rememberImage('/uploads/clean.png',image),true);
 assert.equal(await c.getImage('/uploads/clean.png'),image);assert.equal(c.loads.length,0);assert.equal(c.probes.length,2);
 assert.equal(c.rememberImage('/uploads/clean.png',decoded(true)),false);
 assert.equal((await c.getImage('/uploads/clean.png')).tainted,false);
});

test('a previously clean IMG that changes to a tainted source loses its cache entry',async()=>{
 const c=cache(),image=decoded(false);image.src='blob:clean';
 assert.equal(c.rememberImage('/uploads/material.png',image),true);
 image.src='http://workbench-asset.localhost/uploads/another.png';image.tainted=true;
 assert.equal(c.rememberImage('/uploads/material.png',image),false);
 const reloaded=await c.getImage('/uploads/material.png');assert.notEqual(reloaded,image);assert.equal(reloaded.tainted,false);
});

test('failed origin-clean check rejects export and evicts pending cache for retry',async()=>{
 const c=cache({blocked:true});
 await assert.rejects(c.getImage('/uploads/blocked.png'),/无法安全导出/);
 await assert.rejects(c.getImage('/uploads/blocked.png'),/无法安全导出/);
 assert.equal(c.loads.length,2);
});
