/** 合成保存快照 → Edge 真实 Canvas → 隔离文件回执；不启动桌面 EXE、不访问数据库。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {dirname,resolve,extname,sep,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const publicRoot=resolve(root,'apps/desktop/public');
const directory=resolve(root,'sandbox',`agent-ui-smoke-${Date.now()}`);
await mkdir(directory,{recursive:true});
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const mime={'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf'};
const errors=[],requests=[],files=[];
const server=createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(pathname==='/__agent-smoke.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent isolated Canvas smoke</title><body>隔离 Canvas 验证</body></html>');return;}
  const path=resolve(publicRoot,'.'+pathname);
  if(path!==publicRoot&&!path.startsWith(publicRoot+sep)){res.writeHead(403);res.end();return;}
  const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolveReady=>server.listen(0,'127.0.0.1',resolveReady));
const origin=`http://127.0.0.1:${server.address().port}`;
const report={directory,checks:[],pageErrors:errors,scope:'Synthetic configs only; file callbacks are isolated test stubs, not Tauri native acceptance.'};
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1200,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('requestfailed',request=>requests.push({url:request.url(),failure:request.failure()?.errorText}));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin||url.protocol==='file:')return route.continue();
  return route.abort('blockedbyclient');
 });
 await page.exposeFunction('smokeWriteFile',async({name,base64})=>{
  assert.equal(typeof name,'string');assert.equal(isAbsolute(name),false);
  const path=resolve(directory,name);assert.ok(path.startsWith(directory+sep));
  const bytes=Buffer.from(base64,'base64');
  assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'actual PNG signature');
  assert.ok(bytes.length>1000,'PNG must contain painted content');
  const dimensions={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
  const receipt={name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...dimensions};files.push(receipt);
  return {ok:true,...receipt};
 });
 await page.exposeFunction('smokeFinish',async({reportHtml,manifest})=>{
  assert.ok(reportHtml.includes('展示 CPU')&&reportHtml.includes('实际 CPU'));
  assert.ok(reportHtml.includes('未填写')&&!reportHtml.includes('<script>'));
  assert.ok(!reportHtml.includes('UI后续改动')&&!reportHtml.includes('配置1</h2>'));
  const reportPath=resolve(directory,'report.html'),manifestPath=resolve(directory,'manifest.json'),zipPath=resolve(directory,'images.zip');
  await writeFile(reportPath,reportHtml);await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  // 测试回调也生成真实 ZIP，以免返回并不存在的成功路径；原生 ZIP 留给宿主联调。
  execFileSync('py',['-3','-X','utf8','-c','import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1]); z=pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(z,"w",zipfile.ZIP_DEFLATED) as out:\n for f in p.rglob("*"):\n  if f.is_file() and f!=z: out.write(f,f.relative_to(p))\nwith zipfile.ZipFile(z) as check:\n assert check.testzip() is None\n',directory,zipPath],{windowsHide:true,timeout:30000});
  assert.ok((await stat(zipPath)).size>1000);
  return {ok:true,directory,zipPath,reportPath,manifestPath,files};
 });
 await page.goto(`${origin}/__agent-smoke.html`);
 report.browserResult=await page.evaluate(async()=>{
  const {exportAgentSnapshot}=await import('/workbench/agent-export.js');
  const {renderPoster}=await import('/workbench/poster.js');
  const {modulesDefault}=await import('/workbench/core.js');
  const make=(id,name)=>({id,name,productId:'synthetic-link',product:'隔离测试主机',productUrl:'javascript:alert("unsafe")',shopId:'intel',spu:'00001234',skuId:'',version:'隔离测试版',shortName:'合成配置',theme:'light',layout:'long',skuMode:'dedicated',caseVisible:false,caseImage:'',posterImages:[],price:3999,modules:modulesDefault('intel','light'),parts:[{slot:'CPU',name:'展示 CPU',goodsId:'00001',qty:1,erp:100,tax:110},{slot:'内存',name:'DDR5 16GB',goodsId:'00002',qty:2,erp:150,tax:160},{slot:'硬盘',name:'NVMe 1TB',goodsId:'00003',qty:1,erp:200,tax:220}],actualParts:[{slot:'CPU',name:'实际 CPU',goodsId:'00004',qty:1,erp:120,tax:130}],addons:[],benefits:[],footer:'仅用于隔离渲染验证'});
  const configs=[make('synthetic-first','配置1'),make('synthetic-selected','配置2')];
  const initial=JSON.stringify(configs),renders=[],progress=[];
  const result=await exportAgentSnapshot({configs,revision:77,params:{images:'both',report:true,configIds:['synthetic-selected']},writeFile:window.smokeWriteFile,finish:window.smokeFinish,progress:p=>{progress.push(p);configs[1].parts[0].name='UI后续改动';},render:async(config,width)=>{
   if(config.parts[0].name!=='展示 CPU')throw Error('snapshot changed during task');
   const output=await renderPoster(config,width);
   const ctx=output.canvas.getContext('2d'),image=ctx.getImageData(0,0,output.canvas.width,output.canvas.height),colors=new Set();
   for(let i=0;i<image.data.length;i+=4*97)colors.add(Array.from(image.data.subarray(i,i+4)).join(','));
   if(colors.size<4)throw Error('canvas lacks nonuniform painted content');
   renders.push({layout:config.layout,width:output.canvas.width,height:output.canvas.height,colors:colors.size,overflow:output.overflow});
   return output;
  }});
  return {result,renders,progress,initialSnapshotHadTwoConfigs:JSON.parse(initial).length===2};
 });
 assert.equal(report.browserResult.result.export,'completed');assert.equal(report.browserResult.result.localSave,'unchanged');
 assert.deepEqual(report.browserResult.renders.map(r=>r.layout),['long','square']);
 assert.equal(report.browserResult.renders[0].width,1000);assert.equal(report.browserResult.renders[1].width,1400);
 assert.equal(report.browserResult.renders[1].height,1400);assert.ok(files.every(f=>f.name.endsWith('/2_配置2.png')));
 assert.equal(files.length,2);assert.ok(files.every(f=>f.width>0&&f.height>0));report.files=files;
 report.checks.push('actual_renderer_long_square_png','fixed_snapshot_during_ui_mutation','selected_config_original_number','sequential_disk_png_receipts','offline_html_manifest_real_zip');
 await page.goto(pathToFileURL(resolve(directory,'report.html')).href);
 await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
 report.reportImages=await page.locator('img').evaluateAll(images=>images.map(i=>({src:i.getAttribute('src'),loaded:i.naturalWidth>0})));
 assert.equal(report.reportImages.length,2);assert.ok(report.reportImages.every(i=>i.loaded),'offline report PNG references must load');
 assert.equal(await page.locator('a[href^="javascript:"]').count(),0);
 await page.screenshot({path:resolve(directory,'report-preview.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);report.checks.push('offline_report_images_loaded','no_pageerrors_or_failed_requests');
 report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;throw error;}
finally{
 await browser?.close();await new Promise(resolveClosed=>server.close(resolveClosed));
 await writeFile(resolve(directory,'completion.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({ok:report.ok,directory,checks:report.checks,error:report.error}));
}
