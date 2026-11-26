/** Edge 使用真实 IndexedDB，NAS 保存与回执走仅监听回环的合成 PGlite 服务。 */
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {startSourceAcceptance,fixtureActor,fixtureWorkspace,fixtureDeployment} from '../../../services/nas-api/tools/shared-sources-acceptance.mjs';

if(!process.argv[2])throw Error('请提供合成三店 NAS fixture 目录');
const root=await mkdtemp(join(tmpdir(),'diy-nas-draft-acceptance-'));
const api=await startSourceAcceptance({fixture:resolve(process.argv[2]),root,authenticate:async()=>({uid:fixtureActor,workspaceId:fixtureWorkspace})});
const origin=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const prefix='diy-nas-draft:'+JSON.stringify(['isolated:main',fixtureWorkspace,fixtureActor])+':';
const oldDoc={id:'legacy',shopId:'intel',name:'旧版草稿',parts:[],actualParts:[],addons:[]};
const text=JSON.stringify({format:1,id:oldDoc.id,version:null,document:oldDoc,base:null,pending:null,dependencies:{sources:{},costs:{}}});
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/draft-acceptance',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>隔离草稿验收</title>'}));
 await page.route('**/draft-api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.slice('/draft-api'.length);
  if(path==='/settings')return route.fulfill({json:{configured:true,main_editor:true,endpoint_id:'isolated',deployment_id:fixtureDeployment}});
  const response=await fetch(api.url+path,{method:req.method(),body:req.postData()??undefined,
   headers:{'content-type':'application/json','x-workbench-deployment':fixtureDeployment}});
  await route.fulfill({status:response.status,body:await response.text(),contentType:'application/json'});
 });
 await page.goto(origin+'/draft-acceptance');
 await page.evaluate(([key,value])=>localStorage.setItem(key,value),[prefix+'"legacy"',text]);
 async function start(){
  await page.evaluate(async()=>{
   const {createNasDraftStorage}=await import('/workbench/nas-draft-storage.js');
   const {createNasMainWorkspace}=await import('/workbench/nas-main-workspace.js');
   const nativeRequest=(path,options)=>fetch('/draft-api'+path,options);
   const driver=createNasDraftStorage({legacyStorage:localStorage});
   const workspace=createNasMainWorkspace({nativeRequest,storage:localStorage,draftStorage:driver});
   const member=await workspace.initialize();
   window.fixtureDrafts={workspace,driver,member};
  });
 }
 await start();
 assert.equal(await page.evaluate(key=>fixtureDrafts.driver.getFresh(key),prefix+'"legacy"'),text);
 const count=208;
 await page.evaluate(async count=>{
  const {createNasDraftController}=await import('/workbench/nas-draft-controller.js');
  const {driver,member}=fixtureDrafts;
  // 高容量样例仅在本地编辑；已确认成员与工作台一致，避免为压测制造服务端配置。
  const ctrl=createNasDraftController({client:{me:async()=>member},draftStorage:driver,endpointId:'isolated:main'});
  for(let i=0;i<count;i++){
   const document={id:'bulk-'+i,shopId:'intel',name:'合成配置 '+i,parts:[],actualParts:[],addons:[],description:'x'.repeat(64000)+i};
   await ctrl.create(document);ctrl.edit({...document,name:'本机修改 '+i});
  }
  await fixtureDrafts.workspace.flushDrafts();
 },count);
 const verify=()=>page.evaluate(async({count,prefix})=>{
  const {driver,workspace}=fixtureDrafts;
  const ids=new Set(workspace.drafts().map(row=>row.id));
  let bytes=0;
  for(let i=0;i<count;i++){
   const id='bulk-'+i,raw=await driver.getFresh(prefix+JSON.stringify(id));
   const expected={format:1,id,version:null,base:null,dependencies:{sources:{},costs:{}},document:{id,shopId:'intel',name:'本机修改 '+i,
    parts:[],actualParts:[],addons:[],description:'x'.repeat(64000)+i},pending:null};
   if(!ids.has(id)||raw!==JSON.stringify(expected))throw Error('草稿恢复不完整 '+id);
   bytes+=new TextEncoder().encode(raw).length;
  }
  return {bytes,count:ids.size,legacy:Object.keys(localStorage).filter(k=>k.startsWith('diy-nas-draft:')).length};
 },{count,prefix});
 const before=await verify();assert(before.bytes>12*1024**2);assert.equal(before.count,count+1);assert.equal(before.legacy,0);
 await page.reload();await start();assert.deepEqual(await verify(),before);
 // 通过主工作台实际加载并保存一个服务端配置，再核对回执、服务端名称和原始磁盘记录。
 const saved=await page.evaluate(async prefix=>{
  const {workspace,driver}=fixtureDrafts;
  const head=await workspace.request('/api/workspace/index'),id=head.summaries[0].id;
  const load=()=>workspace.request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:[id],revision:head.revision})});
  const {configs:[config]}=await load();workspace.attach(config);config.name='草稿回执验收';workspace.stage(config);
  await workspace.flushDrafts();const key=prefix+JSON.stringify(id);
  if(!await driver.getFresh(key))throw Error('服务端保存前缺本机草稿');
  const receipt=await workspace.submit(config),disk=await driver.getFresh(key);
  const {configs:[readback]}=await load();
  return {receipt,disk,id,name:readback.name};
 },prefix);
 assert.equal(saved.receipt.configuration_id,saved.id);assert.equal(saved.disk,null);assert.equal(saved.name,'草稿回执验收');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...before,bulk:count,reloaded:true,confirmedVersion:saved.receipt.version,root}));
}finally{await browser?.close();await api.close();}
