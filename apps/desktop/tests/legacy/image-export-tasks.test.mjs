import test from 'node:test';
import assert from 'node:assert/strict';
import {startImageExportTask,imageExportTasks} from '../../public/workbench/image-export-tasks.js';
const entries=()=>['a','b'].map(id=>({name:id+'.png',config:{id,name:id,parts:[{name:'原始'}]}}));
const render=async config=>({canvas:{toBlob:callback=>callback(new Blob([JSON.stringify(config)]))}});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};

test('快照隔离后续编辑和渲染器修改，失败重试只输出未成功的图片',async()=>{
 const input=entries(),gate=deferred(),renders=[],outputs=[];let fail=true;
 const task=startImageExportTask({entries:input,name:'测试',renderImage:async config=>{await gate.promise;renders.push(structuredClone(config));if(config.id==='b'&&fail)throw Error('暂时失败');config.parts[0].name='渲染器改动';return render(config);},saveFolder:async files=>{outputs.push(files.map(file=>file.name));return {directory:'test'};}});
 input[0].config.parts[0].name='后续编辑';gate.resolve();await task.done;
 assert.equal(task.phase,'partial');assert.equal(renders[0].parts[0].name,'原始');fail=false;await task.retryFailed();
 assert.deepEqual(renders.map(c=>c.id),['a','b','b']);assert.equal(renders[2].parts[0].name,'原始');assert.deepEqual(outputs[1],['b.png','导出清单_重试1.json']);assert.equal(task.phase,'completed');assert.ok(task.items.every(item=>item.config===null&&item.bytes===null));
});
test('取消目录选择保留生成结果，再保存不重复绘制且不能报告已保存',async()=>{
 let rendered=0,calls=0;const task=startImageExportTask({entries:entries(),name:'测试',renderImage:async c=>{rendered++;return render(c);},saveFolder:async()=>++calls===1?{cancelled:true}:{directory:'test'}});
 await task.done;assert.equal(task.phase,'cancelled');assert.equal(task.items.filter(item=>item.state==='saved').length,0);await task.resume();assert.equal(rendered,2);assert.equal(task.items.every(item=>item.state==='saved'),true);
});
test('关闭文字订阅不影响后台执行，取消任务阻止后续渲染和保存',async()=>{
 const gate=deferred();let renders=0,saves=0;const task=startImageExportTask({entries:entries(),name:'测试',status:()=>{throw Error('弹窗已关闭');},renderImage:async c=>{renders++;await gate.promise;return render(c);},saveFolder:async()=>{saves++;return {directory:'test'};}});
 assert.ok(imageExportTasks().includes(task));task.cancel();gate.resolve();await assert.rejects(task.done,{name:'AbortError'});assert.equal(renders,1);assert.equal(saves,0);await task.resume();assert.equal(task.phase,'completed');
});
test('原生保存中收到迟到外部取消仍按已写盘记账，不重复成功项',async()=>{
 const gate=deferred(),signal=new AbortController();let saving;const started=new Promise(r=>saving=r);
 const task=startImageExportTask({entries:entries(),name:'测试',signal:signal.signal,renderImage:render,saveFolder:async()=>{saving();await gate.promise;return {directory:'test'};}});
 await started;signal.abort();gate.resolve();await task.done;assert.equal(task.phase,'completed');assert.equal(task.items.every(item=>item.state==='saved'),true);await task.retryFailed();assert.equal(task.attempt,1);
});
test('浏览器下载与本机保存状态分开，保存失败只重试未交付项',async()=>{
 let fail=true,rendered=0;const task=startImageExportTask({entries:entries(),name:'测试',renderImage:async c=>{rendered++;return render(c);},saveFolder:async()=>{if(fail)throw Error('磁盘失败');return null;},download:async()=>{}});
 await assert.rejects(task.done,/磁盘失败/);assert.ok(task.items.every(item=>item.state==='failed'));fail=false;await task.retryFailed();assert.equal(rendered,2);assert.ok(task.items.every(item=>item.state==='downloaded'));
});
test('原生部分写出回执保留成功项，重试不再次输出成功图片',async()=>{
 const outputs=[];const task=startImageExportTask({entries:entries(),name:'测试',renderImage:render,saveFolder:async files=>{outputs.push(files.map(file=>file.name));return outputs.length===1?{ok:false,directory:'test',files:['a.png'],error:'磁盘已满'}:{ok:true,directory:'test_retry',files:files.map(file=>file.name)};}});
 await task.done;assert.equal(task.items[0].state,'saved');assert.equal(task.items[1].state,'failed');assert.match(task.message,/已导出 1 张图片/);await task.retryFailed();assert.deepEqual(outputs[1],['b.png','导出清单_重试1.json']);
});

test('原生流式任务逐张落盘后才生成下一张，完成后不保留PNG和配置',async()=>{
 const input=Array.from({length:80},(_,i)=>({name:`${i}.png`,config:{id:i}}));let renders=0,writes=0,opened=0,ended=0;const saved=[];
 const task=startImageExportTask({entries:input,name:'stream',renderImage:async config=>{assert.equal(writes,renders);renders++;return render(config);},openFolder:async()=>{opened++;return {directory:'stream',append:async file=>{if(file.name.endsWith('.png')){writes++;assert.equal(renders,writes);}saved.push(file.name);return {ok:true,files:[...saved]};},finish:async()=>{ended++;return {ok:true,files:saved,directory:'stream'};}};}});
 await task.done;assert.equal(task.phase,'completed');assert.equal(opened,1);assert.equal(ended,1);assert.equal(writes,80);assert.ok(task.items.every(item=>item.bytes===null&&item.config===null));
});
test('流式取消选目录不生成图片，继续只重新选择一次目录',async()=>{
 let opens=0,renders=0;const saved=[];
 const task=startImageExportTask({entries:entries(),name:'stream',renderImage:async c=>{renders++;return render(c);},openFolder:async()=>++opens===1?{cancelled:true}:{append:async f=>{saved.push(f.name);return {ok:true,files:[...saved]};},finish:async()=>({ok:true,files:saved})}});
 await task.done;assert.equal(renders,0);assert.equal(task.phase,'cancelled');await task.resume();assert.equal(renders,2);assert.equal(opens,2);assert.equal(task.phase,'completed');
});
test('流式中途保存失败释放所有PNG，失败重试重新生成且跳过已落盘项',async()=>{
 let attempts=0,ended=0;const renders=[],batches=[];
 const task=startImageExportTask({entries:entries(),name:'stream',renderImage:async c=>{renders.push(c.id);return render(c);},openFolder:async()=>{const attempt=++attempts,saved=[];batches.push(saved);return {append:async f=>{if(attempt===1&&f.name==='b.png')return {ok:false,files:saved,error:'磁盘已满'};saved.push(f.name);return {ok:true,files:[...saved]};},finish:async()=>{ended++;return {ok:true,files:saved};}};}});
 await task.done;assert.equal(task.phase,'partial');assert.deepEqual(task.items.map(i=>i.state),['saved','failed']);assert.ok(task.items.every(i=>i.bytes===null));await task.retryFailed();assert.deepEqual(renders,['a','b','b']);assert.deepEqual(batches[1],['b.png','导出清单_重试1.json']);assert.equal(ended,2);
});
test('流式保存回执之后取消保留成功项并关闭会话，继续不重复已交付图片',async()=>{
 const controller=new AbortController();let opens=0,ends=0;const renders=[];
 const task=startImageExportTask({entries:entries(),name:'stream',signal:controller.signal,renderImage:async c=>{renders.push(c.id);return render(c);},openFolder:async()=>{const attempt=++opens,saved=[];return {append:async f=>{saved.push(f.name);if(attempt===1)controller.abort();return {ok:true,files:[...saved]};},finish:async()=>{ends++;return {ok:true,files:saved};}};}});
 await task.done;assert.equal(task.phase,'cancelled');assert.deepEqual(task.items.map(i=>i.state),['saved','pending']);assert.ok(task.items.every(i=>i.bytes===null));await task.resume();assert.deepEqual(renders,['a','b']);assert.equal(ends,2);assert.equal(task.phase,'completed');
});
test('流式结束回执能恢复append丢失的确认，未知保存不误报成功',async()=>{
 let ends=0;
 const task=startImageExportTask({entries:entries(),name:'stream',renderImage:render,openFolder:async()=>({append:async()=>{throw Error('连接中断');},finish:async()=>{ends++;return {ok:true,files:['a.png']};}})});
 await task.done;assert.deepEqual(task.items.map(i=>i.state),['saved','failed']);assert.equal(task.phase,'partial');assert.equal(ends,1);assert.ok(task.items.every(i=>i.bytes===null));
});

test('流式渲染失败继续其他图片，失败项可独立重新生成',async()=>{
 let fail=true;const outputs=[];
 const task=startImageExportTask({entries:entries(),name:'stream',renderImage:async c=>{if(fail&&c.id==='a')throw Error('图片太高');return render(c);},openFolder:async()=>{const saved=[];outputs.push(saved);return {append:async f=>{saved.push(f.name);return {ok:true,files:[...saved]};},finish:async()=>({ok:true,files:saved})};}});
 await task.done;assert.deepEqual(task.items.map(i=>i.state),['failed','saved']);assert.ok(task.items.every(i=>i.bytes===null));fail=false;await task.retryFailed();assert.deepEqual(outputs[1],['a.png','导出清单_重试1.json']);assert.equal(task.phase,'completed');
});
test('流式渲染中取消释放会话且不写出尚未生成的文件',async()=>{
 const gate=deferred();let started;const rendering=new Promise(r=>started=r);let ends=0,saves=0;
 const task=startImageExportTask({entries:entries(),name:'stream',renderImage:async c=>{started();await gate.promise;return render(c);},openFolder:async()=>({append:async()=>{saves++;return {ok:true,files:[]};},finish:async()=>{ends++;return {ok:true,files:[]};}})});
 await rendering;task.cancel();gate.resolve();await task.done;assert.equal(task.phase,'cancelled');assert.equal(ends,1);assert.equal(saves,0);assert.ok(task.items.every(i=>i.bytes===null&&i.state==='pending'));
});

test('流式任务在成功编码、溢出和取消后都释放任务画布位图',async()=>{
 for(const mode of ['saved','overflow','cancelled']){
  const controller=new AbortController(),canvas={width:1400,height:2400,toBlob:callback=>{assert.equal(canvas.width,1400);callback(new Blob(['png']));}};const saved=[];
  const task=startImageExportTask({entries:entries().slice(0,1),name:mode,signal:controller.signal,renderImage:async()=>{if(mode==='cancelled')controller.abort();return {canvas,overflow:mode==='overflow'};},openFolder:async()=>({append:async f=>{assert.equal(canvas.width,0);assert.equal(canvas.height,0);saved.push(f.name);return {ok:true,files:[...saved]};},finish:async()=>({ok:true,files:saved})})});
  await task.done;assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(task.items[0].bytes,null);
 }
});
test('清单写入失败或回执漏报时图片仍记账，但明确提示导出未完整完成',async()=>{
 for(const mode of ['throw','missing']){
  const saved=[];
  const task=startImageExportTask({entries:entries(),name:'manifest',renderImage:render,openFolder:async()=>({append:async f=>{if(f.name.endsWith('.json')){if(mode==='throw')throw Error('磁盘已满');return {ok:true,files:[...saved]};}saved.push(f.name);return {ok:true,files:[...saved]};},finish:async()=>({ok:true,files:saved})})});
  await task.done;assert.ok(task.items.every(item=>item.state==='saved'));assert.equal(task.phase,'partial');assert.equal(task.manifestSaved,false);assert.match(task.message,/导出清单未确认保存，本次导出未完整完成/);
 }
});
