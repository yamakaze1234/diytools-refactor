/** 在 1360×900 的正式工作表入口操作本机隔离数据与合成三店 PGlite。 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {normalizeWorkspaceState} from '../public/workbench/shops.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199',fixture=process.argv[2];
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请提供纯合成的三店 fixture');
const api=await startSourceAcceptance({fixture,root:await mkdtemp(join(tmpdir(),'diy-source-deleted-')),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace('<script type="module" src="./bootstrap.js"></script>',`<script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>`);
const browser=await chromium.launch({channel:'msedge',headless:true});
const sources=['恢复','单删','保留','全清','并发'].map((word,i)=>({sourceId:'retire'+i,shopId:'intel',goodsId:String(81000+i),erpCategory:'硬盘',
 name:'退役样例'+word,originalName:'合成硬盘 '+i,deletedAt:new Date(Date.now()-([0,2].includes(i)?28:22)*86400000).toISOString()}));
const archive=blankConfig(null,{id:'link',name:'合成整机',shopId:'intel'},'已归档配置');
archive.id='retired-config';archive.shopId='intel';archive.deletedAt=new Date().toISOString();archive.parts[0].sourceId='retire2';
for(const source of sources)await api.db.query("INSERT INTO intel_live.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES($1,'intel',false,$2,$3,$4)",[source.sourceId,source.goodsId,source.name,JSON.stringify(source)]);
const addTemplate=id=>api.db.query('INSERT INTO intel_live.templates(template_id,shop_id,name,configurations,attrs) VALUES($1,\'intel\',\'样例\', $2,\'{}\')',['tmpl-'+id,JSON.stringify([{parts:[{sourceId:id}]}])]);
await addTemplate('retire2');
async function verify(nas){
 const page=await browser.newPage({viewport:{width:1360,height:900},bypassCSP:true}),errors=[],writes=[];
 let unknownCounts=false;
 const offline=normalizeWorkspaceState({sourceCatalog:structuredClone(sources),configs:[archive],templates:[],costSource:[],logs:[],caseGallery:[],revision:1},[]);
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.route('**/workbench/deleted-fixture*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(nas){
   if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'fixture',deployment_id:fixtureDeployment}});
   if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
   const res=await fetch(api.url+path+url.search,{method:req.method(),body:req.postData()??undefined,headers:{...req.headers(),'x-workbench-deployment':fixtureDeployment}});
   if(req.method()==='POST')writes.push([path,res.status]);
   if(unknownCounts&&path.endsWith('/catalog/sources')&&res.ok){
    // 模拟旧 NAS 可读目录、尚未返回引用计数；升级后无需重开工作表。
    const body=await res.json();for(const row of body.data)delete row.references;
    return route.fulfill({json:body});
   }
   return route.fulfill({status:res.status,contentType:'application/json',body:await res.text()});
  }
  let result={};
  if(path==='/api/workspace/index'){const {configs,...metadata}=offline;result={metadata,revision:offline.revision,summaries:configs.map(summaryOf)};}
  if(path==='/api/configs/load')result={revision:offline.revision,configs:offline.configs.filter(row=>req.postDataJSON().ids.includes(row.id))};
  if(path==='/api/state'){
   if(req.method()==='POST'){
    const payload=req.postDataJSON();
    if(payload.baseRevision!==offline.revision)return route.fulfill({status:409,json:{message:'已有其他页面更新来源'}});
    for(const key of ['sourceCatalog','shopSettings'])if(key in payload)offline[key]=payload[key];
    offline.revision++;writes.push(['offline',200]);
    result={state:offline,revision:offline.revision,updatedAt:new Date().toISOString()};
   }else result=offline;
  }
  return route.fulfill({json:result});
 });
 try{
  await page.goto(base+'/workbench/deleted-fixture'+(nas?'?workspace=nas':''));
  await page.waitForFunction(()=>window.workbenchReady);
  await page.locator('.reui-rail').getByRole('button',{name:/^维护/}).click();
  await page.getByRole('button',{name:/^输出源维护/}).click();
  const sheet=page.locator('#source-sheet-page'),view=sheet.locator('[data-deleted-view]'),confirm=page.locator('.rb-confirm');
  const row=id=>view.locator(`[data-deleted-row="${id}"]`);
  unknownCounts=nas;
  await sheet.locator('[data-filter=deleted]').click();
  await row('retire0').waitFor();
  if(nas){
   assert.match(await row('retire0').innerText(),/引用待核对/);
   assert.ok(await row('retire0').locator('[data-one=purge]').isDisabled());
   unknownCounts=false;await view.locator('[data-deleted-refresh]').click();
   await row('retire0').getByText('0 引用 · 可清理').waitFor();
  }
  assert.match(await row('retire0').innerText(),nas?/剩余 2 天 · 即将自动清理/:/剩余 2 天 · 即将到期/);
  assert.match(await view.locator('[data-deleted-counts]').innerText(),/可彻底删除 4 条 · 被引用保护 1 条/);
  for(const theme of ['dark','light']){
   await page.evaluate(theme=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:theme})),theme);
   const result=await row('retire0').locator('td').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth}));
   assert.deepEqual(result,{background:theme==='dark'?'rgb(36, 37, 41)':'rgb(255, 255, 255)',overflow:false});
  }
  await view.locator('[data-sub=protected]').click();assert.equal(await view.locator('[data-deleted-row]').count(),1);
  assert.ok(await row('retire2').locator('[data-one=purge]').isDisabled());
  assert.match(await row('retire2').innerText(),/剩余 2 天 · 即将到期/);
  assert.match(await row('retire2').innerText(),nas?/模板 1 个/:/配置 1 套/);
  await view.locator('[data-sub=free]').click();assert.equal(await view.locator('[data-deleted-row]').count(),4);
  await view.locator('[data-deleted-search]').fill('81000');assert.equal(await view.locator('[data-deleted-row]').count(),1);
  await row('retire0').locator('[data-one=restore]').click();await row('retire0').waitFor({state:'detached'});
  await view.locator('[data-deleted-search]').fill('');
  await row('retire1').locator('[data-one=purge]').click();assert.match(await confirm.innerText(),/退役样例单删/);
  await confirm.locator('[value=cancel]').click();assert.equal(await row('retire1').count(),1);
  await row('retire1').locator('[data-deleted-id]').check();await view.locator('[data-bulk=purge]').click();await confirm.locator('[value=confirm]').click();await row('retire1').waitFor({state:'detached'});
  if(nas){
   // 列表读完后才被另一操作引用，提交必须重新核对并带回精确的保护数量。
   await addTemplate('retire4');await row('retire4').locator('[data-one=purge]').click();
   await confirm.locator('[value=confirm]').click();await view.locator('[data-deleted-status]').getByText(/仍被 0 套配置、1 个模板引用/).waitFor();
   assert.ok(writes.some(([path,status])=>path.endsWith('/retire4/purge')&&status===409));
  }
  await view.locator('[data-sub=protected]').click();
  await view.locator('[data-bulk=clear]').click();const items=await confirm.locator('li').allTextContents();
  assert.ok(items.some(text=>text.includes('退役样例全清')));assert.ok(items.every(text=>!text.includes('退役样例保留')));
  await confirm.locator('[value=confirm]').click();await view.locator('[data-bulk=clear]:disabled').waitFor();
  await view.locator('[data-sub=all]').click();await row('retire2').waitFor();
  assert.equal(await view.locator('[data-deleted-row]').count(),nas?2:1);
  await view.locator('[data-deleted-all]').check();await view.locator('[data-bulk=restore]').click();
  await view.locator('tbody').getByText('没有符合条件的已删除输出源。').waitFor();
  await sheet.locator('[data-filter=active]').click();await sheet.getByRole('searchbox',{name:'筛选已有输出源'}).fill('退役样例恢复');
  assert.ok(await sheet.locator('[data-sheet-row]').count()>0);
  const persisted=nas?(await api.db.query("SELECT source_id AS id,attrs->>'deletedAt' AS deleted FROM intel_live.sources WHERE source_id LIKE 'retire%' ORDER BY source_id")).rows
    :offline.sourceCatalog.map(row=>({id:row.sourceId,deleted:row.deletedAt??null}));
  assert.deepEqual(persisted,(nas?['retire0','retire2','retire4']:['retire0','retire2']).map(id=>({id,deleted:null})));
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
}
try{await verify(false);await verify(true);console.log('通过：离线和 NAS 已删除输出源的 30 天倒计时、受保护筛选、单条及批量恢复、确认/取消彻底删除、跨筛选清理、并发引用、双主题与实际回读。');}
finally{await browser.close();await api.close();}
