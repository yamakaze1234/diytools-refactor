import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve('apps/desktop/public/workbench'),out=path.resolve('sandbox/save-conflict-20261017');await fs.mkdir(out,{recursive:true});
const html=await fs.readFile(path.join(root,'index.html'),'utf8'),app=await fs.readFile(path.join(root,'app.js'),'utf8');
const shell=html.match(/<dialog id="dialog">[\s\S]*?<\/dialog>/)[0],styles=html.match(/<link rel="stylesheet"[^>]*>/g).join('');
const code=app.slice(app.indexOf('function openConflict('),app.indexOf('// 刷新当前配置的标题'));
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+shell+'</html>');return;}const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error('path');res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async code=>{
  const {saveConflictHtml}=await import('/save-conflict-view.js'),{mergeEditorState}=await import('/editor-performance.js');
  const base={revision:1,configs:[{id:'c1',name:'配置 1',shop:'示例店铺',product:'台式主机',price:6999,parts:[{lineId:'gpu',slot:'显卡',name:'RTX 5060',qty:1,upgrade:'加 229 元升级'}]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
  let state=structuredClone(base),acceptedState=structuredClone(base),changeCounter=0,conflict=true,dirty=true,fullWorkspace=false;
  state.configs[0].parts[0].name='RTX 5060 Ti';state.configs[0].parts[0].upgrade='加 299 元升级';
  const remote=structuredClone(base);remote.revision=2;remote.configs[0].parts[0].name='RTX 5070';remote.configs[0].parts[0].upgrade='加 599 元升级';remote.configs[0].price=7299;
  const f=window.fixture={writes:[],saved:0,errors:[],edit(){state.configs[0].parts[0].upgrade='加 399 元升级';changeCounter++;},getState:()=>state};
  const $=selector=>document.querySelector(selector),esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cloneEditorState=structuredClone,toast=message=>f.errors.push(message),backup=()=>{};
  function openDialog(title,body){$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=body;$('#dialog-body').scrollTop=0;if(!$('#dialog').open)$('#dialog').showModal();}
  const closeDialog=()=>$('#dialog').close();
  async function completeWorkspaceSnapshot(){return{...mergeEditorState(base,state,remote),remote:structuredClone(remote),counter:changeCounter};}
  const recoverySnapshot=async()=>({state:structuredClone(state),baseState:base}),request=async(url,options)=>{f.writes.push({url,body:JSON.parse(options.body)});return{ok:true};};
  const invalidateSaveScope=()=>{},save=async()=>{f.saved++;},renderAll=()=>{};
  eval(code+`;openConflict('同一内容在本机与同步版本中都有修改，当前输入已保留。');`);
 },code);
 await page.locator('#conflict-compare').click();await page.locator('.cloud-conflict-table').waitFor();
 assert.equal(await page.locator('.cloud-conflict-card').count(),1);const text=await page.locator('.cloud-conflict-table').textContent();for(const v of ['本页待保存内容','最新已保存内容','RTX 5060 Ti','RTX 5070','加 299 元升级','加 599 元升级'])assert.ok(text.includes(v),v);
 assert.equal(await page.evaluate(()=>fixture.writes.length),0);await page.screenshot({path:path.join(out,'comparison-wide.png')});
 await page.setViewportSize({width:480,height:820});await page.screenshot({path:path.join(out,'comparison-narrow.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>fixture.edit());await page.locator('#conflict-apply-local').click();await page.locator('#conflict-message').filter({hasText:'重新比较'}).waitFor();assert.equal(await page.evaluate(()=>fixture.saved),0);
 await page.locator('#conflict-refresh').click();await page.locator('.cloud-conflict-table').filter({hasText:'加 399 元升级'}).waitFor();await page.locator('#conflict-apply-local').click();
 const result=await page.evaluate(()=>({saved:fixture.saved,writes:fixture.writes.length,recoveryPrice:fixture.writes[0].body.state.configs[0].price,price:fixture.getState().configs[0].price,upgrade:fixture.getState().configs[0].parts[0].upgrade,closed:!document.querySelector('dialog').open}));
 assert.deepEqual(result,{saved:1,writes:1,recoveryPrice:6999,price:7299,upgrade:'加 399 元升级',closed:true});assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'browser-result.json'),JSON.stringify({passed:true,productionHandlers:true,responsive:true,stalePreviewRejected:true,errors,...result},null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
