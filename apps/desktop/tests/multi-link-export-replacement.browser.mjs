/** 库存和全店配件多任务验收：真实 React/业务页面，接口只使用合成数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5213';

const configs=Array.from({length:4},(_,i)=>{
 const product={id:`p${Math.floor(i/2)}`,name:`隔离链接${Math.floor(i/2)}`,shopId:'intel',spu:'',configs:[]};
 const c=blankConfig(null,product,`配置${i}`);c.id=`c${i}`;c.price=5000;return c;
});
let state=normalizeWorkspaceState({revision:1,updatedAt:new Date().toISOString(),configs,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{intel:{coupon:0}},logs:[]},[]);
state.configs.forEach((c,i)=>c.name='配置'+(i+1));
state.sourceCatalog=[{shopId:'intel',sourceId:'s-cpu',goodsId:'1001',name:'验收CPU',erp:800,tax:850},{shopId:'intel',sourceId:'s-memory',goodsId:'1002',name:'验收内存',erp:220,tax:240}];
state.sourceCatalog.push({shopId:'intel',sourceId:'new-cpu',goodsId:'2001',name:'替换CPU',erp:900,tax:950},{shopId:'intel',sourceId:'new-memory',goodsId:'2002',name:'替换内存',erp:330,tax:350});
state.costSource=state.sourceCatalog.map(p=>({...p,stockAvailable:p.goodsId.startsWith('2')?100:0}));
for(const c of state.configs){Object.assign(c.parts[0],state.sourceCatalog[0]);Object.assign(c.actualParts[0],state.sourceCatalog[0]);Object.assign(c.parts[3],state.sourceCatalog[1]);Object.assign(c.actualParts[3],state.sourceCatalog[1]);c.actualParts[3].qty=2;c.parts[0].upgrade='旧CPU文案';c.parts[3].upgrade='旧内存文案';}
const errors=[],requests=[],browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const topPage=await browser.newPage({viewport:{width:1500,height:1000},bypassCSP:true});let page=topPage;page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
 const html=(await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 await page.route('**/workbench/upgrade-tasks-fixture',r=>r.fulfill({contentType:'text/html',body:html}));
 const source=await fs.readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/app.js',r=>r.fulfill({contentType:'text/javascript',body:source+`\nwindow.memoryProbe={snapshot:()=>structuredClone(state),selectForTest:ids=>{selected=new Set(ids);},close:()=>closeDialog()};`}));
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
 await page.locator('[data-product-toggle="p0"]').click();await page.locator('[data-id="c0"]').click();




 const results=[];
 assert.equal(await page.locator('#image-export-sku-mode').inputValue(),'padded');
 await page.evaluate(()=>window.memoryProbe.selectForTest(['c0','c2']));
 await page.locator('#link-parts').evaluate(button=>button.click());
 await page.locator('#link-part-query').waitFor({timeout:5000});
 assert.equal(await page.locator('#link-part-sku-mode').inputValue(),'padded');
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
 await page.evaluate(()=>window.memoryProbe.close());
 const output=process.env.EXPORT_REGRESSION_OUTPUT;
 assert.ok(output,'EXPORT_REGRESSION_OUTPUT is required');
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
 for(const mode of ['dedicated','padded']){
  await page.locator('#image-export-kind').selectOption('both');
  await page.locator('#image-export-sku-mode').selectOption(mode);
  await page.locator('#batch-export').click();
  await page.waitForFunction(async count=>(await import('/workbench/image-export-tasks.js')).imageExportTasks().length>=count,mode==='dedicated'?1:2,{timeout:45000});
  const task=await page.evaluate(async()=>{const t=(await import('/workbench/image-export-tasks.js')).imageExportTasks().at(-1);await t.done;return {phase:t.phase,files:t.items.map(i=>({name:i.name,state:i.state})),message:t.message};});
  assert.equal(task.phase,'completed',JSON.stringify(task));assert.equal(task.files.length,4);assert.ok(task.files.every(f=>f.state==='saved'));
  assert.equal(sessions.get(String(counter)).files.filter(n=>n.endsWith('.png')).length,4);
  results.push('two links, four real PNG files, SKU '+mode);
 }
 assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.method==='POST'&&['/api/state','/api/configs/batch','/api/configs/patch'].includes(r.path)).length,0);
 console.log(JSON.stringify({status:'passed',results,outputs:[...sessions.values()]}));
}finally{await browser.close();}
