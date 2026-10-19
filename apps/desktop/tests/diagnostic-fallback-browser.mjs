import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve('apps/desktop/public/workbench'),out=path.resolve('sandbox/save-timeout-diagnostics-20261017');
await fs.mkdir(out,{recursive:true});
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const shell=html.match(/<dialog id="dialog">[\s\S]*?<\/dialog>/)[0],styles=html.match(/<link rel="stylesheet"[^>]*>/g).join('');
const source=(await fs.readFile(path.join(root,'workspace-sync-ui.js'),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export async function bindWorkspaceSync','async function bindWorkspaceSync');
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'+styles+'<button id="workspace-sync">同步</button><span id="workspace-sync-status"></span><button id="operator-open"></button>'+shell+'</html>');return;}const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error('path');res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async source=>{
  const view={session:{configured:true,authenticated:true,member:{name:'测试成员'}},checkpoint:{initialized:true,conflicts:0},summary:{pending:1},running:true,automatic:true,error:null};
  const controller={status:()=>view,start:async()=>{},refresh:async()=>{},tick:async()=>{}};
  const createCloudController=()=>controller,createCloudWorker=()=>({}),bindVersionHistory=()=>({}),bindLegacyHistory=()=>({});
  window.fetch=async()=>({ok:true,json:async()=>({skipped:true})});
  window.workbenchExportDiagnostics=()=>new Promise(()=>{});
  window.workbenchDiagnosticText=()=>JSON.stringify({schema:1,privacy:'metadata-only',scope:'current-session',events:[{stage:'local-save-wait',phase:'error',code:'TIMEOUT'},{stage:'local-save',phase:'running',code:'PENDING'}]},null,2);
  const openDialog=(title,body)=>{document.querySelector('#dialog-title').textContent=title;document.querySelector('#dialog-body').innerHTML=body;if(!document.querySelector('#dialog').open)document.querySelector('#dialog').showModal();};
  const flush=async()=>{throw Error('诊断不应触发保存');};
  await eval(source+';bindWorkspaceSync({flush,receive:async()=>true,esc:String,toast:()=>{},openDialog}).then(ui=>ui.open())');
 },source);
 await page.locator('#cloud-diagnostics').click();assert.equal(await page.locator('#cloud-diagnostics').isDisabled(),true);
 await page.locator('#cloud-diagnostic-text').click();
 assert.match(await page.locator('#diagnostic-text').inputValue(),/local-save-wait/);
 for(const [name,width] of [['wide',1280],['narrow',560]]){
  await page.setViewportSize({width,height:960});
  const box=await page.locator('#diagnostic-text').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  await page.screenshot({path:path.join(out,`diagnostic-${name}.png`)});
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'browser-result.json'),JSON.stringify({ok:true,scenario:'native export never returns; real diagnostic text button remains usable',viewports:[1280,560],errors,scope:'isolated browser UI with native export stub; not affected-machine save acceptance'},null,2));
 console.log('Browser diagnostic fallback passed at 1280px and 560px.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
