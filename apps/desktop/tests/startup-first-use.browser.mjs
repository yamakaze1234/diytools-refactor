/** 首次接入页面无窗口验收：真实 React/状态机 + 内存桥接；不读取业务目录或发送云请求。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STARTUP_TEST_URL||'http://127.0.0.1:5197';
const output=path.resolve(process.env.STARTUP_TEST_OUTPUT||'sandbox/first-use-migration-20261014/ui');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],scenarios=[];
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/startup-fixture',route=>route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>'}));
 await page.goto(base+'/startup-fixture');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const React=(await import('/node_modules/.vite/deps/react.js')).default;const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {default:StartupLogin}=await import('/src/StartupLogin.tsx');const {createStartupLoginController}=await import('/src/startup-login-controller.ts');
  await import('/src/App.css');
  const root=createRoot(document.querySelector('#root')),member={uid:'ui-test',workspaceId:'ui-workspace',name:'验收成员'};
  window.fixture={calls:[],initialized:false,mode:'cancel',gate:null};
  const reply=value=>({status:200,body:JSON.stringify(value)});
  window.mount=async(initialized=false)=>{
   window.controller?.dispose();Object.assign(window.fixture,{calls:[],initialized,mode:'cancel',gate:null});
   const controller=createStartupLoginController({desktop:true,invoke:async(_command,{action,payloadJson})=>{
    const f=window.fixture;f.calls.push({action,payload:JSON.parse(payloadJson)});
    if(action==='status')return reply({session:{authenticated:true,member}});
    if(action==='firstUseStatus')return reply({required:!f.initialized});
    if(action==='connect'){f.initialized=true;return reply({initialized:true});}
    if(action==='migrateLegacy'){
     if(f.mode==='error')return {status:400,body:JSON.stringify({error:'旧资料所属工作区与登录成员不一致'})};
     if(f.mode==='cancel')return reply({cancelled:true});
     await new Promise(resolve=>{f.gate=resolve;});
     return reply({prepared:true,token:'fixture-token',sourceBound:false,state:{revision:0,configs:[],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}},records:[],outbox:[]});
    }
    if(action==='migrateLegacyApply'){f.initialized=true;return reply({initialized:true});}
    if(action==='logout')return reply({authenticated:false,member:null});
    throw Error('unexpected '+action);
   },onState:state=>root.render(state.phase==='ready'?React.createElement('p',{id:'editor-ready'},'工作台已准备'):React.createElement(StartupLogin,{desktop:true,state,onLogin:(u,p)=>controller.login(u,p),onRetry:()=>controller.retry(),onLogout:()=>controller.logout(),onChooseData:s=>controller.chooseData(s)}))});
   window.controller=controller;await controller.initialize();
  };
  await window.mount();
 });
 const cloud=()=>page.getByRole('button',{name:'从云端下载全部数据'}),legacy=()=>page.getByRole('button',{name:'选择旧版 data 目录迁移'});
 await cloud().waitFor();assert.equal(await legacy().count(),1);assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(x=>x.action)),['status','firstUseStatus']);scenarios.push('explicit-choice-before-binding');
 await page.screenshot({path:path.join(output,'first-use-desktop.png'),fullPage:true});
 await legacy().click();await page.waitForFunction(()=>!window.controller.status().busy);assert.equal(await cloud().isEnabled(),true);assert.equal(await page.locator('#editor-ready').count(),0);scenarios.push('picker-cancel');
 await page.evaluate(()=>{window.fixture.mode='error';});await legacy().click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/工作区/);scenarios.push('owner-mismatch-retry');
 await page.setViewportSize({width:375,height:850});await page.screenshot({path:path.join(output,'first-use-mobile-error.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);scenarios.push('mobile-no-horizontal-overflow');
 await cloud().focus();assert.equal(await cloud().evaluate(el=>document.activeElement===el),true);scenarios.push('keyboard-focus');
 await cloud().click();await page.locator('#editor-ready').waitFor();assert.equal(await page.evaluate(()=>window.fixture.initialized),true);scenarios.push('cloud-choice-enters-workbench');
 await page.evaluate(()=>window.mount(true));await page.locator('#editor-ready').waitFor();assert.equal(await legacy().count(),0);scenarios.push('existing-client-skips-choice');
 await page.evaluate(()=>window.mount());await legacy().waitFor();await page.evaluate(()=>{window.fixture.mode='success';});await legacy().click();
 await page.waitForFunction(()=>typeof window.fixture.gate==='function');assert.equal(await cloud().isDisabled(),true);assert.equal(await legacy().isDisabled(),true);assert.equal(await page.locator('#editor-ready').count(),0);scenarios.push('migration-busy-disables-choices');
 await page.evaluate(()=>window.fixture.gate());await page.waitForFunction(()=>!window.controller.status().busy);assert.equal(await page.evaluate(()=>window.controller.status().phase),'ready',await page.evaluate(()=>window.controller.status().error));await page.locator('#editor-ready').waitFor();
 const apply=await page.evaluate(()=>window.fixture.calls.find(x=>x.action==='migrateLegacyApply'));
 assert.equal(apply.payload.token,'fixture-token');assert(Array.isArray(apply.payload.records));assert(Array.isArray(apply.payload.materializedProjection));scenarios.push('real-projection-helper-before-native-apply');
 assert.deepEqual(errors,[]);const result={status:'passed',scenarios,errors,nativePickerTested:false,cloudNetworkTested:false};await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
