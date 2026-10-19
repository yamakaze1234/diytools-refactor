/** 真实登录组件及状态机，合成原生桥接验证勾选、重开恢复与退出清除。 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
let remembered=false;const calls=[],errors=[],member={uid:'synthetic-member',workspaceId:'synthetic-workspace',name:'测试成员'};
try{
 const page=await browser.newPage({viewport:{width:1000,height:900}});page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('nativeAuth',async(_command,{action,payloadJson})=>{
  const payload=JSON.parse(payloadJson);calls.push({action,remember:payload.remember});let value;
  if(action==='status')value={session:{authenticated:false,member:null,remembered}};
  else if(action==='login'){assert.equal(payload.password,'synthetic-password');remembered=payload.remember===true;value={authenticated:true,member};}
  else if(action==='resume'){assert.equal(remembered,true);value={authenticated:true,member};}
  else if(action==='firstUseStatus')value={required:false};
  else if(action==='connect')value={initialized:true};
  else if(action==='logout'){remembered=false;value={authenticated:false,member:null};}
  else throw Error('unexpected '+action);
  return{status:200,body:JSON.stringify(value)};
 });
 await page.route('**/remember-fixture',route=>route.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));
 const mount=async()=>{
  await page.goto((process.env.STARTUP_TEST_URL||'http://127.0.0.1:5197')+'/remember-fixture');
  await page.evaluate(async()=>{
   const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
   const React=(await import('/node_modules/.vite/deps/react.js')).default,{createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
   const {default:StartupLogin}=await import('/src/StartupLogin.tsx'),{createStartupLoginController}=await import('/src/startup-login-controller.ts');
   const root=createRoot(document.querySelector('#root'));let controller;
   controller=createStartupLoginController({desktop:true,invoke:window.nativeAuth,onState:state=>root.render(state.phase==='ready'?React.createElement('p',{id:'ready'},'已进入工作台'):React.createElement(StartupLogin,{desktop:true,state,onLogin:(...args)=>controller.login(...args),onRetry:()=>controller.retry(),onLogout:()=>controller.logout(),onChooseData:source=>controller.chooseData(source)}))});
   window.controller=controller;await controller.initialize();
  });
 };
 await mount();await page.locator('#startup-username').waitFor();assert.equal(await page.locator('#startup-remember').isChecked(),true);
 await page.locator('#startup-remember').uncheck();await page.locator('#startup-username').fill('synthetic-user');await page.locator('#startup-password').fill('synthetic-password');await page.locator('button[type="submit"]').click();await page.locator('#ready').waitFor();assert.equal(remembered,false);
 await mount();await page.locator('#startup-username').waitFor();await page.locator('#startup-username').fill('synthetic-user');await page.locator('#startup-password').fill('synthetic-password');await page.locator('button[type="submit"]').click();await page.locator('#ready').waitFor();assert.equal(remembered,true);
 const before=calls.length;await mount();await page.locator('#ready').waitFor();assert.deepEqual(calls.slice(before).map(c=>c.action),['status','resume','firstUseStatus','connect']);assert.equal(await page.locator('#startup-password').count(),0);
 assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('synthetic-password')),false);
 await page.evaluate(()=>window.controller.logout());await page.locator('#startup-username').waitFor();assert.equal(remembered,false);
 await mount();await page.locator('#startup-username').waitFor();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',defaultChecked:true,uncheckedDoesNotPersist:true,restartRestoresWithoutPassword:true,logoutClears:true,pageErrors:errors},null,2));
}finally{await browser.close();}
