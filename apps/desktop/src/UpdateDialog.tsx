/** 程序更新弹窗：检查更新、展示候选版本并在应用更新期间冻结工作台操作。 */
import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { createUpdaterController, shouldPreventUpdaterClose, type UpdateCheck, type DownloadedUpdate, type UpdateProgress, type UpdateState, type UpdateWorkbench } from './updater-controller';
import { createUpdaterAccessController, type UpdaterAccessState, type UpdaterAccessStatus } from './updater-access-controller';

const initial: UpdateState = { phase: 'idle', release: null, downloaded: null, progress: null, error: '', restartAfterDownload: false };

/** 连接更新控制器与界面，未保存草稿和更新中状态均参与关闭保护。 */
export default function UpdateDialog({ open, onClose, dirty, onFreeze }: {
  open: boolean; onClose(): void; dirty: boolean; onFreeze(frozen: boolean): void;
}) {
  const [state, setState] = useState(initial);
  const [eventError, setEventError] = useState('');
  const [currentVersion, setCurrentVersion] = useState('');
  const [access, setAccess] = useState<UpdaterAccessState>({ status: null, busy: false, error: '' });
  const [token, setToken] = useState('');
  const [accessOpen, setAccessOpen] = useState(false);
  const accessRef = useRef<ReturnType<typeof createUpdaterAccessController> | null>(null);
  const dirtyRef = useRef(dirty);
  const freezeRef = useRef(onFreeze);
  const dialogRef = useRef<HTMLElement>(null);
  dirtyRef.current = dirty;
  freezeRef.current = onFreeze;
  const controllerRef = useRef<ReturnType<typeof createUpdaterController> | null>(null);
  useEffect(() => {
    let closeGuardReady = !isTauri();
    const nativeOnly = () => { if (!isTauri()) throw Error('检查和安装更新需要在桌面程序中运行。'); };
    const controller = createUpdaterController({
      check: () => { nativeOnly(); return invoke<UpdateCheck>('updater_check'); },
      download: () => { nativeOnly(); return invoke<DownloadedUpdate>('updater_download'); },
      install: () => { nativeOnly(); return invoke('updater_install'); },
      getWorkbench: () => document.querySelector<HTMLIFrameElement>('.legacy-workbench-frame')?.contentWindow as UpdateWorkbench | null ?? null,
      hasUnsavableChanges: () => dirtyRef.current,
      acquireInstall: () => {
        if (!closeGuardReady || window.workbenchClosePending || window.workbenchUpdatePending) return false;
        window.workbenchUpdatePending = true;
        return true;
      },
      releaseInstall: () => { window.workbenchUpdatePending = false; },
      freeze: frozen => freezeRef.current(frozen),
      onState: setState,
    });
    controllerRef.current = controller;
    const accessController = createUpdaterAccessController({
      invoke: (command, args) => { nativeOnly(); return invoke<UpdaterAccessStatus>(command, args); },
      onState: setAccess,
    });
    accessRef.current = accessController;
    let disposed = false;
    let remove: (() => void) | undefined;
    let removeClose: (() => void) | undefined;
    if (isTauri()) getVersion().then(version => { if (!disposed) setCurrentVersion(version); }).catch(() => {});
    if (isTauri()) listen<UpdateProgress>('updater-progress', event => controller.progress(event.payload)).then(unlisten => {
      if (disposed) unlisten(); else remove = unlisten;
    }).catch(error => { if (!disposed) setEventError('下载进度监听不可用：' + String(error)); });
    if (isTauri()) getCurrentWindow().onCloseRequested(event => {
      if (shouldPreventUpdaterClose(Boolean(document.querySelector('.legacy-workbench-frame')), Boolean(window.workbenchUpdatePending))) event.preventDefault();
    }).then(unlisten => {
      if (disposed) unlisten(); else { removeClose = unlisten; closeGuardReady = true; }
    }).catch(error => { if (!disposed) setEventError('更新关闭保护未能安装：' + String(error)); });
    return () => { disposed = true; remove?.(); removeClose?.(); controller.dispose(); accessController.dispose(); if (controllerRef.current === controller) controllerRef.current = null; if (accessRef.current === accessController) accessRef.current = null; };
  }, []);
  useEffect(() => { setToken(''); if (open) void controllerRef.current?.check(); }, [open]);
  // Gitea 匿名更新不读取 GitHub 凭据；仅展开备用授权设置时查询本机授权状态。
  useEffect(() => { if (open && accessOpen) void accessRef.current?.refresh(); }, [open, accessOpen]);
  useEffect(() => { if (/访问受限|授权|权限|private|unauthorized|forbidden|401|403/i.test(state.error)) setAccessOpen(true); }, [state.error]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (!window.workbenchUpdatePending && previous?.isConnected) previous.focus(); };
  }, [open]);
  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing';
  const installing = state.phase === 'installing';
  function close() { if (installing) return; controllerRef.current?.cancelUpdate(); setToken(''); onClose(); }
  async function saveAccess() {
    // 输入立即清空，令牌只随本次原生调用传递。
    let secret = token;
    setToken('');
    const request = accessRef.current?.save(secret);
    secret = '';
    if (await request) await controllerRef.current?.check();
  }
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !installing) { controllerRef.current?.cancelUpdate(); setToken(''); onClose(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, installing, onClose]);
  if (!open) return null;
  const progress = state.progress;
  const percent = progress?.total ? Math.min(100, Math.floor(progress.received / progress.total * 100)) : null;
  const bytes = (value: number) => (value / 1024 / 1024).toFixed(1) + ' MB';
  return <div className="update-overlay">
    <section ref={dialogRef} className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-busy={busy} tabIndex={-1} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')].filter(node => node.getClientRects().length);
      if (!buttons.length) { event.preventDefault(); return; }
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="update-heading"><div><p className="eyebrow">桌面程序</p><h2 id="update-title">检查更新</h2></div><button className="text-button" onClick={close} disabled={installing} aria-label="关闭更新窗口">关闭</button></div>
      <dl className="update-versions"><div><dt>当前版本</dt><dd>{state.release?.currentVersion ?? (currentVersion || '等待检查')}</dd></div><div><dt>可用版本</dt><dd>{state.downloaded?.version ?? state.release?.version ?? '—'}</dd></div><div><dt>更新来源</dt><dd>{state.downloaded?.source ?? state.release?.source ?? 'Gitea 优先 · GitHub 备用'}</dd></div></dl>
      <p className="storage-note">优先从 Gitea 获取更新，无需填写令牌；暂时无法访问时尝试 GitHub 备用源。</p>
      <p className="update-message" role="status">{state.phase === 'checking' ? '正在查询兼容的桌面程序版本…' : state.phase === 'downloading' ? state.restartAfterDownload ? '正在下载并校验，完成后保存修改并重启。关闭此窗口可继续编辑，并暂停自动重启。' : '正在下载并校验，可关闭此窗口继续编辑；完成后等待手动重启更新。' : installing ? '正在保存修改并准备重启，请稍候…' : state.phase === 'downloaded' ? '更新包已下载并校验，点击下方按钮保存修改并重启。' : state.release?.message ?? '准备检查更新。'}</p>
      {state.phase === 'downloading' && <div className="update-progress"><progress max="100" {...(percent === null ? {} : { value: percent })} aria-label="更新包下载进度" /><span>{progress ? bytes(progress.received) + (progress.total ? ' / ' + bytes(progress.total) : '') : '等待下载进度'}{percent === null ? '' : ` · ${percent}%`}</span></div>}
      {state.release?.notes && <div className="update-notes"><h3>更新说明</h3><p>{state.release.notes}</p></div>}
      {(state.error || eventError) && <p className="notice error" role="alert">{state.error || eventError}</p>}
      <details className="update-access" open={accessOpen} onToggle={event => setAccessOpen(event.currentTarget.open)}>
        <summary>GitHub 备用源授权（可选）</summary>
        <p>{access.status?.source === 'gh' ? '备用源已复用本机 GitHub 登录。' : access.status?.configured ? '已保存 GitHub 备用源授权。' : '仅当 GitHub 备用仓库需要授权时，复用本机 GitHub 登录或填写令牌。'}</p>
        <p className="storage-note">令牌仅用于 GitHub 备用仓库的内容读取，保存在本机，不影响 Gitea 更新。</p>
        <label htmlFor="updater-token">GitHub 令牌（可选）</label>
        <input id="updater-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} disabled={busy || access.busy} />
        <div className="update-actions"><button className="secondary" disabled={busy || access.busy || access.status?.source !== 'credential'} onClick={async () => { setToken(''); if (await accessRef.current?.clear()) await controllerRef.current?.check(); }}>清除本机令牌</button><button disabled={busy || access.busy || !token.trim()} onClick={() => void saveAccess()}>保存授权并检查</button></div>
        {access.error && <p className="notice error" role="alert">{access.error}</p>}
      </details>
      <div className="update-actions"><button className="secondary" disabled={busy || access.busy || Boolean(state.downloaded)} onClick={() => void controllerRef.current?.check()}>重新检查</button><button disabled={busy || access.busy || dirty || (!state.downloaded && (!state.release?.available || !state.release.canInstall))} onClick={() => void controllerRef.current?.update()}>{state.downloaded ? '保存并重启更新' : '一键更新并重启'}</button></div>
      {dirty && <p className="storage-note">当前页面的修改需要先保存或放弃，再重启更新。</p>}
    </section>
  </div>;
}
