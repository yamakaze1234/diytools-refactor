/** 原生退出保护：首次关闭先等待工作台保存，仅在保存确认后放行一次重入关闭事件。 */
export interface CloseRequest { preventDefault(): void }
export interface SaveBeforeClose { workbenchBeforeQuit?: () => Promise<void> }
export interface CloseControllerOptions {
  getWorkbench(): SaveBeforeClose | null;
  closeWindow(): Promise<void>;
  onPending(pending: boolean): void;
  onError(message: string): void;
}

/** The first close saves; a single reentered close is allowed only after that save confirms. */
/** 保存失败保留窗口和输入；页面被替换或控制器卸载后不能关闭新的工作台。 */
export function createWorkbenchCloseController(options: CloseControllerOptions) {
  let disposed = false, pending = false, allowNextClose = false;
  /** 失败路径解除等待状态，让用户修正问题后再次关闭。 */
  function finish() { pending = false; options.onPending(false); }
  return {
    get pending() { return pending; },
    async handle(event: CloseRequest): Promise<void> {
      if (disposed) { event.preventDefault(); return; }
      if (allowNextClose) {
        allowNextClose = false;
        // Keep editing/navigation locked until Tauri destroys the window.
        return; // Tauri's onCloseRequested wrapper now destroys the window.
      }
      event.preventDefault();
      if (pending) return;
      pending = true;
      options.onPending(true);
      const workbench = options.getWorkbench();
      try {
        await workbench?.workbenchBeforeQuit?.();
        if (disposed) return;
        if (options.getWorkbench() !== workbench) throw Error('工作台页面已变化，请重新关闭窗口。');
        allowNextClose = true;
        await options.closeWindow();
        // Keep the guard until the native close event reenters, even if close IPC returns first.
      } catch (error) {
        allowNextClose = false;
        if (!disposed) {
          options.onError(error instanceof Error ? error.message : String(error));
          finish();
        }
      }
    },
    dispose() {
      disposed = true;
      allowNextClose = false;
      // A detached controller must never close whichever page replaced its iframe.
    },
  };
}
