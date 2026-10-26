/** 自由编辑布局、裁切坐标和编辑回读；所有接口仅使用隔离样本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5201';
const output=new URL('../../../../',import.meta.url);
const configs=Array.from({length:3},(_,i)=>{
 const c=blankConfig(null,{id:'p0',name:'自由编辑隔离样本',shopId:'intel',spu:'',configs:[]},`配置${i+1}`);
 c.id=`c${i}`;c.price=5000;c.parts[0].name='Intel Core Ultra 5 245KF';return c;
});
let state=normalizeWorkspaceState({revision:1,configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{}},logs:[]},[]);
const errors=[],requests=[],layouts=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const top=await browser.newPage({viewport:{width:1800,height:1000},bypassCSP:true});
 top.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await top.route('**/workbench/free-editor-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await top.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.editorProbe={snapshot:()=>structuredClone(state),geometry:()=>({base:previewResult.base,height:previewResult.height,content:previewResult.previewContentRect,regions:previewResult.textRegions}),padded:()=>{checkpointConfig();current().layout='square';current().skuMode='padded';changed('验收补白布局');renderAll();},detail:()=>{current().layout='long';changed('验收详情布局');renderAll();},save:()=>save()};`}));
 await top.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await top.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;
  requests.push({path,method:req.method()});let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...payload,revision:state.revision+1};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,activityDelta:[]};}
  else if(path==='/api/session')value={defaultOperator:'自由编辑隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 // 真实 React 宿主和 iframe，复现主表粘性表头与编辑浮层的叠放关系。
 await top.route('**/workbench/free-editor-host',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><script src="/workbench/endfield-init.js"></script><link rel="stylesheet" href="/workbench/endfield/endfield.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"><script type="module" src="/workbench/endfield-theme.js"></script><style>html,body,#root{height:100%;margin:0}</style><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;window.isTauri=true;window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async(command)=>command==='cloud_native_json_request'?{status:200,body:JSON.stringify({configured:false})}:1};const {default:App}=await import('/src/App.tsx');window.installWorkbenchBridge=async()=>{};const host=document.createElement('div');host.id='root';document.body.append(host);createRoot(host).render(React.createElement(App));</script>`}));
 await top.route('**/workbench/index.html',r=>r.fulfill({contentType:'text/html',body:html}));
 await top.goto(base+'/workbench/free-editor-host');
 await top.locator('iframe').waitFor();const page=await top.locator('iframe').elementHandle().then(h=>h.contentFrame());
 await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();
 await page.waitForFunction(()=>document.querySelector('#poster-object-select').options.length>3);
 const before=await page.evaluate(()=>window.editorProbe.snapshot());
 await page.locator('#preview-expand').click();
 for(const theme of ['light','dark'])for(const width of [2560,1440,1000,720,400]){
  await top.setViewportSize({width,height:width===400?850:1000});
  if(await page.evaluate(()=>document.documentElement.dataset.workbenchTheme)!==theme){await page.locator('#preview-expand').click();await page.locator('#workbench-theme-toggle').click();await page.locator('#preview-expand').click();}
  assert.equal(await page.locator('#workbench-theme-toggle').innerText(),theme==='dark'?'浅色界面':'深色界面');
  assert.equal(await top.evaluate(()=>document.documentElement.dataset.workbenchTheme),theme);
  await page.waitForTimeout(100);
  const result=await page.evaluate(()=>{
   const root=document.querySelector('.preview-side'),canvas=document.querySelector('#preview-scroll'),settings=document.querySelector('.preview-settings-panel'),r=el=>el.getBoundingClientRect();
   const controls=[...document.querySelectorAll('[data-preview-fit],#download,#batch-export')].map(el=>({id:el.id||el.dataset.previewFit,width:r(el).width,height:r(el).height,bottom:r(el).bottom}));
   const view=r(root),work=r(document.querySelector('.preview-workspace'));
   const s=r(canvas),hits=[[s.left+5,s.top+5],[s.right-5,s.bottom-5],[s.left+s.width/2,s.top+s.height/2]].map(([x,y])=>!!document.elementFromPoint(x,y)?.closest('.preview-side'));
   return {width:innerWidth,theme:document.documentElement.dataset.workbenchTheme,root:{right:view.right,bottom:view.bottom},work:{width:work.width,overflow:document.querySelector('.preview-workspace').scrollWidth>work.width+2},canvas:{width:s.width,height:s.height},settings:{left:r(settings).left,top:r(settings).top},controls,hits,z:Number(getComputedStyle(root).zIndex)};
  });
  assert.ok(result.z>45&&result.hits.every(Boolean),JSON.stringify(result));
  assert.ok(!result.work.overflow&&result.root.right<=width&&result.root.bottom<=(width===400?850:1000),JSON.stringify(result));
  assert.ok(result.canvas.width>100&&result.canvas.height>120,JSON.stringify(result));
  assert.ok(result.controls.every(c=>c.height>=28&&c.height<70&&c.width>30&&c.bottom<=result.root.bottom),JSON.stringify(result));
  await page.locator('.canvas-tools>summary').click();
  assert.ok(await page.locator('#poster-object-select').isVisible());
  await page.locator('.canvas-tools>summary').click();
  layouts.push(result);
 }
 assert.deepEqual((await page.evaluate(()=>window.editorProbe.snapshot())).configs,before.configs);
 await top.setViewportSize({width:1440,height:1000});
 await page.locator('.canvas-tools>summary').click();
 await page.locator('#poster-object-select').selectOption({index:2});
 await page.locator('#poster-text-content').waitFor();
 await page.locator('#poster-text-content').fill('自由编辑文字与坐标验收');await page.locator('#poster-text-content').press('Tab');
 await page.waitForFunction(()=>Object.values(window.editorProbe.snapshot().configs[0].textStyles||{}).some(s=>s.text==='自由编辑文字与坐标验收'));
 await page.evaluate(()=>window.editorProbe.save());
 assert.ok(Object.values(state.configs[0].textStyles).some(s=>s.text==='自由编辑文字与坐标验收'));
 await page.locator('#poster-undo').click();await page.evaluate(()=>window.editorProbe.save());
 assert.ok(!Object.values(state.configs[0].textStyles||{}).some(s=>s.text==='自由编辑文字与坐标验收'));
 await page.locator('#poster-redo').click();await page.evaluate(()=>window.editorProbe.save());
 assert.ok(Object.values(state.configs[0].textStyles).some(s=>s.text==='自由编辑文字与坐标验收'));
 await page.evaluate(()=>window.editorProbe.padded());
 await page.waitForFunction(()=>window.editorProbe.geometry()?.content&&document.querySelector('#poster-stage').style.overflow==='hidden');
 assert.equal(await page.locator('.canvas-tools').isVisible(),false);
 const paddedReadOnly=await page.evaluate(()=>window.editorProbe.geometry().regions.length===0);assert.ok(paddedReadOnly);
 await page.evaluate(()=>window.editorProbe.detail());
 await page.waitForFunction(()=>!document.querySelector('.canvas-tools').classList.contains('hidden')&&window.editorProbe.geometry().regions.length>0);
 await page.locator('#poster-object-select').selectOption({index:2});
 const selectedKey=await page.locator('#poster-object-select').inputValue();
 const checkSelection=async()=>{
  // 缩放选框在下一帧更新，先等待画布与选框坐标一致。
  await page.waitForFunction(key=>{const g=window.editorProbe.geometry(),r=g.regions.find(r=>r.key===key),c=document.querySelector('#poster').getBoundingClientRect(),b=document.querySelector('#poster-selection').getBoundingClientRect();return r&&Math.abs(b.left-c.left-r.x/g.base*c.width)<2&&Math.abs(b.top-c.top-r.top/g.height*c.height)<2&&Math.abs(b.width-r.width/g.base*c.width)<2;},selectedKey,{timeout:5000});
  const delta=await page.evaluate(key=>{
   const g=window.editorProbe.geometry(),region=g.regions.find(r=>r.key===key),canvas=document.querySelector('#poster').getBoundingClientRect(),box=document.querySelector('#poster-selection').getBoundingClientRect();
   return {x:Math.abs(box.left-(canvas.left+region.x/g.base*canvas.width)),y:Math.abs(box.top-(canvas.top+region.top/g.height*canvas.height)),width:Math.abs(box.width-region.width/g.base*canvas.width)};
  },selectedKey);
  assert.ok(delta.x<2&&delta.y<2&&delta.width<2,JSON.stringify(delta));return delta;
 };
 const contentSelection=await checkSelection();
 await page.locator('#poster-zoom').selectOption('fit');const fitSelection=await checkSelection();
 await page.locator('#poster-zoom').selectOption('125');const zoomSelection=await checkSelection();
 // 指针拖动与键盘移动必须继续映射到图片坐标，撤销后回到原位置。
 await page.locator('#poster-zoom').selectOption('content');await page.locator('.canvas-tools>summary').click();
 const regionBefore=await page.evaluate(key=>window.editorProbe.geometry().regions.find(r=>r.key===key),selectedKey);
 const selection=await page.locator('#poster-selection').boundingBox();
 await top.mouse.move(selection.x+selection.width/2,selection.y+selection.height/2);await top.mouse.down();await top.mouse.move(selection.x+selection.width/2+18,selection.y+selection.height/2+12,{steps:5});await top.mouse.up();
 await page.waitForTimeout(150);
 const regionAfter=await page.evaluate(key=>window.editorProbe.geometry().regions.find(r=>r.key===key),selectedKey);
 assert.ok(Math.abs(regionAfter.x-regionBefore.x)>1||Math.abs(regionAfter.top-regionBefore.top)>1);
 await page.locator('#poster-stage').press('ArrowRight');await page.waitForTimeout(100);await checkSelection();
 await top.screenshot({path:new URL('free-editor-browser-dark.png',output).pathname.replace(/^\/([A-Z]:)/i,'$1')});
 await page.locator('#preview-expand').click();
 assert.ok(!await page.locator('.preview-expanded').count());
 assert.ok(await page.locator('#preview-scroll').isVisible());
 await page.locator('#preview-expand').click();await page.locator('.preview-config-nav button').last().click();
 await page.waitForFunction(()=>document.querySelector('#poster-inspector').classList.contains('hidden'));
 await page.locator('#poster-stage').press('Escape');assert.equal(await page.locator('.preview-expanded').count(),0);
 assert.deepEqual(errors,[]);
 const result={passed:true,layouts,paddedReadOnly,contentSelection,fitSelection,zoomSelection,editSaveUndoRedo:true,dragAndKeyboard:true,configurationSwitch:true,errors,isolatedRequests:requests.length};
 await fs.writeFile(new URL('free-editor-result.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
