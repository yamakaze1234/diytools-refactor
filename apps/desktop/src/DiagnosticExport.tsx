/** 首次使用卡住时也能导出；仅导出白名单诊断，操作不等待业务调用完成。 */
import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { exportDiagnostics } from './diagnostics';
export default function DiagnosticExport() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (!isTauri()) throw Error('需要在桌面程序中导出');
      const version = await getVersion().catch(() => 'unknown');
      const result = await exportDiagnostics(invoke, version);
      setMessage(result === 'saved' ? '诊断日志已保存。仅含本次运行的阶段、错误类别和耗时，不含账号与配置内容。' : '已取消导出。');
    } catch { setMessage('诊断日志未保存，请重新选择可写目录。'); }
    finally { setBusy(false); }
  }
  return <div className="diagnostic-export"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? '正在导出诊断日志…' : '导出诊断日志'}</button>{message && <p role="status">{message}</p>}</div>;
}
