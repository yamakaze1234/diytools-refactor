import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve('apps/desktop/public/workbench'),out=path.resolve('sandbox/source-sync-20261015/ui');await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench-ui.css"><link rel="stylesheet" href="/workbench-simple.css"><dialog class="source-dialog"><div id="dialog-body"><div class="source-sync-top" id="mount"></div></div></dialog>');return;}const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error('path');res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file));}catch(e){res.statusCode=404;res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1400,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);

 async function setup(){await page.evaluate(async()=>{
  const {mountSourceSync}=await import('/source-sync-ui.js'),{applySourceSync}=await import('/source-sync-data.js'),{applyReplacement}=await import('/global-batch.js');
  const row={sourceId:'source',shopId:'intel',goodsId:'123',name:'新名称',tax:200,addonText:'新说明'};
  const config=(id,productId,name)=>({id,shopId:'intel',productId,product:productId,name,theme:'dark',parts:[{slot:'内存',sourceId:'source',goodsId:'123',name:'原名称',tax:100,qty:1,upgrade:'手写说明'}],actualParts:[{slot:'内存',goodsId:'actual',qty:7}],addons:[{text:'人工加购'}]});
  const configs=[config('a','链接1','配置1'),config('b','链接1','配置2'),config('c','链接2','配置1')];
  const f=window.fixture={configs,original:structuredClone(configs),row,applied:[],exports:[],rendered:[],cancel:false,partial:false,failSave:false};
  window.pywebview={api:{export_image_folder_session:async payload=>{
   if(payload.phase==='begin'){f.exports.push({files:[],renderedCount:f.rendered.length});return f.cancel?{cancelled:true}:{token:'test',directory:'isolated/source-export'};}
   const exported=f.exports.at(-1);if(payload.phase==='append')exported.files.push(...payload.files);
   return {ok:!f.partial,files:exported.files.map(file=>file.name).filter((name,index)=>!f.partial||index===0),directory:'isolated/source-export',...(f.partial?{error:'模拟磁盘错误'}:{})};
  }}};
  window.sync=mountSourceSync(document.querySelector('#mount'),{message(){},isEdited:()=>false,flush:async()=>{},getConfigs:()=>configs,getRows:()=>[row],shopId:()=> 'intel',apply:async plan=>{
   if(f.failSave)throw Error('模拟保存失败');
   applySourceSync(plan,configs,[row]);f.applied.push(plan);
  },renderImage:async c=>{f.rendered.push({id:c.id,theme:c.theme});const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;return {canvas,overflow:false};},download:()=>{throw Error('必须走目录选择');}});if(!document.querySelector('dialog').open)document.querySelector('dialog').showModal();
 });await page.locator('[data-review-link] option[value="链接1"]').waitFor({state:'attached'});}
 const choose=async(id,field)=>{await page.locator('[data-review-link]').selectOption('链接1');await page.locator('[data-source-select]').evaluateAll((els,{id,field})=>els.find(el=>{const key=JSON.parse(el.value);return key[0]===id&&key.at(-1)===field}).click(),{id,field});};
 const idle=()=>page.waitForFunction(()=>!document.querySelector('#source-check').disabled);
 await setup();await choose('b','name');await page.locator('[data-review-export]').check();await page.locator('#source-export-scope').selectOption('changed');
 assert.match(await page.locator('[data-source-sync-message]').textContent(),/导出 2 张/);
 await page.locator('#source-apply').click();await idle();
 let f=await page.evaluate(()=>window.fixture);assert.equal(f.applied.length,1);assert.equal(f.exports[0].renderedCount,0);assert.deepEqual(f.exports[0].files.map(x=>x.name),['链接1_配置图/2_配置2.png','链接1_sku图/2_配置2.png','导出清单.json']);assert.ok(f.rendered.every(c=>c.theme==='dark'));assert.ok(f.exports[0].files[0].base64.startsWith('iVBOR'));
 await page.locator('#source-export-scope').selectOption('all');await page.evaluate(()=>window.fixture.cancel=true);await page.locator('#source-export-retry').click();await idle();assert.match(await page.locator('[data-source-sync-message]').textContent(),/取消图片导出/);
 await page.evaluate(()=>window.fixture.cancel=false);await page.locator('#source-export-retry').click();await idle();f=await page.evaluate(()=>window.fixture);assert.equal(f.applied.length,1);assert.equal(f.exports.at(-1).files.length,5);assert.ok(f.exports.at(-1).files.every(x=>!x.name.includes('链接2')));
 await page.evaluate(()=>window.fixture.configs[1].salePrice=999);await page.locator('#source-undo').click();await idle();f=await page.evaluate(()=>window.fixture);assert.equal(f.configs[1].salePrice,999);assert.deepEqual(f.configs[1].parts,f.original[1].parts);assert.equal(f.applied.length,2);assert.equal(await page.locator('#source-undo').isDisabled(),true);assert.equal(await page.locator('#source-export-retry').isHidden(),true);
 // A later batch gets a fresh one-shot undo. Failed saves do not consume it.
 await choose('b','tax');await page.locator('[data-review-export]').uncheck();await page.locator('#source-apply').click();await idle();assert.equal(await page.locator('#source-undo').isEnabled(),true);assert.equal(await page.evaluate(()=>Object.hasOwn(window.fixture.configs[1],'taxUpdatedAt')),true);
 await page.evaluate(()=>window.fixture.failSave=true);await page.locator('#source-undo').click();await idle();assert.match(await page.locator('[data-source-sync-message]').textContent(),/还原未完成.*模拟保存失败/);assert.equal(await page.locator('#source-undo').isEnabled(),true);
 await page.evaluate(()=>window.fixture.failSave=false);await page.locator('#source-undo').click();await idle();assert.equal(await page.evaluate(()=>Object.hasOwn(window.fixture.configs[1],'taxUpdatedAt')),false);
 await choose('b','upgrade');await page.locator('#source-keep-all').click();await idle();assert.equal(await page.evaluate(()=>window.fixture.configs[1].parts[0].upgrade),'手写说明');await page.locator('#source-undo').click();await idle();assert.deepEqual(await page.evaluate(()=>window.fixture.configs[1].parts),f.original[1].parts);
 await choose('b','name');await page.locator('#source-apply').click();await idle();await page.evaluate(()=>window.fixture.configs[1].parts[0].name='后改名称');await page.locator('#source-undo').click();await idle();assert.match(await page.locator('[data-source-sync-message]').textContent(),/后来已修改/);assert.equal(await page.evaluate(()=>window.fixture.configs[1].parts[0].name),'后改名称');
 await setup();await choose('b','name');await page.locator('[data-review-export]').check();await page.evaluate(()=>window.fixture.partial=true);await page.locator('#source-apply').click();await idle();assert.match(await page.locator('[data-source-sync-message]').textContent(),/已导出 1 张图片，失败 1 张/);assert.equal(await page.locator('#source-undo').isEnabled(),true);
 await page.screenshot({path:path.join(out,'source-export-undo.png')});assert.deepEqual(errors,[]);
 const result={passed:true,changedKeepsOriginalNumber:true,allOnlyAffectedLinks:true,chooseBeforeRendering:true,nativeSessionBridge:true,themePreserved:true,cancelRetryNoReapply:true,undoOnce:true,nextBatchUndo:true,undoFailedSaveRetry:true,addedTimestampRemoved:true,ignoreUndo:true,laterUnrelatedEditPreserved:true,laterSameFieldProtected:true,partialReceiptHonest:true,errors};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
