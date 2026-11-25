// React 宿主缓存确认：mock 原生命令，不清理本机缓存；测试草稿选择、失败重载和关闭互斥。
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({bypassCSP:true});const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});page.on('response',r=>{if(r.status()>=400)console.error(r.status(),r.url());});page.setDefaultTimeout(10000);
 await page.route('**/p1-cache-host',route=>route.fulfill({contentType:'text/html',body:`<html><head><meta charset="UTF-8"></head><body><iframe class="legacy-workbench-frame"></iframe><div id="root"></div><script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;const {default:Dialog}=await import('/src/CacheCleanupDialog.tsx');
 window.probe={drafts:[{id:'a',name:'配置5'}],blocker:null,calls:[],reloads:0,fail:false,frozen:false};
 window.isTauri=true;window.__TAURI_INTERNALS__={invoke:async command=>{probe.calls.push(command);if(probe.fail)throw Error('更新操作正在进行');return {recycledFiles:2,recycledBytes:2048,retained:1,browserCacheCleared:true,warnings:[]};}};
 const live=document.querySelector('iframe').contentWindow;
 live.workbenchCacheStatus=async()=>({drafts:probe.drafts,count:probe.drafts.length,blocker:probe.blocker});
 live.workbenchPrepareCacheCleanup=async choice=>{probe.choice=choice;if(probe.blocker)throw Error(probe.blocker);probe.drafts=[];return {count:0,drafts:[],blocker:null};};
 live.workbenchReloadAfterCache=()=>{probe.reloads++;dispatchEvent(new MessageEvent('message',{source:live,origin:location.origin,data:{type:'workbench-ready'}}));};
 const root=createRoot(document.getElementById('root'));window.show=()=>root.render(React.createElement(Dialog,{onClose:()=>root.render(null),onFreeze:value=>probe.frozen=value}));window.show();
 </script></body></html>`}));
 await page.goto(base+'/p1-cache-host');await page.getByRole('button',{name:'先保存再清理'}).waitFor();
 assert.match(await page.locator('dialog').innerText(),/配置5/);assert.equal((await page.evaluate(()=>probe.calls)).length,0);
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.evaluate(()=>show());
 await page.getByRole('button',{name:'先保存再清理'}).click();await page.getByRole('button',{name:'完成',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>probe.choice),'save');assert.equal(await page.evaluate(()=>probe.reloads),1);assert.equal(await page.evaluate(()=>probe.frozen),false);
 assert.match(await page.locator('[role=status]').innerText(),/移入回收站.*已重新加载服务端最新资料/);
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.evaluate(()=>{probe.drafts=[{id:'b',name:'配置6'}];probe.fail=true;show();});
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'确认放弃草稿后清理'}).click();assert.equal(await page.evaluate(()=>probe.calls.length),1);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'确认放弃草稿后清理'}).click();
 await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('更新操作正在进行'));
 assert.equal(await page.evaluate(()=>probe.reloads),2);assert.equal(await page.evaluate(()=>probe.choice),'discard');assert.equal(await page.evaluate(()=>window.workbenchUpdatePending),false);
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.evaluate(()=>{probe.blocker='存在待确认的提交回执';probe.drafts=[{id:'pending'}];show();});
 await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('待确认'));
 assert.equal(await page.getByRole('button',{name:'确认放弃草稿后清理'}).count(),0);assert.equal(await page.evaluate(()=>probe.calls.length),2);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,saveBeforeCleanup:true,explicitDiscard:true,pendingBlocked:true,reloadAfterNativeFailure:true}));
}finally{await browser.close();}
