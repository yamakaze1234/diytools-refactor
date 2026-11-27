/** 真实工作台连接回环三店服务，验证操作记录和未保存方案的跨入口交互。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';
import {clickWorkbenchControl,closeWorkbenchDialog} from './review-frontend-visible-ui.mjs';

const fixture=process.argv[2],base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
if(!fixture||existsSync(join(fixture,'real-samples.json')))throw Error('请指定纯合成验收 SQL fixture 目录');
const api=await startSourceAcceptance({fixture,root:join(fixture,'activity-browser-uploads'),
 authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace,name:'我的合成账号'})});
let browser;
try{
 const part={id:randomUUID(),productId:'fixture-link',name:'已保存加购',mode:'parts',priceCents:1200,copyMode:'preset',
  preset:'parts',customCopy:'',presetEdits:{},rules:[{kind:'add',sourceId:'fixture-local',targetGoodsId:'100001',qtyMode:'fixed',qty:1}]};
 await api.db.query("UPDATE jonsbo_live.shops SET settings=jsonb_build_object('addonPacks',$1::jsonb)",[JSON.stringify([part])]);
 const op=randomUUID(),peer='fixture_verified02',recordHash='0'.repeat(64);
 await api.db.query(`INSERT INTO jonsbo_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
  VALUES($1,$2,$3,'jonsbo','costs',$4,'{}')`,[fixtureWorkspace,peer,op,recordHash]);
 await api.db.query(`INSERT INTO jonsbo_live.workspace_audit VALUES
  ($1,$2,$3,1,'100001','tax_sync',1,2,gen_random_uuid(),now()),
  ($1,$2,$3,2,'9900013','tax_file_skipped',1,2,gen_random_uuid(),now())`,[fixtureWorkspace,peer,op]);
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1300,height:900},bypassCSP:true});
 const errors=[],requests=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('dialog',dialog=>void dialog.accept());
 page.setDefaultTimeout(12000);
 const html=(await readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8')).replace(
  '<script type="module" src="./bootstrap.js"></script>',`<script type="module">
   import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;
   window.__vite_plugin_react_preamble_installed__=true;
   const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
   window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');
   document.body.classList.remove('login-required');
  </script>`);
 const app=await readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
 await page.route('**/workbench/activity-nas-fixture?*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.route('**/workbench/app.js',route=>route.fulfill({contentType:'text/javascript',body:app+`
  window.seedAddonDraftForTest=pack=>{currentAddonDrafts().set(pack.id,{pack,base:null});refreshAddonDrafts();};
 `}));
 await page.route('**/catalog.json',route=>route.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api\/native-nas/,'');
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'isolated-activity',deployment_id:fixtureDeployment}});
  if(!path.startsWith('/api/v1/'))return route.fulfill({json:{}});
  requests.push({path,method:req.method(),body:req.postData()});
  const response=await fetch(api.url+path+url.search,{method:req.method(),
   headers:{...req.headers(),'x-workbench-deployment':fixtureDeployment},body:req.postData()??undefined});
  await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
 });
 await page.goto(base+'/workbench/activity-nas-fixture?workspace=nas&nas_shop=jonsbo');
 await page.waitForFunction(()=>window.workbenchReady===true);
 assert.equal(await page.locator('#shop-picker').inputValue(),'jonsbo');
 await page.locator('[data-product-toggle="fixture-link"]').click();
 await page.locator('.rail-navigation').waitFor();
 const openLog=()=>clickWorkbenchControl(page,'#logs-open');
 const modal=page.locator('#dialog.activity-dialog');
 // 先连旧数据库，再安装候选 034 验证同一个正式界面能切到新功能。
 await openLog();
 await modal.getByText('共 2 条记录').waitFor();
 assert.equal(await modal.locator('#activity-cleanup-open').isVisible(),false);
 assert.equal(await modal.locator('#activity-kind').isVisible(),false);
 await closeWorkbenchDialog(page);
 await api.db.exec(await readFile(new URL('../../../services/nas-api/sql/034-activity-filter-and-cleanup.sql',import.meta.url),'utf8'));
 await openLog();
 await modal.getByText('更新 1 项，跳过 1 项手动核算价').waitFor();
 assert.match(await modal.locator('.activity-shop').textContent(),/乔思伯/);
 const geometry=()=>modal.locator('.activity-row').first().evaluate(row=>{
  const style=getComputedStyle(row.querySelector('.activity-action'));
  return [row.querySelector('time').getBoundingClientRect().width,row.querySelector('.activity-person').getBoundingClientRect().width,
   row.querySelector('.activity-action').getBoundingClientRect().width,style.flexWrap,getComputedStyle(row.querySelector('.activity-action strong')).whiteSpace];
 });
 for(const [theme,background] of [['dark','rgb(31, 31, 31)'],['light','rgb(255, 255, 255)']]){
  await closeWorkbenchDialog(page);
  await page.evaluate(theme=>window.dispatchEvent(new CustomEvent('workbench-ui-theme-change',{detail:theme})),theme);
  await openLog();
  await modal.locator('.activity-row').waitFor();
  assert.equal(await modal.evaluate(el=>getComputedStyle(el).backgroundColor),background);
  for(const width of [1300,760]){
   await page.setViewportSize({width,height:900});
   const [time,actor,action,wrap,badge]=await geometry();
   assert.ok(time>=72&&actor>=108&&action>=204);assert.deepEqual([wrap,badge],['wrap','nowrap']);
  }
 }
 await modal.locator('.activity-row .activity-person').click();
 await modal.locator('#activity-kind').selectOption('costs');
 await modal.getByRole('button',{name:'清理历史记录…'}).click();
 await modal.locator('#activity-cleanup-scope').selectOption('selected');
 await modal.getByRole('button',{name:'预览清理'}).click();
 await modal.getByText(/预计清理 2 条底层审计记录，可回收 0 份/).waitFor();
 const purgeRequests=()=>requests.filter(row=>row.path.endsWith('/activity/purge')).map(row=>JSON.parse(row.body));
 assert.deepEqual(purgeRequests(),[{actor:peer,kind:'costs',dry_run:true}]);
 await modal.getByRole('button',{name:'确认清理'}).click();
 await modal.getByText('所选条件下暂无操作记录。').waitFor();
 assert.deepEqual(purgeRequests(),[{actor:peer,kind:'costs',dry_run:true},{actor:peer,kind:'costs',dry_run:false}]);
 assert.equal((await api.db.query('SELECT count(*)::int n FROM jonsbo_live.workspace_receipts')).rows[0].n,1);
 await closeWorkbenchDialog(page);
 await page.setViewportSize({width:1300,height:900});

 const text={...part,id:randomUUID(),name:'新链接文案',mode:'text',priceCents:null,copyMode:'custom',customCopy:'草稿文案',rules:[]};
 const orphan={...text,id:randomUUID(),productId:'archived-only-link',name:''};
 for(const pack of [{...part,name:'加购改名草稿'},text,orphan])await page.evaluate(pack=>window.seedAddonDraftForTest(pack),pack);
 const readDrafts=()=>page.evaluate(async()=> (await window.workbenchCacheStatus()).addonDrafts);
 let drafts=await readDrafts();assert.equal(drafts.length,3);
 assert.deepEqual(drafts.filter(row=>row.canLocate).map(row=>row.mode).sort(),['parts','text']);
 await page.getByText('本机留有 3 份加购包草稿').waitFor();
 await page.evaluate(id=>window.workbenchLocateAddonDraft(id),text.id);
 await page.locator('#pack-select').waitFor();
 assert.equal(await page.locator('#pack-select').inputValue(),text.id);
 assert.equal(await page.locator('#pack-text-mode').getAttribute('aria-pressed'),'true');
 assert.match(await page.locator('#pack-select option:checked').textContent(),/新链接文案（未保存）/);
 const maintenance=async()=>{
  await page.locator('.rail-navigation').getByRole('button',{name:'维护',exact:true}).click();
  await page.locator('#rail-tool-panel').getByRole('button',{name:'加购包维护',exact:true}).click();
  await page.locator('#pack-maintenance-list').waitFor();
 };
 await maintenance();
 await page.locator('#pack-unsaved').check();
 assert.equal(await page.locator('#pack-maintenance-list>details').count(),3);
 const edited=page.locator('#pack-maintenance-list>details').filter({hasText:'加购改名草稿'});
 await edited.locator('summary').first().click();
 await edited.getByRole('button',{name:'编辑此方案'}).click();
 await page.waitForFunction(id=>document.querySelector('#pack-select')?.value===id,part.id);
 assert.equal(await page.locator('#pack-parts-mode').getAttribute('aria-pressed'),'true');
 await maintenance();
 const inactive=page.locator('#pack-maintenance-list>details').filter({hasText:'链接已无在用配置'});
 await inactive.locator('summary').first().click();
 assert.equal(await inactive.getByRole('button',{name:'编辑此方案'}).count(),0);
 await inactive.getByRole('button',{name:'放弃草稿'}).click();
 await inactive.waitFor({state:'detached'});
 await page.getByText('本机留有 2 份加购包草稿').waitFor();
 await closeWorkbenchDialog(page);
 await page.evaluate(ids=>window.workbenchDiscardAddonDrafts(ids),[part.id,text.id]);
 drafts=await readDrafts();assert.deepEqual(drafts,[]);
 assert.equal(await page.locator('#workspace-sync-status').textContent(),'乔思伯 · NAS');
 assert.deepEqual(errors,[]);
 console.log('三店界面验收通过：旧接口降级、双主题布局、筛选清理、两种加购模式定位、总览及孤儿草稿放弃');
}finally{await browser?.close();await api.close();}
