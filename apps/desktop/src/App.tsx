import ConnectionSettings, {type ConnectionConfig} from './ConnectionSettings';
import { createPortal } from 'react-dom';
import WorkbenchThemeToggle from './WorkbenchThemeToggle';
import {Button} from '@/components/ui/button';
import './reui.css';
import DiagnosticExport from './DiagnosticExport';
import CacheCleanupDialog from './CacheCleanupDialog';
import AgentPermissionsMenu from './AgentPermissionsDialog';
/** 桌面 React 宿主：组织启动登录、工作台导航和更新流程，统一阻止未完成保存时的切换。 */
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from '@tauri-apps/api/core';
import ConfigWorkspace from "./ConfigWorkspace";
import ErpEnvironment from "./ErpEnvironment";
import LegacyMigration from "./LegacyMigration";
import LegacyWorkbench from "./LegacyWorkbench";
import UpdateDialog from "./UpdateDialog";
import type { UpdateCheck } from './updater-controller';
import StartupLogin from './StartupLogin';
import StartupUpdateNotice from './StartupUpdateNotice';
import { createStartupLoginController, initialStartupLoginState, trustedWorkbenchSignOut } from './startup-login-controller';
import type { CloudApiResponse } from './startup-login-controller';
import "./App.css";

type Page = "workbench" | "configs" | "migration" | "erp";
/** 根据登录阶段挂载页面，将脏状态与更新冻结状态集中管理。 */
export default function App() {
  const desktop = isTauri();
  const [login, setLogin] = useState(() => initialStartupLoginState(desktop));
  const loginController = useRef<ReturnType<typeof createStartupLoginController> | null>(null);
  const [page, setPage] = useState<Page>("workbench");
  const [headerTarget, setHeaderTarget] = useState<HTMLElement|null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [cacheOpen,setCacheOpen]=useState(false);
  const [startupRelease, setStartupRelease] = useState<UpdateCheck|null>(null);
  const [startupOffer, setStartupOffer] = useState<UpdateCheck|null>(null);
  const startupCheck = useRef<Promise<UpdateCheck>|null>(null);
  const startupChecking = useRef(false);
  const runtimeCheck = useRef<Promise<{status:string;hasLocal:boolean}>|null>(null);
  const [runtimeOffer,setRuntimeOffer]=useState(false);
  const [runtimeBusy,setRuntimeBusy]=useState(false);
  const [runtimeMessage,setRuntimeMessage]=useState('');

  const startupNoticeDismissed = useRef(false);
  const [updateFrozen, setUpdateFrozen] = useState(false);
  const [nasMain,setNasMain]=useState(false);
  const [acceptance,setAcceptance]=useState(false);
  const [connectionOpen,setConnectionOpen]=useState(false);
  const [connectionRequired,setConnectionRequired]=useState(false);
  const header = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed=false,controller:ReturnType<typeof createStartupLoginController>|null=null;
    void (async()=>{
      try{
        const native=desktop?await invoke<CloudApiResponse>('nas_native_request',{method:'GET',route:'/settings',body:null,expectedActor:null}):null;
        if(disposed)return;
        if(native&&native.status!==200)throw Error('无法核对工作台启动模式。');
        const info=native?JSON.parse(native.body):{};
        const useNas=info.main_editor===true;
        setNasMain(useNas);
        setAcceptance(info.acceptance===true);
        // 检查独立于登录，复用同一次启动的查询，离线时安静退出。
        if(desktop&&info.acceptance!==true){
          if(!startupCheck.current){
            startupChecking.current=true;
            startupCheck.current=invoke<UpdateCheck>('updater_check').finally(()=>{startupChecking.current=false;});
          }
          // 私有组件有独立的签名清单，启动检查只提醒已有组件的用户。
          runtimeCheck.current??=startupCheck.current.catch(()=>null).then(()=>invoke('erp_runtime_check'));
          void runtimeCheck.current.then(result=>{
            if(!disposed&&result?.hasLocal&&result.status==='outdated')setRuntimeOffer(true);
          },()=>{});
          void startupCheck.current.then(release=>{
            if(!disposed&&!startupNoticeDismissed.current&&release.available&&release.version)setStartupRelease(release);
          },()=>{});
        }
        if(useNas&&!info.configured){setConnectionRequired(true);setConnectionOpen(true);return;}
        controller=createStartupLoginController({desktop,nasMain:useNas,
          invoke:(command,args)=>invoke<CloudApiResponse>(useNas?'nas_identity_request':command,args),onState:setLogin});
        loginController.current=controller;
        void controller.initialize();
      }catch(error){
        if(!disposed)setLogin({...initialStartupLoginState(false),error:error instanceof Error?error.message:'无法核对工作台启动模式。'});
      }
    })();
    const signedOut = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow;
      if (!trustedWorkbenchSignOut(event, frame, location.origin) || window.workbenchClosePending || window.workbenchUpdatePending) return;
      // The sender has already completed stop/save/logout. Only its own same-origin
      // frame can release this editing surface; incidental session refresh cannot.
      controller?.signedOut(event.data?.nasLogoutUnconfirmed===true); setPage('workbench'); setDirty(false); setNotice(''); setUpdateOpen(false); setUpdateFrozen(false);
    };
    window.addEventListener('message', signedOut);
    return () => { disposed=true; controller?.dispose(); window.removeEventListener('message', signedOut); if (loginController.current === controller) loginController.current = null; };
  }, [desktop]);
  function freezeForUpdate(frozen: boolean) {
    const frame = document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame');
    if (frozen) {
      (frame?.contentDocument?.activeElement as HTMLElement | null)?.blur?.();
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    if (frame) frame.inert = frozen || Boolean(window.workbenchClosePending);
    if (header.current) header.current.inert = frozen;
    if (content.current) content.current.inert = frozen;
    setUpdateFrozen(frozen);
  }
  // 保存连接复用退出前检查，冻结两个编辑面；新地址只在重启后生效。
  async function saveConnection(config:ConnectionConfig){
    if(window.workbenchClosePending||window.workbenchUpdatePending)throw Error('请等待当前操作结束。');
    window.workbenchUpdatePending=true;
    try{
      freezeForUpdate(true);
      const frame=document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow as (Window & {workbenchBeforeQuit?:()=>Promise<void>;workbenchHasPendingChanges?:()=>boolean})|null;
      if(frame){
        if(!frame.workbenchBeforeQuit||!frame.workbenchHasPendingChanges)throw Error('工作台尚未就绪，请稍后重试。');
        await frame.workbenchBeforeQuit();
        if(frame.workbenchHasPendingChanges())throw Error('请先处理未完成的操作，再修改连接。');
      }
      await invoke('nas_connection_save',{config});
      await invoke('nas_connection_restart');
    }catch(error){window.workbenchUpdatePending=false;freezeForUpdate(false);throw error;}
  }
  // 关闭启动提醒只影响本次会话，仍可从更多菜单手动检查。
  function dismissStartupNotice() {
    startupNoticeDismissed.current = true;
    setStartupRelease(null);
  }
  async function installRuntime(){
    setRuntimeBusy(true);setRuntimeMessage('正在下载并校验 ERP 组件…');
    try{
      const result=await invoke<{status:string;message:string}>('erp_runtime_install');
      if(result.status!=='ready')throw Error(result.message||'组件尚未就绪');
      const frame=document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame');
      frame?.contentWindow?.dispatchEvent(new Event('erp-runtime-installed'));
      setRuntimeOffer(false);setNotice('ERP 匹配组件已更新。');
    }catch(error){setRuntimeMessage(String(error));}
    finally{setRuntimeBusy(false);}
  }
  const connectionDialog=connectionOpen?<ConnectionSettings firstUse={connectionRequired} onClose={()=>setConnectionOpen(false)} onSave={saveConnection}/>:null;
  function navigate(next: Page) {
    if(nasMain&&next!=='workbench')return;
    if (next === page) return;
    const live = document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow as (Window & {workbenchHasPendingChanges?:()=>boolean}) | null;
    if (dirty || window.workbenchClosePending || window.workbenchUpdatePending || live?.workbenchHasPendingChanges?.()) { setNotice("请先保存或放弃当前修改、完成待确认操作，并等待操作结束，再切换页面。"); return; }
    setNotice(""); setDirty(false); setPage(next);
  }
  if(connectionRequired)return connectionDialog;
  if (login.phase !== 'ready') return <>{connectionDialog}<StartupLogin desktop={desktop} state={login} nasMain={nasMain}
    onLogin={(username, password, remember) => loginController.current?.login(username, password, remember) ?? Promise.resolve()}
    onRetry={() => loginController.current?.retry() ?? Promise.resolve()}
    onChooseData={source => loginController.current?.chooseData(source) ?? Promise.resolve()}
    onLogout={() => loginController.current?.logout() ?? Promise.resolve()} onConnectionSettings={nasMain&&!acceptance?()=>setConnectionOpen(true):undefined} /></>;
  const hostHeader = <header ref={header} inert={updateFrozen} className="app-header">
    <div><strong>DIY Tools</strong><span>配置工作台</span></div>
    <nav aria-label="主导航"><Button type="button" variant="outline" className={page === "workbench" ? "active" : ""} disabled={dirty && page !== "workbench"} onClick={() => navigate("workbench")}>配置工作台</Button></nav>
    <span className="sandbox-label">{acceptance?'完整测试版 · 本机测试数据':nasMain?'局域网 · NAS':login.localOnly ? '本机保存' : '团队工作区'}</span>
    <WorkbenchThemeToggle/>
    <details className="app-more"><summary>更多</summary><div className="app-more-menu">
      {nasMain&&!acceptance&&<Button type="button" variant="outline" onClick={event=>{setConnectionOpen(true);event.currentTarget.closest('details')?.removeAttribute('open');}}>连接设置</Button>}
      {nasMain&&<Button type="button" variant="outline" onClick={event => {
        const frame=document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame');
        frame?.contentWindow?.postMessage({type:'workbench-nas-autosave-settings'},location.origin);
        event.currentTarget.closest('details')?.removeAttribute('open');
      }}>自动保存设置</Button>}
      {nasMain&&desktop&&<AgentPermissionsMenu/>}
      {/* 新版通道由原生签名契约隔离；诊断仅导出本次运行日志。 */}
      {!acceptance&&<Button type="button" variant="outline"
        onClick={event => { dismissStartupNotice();setUpdateOpen(true);event.currentTarget.closest('details')?.removeAttribute('open'); }}>检查更新</Button>}
      <DiagnosticExport />
      <Button type="button" variant="outline" onClick={event=>{setCacheOpen(true);event.currentTarget.closest('details')?.removeAttribute('open');}}>清理缓存</Button>
    </div></details>
  </header>;
  return <main className={`app-shell ${page === "workbench" ? "app-shell-workbench" : ""}`}>
    {page === "workbench" && headerTarget ? createPortal(hostHeader, headerTarget) : hostHeader}
    {Boolean(login.migrationMissingImages) && <p className="notice" role="status">旧资料中有 {login.migrationMissingImages} 张原图未找到，配置已保留。云端同步将尝试补齐，仍缺失时请重新选择原图。</p>}
    {runtimeOffer&&!startupRelease&&!updateOpen&&!cacheOpen&&!connectionOpen&&<aside className="notice" aria-live="polite">
      <span>{runtimeMessage||'本机 ERP 匹配组件有新版。'}</span>
      <Button type="button" disabled={runtimeBusy} onClick={()=>void installRuntime()}>一键更新组件</Button>
      <Button type="button" variant="outline" disabled={runtimeBusy} onClick={()=>setRuntimeOffer(false)}>稍后</Button>
    </aside>}
    {notice && <p className="notice" role="alert">{notice}<Button type="button" variant="outline" className="text-button" onClick={() => setNotice("")}>知道了</Button></p>}
    <div ref={content} inert={updateFrozen} className="app-content">{page === "workbench" ? <LegacyWorkbench nasMain={nasMain} onDirty={setDirty} onHeaderTarget={setHeaderTarget} /> : page === "configs" ? <ConfigWorkspace onDirty={setDirty} /> : page === "migration" ? <LegacyMigration onDirty={setDirty} /> : <ErpEnvironment />}</div>
    {connectionDialog}
    {cacheOpen&&<CacheCleanupDialog onClose={()=>setCacheOpen(false)} onFreeze={freezeForUpdate}/>}
    {startupRelease && !updateOpen && !connectionOpen && (
      <StartupUpdateNotice release={startupRelease} onDismiss={dismissStartupNotice} onUpdate={() => {
        setStartupOffer(startupRelease);
        dismissStartupNotice();
        setUpdateOpen(true);
      }} />
    )}
    <UpdateDialog open={updateOpen} startupOffer={startupOffer} onClose={() => {setStartupOffer(null);setUpdateOpen(false);}} dirty={page !== "workbench" && dirty} onFreeze={freezeForUpdate}
      check={async()=>startupChecking.current&&startupCheck.current?startupCheck.current:invoke<UpdateCheck>('updater_check')} />
  </main>;
}
