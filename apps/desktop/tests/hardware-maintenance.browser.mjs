/** 隔离浏览器验收：真实 React renderer、source-editor 和 sourceBatch；存储为内存合成资料，无 ERP/云/本机库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const out=new URL('file:///D:/diytools/sandbox/hardware-maintenance-20261101/');
const errors=[],blockedRequests=[],checks=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
let page;
try {
 page=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',d=>d.accept());
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==new URL(base).origin||url.pathname.startsWith('/api/')){blockedRequests.push(url.origin+url.pathname);return route.abort();}return route.continue();});
 const html=`<!doctype html><html><head><script src="/workbench/endfield-init.js"></script><link rel="stylesheet" href="/workbench/endfield/endfield.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"><meta charset="utf-8"><link rel="stylesheet" href="/workbench/style.css"><link rel="stylesheet" href="/workbench/workbench-ui.css"><link rel="stylesheet" href="/workbench/workbench-simple.css"><link rel="stylesheet" href="/workbench/desktop-layout.css"><link rel="stylesheet" href="/workbench/ui-polish.css"><link rel="stylesheet" href="/workbench/reui-layout.css"></head><body><dialog id="dialog"><form method="dialog"><div class="dialog-title"><h2 id="dialog-title"></h2><button class="close" aria-label="关闭">×</button></div></form><div id="dialog-body"></div></dialog><script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
 const {openSourceEditor}=await import('/workbench/source-editor.js');
 const {sourceBatch}=await import('/workbench/source-batch.js');
 const {sourceAddon,sourceAddonFields}=await import('/workbench/addon-data.js');
 const renderer=createWorkbenchReactRenderer(),dialog=document.querySelector('#dialog'),body=document.querySelector('#dialog-body');
 const make=(id,goodsId,name,tax)=>({sourceId:id,shopId:'intel',goodsId,name,erp:tax-10,tax,upgrade:'',capacityOverrides:{},...sourceAddonFields(sourceAddon({}))});
 const legacyChoice={id:'legacy-upgrade',goodsId:'',qty:1,priceCents:null,label:'历史加购说明',enabled:true};
 let state={configs:[],templates:[],sourceCatalog:[make('fixture-case','71003','乔思伯 Z20 MATX 机箱',200),make('fixture-memory','71004','DDR5 内存 16GB',200),make('fixture-gpu','71005','RTX5060Ti 显卡 16GB',200),make('fixture-storage','71006','SSD 固态硬盘 1TB',200),{...make('fixture-a','71001','Intel i5 14600KF CPU',100),capacityOverrides:{memoryGb:48}},{...make('fixture-b','71002','技嘉 B760M 主板',200),capacityOverrides:null,addonText:'历史加购说明',addonChoices:[legacyChoice]},{...make('fixture-other-shop','71001','跨店内存16GB',100),shopId:'gigabyte',addonText:'历史加购说明',addonChoices:[legacyChoice]}],costSource:[{goodsId:'71001',name:'Intel i5 14600KF CPU',erp:90,tax:100,stockAvailable:10},{goodsId:'71002',name:'技嘉 B760M 主板',erp:190,tax:200,stockAvailable:20}]};
 const probe={writes:[],failNext:false,notices:[],state:()=>structuredClone(state)};window.sourceProbe=probe;
 function openDialog(title,markup){window.workbenchSourceEditor?.detachForDialog?.();renderer.release(body);body.innerHTML=markup;document.querySelector('#dialog-title').textContent=title;dialog.classList.remove('source-dialog');if(!dialog.open)dialog.showModal();}
 dialog.addEventListener('close',()=>{if(dialog.open)return;window.workbenchSourceEditor?.detachForDialog?.();renderer.release(body);});
 const api={openDialog,shopId:()=> 'intel',getRows:()=>state.sourceCatalog.filter(r=>r.shopId==='intel'),getAllRows:()=>state.sourceCatalog,getCosts:()=>state.costSource,getConfigs:()=>state.configs,flush:async()=>{},download:()=>{throw Error('No fixture export requested');},lookupProduct:async()=>{throw Error('真实ERP调用禁止：隔离fixture');},setDeleted:async()=>{throw Error('No fixture deletion requested');},applySync:async()=>{throw Error('No fixture sync requested');},validateImage:async()=>{},updateLinkCosts:async()=>{throw Error('No fixture config update requested');},render:(container,model)=>renderer.dialog(container,'source-editor',model),renderDetail:(container,model)=>renderer.dialog(container,'source-editor-detail',model),release:container=>renderer.release(container),applyBatch:async entries=>{if(probe.failNext){probe.failNext=false;openDialog('隔离保存冲突','<p id="fixture-conflict">合成冲突：保留源表单</p>');throw Error('隔离版本冲突');}const result=sourceBatch(state,entries);state=result.next;probe.writes.push(structuredClone(entries));return result;}};
 probe.open=()=>openSourceEditor(api);probe.replace=()=>openDialog('隔离其他弹窗','<textarea id="source-name">另一弹窗同名字段</textarea>');probe.close=()=>dialog.close();probe.open();window.fixtureReady=true;
 </script></body></html>`;
 await page.route('**/workbench/source-reui-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.goto(base+'/workbench/source-reui-fixture');await page.waitForFunction(()=>window.fixtureReady);

 await page.locator('[data-source-id="fixture-a"]').click();
 await page.locator('#source-hardware').waitFor();
 async function visibleKind(id,kind){await page.locator(`[data-source-id="${id}"]`).click();await page.waitForFunction(()=>!document.querySelector('.workbench-detail-ghost'));assert.deepEqual(await page.locator('[data-maintenance-kind]:visible').evaluateAll(els=>els.map(el=>el.dataset.maintenanceKind)),[kind]);}
 for(const [id,kind]of [['fixture-a','cpu'],['fixture-b','board'],['fixture-case','case'],['fixture-memory','memoryGb'],['fixture-gpu','vramGb'],['fixture-storage','storageGb']])await visibleKind(id,kind);
 await visibleKind('fixture-a','cpu');
 await page.locator('#source-hardware').evaluate(el=>el.scrollIntoView({block:'center'}));
 await page.locator('#source-hardware').screenshot({path:fileURLToPath(new URL('hardware-view-cpu.png',out))});
 await page.screenshot({path:fileURLToPath(new URL('hardware-view-full.png',out))});
 await page.locator('#source-hardware-cpu').fill('14600KF');
 await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===1);
 assert.equal((await page.evaluate(()=>window.sourceProbe.state())).sourceCatalog.find(r=>r.sourceId==='fixture-a').hardwareOverrides.cpuName,'14600KF');
 await page.locator('[data-source-id="fixture-b"]').click();await page.locator('#source-hardware-board').selectOption('MATX');await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===2);
 await page.waitForFunction(()=>!document.querySelector('#source-save-all').disabled);await page.evaluate(()=>window.sourceProbe.close());await page.waitForFunction(()=>!window.workbenchSourceEditor);await page.evaluate(()=>window.sourceProbe.open());
 await page.locator('[data-source-id="fixture-b"]').click();assert.equal(await page.locator('#source-hardware-board').inputValue(),'MATX');
 await visibleKind('fixture-case','case');await page.locator('#source-hardware-case-MATX').check();await page.locator('#source-hardware-case-ITX').check();await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===3);
 await page.locator('#source-hardware').evaluate(el=>el.scrollIntoView({block:'center'}));
 await page.locator('#source-hardware').screenshot({path:fileURLToPath(new URL('hardware-view-case.png',out))});
 let row=(await page.evaluate(()=>window.sourceProbe.state())).sourceCatalog.find(r=>r.sourceId==='fixture-case');assert.deepEqual(row.hardwareOverrides.caseBoards,['MATX','ITX']);
 await page.locator('#source-hardware-case-MATX').uncheck();await page.locator('#source-hardware-case-ITX').uncheck();await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===4);
 row=(await page.evaluate(()=>window.sourceProbe.state())).sourceCatalog.find(r=>r.sourceId==='fixture-case');assert.equal(row.hardwareOverrides,undefined);
 await visibleKind('fixture-b','board');await page.locator('#source-hardware-board').selectOption('');await page.locator('#source-save-all').click();await page.waitForFunction(()=>window.sourceProbe.writes.length===5);
 assert.equal((await page.evaluate(()=>window.sourceProbe.state())).sourceCatalog.find(r=>r.sourceId==='fixture-b').hardwareOverrides,undefined);
 assert.deepEqual((await page.evaluate(()=>window.sourceProbe.state())).sourceCatalog.find(r=>r.sourceId==='fixture-a').capacityOverrides,{memoryGb:48});
 await page.locator('#source-hardware').evaluate(el=>el.scrollIntoView({block:'center'}));
 await page.locator('#source-hardware').screenshot({path:fileURLToPath(new URL('hardware-view-board.png',out))});
 await page.setViewportSize({width:850,height:900});await visibleKind('fixture-case','case');
 await page.locator('#source-hardware').evaluate(el=>el.scrollIntoView({block:'center'}));
 await page.locator('#source-hardware').screenshot({path:fileURLToPath(new URL('hardware-view-narrow.png',out))});
 await page.evaluate(()=>{document.documentElement.dataset.workbenchTheme='dark';document.documentElement.classList.add('dark');});
 await page.locator('#source-hardware').evaluate(el=>el.scrollIntoView({block:'center'}));
 await page.locator('#source-hardware').screenshot({path:fileURLToPath(new URL('hardware-view-dark.png',out))});

 const poster=await page.evaluate(async()=>{
 const {blankConfig}=await import('/workbench/core.js');const {renderPoster}=await import('/workbench/poster.js');
 const c=blankConfig(null,{id:'p',name:'隔离搭配',shopId:'intel',configs:[]});c.caseImage='';c.addedImages=[];
 c.parts=[{slot:'主板',goodsId:'1',name:'B760M',qty:1,upgrade:'【+100元升级ATX大板】【+50元升级B760M】'},{slot:'机箱',goodsId:'2',name:'机箱 M-ATX',qty:1}];c.actualParts=structuredClone(c.parts);
 c.addons=[{text:'【+100元升级ATX大板】',hardwareFacts:{boardType:'ATX'},note:'不应留下备注'}];
 const checks=[];for(const layout of ['long','square']){c.layout=layout;c.skuMode='dedicated';const r=await renderPoster(c,700,{interactive:true});const values=r.textRegions.map(x=>x.value).join(' ');checks.push({layout,hidden:!values.includes('ATX大板')&&!values.includes('不应留下备注'),kept:values.includes('升级B760M')});}
 return checks;});assert.ok(poster.every(p=>p.hidden&&p.kept),JSON.stringify(poster));
 assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[]);
 await fs.writeFile(new URL('hardware-ui-result.json',out),JSON.stringify({passed:true,checks:['six component types show only matching fields','hidden existing values preserved','CPU save','board select persist reopen','case multi-select persist','clear restores auto','no console errors'],errors},null,2));
 console.log('hardware UI passed');
}finally{await browser.close();}
