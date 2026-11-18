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

// 超大图和累计像素预算必须真正淘汰，不能仅靠图片张数限制。
test('解码缓存按字节淘汰且清空不破坏调用方原图',async()=>{
 const c=cache(),large={...decoded(false),naturalWidth:3000,naturalHeight:3000};
 c.rememberImage('/one',large);c.rememberImage('/two',{...large});
 await c.getImage('/one');assert.equal(c.loads.length,1);
 c.clearImageCache();assert.equal(large.naturalWidth,3000);
 await c.getImage('/two');assert.equal(c.loads.length,2);
 const huge={...large,naturalWidth:10000};c.rememberImage('/huge',huge);
 await c.getImage('/huge');assert.equal(c.loads.length,3);
});
test('切换配置期间完成的旧加载不会重新污染缓存',async()=>{
 const c=cache(),pending=c.getImage('/old');c.clearImageCache();
 assert.ok(await pending);await c.getImage('/old');assert.equal(c.loads.length,2);
});
