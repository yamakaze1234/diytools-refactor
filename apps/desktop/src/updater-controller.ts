/** 更新控制器：组织版本检查、包准备和安装请求，保证异步回执不会越过关闭或取消边界。 */
export interface UpdateCheck {
  currentVersion: string;
  available: boolean;
  version?: string;
  notes?: string;
  source?: string;
  canInstall: boolean;
  message: string;
}
export interface DownloadedUpdate { version: string; source: string }
export interface UpdateProgress { phase: 'downloading'; received: number; total?: number | null }
export interface UpdateWorkbench {
  workbenchBeforeQuit?: () => Promise<void>;
  workbenchHasPendingChanges?: () => boolean;
}
export type UpdatePhase = 'idle' | 'checking' | 'ready' | 'downloading' | 'downloaded' | 'installing';
export interface UpdateState {
  phase: UpdatePhase;
  release: UpdateCheck | null;
  downloaded: DownloadedUpdate | null;
  progress: UpdateProgress | null;
  error: string;
  restartAfterDownload: boolean;
}
export interface UpdaterOptions {
  check(): Promise<UpdateCheck>;
  download(): Promise<DownloadedUpdate>;
  install(): Promise<unknown>;
  getWorkbench(): UpdateWorkbench | null;
  hasUnsavableChanges(): boolean;
  acquireInstall(): boolean;
  releaseInstall(): void;
  freeze(frozen: boolean): void;
  onState(state: UpdateState): void;
}

// Tauri gives each close listener its own preventDefault flag. While a workbench
// exists, only its save controller may authorize destruction, including reentry.
/** 判断更新期间是否需要阻止原生窗口关闭。 */
export function shouldPreventUpdaterClose(workbenchMounted: boolean, updatePending: boolean) {
  return workbenchMounted || updatePending;
}

/** Native code owns release URLs and staged files. This controller owns save/close ordering. */
/** 维护单个更新流程的状态，通过注入接口执行原生更新操作。 */
export function createUpdaterController(options: UpdaterOptions) {
  let disposed = false, generation = 0, ownsInstall = false;
  let updateGeneration = 0, updateFlight: Promise<void> | null = null;
  let state: UpdateState = { phase: 'idle', release: null, downloaded: null, progress: null, error: '', restartAfterDownload: false };
  const emit = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    if (!disposed) options.onState(state);
  };
  const failed = (error: unknown) => error instanceof Error ? error.message : String(error);
  const unlock = () => {
    if (!ownsInstall) return;
    ownsInstall = false;
    options.releaseInstall();
    options.freeze(false);
  };
  const controller = {
    get state() { return state; },
    async check() {
      if (disposed || ['checking', 'downloading', 'installing'].includes(state.phase) || state.downloaded) return;
      const operation = ++generation;
      emit({ phase: 'checking', error: '', release: null, progress: null });
      try {
        const release = await options.check();
        if (!disposed && operation === generation) emit({ phase: 'ready', release });
      } catch (error) {
        if (!disposed && operation === generation) emit({ phase: 'ready', error: failed(error) });
      }
    },
    async download() {
      if (disposed || state.phase !== 'ready' || !state.release?.available || !state.release.canInstall) return;
      const operation = ++generation;
      emit({ phase: 'downloading', error: '', downloaded: null, progress: null });
      try {
        const downloaded = await options.download();
        if (!disposed && operation === generation) emit({ phase: 'downloaded', downloaded, progress: null });
      } catch (error) {
        if (!disposed && operation === generation) emit({ phase: 'ready', downloaded: null, progress: null, error: failed(error) });
      }
    },
    progress(progress: UpdateProgress) {
      if (disposed || state.phase !== 'downloading' || progress.phase !== 'downloading') return;
      if (!Number.isFinite(progress.received) || progress.received < 0) return;
      emit({ progress: { ...progress, total: progress.total && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null } });
    },
    async install() {
      if (disposed || state.phase !== 'downloaded' || !state.downloaded) return;
      if (options.hasUnsavableChanges()) { emit({ error: '当前页面有未保存的修改，请先保存或放弃修改，再安装更新。' }); return; }
      if (!options.acquireInstall()) { emit({ error: '当前正在退出或安装更新，请等待操作结束。' }); return; }
      ownsInstall = true;
      emit({ phase: 'installing', error: '' });
      let installationStarted = false;
      try {
        // The adapter blurs active fields before making both documents inert.
        options.freeze(true);
        const workbench = options.getWorkbench();
        if (workbench) {
          if (!workbench.workbenchBeforeQuit || !workbench.workbenchHasPendingChanges) throw Error('工作台尚未就绪，请等待载入完成后重新更新。');
          await workbench.workbenchBeforeQuit();
          if (disposed) { unlock(); return; }
          if (options.getWorkbench() !== workbench) throw Error('工作台页面已变化，请重新更新。');
          if (workbench.workbenchHasPendingChanges()) throw Error('修改尚未正常保存。恢复草稿不能替代保存，请完成保存后重新更新。');
        }
        if (disposed) { unlock(); return; }
        if (options.hasUnsavableChanges()) throw Error('当前页面仍有未保存的修改，请先保存后重新更新。');
        installationStarted = true;
        await options.install();
        // Success hands control to the helper and native exit. Keep the guard until destruction.
      } catch (error) {
        unlock();
        if (!disposed) emit(installationStarted
          ? { phase: 'ready', downloaded: null, error: failed(error) + ' 请重新下载后重试。' }
          : { phase: 'downloaded', error: failed(error) });
      }
    },
    /** 一次点击完成下载、校验与保存安装；关闭下载弹窗只取消自动重启意图。 */
    update(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (updateFlight) return updateFlight;
      const operation = ++updateGeneration;
      emit({ restartAfterDownload: true });
      const job = (async () => {
        if (state.phase === 'ready') await controller.download();
        if (!disposed && operation === updateGeneration && state.phase === 'downloaded') await controller.install();
      })().finally(() => { if (updateFlight === job) { updateFlight = null; emit({ restartAfterDownload: false }); } });
      updateFlight = job;
      return job;
    },
    cancelUpdate() { updateGeneration++; emit({ restartAfterDownload: false }); },
    dispose() {
      disposed = true;
      generation++;
      updateGeneration++;
      // A save awaiting completion must not install into a replacement page.
      unlock();
    },
  };
  return controller;
}
