/** 私有更新授权：凭据仅交给原生层，状态和错误中不保留令牌。 */
export interface UpdaterAccessStatus { configured: boolean; source: 'credential' | 'gh' | 'none' }
export interface UpdaterAccessState { status: UpdaterAccessStatus | null; busy: boolean; error: string }
export interface UpdaterAccessOptions {
  invoke(command: string, args?: { token: string }): Promise<UpdaterAccessStatus>;
  onState(state: UpdaterAccessState): void;
}
/** 串行更新本机授权，避免迟到的状态查询覆盖保存结果。 */
export function createUpdaterAccessController(options: UpdaterAccessOptions) {
  let disposed = false, flight: Promise<boolean> | null = null;
  let state: UpdaterAccessState = { status: null, busy: false, error: '' };
  const emit = (patch: Partial<UpdaterAccessState>) => { if (!disposed) { state = { ...state, ...patch }; options.onState(state); } };
  function perform(command: string, token?: string): Promise<boolean> {
    if (disposed || flight) return Promise.resolve(false);
    emit({ busy: true, error: '' });
    const job = Promise.resolve().then(async () => {
      try {
        const request = options.invoke(command, token === undefined ? undefined : { token });
        token = '';
        const status = await request;
        if (!status || typeof status.configured !== 'boolean' || !['credential', 'gh', 'none'].includes(status.source)) throw Error();
        if (disposed) return false;
        emit({ status: { configured: status.configured, source: status.source } });
        return true;
      } catch {
        // 原生错误可能带有请求上下文，界面只显示固定文案。
        emit({ error: command === 'updater_access_status' ? '无法读取本机更新授权，请重试。' : '更新授权操作未完成，请检查令牌后重试。' });
        return false;
      } finally { token = ''; flight = null; emit({ busy: false }); }
    });
    flight = job;
    return job;
  }
  return {
    refresh: () => perform('updater_access_status'),
    save: (token: string) => token.trim() ? perform('updater_access_save', token.trim()) : Promise.resolve(false),
    clear: () => perform('updater_access_clear'),
    dispose: () => { disposed = true; },
    status: () => state,
  };
}
