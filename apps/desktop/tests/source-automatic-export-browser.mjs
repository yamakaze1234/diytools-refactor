import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve('apps/desktop/public/workbench'),out=path.resolve(process.env.WORKBENCH_SCREENSHOTS||'../ui');await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench-ui.css"><link rel="stylesheet" href="/workbench-simple.css"><link rel="stylesheet" href="/source-sheet.css"><dialog class="source-dialog"><div id="dialog-body"><div class="source-sync-top" id="mount"></div></div></dialog>');return;}const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error('path');res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file));}catch(e){res.statusCode=404;res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
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
  const api={message(){},isEdited:()=>false,flush:async()=>{},getConfigs:()=>configs,getRows:()=>[row],shopId:()=> 'intel',apply:async plan=>{
   if(f.failSave)throw Error('模拟保存失败');
   applySourceSync(plan,configs,[row]);f.applied.push(plan);
  },renderImage:async c=>{f.rendered.push({id:c.id,theme:c.theme});const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;return {canvas,overflow:false};},download:()=>{throw Error('必须走目录选择');}};
  // 两个正式入口各有独立会话，复用领域保存和出图夹具。
  const views={};window.selectView=view=>{for(const [name,pane] of Object.entries(views))pane.hidden=name!==view;
   if(!views[view]){const pane=document.createElement('section');views[view]=pane;document.querySelector('#mount').append(pane);const session=mountSourceSync(pane,{...api,view});if(view==='automatic')window.sync=session;}
  };window.selectView('automatic');window.selectView('pending');if(!document.querySelector('dialog').open)document.querySelector('dialog').showModal();
 });await page.locator('[data-review-link] option[value="链接1"]').waitFor({state:'attached'});}

 const idle=()=>page.waitForFunction(()=>!document.querySelector('[data-auto-export]').disabled);
 await setup();
 await page.evaluate(()=>window.selectView('automatic'));
 // 导出准备中断时还没有图片任务；关闭保存弹窗后用同一批回执补导，无需再次写配置。
 await page.evaluate(async()=>{
  const {openSavedAddonDecision}=await import('/source-saved-addon-dialog.js');
  const {SourceChangeSession}=await import('/source-sync-data.js');
  const f=window.fixture,config=f.configs[2],session=new SourceChangeSession('intel');
  const change={id:config.id,name:config.name,product:config.product,before:config,details:[{
   sourceId:f.row.sourceId,slot:'内存',field:'upgrade',kind:'follow',before:'旧说明',after:'新说明',
  }]};
  const plan={shopId:'intel',followConfigCount:1,followLinkCount:1,manualConfigCount:0,manualLinkCount:0,changes:[change]};
  void openSavedAddonDecision({plan,rows:[f.row],apply:async()=>{f.applied.push(plan);},
   prepareExport:async()=>{throw Error('模拟链接读取超时');},
   onUpdatedWithoutExport:changes=>{session.record(changes);window.sync.showAutomaticChanges(session.records);}});
 });
 const prompt=page.locator('#modal-save-prompt');
 await prompt.locator('#btn-update-now').click();
 await prompt.getByText(/模拟链接读取超时.*本次变动/).waitFor();
 assert.equal(await prompt.locator('#btn-update-now').isDisabled(),true);
 assert.equal(await page.locator('#image-task-center-toggle').count(),0);
 await prompt.locator('#btn-defer-update').click();
 assert.deepEqual(await page.locator('[data-auto-config]:checked').evaluateAll(els=>els.map(el=>el.dataset.autoConfig)),['c']);
 await page.locator('[data-auto-export]').click();await idle();
 const recovered=await page.evaluate(()=>({writes:window.fixture.applied.length,files:window.fixture.exports[0].files.map(file=>file.name)}));
 assert.equal(recovered.writes,1);
 assert.deepEqual(recovered.files,['链接2_配置图/1_配置1.png','链接2_sku图/1_配置1.png','导出清单.json']);
 await page.evaluate(()=>{window.fixture.applied=[];window.fixture.exports=[];});
 await page.evaluate(()=>window.sync.showAutomaticChanges(window.fixture.configs.filter(c=>c.id!=='a').map(c=>({id:c.id,name:c.name,product:c.product,before:structuredClone(c),details:[{slot:'内存',field:'upgrade',partIndex:0,before:'旧说明',after:'新说明'}]}))));

 assert.match(await page.locator('.source-review-standalone h3').textContent(),/本次变动/);
 assert.equal(await page.locator('[data-auto-export]').textContent(),'导出所选图片');

 await page.evaluate(()=>window.selectView('pending'));
 // 混合选择和纯核算价用例需要主动展开字段筛选。
 const fields=page.locator('.sd-fields');
 await fields.locator('summary').click();await fields.locator('[data-source-field=tax]').check();await fields.locator('summary').click();
 await page.locator('[data-source-select][value*=tax]').first().waitFor({state:'attached'});
 await page.locator('[data-review-search]').fill('不存在的配置');assert.match(await page.locator('[data-source-groups]').textContent(),/没有待确认/);
 await page.locator('[data-review-search]').fill('配置2');assert.equal(await page.locator('[data-source-select]').count(),3);
 await page.locator('[data-review-search]').fill('');await page.locator('[data-review-slot]').selectOption('内存');
 await page.screenshot({path:path.join(out,'simplified-pending-wide.png')});
 await page.setViewportSize({width:600,height:900});await page.screenshot({path:path.join(out,'simplified-pending-narrow.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1400,height:1050});
 // 勾选只处理已选手动字段；混入核算单价时跳过它，不能扩大为全部。
 await page.locator('[data-review-link]').selectOption('链接1');
 const pick=async(id,field)=>page.locator('[data-source-select]').evaluateAll((els,{id,field})=>els.find(el=>{const key=JSON.parse(el.value);return key[0]===id&&key.at(-1)===field;}).click(),{id,field});
 await pick('a','tax');assert.equal(await page.locator('#source-keep-all').isDisabled(),true);
 await pick('b','upgrade');assert.equal(await page.locator('#source-keep-all').isEnabled(),true);
 await page.locator('[data-review-link]').selectOption('链接2');
 await page.locator('#source-keep-all').click();await page.waitForFunction(()=>!document.querySelector('#source-check').disabled);
 let chosen=await page.evaluate(()=>window.fixture);assert.equal(chosen.applied.length,1);assert.deepEqual(chosen.applied[0].changes.map(c=>c.id),['b']);assert.deepEqual(chosen.applied[0].changes[0].details.map(d=>d.field),['upgrade']);
 assert.equal(chosen.configs[0].parts[0].tax,100);assert.equal(chosen.configs[2].parts[0].sourceFollow?.upgrade?.ignoredSourceValue,undefined);
 await page.locator('#source-undo').click();await page.waitForFunction(()=>!document.querySelector('#source-check').disabled);
 await page.evaluate(()=>window.fixture.applied=[]);
 // 无勾选时不会整店忽略。显式选取一个配置的两项人工文案之后才允许提交。
 await page.locator('[data-review-link]').selectOption('链接1');
 assert.equal(await page.locator('#source-keep-all').isDisabled(),true);
 await pick('b','name');await pick('b','upgrade');
 await page.locator('#source-keep-all').click();await page.waitForFunction(()=>!document.querySelector('#source-check').disabled);
 let kept=await page.evaluate(()=>window.fixture);assert.equal(kept.applied.length,1);assert.equal(kept.applied[0].action,'ignore');assert.deepEqual(kept.applied[0].changes.map(c=>c.id),['b']);
 assert.equal(kept.configs[1].parts[0].name,'原名称');assert.equal(kept.configs[1].parts[0].upgrade,'手写说明');assert.equal(kept.configs[1].parts[0].tax,100);
 assert.equal(kept.configs[1].parts[0].sourceFollow.name.ignoredSourceValue,'新名称');assert.equal(kept.configs[1].parts[0].sourceFollow.upgrade.ignoredSourceValue,'新说明');
 assert.equal(await page.locator('#source-keep-all').isDisabled(),true);
 await page.locator('#source-check').click();await page.locator('[data-source-select]').first().waitFor({state:'attached'});assert.equal(await page.locator('#source-keep-all').isDisabled(),true);
 await page.locator('#source-undo').click();await page.waitForFunction(()=>!document.querySelector('#source-check').disabled);await pick('b','name');
 await page.evaluate(()=>window.fixture.failSave=true);await page.locator('#source-keep-all').click();await page.waitForFunction(()=>!document.querySelector('#source-check').disabled);assert.match(await page.locator('[data-source-sync-message]:visible').textContent(),/模拟保存失败/);
 await page.evaluate(()=>{window.fixture.failSave=false;window.fixture.applied=[];});await page.locator('#source-check').click();
 await page.evaluate(()=>window.selectView('automatic'));await page.locator('[data-source-automatic] details.source-review-members').evaluateAll(els=>els.forEach(el=>el.open=true));
 await page.locator('[data-auto-config="c"]').uncheck();
 await page.locator('[data-auto-export]').click();await idle();
 let f=await page.evaluate(()=>window.fixture);assert.equal(f.applied.length,0);assert.deepEqual(f.exports[0].files.map(x=>x.name),['链接1_配置图/2_配置2.png','链接1_sku图/2_配置2.png','导出清单.json']);
 await page.locator('[data-auto-export-scope]').evaluate(el=>el.closest('details').open=true);await page.locator('[data-auto-export-scope]').selectOption('all');await page.locator('[data-auto-export-images]').selectOption('square');await page.locator('[data-auto-export]').click();await idle();
 f=await page.evaluate(()=>window.fixture);assert.equal(f.exports.at(-1).files.length,3);assert.ok(f.exports.at(-1).files.filter(x=>x.name.endsWith('.png')).every(x=>x.name.includes('_sku图/')));assert.equal(f.applied.length,0);
 await page.locator('[data-auto-select-all]').check();await page.locator('[data-auto-select-all]').uncheck();assert.equal(await page.locator('[data-auto-export]').isDisabled(),true);
 await page.locator('[data-auto-select-all]').check();await page.screenshot({path:path.join(out,'automatic-export-wide.png')});
 await page.setViewportSize({width:600,height:900});await page.screenshot({path:path.join(out,'automatic-export-narrow.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>window.selectView('pending'));
 await page.evaluate(()=>{const f=window.fixture;for(let i=0;i<18;i++){const c=structuredClone(f.original[0]);c.id='page-'+i;c.parts[0].name='不同名称'+i;f.configs.push(c);}});
 await page.locator('#source-check').click();await page.waitForFunction(()=>document.querySelector('[data-review-next]')&&!document.querySelector('[data-review-next]').disabled);
 assert.equal(await page.locator('[data-source-description-group]').count(),12,'首屏仅渲染一页差异组');
 await page.locator('[data-source-select-group]').first().check();const selectedText=await page.locator('[data-review-selected]').textContent();await page.locator('[data-review-next]').click();assert.equal(await page.locator('[data-review-selected]').textContent(),selectedText);await page.locator('[data-review-prev]').click();assert.equal(await page.locator('[data-source-select-group]').first().isChecked(),true);
 await page.locator('[data-review-search]').fill('不同名称17');assert.equal(await page.locator('[data-source-description-group]').count(),1);assert.equal(await page.locator('[data-review-prev]').isVisible(),false);

 await page.evaluate(()=>window.selectView('automatic'));
 await page.evaluate(()=>window.sync.showAutomaticChanges(Array.from({length:18},(_,i)=>({id:'auto-page-'+i,name:'配置'+i,product:'测试链接',before:{shopId:'intel',productId:'p'},details:[{slot:'内存',field:'upgrade',partIndex:0,before:'旧'+i,after:'新'+i}]}))));
 assert.equal(await page.locator('[data-auto-source-group]').count(),8);await page.locator('[data-auto-next]').click();assert.equal(await page.locator('[data-auto-source-group]').count(),8);assert.equal(await page.locator('[data-auto-config]:checked').count(),8);await page.locator('[data-auto-next]').click();assert.equal(await page.locator('[data-auto-source-group]').count(),2);assert.equal(await page.locator('[data-auto-next]').isDisabled(),true);await page.locator('[data-auto-search]').fill('配置17');assert.equal(await page.locator('[data-auto-source-group]').count(),1);assert.equal(await page.locator('[data-auto-prev]').isDisabled(),true);
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,automaticOnly:true,selection:true,images:true,scope:true,noReapply:true,emptyDisabled:true,errors},null,2));console.log('automatic export browser checks passed');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
