/** 真实离线工作台的加购保存、差异和导图验收。接口仅访问本次测试的内存工作区。 */
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const output=process.env.SOURCE_ADDON_SYNC_CAPTURE;
if(output)await mkdir(output,{recursive:true});
const oldText='【+199元升级14600KF】',newText='【+249元升级14600KF】',manual='【直播间专享：免费升级盒装】';
const name='Intel 酷睿 i5-13600KF 散',goodsId='9900301';
const clone=value=>structuredClone(value);
function fixture(scenario){
 const rows=['intel','gigabyte'].map(shopId=>({sourceId:'cpu-'+shopId,shopId,goodsId,name,originalName:name,erp:1202.13,tax:1150,
  updatedAt:new Date().toISOString(),addonText:oldText,addonChoices:[{id:'cpu-upgrade',label:oldText,goodsId:'',qty:1,originalQty:1,enabled:true,priceCents:null}]}));
 const configs=[['intel','f1','跟随方案'],['intel','m1','人工专场'],['gigabyte','other','外店跟随']].map(([shopId,id,label])=>{
  const source=rows.find(row=>row.shopId===shopId),isManual=id==='m1',product={id:'p-'+shopId,name:shopId==='intel'?'MF400银':'X400白',shopId,spu:'',configs:[]};
  const config=blankConfig(null,product,label);Object.assign(config,{id,name:label,shopId,price:4999});
  const part=config.parts[0],upgrade=isManual?manual:oldText;
  Object.assign(part,{sourceId:source.sourceId,name,goodsId,erp:1202.13,tax:1150,upgrade,
   sourceFollow:{sourceId:source.sourceId,name:{mode:'follow',value:name,sourceValue:name},upgrade:{mode:isManual?'manual':'follow',value:upgrade,sourceValue:oldText}}});
  config.actualParts[0]={...part};return config;
 });
 const state=normalizeWorkspaceState({configs,revision:1,updatedAt:new Date().toISOString(),sourceCatalog:rows,costSource:[{goodsId,name,erp:1202.13,tax:1150,stockAvailable:18}],caseGallery:[],logs:[],templates:[]},[]);
 state.shopSettings.intel.addonPacks=[{id:'fan-pack',productId:'p-intel',name:'加购独立风扇',mode:'text',
  priceCents:null,copyMode:'preset',preset:'name',customCopy:'',presetEdits:{},rules:[]}];
 // 用另外两种配件检验表格在真实行高下与左侧菜单相邻时的布局。
 for(const [goodsId,name,category,erp,tax,addonText] of [
  ['9900302','技嘉 RTX 5060 Ti 冰猎鹰 16G','显卡',3580,3600,'【+799元升级 RTX 5070 雪鹰白】'],
  ['9900303','致态 TiPlus7100 1T NVMe','硬盘',488,495,'【+399元升级 2T 固态】'],
 ]){
  state.sourceCatalog.push({sourceId:'spare-'+goodsId,shopId:'intel',goodsId,name,originalName:name,erpCategory:category,erp,tax,addonText});
  state.costSource.push({goodsId,name,erpCategory:category,erp,tax,stockAvailable:22});
 }
 if(scenario==='receipts'){
  const source=state.sourceCatalog.find(row=>row.goodsId==='9900302');
  const config=blankConfig(null,{id:'p2',name:'显卡链接',shopId:'intel'},'显卡跟随');
  Object.assign(config,{id:'f2',shopId:'intel',price:4999});
  const part=config.parts.find(part=>part.slot==='显卡');
  Object.assign(part,{sourceId:source.sourceId,goodsId:source.goodsId,name:source.name,tax:source.tax,erp:source.erp,upgrade:source.addonText,
   sourceFollow:{sourceId:source.sourceId,name:{mode:'follow',value:source.name,sourceValue:source.name},upgrade:{mode:'follow',value:source.addonText,sourceValue:source.addonText}}});
  config.actualParts=config.parts.map(part=>({...part}));state.configs.push(config);
 }
 if(scenario==='name'){
  const part=state.configs.find(config=>config.id==='m1').parts[0];
  part.displayName='人工定制处理器名';
  part.sourceFollow.name={mode:'manual',value:part.displayName,sourceValue:name};
 }
 if(scenario==='tax'){
  // 仅保留本店配置的核算价差异。输入的名称与加购都已跟随。
  state.configs=state.configs.filter(config=>config.id==='f1');
  state.configs[0].parts[0].tax=999;
 }
 if(scenario==='layout'){
  // 不同的人工文案在列表中各自成组，使滚动来自实际差异数据。
  for(let i=1;i<=8;i++){
   const config=clone(state.configs.find(row=>row.id==='m1')),part=config.parts[0];
   config.id='layout-'+i;config.name='版式样例 '+i;
   part.upgrade+=' '+i;part.sourceFollow.upgrade.value=part.upgrade;
   config.actualParts[0]=clone(part);state.configs.push(config);
  }
 }
 return state;
}
const html=await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8');
const bootstrap=`import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;
 await import('/workbench/app.js');document.body.classList.remove('login-required');`;
const browser=await chromium.launch({channel:'msedge',headless:true});
async function verify(scenario){
 const page=await browser.newPage({viewport:{width:1360,height:900},bypassCSP:true,reducedMotion:'reduce'});
 const state=fixture(scenario),errors=[],foreign=[],writes=[],exports=[];
 page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));
 // 原生选目录/写文件由内存回执替代，图片仍由实际导图任务渲染；仅记录文件名。
 await page.exposeFunction('captureImageSession',({phase,files})=>{
  if(phase==='begin'){exports.push({files:[],finished:false});return {directory:'fixture',token:'fixture'};}
  const batch=exports.at(-1);if(phase==='append')batch.files.push(...files.map(file=>file.name));
  if(phase==='finish')batch.finished=true;
  return {ok:true,files:batch.files,directory:'fixture'};
 });
 await page.addInitScript(()=>{window.pywebview={api:{export_image_folder_session:async request=>{
  // 在原生导出会话开始时核对两种图片实际交给渲染器的加购文案。
  if(request.phase==='begin'){
   const {imageExportTasks}=await import('/workbench/image-export-tasks.js');
   const {posterAddonEntries}=await import('/workbench/poster.js');
   window.exportedPacks=imageExportTasks().at(-1).items.map(({config})=>
    posterAddonEntries(config,'addons').map(({entry})=>entry.text));
  }
  return window.captureImageSession(request);
 }}};});
 await page.route('**/*',route=>{
  if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();
  foreign.push(route.request().url());return route.abort();
 });
 await page.route('**/workbench/source-addon-fixture',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/bootstrap.js',route=>route.fulfill({contentType:'text/javascript',body:bootstrap}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',route=>{
  const req=route.request(),path=new URL(req.url()).pathname,payload=req.method()==='POST'?req.postDataJSON():null;
  let result={};
  if(path==='/api/workspace/index'){
   const {configs,...metadata}=state;result={metadata,revision:state.revision,updatedAt:state.updatedAt,summaries:configs.map(summaryOf)};
  }else if(path==='/api/configs/load')result={revision:state.revision,configs:state.configs.filter(row=>payload.ids.includes(row.id))};
  else if(path==='/api/state'){
   if(payload){for(const key of ['caseGallery','configs','templates','sourceCatalog','costSource','shopSettings'])state[key]=clone(payload[key]);state.revision++;writes.push(path);}
   result=payload?{...state,state:clone(state)}:state;
  }else if(['/api/configs/batch','/api/configs/patch'].includes(path)){
   const saved=payload.changes.map(change=>clone(change.after));state.configs=state.configs.map(row=>saved.find(item=>item.id===row.id)||row);
   writes.push(path);result={configs:saved,revision:++state.revision,updatedAt:state.updatedAt,activityDelta:[]};
  }else if(path==='/api/session')result={defaultOperator:'隔离验收'};
  else if(path==='/api/derived/status')result={running:false,images:[]};
  else if(path==='/api/native-cloud/status')result={configured:false,session:{configured:false,authenticated:false},checkpoint:{initialized:false}};
  return route.fulfill({json:result});
 });
 const read=id=>state.configs.find(row=>row.id===id).parts[0];
 const saveShot=async file=>{if(output)await page.screenshot({path:join(output,file+'.png')});};
 const rail=page.locator('.reui-rail').getByRole('button',{name:/^维护/}),sheet=page.locator('#source-sheet-page');
 const menu=page.getByRole('button',{name:/^输出源维护/});
 const badge=async count=>{
  await page.waitForFunction(count=>{
   const sheet=document.querySelector('[data-diff-badge]'),rail=document.querySelector('.rail-alert-pill');
   return sheet?.textContent.trim()===String(count)&&(count?rail?.textContent.trim()===String(count):!rail||rail.hidden);
  },count);
 };
 const files=async(expectedBatch=1)=>{
  for(let i=0;i<200&&!exports[expectedBatch-1]?.finished;i++)await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(exports.length,expectedBatch,'每次点击只启动一个导图任务');
  assert.equal(exports.at(-1)?.finished,true,'目录得到导出结束回执');
  const images=exports.at(-1).files.filter(file=>file.endsWith('.png'));
  assert.deepEqual(images,['MF400银_配置图/1_配置1.png','MF400银_sku图/1_配置1.png'],'导出仅包含本店第一套（跟随）配置');
  assert.deepEqual(await page.evaluate(()=>window.exportedPacks),[['加购独立风扇'],['加购独立风扇']]);
 };
 const prompt=page.locator('#modal-save-prompt'),review=page.locator('#dialog');
 const editAddon=async(id,text)=>{
  await sheet.locator('[data-sheet-row="'+id+'"] [data-sheet-action=addons]').first().click();
  await sheet.locator('.ss-drawer-pane:visible [data-choice-label]').first().fill(text);
  await sheet.locator('[data-sheet-action=apply-drawer]').click();
  await sheet.locator('[data-sheet-action=save]').click();await prompt.waitFor();
 };
 const receiptCount=async count=>{
  await page.waitForFunction(count=>{
   const el=document.querySelector('[data-sheet-action=automatic] [data-auto-badge]');
   return count?el?.checkVisibility()&&Number(el.textContent)===count:!el?.checkVisibility();
  },count);
 };
 const chooseUpdateAlone=async()=>{
  await prompt.locator('#prompt-export-toggle').uncheck();
  await prompt.locator('#btn-update-now').click();await prompt.waitFor({state:'hidden'});
 };
 const theme=mode=>page.evaluate(mode=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:mode})),mode);
 const colors=el=>el.evaluate(element=>{
  const style=getComputedStyle(element);return [style.backgroundColor,style.borderTopColor,style.color];
 });
 // 设计稿以弹窗内容确定高度，避免工作台的通用 dialog 样式将保存窗拉伸到全屏。
 const centered=async(locator,width)=>{
  const box=await locator.boundingBox(),viewport=page.viewportSize();
  assert.equal(box.width,width);
  assert.ok(Math.abs(box.x+box.width/2-viewport.width/2)<=1&&Math.abs(box.y+box.height/2-viewport.height/2)<=1,'弹窗应在视口居中');
  return box;
 };
 // 用实际控件的位置验收两行布局，操作完成后也把重新导出和还原按钮算进去。
 const checkFooter=async()=>{
  const footer=review.locator('.sd-footer'),bounds=await footer.boundingBox();
  const modal=await review.boundingBox();
  assert.ok(Math.abs(bounds.y+bounds.height-modal.y-modal.height)<=2,'底栏应贴齐弹窗底边');
  const row=selector=>footer.locator(selector).evaluateAll(els=>els.filter(el=>el.checkVisibility()).map(el=>el.getBoundingClientRect().toJSON()));
  const top=await row('[data-review-export],[data-layout],[data-export-scope],[data-sku-mode],[data-source-sync-message],#source-export-retry,#source-undo');
  const bottom=await row('[data-review-selected],#source-keep-all,#diff-export-only-btn,#source-apply');
  assert.equal(bottom.length,4);
  for(const controls of [top,bottom]){
   for(const [i,rect] of controls.entries()){
    assert.ok(rect.left>=bounds.x&&rect.right<=bounds.x+bounds.width,'底栏控件须位于弹窗内');
    if(i)assert.ok(controls[i-1].right<=rect.left+1,'同一行控件应左右排列');
   }
   const centers=controls.map(r=>r.y+r.height/2);
   assert.ok(Math.max(...centers)-Math.min(...centers)<=2,'同一行控件应垂直居中且不折行');
  }
  assert.ok(Math.max(...top.map(r=>r.bottom))<Math.min(...bottom.map(r=>r.top)),'导出设置和主操作应分两行');
  assert.ok(await footer.evaluate(el=>el.scrollWidth<=el.clientWidth),'底栏不应横向溢出');
 };
 try{
  await page.goto(base+'/workbench/source-addon-fixture');await page.waitForFunction(()=>window.workbenchReady);
  await rail.click();await menu.waitFor();
  if(scenario==='tax'){
   assert.equal(await menu.locator('[data-source-menu-badge]').isVisible(),false);
   assert.equal(await menu.locator('[data-source-menu-time]').isVisible(),false);
  }
  await menu.click();await sheet.waitFor();
  if(scenario==='layout'){
   await sheet.locator('[data-sheet-action=differences]').click();
   const list=review.locator('[data-source-groups]');
   await list.locator('.sd-group').nth(8).waitFor({state:'attached'});
   const longBox=await centered(review,1100);
   assert.ok(longBox.height>=440&&longBox.height<=670,'长列表应受弹窗高度上限约束');
   assert.ok(await list.evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollTop>0;}),'超出上限时应能滚动列表');
   await checkFooter();
   await page.setViewportSize({width:1100,height:760});
   await review.locator('[data-review-search]').fill('版式样例 1');
   const box=await centered(review,1068);
   assert.ok(box.height>=440&&box.height<longBox.height,'只剩一条差异时应收起多余高度');
   const widths=await review.locator('.sd-filters select').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width));
   assert.ok(widths.length===2&&widths.every(w=>w>=112&&w<=168),'链接和配件筛选框应保持紧凑列宽');
   await checkFooter();
   assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);return;
  }
  if(scenario==='tax'){
   await badge(0);
   await theme('dark');
   assert.deepEqual(await colors(sheet.locator('[data-diff-badge]')),['rgb(46, 48, 53)','rgb(86, 90, 99)','rgb(182, 188, 198)']);
   await theme('light');
   await sheet.locator('[data-sheet-action=differences]').click();
   await review.locator('[data-diff-tab=all]').waitFor();
   const taxField=review.locator('[data-source-field=tax]');
   assert.equal(await taxField.isChecked(),false);
   assert.equal(await review.locator('[data-source-select]').count(),0);
   const fields=review.locator('.sd-fields');
   await fields.locator('summary').click();await taxField.check();await fields.locator('summary').click();
   const group=review.locator('[data-source-description-group]').filter({hasText:'含税核算单价'});
   await group.waitFor();assert.match(await group.innerText(),/999/);assert.match(await group.innerText(),/1150/);
   await group.locator('[data-source-select-group]').check();assert.ok(await review.locator('#source-keep-all').isDisabled());
   await review.locator('[data-review-export]').uncheck();await review.locator('#source-apply').click();
   await group.waitFor({state:'detached'});await badge(0);assert.equal(read('f1').tax,1150);
   await review.locator('#source-export-retry').waitFor();await review.locator('#source-undo').waitFor();
   await checkFooter();
   assert.equal(exports.length,0);assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);return;
  }
  if(scenario==='name'){
   const field=sheet.locator('[data-sheet-row="'+goodsId+'"] [data-sheet-field=name]');
   const stageName=async value=>{await field.fill(value);await field.press('Enter');};
   const renamed='英文版处理器展示名';
   await stageName(renamed);
   await sheet.locator('[data-sheet-action=save]').click();
   await prompt.getByText('是否立即更新本店配置的展示名称？',{exact:true}).waitFor();
   assert.equal(await prompt.locator('#prompt-follow-cnt').innerText(),'1 套');
   assert.equal(await prompt.locator('#prompt-manual-cnt').innerText(),'1 套');
   assert.equal(read('f1').name,name);
   await chooseUpdateAlone();
   assert.equal(read('f1').name,renamed);
   assert.equal(read('f1').upgrade,oldText);
   assert.equal(read('m1').displayName,'人工定制处理器名');
   await receiptCount(1);

   const both='同批修改的处理器名称';
   await stageName(both);await editAddon(goodsId,newText);
   await prompt.getByText('是否立即更新本店配置的展示名称与加购？',{exact:true}).waitFor();
   assert.match(await prompt.locator('#btn-update-now').innerText(),/展示名称与加购并导图/);
   await chooseUpdateAlone();
   assert.deepEqual([read('f1').name,read('f1').upgrade],[both,newText]);
   assert.deepEqual([read('m1').displayName,read('m1').upgrade],['人工定制处理器名',manual]);
   assert.deepEqual([read('other').name,read('other').upgrade],[name,oldText]);
   assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);return;
  }
  await badge(1);
  await editAddon(goodsId,newText);
  const promptBox=await centered(prompt,620),footer=await prompt.locator('footer').boundingBox();
  assert.ok(Math.abs(promptBox.y+promptBox.height-footer.y-footer.height)<=2,'底栏下方不应有空白区域');
  assert.match(await prompt.innerText(),/跟随输出源（可立即更新）\s*1 套/);
  assert.match(await prompt.innerText(),/人工特殊文案（自动保护）\s*1 套/);
  assert.doesNotMatch(await prompt.innerText(),/外店跟随|技嘉|其他店铺/);
  assert.ok(await prompt.locator('#prompt-export-toggle').isChecked());
  if(scenario==='receipts'){
   await chooseUpdateAlone();await receiptCount(1);
   await editAddon('9900302','【+899元升级显卡】');await chooseUpdateAlone();await receiptCount(2);
   // 同一套再次更新也只计一套；先前另一套的补导记录仍可选择。
   await editAddon('9900302','【+949元升级显卡】');await chooseUpdateAlone();await receiptCount(2);
   assert.equal(exports.length,0);
   await sheet.locator('[data-sheet-action=automatic]').click();
   const history=review.locator('[data-source-automatic]');
   await history.locator('[data-auto-export]').waitFor();
   const ids=await history.locator('[data-auto-config]').evaluateAll(els=>[...new Set(els.map(el=>el.dataset.autoConfig))].sort());
   assert.deepEqual(ids,['f1','f2']);assert.match(await history.innerText(),/949/);
   await history.locator('[data-auto-select-all]').uncheck();
   const cpu=history.locator('[data-auto-config=f1]').first();await cpu.locator('xpath=ancestor::details/summary').click();
   await cpu.check();
   const before=writes.length,snapshot=clone(state.configs);
   await history.locator('[data-auto-export]').click();await files();
   assert.equal(writes.length,before);assert.deepEqual(state.configs,snapshot);
   assert.equal(read('m1').upgrade,manual);assert.equal(read('other').upgrade,oldText);
   await page.keyboard.press('Escape');await review.waitFor({state:'hidden'});
   await sheet.locator('[data-sheet-action=back]').click();await sheet.waitFor({state:'hidden'});
   await rail.click();await menu.click();await sheet.waitFor();await receiptCount(0);
  }else if(scenario==='immediate'){
   await saveShot('save');await prompt.locator('#btn-update-now').click();await prompt.waitFor({state:'hidden'});await files();
   assert.equal(read('f1').upgrade,newText);assert.equal(read('m1').upgrade,manual);assert.equal(read('other').upgrade,oldText);
   await badge(1);
   // 换到另一个店铺的工作表，不能从“本次变动”看到之前店铺的配置。
   await editAddon(goodsId,'【+299元升级14600KF】');await chooseUpdateAlone();await receiptCount(1);
   await sheet.locator('#source-sheet-shop').selectOption('gigabyte');
   await page.locator('[data-product-toggle="p-gigabyte"]').waitFor();
   await rail.click();await menu.click();await sheet.waitFor();await receiptCount(0);
  }else{
   await prompt.locator('#btn-defer-update').click();await badge(2);
   assert.equal(read('f1').upgrade,oldText);assert.equal(read('m1').upgrade,manual);
   await rail.click();await menu.waitFor();assert.match(await menu.innerText(),/待确认\s*2/);
   assert.match(await menu.innerText(),/最近变动\s*\d\d-\d\d \d\d:\d\d/);
   await theme('dark');
   assert.deepEqual(await colors(menu.locator('[data-source-menu-badge]')),['rgb(59, 32, 35)','rgb(140, 61, 66)','rgb(255, 148, 150)']);
   await theme('light');await saveShot('maintenance');await rail.click();
   await sheet.locator('[data-sheet-action="differences"]').click();
   await review.locator('[data-diff-tab=all]').waitFor();
   const {height}=await centered(review,1100);
   assert.ok(height>=440&&height<=670,'差异弹窗应在 440–670px 之间按内容取高');
   await checkFooter();
   assert.equal(await review.locator('[data-source-select]:checked').count(),0);
   await review.locator('#diff-select-follow').click();
   assert.match(await review.innerText(),/跟随\s*1\s*·\s*人工\s*0/);
   const snapshot=clone(state.configs),before=writes.length;
   await review.locator('#diff-export-only-btn').click();await files();
   assert.equal(writes.length,before);assert.deepEqual(state.configs,snapshot);
   await review.locator('#source-keep-all').click();await badge(1);
   assert.equal(read('f1').upgrade,oldText);assert.equal(read('f1').sourceFollow.upgrade.mode,'follow');
   await review.locator('[data-diff-tab=ignored]').click();
   assert.equal(await review.locator('[data-review-selected]').innerText(),'已处理 / 已忽略 1 项（满 7 天自动清理）');
   const restore=review.locator('[data-restore-item]').first();
   if(!await restore.isVisible())await review.locator('[data-toggle-group]').first().click();
   assert.match(await review.innerText(),/还剩 7 天清理/);await saveShot('ignored');
   await restore.click();await badge(2);assert.equal(read('f1').sourceFollow.upgrade.ignoredSourceValue,undefined);
   await review.locator('[data-diff-tab=all]').click();
   assert.equal(await review.locator('[data-review-selected]').innerText(),'已选 0 项');
   await review.locator('#diff-select-follow').click();
   await review.locator('[data-review-export]').uncheck();await review.locator('#source-apply').click();await badge(1);
   assert.equal(read('f1').upgrade,newText);assert.equal(read('m1').upgrade,manual);
   await review.locator('[data-ignore-group]').first().click();await badge(0);
   assert.equal(read('m1').upgrade,manual);assert.equal(read('m1').sourceFollow.upgrade.mode,'manual');
   await review.locator('[data-diff-tab=ignored]').click();await review.locator('[data-restore-group]').click();await badge(1);
   // 共用草稿已保存；另一店的跟随文案在切换店铺后仍待人工决定是否同步。
   await page.keyboard.press('Escape');await review.waitFor({state:'hidden'});
   await sheet.locator('#source-sheet-shop').selectOption('gigabyte');
   await page.locator('[data-product-toggle="p-gigabyte"]').waitFor();
   await rail.click();await menu.waitFor();assert.match(await menu.innerText(),/待确认\s*1/);
   await menu.click();await badge(1);
   await sheet.locator('[data-sheet-action="differences"]').click();await review.locator('[data-diff-tab=follow]').click();
   assert.match(await review.locator('[data-source-groups]').textContent(),/外店跟随/);
   assert.equal(read('other').upgrade,oldText);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);
 }catch(error){console.error((await page.locator('body').innerText()).slice(-2500));throw error;}
 finally{await page.close();}
}
try{
 for(const scenario of ['immediate','deferred','receipts','tax','layout','name'])await verify(scenario);
 console.log('通过：当前店名称与加购保存决策、人工文案保护、真实双图导出、暂缓/仅导图、忽略/恢复、三级角标、补导记录合并、核算价显式确认、深色徽章、差异窗口自适应高度与两行底栏。');
}finally{await browser.close();}
