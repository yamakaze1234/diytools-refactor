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
 await page.locator('[data-product-toggle="product-test"]').click();await page.locator('[data-id="config-test"]').click();await page.locator('[data-react-editor="parts"]').waitFor();
 const save=async()=>{await page.locator('#save').click();await page.waitForFunction(()=>!window.workbenchHasPendingChanges());};
 const live=()=>state.configs.find(c=>c.id==='config-test');
 await page.locator('[data-qty="0"]').fill('2');await save();assert.equal(live().parts[0].qty,2);assert.equal(live().actualParts[0].qty,2);
 await page.locator('[data-display-name="0"]').fill('自定义展示CPU');await page.locator('[data-qty="0"]').focus();await save();assert.equal(live().parts[0].displayName,'自定义展示CPU');
 await page.locator('[data-poster-visible="0"]').uncheck();await save();assert.equal(live().parts[0].posterVisible,false);
 await page.locator('[data-part-drag]').first().focus();await page.keyboard.press('ArrowDown');await save();assert.equal(live().parts[1].slot,'CPU');
 await page.locator('[data-tab="actual"]').click();await page.locator('[data-qty="0"]').fill('3');await save();assert.equal(live().actualParts[0].qty,3);assert.notEqual(live().parts.find(p=>p.slot===live().actualParts[0].slot).qty,3);
 await page.locator('[data-tab="addons"]').click();await page.locator('[data-upgrade="0"]').fill('隔离升级文案');await page.locator('#add-benefit').click();await page.locator('[data-benefit="0"]').fill('隔离福利');await save();assert.equal(live().benefits[0].text,'隔离福利');
 await page.locator('[data-edit-addon="0"]').click();await page.locator('[data-choice-label]').fill('React多项加购');await page.locator('[data-choice-add]').click();await page.locator('[data-choice-label]').last().fill('第二项福利');await page.locator('[data-choice-add]').click();await page.locator('[data-choice-label]').last().fill('临时选项');await page.locator('[data-choice-remove]').last().click();await page.locator('#addon-edit-save').click();await save();assert.equal(live().addons[0].choices.length,2);assert.equal(live().addons[0].choices[0].label,'React多项加购');
 await page.locator('#add-addon').click();await page.locator('[data-addon-text]').fill('测试独立加购');await page.locator('[data-addon-note]').fill('保留备注');await page.locator('[data-addon-price]').fill('1.234');assert.match(await page.locator('[data-addon-check]').textContent(),/最多两位/);await page.locator('[data-addon-price]').fill('12.34');assert.doesNotMatch(await page.locator('[data-addon-check]').textContent(),/最多两位/);await page.locator('#addon-edit-save').click();await save();assert.equal(live().addons[1].text,'测试独立加购');
 await page.locator('[data-tab="modules"]').click();await page.locator('#shop-title').fill('验收店铺标题');await page.locator('#footer-text').fill('验收页脚');await page.locator('#add-module').click();const custom=page.locator('[data-custom-text]').last();await custom.fill('新增模块正文');await save();assert.equal(live().footer,'验收页脚');assert.equal(live().modules.at(-1).text,'新增模块正文');
 await page.locator('[data-move]').last().evaluate(node=>node.previousElementSibling.click());await save();assert.equal(live().modules.at(-2).text,'新增模块正文');
 await page.locator('[data-tab="costs"]').click();await page.locator('[data-config-cost="0"]').click();await page.locator('#config-cost-value').fill('321.45');await page.locator('#config-cost-save').click();await save();assert.equal(live().actualParts[0].taxOverride.value,321.45);
 await page.locator('[data-config-cost-reset="0"]').click();await save();assert.equal(live().actualParts[0].taxOverride,undefined);
 // 保存回执到达时仍在输入，验证节点、组合串和光标保持，同时下一批保存最终文字。
 await page.locator('[data-tab="modules"]').click();delayed=400;await page.locator('#footer-text').fill('先保存');await page.locator('#save').click();await page.locator('#footer-text').evaluate(node=>{window.__inputNode=node;node.focus();node.value='中文组合中';node.setSelectionRange(2,4);node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));node.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
 await page.waitForTimeout(600);assert.equal(await page.locator('#footer-text').evaluate(node=>node===window.__inputNode&&node.value==='中文组合中'&&node.selectionStart===2&&node.selectionEnd===4),true);await page.locator('#footer-text').dispatchEvent('compositionend');await save();assert.equal(live().footer,'中文组合中');
 await page.locator('#undo').click();await save();assert.notEqual(live().footer,'中文组合中');await page.locator('#redo').click();await save();assert.equal(live().footer,'中文组合中');
 await page.locator('#template-section-toggle').click();assert.equal(await page.locator('[data-react-templates] [data-template-product-toggle]').count(),1);await page.locator('[data-template-product-toggle="template-group"]').click();await page.locator('[data-template-config-id="template-test"]').click();await page.locator('[data-tab="parts"]').click();await page.locator('[data-qty="0"]').fill('4');await save();assert.equal(state.configs.find(c=>c.id==='template-test').parts[0].qty,4);
 await page.locator('[data-id="config-test"]').click();await page.locator('#add-template').click();await page.locator('[data-template-fold]').first().click();await page.locator('.template-choice').first().check();await page.locator('#template-use').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await save();assert.ok(state.configs.length>2);
 assert.deepEqual(errors,[]);assert.ok(receipts.length>10);console.log(JSON.stringify({status:'passed',scenarios:['展示数量及BOM联动','展示名称','图片可见性','键盘排序','独立BOM','升级福利','加购草稿与错误恢复','多项加购编辑','模块样式顺序','核算覆盖与恢复','延迟保存与中文组合光标','撤销重做','模板直接编辑','模板选择导入'],saveReceipts:receipts.length,configs:state.configs.length,errors},null,2));
}finally{await browser.close();}
