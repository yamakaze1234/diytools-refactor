/** 桌面 React 宿主：组织启动登录、工作台导航和更新流程，统一阻止未完成保存时的切换。 */
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from '@tauri-apps/api/core';
import ConfigWorkspace from "./ConfigWorkspace";
import ErpEnvironment from "./ErpEnvironment";
import LegacyMigration from "./LegacyMigration";
import LegacyWorkbench from "./LegacyWorkbench";
import UpdateDialog from "./UpdateDialog";
import StartupLogin from './StartupLogin';
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
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateFrozen, setUpdateFrozen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = createStartupLoginController({ desktop,
      invoke: (command, args) => invoke<CloudApiResponse>(command, args), onState: setLogin });
    loginController.current = controller;
    void controller.initialize();
    const signedOut = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow;
      if (!trustedWorkbenchSignOut(event, frame, location.origin) || window.workbenchClosePending || window.workbenchUpdatePending) return;
      // The sender has already completed stop/save/logout. Only its own same-origin
      // frame can release this editing surface; incidental session refresh cannot.
      controller.signedOut(); setPage('workbench'); setDirty(false); setNotice(''); setUpdateOpen(false); setUpdateFrozen(false);
    };
    window.addEventListener('message', signedOut);
    return () => { controller.dispose(); window.removeEventListener('message', signedOut); if (loginController.current === controller) loginController.current = null; };
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
  function navigate(next: Page) {
    if (next === page) return;
    const live = document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow as (Window & {workbenchHasPendingChanges?:()=>boolean}) | null;
    if (dirty || window.workbenchClosePending || window.workbenchUpdatePending || live?.workbenchHasPendingChanges?.()) { setNotice("请先保存或放弃当前修改、完成待确认操作，并等待操作结束，再切换页面。"); return; }
    setNotice(""); setDirty(false); setPage(next);
  }
  if (login.phase !== 'ready') return <StartupLogin desktop={desktop} state={login}
    onLogin={(username, password) => loginController.current?.login(username, password) ?? Promise.resolve()}
    onRetry={() => loginController.current?.retry() ?? Promise.resolve()}
    onLogout={() => loginController.current?.logout() ?? Promise.resolve()} />;
  return <main className={`app-shell ${page === "workbench" ? "app-shell-workbench" : ""}`}>
    <header ref={header} inert={updateFrozen} className="app-header"><div><strong>DIY Tools</strong><span>本地测试版</span></div><nav aria-label="主导航"><button className={page === "workbench" ? "active" : ""} disabled={dirty && page !== "workbench"} onClick={() => navigate("workbench")}>配置工作台</button></nav><span className="sandbox-label">{login.localOnly ? '本机保存' : '独立本地数据'}</span><details className="app-more"><summary>更多</summary><div className="app-more-menu"><button className={page === "migration" ? "active" : ""} disabled={dirty && page !== "migration"} onClick={event => { navigate("migration"); event.currentTarget.closest('details')?.removeAttribute('open'); }}>迁移记录</button><button className={page === "erp" ? "active" : ""} disabled={dirty && page !== "erp"} onClick={event => { navigate("erp"); event.currentTarget.closest('details')?.removeAttribute('open'); }}>ERP 环境</button><button onClick={event => { setUpdateOpen(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}>检查更新</button></div></details></header>
    {notice && <p className="notice" role="alert">{notice}<button className="text-button" onClick={() => setNotice("")}>知道了</button></p>}
    <div ref={content} inert={updateFrozen} className="app-content">{page === "workbench" ? <LegacyWorkbench onDirty={setDirty} /> : page === "configs" ? <ConfigWorkspace onDirty={setDirty} /> : page === "migration" ? <LegacyMigration onDirty={setDirty} /> : <ErpEnvironment />}</div>
    <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} dirty={page !== "workbench" && dirty} onFreeze={freezeForUpdate} />
  </main>;
}
