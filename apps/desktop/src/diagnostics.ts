import appPackage from '../package.json' with { type: 'json' };
/** 诊断只保留白名单元信息；任何请求正文、账号、路径及原始错误都不会进入记录。 */
export type DiagnosticPhase = 'running' | 'ok' | 'error';
const stages = new Set(['startup-status','login','logout','first-use','connect','legacy-read','legacy-project','legacy-apply','cloud-load','cloud-commit','cloud-call','cloud-checkpoint','cloud-pull','cloud-push','assets-download','assets-upload','assets-cancel','plan-preview','plan-apply','local-request','local-save','local-save-wait','diagnostic-export','sql-request','unknown']);
const actions: Record<string, string> = { status:'startup-status',login:'login',logout:'logout',resume:'login',firstUseStatus:'first-use',connect:'connect',migrateLegacy:'legacy-read',migrateLegacyApply:'legacy-apply',load:'cloud-load',commit:'cloud-commit',call:'cloud-call',assetsDownload:'assets-download',assetsEnsure:'assets-upload',assetsCancel:'assets-cancel',planPreview:'plan-preview',planApply:'plan-apply' };
interface Entry { sequence: number; stage: string; phase: DiagnosticPhase; code: string; httpStatus?: number; startedAt: string; elapsedMs: number }
/** 不保存原文，仅将有限错误文本归类；未知内容统一为 OPERATION_FAILED。 */
export function diagnosticCode(error: unknown): string {
  // 工作台 iframe 的 DOMException 属于另一个 realm，不能仅依赖 instanceof Error。
  if (error && typeof error === 'object' && 'name' in error) {
    if (error.name === 'TimeoutError') return 'TIMEOUT';
    if (error.name === 'AbortError') return 'CANCELLED';
  }
  const text = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').slice(0, 4096);
  if (/timeout|timed out|超时/i.test(text)) return 'TIMEOUT';
  if (/cancel|abort|取消/i.test(text)) return 'CANCELLED';
  if (/too large|超过.*(?:MiB|MB|限制)|文件过大/i.test(text)) return 'SIZE_LIMIT';
  if (/SQLITE_BUSY|database is locked|数据库.*锁/i.test(text)) return 'DATABASE_BUSY';
  if (/SQLITE_CORRUPT|malformed|损坏/i.test(text)) return 'DATABASE_INVALID';
  if (/permission|access denied|权限|拒绝访问/i.test(text)) return 'ACCESS_DENIED';
  if (/unauthoriz|认证|登录|密码|令牌/i.test(text)) return 'AUTH_REQUIRED';
  if (/network|fetch|连接|网络/i.test(text)) return 'NETWORK_FAILED';
  if (/json|格式|解析|核对|字段/i.test(text)) return 'FORMAT_INVALID';
  return 'OPERATION_FAILED';
}
export function cloudDiagnosticStage(action: string, payloadJson = ''): string {
  // 只匹配固定动作名，不解析大型业务正文，更不会记录请求标识和内容。
  if (action === 'call') {
    const head = payloadJson.slice(0, 512);
    if (/"action"\s*:\s*"sync\.pull"/.test(head)) return 'cloud-pull';
    if (/"action"\s*:\s*"sync\.push(?:Batch)?"/.test(head)) return 'cloud-push';
    if (/"action"\s*:\s*"sync\.snapshot"/.test(head)) return 'cloud-checkpoint';
  }
  return Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : 'unknown';
}
export function createDiagnosticLog(limit = 200) {
  const entries: Entry[] = [];
  const clocks = new WeakMap<Entry, number>();
  let sequence = 0;
  const capacity = Math.min(200, Math.max(1, Math.floor(limit) || 200));
  return {
    begin(stage: string) {
      const entry: Entry = { sequence: ++sequence, stage: stages.has(stage) ? stage : 'unknown', phase: 'running', code: 'PENDING', startedAt: new Date().toISOString(), elapsedMs: 0 };
      clocks.set(entry, performance.now()); entries.push(entry);
      if (entries.length > capacity) entries.splice(entries.findIndex(item => item.phase !== 'running') < 0 ? 0 : entries.findIndex(item => item.phase !== 'running'), 1);
      let finished = false;
      return (error?: unknown, status?: number) => {
        if (finished) return; finished = true;
        const validStatus = Number.isInteger(status) && status! >= 200 && status! <= 599 ? status : undefined;
        entry.phase = error !== undefined || (validStatus !== undefined && validStatus >= 300) ? 'error' : 'ok';
        entry.code = entry.phase === 'ok' ? 'OK' : error !== undefined ? diagnosticCode(error) : `HTTP_${validStatus}`;
        if (validStatus !== undefined) entry.httpStatus = validStatus;
        entry.elapsedMs = Math.max(0, Math.round(performance.now() - clocks.get(entry)!));
      };
    },
    snapshot(version: string) {
      return { schema: 1, app: 'DIYTools', version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : 'unknown', exportedAt: new Date().toISOString(), scope: 'current-session', privacy: 'metadata-only', dropped: sequence - entries.length,
        events: entries.map(entry => ({ ...entry, elapsedMs: entry.phase === 'running' ? Math.max(0, Math.round(performance.now() - clocks.get(entry)!)) : entry.elapsedMs })) };
    },
  };
}
export const diagnostics = createDiagnosticLog();
/** 调用成功和异常均原样交还业务；诊断旁路不改变登录、同步与重试语义。 */
export async function trackDiagnostic<T extends { status: number; body: string }>(stage: string, task: () => Promise<T>): Promise<T> {
  const finish = diagnostics.begin(stage);
  try {
    const result = await task();
    let safeError: unknown;
    // 仅错误响应且有界时用于分类，原文不会离开此调用。
    if (result?.status >= 300 && typeof result.body === 'string' && result.body.length <= 16384) {
      try { safeError = JSON.parse(result.body)?.error; } catch { safeError = 'JSON'; }
    }
    finish(safeError, result?.status);
    return result;
  } catch (error) { finish(error); throw error; }
}
/** 复用现有原生文件夹导出，只有文件列表确认落盘才显示成功；取消不当作完成。 */
export function diagnosticText(version = appPackage.version): string {
  return JSON.stringify(diagnostics.snapshot(version), null, 2);
}
type DiagnosticInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
const pendingExports = new WeakMap<DiagnosticInvoke, Promise<'saved' | 'cancelled'>>();
// 超时只停止界面等待，原生文件对话框可能仍在运行；保留任务以免重试重复弹窗/写文件。
export async function exportDiagnostics(invoke: DiagnosticInvoke, version = appPackage.version) {
  let pending = pendingExports.get(invoke);
  if (!pending) {
    const finish = diagnostics.begin('diagnostic-export');
    pending = saveDiagnosticFile(invoke, version).then(result => { finish(); return result; }, error => { finish(error); throw error; });
    pendingExports.set(invoke, pending);
    const clear = () => { pendingExports.delete(invoke); };
    void pending.then(clear, clear);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('原生导出超时，结果尚未确认。请查看诊断文本；若已有目录选择窗口，请先处理该窗口。')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}
async function saveDiagnosticFile(invoke: DiagnosticInvoke, version: string): Promise<'saved' | 'cancelled'> {
  const text = diagnosticText(version);
  const bytes = new TextEncoder().encode(text);
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const result = await invoke('workbench_export_folder', { payload: { name: 'DIYTools-诊断-' + new Date().toISOString().replace(/[:.]/g, '-'), files: [{ name: 'diagnostics.json', base64 }] } }) as { ok?: boolean; cancelled?: boolean; files?: string[] };
  if (result?.cancelled) return 'cancelled';
  if (result?.ok !== true || !result.files?.includes('diagnostics.json')) throw Error('诊断文件未确认保存，请重试。');
  return 'saved';
}
