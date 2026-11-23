/** 在隔离三店 NAS 合成库上验证价格表、分批定价与配置图的实际入口。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../public/workbench/nas-api-client.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 NAS fixture 目录');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const root=await mkdtemp(join(tmpdir(),'diy-price-poster-nas-'));
const api=await startSourceAcceptance({fixture,root,authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const link=id=>'price-fix-'+id;
const row=(id,i)=>link(id)+'-'+i;
let browser;
try{
 const send=(path,options)=>fetch(api.url+path,{...options,headers:{...options?.headers,'x-workbench-deployment':fixtureDeployment}});
 const client=createNasApiClient({nativeRequest:send,shopId:'intel'});
 client.bindIdentity(fixtureWorkspace,fixtureActor);
 const copy='共用源散热升级标记';
 const {document:source,version}=await client.saveCatalog('shared-sources','9900791','create',{operation_id:randomUUID(),document:{
  id:'9900791',name:'浏览器验收散热',erpAdoption:{name:'浏览器验收散热',erp:95,stockAvailable:8,sku:'TEST'},
 }});
 await client.saveCatalog('shared-sources','9900791','replace',{operation_id:randomUUID(),expected_version:version,
  document:{id:'9900791',edits:{shared:{values:{tax:100,addon:{addonText:copy}},restore:[]}}}});
 const groups=[['a',4],['b',3],['c',36],['d',36],['e',36],['f',36]];
 for(const [index,[id,count]] of groups.entries()){
  await api.db.query("INSERT INTO intel_live.products(shop_id,product_id) VALUES('intel',$1)",[link(id)]);
  // 按降序写入以校验清单顺序确实由持久化序号确定。
  await api.db.query(`INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
   SELECT $1||'-'||i,'intel',$1,'配置'||i,'', '',$2+i,180000-i*1000,
    jsonb_build_object('product',$3::text,'version','配置'||i,'shortName','简称'||($4-i),'shortNameAuto',false,'showUpgrades',true),'{}'
   FROM generate_series($4,1,-1) AS i`,[link(id),10000+index*100,'验收链接 '+id,count]);
  await api.db.query(`INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
   SELECT configuration_id,kind,1,'fixture-cooler','散热',$2,$3,1,$4,$5
   FROM intel_live.configurations CROSS JOIN (VALUES ('display'),('actual')) AS t(kind) WHERE product_id=$1`,
   [link(id),'9900791','浏览器验收散热',source.sourceId,JSON.stringify({
    sourceFollow:{sourceId:source.sourceId,upgrade:{mode:'follow',value:'',sourceValue:'',textOnly:true}},
   })]);
 }
 // 用真实兼容字段模拟旧配置曾将同一输出源文案同步进 addons。
 const target=row('a',4);
 await api.db.query("INSERT INTO intel_live.addons(configuration_id,position,fields,items) VALUES($1,1,$2,'[]')",
  [target,JSON.stringify({text:copy,note:'',sourceId:source.sourceId})]);

 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1700,height:1040},bypassCSP:true,acceptDownloads:true});
 page.setDefaultTimeout(15000);
 const errors=[],details=[];
 let holdDetails=null;
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
 await page.addInitScript(()=>{
  const fill=CanvasRenderingContext2D.prototype.fillText;
  window.posterInk=[];
  CanvasRenderingContext2D.prototype.fillText=function(text,...args){
   window.posterInk.push(String(text));return fill.call(this,text,...args);
  };
 });
 const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8'))
  .replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
   import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;
   window.__vite_plugin_react_preamble_installed__=true;
   const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
   window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');
   document.body.classList.remove('login-required');
  </script>`);
 await page.route('**/workbench/price-poster-nas-fixture?*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'isolated-price-poster',deployment_id:fixtureDeployment}});
  if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
  const id=path.match(/\/configurations\/([^/]+)$/)?.[1];
  if(id&&req.method()==='GET'){details.push(id);await holdDetails?.(id);}
  const response=await send(path+url.search,{method:req.method(),headers:req.headers(),body:req.postData()??undefined});
  await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
 });
 await page.goto(base+'/workbench/price-poster-nas-fixture?workspace=nas');
 await page.waitForFunction(()=>window.workbenchReady===true);
 // 先点另一链接的最后一套，再点当前链接的最后一套，刻意改变详情缓存的先后顺序。
 const openLink=id=>page.locator(`[data-product-toggle="${link(id)}"] .link-arrow`).click();
 const openRow=id=>page.locator(`.config-item[data-id="${id}"]`).click();
 await openLink('b');await openRow(row('b',3));
 await openLink('a');
 await page.evaluate(()=>{window.posterInk=[];});
 await openRow(target);
 const sidebar=()=>page.locator('.config-item[data-id^="price-fix-"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
 const order=await sidebar();
 assert.deepEqual(order,[...Array.from({length:4},(_,i)=>row('a',i+1)),...Array.from({length:3},(_,i)=>row('b',i+1))]);
 await page.waitForFunction(copy=>window.posterInk.join('').includes(copy),copy);
 const checkDrawing=async()=>{
  const ink=await page.evaluate(()=>window.posterInk.join(''));
  assert.ok(ink.includes(copy),'配件对应行继续绘制共用源升级文字');
  assert.ok(!ink.includes('加购与选配'),'没有页签文案时不绘制加购模块');
 };
 await checkDrawing();
 await page.locator('[data-tab="addon-packs"]').click();
 await page.locator('#pack-text-mode').click();
 await page.locator('#pack-add-config-copy').waitFor();
 assert.deepEqual(await page.locator('#link-addon-editor [data-copy-field]').evaluateAll(fields=>fields.map(field=>field.value)),['','']);
 await page.locator('#image-export-kind').selectOption('long');
 await page.evaluate(()=>{window.posterInk=[];});
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
 assert.match(download.suggestedFilename(),/\.png$/);assert.equal(await download.failure(),null);
 await checkDrawing();
 await page.locator('[data-tab="parts"]').click();

 // 勾选未打开的链接，验证默认范围只补齐相关链接的详情。
 await page.locator(`.config-item[data-id="${row('b',3)}"] input`).check();
 await page.locator(`[data-group-select="${link('c')}"]`).check();
 const beforeBatch=details.length;
 const dialog=page.locator('#dialog');
 const defaultGate=Promise.withResolvers();
 holdDetails=id=>id.startsWith(link('c'))?defaultGate.promise:null;
 const batch=page.locator('#batch-profit-price');
 await Promise.all([
  page.waitForRequest(req=>req.method()==='GET'&&req.url().includes('/configurations/'+link('c')+'-')),
  batch.click(),
 ]);
 await batch.evaluate(button=>button.click());
 assert.equal(await batch.isDisabled(),true);
 assert.match(await batch.textContent(),/正在载入/);
 defaultGate.resolve();holdDetails=null;
 await dialog.waitFor();
 const defaultRequests=details.slice(beforeBatch);
 assert.ok(defaultRequests.some(id=>id.startsWith(link('c'))));
 assert.ok(defaultRequests.every(id=>['a','b','c'].some(key=>id.startsWith(link(key)))));
 const scope=key=>dialog.locator(`[name="bpp-scope"][value="${key}"]`);
 assert.match(await scope('link').locator('..').textContent(),/1 个链接 · 4 套/);
 assert.match(await scope('all').locator('..').textContent(),/15[1-9] 套/);
 await scope('link').check();
 await dialog.locator('#bpp-target').fill('200');
 await dialog.locator('#bpp-rows tr').first().waitFor();
 assert.equal(await dialog.locator('#bpp-rows tr').count(),4);
 const start=details.length,gate=Promise.withResolvers();
 holdDetails=()=>details.length-start>64?gate.promise:null;
 await scope('all').check();
 const progress=dialog.locator('#bpp-progress');
 await progress.waitFor();
 await page.waitForFunction(()=>Number(document.querySelector('#bpp-progress').textContent.match(/已载入 (\d+)/)?.[1])>=100);
 assert.equal(await dialog.locator('#bpp-apply').isDisabled(),true);
 await scope('link').check();
 assert.equal(await dialog.locator('#bpp-rows tr').count(),4);
 await scope('all').check();
 gate.resolve();holdDetails=null;
 await dialog.locator('#bpp-next').waitFor();
 assert.equal(await dialog.locator('#bpp-rows tr').count(),100);
 await dialog.locator('#bpp-next').click();
 assert.ok(await dialog.locator('#bpp-rows tr').count()>0);
 assert.equal(new Set(details.slice(start)).size,details.length-start);
 await dialog.press('Escape');

 await page.getByRole('button',{name:'价格',exact:true}).click();
 await page.locator('#price-profit-title').waitFor();
 const shown=()=>page.locator('[data-pp-row]').evaluateAll(nodes=>nodes.map(n=>n.dataset.ppRow));
 const headings=()=>page.locator('[data-pp-group]').evaluateAll(nodes=>nodes.map(n=>n.dataset.ppGroup));
 assert.deepEqual(await shown(),order.slice(0,4));
 assert.deepEqual(await page.locator('#pp-shop option').evaluateAll(nodes=>nodes.map(n=>n.value)),['intel']);
 assert.equal(await page.locator('#pp-alert').isEnabled(),true);
 const groupOrder=await headings();
 await page.locator('#pp-expand-links').click();
 assert.deepEqual((await shown()).filter(id=>order.includes(id)),order);
 const sort=page.locator('[data-pp-sort="arrival"]');
 await sort.click();
 assert.deepEqual(await headings(),groupOrder);
 assert.deepEqual((await shown()).filter(id=>order.includes(id)),[...order.slice(0,4).reverse(),...order.slice(4).reverse()]);
 await sort.click();await sort.click();
 assert.deepEqual((await shown()).filter(id=>order.includes(id)),order);
 const original=await shown();
 await page.locator('#pp-flat').click();await sort.click();
 assert.equal((await shown()).filter(id=>order.includes(id))[0],target);
 await sort.click();await sort.click();assert.deepEqual(await shown(),original);
 await page.locator('#pp-grouped').click();await page.locator('#pp-collapse-links').click();
 assert.deepEqual(await shown(),[]);
 await page.locator('[data-pp-group]').filter({hasText:'验收链接 a'}).locator('[data-pp-collapse]').click();
 assert.deepEqual(await shown(),order.slice(0,4));
 // 检查单行提交与链接头选择都复用其它配置行，不提前绘制旧价格。
 const cell=id=>page.locator(`[data-pp-row="${id}"] [data-pp-cell="price"]`);
 await page.evaluate(id=>{
  const value=()=>document.querySelector(`[data-pp-row="${id}"] [data-pp-cell="price"]`).value.replaceAll(',','');
  window.pricePaints=[];
  new MutationObserver(()=>window.pricePaints.push(Number(value()))).observe(document.querySelector('#pp-rows'),
   {childList:true,subtree:true,attributeFilter:['data-pp-precise']});
 },target);
 await page.evaluate(id=>{window.otherPriceRow=document.querySelector(`[data-pp-row="${id}"]`);},row('a',1));
 await page.locator('[data-pp-group]').filter({hasText:'验收链接 a'}).locator('[data-pp-select-link]').click();
 assert.equal(await page.locator('[data-pp-jump-link]:visible').count(),1);
 for(const [key,value] of [['Enter','2201.25'],['Tab','2202.25'],['ArrowUp','2203.25']]){
  await cell(target).fill(value);
  await page.evaluate(()=>{window.pricePaints=[];});
  await cell(target).press(key);
  await page.waitForFunction(({id,value})=>document.querySelector(`[data-pp-row="${id}"] [data-pp-cell="price"]`).dataset.ppPrecise===value,{id:target,value});
  assert.ok((await page.evaluate(()=>window.pricePaints)).every(displayed=>Math.round(displayed)===Math.round(Number(value))));
  assert.equal(await page.evaluate(id=>window.otherPriceRow===document.querySelector(`[data-pp-row="${id}"]`),row('a',1)),true);
 }
 await page.evaluate(()=>{window.pricePaints=[];});await page.locator('#pp-undo').click();
 await page.waitForFunction(id=>document.querySelector(`[data-pp-row="${id}"] [data-pp-cell="price"]`).dataset.ppPrecise==='2202.25',target);
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.pricePaints)]),[2202]);
 await page.evaluate(()=>{window.pricePaints=[];});await page.locator('#pp-redo').click();
 await page.waitForFunction(id=>document.querySelector(`[data-pp-row="${id}"] [data-pp-cell="price"]`).dataset.ppPrecise==='2203.25',target);
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.pricePaints)]),[2203]);
 await page.locator(`[data-pp-row="${target}"] [data-pp-pick]`).check();
 await page.locator('#pp-batch').click();
 await page.locator('#pp-batch-value').fill('10');
 await page.locator('#pp-batch-apply').click();
 await page.waitForFunction(()=>document.querySelector('#pp-status').textContent.includes('点击“保存到服务端”'));
 assert.equal(await page.locator('#pp-save-count').textContent(),'1 套待保存');
 await page.locator('#pp-save').click();
 await page.waitForFunction(()=>document.querySelector('#pp-save-count').textContent==='无待保存');
 assert.equal((await client.detail(target)).document.price,2213.25);

 // 从实际侧栏拖动最后一套到最前面，再进入价格表读取新索引。
 await page.locator('.pp-menu > summary').click();await page.locator('#pp-back').click();
 await page.evaluate(([from,to])=>{
  const source=document.querySelector(`.config-item[data-id="${from}"]`);
  const target=document.querySelector(`.config-item[data-id="${to}"]`);
  const dataTransfer=new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer,clientY:target.getBoundingClientRect().top}));
 },[target,row('a',1)]);
 await page.waitForFunction(id=>document.querySelector('[data-list-product="price-fix-a"] .config-item')?.dataset.id===id,target);
 const newOrder=(await sidebar()).filter(id=>id.startsWith(link('a')));
 await page.getByRole('button',{name:'价格',exact:true}).click();
 await page.locator('#price-profit-title').waitFor();
 assert.deepEqual(await shown(),newOrder);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({通过:true,价格配置:original.length,加载分批:details.slice(start).length,合成资料目录:root}));
}catch(error){
 console.error(error.stack);process.exitCode=1;
}finally{await browser?.close();await api.close();}
