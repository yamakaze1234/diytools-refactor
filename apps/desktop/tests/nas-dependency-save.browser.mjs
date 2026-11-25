/** 真实 NAS 页面隔离验收：依赖自动接续与总表焦点回落后的冲突处理。 */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';
import {createNasApiClient} from '../public/workbench/nas-api-client.js';
const fixture=process.argv[2],out=process.env.DEPENDENCY_BROWSER_OUTPUT;if(!fixture||!out)throw Error('请指定合成 fixture 和回执目录');
await mkdir(out,{recursive:true});
const api=await startSourceAcceptance({fixture,root:join(fixture,'dependency-browser-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5243';
let browser;
try{
 for(const name of ['027-quotation-identity-invalidation.sql','028-cross-shop-cost-sync.sql','030-incoming-stock.sql'])await api.db.exec(await readFile(new URL('../../../services/nas-api/sql/'+name,import.meta.url),'utf8'));
 await api.db.exec(`INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
  SELECT 'dependency-other',shop_id,product_id,'对照配置','','',workspace_order+1,workbench_price_cents,fields,design FROM intel_live.configurations WHERE configuration_id='fixture-overlap';
 INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
  SELECT 'dependency-other',part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs FROM intel_live.parts WHERE configuration_id='fixture-overlap';`);
 const send=(path,options)=>fetch(api.url+path,{...options,headers:{...options?.headers,'x-workbench-deployment':fixtureDeployment}});
 const client=createNasApiClient({nativeRequest:send,shopId:'intel'});client.bindIdentity(fixtureWorkspace,fixtureActor);
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1700,height:1040},bypassCSP:true});page.setDefaultTimeout(15000);
 const errors=[],saves=[],dialogs=[];let holdCompare=null;
 page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
 const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;
 await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
 const source=await readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/dependency-fixture?*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',route=>route.fulfill({contentType:'text/javascript',body:source+`
 window.dependencyProbe={activate,active:()=>current()?.id,stage(id,name){const c=state.configs.find(row=>row.id===id);c.name=name;changed('隔离文案编辑',[id]);renderAll();},drafts:()=>nasWorkspace.drafts(),document:id=>state.configs.find(row=>row.id===id),part(id,name){const c=state.configs.find(row=>row.id===id);c.actualParts[0].name=name;changed('隔离配件编辑',[id]);renderAll();},close:closeDialog};
 const dependencyShowModal=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(){window.dependencyDialogTitles??=[];window.dependencyDialogTitles.push(document.querySelector('#dialog-title')?.textContent);return dependencyShowModal.call(this);};
 `}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'dependency-isolated',deployment_id:fixtureDeployment}});
  if(path==='/erp-read')return route.fulfill({json:{ok:true,saved:false,settings:{path:''}}});
  if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
  if(path.endsWith('/configurations/fixture-overlap')&&request.method()==='GET'&&holdCompare)await holdCompare;
  const response=await send(path+url.search,{method:request.method(),headers:request.headers(),body:request.postData()??undefined});
  if(request.method()==='PUT'&&path.endsWith('/configurations/fixture-overlap'))saves.push({status:response.status,body:request.postDataJSON()});
  await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
 });
 await page.goto(base+'/workbench/dependency-fixture?workspace=nas');await page.waitForFunction(()=>window.workbenchReady);
 await page.evaluate(async()=>{await dependencyProbe.activate('fixture-overlap');await dependencyProbe.activate('dependency-other');await dependencyProbe.activate('fixture-overlap');});
 await page.evaluate(()=>dependencyProbe.stage('fixture-overlap','依赖刷新后保存'));
 await api.db.exec("UPDATE intel_live.costs SET version=version+1,erp=erp+1,tax=432.1,attrs=attrs||'{\"nasErpOverride\":true,\"nasTaxOverride\":true}' WHERE goodsid='100001'; UPDATE intel_live.sources SET version=version+1 WHERE source_id='fixture-local';");
 await page.locator('#save').click();await page.waitForFunction(()=>dependencyProbe.drafts().length===0);
 assert.equal((await client.detail('fixture-overlap')).document.name,'依赖刷新后保存');
 await page.waitForFunction(()=>dependencyProbe.document('fixture-overlap').actualParts[0].tax===432.1);
 assert.deepEqual(saves.map(row=>row.status),[409,200]);assert.notEqual(saves[0].body.operation_id,saves[1].body.operation_id);
 assert.equal(await page.locator('#dialog[open]').count(),0);assert(!(await page.evaluate(()=>window.dependencyDialogTitles??[])).includes('保存配置结果'));
 await page.screenshot({path:join(out,'dependency-saved.png')});
 // 同配置真正发生并发保存时，结果弹窗仍出现。
 await page.evaluate(()=>{dependencyProbe.stage('fixture-overlap','A 保留的草稿');dependencyProbe.part('fixture-overlap','A 修改的内存');});
 const before=await client.detail('fixture-overlap');await client.save('replace','fixture-overlap',{operation_id:crypto.randomUUID(),expected_version:before.version,dependencies:before.dependencies,document:{...before.document,name:'B 已保存的版本',actualParts:before.document.actualParts.map((part,index)=>index===0?{...part,name:'B 修改的内存',qty:part.qty+1}:part)}});
 await page.locator('#save').click();await page.locator('#dialog-title').filter({hasText:'保存配置结果'}).waitFor();
 // 放大实际焦点竞争：查比较详情期间聚焦背景另一配置总表单元格，触发真实 onFocusCapture。
 const release=Promise.withResolvers();holdCompare=release.promise;
 await page.locator('[data-nas-save-locate="fixture-overlap"][data-compare]').click();
 await page.locator('[data-continuous-config="dependency-other"] [data-ov-cell]').first().evaluate(node=>node.focus());
 await page.waitForFunction(()=>dependencyProbe.active()==='dependency-other');holdCompare=null;release.resolve();
 await page.locator('#dialog-title').filter({hasText:'处理配置冲突'}).waitFor();
 assert.match(await page.locator('#dialog-body').innerText(),/B 已保存的版本/);assert.match(await page.locator('#dialog-body').innerText(),/A 保留的草稿/);
 const details=await page.getByRole('table',{name:'配置冲突明细'}).innerText();for(const text of ['实际配件','数量','A 修改的内存','B 修改的内存','双方修改冲突','开始编辑时'])assert(details.includes(text),text);
 await page.locator('#dialog').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
 await page.screenshot({path:join(out,'version-conflict.png')});
 await page.locator('#nas-use-server').click();await page.waitForFunction(()=>dependencyProbe.drafts().length===0);
 assert.equal(await page.evaluate(()=>dependencyProbe.document('fixture-overlap').name),'B 已保存的版本');assert.equal(await page.locator('#dialog[open]').count(),0);
 assert.deepEqual(errors,[]);
 const result={passed:true,realHttp:true,dependencyRefreshWithoutDialog:true,versionConflictDialog:true,backgroundFocusChangedTarget:true,partConflictDetails:true,refreshedDisplayedCost:true,abandonCorrectDraft:true,errors,saves:saves.map(row=>row.status)};
 await writeFile(join(out,'browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await api.close();}
