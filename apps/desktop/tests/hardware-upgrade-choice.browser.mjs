/** 真实工作台业务函数 + React 编辑器的隔离无窗口验收；接口仅写内存合成数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5194';
const product={id:'product-test',name:'隔离验收链接',shopId:'intel',spu:'12345678901234567890',installment:0,configs:[]};
const config=blankConfig(null,product,'隔离配置');config.id='config-test';config.price=5000;config.parts=config.parts.slice(0,2);config.parts[0]={slot:'CPU',sourceId:'source-cpu',name:'测试CPU',goodsId:'11111111111111111111',qty:1,erp:100,tax:120,upgrade:''};config.parts[1]={slot:'内存',name:'测试内存',goodsId:'22222222222222222222',qty:1,erp:50,tax:60,upgrade:''};config.actualParts=structuredClone(config.parts);config.addons=[{text:'升级选项',note:'原备注',choices:[{id:'choice-test',goodsId:'',qty:1,originalQty:1,priceCents:null,label:'仅文字原方案',enabled:true}]}];
config.parts.push({slot:'主板',goodsId:'board',name:'B760M',qty:1,upgrade:'【升级Z890】'},{slot:'机箱',goodsId:'case',name:'M-ATX 机箱',qty:1});config.addons=[{text:'【升级Z890主板】'}];
const template=structuredClone(config);Object.assign(template,{id:'template-test',productId:'template-group',product:'验收模板组',productCategory:'主机模板',name:'模板配置'});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs:[config,template],sourceCatalog:[{sourceId:'source-cpu',shopId:'intel',slot:'CPU',name:'测试CPU',goodsId:'11111111111111111111',erp:100,tax:120}],costSource:[{goodsId:'11111111111111111111',name:'测试CPU',erp:100,tax:120},{goodsId:'22222222222222222222',name:'测试内存',erp:50,tax:60}],templates:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
const receipts=[],errors=[];let delayed=0;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({bypassCSP:true,viewport:{width:1500,height:1100}});page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE',error.stack);});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/editor-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname,payload=request.method()==='POST'?request.postDataJSON():null;let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&request.method()==='GET')value=state;
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const configs=payload.changes.map(change=>structuredClone(change.after));state.configs=state.configs.map(c=>configs.find(after=>after.id===c.id)||c);state.revision++;state.updatedAt=new Date().toISOString();value={configs,revision:state.revision,updatedAt:state.updatedAt,activityDelta:[]};receipts.push({path,payload});if(delayed){const ms=delayed;delayed=0;await new Promise(resolve=>setTimeout(resolve,ms));}}
  else if(path==='/api/state'&&request.method()==='POST'){state={...structuredClone(payload),revision:state.revision+1,updatedAt:new Date().toISOString(),logs:[]};delete state.baseState;delete state.baseRevision;value={state,revision:state.revision,updatedAt:state.updatedAt,logs:[]};receipts.push({path,payload});}
  else if(path==='/api/session')value={defaultOperator:'隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/editor-fixture');await page.waitForFunction(()=>window.workbenchReady===true).catch(async error=>{console.error(await page.locator('#save-status').textContent(),await page.locator('#editor').textContent());throw error;});
 await page.locator('[data-product-toggle="product-test"]').click();await page.locator('[data-id="config-test"]').click();await page.locator('.tabs [data-tab="display"]').click();await page.locator('[data-react-editor="parts"]').waitFor();

 const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>!window.workbenchHasPendingChanges());};
 await page.locator('[data-tab="addons"]').click();
 assert.equal(await page.locator('[data-upgrade="2"]').inputValue(),'');
 await page.locator('[data-hardware-upgrade="2"]').selectOption('use');
 assert.equal(await page.locator('[data-upgrade="2"]').inputValue(),'【升级Z890】');
 assert.equal(await page.locator('[data-hardware-upgrade="2"]').count(),1);
 await page.locator('[data-hardware-addon="0"]').selectOption('use');await save();
 assert.ok(state.configs.find(c=>c.id==='config-test').parts[2].hardwareUpgradeConfirmed);
 assert.ok(state.configs.find(c=>c.id==='config-test').addons[0].hardwareUpgradeConfirmed);
 await page.reload();await page.waitForFunction(()=>window.workbenchReady===true);
 if(await page.locator('[data-id="config-test"]').count()===0)await page.locator('[data-product-toggle="product-test"]').click();
 await page.locator('[data-id="config-test"]').click();await page.locator('[data-tab="addons"]').click();
 assert.equal(await page.locator('[data-hardware-upgrade="2"]').inputValue(),'use');
 assert.equal(await page.locator('[data-hardware-addon="0"]').inputValue(),'use');
 assert.equal(await page.locator('[data-upgrade="2"]').inputValue(),'【升级Z890】');
 await page.locator('[data-hardware-upgrade="2"]').selectOption('');await save();
 assert.equal(await page.locator('[data-upgrade="2"]').inputValue(),'');
 await page.locator('#undo').click();await save();
 assert.equal(await page.locator('[data-upgrade="2"]').inputValue(),'【升级Z890】');
 await page.locator('[data-hardware-addon="0"]').selectOption('');await save();
 assert.equal(state.configs.find(c=>c.id==='config-test').addons[0].hardwareUpgradeConfirmed,undefined);
 // 真实 Canvas 绘图：核对详情图与 SKU 图使用同一手动选择结果。
 const drawing=await page.evaluate(async config=>{
  const {renderPoster}=await import('/workbench/poster.js');
  const {selectHardwareUpgrade}=await import('/workbench/hardware-upgrade.js');
  const original=CanvasRenderingContext2D.prototype.fillText,results=[];let texts=[];
  CanvasRenderingContext2D.prototype.fillText=function(text,...args){texts.push(String(text));return original.call(this,text,...args);};
  try{for(const layout of ['long','square']){config.layout=layout;config.showUpgrades=true;config.caseImage='';config.addons=[];
   for(const show of [false,true]){selectHardwareUpgrade(config.parts[2],config,show);texts=[];await renderPoster(config);results.push({layout,show,found:texts.join('').includes('升级Z890')});}
  }}finally{CanvasRenderingContext2D.prototype.fillText=original;}
  return results;
 },state.configs.find(c=>c.id==='config-test'));
 for(const result of drawing)assert.equal(result.found,result.show,JSON.stringify(result));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['手动展示','提示保留','加购选择','保存重载','切回默认','撤销恢复'],saveReceipts:receipts.length,drawing,errors}));
}finally{await browser.close();}
