/** 从侧栏进入实际工作台，在合成离线工作区和三店 PGlite 上验收恢复与彻底删除。 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199',fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成三店 fixture 目录');
const api=await startSourceAcceptance({fixture,root:await mkdtemp(join(tmpdir(),'diy-config-recycle-')),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const day=86400000,at=offset=>new Date(Date.now()-offset*day).toISOString();
const config=(i,shopId='intel')=>{
 const c=blankConfig(null,{id:'link',name:'合成整机',shopId},'合成配置'+i);
 return {...c,id:'row'+i,shopId,version:'批次'+i,name:'合成配置'+i,deletedAt:at(i===1?6.5:4)};
};
const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
async function verify(nas){
 const page=await browser.newPage({viewport:{width:1360,height:900},bypassCSP:true}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 const archived=Array.from({length:nas?102:5},(_,i)=>config(i+1)),active=config('active');delete active.deletedAt;
 const offline=normalizeWorkspaceState({configs:[active,...archived,config('foreign','jonsbo')],sourceCatalog:[],costSource:[],revision:1,templates:[],logs:[],caseGallery:[]},[]);
 if(nas){
  await api.db.query("INSERT INTO intel_live.products(shop_id,product_id) VALUES ('intel','rb-test-link')");
  for(const c of archived)await api.db.query(`INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design,archived_at)
  VALUES ($1,'intel','rb-test-link',$2,'','',20,50000,$3,'{}',$4)`,[c.id,c.name,JSON.stringify({product:c.product,version:c.version}),c.deletedAt]);
 }
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.route('**/workbench/recycle-fixture*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  const payload=req.postData()?req.postDataJSON():null;
  if(nas){
   if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'fixture',deployment_id:fixtureDeployment}});
   if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
   const res=await fetch(api.url+path+url.search,{method:req.method(),headers:{...req.headers(),'x-workbench-deployment':fixtureDeployment},body:req.postData()??undefined});
   return route.fulfill({status:res.status,contentType:'application/json',body:await res.text()});
  }
  let value={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=offline;value={revision:offline.revision,metadata,summaries:configs.map(summaryOf)};}
  if(path==='/api/configs/load')value={revision:offline.revision,configs:offline.configs.filter(c=>payload.ids.includes(c.id))};
  if(path==='/api/state'){
   if(payload){offline.configs=payload.configs;offline.revision++;}
   value=payload?{state:offline,revision:offline.revision,updatedAt:at(0)}:offline;
  }
  return route.fulfill({json:value});
 });
 try{
  await page.goto(base+'/workbench/recycle-fixture'+(nas?'?workspace=nas':''));
  await page.waitForFunction(()=>window.workbenchReady===true);
  await page.locator('#link-recycle-shortcut').click();
  const root=page.locator('.rb-config'),search=root.locator('[data-search]'),confirmation=page.locator('.rb-confirm');
  await root.waitFor();
  const box=await page.locator('#dialog').boundingBox();assert.ok(Math.abs(box.width-920)<2&&Math.abs(box.x+box.width/2-680)<2);
  assert.equal(await root.locator('.rb-row').count(),archived.length);
  assert.match(await root.locator('.rb-row').first().innerText(),nas?/合成配置1\b[\s\S]*即将自动清理/:/合成配置1\b[\s\S]*即将到期/);
  for(const mode of ['dark','light']){
   await page.evaluate(mode=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:mode})),mode);
   const style=await root.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,fit:el.scrollWidth<=el.clientWidth+1}));
   assert.equal(style.fit,true);assert.equal(style.bg,mode==='dark'?'rgb(36, 37, 41)':'rgb(255, 255, 255)');
  }
  await search.fill('批次2');assert.ok((await root.locator('.rb-row').count())>=1);
  await root.locator('[data-id="row2"]').check();await search.fill('批次3');await root.locator('[data-id="row3"]').check();
  await root.locator('[data-action=restore]').click();assert.equal(await confirmation.locator('li').count(),2);
  await confirmation.locator('[value=confirm]').click();
  await page.waitForFunction(()=>document.querySelector('.rb-config footer')?.textContent.includes('已恢复 2'));
  await search.fill('');await root.locator('[data-purge-config="row1"]').click();await confirmation.locator('[value=cancel]').click();
  assert.equal(await root.locator('[data-id="row1"]').count(),1);
  await root.locator('[data-id="row1"]').check();await root.locator('[data-id="row4"]').check();
  await root.locator('[data-action=purge]').click();assert.equal(await confirmation.locator('li').count(),2);
  await confirmation.locator('[value=confirm]').click();await root.locator('[data-id="row1"]').waitFor({state:'detached'});
  await search.fill('批次5');await root.locator('[data-action=clear]').click();
  assert.equal(await confirmation.locator('li').count(),archived.length-4);
  await confirmation.locator('[value=confirm]').click();await root.locator('[data-action=clear]:disabled').waitFor();
  assert.equal(await root.locator('[data-total]').textContent(),'0 套');
  if(nas){
   const {rows}=await api.db.query("SELECT configuration_id,archived_at FROM intel_live.configurations WHERE product_id='rb-test-link' ORDER BY configuration_id");
   assert.deepEqual(rows.map(r=>[r.configuration_id,r.archived_at]),[['row2',null],['row3',null]]);
  }else{
   assert.deepEqual(offline.configs.filter(c=>c.shopId==='intel').map(c=>c.id).sort(),['row2','row3','rowactive']);
   assert.ok(offline.configs.find(c=>c.shopId==='jonsbo').deletedAt);
  }
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
}
try{await verify(false);await verify(true);console.log('通过：离线与 NAS 回收站、跨页、倒计时、搜索、批量恢复、取消/确认删除、清空、双主题及店铺隔离。');}
finally{await browser.close();await api.close();}
