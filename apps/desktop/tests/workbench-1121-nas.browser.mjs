/** 用合成三店服务验收现有 NAS 模板和 ERP 建源从界面到数据库的路径。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../public/workbench/nas-api-client.js';

const fixture=process.argv[2];
if(!fixture)throw Error('请指定合成 fixture 目录');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const api=await startSourceAcceptance({fixture,root:join(fixture,'1121-browser-uploads'),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
let browser;
try{
 // 展示型号先使用另一条来源，验收按实际货号打开快速维护。
 await api.db.query(`UPDATE intel_live.templates SET configurations=jsonb_set(configurations,'{0,parts}',(configurations#>'{0,parts}')||$1::jsonb)
  WHERE template_id='fixture-template'`,[JSON.stringify([{slot:'主板',lineId:'test-display-board',sourceId:'fixture-cost-history',
   goodsId:'9900011',name:'独立展示配件',qty:1}])]);
 // 单独的配置组只随索引返回摘要，先拦住详情回执再检查切换。
 const delayed=new Map();
 for(const [key,name] of [['slow-a','慢加载模板甲'],['slow-b','慢加载模板乙']]){
  const rowId=key+'-row';
  await api.db.query("INSERT INTO intel_live.products(shop_id,product_id) VALUES('intel',$1)",[key]);
  await api.db.query(`INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
   VALUES($1,'intel',$2,'配置1','','',100,0,$3,'{}')`,[rowId,key,JSON.stringify({product:name,productCategory:'主机模板',version:'配置1'})]);
  delayed.set(rowId,Promise.withResolvers());
 }
 const send=(path,options)=>fetch(api.url+path,{...options,headers:{...options?.headers,'x-workbench-deployment':fixtureDeployment}});
 const client=createNasApiClient({nativeRequest:send,shopId:'intel'});
 client.bindIdentity(fixtureWorkspace,fixtureActor);
 // 跨店目录可能包含只在另一家店建档的来源，当前店维护应照常打开和保存。
 const otherShop=createNasApiClient({nativeRequest:send,shopId:'gigabyte'});
 otherShop.bindIdentity(fixtureWorkspace,fixtureActor);
 const otherId='9900727',otherName='仅技嘉有的验收内存';
 await otherShop.saveCatalog('shared-sources',otherId,'create',{operation_id:randomUUID(),document:{
  id:otherId,name:otherName,erpAdoption:{name:otherName,erp:110,stockAvailable:5,sku:'TEST'},
 }});
 assert.deepEqual(Object.keys((await client.catalog('shared-sources',otherId)).document.stores),['gigabyte']);
 // 通过真实建源接口添加可维护的样本，模板只引用原配件与货号。
 const samples=[
  ['显卡','9900722','验收 RTX 5070 显卡 黑色'],
  ['机箱','9900723','验收 Z20 MATX 机箱 黑色'],
  ['内存','9900724','验收 DDR5 内存 16GB 黑色'],
  ['风扇','9900725','验收 ZE-240B 风扇 黑色'],
  ['硬盘','9900726','验收 SSD 固态硬盘 1TB'],
 ];
 const parts=[];
 for(const [slot,id,name] of samples){
  const saved=await client.saveCatalog('shared-sources',id,'create',{operation_id:randomUUID(),
   document:{id,name,erpAdoption:{name,erp:100,stockAvailable:5,sku:'TEST'}}});
  parts.push({slot,goodsId:id,sourceId:saved.document.sourceId,name,erpName:name,qty:1,lineId:'test-'+id});
 }
 // 两个链接使用同一货号，展示数量和实际数量各自独立，便于核对撤销结果。
 const oldMemory=parts.find(part=>part.slot==='内存');
 const nextMemoryId='9900728',nextMemoryName='验收 DDR5 内存 24GB 白色';
 const nextMemory=(await client.saveCatalog('shared-sources',nextMemoryId,'create',{operation_id:randomUUID(),
  document:{id:nextMemoryId,name:nextMemoryName,erpAdoption:{name:nextMemoryName,erp:125,stockAvailable:5,sku:'TEST'}}})).document;
 const batchIds=['batch-memory-a','batch-memory-b'];
 for(const [index,id] of batchIds.entries()){
  await api.db.query("INSERT INTO intel_live.products(shop_id,product_id) VALUES('intel',$1)",[id]);
  await api.db.query(`INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
   VALUES($1,'intel',$1,'配置1','','',100,319900,$2,'{}')`,[id,JSON.stringify({product:'批量换件验收 '+(index+1),version:'配置1'})]);
  for(const [kind,qty] of [['display',index+1],['actual',index+2]])
   await api.db.query(`INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
    VALUES($1,$2,1,'memory-line','内存',$3,$4,$5,$6,'{}')`,[id,kind,oldMemory.goodsId,oldMemory.name,qty,oldMemory.sourceId]);
 }
 await api.db.query(`UPDATE intel_live.templates SET configurations=jsonb_set(
  jsonb_set(configurations,'{0,parts}',(configurations#>'{0,parts}')||$1::jsonb),'{0,actualParts}',$1::jsonb)
  WHERE template_id='fixture-template'`,[JSON.stringify(parts)]);
 // 同一张模板中并排对照已绑定、仅规格、无卡和空白四种状态。
 const gpuCases=[
  [parts.find(part=>part.slot==='显卡')],
  [{slot:'显卡',name:'RTX 5070 12G',qty:1,lineId:'gpu-spec'}],
  [{slot:'显卡',name:'无卡',qty:1,lineId:'gpu-none'}],
  [],
 ].map((parts,index)=>({id:'gpu-status-'+index,name:'显卡标记验收',parts,actualParts:[]}));
 await api.db.query(`INSERT INTO intel_live.templates(template_id,shop_id,name,configurations,attrs)
  VALUES('gpu-status-fixture','intel','显卡标记验收',$1,'{}')`,[JSON.stringify(gpuCases)]);
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1800,height:1050},bypassCSP:true});
 page.setDefaultTimeout(8000);
 const errors=[];
 page.on('pageerror',error=>errors.push(error.stack));
 await page.addInitScript(()=>{
  // 记录 innerHTML 插入即刻的状态，避免事后断言错过首次绘制。
  window.templateInsertions=[];
  const property=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  Object.defineProperty(Element.prototype,'innerHTML',{...property,set(value){
   property.set.call(this,value);
   if(this.id!=='host-template-sheet')return;
   const create=this.querySelector('#host-template-create'),copy=this.querySelector('#host-template-copy');
   if(create&&copy)window.templateInsertions.push({
    createDisabled:create.hasAttribute('disabled'),copyDisabled:copy.hasAttribute('disabled'),label:create.textContent,
    hint:this.querySelector('.host-template-generate-hint').textContent,
    preview:this.querySelector('.host-template-copy-preview').textContent,
   });
  }});
 });
 const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8'))
  .replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
   import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;
   window.__vite_plugin_react_preamble_installed__=true;
   const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
   window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');
   document.body.classList.remove('login-required');
  </script>`);
 await page.route('**/workbench/1121-nas-fixture?*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'isolated-1121',deployment_id:fixtureDeployment}});
  if(path==='/erp-read'){
   const {kind}=req.postDataJSON();
   const rows=kind==='erp-catalog'?[{goodsId:'9900721',name:'验收新款主板 X870 白色 (DDR5)',erp:1680,stockAvailable:5}]:[];
   return route.fulfill({json:{ok:true,complete:true,total:rows.length,rows}});
  }
  if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
  const gate=delayed.get(path.split('/').at(-1));
  if(gate)await gate.promise;
  const response=await send(path+url.search,{method:req.method(),headers:req.headers(),body:req.postData()??undefined});
  await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
 });
 page.on('dialog',dialog=>void dialog.accept());
 await page.goto(base+'/workbench/1121-nas-fixture?workspace=nas');
 await page.waitForFunction(()=>window.workbenchReady===true,undefined,{timeout:10000});
 // 批量事务完成后的按钮必须在当前链接生效，中途不切换链接或主动重绘。
 await page.locator('[data-product-toggle="'+batchIds[0]+'"]').click();
 const overview=page.locator('#continuous-workbench');
 await overview.locator('.ov-config[data-active="true"]').waitFor();
 await page.getByRole('button',{name:'维护',exact:true}).click();
 await page.locator('#rail-tool-panel').getByRole('button',{name:'批量修改配件 / 加购 / 导图',exact:true}).click();
 await page.locator('#global-query').fill(oldMemory.goodsId);
 await page.locator('[data-global-part]').filter({hasText:oldMemory.goodsId}).click();
 assert.equal(await page.locator('[data-global-link]:checked').count(),2);
 await page.locator('#global-new-query').fill(nextMemoryId);
 await page.locator('#global-product-search [data-product-id="'+nextMemory.sourceId+'"]').click();
 await page.locator('#global-qty').fill('4');
 await page.locator('#global-preview').click();
 await page.locator('#global-apply').click();
 await page.waitForFunction(()=>document.querySelector('#global-status')?.textContent.startsWith('已统一修改'));
 await page.locator('#dialog').press('Escape');
 await page.locator('#dialog').waitFor({state:'hidden'});
 const readMemoryBatch=async()=>Promise.all(batchIds.map(async id=>{
  const {document}=await client.detail(id);
  return [document.parts,document.actualParts].map(parts=>{
   const memory=parts.find(part=>part.slot==='内存');
   return [memory.goodsId,memory.qty];
  });
 }));
 const restoredMemory=batchIds.map((_,index)=>[[oldMemory.goodsId,index+1],[oldMemory.goodsId,index+2]]);
 const replacedMemory=batchIds.map(()=>[[nextMemoryId,4],[nextMemoryId,4]]);
 assert.deepEqual(await readMemoryBatch(),replacedMemory);
 const undo=overview.getByRole('button',{name:'撤销',exact:true}),redo=overview.getByRole('button',{name:'重做',exact:true});
 await undo.click({timeout:2500});
 await redo.click({trial:true,timeout:2500});
 assert.deepEqual(await readMemoryBatch(),restoredMemory);
 await redo.click();
 await undo.click({trial:true,timeout:2500});
 assert.equal(await overview.locator('.ov-config[data-active="true"]').getAttribute('data-continuous-config'),batchIds[0]);
 assert.deepEqual(await readMemoryBatch(),replacedMemory);

 const heading=page.locator('#template-section-toggle');
 await heading.locator('.zone-arrow').click();
 const card=page.locator('[data-template-snapshot="fixture-template"]');
 const sheet=page.locator('#host-template-sheet');
 await page.locator('[data-template-snapshot="gpu-status-fixture"]').click();
 const gpuCells=sheet.locator('td').filter({has:page.locator('[data-template-cell="显卡"]')});
 assert.deepEqual(await gpuCells.evaluateAll(cells=>cells.map(cell=>cell.querySelector('.host-template-gpu-pending')?.textContent??null)),
  [null,'待选货号',null,null]);
 const marker=sheet.getByText('待选货号',{exact:true});
 assert.equal(await marker.isVisible(),true);
 assert.equal(await marker.evaluate(el=>el.getBoundingClientRect().height<=el.previousElementSibling.getBoundingClientRect().height),true);
 // 左栏已载入模板全文，打开当次就应显示表格，不出现中间的空面板。
 assert.equal(await card.evaluate(el=>{el.click();return Boolean(document.querySelector('#host-template-sheet table'));}),true);
 await sheet.locator('tbody tr').first().waitFor();
 const firstPaint=()=>page.evaluate(()=>window.templateInsertions.at(-1));
 const copy=sheet.locator('#host-template-copy');
 const buttonShape=()=>copy.evaluate(button=>{
  const style=getComputedStyle(button);
  return [style.borderTopWidth,style.clipPath,button.getBoundingClientRect().height];
 });
 const initial=await firstPaint();
 assert.equal(initial.createDisabled,true);assert.equal(initial.copyDisabled,true);
 assert.equal(initial.label,'生成到草稿区（0 套）');assert.equal(initial.hint,'先勾选要生成的行');
 assert.match(initial.preview,/选号（0 套）/);
 assert.equal(await copy.evaluate(button=>getComputedStyle(button).transitionDuration),'0s');
 const disabledShape=await buttonShape();
 const exterior=sheet.locator('[data-exterior="机箱"]');
 await exterior.focus();
 assert.equal(await exterior.evaluate(field=>{
  document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}));
  return field.isConnected&&document.activeElement===field;
 }),true);
 const generate=sheet.locator('#host-template-create');
 const top=await generate.evaluate(button=>button.getBoundingClientRect().top);
 await sheet.locator('tbody [data-host-template-pick]:enabled').first().check();
 assert.equal(await generate.evaluate(button=>button.getBoundingClientRect().top),top);
 await sheet.locator('#host-template-good-id').check();
 assert.equal((await firstPaint()).createDisabled,false);assert.equal((await firstPaint()).copyDisabled,false);
 assert.equal((await firstPaint()).label,'生成到草稿区（1 套）');
 assert.deepEqual(await buttonShape(),disabledShape);
 await sheet.locator('tbody [data-host-template-pick]:enabled').first().uncheck();
 const pendingA=page.waitForRequest(request=>request.url().includes('/configurations/slow-a-row?'));
 await page.locator('[data-template-product-toggle="slow-a"]').click();
 await pendingA;
 assert.equal(await sheet.locator('.host-template-toolbar h2').textContent(),'模板');
 assert.equal(await sheet.getByText('正在载入模板…',{exact:true}).count(),0);
 delayed.get('slow-a-row').resolve();
 await sheet.getByRole('heading',{name:'慢加载模板甲',exact:true}).waitFor();
 assert.equal((await firstPaint()).copyDisabled,true);
 const pendingB=page.waitForRequest(request=>request.url().includes('/configurations/slow-b-row?'));
 await page.locator('[data-template-product-toggle="slow-b"]').click();
 await pendingB;
 assert.equal(await sheet.locator('.host-template-toolbar h2').textContent(),'慢加载模板甲');
 await card.click();
 const late=page.waitForResponse(response=>response.url().includes('/configurations/slow-b-row?'));
 delayed.get('slow-b-row').resolve();
 await late;
 await sheet.getByRole('heading',{name:'模板',exact:true}).waitFor();
 await card.locator('strong').dblclick();
 await page.locator('.host-template-rename').fill('NAS 模板验收');
 await page.locator('.host-template-rename').press('Enter');
 await sheet.locator('#host-template-save').click();
 await sheet.locator('.host-template-state[data-dirty="false"]').waitFor();
 assert.equal((await client.catalog('templates','fixture-template')).document.name,'NAS 模板验收');
 await sheet.locator('tbody [data-host-template-pick]:enabled').first().check();
 await sheet.locator('#host-template-create').click();
 await page.locator('#host-template-link-name').fill('NAS 新草稿验收');
 await page.locator('#host-template-link-save').click();
 await page.waitForFunction(()=>!document.querySelector('#dialog').open,undefined,{timeout:8000});
 await page.locator('#config-list').getByText('NAS 新草稿验收',{exact:false}).first().waitFor();
 const active=page.locator('.ov-config[data-active="true"]');
 await active.waitFor();
 const board=active.locator('tr').filter({has:page.getByRole('button',{name:'主板',exact:true})});
 await board.locator('[data-ov-cell="0"]').press('F2');
 const input=active.getByRole('combobox',{name:/主板 实际配件/});
 await input.fill('验收新款主板');
 const boardCandidate=page.locator('.ov-erp-candidate').filter({hasText:'验收新款主板 X870 白色'});
 await boardCandidate.locator('.ov-erp-color[data-color="白"]').waitFor();
 await boardCandidate.click();
 await board.getByText('验收新款主板 X870 白色',{exact:false}).first().waitFor();
 assert.deepEqual(Object.keys((await client.catalog('shared-sources','9900721')).document.stores),['intel']);
 assert.equal((await client.resource('sources','erp:intel:9900721')).document.name,'验收新款主板 X870 白色');
 assert.equal((await client.resource('costs','9900721')).document.tax,1680);
 // 无需先手动保存配置，也能直接维护刚建成的输出源。
 await board.getByRole('button',{name:'修改输出源',exact:true}).click();
 const edit=page.locator('#dialog.source-quick-dialog');
 await edit.locator('#source-tax').waitFor();
 assert.equal(await edit.locator('#source-id').inputValue(),'9900721');
 assert.equal(await edit.getByLabel('本店含税核算单价',{exact:true}).inputValue(),'1680');
 assert.ok(await edit.locator('#source-maintenance-fields').isVisible());
 const color=edit.locator('#source-hardware-color');
 const colorHint=edit.locator('[data-hardware-hint="color"]');
 const openHardware=async()=>{
  const details=edit.locator('#source-maintenance-fields');
  if(!await details.evaluate(el=>el.open))await details.locator('summary').click();
 };
 const saveSource=async()=>{
  await edit.locator('#source-save-all').click();
  await page.waitForFunction(()=>document.querySelector('#source-message')?.textContent?.includes('已保存 1 条'));
 };
 const closeSource=async()=>{await page.keyboard.press('Escape');await edit.waitFor({state:'hidden'});};
 await openHardware();
 assert.equal(await color.inputValue(),'');
 assert.equal(await colorHint.textContent(),'自动：白');
 await color.selectOption('黑');
 assert.equal(await colorHint.textContent(),'人工：黑');
 await edit.locator('#source-name').fill('本店新款主板');
 await edit.locator('#source-tax').fill('1725.50');
 await saveSource();
 const boardSource=async()=>(await client.resource('sources','erp:intel:9900721')).document;
 assert.equal((await boardSource()).name,'本店新款主板');
 assert.equal((await boardSource()).hardwareOverrides.color,'黑');
 const updated=await client.resource('costs','9900721');
 assert.equal(updated.document.tax,1725.5);
 assert.equal(updated.document.nasManualTax,true);
 assert.deepEqual(Object.keys((await client.catalog('shared-sources','9900721')).document.stores),['intel']);
 await closeSource();
 const configId=await active.getAttribute('data-continuous-config');
 const saveConfig=async()=>{
  const saveResult=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/configurations/'+configId));
  await page.locator('#save').click();
  const response=await saveResult;
  assert.ok(response.ok(),await response.text());
  await page.waitForFunction(()=>!window.workbenchHasPendingChanges());
  return client.detail(configId);
 };
 const config=await saveConfig();
 assert.equal(config.document.actualParts.find(row=>row.slot==='主板')?.goodsId,'9900721');
 assert.equal(config.document.parts.find(row=>row.slot==='主板')?.goodsId,'9900011');
 for(const [slot,id] of samples)assert.equal(config.document.actualParts.find(row=>row.slot===slot)?.goodsId,id,slot);
 const badge=(row,value)=>row.locator(`.ov-erp-color[data-color="${value}"]`);
 await badge(board,'黑').waitFor();
 await board.locator('[data-ov-cell="0"]').press('F2');
 await active.getByRole('combobox',{name:/主板 实际配件/}).fill('9900721');
 const savedBoardCandidate=page.locator('.continuous-candidate').filter({hasText:'GoodID 9900721'});
 await badge(savedBoardCandidate,'黑').waitFor();
 await savedBoardCandidate.click();
 await board.getByRole('button',{name:'修改输出源',exact:true}).click();
 await openHardware();
 assert.equal(await color.inputValue(),'黑');
 await color.selectOption('');
 assert.equal(await colorHint.textContent(),'自动：白');
 await saveSource();
 assert.equal((await boardSource()).hardwareOverrides?.color,undefined);
 await closeSource();
 await badge(board,'白').waitFor();

 for(const [slot,id] of samples){
  const row=active.locator('tr').filter({has:page.getByRole('button',{name:slot,exact:true})});
  if(slot==='显卡')await badge(row,'黑').waitFor();
  await row.getByRole('button',{name:'修改输出源',exact:true}).click();
  await openHardware();
  assert.equal(await edit.locator('#source-id').inputValue(),id);
  if(slot==='硬盘'){assert.equal(await color.isVisible(),false);await closeSource();continue;}
  await color.selectOption('白');
  assert.equal(await colorHint.textContent(),'人工：白');
  await saveSource();
  assert.equal((await client.resource('sources','erp:intel:'+id)).document.hardwareOverrides.color,'白');
  await closeSource();
  if(slot==='显卡')await badge(row,'白').waitFor();
  else assert.equal(await row.locator('.ov-erp-color').count(),0,slot);
  await row.locator('[data-ov-cell="0"]').press('F2');
  await active.getByRole('combobox',{name:new RegExp(slot+' 实际配件')}).fill(id);
  const candidate=page.locator('.continuous-candidate').filter({hasText:'GoodID '+id});
  await candidate.waitFor();
  if(slot==='显卡')await badge(candidate,'白').waitFor();
  else assert.equal(await candidate.locator('.ov-erp-color').count(),0,slot);
  await candidate.click();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,nasTemplateSaved:true,nasDraftGenerated:true,erpSourceSelected:true,stableTemplatePanel:true,
  initialButtonsStable:true,slowTemplateSwitch:true,quickEditActualSource:true,singleShopSources:true,hardwareColors:true,
  batchHistoryWithoutLinkSwitch:true}));
}finally{await browser?.close();await api.close();}
