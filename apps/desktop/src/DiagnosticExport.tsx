/** 首次使用卡住时也能导出；仅导出白名单诊断，操作不等待业务调用完成。 */
import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { diagnosticText, exportDiagnostics } from './diagnostics';
export default function DiagnosticExport() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [text, setText] = useState('');
  async function save() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (!isTauri()) throw Error('需要在桌面程序中导出');
      const result = await exportDiagnostics(invoke);
      setMessage(result === 'saved' ? '诊断日志已保存。仅含本次运行的阶段、错误类别和耗时，不含账号与配置内容。' : '已取消导出。');
    } catch { setMessage('诊断文件尚未确认保存。若未弹出目录窗口，请点击“查看诊断文本”并复制内容。'); }
    finally { setBusy(false); }
  }
  return <div className="diagnostic-export"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? '正在导出诊断日志…' : '导出诊断日志'}</button><button type="button" onClick={() => setText(diagnosticText())}>查看诊断文本</button>{text && <><p>可全选复制以下诊断信息，不含账号与配置内容。</p><textarea aria-label="诊断文本" readOnly rows={10} value={text} onFocus={event => event.currentTarget.select()} /></>}{message && <p role="status">{message}</p>}</div>;
}
