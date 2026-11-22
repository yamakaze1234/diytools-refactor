/** 真实桌面入口与更新弹窗，只用合成原生回执测试启动检查。 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.STARTUP_TEST_URL||'http://127.0.0.1:5197';
const browser=await chromium.launch({channel:'msedge',headless:true});
const release={currentVersion:'0.2.47',version:'9.9.0',available:true,canInstall:true,source:'Gitea',message:'可用'};
const errors=[];
try{
 for(const scenario of ['available','current','offline','manual']){
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  try{
   const calls=[];
   let finish;
   const pending=new Promise(resolve=>{finish=resolve;});
   await page.exposeFunction('fixtureInvoke',async(command,args)=>{
    calls.push(command);
    const reply=body=>({status:200,body:JSON.stringify(body)});
    if(command==='nas_native_request')return reply({main_editor:false,acceptance:false});
    if(command==='cloud_native_json_request')return reply({configured:false});
    if(command==='updater_check'){
     await pending;
     if(scenario==='offline')throw Error('离线验收');
     return scenario==='current'?{...release,available:false,canInstall:false,version:null}:release;
    }
    if(command==='plugin:app|version')return release.currentVersion;
    if(command==='plugin:event|listen')return 1;
    if(command==='updater_recovery_status')return null;
    if(command==='updater_download'||command==='updater_install')throw Error('验收不应触发下载或安装');
    return null;
   });
   await page.addInitScript(()=>{
    let next=0;
    window.isTauri=true;
    window.__TAURI_INTERNALS__={invoke:(command,args)=>window.fixtureInvoke(command,args),
     transformCallback:()=>++next,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
   });
   await page.route('**/workbench/index.html*',route=>route.fulfill({contentType:'text/html',body:'<html><body>合成编辑区</body></html>'}));
   await page.goto(base+'/');
   const notice=page.getByRole('complementary',{name:'桌面更新'});
   await page.locator('.legacy-workbench-frame').waitFor();
   assert.equal(calls.filter(c=>c==='updater_check').length,1);
   assert.equal(await notice.count(),0);
   if(scenario==='manual'){
    await page.locator('.app-more summary').click();
    await page.getByRole('button',{name:'检查更新',exact:true}).click();
    await page.getByRole('dialog').waitFor();
   }
   finish();
   if(scenario==='available'){
    await notice.getByText('新版 9.9.0 可用').waitFor();
    await notice.getByRole('button',{name:'稍后'}).click();
    await notice.waitFor({state:'detached'});
   }else if(scenario==='manual'){
    await page.getByRole('dialog').getByText('9.9.0',{exact:false}).first().waitFor();
    assert.equal(await notice.count(),0);
   }else{
    // 等待模拟桥接回执与 React 更新完成。
    await page.waitForTimeout(150);
    assert.equal(await notice.count(),0);
   }
   assert.equal(calls.filter(c=>c==='updater_check').length,1);
   assert.equal(calls.some(c=>c==='updater_download'||c==='updater_install'),false);
  }finally{await page.close();}
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,newVersion:true,upToDate:true,offline:true,manualSharesStartupCheck:true}));
}finally{await browser.close();}
