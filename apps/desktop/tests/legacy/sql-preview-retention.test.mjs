import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSqlSync} from '../../public/workbench/sql-sync-ui.js';

// 只模拟本模块使用的 DOM 接口，验证异步生命周期，不连接 SQL 或用户窗口。
function harness(){
 let nodes=new Map();const dialog=new EventTarget();dialog.open=false;dialog.querySelector=selector=>nodes.get(selector)||null;dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new Event('close'));};
 const document={body:{inert:false},querySelector:selector=>selector==='#dialog'?dialog:nodes.get(selector)||null};
 const openDialog=(_title,html)=>{
  for(const node of nodes.values())node.isConnected=false;nodes=new Map();dialog.open=true;const own=nodes;
  for(const key of [...html.matchAll(/id="([^"]+)"/g)].map(match=>'#'+match[1]).concat(['.dialog-title .close','.sql-diff-table tbody','.sql-diff-scroll'])){
   const node=new EventTarget();Object.assign(node,{id:key.slice(1),value:'test',checked:true,isConnected:true,textContent:'',disabled:false,querySelector:selector=>own.get(selector),querySelectorAll:()=>[...own.values()]});own.set(key,node);
  }
 };
 return {document,dialog,openDialog,get:selector=>nodes.get(selector)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plan={id:'plan1',source:{server:'fixture',port:1433,database:'fixture'},total:101,matched:101,unmatched:0,unknown:0,changes:Array.from({length:101},(_,i)=>({goodsId:String(i),name:'配件',before:1,after:2}))};
test('SQL读取关闭后继续、重新打开保留分页与预览，版本变化拒绝应用并支持重新读取',async()=>{
 const savedDocument=globalThis.document,savedFetch=globalThis.fetch,h=harness();let resolvePreview,revision=1,reads=0,applies=0;
 globalThis.document=h.document;
 globalThis.fetch=async url=>({ok:true,json:async()=>{if(url.endsWith('/credentials'))return {saved:false};if(url.endsWith('/preview')){reads++;return new Promise(resolve=>resolvePreview=resolve);}applies++;return {};}});
 try{
  const api=bindSqlSync({openDialog:h.openDialog,flush:async()=>{},context:()=>revision,hasPending:()=>false,operator:()=>'',receive:async()=>true,toast:()=>{}});
  api.setup();await tick();const reading=h.get('#sql-connection-form').onsubmit({preventDefault(){}});await tick();assert.equal(reads,1);
  h.dialog.close();api.setup();assert.ok(h.get('#sql-read-wait'));resolvePreview(plan);await reading;
  assert.ok(h.get('#sql-apply'));h.get('#sql-diff-next').onclick();assert.match(h.get('#sql-diff-page').textContent,/第 2/);
  h.dialog.close();api.setup();assert.equal(reads,1);assert.match(h.get('#sql-diff-page').textContent,/第 2/);
  const realNow=Date.now;try{const later=realNow()+600001;Date.now=()=>later;await h.get('#sql-apply').onclick();assert.equal(applies,0);assert.match(h.get('#sql-apply-message').textContent,/过期/);}finally{Date.now=realNow;}
  revision=2;await h.get('#sql-apply').onclick();assert.equal(applies,0);assert.equal(h.get('#sql-apply').disabled,true);
  h.get('#sql-preview-refresh').onclick();assert.ok(h.get('#sql-connection-form'));await tick();const readingAgain=h.get('#sql-connection-form').onsubmit({preventDefault(){}});await tick();resolvePreview({...plan,id:'plan2'});await readingAgain;
  await h.get('#sql-apply').onclick();assert.equal(applies,1);api.setup();assert.ok(h.get('#sql-connection-form'));
 }finally{globalThis.document=savedDocument;globalThis.fetch=savedFetch;}
});

test('SQL已应用后关闭弹窗允许按需回载，页面回载完成才允许开始下一次编辑',async()=>{
 const savedDocument=globalThis.document,savedFetch=globalThis.fetch,h=harness();let resolveReceive,received=false,toasts=0;
 globalThis.document=h.document;
 globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/credentials')?{saved:false}:url.endsWith('/preview')?plan:{}});
 try{
  const api=bindSqlSync({openDialog:h.openDialog,flush:async()=>{},context:()=>1,hasPending:()=>false,operator:()=>'',receive:()=>new Promise(resolve=>{assert.equal(h.dialog.open,false,'按需工作区不能在弹窗打开时刷新');received=true;resolveReceive=resolve;}),toast:()=>{toasts++;}});
  api.setup();await tick();await h.get('#sql-connection-form').onsubmit({preventDefault(){}});
  const applying=h.get('#sql-apply').onclick();await tick();assert.equal(received,true);
  assert.equal(h.dialog.open,false);
  assert.equal(h.document.body.inert,true,'SQL持久化完成但页面尚未接收，不能提前释放编辑界面');
  assert.equal(toasts,0);resolveReceive(true);await applying;
  assert.equal(h.dialog.open,false);assert.equal(h.document.body.inert,false);assert.equal(toasts,1);
 }finally{globalThis.document=savedDocument;globalThis.fetch=savedFetch;}
});

test('SQL回载拒绝时保留替换后的冲突弹窗，不显示同步成功',async()=>{
 const savedDocument=globalThis.document,savedFetch=globalThis.fetch,h=harness();let toasts=0;
 globalThis.document=h.document;
 globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/credentials')?{saved:false}:url.endsWith('/preview')?plan:{}});
 try{
  const api=bindSqlSync({openDialog:h.openDialog,flush:async()=>{},context:()=>1,hasPending:()=>false,operator:()=>'',receive:async()=>{h.openDialog('保存版本需要比较','<button id="conflict-backup">下载当前草稿</button>');return false;},toast:()=>{toasts++;}});
  api.setup();await tick();await h.get('#sql-connection-form').onsubmit({preventDefault(){}});await h.get('#sql-apply').onclick();
  assert.equal(h.dialog.open,true);assert.ok(h.get('#conflict-backup'));assert.equal(toasts,0);assert.equal(h.get('.dialog-title .close').disabled,false);assert.equal(h.document.body.inert,false);
 }finally{globalThis.document=savedDocument;globalThis.fetch=savedFetch;}
});

test('SQL回载异常也恢复页面原有输入锁，不残留不可操作页面',async()=>{
 const savedDocument=globalThis.document,savedFetch=globalThis.fetch;
 try{for(const previous of [false,true]){
  const h=harness();h.document.body.inert=previous;const messages=[];globalThis.document=h.document;
  globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/credentials')?{saved:false}:url.endsWith('/preview')?plan:{}});
  const api=bindSqlSync({openDialog:h.openDialog,flush:async()=>{},context:()=>1,hasPending:()=>false,operator:()=>'',receive:async()=>{assert.equal(h.document.body.inert,true);throw Error('fixture reload failure');},toast:value=>messages.push(value)});
  api.setup();await tick();await h.get('#sql-connection-form').onsubmit({preventDefault(){}});await h.get('#sql-apply').onclick();
  assert.equal(h.document.body.inert,previous);assert.deepEqual(messages,['fixture reload failure']);
 }}finally{globalThis.document=savedDocument;globalThis.fetch=savedFetch;}
});
