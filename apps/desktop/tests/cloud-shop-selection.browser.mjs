import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
let clearCalls=[];
const server=createServer(async(req,res)=>{try{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end(`<meta charset="UTF-8"><button id="workspace-sync"></button><span id="workspace-sync-status"></span><button id="operator-open"></button><dialog id="dialog"></dialog><script type="module">import {bindWorkspaceSync} from '/workbench/workspace-sync-ui.js';window.runs=[];window.messages=[];window.ui=await bindWorkspaceSync({flush:async()=>{},receive:async()=>true,esc:String,toast:m=>messages.push(m),openDialog:(title,html)=>{const d=document.querySelector('dialog');d.innerHTML='<form method="dialog"><div class="dialog-title"><h2 id="dialog-title">数据与同步</h2><button aria-label="关闭" class="close">×</button></div></form><div id="dialog-body">'+html+'</div>';if(!d.open)d.showModal();}});window.ready=true;</script>`);return;}
 if(req.url==='/workbench/cloud-worker-client.js'){res.setHeader('content-type','text/javascript');res.end(`export function createCloudWorker(){return {run:async args=>{window.runs.push(args);return {pending:0,conflicts:0};},stop(){}};}`);return;}
 if(req.url==='/api/cache/shops/preview'||req.url==='/api/cache/shops/clear'){
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/preview'))res.end(JSON.stringify({shopIds:input.shopIds,shops:input.shopIds.map(id=>({id,configs:3,templates:1,settings:1})),baseRevision:8,cloudVersion:9,blocked:false}));
  else{clearCalls.push(input);res.end(JSON.stringify({backup:'isolated-backup.json',cloudDeleted:false}));}return;
 }
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/status')?{configured:true,session:{authenticated:true,member:{uid:'test',workspaceId:'isolated'}},checkpoint:{initialized:true,uid:'test',workspaceId:'isolated'}}:{skipped:true}));return;}
 res.setHeader('content-type','text/javascript');res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
 }catch(e){res.statusCode=404;res.end(String(e));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(url);await page.waitForFunction(()=>window.ready&&runs.length===1);
 assert.deepEqual(await page.evaluate(()=>runs[0].shopIds),['intel']);
 await page.click('#workspace-sync');await page.locator('[data-cloud-shop="jonsbo"]').check();await page.locator('[data-cloud-shop="intel"]').uncheck();
 await page.click('#cloud-sync-now');await page.waitForFunction(()=>runs.length===2);
 assert.deepEqual(await page.evaluate(()=>runs.at(-1).shopIds),['jonsbo']);
 await page.locator('[data-cloud-shop="jonsbo"]').click();assert.equal(await page.locator('[data-cloud-shop="jonsbo"]').isChecked(),true);
 await page.reload();await page.waitForFunction(()=>window.ready&&runs.length===1);assert.deepEqual(await page.evaluate(()=>runs[0].shopIds),['jonsbo']);
 await page.click('#workspace-sync');await page.locator('[data-cloud-shop="gigabyte"]').check();await page.click('#cloud-sync-now');await page.waitForFunction(()=>runs.length===2);
 assert.deepEqual(await page.evaluate(()=>runs.at(-1).shopIds),['gigabyte','jonsbo']);assert.deepEqual(errors,[]);
 if(process.env.UI_CAPTURE){
  for(const name of ['style.css','workbench-ui.css','workbench-simple.css','desktop-layout.css','ui-polish.css'])await page.addStyleTag({content:await readFile(new URL('../public/workbench/'+name,import.meta.url),'utf8')});
  await page.locator('#dialog').screenshot({path:process.env.UI_CAPTURE+'.png'});
  await page.setViewportSize({width:480,height:950});
  assert.equal(await page.evaluate(()=>document.querySelector('#dialog').scrollWidth<=document.querySelector('#dialog').clientWidth),true);
  await page.locator('#dialog').screenshot({path:process.env.UI_CAPTURE+'-narrow.png'});
  await page.locator('.cloud-tools summary').click();assert.equal(await page.locator('#cloud-diagnostics').isVisible(),true);
 }
 await page.locator('.cloud-tools summary').evaluate(n=>{n.parentElement.open=true;});
 await page.click('#local-cache');await page.click('#cache-shops');
 await page.locator('[data-cleanup-shop="jonsbo"]').check();await page.locator('[data-cleanup-shop="gigabyte"]').check();
 await page.click('#shop-cleanup-preview');await page.waitForSelector('#shop-cleanup-confirm');
 assert.equal(clearCalls.length,0);assert.match(await page.locator('#dialog').innerText(),/3 套配置/);
 await page.click('#shop-cleanup-confirm');await page.waitForSelector('#shop-cleanup-done');
 assert.equal(clearCalls.length,1);assert.equal(clearCalls[0].confirmed,true);assert.equal(clearCalls[0].baseRevision,8);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('diy-cloud-selected-shops'))),[]);
 assert.match(await page.locator('#dialog').innerText(),/云端保留/);
 await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await page.evaluate(()=>runs.length),0);
 await page.click('#workspace-sync');await page.locator('[data-cloud-shop="jonsbo"]').check();await page.click('#cloud-sync-now');await page.waitForFunction(()=>runs.length===1);
 assert.deepEqual(await page.evaluate(()=>runs[0].shopIds),['jonsbo']);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',defaultCurrentShop:true,singleShop:true,multipleShops:true,reloadRemembered:true,emptySelectionBlocked:true,shopCleanupPreviewAndConfirm:true,emptyAfterCleanupSurvivesReload:true,reselectSync:true,errors}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
