/** 手动清理缓存：草稿选择先完成，原生只清受限缓存，最后确认工作台已重新载入。 */
import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
type AddonDraft={id:string;productId:string;productName:string;name:string;mode:'parts'|'text';canLocate:boolean;failed:boolean};
type Status={count:number;drafts:{id:string;name?:string;product?:string;pending?:boolean}[];blocker:string|null;addonDrafts?:AddonDraft[]};
type Report={recycledFiles:number;recycledBytes:number;matchingFiles:number;matchingBytes:number;retained:number;browserCacheCleared:boolean;warnings:string[]};
type CacheFrame=Window&{workbenchReady?:boolean;workbenchCacheStatus?:()=>Promise<Status>;workbenchPrepareCacheCleanup?:(choice:string)=>Promise<Status>;workbenchReloadAfterCache?:()=>void;
 workbenchLocateAddonDraft?:(id:string)=>Promise<void>;workbenchDiscardAddonDrafts?:(ids:string[])=>Promise<Status>};
const frame=()=>document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow as CacheFrame|null;
function reloadWorkbench(workbench:CacheFrame){
 return new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('缓存已处理，服务端资料尚未载入完成，请稍后重新打开工作台。'));},45000);
  const receive=(event:MessageEvent)=>{if(event.source===workbench&&event.origin===location.origin&&event.data?.type==='workbench-ready'){cleanup();resolve();}};
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  window.addEventListener('message',receive);
  try{workbench.workbenchReloadAfterCache!();}catch(error){cleanup();reject(error);}
 });
}
export default function CacheCleanupDialog({onClose,onFreeze}:{onClose:()=>void;onFreeze:(value:boolean)=>void}){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('正在检查草稿…'),[finished,setFinished]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();let live=true;const workbench=frame();
  if(!workbench?.workbenchCacheStatus)setMessage('工作台尚未就绪，请稍后重试。');
  else void workbench.workbenchCacheStatus().then(value=>{if(live){setStatus(value);setMessage(value.blocker||'');}},error=>{if(live)setMessage(String(error.message||error));});
  return()=>{live=false;};},[]);
 const addonDrafts=status?.addonDrafts??[];
 async function discardAddon(ids:string[],label:string){
  const workbench=frame();
  if(busy||!workbench?.workbenchDiscardAddonDrafts||!confirm(`确认放弃${label}？`))return;
  setBusy(true);
  try{
   const next=await workbench.workbenchDiscardAddonDrafts(ids);setStatus(next);setMessage(next.blocker||'');
  }catch(error){
   try{setStatus(await workbench.workbenchCacheStatus?.()??null);}catch{/* 保留删除失败的提示。 */}
   setMessage(error instanceof Error?error.message:String(error));
  }finally{setBusy(false);}
 }
 async function run(choice:'check'|'save'|'discard'){
  if(busy||window.workbenchClosePending||window.workbenchUpdatePending)return;
  if(!isTauri()){setMessage('磁盘与浏览器缓存清理需要在桌面程序中运行。');return;}
  const workbench=frame();if(!workbench?.workbenchPrepareCacheCleanup||!workbench.workbenchReloadAfterCache){setMessage('工作台尚未就绪，请稍后重试。');return;}
  if(choice==='discard'&&!confirm(`确认放弃当前店铺 ${status?.count??0} 份未保存草稿后清理缓存？此操作会重新载入服务器资料。`))return;
  window.workbenchUpdatePending=true;setBusy(true);onFreeze(true);setMessage('正在处理草稿并清理缓存…');
  try{
   await workbench.workbenchPrepareCacheCleanup(choice);
   // 放弃后即使原生清理失败，也必须重载编辑器，不能解冻已撤掉草稿控制器的旧 DOM。
   let report:Report;
   try{report=await invoke<Report>('workbench_clear_cache');}
   finally{await reloadWorkbench(workbench);}
   setFinished(true);setStatus(null);setMessage(`已将 ${report.recycledFiles-report.matchingFiles} 个旧安装包和 ${report.matchingFiles} 份 ERP 匹配回执（${(report.recycledBytes/1048576).toFixed(1)} MB）移入回收站；${report.browserCacheCleared?'浏览器缓存已清理；':''}已重新加载服务端最新资料。${report.retained?`保留 ${report.retained} 个当前版本、更新中或待核对安装包。`:''}${report.warnings.join(' ')}`);
  }catch(error){setMessage(error instanceof Error?error.message:String(error));try{setStatus(await frame()?.workbenchCacheStatus?.()??null);}catch{/* 保留原错误，不以未知状态继续清理。 */}}
  finally{window.workbenchUpdatePending=false;onFreeze(false);setBusy(false);}
 }
 return <dialog ref={dialog} className="cache-cleanup-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <h2>清理缓存</h2><p>清理历史更新安装包、浏览器缓存和已完成的本机 ERP 匹配回执，并重新加载最新资料。未完成和待核验的回执会保留。登录、连接设置和本机运行时文件会保留。</p>
  {!!status?.count&&<section aria-label="未保存的配置草稿">
   <p>当前店铺有 {status.count} 份未保存草稿。</p>
   <ul className="cache-config-drafts">{status.drafts.map(row=><li key={row.id}>{row.product&&`${row.product} · `}{row.name||row.id}{row.pending&&'（待确认回执）'}</li>)}</ul>
  </section>}
  {addonDrafts.length>0&&<section aria-label="未保存的加购包草稿">
   <ul className="cache-addon-drafts">{addonDrafts.map(row=><li key={row.id} data-failed={row.failed}>
    <div><strong>{row.name}</strong><small>{row.productName} · {row.mode==='parts'?'加购包方案':'链接文案'}</small>
     {row.failed&&<strong className="cache-addon-error">草稿写盘失败</strong>}</div>
    <div className="actions">{row.canLocate&&<button disabled={busy} onClick={()=>{
     const workbench=frame();onClose();
     void workbench?.workbenchLocateAddonDraft?.(row.id);
    }}>定位编辑</button>}
    <button disabled={busy} onClick={()=>void discardAddon([row.id],`「${row.name}」`)}>放弃草稿</button></div>
   </li>)}</ul>
   <button disabled={busy} onClick={()=>void discardAddon(addonDrafts.map(row=>row.id),`全部 ${addonDrafts.length} 份加购包草稿`)}>放弃全部加购包草稿</button>
  </section>}
  <p role="status">{message}</p><div className="actions">
   {!finished&&!status?.blocker&&status&&(status.count?<><button disabled={busy} onClick={()=>void run('save')}>先保存再清理</button><button disabled={busy} onClick={()=>void run('discard')}>确认放弃草稿后清理</button></>:<button disabled={busy} onClick={()=>void run('check')}>清理缓存</button>)}
   <button disabled={busy} onClick={onClose}>{finished?'完成':'取消'}</button></div>
 </dialog>;
}
