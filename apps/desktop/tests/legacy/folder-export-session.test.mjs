import test from 'node:test';
import assert from 'node:assert/strict';
import {saveImageFolder} from '../../public/workbench/folder-export.js';

async function withBridge(session,run){
 const oldBridge=globalThis.pywebview,oldReader=globalThis.FileReader;
 globalThis.pywebview={api:{export_image_folder:()=>assert.fail('不应使用整批桥接'),export_image_folder_session:session}};
 globalThis.FileReader=class{async readAsDataURL(blob){this.result='data:image/png;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload();}};
 try{await run();}finally{globalThis.pywebview=oldBridge;globalThis.FileReader=oldReader;}
}
test('大批量图片只选一次目录，逐批编码且每次IPC保持有限大小',async()=>{
 const data=new Uint8Array(1024*1024),files=Array.from({length:400},(_,i)=>({name:`链接/图${i}.png`,bytes:data}));let begins=0,appends=0,finished=false,max=0;const saved=[];
 await withBridge(async payload=>{
  if(payload.phase==='begin'){begins++;return {token:'t',directory:'test'};}
  if(payload.phase==='finish'){finished=true;return {ok:true,directory:'test',files:saved};}
  appends++;max=Math.max(max,JSON.stringify(payload).length);assert.equal(payload.token,'t');
  for(const file of payload.files){assert.equal(Buffer.from(file.base64,'base64').length,data.length);saved.push(file.name);}
  return {ok:true,directory:'test',files:[...saved]};
 },async()=>{const result=await saveImageFolder(files,'测试');assert.equal(result.files.length,400);});
 assert.equal(begins,1);assert.equal(appends,50);assert.equal(finished,true);assert.ok(max<12*1024*1024);
});
test('取消选择不编码图片，中途磁盘失败仍返回已保存清单并结束会话',async()=>{
 await withBridge(async payload=>{assert.equal(payload.phase,'begin');return {cancelled:true};},async()=>{assert.equal((await saveImageFolder([{bytes:null}],'x')).cancelled,true);});
 const files=[{name:'a.png',bytes:new Uint8Array(8*1024*1024)},{name:'b.png',bytes:new Uint8Array(1)}];let writes=0,ends=0;
 await withBridge(async payload=>{
  if(payload.phase==='begin')return {token:'t'};
  if(payload.phase==='finish'){ends++;return {ok:false,directory:'test',files:['a.png'],error:'磁盘已满'};}
  return ++writes===1?{ok:true,files:['a.png']}:{ok:false,files:['a.png'],error:'磁盘已满'};
 },async()=>{const result=await saveImageFolder(files,'x');assert.equal(result.ok,false);assert.deepEqual(result.files,['a.png']);assert.match(result.error,/磁盘已满/);});
 assert.equal(ends,1);assert.equal(writes,2);
});
test('取消传输释放会话并保留已落盘图片，未传输文件不报告成功',async()=>{
 const controller=new AbortController();let ends=0;
 await withBridge(async payload=>{
  if(payload.phase==='begin')return {token:'t'};
  if(payload.phase==='finish'){ends++;return {ok:true,files:['a.png']};}
  controller.abort();return {ok:true,files:['a.png']};
 },async()=>{const result=await saveImageFolder([{name:'a.png',bytes:new Uint8Array(8*1024*1024)},{name:'b.png',bytes:new Uint8Array(1)}],'x',{signal:controller.signal});assert.equal(result.ok,false);assert.deepEqual(result.files,['a.png']);});
 assert.equal(ends,1);
});
