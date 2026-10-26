/** 隔离浏览器验收：真实 React renderer、source-editor 和 sourceBatch；存储为内存合成资料，无 ERP/云/本机库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const out=new URL('../../../../',import.meta.url);
const errors=[],blockedRequests=[],checks=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
let page;
try {
 page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',d=>d.accept());
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==new URL(base).origin||url.pathname.startsWith('/api/')){blockedRequests.push(url.origin+url.pathname);return route.abort();}return route.continue();});
 const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/workbench/style.css"><link rel="stylesheet" href="/workbench/workbench-ui.css"><link rel="stylesheet" href="/workbench/workbench-simple.css"><link rel="stylesheet" href="/workbench/desktop-layout.css"><link rel="stylesheet" href="/workbench/ui-polish.css"><link rel="stylesheet" href="/workbench/reui-layout.css"></head><body><dialog id="dialog"><form method="dialog"><div class="dialog-title"><h2 id="dialog-title"></h2><button class="close" aria-label="关闭">×</button></div></form><div id="dialog-body"></div></dialog><script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
 const {openSourceEditor}=await import('/workbench/source-editor.js');
 const {sourceBatch}=await import('/workbench/source-batch.js');
 const {sourceAddon,sourceAddonFields}=await import('/workbench/addon-data.js');
 const renderer=createWorkbenchReactRenderer(),dialog=document.querySelector('#dialog'),body=document.querySelector('#dialog-body');
 const make=(id,goodsId,name,tax)=>({sourceId:id,shopId:'intel',goodsId,name,erp:tax-10,tax,upgrade:'',capacityOverrides:{},...sourceAddonFields(sourceAddon({}))});
 let state={configs:[],templates:[],sourceCatalog:[make('fixture-a','71001','隔离内存16GB',100),make('fixture-b','71002','隔离硬盘1TB',200)],costSource:[{goodsId:'71001',name:'隔离内存16GB',erp:90,tax:100,stockAvailable:10},{goodsId:'71002',name:'隔离硬盘1TB',erp:190,tax:200,stockAvailable:20}]};
 const probe={writes:[],failNext:false,notices:[],state:()=>structuredClone(state)};window.sourceProbe=probe;
 function openDialog(title,markup){window.workbenchSourceEditor?.detachForDialog?.();renderer.release(body);body.innerHTML=markup;document.querySelector('#dialog-title').textContent=title;dialog.classList.remove('source-dialog');if(!dialog.open)dialog.showModal();}
 dialog.addEventListener('close',()=>{if(dialog.open)return;window.workbenchSourceEditor?.detachForDialog?.();renderer.release(body);});
 const api={openDialog,shopId:()=> 'intel',getRows:()=>state.sourceCatalog.filter(r=>r.shopId==='intel'),getAllRows:()=>state.sourceCatalog,getCosts:()=>state.costSource,getConfigs:()=>state.configs,flush:async()=>{},download:()=>{throw Error('No fixture export requested');},lookupProduct:async()=>{throw Error('真实ERP调用禁止：隔离fixture');},setDeleted:async()=>{throw Error('No fixture deletion requested');},applySync:async()=>{throw Error('No fixture sync requested');},validateImage:async()=>{},updateLinkCosts:async()=>{throw Error('No fixture config update requested');},render:(container,model)=>renderer.dialog(container,'source-editor',model),renderDetail:(container,model)=>renderer.dialog(container,'source-editor-detail',model),release:container=>renderer.release(container),applyBatch:async entries=>{if(probe.failNext){probe.failNext=false;openDialog('隔离保存冲突','<p id="fixture-conflict">合成冲突：保留源表单</p>');throw Error('隔离版本冲突');}const result=sourceBatch(state,entries);state=result.next;probe.writes.push(structuredClone(entries));return result;}};
 probe.open=()=>openSourceEditor(api);probe.replace=()=>openDialog('隔离其他弹窗','<textarea id="source-name">另一弹窗同名字段</textarea>');probe.close=()=>dialog.close();probe.open();window.fixtureReady=true;
 </script></body></html>`;
 await page.route('**/workbench/source-reui-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.goto(base+'/workbench/source-reui-fixture');await page.waitForFunction(()=>window.fixtureReady);
 await page.locator('#source-name').waitFor();assert.equal(await page.locator('#source-name').inputValue(),'隔离内存16GB');
 assert.equal(await page.locator('#source-save-all').getAttribute('data-slot'),'button');
 assert.equal(await page.locator('#source-id').getAttribute('data-slot'),'input');checks.push('real-renderer-controls');
 // Keep exact nodes across a shared-dialog replacement, including legacy addon/capacity subforms.
 await page.locator('#source-name').fill('未保存中文名称');await page.locator('#source-tax').fill('123.45');
 await page.locator('[data-common-note]').fill('未保存加购说明');
 const capacity=page.locator('[data-capacity]').first();await capacity.fill('32');
 await page.evaluate(()=>{window.sourceProbe.retainedName=document.querySelector('#source-name');window.sourceProbe.replace();});
 assert.equal(await page.locator('#source-name').inputValue(),'另一弹窗同名字段');
 await page.evaluate(()=>window.sourceProbe.close());await page.evaluate(()=>window.sourceProbe.open());
 assert.equal(await page.evaluate(()=>document.querySelector('#source-name')===window.sourceProbe.retainedName),true);
 assert.equal(await page.locator('#source-name').inputValue(),'未保存中文名称');assert.equal(await page.locator('#source-tax').inputValue(),'123.45');assert.equal(await page.locator('[data-common-note]').inputValue(),'未保存加购说明');assert.equal(await page.locator('[data-capacity]').first().inputValue(),'32');checks.push('detached-draft-identical-node-and-all-fields');
 // Actual save failure replaces the dialog while source-controller remains busy.
 await page.evaluate(()=>window.sourceProbe.failNext=true);await page.locator('#source-save-all').click();await page.locator('#fixture-conflict').waitFor();
 await page.evaluate(()=>window.sourceProbe.close());await page.evaluate(()=>window.sourceProbe.open());
 assert.equal(await page.locator('#source-name').inputValue(),'未保存中文名称');assert.match(await page.locator('#source-message').innerText(),/保存失败/);
 await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===1);
 let state=await page.evaluate(()=>window.sourceProbe.state());assert.equal(state.sourceCatalog.find(r=>r.sourceId==='fixture-a').name,'未保存中文名称');assert.equal(state.sourceCatalog.find(r=>r.sourceId==='fixture-a').tax,123.45);assert.equal(state.sourceCatalog.find(r=>r.sourceId==='fixture-a').addonNote,'未保存加购说明');checks.push('conflict-restore-retry-domain-save');
 // Switching records stages current draft; discard resets both staged and visible changes.
 await page.locator('#source-name').fill('待放弃A');await page.locator('[data-source-id="fixture-b"]').click();await page.locator('#source-name').fill('待放弃B');
 await page.locator('[data-source-id="fixture-a"]').click();assert.equal(await page.locator('#source-name').inputValue(),'待放弃A');
 await page.locator('#source-discard-all').click();assert.equal(await page.locator('#source-name').inputValue(),'未保存中文名称');assert.equal(await page.evaluate(()=>window.workbenchSourceEditor.hasPending()),false);checks.push('switch-stage-discard');
 // New special component keeps three-shop choices and zero-cost rules from sourceBatch.
 await page.locator('#source-special-list').click();await page.locator('#source-new').click();assert.equal(await page.locator('#source-special').isChecked(),true);
 await page.locator('#source-name').fill('隔离特殊配件');assert.equal(await page.locator('[data-source-new-shop]:checked').count(),3);
 await page.locator('#source-save').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===2);
 state=await page.evaluate(()=>window.sourceProbe.state());const added=state.sourceCatalog.filter(r=>r.name==='隔离特殊配件');assert.equal(added.length,3);assert.ok(added.every(r=>r.specialComponent&&r.tax===0));checks.push('new-special-three-shop-domain-save');
 await page.evaluate(()=>{document.querySelector('#dialog').scrollTop=0;document.querySelector('#dialog-body').scrollTop=0;});
 await page.screenshot({path:fileURLToPath(new URL('source-editor-reui.png',out)),fullPage:true});
 const geometry=await page.locator('#dialog').evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};});
 assert.ok(Math.abs(geometry.x-(geometry.viewportWidth-geometry.width)/2)<2,JSON.stringify(geometry));
 assert.ok(Math.abs(geometry.y-(geometry.viewportHeight-geometry.height)/2)<2,JSON.stringify(geometry));checks.push('dialog-centered-latest-shared-css');
 await page.waitForFunction(()=>!document.querySelector('#source-save-all').disabled);
 for(let i=0;i<3;i++){await page.evaluate(()=>window.sourceProbe.close());await page.waitForFunction(()=>!window.workbenchSourceEditor);await page.evaluate(()=>window.sourceProbe.open());await page.locator('#source-name').waitFor();assert.equal(await page.locator('.source-editor-root').count(),1);assert.equal(await page.locator('.source-changes-dialog').count(),2);}
 checks.push('three-clean-close-reopen-cycles');
 assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[]);
 const result={passed:true,fixture:'real-react-renderer-source-controller-and-sourceBatch; memory synthetic storage',productionAccess:false,realUploadOrErp:false,checks,errors,blockedRequests,writeCount:await page.evaluate(()=>window.sourceProbe.writes.length)};
 await fs.writeFile(new URL('source-editor-reui-result.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error){
 if(page)await page.screenshot({path:fileURLToPath(new URL('source-editor-reui-failure.png',out)),fullPage:true}).catch(()=>{});
 await fs.writeFile(new URL('source-editor-reui-result.json',out),JSON.stringify({passed:false,error:error.message,checks,errors,blockedRequests},null,2));throw error;
} finally {await browser.close();}
