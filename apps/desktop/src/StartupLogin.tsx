/** 启动登录表单：展示鉴权与准备阶段，提供登录、重试和退出会话入口。 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StartupLoginState } from './startup-login-controller';
import './StartupLogin.css';

/** 按控制器状态禁用重复操作，提交凭据后由控制器负责后续准备。 */
export default function StartupLogin({ desktop, state, onLogin, onRetry, onLogout, onChooseData }: {
  desktop: boolean; state: StartupLoginState;
  onLogin: (username: string, password: string) => Promise<void>;
  onRetry: () => Promise<void>; onLogout: () => Promise<void>;
  onChooseData: (source: 'cloud' | 'legacy') => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy) return;
    let secret = password;
    setPassword('');
    const request = onLogin(username, secret);
    secret = '';
    await request;
  }
  return <main className="startup-login-shell">
    <section className="startup-login-card" aria-labelledby="startup-login-title">
      <div className="startup-login-mark" aria-hidden="true"><span /><span /><span /></div>
      <h1 id="startup-login-title">{state.firstUse ? '准备你的工作台' : 'DIY配置工作台'}</h1>
      <p className="startup-login-intro">{state.firstUse ? '首次使用，选择数据从哪里开始。' : '登录后，继续管理配置与图片。'}</p>
      {!desktop ? <p className="startup-login-platform" role="status">请使用 Windows 工作台登录。</p>
        : state.session.authenticated ? <div className="startup-login-preparation">
          <p className="startup-login-member">{state.session.member?.name || '已登录'}</p>
          {state.busy && <p role="status" className="startup-login-progress"><span className="startup-login-spinner" aria-hidden="true" />{state.message || '正在准备工作台…'}</p>}
          {state.error && <p className="startup-login-error" role="alert">{state.error}</p>}
          {state.firstUse && <div className="startup-data-choices" aria-label="首次使用的数据来源" aria-busy={state.busy}>
            <button className="startup-data-choice" disabled={state.busy} onClick={() => void onChooseData('cloud')}>
              <strong>从云端下载全部数据</strong><span>下载当前工作区的配置与原图，适合没有旧版资料的电脑。</span>
            </button>
            <button className="startup-data-choice" disabled={state.busy} onClick={() => void onChooseData('legacy')}>
              <strong>选择旧版 data 目录迁移</strong><span>复用本机配置与原图，保留未同步修改，再补齐云端变化。</span>
            </button>
            <p className="startup-data-note">迁移前请保存并退出旧程序。旧目录保持不变。</p>
          </div>}
          {!state.busy && <div className="startup-login-retry-actions">{!state.firstUse && <button className="startup-login-submit" onClick={() => void onRetry()}>重试</button>}<button className="startup-login-other" onClick={() => void onLogout()}>退出重新登录</button></div>}
        </div> : <form onSubmit={submit} className="startup-login-form">
          <label htmlFor="startup-username">账号</label>
          <input id="startup-username" name="username" autoComplete="username" autoFocus value={username} onChange={event => setUsername(event.target.value)} disabled={state.busy} required />
          <label htmlFor="startup-password">密码</label>
          <input id="startup-password" name="password" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={state.busy} required />
          {state.error && <p className="startup-login-error" role="alert">{state.error}</p>}
          {state.busy && <p className="startup-login-progress" role="status">{state.message}</p>}
          <button type="submit" className="startup-login-submit" disabled={state.busy}>{state.busy ? '请稍候…' : '登录'}</button>
          {state.error && <button type="button" className="startup-login-other" disabled={state.busy} onClick={() => void onRetry()}>重新检查登录状态</button>}
        </form>}
      <p className="startup-login-storage">配置先保存在本机，登录后自动同步。</p>
    </section>
  </main>;
}
