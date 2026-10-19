import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const extract=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end));
function fixture(){
 const opened=[],requests=[],dialog={open:false},listeners={};let pending=false,focused=false,batches=[{revision:5,seen:false}];
 const c={window:{workbenchReady:true,workbenchHasPendingChanges:()=>pending},document:{addEventListener:(name,fn)=>listeners[name]=fn,activeElement:{matches:()=>focused}},conflict:false,workspaceLoad:null,fullActionBusy:0,state:{revision:10},
  $:()=>dialog,setInterval(){},toast(){},console,request:async()=>{requests.push(1);return{batches};},showPriceChanges:async options=>{opened.push(options);}};
 vm.runInNewContext(extract('const priceNotifications=','function openProfitFull('),c);
 return{c,opened,requests,dialog,listeners,setPending:v=>pending=v,setFocused:v=>focused=v,setBatches:v=>batches=v};
}
test('启动、普通保存版本推进及点击其他按钮不读取或弹出旧未读价格批次',async()=>{
 const f=fixture();for(let i=0;i<5;i++){f.c.state.revision++;await f.c.checkPriceChanges();}
 f.setFocused(true);await f.c.checkPriceChanges();f.setFocused(false);await f.c.checkPriceChanges();
 assert.equal(f.requests.length,0);assert.equal(f.opened.length,0);
});
test('仅ERP与成本源成功事件可触发，并限定本次回执范围且只弹一次',async()=>{
 for(const source of ['erp','cost-source']){
  const f=fixture();f.setBatches([{revision:12,seen:false},{revision:11,seen:false},{revision:5,seen:false}]);
  f.c.queuePriceChanges({source,after:10,revision:11});await f.c.checkPriceChanges();await f.c.checkPriceChanges();
  f.c.queuePriceChanges({source,after:10,revision:11});await f.c.checkPriceChanges();
  assert.deepEqual(f.opened.map(o=>o.revision),[11]);assert.equal(f.opened[0].automatic,true);assert.equal(f.requests.length,1);
 }
 const f=fixture();for(const value of [{source:'ordinary',after:10,revision:11},{source:'erp',after:11,revision:11},{source:'erp',after:10,revision:undefined}])f.c.queuePriceChanges(value);
 await f.c.checkPriceChanges();assert.equal(f.requests.length,0);
});
test('本次没有价格变化或已手动看过时，不改为弹历史未读批次',async()=>{
 for(const batches of [[{revision:5,seen:false}],[{revision:11,seen:true},{revision:5,seen:false}]]){
  const f=fixture();f.setBatches(batches);f.c.queuePriceChanges({source:'erp',after:10,revision:11});await f.c.checkPriceChanges();await f.c.checkPriceChanges();assert.equal(f.opened.length,0);assert.equal(f.requests.length,1);
 }
});
test('导入完成时正在编辑或使用其他窗口，放弃自动提示，之后失焦或点击配件不补弹',async()=>{
 for(const block of ['pending','dialog','focus']){
  const f=fixture();f.setBatches([{revision:11,seen:false}]);f.c.queuePriceChanges({source:'erp',after:10,revision:11});
  f.setPending(block==='pending');f.dialog.open=block==='dialog';f.setFocused(block==='focus');await f.c.checkPriceChanges();
  f.setPending(false);f.dialog.open=false;f.setFocused(false);await f.c.checkPriceChanges();
  assert.equal(f.opened.length,0);assert.equal(f.requests.length,0);
 }
});
test('价格查询期间打开其他功能，旧通知丢弃，关闭其他功能后不补弹',async()=>{
 const f=fixture();f.setBatches([{revision:11,seen:false}]);f.c.queuePriceChanges({source:'erp',after:10,revision:11});
 const request=f.c.request;f.c.request=async()=>{const r=await request();f.dialog.open=true;return r;};await f.c.checkPriceChanges();
 f.dialog.open=false;await f.c.checkPriceChanges();assert.equal(f.opened.length,0);assert.equal(f.requests.length,1);
});
test('慢查询期间已经点击或按键，即使其他功能已关闭也不弹；查询失败不重试',async()=>{
 for(const event of ['pointerdown','keydown','error']){
  const f=fixture();f.setBatches([{revision:11,seen:false}]);f.c.queuePriceChanges({source:'erp',after:10,revision:11});
  const request=f.c.request;f.c.request=async()=>{const r=await request();if(event==='error')throw Error('离线');f.listeners[event]();return r;};
  await f.c.checkPriceChanges();await f.c.checkPriceChanges();assert.equal(f.opened.length,0);assert.equal(f.requests.length,1);
 }
});
test('ERP回载失败或拒绝时清除本次待提示，成功留给解锁后的完成回调',async()=>{
 for(const result of [true,false,'error']){
  const events=[],c={priceNotifications:[],receiveErp:async()=>{events.push('receive');c.priceNotifications.push({revision:11});if(result==='error')throw Error('回载失败');return result;},checkPriceChanges:async()=>events.push('check')};
  vm.runInNewContext(extract('async function receiveErpForPrices(','function openProfitFull('),c);
  if(result==='error')await assert.rejects(c.receiveErpForPrices({}),/回载失败/);else await c.receiveErpForPrices({});
  assert.deepEqual(events,['receive']);assert.equal(c.priceNotifications.length,result===true?1:0);
 }
});
test('全量加载期间打开其他弹窗，自动展示再次检查而手动入口仍可用',async()=>{
 const opened=[],c={priceNotifications:[{revision:11}],pricePopupBlocked:()=>false,ensureFullWorkspace:async()=>{c.pricePopupBlocked=()=>true;},openPriceChanges:async()=>opened.push(1),openDialog(){},request(){},toast(){},downloadBlob(){},acceptedState:{configs:[]}};
 vm.runInNewContext(extract('async function showPriceChanges(','// 仅本次本机同步成功回执'),c);
 assert.equal(await c.showPriceChanges({automatic:true}),false);assert.equal(opened.length,0);
 await c.showPriceChanges();assert.equal(opened.length,1);assert.equal(c.priceNotifications.length,0);
});
test('成本源仅在保存成功后排队，普通保存与失败不产生通知',async()=>{
 for(const fail of [false,true]){
  let apply,saves=0;const events=[],c={openCostEditor:api=>{apply=api.apply;},openDialog(){},state:{sourceCatalog:[]},acceptedState:{revision:10},save:async()=>{saves++;if(saves===2){if(fail)throw Error('保存失败');c.acceptedState.revision=11;}},checkpoint(){},applyManualCosts:()=>['c'],sourceCatalog:()=>[],changed(){},renderAll(){},queuePriceChanges:e=>events.push(e),checkPriceChanges:async()=>{}};
  vm.runInNewContext(extract('function openCostsFull(','// 接收已经提交的 ERP 数据'),c);c.openCostsFull();
  if(fail)await assert.rejects(apply([{goodsId:'1',tax:100}]),/保存失败/);else await apply([{goodsId:'1',tax:100}]);
  assert.equal(events.length,fail?0:1);if(!fail)assert.equal(events[0].revision,11);
 }
});
test('ERP接收仅使用成功回执版本，界面刷新和历史状态不产生通知',async()=>{
 const events=[],c={fullWorkspace:false,conflict:false,refreshCompactWorkspace:async()=>true,queuePriceChanges:e=>events.push(e),checkPriceChanges:async()=>{}};
 vm.runInNewContext(extract('async function receiveErp(','// 维护机箱图库'),c);
 await c.receiveErp({ok:true,revision:21});await c.receiveErp({ok:false,revision:22});await c.receiveErp({revision:23});
 assert.equal(events.length,1);assert.equal(events[0].after,20);assert.equal(events[0].revision,21);
});
