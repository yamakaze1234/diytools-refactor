/** ERP 环境与商品查询页面：展示运行环境状态，提供成员登录和只读 SKU 查询。 */
import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createErpSessionController, initialErpSessionState } from './erp-session-controller';
import type { ErpGoodsResult, ErpSession } from './erp-session-controller';
import './ErpEnvironment.css';

interface EnvironmentReport {
  python: string;
  executable: string;
  platform: string;
  erp_package: { status: 'ready' | 'missing' | 'error'; version: string | null; message: string };
  erp_connected: boolean;
}

/** 订阅 ERP 控制器状态并呈现查询结果，凭据操作交给本机接口。 */
export default function ErpEnvironment() {
  const desktop = isTauri();
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [environmentError, setEnvironmentError] = useState('');
  const [session, setSession] = useState(initialErpSessionState);
  const [mode, setMode] = useState<'password' | 'cookie'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const controller = useRef<ReturnType<typeof createErpSessionController> | null>(null);
  const environmentFlight = useRef(false);
  const lifecycle = useRef(0);
  useEffect(() => {
    const instance = createErpSessionController({ desktop,
      request: input => invoke<ErpSession | ErpGoodsResult>('erp_session_request', { input }),
      onState: setSession });
    controller.current = instance;
    if (desktop) void instance.status();
    const mounted = ++lifecycle.current;
    return () => {
      instance.dispose();
      if (controller.current === instance) controller.current = null;
      if (lifecycle.current === mounted) lifecycle.current++;
    };
  }, [desktop]);
  const busy = environmentBusy || session.busy !== null;
  const connected = session.session?.connected === true;
  async function checkEnvironment() {
    if (!desktop || environmentFlight.current || controller.current?.state.busy) return;
    environmentFlight.current = true;
    const mounted = lifecycle.current;
    setEnvironmentBusy(true); setEnvironmentError(''); setReport(null);
    try {
      const result = await invoke<EnvironmentReport>('check_erp_environment');
      if (lifecycle.current === mounted) setReport(result);
    } catch {
      if (lifecycle.current === mounted) setEnvironmentError('本机环境检查失败，请确认 ERP 接入环境已安装后重试。');
    } finally {
      environmentFlight.current = false;
      if (lifecycle.current === mounted) setEnvironmentBusy(false);
    }
  }
  function connect() {
    if (!desktop || environmentFlight.current || controller.current?.state.busy) return;
    const credentials = mode === 'password' ? { username: username.trim(), password } : { cookie: cookie.trim() };
    void controller.current?.connect(credentials);
    setPassword(''); setCookie('');
  }
  const canConnect = mode === 'password' ? username.trim() && password : cookie.trim();
  const display = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '—' : value;
  return (
    <main className="workspace erp-environment">
      <section className="intro">
        <p className="eyebrow">ERP 接入</p>
        <h1>ERP 登录与商品查询</h1>
        <p>按商品 SKU 查看商品与 BOM 明细，仅查询，不写入工作台或 ERP。</p>
      </section>
      {!desktop && <p className="notice">当前是浏览器预览，连接与查询操作需在桌面程序中使用。</p>}
      <section className="checks" aria-label="ERP 连接">
        <div className="check-heading"><h2>本机连接</h2><span className={`status ${connected ? 'ready' : ''}`}>{session.busy === 'status' ? '正在读取状态' : connected ? '已连接' : session.session ? '未连接' : '状态未确认'}</span></div>
        <div className="erp-form">
          <label>ERP 地址<input value={session.session?.domain || "本机尚未配置"} readOnly /></label>
          {connected ? <div className="erp-connected"><p>当前账号：{session.session?.user || 'ERP 会话'}</p>{session.session?.package_version && <p>ERP 适配器版本：{session.session.package_version}</p>}</div> : <>
            <fieldset className="erp-login-mode" disabled={busy}><legend>登录方式</legend><label><input type="radio" name="erp-login-mode" checked={mode === 'password'} onChange={() => { setMode('password'); setPassword(''); setCookie(''); }} />账号密码</label><label><input type="radio" name="erp-login-mode" checked={mode === 'cookie'} onChange={() => { setMode('cookie'); setPassword(''); setCookie(''); }} />Cookie</label></fieldset>
            <form onSubmit={event => { event.preventDefault(); connect(); }} autoComplete="off">
              <fieldset disabled={busy} className="erp-credentials">
                {mode === 'password' ? <><label>账号<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" /></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" /></label></> : <label className="erp-cookie">Cookie<textarea value={cookie} onChange={event => setCookie(event.target.value)} autoComplete="off" spellCheck={false} rows={3} placeholder="粘贴 ERP 登录 Cookie" /></label>}
              </fieldset>
              <button type="submit" disabled={busy || !desktop || !canConnect}>{session.busy === 'connect' ? '正在连接…' : '连接 ERP'}</button>
            </form>
          </>}
          <div className="erp-session-actions"><button className="secondary" disabled={busy || !desktop} onClick={() => { if (!environmentFlight.current) void controller.current?.status(); }}>刷新连接状态</button><button className="secondary" disabled={busy || !desktop || !connected} onClick={() => { if (!environmentFlight.current) void controller.current?.disconnect(); }}>{session.busy === 'disconnect' ? '正在断开…' : '断开本机连接'}</button></div>
          <p className="storage-note">凭据仅用于本次会话；关闭程序后需重新登录。</p>
          {session.error && <p className="notice error" role="alert">{session.error}</p>}
        </div>
      </section>
      <section className="checks erp-query" aria-label="ERP 商品查询" aria-busy={session.busy === 'query_goods'}>
        <div className="check-heading"><h2>商品与 BOM 明细</h2><span className="status">只读查询</span></div>
        <div className="erp-form">
          <form className="erp-query-form" onSubmit={event => { event.preventDefault(); if (!environmentFlight.current) void controller.current?.query(); }}><label>商品 SKU<input value={session.sku} onChange={event => controller.current?.setSku(event.target.value)} disabled={busy} placeholder="输入完整 SKU，保留前导零" inputMode="text" /></label><button type="submit" disabled={busy || !desktop || !connected || !session.sku.trim()}>{session.busy === 'query_goods' ? '正在查询…' : '查询明细'}</button></form>
          <div aria-live="polite">
            {!session.result && <p className="empty">{session.busy === 'query_goods' ? '正在读取 ERP 商品明细…' : connected ? '输入商品 SKU 后查询。' : '连接 ERP 后可查询商品明细。'}</p>}
            {session.result && <><p className="erp-result-note">SKU：<strong>{session.result.sku}</strong> · {session.result.rows.length} 项明细<span>查询时间：{display(session.result.queried_at)}</span></p>{session.result.rows.length === 0 ? <p className="empty">该 SKU 未找到可用的商品或关联明细，请核对 SKU。</p> : <div className="erp-results"><table><thead><tr>{['商品 ID', '商品编码', '商品名称', '数量', '类型', '分类', '品牌', '系列', '型号', '规格', '赠品'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{session.result.rows.map((row, index) => <tr key={`${row.goods_id}-${index}`}><td>{display(row.goods_id)}</td><td>{display(row.code)}</td><td>{display(row.name)}</td><td className="numeric">{display(row.quantity)}</td><td>{display(row.type)}</td><td>{display(row.category)}</td><td>{display(row.brand)}</td><td>{display(row.series)}</td><td>{display(row.model)}</td><td>{display(row.spec)}</td><td>{row.is_gift ? '是' : '否'}</td></tr>)}</tbody></table></div>}</>}
          </div>
        </div>
      </section>
      <section className="checks erp-check" aria-label="ERP 环境检查">
        <div className="check-heading"><h2>本机环境</h2><button className="secondary" disabled={busy || !desktop} onClick={() => void checkEnvironment()}>{environmentBusy ? '正在检查…' : '检查 ERP 环境'}</button></div>
        {environmentError && <p className="notice error" role="alert">{environmentError}</p>}
        <div aria-live="polite" aria-busy={environmentBusy}>
          <div className="check-row"><div><h3>Python 运行环境</h3><p>{report ? `Python ${report.python} · ${report.platform}` : '检查独立环境能否启动并返回结果'}</p></div><span className={`status ${report ? 'ready' : ''}`}>{report ? '可用' : environmentBusy ? '检查中' : '未检查'}</span></div>
          <div className="check-row"><div><h3>本机 ERP 适配器</h3><p>{report ? report.erp_package.message : '检查安装状态、依赖和导入入口'}</p>{report?.erp_package.version && <p>版本 {report.erp_package.version}</p>}</div><span className={`status ${report?.erp_package.status === 'ready' ? 'ready' : report ? 'pending' : ''}`}>{report ? ({ ready: '可用', missing: '未安装', error: '加载失败' }[report.erp_package.status]) : environmentBusy ? '等待检查' : '未检查'}</span></div>
        </div>
        {report && <details><summary>查看环境路径</summary><code>{report.executable}</code></details>}
      </section>
    </main>
  );
}

