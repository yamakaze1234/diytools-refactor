import { diagnostics, exportDiagnostics, trackDiagnostic, cloudDiagnosticStage } from '../diagnostics.ts';
/** 旧页面本机桥接：将受支持的 fetch 路由映射到 Tauri IPC，素材 URL 仅在渲染时转换。 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/** Adapter for the legacy renderer. Business state stays in the Rust local store. */
export type WorkbenchInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface WorkbenchResponse { status: number; body: string }
export interface WorkbenchAsset { mime: string; base64: string }
export interface WorkbenchFolderPayload { name: string; files: Array<{ name: string; base64: string }> }
export interface WorkbenchBridgeOptions {
  /** Explicit dependency injection for tests. Never supplies an implicit success fixture. */
  invoke?: WorkbenchInvoke;
  native?: boolean;
  assetOrigin?: string;
}
export type WorkbenchWindow = Window & {
  workbenchExportDiagnostics?: () => Promise<string>;
  workbenchRecordDiagnostic?: (stage: string, error?: unknown) => void;
  resolveWorkbenchAsset?: (url: string) => string;
  pywebview?: { api?: { export_image_folder?: (payload: WorkbenchFolderPayload) => Promise<unknown> } };
};

/** Inventory of the old UI's local contracts; unknown /api routes still reach the backend. */
export const LOCAL_WORKBENCH_ROUTES = [
  '/api/state', '/api/configs/batch', '/api/session', '/api/catalog', '/api/recovery-draft',
  '/api/workspace/index', '/api/configs/load', '/api/configs/patch', '/api/activity',
  '/api/derived/status', '/api/derived/wait', '/api/image', '/api/asset',
  '/api/products/standard', '/api/versions', '/api/versions/status',
  '/api/versions/name', '/api/versions/preview', '/api/versions/restore',
  '/api/versions/delete-named', '/api/versions/cleanup', '/api/cache/preview',
  '/api/cache/clear', '/api/cache/maintain', '/api/profit/start', '/api/profit/history', '/api/profit/status',
  '/api/profit/reset', '/api/profit/publish', '/api/workspace-sync/local-history',
  '/api/legacy-history/status', '/api/legacy-history/versions', '/api/legacy-history/preview',
  '/api/legacy-history/restore', '/api/legacy-history/profit',
] as const;

const installations = new WeakMap<object, Promise<void>>();
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const CLOUD_ACTIONS = new Set(['login', 'logout', 'resume', 'status', 'connect', 'load', 'commit', 'call', 'assetsEnsure', 'assetsDownload', 'assetsCancel', 'planPreview', 'planApply']);

/** Only the company SQL read/preview/confirmed-apply contract is enabled. */
/** 只放行已实现的公司 SQL 只读查询、预览和确认应用路由。 */
export function isSqlSyncRoute(path: string, method: string): boolean {
  return (method === 'GET' && ['/api/sql-sync/credentials', '/api/erp-sync/status'].includes(path)) ||
    (method === 'POST' && ['/api/sql-sync/credentials/clear', '/api/sql-sync/preview', '/api/sql-sync/apply'].includes(path));
}

function errorResponse(message: string, status = 503): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

/** Online operations remain visible failures, so no login or live ERP result is fabricated. */
/** 对尚未接通的旧接口返回明确错误，不伪造登录或业务成功结果。 */
export function unavailableWorkbenchOperation(path: string, method: string): string | null {
  if (isSqlSyncRoute(path, method)) return null;
  if (path.startsWith('/api/cloud-sync/') ||
      (path.startsWith('/api/workspace-sync/') && path !== '/api/workspace-sync/local-history')) {
    return '当前为本机工作台，云端登录与同步尚未接通；本机修改可以继续保存。';
  }
  if (path.startsWith('/api/erp-sync/') || path.startsWith('/api/erp-bridge/') || path.startsWith('/api/sql-sync/')) {
    return '当前版本尚未接通 ERP 或公司数据库；保留原有成本和库存，不会生成同步结果。';
  }
  if (path.startsWith('/api/product-sync/')) {
    return 'ERP 商品查询尚未接通；可使用标准 JSON 预览导入或导出当前链接。';
  }
  if (path === '/api/profit/publish' && method !== 'GET') {
    return '发布到后台监控的目录接口尚未接通，未写入外部目录。';
  }
  return null;
}

function assetPath(path: string): boolean {
  return path.startsWith('/uploads/') || path.startsWith('/saved/');
}

/** Resolve only renderer URLs, never mutate persisted caseImage/posterImages state. */
/** 解析绘图所需的本机素材地址，持久化字段仍保留原始路径。 */
export function resolveWorkbenchAsset(url: string, origin?: string): string {
  if (url.startsWith('/assets/')) return '/workbench' + url;
  if (assetPath(url) && origin) return origin.replace(/\/$/, '') + url;
  return url;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('请求已取消', 'AbortError');
}

/** 在异步 IPC 与取消信号间竞争，并在结束后移除监听。 */
async function abortable<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let listener: (() => void) | undefined;
  const canceled = new Promise<never>((_, reject) => {
    listener = () => reject(abortError(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([task(), canceled]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return 'url' in input ? input.url : input.href;
}

function nativeAssetOrigin(): string {
  return /Windows|Android/.test(globalThis.navigator?.userAgent ?? '')
    ? 'http://workbench-asset.localhost' : 'workbench-asset://localhost';
}

/** Install before importing app.js. A browser preview uses the explicit Vite local provider. */
/** 每份文档只安装一次；iframe 重载复用 WindowProxy，但新 Document 必须重新桥接。 */
export function installWorkbenchBridge(targetWindow: Window, options: WorkbenchBridgeOptions = {}): Promise<void> {
  const documentKey = targetWindow.document ?? targetWindow;
  const installed = installations.get(documentKey);
  if (installed) return installed;
  const pending = install(targetWindow as WorkbenchWindow, options);
  installations.set(documentKey, pending);
  pending.catch(() => installations.delete(documentKey));
  return pending;
}

/** 按运行环境安装请求与图片解析适配，原有浏览器行为只在明确路由范围内被接管。 */
async function install(targetWindow: WorkbenchWindow, options: WorkbenchBridgeOptions): Promise<void> {
  const native = options.native ?? Boolean(options.invoke || '__TAURI_INTERNALS__' in globalThis);
  const invoke: WorkbenchInvoke | undefined = options.invoke ?? (native ? tauriInvoke : undefined);
  const originalFetch = targetWindow.fetch.bind(targetWindow);
  const origin = native ? options.assetOrigin ?? nativeAssetOrigin() : undefined;
  targetWindow.resolveWorkbenchAsset = url => resolveWorkbenchAsset(url, origin);

  targetWindow.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(inputUrl(input), targetWindow.location.href);
    // Only this frame's local routes are adapted. No unrelated website request becomes a local API call.
    if (url.origin !== targetWindow.location.origin) return originalFetch(input, init);
    let path = url.pathname;
    if (path === '/catalog.json') {
      // 真实配件目录只在本机 data 中读取，发布程序仅内置空目录。
      if (!invoke) return originalFetch(new URL('/workbench/catalog.json' + url.search, url).href, init);
      path = '/api/catalog';
    }
    if (path.startsWith('/assets/')) {
      return originalFetch(new URL('/workbench' + path + url.search, url).href, init);
    }
    if (!path.startsWith('/api/') && !assetPath(path)) return originalFetch(input, init);
    const request = new Request(typeof input === 'object' && 'url' in input ? input : url.href, init);
    const unavailable = unavailableWorkbenchOperation(path, request.method);
    if (request.signal.aborted) throw abortError(request.signal);
    if (unavailable) return errorResponse(unavailable);
    if (isSqlSyncRoute(path, request.method) && url.search) return errorResponse('公司数据库接口不接受 URL 参数', 400);
    const cloud = path.startsWith('/api/native-cloud/');
    const cloudAction = cloud ? path.slice('/api/native-cloud/'.length) : '';
    if (cloud && (!CLOUD_ACTIONS.has(cloudAction) || url.search || request.method !== 'POST')) return errorResponse('云同步接口参数或方法无效', 400);
    if (cloud && !invoke) return errorResponse('请在 Windows 工作台中使用成员登录与云同步');
    if (!invoke) return originalFetch(input, init);
    return abortable(request.signal, async () => {
      if (assetPath(path)) {
        if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('本地素材只支持读取', 405);
        let asset: WorkbenchAsset;
        try { asset = await invoke<WorkbenchAsset>('workbench_read_asset', { path }); }
        catch (error) { return errorResponse(String(error), 404); }
        if (!asset || typeof asset.mime !== 'string' || typeof asset.base64 !== 'string') {
          return errorResponse('本地素材返回格式无效', 502);
        }
        const bytes = Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
        return new Response(request.method === 'HEAD' ? null : bytes, {
          status: 200, headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store' },
        });
      }
      const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
      // Reading a POST body can yield; an abort before native dispatch must not start a save.
      if (request.signal.aborted) throw abortError(request.signal);
      let result: WorkbenchResponse;
      const sql = isSqlSyncRoute(path, request.method);
      // Credentials belong in the body only. SQL routes do not accept query parameters.
      try {
        if (cloud) {
          // Large snapshots are parsed by Rust/worker, never by the UI thread.
          result = await trackDiagnostic(cloudDiagnosticStage(cloudAction, body || ''), () => invoke<WorkbenchResponse>('cloud_native_json_request', { action: cloudAction, payloadJson: body || '{}' }));
        } else result = await trackDiagnostic(sql ? 'sql-request' : 'local-request', () => invoke<WorkbenchResponse>(sql ? 'sql_sync_request' : 'workbench_request', { method: request.method, path: path + url.search, body }));
      }
      catch (error) { return errorResponse(cloud ? '云同步接口调用失败，本机修改已保留' : sql ? '公司数据库接口调用失败，请检查连接后重试' : '本机接口调用失败：' + String(error)); }
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string') {
        return errorResponse('本机接口返回格式无效，未确认保存成功', 502);
      }
      return new Response([204, 205, 304].includes(result.status) ? null : result.body,
        { status: result.status, headers: JSON_HEADERS });
    });
  };

  // Native batch export preserves the old file contract; a failed native command rejects visibly.
  // Browser preview has no pywebview bridge, so the existing browser ZIP download remains active.
  if (invoke) {
    // 导出不排队等待同步锁，卡住时仍能保存当前运行阶段。
    targetWindow.workbenchExportDiagnostics = async () => exportDiagnostics(invoke, await invoke<string>('plugin:app|version').catch(() => 'unknown'));
    targetWindow.workbenchRecordDiagnostic = (stage, error) => { diagnostics.begin(stage)(error); };
    targetWindow.pywebview = { api: { export_image_folder: payload => invoke('workbench_export_folder', { payload }) } };
  }

  // Markup images need the same runtime URL transformation as detached canvas Image objects.
  // The renderer explicitly calls resolveWorkbenchAsset for detached images and download anchors.
  if (targetWindow.document && typeof MutationObserver !== 'undefined') {
    const rewrite = (element: Element) => {
      if (element.tagName !== 'IMG') return;
      const source = element.getAttribute('src');
      if (!source) return;
      const resolved = targetWindow.resolveWorkbenchAsset!(source);
      // Some renderers already resolve src before inserting markup. They still
      // need CORS when their decoded image is later reused by a canvas.
      if (origin && (resolved.startsWith(origin + '/uploads/') || resolved.startsWith(origin + '/saved/')) && element.getAttribute('crossorigin') !== 'anonymous') {
        element.setAttribute('crossorigin', 'anonymous');
      }
      if (resolved !== source) {
        element.setAttribute('src', resolved);
      }
    };
    const scan = (node: Node) => {
      if (node.nodeType !== 1) return;
      rewrite(node as Element);
      (node as Element).querySelectorAll('img[src]').forEach(rewrite);
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') rewrite(record.target as Element);
        else record.addedNodes.forEach(scan);
      }
    });
    scan(targetWindow.document.documentElement);
    observer.observe(targetWindow.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    targetWindow.addEventListener('unload', () => observer.disconnect(), { once: true });
  }
}
