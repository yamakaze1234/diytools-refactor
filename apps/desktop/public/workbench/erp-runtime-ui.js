/** 组件安装入口只调用原生签名通道；个人先行版在通道离线时仍可使用现有组件。 */
export const runtimeBannerHtml='<div class="erp-runtime-banner" data-runtime-banner hidden><span role="status"></span><button type="button" class="primary" hidden></button></div>';
export function bindRuntimeBanner(root,refreshSession,onAvailability=()=>{}){
 const native=window.workbenchErpRuntime;
 if(!native)return;
 const banner=root.querySelector('[data-runtime-banner]'),button=banner.querySelector('button'),label=banner.querySelector('span');
 let revision=0;
 const attached=()=>root.isConnected&&root.closest('dialog')?.open;
 function draw(info){
  const missing=info.status==='missing',outdated=info.status==='outdated',offline=info.status==='unavailable';
  onAvailability(!missing&&(!offline||info.hasLocal));
  banner.hidden=!(missing||outdated||offline&&!info.hasLocal);button.hidden=!(missing||outdated);
  button.disabled=false;button.textContent=outdated?'一键更新组件':'一键安装组件';
  label.textContent=missing?'本机缺少 ERP 匹配组件，请安装后登录。':outdated?'ERP 匹配组件有可用更新。':info.message||'组件通道暂时不可用，请稍后再试。';
 }
 async function check(){
  const token=++revision;
  try{const info=await native('check');if(attached()&&revision===token)draw(info);}
  catch{if(attached()&&revision===token){banner.hidden=false;button.hidden=true;label.textContent='暂时无法检查 ERP 组件版本。';}}
 }
 async function installed(){
  if(!attached())return;
  await Promise.all([check(),refreshSession()]);
 }
 window.addEventListener('erp-runtime-installed',installed);
 root.closest('dialog')?.addEventListener('close',()=>window.removeEventListener('erp-runtime-installed',installed),{once:true});
 button.onclick=async()=>{
  if(button.disabled)return;
  ++revision;button.disabled=true;banner.setAttribute('aria-busy','true');label.textContent='正在下载、核验并安装 ERP 组件…';
  try{
   const info=await native('install');
   if(attached())draw(info);
   if(info.status==='ready')window.dispatchEvent(new Event('erp-runtime-installed'));
  }catch(error){
   if(attached())label.textContent=typeof error==='string'?error:error?.message||'组件安装失败，请重试。';
  }finally{if(attached()){button.disabled=false;banner.removeAttribute('aria-busy');}}
 };
 void check();
}
