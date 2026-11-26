/** 在独立的合成三店 PGlite 上，通过正式工作台与 HTTP 路由验证加购决策。 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const fixture=process.argv[2]&&resolve(process.argv[2]);
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请提供纯合成三店 fixture 目录');
const origin=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const goodsId='9900012',sourceId='fixture-addon-choices',shops=['intel','gigabyte','jonsbo'];
const oldText='可咨询客服升级【+99元升级测试配件】',newLabel='可选三店新版加购',latest=newLabel+'【+99元升级测试配件】',manual='本店专属赠品';
const api=await startSourceAcceptance({fixture,root:join(fixture,'addon-nas-uploads'),authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
let browser;
try{
 for(const file of ['020-workbench-global-tax.sql','021-workbench-alias-addons.sql','027-quotation-identity-invalidation.sql','028-cross-shop-cost-sync.sql','029-manual-tax-protection.sql','030-incoming-stock.sql','031-erp-category.sql']){
  await api.db.exec(await readFile(new URL('../../../services/nas-api/sql/'+file,import.meta.url),'utf8'));
 }
 for(const shop of shops){
  const table=shop+'_live',source=(await api.db.query(`SELECT name FROM ${table}.sources WHERE source_id=$1`,[sourceId])).rows[0];
  // 共用同一套旧方案，每家店保存独立的跟随记录。英特尔再加一套人工特例。
  if(shop==='intel')await api.db.query(`INSERT INTO ${table}.configurations
   (configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
   SELECT 'manual-addon',shop_id,product_id,'人工专属', '',spu,2,workbench_price_cents,fields,design
   FROM ${table}.configurations WHERE configuration_id='fixture-overlap'`);
  for(const [id,mode] of [['fixture-overlap','follow'],...(shop==='intel'?[['manual-addon','manual']]:[])]){
   const upgrade=mode==='manual'?manual:oldText;
   const attrs={upgrade,tax:160,sourceFollow:{sourceId,name:{mode:'follow',value:source.name,sourceValue:source.name},
    upgrade:{mode,value:upgrade,sourceValue:oldText}}};
   for(const kind of ['display','actual'])await api.db.query(`INSERT INTO ${table}.parts
    (configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
    VALUES ($1,$2,1,'fixture-line','硬盘',$3,$4,1,$5,$6)
    ON CONFLICT(configuration_id,part_kind,position) DO UPDATE SET slot=EXCLUDED.slot,name=EXCLUDED.name,
     goodsid=EXCLUDED.goodsid,source_id=EXCLUDED.source_id,attrs=EXCLUDED.attrs`,[id,kind,goodsId,source.name,sourceId,JSON.stringify(attrs)]);
  }
 }
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1360,height:900}});
 page.setDefaultTimeout(14000);
 const errors=[],requests=[],headers={'x-workbench-deployment':fixtureDeployment,'content-type':'application/json'};
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.exposeFunction('nasAddonFixture',async(command,args)=>{
  const reply=data=>({status:200,body:JSON.stringify(data)});
  if(command==='nas_identity_request')return reply({session:{configured:true,authenticated:true,member:{uid:fixtureActor,workspaceId:fixtureWorkspace}}});
  if(command==='nas_native_request'&&args.route==='/settings')return reply({configured:true,main_editor:true,endpoint_id:'fixture-addon-nas',deployment_id:fixtureDeployment,acceptance:true});
  if(command==='nas_native_request'){
   const res=await fetch(api.url+args.route,{method:args.method,body:args.body??undefined,headers});
   const body=await res.text();requests.push({method:args.method,route:args.route,status:res.status});
   if(!res.ok)console.error(args.route,res.status,body);
   return {status:res.status,body};
  }
  if(command==='nas_erp_read')return reply({ok:true,saved:true,rows:[]});
  return 1;
 });
 await page.addInitScript(()=>{
  window.isTauri=true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},
   convertFileSrc:()=>location.origin,invoke:(command,args)=>window.nasAddonFixture(command,args)};
 });
 await page.goto(origin);
 const frame=page.frameLocator('.legacy-workbench-frame'),sheet=frame.locator('#source-sheet-page');
 const ready=()=>frame.locator('#shop-picker').evaluate(async()=>{while(!window.workbenchReady)await new Promise(resolve=>setTimeout(resolve,30));});
 async function openSheet(){
  await frame.locator('.reui-rail').getByRole('button',{name:/维护/}).click();
  await frame.getByRole('button',{name:/输出源维护/}).click();
  await sheet.waitFor();
 }
 try{
  await ready();await openSheet();
  const row=sheet.locator('[data-sheet-row="'+goodsId+'"]');
  await row.locator('[data-sheet-action="addons"]').first().click();
  await sheet.locator('.ss-drawer-pane:visible [data-choice-label]').first().fill(newLabel);
  await sheet.locator('[data-sheet-action="apply-drawer"]').click();
  await sheet.locator('[data-sheet-action="save"]').click();
  const prompt=frame.locator('#modal-save-prompt');
  assert.equal(await prompt.locator('#prompt-follow-cnt').innerText(),'1 套');
  assert.equal(await prompt.locator('#prompt-manual-cnt').innerText(),'1 套');
  await prompt.locator('#prompt-export-toggle').uncheck();
  await prompt.locator('#btn-update-now').click();
  await prompt.waitFor({state:'hidden'});
  // NAS 回读配置后仍保留本店的补导回执。
  assert.equal(await sheet.locator('[data-auto-badge]').innerText(),'1');
  assert.ok(requests.some(r=>r.method==='PUT'&&r.route.includes('/catalog/shared-sources/'+goodsId)&&r.status===200));
  const applications=requests.filter(r=>r.method==='POST'&&r.route.includes('/workspace/configurations'));
  assert.ok(applications.length&&applications.every(r=>r.route.includes('shop_id=intel')&&r.status===200));
  // 直接核验隔离库原文，避免将页面临时投影当作已落库更新。
  for(const shop of shops){
   const dbRows=(await api.db.query(`SELECT configuration_id AS id,attrs->>'upgrade' AS text,attrs#>>'{sourceFollow,upgrade,mode}' AS mode
    FROM ${shop}_live.parts WHERE part_kind='display' AND source_id=$1 ORDER BY configuration_id`,[sourceId])).rows;
   assert.deepEqual(dbRows,[{id:'fixture-overlap',text:shop==='intel'?latest:oldText,mode:'follow'},...(shop==='intel'?[{id:'manual-addon',text:manual,mode:'manual'}]:[])]);
  }
  for(const shop of shops.slice(1)){
   await sheet.locator('#source-sheet-shop').selectOption(shop);
   await frame.locator('body[data-source-diff-shop="'+shop+'"][data-source-diff-count="1"]').waitFor();
   if(!await sheet.isVisible())await openSheet();
   assert.equal(await sheet.locator('[data-auto-badge]').isHidden(),true,'切换店铺时清空本次变动');
   await sheet.locator('[data-diff-badge]').getByText('1',{exact:true}).waitFor();
   await sheet.locator('[data-sheet-action="differences"]').click();
   const review=frame.locator('#dialog');
   await review.locator('[data-diff-tab="follow"]').click();
   assert.match(await review.locator('[data-source-groups]').textContent(),new RegExp(newLabel));
   await page.keyboard.press('Escape');await review.waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]);
  console.log('通过：真实 NAS 加购保存、英特尔跟随/人工分流和写入、另两店提醒及完整原文保护。');
 }catch(error){console.error((await frame.locator('body').innerText()).slice(-1700));throw error;}
}finally{await browser?.close();await api.close();}
