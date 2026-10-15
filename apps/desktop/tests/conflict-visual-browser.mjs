import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve('apps/desktop/public/workbench'),out=path.resolve('sandbox/conflict-visual-20261015/ui');await fs.mkdir(out,{recursive:true});
// 直接复用正式页面的弹窗壳和样式顺序，防止预览结构偏离现用界面。
const workbenchHtml=await fs.readFile(path.join(root,'index.html'),'utf8');
const dialogShell=workbenchHtml.match(/<dialog id="dialog">[\s\S]*?<\/dialog>/)[0]
 .replace('<h2 id="dialog-title"></h2>','<h2 id="dialog-title">处理同步冲突</h2>')
 .replace('<div id="dialog-body"></div>','<div id="dialog-body"><div id="mount"></div></div>');
const styles=workbenchHtml.match(/<link rel="stylesheet"[^>]*>/g).join('');
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+dialogShell+'</html>');return;}const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error('path');res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file));}catch(e){res.statusCode=404;res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async()=>{
  const {mountCloudConflicts}=await import('/cloud-conflict-view.js'),{createCloudEngine}=await import('/cloud-engine.js'),{createCloudController}=await import('/cloud-controller.js'),{projectWorkspace}=await import('/cloud-projection.js');
  const member={uid:'test',workspaceId:'isolated'},copy=structuredClone;
  const state={revision:1,configs:Array.from({length:3},(_,i)=>({id:'c'+i,shopId:'intel',shop:'示例店铺',product:'台式主机 · 链接'+(i+1),name:'配置'+(i+1),price:6999,parts:[{lineId:'gpu',goodsId:'123',slot:'显卡',qty:1,name:'RTX 5060 鹰系列',upgrade:'加 229 元升级'}],actualParts:[],addons:[]})),templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
  const projection=projectWorkspace(state),records=[...projection,{type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:3},createdAt:'2026-01-01T00:00:00Z'}}].map(r=>({type:r.type,id:r.id,version:1,base:copy(r.data),draft:copy(r.data),conflict:null}));
  for(const row of records.filter(r=>r.type==='configuration')){const data=copy(row.draft);data.parts[0].name='RTX 5060 风魔系列';data.parts[0].upgrade='加 299 元升级';row.version=2;row.base=copy(data);row.conflict={fields:['parts'],remote:{type:row.type,id:row.id,version:2,data}};}
  const f=window.fixture={current:{state,cloudVersion:1,document:{format:1,...member,deviceId:'test',cursor:2,records,outbox:[],materializedProjection:projection}},commits:0,flushes:0,receives:0,fail:false,messages:[],hold:false};
  const engine=createCloudEngine({load:async()=>copy(f.current),call:async()=>{throw Error('不应访问云端');},commit:async req=>{if(f.fail)throw Error('模拟磁盘写入失败');f.commits++;if(f.hold)await new Promise(r=>f.release=r);f.current={state:{...copy(req.state),revision:f.current.state.revision+1},cloudVersion:f.current.cloudVersion+1,document:copy(req.document)};return{revision:f.current.state.revision,cloudVersion:f.current.cloudVersion};}});
  const controller=createCloudController({makeEngine:()=>engine,request:async()=>({session:{authenticated:true,member},checkpoint:{initialized:true,...member,conflicts:f.current.document.records.filter(r=>r.conflict).length}}),flush:async()=>{f.flushes++;},receive:async()=>{f.receives++;return true;}});await controller.refresh();controller.pause();
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  document.querySelector('dialog').showModal();await mountCloudConflicts(document.querySelector('#mount'),{controller,esc,toast:t=>f.messages.push(t),onBack:()=>document.querySelector('dialog').close(),isCurrent:()=>document.querySelector('dialog').open});
 });
 const idle=()=>page.waitForFunction(()=>!document.querySelector('[data-conflict-refresh]')?.disabled);
 assert.equal(await page.locator('.cloud-conflict-card').count(),3,await page.locator('#mount').textContent());assert.equal(await page.locator('pre').count(),0);
 assert.match(await page.locator('.cloud-conflict-card').first().textContent(),/升级说明/);await page.locator('[data-conflict-select="0"]').check();await page.locator('[data-conflict-select="1"]').check();
 assert.match(await page.locator('[data-conflict-batch=remote]').textContent(),/2 项/);
 const layout=await page.evaluate(()=>{
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  return{dialog:rect('#dialog'),title:rect('#dialog-title'),toolbar:rect('.cloud-conflict-toolbar'),close:rect('#dialog .close'),viewport:{width:innerWidth,height:innerHeight}};
 });
 assert.ok(Math.abs(layout.dialog.x+layout.dialog.width/2-layout.viewport.width/2)<2,'弹窗水平居中');
 assert.ok(Math.abs(layout.dialog.y+layout.dialog.height/2-layout.viewport.height/2)<2,'弹窗垂直居中');
 assert.ok(Math.abs(layout.title.x-layout.toolbar.x)<2,'标题和内容左对齐');
 assert.ok(layout.title.x-layout.dialog.x>=20&&layout.title.y-layout.dialog.y>=16,'标题留有边距');
 assert.ok(layout.close.right<layout.dialog.right,'关闭按钮在弹窗内');
 await page.screenshot({path:path.join(out,'conflict-comparison.png')});
 const scrolled=await page.evaluate(()=>{
  document.querySelector('#dialog-body').scrollTop=250;
  const rect=selector=>document.querySelector(selector).getBoundingClientRect();
  return{titleY:rect('#dialog-title').y,toolbarY:rect('.cloud-conflict-toolbar').y,bodyY:rect('#dialog-body').y,scrollTop:document.querySelector('#dialog-body').scrollTop};
 });
 assert.ok(scrolled.scrollTop>0);assert.equal(scrolled.titleY,layout.title.y);
 assert.ok(Math.abs(scrolled.toolbarY-layout.toolbar.y)<2,'滚动时批量操作固定在内容区顶部 '+JSON.stringify(scrolled));
 await page.evaluate(()=>document.querySelector('#dialog-body').scrollTop=0);

 await page.locator('[data-conflict-batch=remote]').click();await idle();assert.equal(await page.locator('.cloud-conflict-card').count(),1);
 let result=await page.evaluate(()=>({commits:fixture.commits,flushes:fixture.flushes,receives:fixture.receives,names:fixture.current.state.configs.map(c=>c.parts[0].name)}));assert.deepEqual(result,{commits:1,flushes:1,receives:1,names:['RTX 5060 风魔系列','RTX 5060 风魔系列','RTX 5060 鹰系列']});
 // 保存失败保留勾选；预览后的编辑拒绝覆盖，刷新后可重试。
 await page.locator('[data-conflict-all]').check();await page.evaluate(()=>fixture.fail=true);await page.locator('[data-conflict-batch=remote]').click();await idle();assert.equal(await page.locator('[data-conflict-select]').isChecked(),true);assert.match(await page.locator('[data-conflict-message]').textContent(),/写入失败/);
 await page.evaluate(()=>{fixture.fail=false;fixture.current.state.configs[2].parts[0].upgrade='刚编辑的说明';fixture.current.state.revision++;});await page.locator('[data-conflict-batch=remote]').click();await idle();assert.match(await page.locator('[data-conflict-message]').textContent(),/重新比较/);assert.equal(await page.evaluate(()=>fixture.commits),1);
 await page.locator('[data-conflict-refresh]').click();await idle();assert.match(await page.locator('.cloud-conflict-table').textContent(),/刚编辑的说明/);
 await page.setViewportSize({width:480,height:820});await page.screenshot({path:path.join(out,'conflict-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('[data-conflict-all]').check();await page.evaluate(()=>fixture.hold=true);await page.locator('[data-conflict-batch=remote]').click();await page.waitForFunction(()=>typeof fixture.release==='function');assert.equal(await page.locator('[data-conflict-batch=remote]').isDisabled(),true);
 await page.evaluate(()=>{document.querySelector('dialog').close();fixture.release();});await page.waitForFunction(()=>fixture.current.document.records.every(r=>!r.conflict));assert.equal(await page.locator('dialog').evaluate(n=>n.open),false);assert.deepEqual(errors,[]);
 const evidence={passed:true,actualEngineAndController:true,bulkOneCommit:true,unselectedPreserved:true,failedSaveKeepsSelection:true,staleDraftRejected:true,refreshIncludesLatestSavedDraft:true,closeDoesNotReopen:true,responsive:true,productionDialogShell:true,layout,stickyToolbarVerified:true,errors};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
