/** 工作台启动入口：等待宿主桥接完成，再加载主界面，避免请求落到未准备好的本地接口。 */
import {observeEmptyErrors} from './ui-feedback.js';
observeEmptyErrors(document.body);
// The React host installs the local Tauri adapter before any workbench module runs.
/** 初始化桥接和工作台模块；启动失败时在页面提供可见错误。 */
async function start(){
 try{
  if(window.parent===window||typeof window.parent.installWorkbenchBridge!=='function')throw Error('请从 DIY Tools 桌面工作台打开此页面');
  await window.parent.installWorkbenchBridge(window);
  await import('./app.js');
  if(!window.workbenchReady)throw Error(document.querySelector('#editor .error')?.textContent||'本机工作台载入失败');
  document.body.classList.remove('login-required');
  window.parent.postMessage({type:'workbench-ready'},location.origin);
  let previous=null;
  const check=()=>{const dirty=Boolean(window.workbenchHasPendingChanges?.());if(dirty!==previous){previous=dirty;window.parent.postMessage({type:'workbench-dirty',dirty},location.origin);}};
  check();setInterval(check,250);
 }catch(error){
  document.querySelector('#login-message').textContent=error.message;
  window.parent.postMessage({type:'workbench-error',message:error.message},location.origin);
 }
}
start();
