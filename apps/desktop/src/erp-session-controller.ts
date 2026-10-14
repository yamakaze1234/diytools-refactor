/** ERP 会话控制器：管理环境检查、登录和只读商品查询，忽略已失效异步回执。 */
export interface ErpSession { connected: boolean; user: string | null; domain: string | null; package_version: string }
export interface ErpGoodsRow {
  goods_id: string | number | null;
  quantity: string | number | null;
  code: string;
  name: string;
  type: string;
  category: string;
  brand: string;
  series: string;
  model: string;
  spec: string;
  is_gift: boolean;
}
export interface ErpGoodsResult { sku: string; rows: ErpGoodsRow[]; queried_at: string }
export type ErpRequest =
  | { action: 'status' | 'disconnect' }
  | { action: 'connect'; username?: string; password?: string; cookie?: string }
  | { action: 'query_goods'; sku: string };
export interface ErpSessionState {
  busy: ErpRequest['action'] | null;
  session: ErpSession | null;
  result: ErpGoodsResult | null;
  error: string;
  sku: string;
}
/** 创建未连接的 ERP 页面状态。 */
export const initialErpSessionState = (): ErpSessionState => ({ busy: null, session: null, result: null, error: '', sku: '' });

// Credentials go directly to IPC, never into state, persistence, or diagnostics.
/** 通过注入的请求接口驱动会话，方便界面与原生 I/O 分离。 */
export function createErpSessionController(options: {
  desktop: boolean;
  request(input: ErpRequest): Promise<ErpSession | ErpGoodsResult>;
  onState(state: ErpSessionState): void;
}) {
  let state = initialErpSessionState();
  let disposed = false, generation = 0, skuGeneration = 0;
  function emit(patch: Partial<ErpSessionState>) {
    state = { ...state, ...patch };
    if (!disposed) options.onState(state);
  }
  async function run(input: ErpRequest) {
    if (disposed || state.busy || !options.desktop) return;
    const operation = ++generation, skuRevision = skuGeneration;
    emit({ busy: input.action, error: '', result: null,
      ...(input.action !== 'query_goods' ? { session: null } : {}) });
    try {
      const result = await options.request(input);
      if (disposed || operation !== generation) return;
      if (input.action === 'query_goods') {
        if (skuRevision !== skuGeneration) return;
        if (!('rows' in result) || result.sku !== input.sku) throw Error('查询结果与当前 SKU 不一致，请重新查询。');
        emit({ result });
      } else {
        if (!('connected' in result)) throw Error('ERP 连接状态返回异常，请重新检查。');
        emit({ session: result });
      }
    } catch (reason) {
      if (!disposed && operation === generation) {
        const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
        const sensitive = input.action === 'connect' && [input.password, input.cookie].some(value => value && message.includes(value));
        // 已知能力错误只映射固定文案，不显示可能包含服务器或私有依赖的底层原文。
        const unavailable = message.startsWith('ERP_RUNTIME_UNAVAILABLE:') ? '本机未安装 ERP 可选运行时，请完成本机接入配置。'
          : message.startsWith('ERP_NOT_CONFIGURED:') ? '本机尚未配置 ERP 服务。' : '';
        const safeMessage = unavailable || (!sensitive && /^[\u4e00-\u9fff]/.test(message) && !/https?:\/\/|Traceback|cookie\s*[=:]|password\s*[=:]/i.test(message)
          ? message : 'ERP 操作失败，请检查本机环境与连接后重试。');
        emit({ error: input.action === 'query_goods' && skuRevision !== skuGeneration ? '' : safeMessage, result: null, session: null });
      }
    } finally {
      if (!disposed && operation === generation) emit({ busy: null });
    }
  }
  return {
    get state() { return state; },
    status() { return run({ action: 'status' }); },
    connect(credentials: { username: string; password: string } | { cookie: string }) {
      if (disposed || state.busy || !options.desktop) return Promise.resolve();
      if ('cookie' in credentials ? !credentials.cookie.trim() : !credentials.username.trim() || !credentials.password) {
        emit({ error: '请填写完整的登录信息。', result: null });
        return Promise.resolve();
      }
      // 服务地址由原生 worker 的本机配置绑定，页面只提交会话凭据。
      return run({ action: 'connect', ...credentials });
    },
    disconnect() { return run({ action: 'disconnect' }); },
    setSku(sku: string) {
      if (disposed || state.sku === sku) return;
      skuGeneration++;
      emit({ sku, result: null, error: '' });
    },
    query() {
      if (disposed || state.busy || !options.desktop) return Promise.resolve();
      const sku = state.sku.trim();
      if (!sku) { emit({ result: null, error: '请输入商品 SKU。' }); return Promise.resolve(); }
      if (!state.session?.connected) { emit({ result: null, error: '请先连接 ERP，再查询商品。' }); return Promise.resolve(); }
      return run({ action: 'query_goods', sku });
    },
    dispose() { disposed = true; generation++; },
  };
}
