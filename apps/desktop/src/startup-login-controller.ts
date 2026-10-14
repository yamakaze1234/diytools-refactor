/** 启动登录状态机：鉴权和本机接入准备完成后才允许挂载工作台，避免未绑定时写入业务状态。 */
export interface CloudMember { uid: string; workspaceId: string; name?: string }
export interface CloudSession { authenticated: boolean; member: CloudMember | null }
export interface CloudApiResponse { status: number; body: string }
export type CloudInvoke = (command: string, args: { action: string; payloadJson: string }) => Promise<CloudApiResponse>;
export interface StartupLoginState {
  phase: 'checking' | 'signed-out' | 'preparing' | 'ready';
  session: CloudSession;
  busy: boolean;
  error: string;
  message: string;
  localOnly: boolean;
}
const emptySession = (): CloudSession => ({ authenticated: false, member: null });
/** 桌面环境先检查已保存会话；网页预览从未登录状态开始。 */
export const initialStartupLoginState = (desktop: boolean): StartupLoginState => ({
  phase: desktop ? 'checking' : 'signed-out', session: emptySession(), busy: desktop, error: '', message: desktop ? '正在检查登录状态…' : '', localOnly: false,
});
function message(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '连接未完成，请重试。'; }

/** 校验原生桥接回执状态码和 JSON 形状，再把业务错误交给登录页。 */
export async function requestStartupCloud(invoke: CloudInvoke, action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await invoke('cloud_native_json_request', { action, payloadJson: JSON.stringify(payload) });
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599 || typeof response.body !== 'string') throw Error('登录返回格式无效，请重试。');
  let value: Record<string, unknown>;
  try { value = JSON.parse(response.body); } catch { throw Error('登录返回格式无效，请重试。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('登录返回格式无效，请重试。');
  if (response.status >= 300) throw Error(typeof value.error === 'string' ? value.error : '连接未完成，请重试。');
  return value;
}
function sessionOf(value: Record<string, unknown>, status = false): CloudSession {
  const raw = (status ? value.session : value) as CloudSession | undefined;
  if (!raw || typeof raw.authenticated !== 'boolean') throw Error('登录状态无效，请重试。');
  if (raw.authenticated && (typeof raw.member?.uid !== 'string' || !raw.member.uid || typeof raw.member.workspaceId !== 'string' || !raw.member.workspaceId)) throw Error('成员信息未确认，请重新登录。');
  return raw.authenticated ? { authenticated: true, member: { uid: raw.member!.uid, workspaceId: raw.member!.workspaceId, name: typeof raw.member!.name === 'string' ? raw.member!.name : undefined } } : emptySession();
}

/** Authenticate and connect before the legacy editor can normalize/save its initial state. */
/** 复用正在进行的登录或准备任务，卸载后不再发布旧回执。 */
export function createStartupLoginController({ desktop, invoke, onState }: { desktop: boolean; invoke: CloudInvoke; onState: (state: StartupLoginState) => void }) {
  let state = initialStartupLoginState(desktop), flight: Promise<void> | null = null, disposed = false;
  const emit = (patch: Partial<StartupLoginState>) => { if (!disposed) { state = { ...state, ...patch }; onState(state); } };
  /** 在工作台 iframe 启动前幂等准备本机同步资料。 */
  async function prepare() {
    if (disposed || !state.session.authenticated) return;
    emit({ phase: 'preparing', message: '正在准备工作台…' });
    // Idempotent native preparation preserves the saved-data guard before iframe boot.
    await requestStartupCloud(invoke, 'connect');
    emit({ phase: 'ready', message: '', error: '' });
  }
  function perform(task: () => Promise<void>) {
    if (!desktop || disposed) return Promise.resolve();
    if (flight) return flight;
    emit({ busy: true, error: '' });
    flight = (async () => {
      try { await task(); }
      catch (error) { emit({ phase: state.session.authenticated ? 'preparing' : 'signed-out', message: '', error: message(error) }); }
      finally { flight = null; emit({ busy: false }); }
    })();
    return flight;
  }
  function initialize() { return perform(async () => {
    emit({ phase: 'checking', message: '正在检查登录状态…' });
    const result = await requestStartupCloud(invoke, 'status');
    // 没有本机云服务配置时直接进入本地工作台；连接失败仍保留登录重试流程。
    if (result.configured === false || (result.session as { configured?: boolean } | undefined)?.configured === false) {
      emit({ session: emptySession(), localOnly: true, phase: 'ready', message: '' });
      return;
    }
    const session = sessionOf(result, true);
    emit({ session, localOnly: false, phase: session.authenticated ? 'preparing' : 'signed-out', message: '' });
    if (session.authenticated) await prepare();
  }); }
  function login(username: string, password: string) { return perform(async () => {
    if (!username.trim() || !password) throw Error('请输入账号和密码。');
    emit({ message: '正在登录…' });
    let result: Record<string, unknown>;
    try { result = await requestStartupCloud(invoke, 'login', { username: username.trim(), password }); }
    finally { password = ''; }
    const session = sessionOf(result);
    if (!session.authenticated) throw Error('登录未完成，请检查账号和密码后重试。');
    emit({ session });
    await prepare();
  }); }
  function retry() { return state.session.authenticated ? perform(prepare) : initialize(); }
  function logout() { return perform(async () => {
    await requestStartupCloud(invoke, 'logout');
    emit({ phase: 'signed-out', session: emptySession(), message: '', error: '' });
  }); }
  return { initialize, login, retry, logout,
    signedOut: () => emit({ phase: 'signed-out', session: emptySession(), busy: false, message: '', error: '' }),
    dispose: () => { disposed = true; }, status: () => state };
}

/** 同时核对消息来源窗口、同源地址和类型，只接受当前工作台的退出登录通知。 */
export function trustedWorkbenchSignOut(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, frame: Window | null | undefined, origin: string) {
  return Boolean(frame && event.source === frame && event.origin === origin && event.data?.type === 'workbench-signed-out');
}
