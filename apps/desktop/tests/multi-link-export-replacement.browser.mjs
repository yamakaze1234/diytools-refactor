/** 库存和全店配件多任务验收：真实 React/业务页面，接口只使用合成数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const output=process.env.EXPORT_REGRESSION_OUTPUT||'D:/diytools/sandbox/workbench-regression-finish-20261120/multi-link-export';
await fs.mkdir(output,{recursive:true});

const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/2)}`,name:`隔离链接${Math.floor(i/2)}`,shopId:'intel',spu:`380000000000000000${Math.floor(i/2)}`,configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'验收CPU',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'验收内存',erp:220,tax:240}];
state.sourceCatalog.push({shopId:'intel',sourceId:'new-cpu',goodsId:'2001',name:'替换CPU',erp:900,tax:950},{shopId:'intel',sourceId:'new-memory',goodsId:'2002',name:'替换内存',erp:330,tax:350});
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:p.goodsId.startsWith('2')?100:0}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);Object.assign(c.parts[3],state.sourceCatalog[1]);Object.assign(c.actualParts[3],state.sourceCatalog[1]);c.actualParts[3].qty=2;c.parts[0].upgrade='旧CPU文案';c.parts[3].upgrade='旧内存文案';}
// 已保存配置可以各自采用不同 SKU 样式，默认导出应尊重每套配置的选择。
state.configs[0].skuExportMode='dedicated';state.configs[0].skuMode='dedicated';
const initial=structuredClone(state);
const errors=[],requests=[],blocked=[],browser=await chromium.launch({channel:'msedge',headless:true});let activePage;
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;activePage=page;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==new URL(base).origin){blocked.push(url.origin);return route.abort();}return route.continue();});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/upgrade-tasks-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nimport {imageExportTasks as fixtureImageTasks} from './image-export-tasks.js';window.memoryProbe={snapshot:()=>structuredClone(state),tasks:()=>fixtureImageTasks().map(task=>({id:task.id,title:task.title,phase:task.phase}))};`}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;requests.push({method:req.method(),path,ids:payload?.ids});let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=state;value={revision:state.revision,updatedAt:state.updatedAt,metadata,summaries:configs.map(summaryOf)};}
  else if(path==='/api/configs/load')value={revision:state.revision,configs:state.configs.filter(c=>payload.ids.includes(c.id))};
  else if(path==='/api/state'&&req.method()==='GET')value=state;
  else if(path==='/api/state'&&req.method()==='POST'){state={...state,...Object.fromEntries(['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'].map(key=>[key,structuredClone(payload[key])])),revision:state.revision+1,updatedAt:new Date().toISOString()};value={...state,state:structuredClone(state)};}
  else if(['/api/configs/patch','/api/configs/batch'].includes(path)){const saved=payload.changes.map(c=>structuredClone(c.after));state.configs=state.configs.map(c=>saved.find(s=>s.id===c.id)||c);state.revision++;value={configs:saved,revision:state.revision,updatedAt:new Date().toISOString(),activityDelta:[]};}
  else if(path==='/api/cost-sync/settings')value=state.costSync||{mode:'cloud',path:'',sheet:'库存数据',goodsColumn:54,taxColumn:67};
  else if(path==='/api/price-changes/list')value={batches:[]};
  else if(path==='/api/session')value={defaultOperator:'内存隔离验收'};
  else if(path==='/api/native-cloud/status')value={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  else if(path==='/api/derived/status')value={images:[],running:false};
  await route.fulfill({json:value});
 });
 await page.goto(base+'/workbench/upgrade-tasks-fixture');await page.waitForFunction(()=>window.workbenchReady);
 await page.locator('[data-product-toggle="p0"] .link-arrow').click();await page.locator('[data-id="c0"]').click();




 const results=[];
 assert.equal(await page.locator('#image-export-sku-mode').inputValue(),'saved');
 await page.locator('.config-item[data-id="c0"] input[type=checkbox]').check();
 await page.locator('[data-product-toggle="p1"] .link-arrow').click();
 await page.locator('.config-item[data-id="c2"] input[type=checkbox]').check();
 assert.match(await page.locator('#selected-count').innerText(),/2/);
 await page.locator('#link-parts').click();
 await page.locator('#link-part-query').waitFor({timeout:5000});
 await page.locator('#link-part-scope').selectOption('selected');
 assert.match(await page.locator('#link-part-scope-summary').innerText(),/2 套配置.*2 个链接/);
 await page.locator('#link-part-query').fill('验收CPU');
 await page.locator('#link-part-match').selectOption({label:'验收CPU · 2 套配置'});
 await page.locator('#link-part-new-query').fill('2001');
 await page.locator('#link-part-new [data-product-id]').click();
 await page.locator('#link-part-add-replace').click();
 assert.equal(await page.locator('[data-rule-title]').count(),2);
 await page.locator('[data-rule-remove]').last().click();
 await page.locator('#link-part-preview').click();
 assert.match(await page.locator('#link-part-status').innerText(),/将修改 2 套配置/);
 assert.equal(await page.locator('#link-part-apply').isEnabled(),true);
 await page.locator('#link-part-add-new').click();
 assert.equal(await page.locator('[data-rule-mode]').last().inputValue(),'add');
 assert.equal(await page.locator('#link-part-apply').isEnabled(),false);
 results.push('cross-link search, replacement, add/remove task, preview invalidation');
 await page.locator('#dialog .close').click();
 const sessions=new Map();let counter=0;
 await page.exposeFunction('nativeExportFixture',async payload=>{
  if(payload.phase==='begin'){
   const token=String(++counter),directory=output+'/export-'+token;await fs.mkdir(directory,{recursive:true});
   sessions.set(token,{directory,files:[]});return {ok:true,token,directory};
  }
  const s=sessions.get(payload.token);assert.ok(s);
  if(payload.phase==='append')for(const f of payload.files){
   const parts=f.name.split('/');
   assert.ok(parts.length<=2&&parts.every(p=>p&&p!=='.'&&p!=='..'&&!/[\\:]/.test(p)),'native export rejects path: '+f.name);
   if(parts.length===2)await fs.mkdir(s.directory+'/'+parts[0],{recursive:true});
   const bytes=Buffer.from(f.base64,'base64');await fs.writeFile(s.directory+'/'+f.name,bytes);s.files.push(f.name);
   if(f.name.endsWith('.png')){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.length>10000);}
  }
  return {ok:true,...s};
 });
 await page.evaluate(()=>{window.pywebview={api:{export_image_folder_session:payload=>window.nativeExportFixture(payload)}};});
 for(const mode of ['saved','dedicated','padded']){
  // 总表预览的“自由编辑”是当前真实可见导出入口，不能点击被收起的旧控件。
  if(!await page.locator('#image-export-kind').isVisible())await page.locator('#preview-expand').click();
  await page.locator('#image-export-kind').selectOption('both');
  await page.locator('#image-export-sku-mode').selectOption(mode);
  const priorTasks=await page.evaluate(()=>window.memoryProbe.tasks().map(task=>task.id));
  await page.locator('#batch-export').click();
  await page.waitForFunction(ids=>window.memoryProbe.tasks().some(task=>!ids.includes(task.id)),priorTasks,{timeout:45000});
  const task=await page.evaluate(async ids=>{const t=(await import('/workbench/image-export-tasks.js')).imageExportTasks().find(task=>!ids.includes(task.id));await t.done;return {phase:t.phase,files:t.items.map(i=>({name:i.name,state:i.state})),message:t.message};},priorTasks);
  assert.equal(task.phase,'completed',JSON.stringify(task));assert.equal(task.files.length,4);assert.ok(task.files.every(f=>f.state==='saved'));
  assert.equal(sessions.get(String(counter)).files.filter(n=>n.endsWith('.png')).length,4);
  // 从真实写出的导出清单核对渲染快照，不依赖已释放的任务内部对象。
  const report=JSON.parse(await fs.readFile(sessions.get(String(counter)).directory+'/导出清单.json','utf8'));
  const saved=await page.evaluate(()=>window.memoryProbe.snapshot());
  if(mode==='saved'){
   assert.deepEqual(saved.configs,initial.configs,'按配置样式导出不得修改配置');
   assert.equal(requests.filter(r=>r.method==='POST'&&['/api/state','/api/configs/batch','/api/configs/patch'].includes(r.path)).length,0);
   assert.deepEqual(report.entries.filter(e=>e.layout==='square').map(e=>e.skuMode),['dedicated','padded']);
  }else{
   for(const id of ['c0','c2'])assert.deepEqual(saved.configs.find(c=>c.id===id),{...initial.configs.find(c=>c.id===id),skuExportMode:mode,skuMode:mode});
   for(const id of ['c1','c3'])assert.deepEqual(saved.configs.find(c=>c.id===id),initial.configs.find(c=>c.id===id));
   assert.ok(report.entries.filter(e=>e.layout==='square').every(e=>e.skuMode===mode));
  }
  results.push('two links, four real PNG files, SKU '+mode);
 }
 // 同一可见维护入口真正应用跨链接替换，再从保存结果导出，不能只验证预览。
 if(await page.locator('.preview-side.preview-expanded').count())await page.locator('#preview-expand').click();
 await page.locator('#link-parts').click();await page.locator('#link-part-scope').selectOption('selected');
 await page.locator('#link-part-query').fill('验收CPU');await page.locator('#link-part-match').selectOption({label:'验收CPU · 2 套配置'});
 await page.locator('#link-part-new-query').fill('2001');await page.locator('#link-part-new [data-product-id]').click();
 await page.locator('#link-part-preview').click();await page.locator('#link-part-apply').click();
 await page.locator('#link-part-export').waitFor();
 const replaced=await page.evaluate(()=>window.memoryProbe.snapshot());
 for(const id of ['c0','c2'])for(const field of ['parts','actualParts'])assert.equal(replaced.configs.find(c=>c.id===id)[field][0].goodsId,'2001');
 for(const id of ['c1','c3'])assert.deepEqual(replaced.configs.find(c=>c.id===id),initial.configs.find(c=>c.id===id));
 await page.locator('#link-part-export-kind').selectOption('both');await page.locator('#link-part-export-scope').selectOption('changed');
 await page.locator('#link-part-sku-mode').selectOption('padded');await page.locator('#link-part-export').click();
 await page.waitForFunction(()=>window.memoryProbe.tasks().some(task=>task.title==='批量修改后导图'),null,{timeout:45000});
 const replacementTask=await page.evaluate(async()=>{const task=(await import('/workbench/image-export-tasks.js')).imageExportTasks().filter(task=>task.title==='批量修改后导图').at(-1);await task.done;return {phase:task.phase,count:task.items.length,title:task.title,states:task.items.map(item=>item.state),directory:task.directory};});
 assert.equal(replacementTask.title,'批量修改后导图',JSON.stringify(replacementTask));
 assert.equal(replacementTask.phase,'completed',JSON.stringify(replacementTask));assert.equal(replacementTask.count,4);
 assert.ok(replacementTask.states.every(state=>state==='saved'),JSON.stringify(replacementTask));
 assert.equal(counter,4,JSON.stringify(replacementTask));assert.equal(sessions.get(String(counter)).files.filter(name=>name.endsWith('.png')).length,4);
 results.push('applied cross-link display/actual replacement, saved selected configurations, exported four PNG files');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 const result={status:'passed',productionAccess:false,results,outputs:[...sessions.values()],errors,blocked};
 await fs.writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){const ui=await activePage?.evaluate(()=>({status:document.querySelector('#link-part-status')?.textContent,tasks:window.memoryProbe?.tasks(),toast:document.querySelector('#toast')?.textContent})).catch(()=>null);await activePage?.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});await fs.writeFile(output+'/failure.json',JSON.stringify({error:error.stack,errors,requests,ui},null,2));console.error(JSON.stringify({ui}));throw error;}finally{await browser.close();}
