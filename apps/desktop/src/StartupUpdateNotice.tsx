import { useEffect, useRef } from 'react';
import type { UpdateCheck } from './updater-controller';

type StartupUpdateNoticeProps = {
  release: UpdateCheck;
  onDismiss: () => void;
  onUpdate: () => void;
};

/** 启动提醒使用原生模态框，在处理更新决定前暂停背景交互。 */
export default function StartupUpdateNotice({ release, onDismiss, onUpdate }: StartupUpdateNoticeProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  // 保留说明顺序，统一用卡片自己的列表标记显示普通文本和 Markdown 要点。
  const notes = (release.notes ?? '').split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:#{1,6}|[-*+•])\s+/, '').trim())
    .filter(Boolean);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    modal.showModal();
    later.current?.focus();
    return () => modal.close();
  }, []);

  return (
    <dialog ref={dialog} className="startup-update-notice" aria-labelledby="startup-update-title"
      aria-describedby="startup-update-retention" onCancel={event => { event.preventDefault(); onDismiss(); }}>
      <header className="startup-update-header">
        <h2 id="startup-update-title">发现新版本 · v{release.version}</h2>
        <span className="startup-update-current">当前 v{release.currentVersion}</span>
      </header>
      <div className="startup-update-body">
        {notes.length > 0 ? (
          <section>
            <h3 id="startup-update-notes-title">本次更新重点</h3>
            <ul className="startup-update-notes" tabIndex={0} aria-labelledby="startup-update-notes-title">
              {notes.map((note, index) => <li key={index}>{note}</li>)}
            </ul>
          </section>
        ) : <p>新版本已可用。打开更新窗口可查看详细信息。</p>}
        <p id="startup-update-retention" className="startup-update-retention">
          仅原地替换主程序并自动重启，草稿、账号与数据全部保留。
        </p>
        <div className="startup-update-actions">
          <button ref={later} type="button" onClick={onDismiss}>稍后再说</button>
          <button type="button" className="startup-update-primary" onClick={onUpdate}>
            {release.canInstall ? '立即更新并重启' : '查看更新'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
