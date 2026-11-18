// 原桌面前端通过隔离桥接调用真实三店 HTTP 接口，验证常用入口和主题。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const fixture=resolve(process.argv[2]);
const useLegacy=process.argv.includes('--legacy');
const api=await startSourceAcceptance({fixture,sharedSources:!useLegacy,root:join(fixture,'workbench-browser-uploads'),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const root=resolve(import.meta.dirname,'../dist');
const headers={'x-workbench-deployment':fixtureDeployment};
const staticServer=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/images/')){
  const image=await fetch(api.url+path);
  res.writeHead(image.status,{'content-type':image.headers.get('content-type')??'application/octet-stream'});
  return res.end(Buffer.from(await image.arrayBuffer()));
 }
 const file=resolve(root,'.'+decodeURIComponent(path==='/'?'/index.html':path));
 if(!file.startsWith(root+sep)){res.writeHead(403);return res.end();}
 try{
  const content=await readFile(file);
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml',
   '.json':'application/json','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg'}[extname(file)];
  res.writeHead(200,{'content-type':type??'application/octet-stream'});res.end(content);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>staticServer.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+staticServer.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'dark',reducedMotion:'reduce'});
 page.setDefaultTimeout(9000);
 const errors=[];
 let workbookVersion=0;
 let denySiblingCatalog=false;
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
 page.on('dialog',dialog=>dialog.accept());
 await page.exposeFunction('acceptanceInvoke',async(command,args)=>{
  const result=(data,status=200)=>({status,body:JSON.stringify(data)});
  if(command==='nas_identity_request')return result({session:{configured:true,authenticated:true,
   member:{uid:fixtureActor,workspaceId:fixtureWorkspace}}});
  if(command==='nas_native_request' && args.route==='/settings')return result({
   configured:true,main_editor:true,endpoint_id:'isolated-test',deployment_id:fixtureDeployment,acceptance:true});
  if(command==='nas_native_request'){
   const route=new URL(args.route,api.url);
   if(denySiblingCatalog&&route.pathname.endsWith('/workspace-catalog')&&route.searchParams.get('shop_id')==='jonsbo')
    return result({error:'FORBIDDEN'},403);
   const res=await fetch(api.url+args.route,{method:args.method,headers:{...headers,'content-type':'application/json'},
    body:args.body??undefined});
   return {status:res.status,body:await res.text()};
  }
  if(command==='nas_upload_request'){
   const path='/api/v1/operations/catalog/assets?'+new URLSearchParams({shop_id:args.shopId,operation_id:args.operationId});
   const res=await fetch(api.url+path,{method:'POST',headers:{...headers,'content-type':args.mime},body:Buffer.from(args.base64,'base64')});
   return {status:res.status,body:await res.text()};
  }
  if(command==='nas_erp_read'&&args.kind==='tax-current'){
   workbookVersion++;
   if(workbookVersion===3)return result({ok:false,error:'测试成本表暂不可读取'},503);
   return result({ok:true,rows:[{goods_id:'100001',tax:70+workbookVersion}],
    workbook:{name:'主机成本表V2新_修复版.xlsb'}});
  }
  if(command==='nas_erp_read')return result({ok:true,rows:[]});
  return 1;
 });
 await page.addInitScript(()=>{
  window.isTauri=true;
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:(_path)=>location.origin,
   invoke:(command,args)=>window.acceptanceInvoke(command,args)};
 });
 await page.goto(origin);
 const frame=page.frameLocator('.legacy-workbench-frame');
 const el=selector=>frame.locator(selector);
 await frame.locator('#shop-picker').waitFor();
 const waitReady=()=>el('[data-nav="source"]').evaluate(el=>new Promise((resolve,reject)=>{
  const expires=performance.now()+12000;
  const poll=()=>window.workbenchReady?resolve(true):performance.now()>expires?reject(new Error(document.querySelector('#save-status').textContent)):setTimeout(poll,50);
  poll();
 }));
 await waitReady();
 async function openSource(id){
  await frame.getByRole('button',{name:'维护',exact:true}).click();
  await frame.getByRole('button',{name:'输出源维护',exact:true}).click();
  await el('#source-search').fill(id);
  await el('#source-list .source-item').first().click();
  await el('#source-edit-scope').waitFor();
 }
 async function saveSource(){
  await el('#source-save').click();
  await frame.getByRole('status').filter({hasText:/已保存 \d+ 条输出源/}).waitFor({timeout:15000});
 }
 const close=()=>el('#dialog .dialog-title button').first().click();
 async function shop(next){
  await el('#shop-picker').selectOption(next);
  await waitReady();
  assert.equal(await el('#shop-picker').inputValue(),next);
 }
 const projection=(shop,key)=>el(`[data-source-projection="${shop}"] [data-field="${key}"]`).innerText();
 await openSource('9900011');
 assert.equal(await el('#source-edit-scope').inputValue(),'shared');
 assert.equal(await el('#source-id').inputValue(),'9900011');
 assert.equal(await el('#source-import-file').count(),0);
 if(useLegacy)await frame.getByText('三店共用验收 · 读取三个店铺的现用资料，修改保存在本机。').waitFor();
 assert.match(await projection('intel','tax'),/220.*保留店铺原值/);
 assert.match(await projection('gigabyte','tax'),/230.*保留店铺原值/);
 assert.match(await projection('jonsbo','tax'),/240.*保留店铺原值/);
 await el('#source-tax').fill('250');
 await el('#source-edit-scope').selectOption('gigabyte');
 await el('[data-source-restore="tax"]').click();
 await saveSource();
 assert.match(await projection('gigabyte','tax'),/250.*共用/);
 assert.match(await projection('intel','tax'),/220.*保留店铺原值/);
 await close();
 await openSource('9900012');
 assert.equal(await el('[data-choice]').count(),2);
 assert.equal(await el('#source-maintenance-fields summary').innerText(),'容量、硬件简称维护');
 assert.equal(await el('#field-upgrade,#addon-structure').count(),0);
 await el('#source-edit-scope').selectOption('jonsbo');
 await el('[data-choice-label]').first().fill('单店加购测试');
 await saveSource();
 assert.match(await projection('jonsbo','addon'),/单店加购测试.*单店覆盖/);
 assert.doesNotMatch(await projection('intel','addon'),/单店加购测试/);
 await close();
 await openSource('9900012');
 await el('#source-new').click();
 await el('#source-id').fill('9900013');
 await el('#source-name').fill('测试新品 48GB');
 await el('#source-tax').fill('314.25');
 await el('[data-choice-add]').click();
 await el('[data-choice-label]').first().fill('可加购风扇');
 await saveSource();
 assert.match(await projection('gigabyte','name'),/测试新品 48GB/);
 await close();
 await shop('gigabyte');
 await openSource('9900013');
 assert.equal(await el('#source-name').inputValue(),'测试新品 48GB');
 await close();
 await frame.getByRole('button',{name:'维护',exact:true}).click();
 await frame.getByRole('button',{name:'当前店铺核算价',exact:true}).click();
 let costInput=el('[data-manual-price="100001"]');
 await frame.getByText(/主机成本表V2新_修复版.xlsb · 匹配/).waitFor();
 assert.equal(await costInput.inputValue(),'71');
 await el('#cost-workbook-refresh').click();
 await frame.getByText(/主机成本表V2新_修复版.xlsb · 匹配/).waitFor();
 assert.equal(await costInput.inputValue(),'72');
 // 读取失败后回到 NAS 已保存价，并废弃基于旧值的批量预览。
 await el('#cost-source-paste-toggle').click();
 await el('#cost-paste-values').fill('100001\t82');
 await el('#cost-paste-check').click();
 assert.match(await el('#cost-paste-diff').innerText(),/72\.00 → 82\.00/);
 assert.equal(await el('#cost-paste-apply').isEnabled(),true);
 await el('#cost-workbook-refresh').click();
 await frame.getByText(/当前显示 NAS 已保存价/).waitFor();
 assert.equal(await costInput.inputValue(),'13');
 assert.equal(await el('#cost-paste-apply').isDisabled(),true);
 assert.equal(await el('#cost-paste-diff').innerText(),'');
 await close();
 if(useLegacy){
  // 兄弟店的目录接口失败时，本店原有正式维护仍可打开。
  denySiblingCatalog=true;
  await frame.getByRole('button',{name:'维护',exact:true}).click();
  await frame.getByRole('button',{name:'输出源维护',exact:true}).click();
  await frame.getByText('三店验收暂不可用，已打开本店正式维护。').waitFor();
  await el('#source-search').fill('100001');
  await el('#source-list .source-item').first().click();
  assert.equal(await el('#source-id').inputValue(),'100001');
  assert.equal(await el('#source-edit-scope').count(),0);
  await close();
  denySiblingCatalog=false;
 }
 if(useLegacy)assert.equal((await api.db.query("SELECT count(*)::int AS rows FROM gigabyte_live.sources WHERE goodsid='9900013'")).rows[0].rows,0);
 const config=el('[data-id="fixture-overlap"]');
 if(!await config.isVisible())await el('[data-product-toggle="fixture-link"]').click();
 await config.click();
 await el('#select-all').check();
 await el('#copy-open').click();
 await el('[data-copy-kind="parts"]').click();
 const columns=(await el('#copy-preview').inputValue()).split('\t');
 assert.equal(columns.length,56);
 assert.equal(columns[0],'100001');
 assert.match(columns[1],/主机成本表V2新_修复版\.xlsb.*\$W:\$W.*\$M:\$M/);
 await frame.getByText('配件公式设置',{exact:true}).click();
 const custom='=@IF([@[CPU_id]]<>"",INDEX(参名称,[@定位CPU]),"")';
 await el('#part-formula-input').fill(custom);
 await el('#part-formula-save').click();
 const configured=(await el('#copy-preview').inputValue()).split('\t');
 assert.equal(configured[1],custom);
 assert.equal(configured[9],custom.replaceAll('CPU','主板'));
 await close();
 await el('#copy-open').click();
 assert.equal((await el('#copy-preview').inputValue()).split('\t')[1],custom);
 await frame.getByText('配件公式设置',{exact:true}).click();
 await el('#part-formula-range').selectOption('one');
 await el('#part-formula-input').fill('=B2');
 await el('#part-formula-slot').selectOption('主板');
 await el('#part-formula-save').click();
 assert.equal((await el('#copy-preview').inputValue()).split('\t')[9],'=B2');
 await close();
 // 原图库界面应展示来自其他店的原图，并允许从当前配置选用。
 await el('#asset-button').evaluate(button=>button.click());
 const foreign=el('[data-gallery-use^="shared-gallery:"]');
 await foreign.first().waitFor();
 assert.equal(await foreign.count(),2);
 await foreign.first().click();
 await el('#dialog').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({workbench:true,mode:useLegacy?'legacy-live-read':'shared-api',freshWorkbook:true,sharedDefaults:true,history:true,restore:true,shopAddon:true,
  createAcrossStores:true,repairedFormula:true,foreignGallerySelection:true}));
}finally{
 await browser.close();
 await new Promise(resolve=>{staticServer.close(resolve);staticServer.closeAllConnections();});
 await api.close();
}
