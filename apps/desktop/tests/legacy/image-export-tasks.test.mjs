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
