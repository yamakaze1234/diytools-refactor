/** 隔离导出验收：检查原生文件、ZIP 与实际像素，不使用模拟渲染器。 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyMcpExports({task,cli,api,frame,directory,report}){
 const before=await api('GET','/api/state?logs=none');
 const output=resolve(directory,'mcp-export');await mkdir(output,{recursive:true});
 report.exports=[];
 for(const images of ['both','square']){
  const operation=randomUUID(),input=resolve(directory,`export-${images}.json`);
  await writeFile(input,JSON.stringify({configIds:before.configs.map(c=>c.id),revision:before.revision,images,report:true,outputDir:output}));
  const args=['export','--input',input,'--operation-id',operation];
  const completed=await task(args,operation),paths=completed.result;
  assert.equal(paths.export,'completed');assert.equal(paths.localSave,'unchanged');assert.equal(paths.revision,before.revision);
  for(const key of ['zipPath','manifestPath','reportPath'])assert.ok((await stat(paths[key])).size>0);
  const manifest=JSON.parse(await readFile(paths.manifestPath,'utf8'));
  assert.equal(manifest.files.length,before.configs.length*(images==='both'?2:1));
  const pixelChecks=[];
  for(const file of manifest.files){
   const bytes=await readFile(resolve(paths.directory,file.name));
   assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
   if(file.layout!=='square')continue;
   const config=before.configs.find(c=>c.id===file.configId);assert.ok(config);
   const pixels=await frame.evaluate(async({base64,config})=>{
    const {renderPoster}=await import('./poster.js');
    // 独立从详情图构建预期方图，不调用 SKU 分支或 paddedSquare，防止重复被测逻辑。
    const detail=await renderPoster({...structuredClone(config),layout:'long'},1400);
    const expected=document.createElement('canvas');expected.width=expected.height=1400;
    const context=expected.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,1400,1400);
    const scale=Math.min(1400/detail.canvas.width,1400/detail.canvas.height),w=detail.canvas.width*scale,h=detail.canvas.height*scale,x=(1400-w)/2,y=(1400-h)/2;
    context.drawImage(detail.canvas,x,y,w,h);
    const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();
    const actual=document.createElement('canvas');actual.width=img.naturalWidth;actual.height=img.naturalHeight;const ctx=actual.getContext('2d');ctx.drawImage(img,0,0);
    const a=ctx.getImageData(0,0,actual.width,actual.height).data,b=context.getImageData(0,0,1400,1400).data;
    let differences=0;for(let i=0;i<Math.max(a.length,b.length);i++)if(a[i]!==b[i])differences++;
    // 补白区也单独检查为纯白，确保不会把专属排版方图当成正确结果。
    const padPoint=x>=1?[0,700]:[700,0],offset=(padPoint[1]*actual.width+padPoint[0])*4;
    const paddingPixel=Array.from(a.slice(offset,offset+4));
    const result={width:img.naturalWidth,height:img.naturalHeight,differingChannels:differences,contentRect:{x,y,width:w,height:h},paddingPixel,detailSize:{width:detail.canvas.width,height:detail.canvas.height}};
    detail.canvas.width=expected.width=actual.width=0;return result;
   },{base64:bytes.toString('base64'),config});
   assert.equal(pixels.width,1400);assert.equal(pixels.height,1400);assert.equal(pixels.differingChannels,0,`${images}: ${file.name}`);
   assert.ok(pixels.contentRect.x>=1||pixels.contentRect.y>=1);assert.deepEqual(pixels.paddingPixel,[255,255,255,255]);
   pixelChecks.push({configId:config.id,savedSkuMode:config.skuMode??'unset',path:resolve(paths.directory,file.name),...pixels});
  }
  assert.equal(pixelChecks.length,3);
  const zip=await promisify(execFile)('py',['-3','-X','utf8','-c',
   'import sys,zipfile,json,hashlib\nfrom pathlib import Path\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n for n in z.namelist():\n  if not n.endswith("/"):\n   assert z.read(n)==(Path(sys.argv[2])/n).read_bytes(), n\n print(json.dumps(z.namelist(),ensure_ascii=False))',paths.zipPath,paths.directory],{windowsHide:true,encoding:'utf8'});
  const zipFiles=JSON.parse(zip.stdout);assert.equal(zipFiles.filter(n=>n.endsWith('.png')).length,manifest.files.length);
  const retry=await cli(args);assert.equal(retry.status,'succeeded');assert.equal(retry.result.zipPath,paths.zipPath);
  assert.deepEqual((await api('GET','/api/state?logs=none')).configs,before.configs);
  assert.equal((await api('GET','/api/state?logs=none')).revision,before.revision);
  report.exports.push({images,operationId:operation,jobId:completed.jobId??completed.id,paths,manifest,pixelChecks,zipFiles});
 }
 report.checks.push('mcp_both_and_square_real_native_export','all_six_sku_pngs_1400_square','all_sku_pixels_equal_centered_white_padded_detail','all_native_file_sizes_and_sha256_match','zip_crc_and_bytes_match_loose_files','export_retry_reuses_receipt','exports_preserve_saved_configs_and_revision');
 // 通过真实界面保存选择，再经 MCP 导出；SQLite 回读和逐像素比较验证同一设置。
 await frame.locator('.image-settings > summary').click();
 await frame.locator('#layout').selectOption('square');
 await frame.waitForFunction(()=>!window.workbenchHasPendingChanges());
 for(const mode of ['dedicated','padded']){
  await frame.locator('#sku-mode').selectOption(mode);
  // 事件先等待上一笔保存，dirty 可能短暂为 false；以目标字段的持久化回读为准。
  for(let attempt=0;attempt<200;attempt++){
   const state=await api('GET','/api/state?logs=none');
   if(state.configs.find(c=>c.id==='synthetic-selected')?.skuExportMode===mode)break;
   await delay(50);
  }
  await frame.waitForFunction(()=>!window.workbenchHasPendingChanges());
  const saved=await api('GET','/api/state?logs=none'),config=saved.configs.find(c=>c.id==='synthetic-selected');
  assert.equal(config.skuExportMode,mode);
  const input=resolve(directory,`explicit-${mode}.json`),operation=randomUUID();
  await writeFile(input,JSON.stringify({configIds:[config.id],revision:saved.revision,images:'square',report:true,outputDir:output}));
  const completed=await task(['export','--input',input,'--operation-id',operation],operation);
  const manifest=JSON.parse(await readFile(completed.result.manifestPath,'utf8'));
  assert.equal(manifest.files.length,1);
  const bytes=await readFile(resolve(completed.result.directory,manifest.files[0].name));
  const pixels=await frame.evaluate(async({config,base64,mode})=>{
   const {renderPoster}=await import('./poster.js');
   const expected=await renderPoster({...config,layout:'square'},1400);
   const opposite=await renderPoster({...config,layout:'square',skuExportMode:mode==='padded'?'dedicated':'padded'},1400);
   const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1400;canvas.getContext('2d').drawImage(img,0,0);
   const read=c=>c.getContext('2d').getImageData(0,0,1400,1400).data,a=read(canvas),b=read(expected.canvas),c=read(opposite.canvas);
   let difference=0,oppositeDifference=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])difference++;if(a[i]!==c[i])oppositeDifference++;}
   const result={difference,oppositeDifference,width:img.naturalWidth,height:img.naturalHeight};
   canvas.width=expected.canvas.width=opposite.canvas.width=0;return result;
  },{config,base64:bytes.toString('base64'),mode});
  assert.equal(pixels.width,1400);assert.equal(pixels.height,1400);assert.equal(pixels.difference,0);assert.ok(pixels.oppositeDifference>0);
  assert.deepEqual((await api('GET','/api/state?logs=none')).configs,saved.configs);
  report.exports.push({explicitMode:mode,pixels,paths:completed.result});
 }
 report.checks.push('explicit_ui_style_saved_to_sqlite','mcp_respects_explicit_dedicated_and_reset_padded_pixels');
}
