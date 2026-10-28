import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exportSingleImage} from '../../public/workbench/single-image-export.js';

test('单张图片通过实际目录适配器传递原始 PNG 字节并等待原生回执',async()=>{
 const oldReader=globalThis.FileReader,oldBridge=globalThis.pywebview;
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);let payload,finish,downloaded=false;
 globalThis.FileReader=class{async readAsDataURL(blob){this.result='data:image/png;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload();}};
 globalThis.pywebview={api:{export_image_folder:async value=>{payload=value;await new Promise(resolve=>finish=resolve);return {ok:true,directory:'export',files:['配置.png']};}}};
 try{
  let completed=false;const pending=exportSingleImage(new Blob([bytes]),'配置.png',{download:()=>downloaded=true,draft:true}).then(message=>{completed=true;return message;});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,false);assert.equal(payload.name,'配置');assert.deepEqual(Buffer.from(payload.files[0].base64,'base64'),Buffer.from(bytes));finish();
  assert.match(await pending,/已保存到.*当前草稿/);assert.equal(downloaded,false);
 }finally{globalThis.FileReader=oldReader;globalThis.pywebview=oldBridge;}
});
test('取消或原生写入失败不回退浏览器下载、不报告成功',async()=>{
 const blob=new Blob(['png']);const download=()=>assert.fail('不能回退浏览器');
 assert.equal(await exportSingleImage(blob,'x.png',{download,saveFolder:async()=>({cancelled:true})}),'已取消图片导出');
 for(const result of [{ok:false,error:'磁盘已满'},{ok:true,files:[]}])await assert.rejects(exportSingleImage(blob,'x.png',{download,saveFolder:async()=>result}));
 await assert.rejects(exportSingleImage(blob,'x.png',{download,saveFolder:async()=>{throw Error('IPC 失败');}}),/IPC 失败/);
});
test('浏览器保留原 PNG 下载，下载失败向上传递',async()=>{
 const blob=new Blob(['png']);let calls=0;
 assert.match(await exportSingleImage(blob,'x.png',{saveFolder:async()=>null,download:async(b,n)=>{assert.equal(b,blob);assert.equal(n,'x.png');calls++;}}),/浏览器下载记录/);assert.equal(calls,1);
 await assert.rejects(exportSingleImage(blob,'x.png',{saveFolder:async()=>null,download:async()=>{throw Error('下载失败');}}),/下载失败/);
});
test('当前图片与仅勾选一张的批量入口都等待统一导出',()=>{
 const source=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 for(const name of ['exportCurrent','batchExportFull']){
  const body=source.split(`async function ${name}(){`)[1].split('\nfunction ')[0];
  assert.match(body,/await exportConfiguredImages/);assert.doesNotMatch(body,/downloadBlob\(await toBlob/);
 }
});
