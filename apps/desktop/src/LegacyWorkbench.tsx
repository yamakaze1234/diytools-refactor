/** 完整工作台 iframe 宿主：先安装本机桥接，再接收页面状态，并接入原生关闭保护。 */
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { installWorkbenchBridge } from './legacy/local-bridge';
import { createWorkbenchCloseController } from './legacy/close-controller';
import './LegacyWorkbench.css';
import { createWorkbenchReactRenderer } from './legacy/react-workbench';
const reactRenderers = new Set<ReturnType<typeof createWorkbenchReactRenderer>>();

declare global {
 interface Window {
  installWorkbenchBridge?: typeof installWorkbenchBridge;
  createWorkbenchReactRenderer?: typeof createWorkbenchReactRenderer;
  workbenchBeforeQuit?: () => Promise<void>;
  workbenchClosePending?: boolean;
  workbenchUpdatePending?: boolean;
 }
}
// Set up before the iframe is rendered, so its bootstrap cannot race the adapter.
window.installWorkbenchBridge = installWorkbenchBridge;
// 必须早于 iframe 模块执行，避免首次渲染退回旧节点后再接管。
window.createWorkbenchReactRenderer = () => {
 const renderer=createWorkbenchReactRenderer();reactRenderers.add(renderer);
 const dispose=renderer.dispose;renderer.dispose=()=>{dispose();reactRenderers.delete(renderer);};
 return renderer;
};

/** 管理 iframe 生命周期，卸载时释放消息及关闭监听。 */
export default function LegacyWorkbench({onDirty}: {onDirty: (dirty: boolean) => void}) {
 const frame = useRef<HTMLIFrameElement>(null);
 useEffect(()=>()=>{for(const renderer of reactRenderers)renderer.dispose();},[]);
 const [error, setError] = useState('');
 const [closeError, setCloseError] = useState('');
 const [closing, setClosing] = useState(false);
 const onDirtyRef = useRef(onDirty);
 onDirtyRef.current = onDirty;
 useEffect(() => {
  const receive = (event: MessageEvent) => {
   if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
   if (event.data?.type === 'workbench-dirty') onDirty(Boolean(event.data.dirty || window.workbenchClosePending));
   if (event.data?.type === 'workbench-error') setError(String(event.data.message));
   if (event.data?.type === 'workbench-ready') setError('');
  };
  window.addEventListener('message', receive);
  return () => { window.removeEventListener('message', receive); onDirty(false); };
 }, [onDirty]);
 useEffect(() => {
  if (!isTauri()) return;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const nativeWindow = getCurrentWindow();
  // Keep the initial native editing surface inactive until the close listener is installed.
  if (frame.current) frame.current.inert = true;
  const controller = createWorkbenchCloseController({
   getWorkbench: () => frame.current?.contentWindow ?? null,
   closeWindow: () => nativeWindow.close(),
   onPending: pending => {
    if (disposed) return;
    window.workbenchClosePending = pending;
    if (frame.current) frame.current.inert = pending || Boolean(window.workbenchUpdatePending);
    setClosing(pending);
    if (pending) { setCloseError(''); onDirtyRef.current(true); }
    else {
     const live = frame.current?.contentWindow as (Window & {workbenchHasPendingChanges?: () => boolean}) | null;
     onDirtyRef.current(Boolean(live?.workbenchHasPendingChanges?.()));
    }
   },
   onError: message => { if (!disposed) setCloseError(message); },
  });
  nativeWindow.onCloseRequested(event => {
   if (window.workbenchUpdatePending) { event.preventDefault(); return; }
   return controller.handle(event);
  }).then(remove => {
   if (disposed) remove();
   else { unlisten = remove; if (frame.current && !controller.pending && !window.workbenchUpdatePending) frame.current.inert = false; }
  }).catch(reason => {
   if (!disposed) setCloseError('关闭保护未能安装：' + String(reason));
  });
  return () => {
   disposed = true;
   controller.dispose();
   unlisten?.();
   window.workbenchClosePending = false;
   if (frame.current) frame.current.inert = false;
  };
 }, []);
 return <section className="legacy-workbench-host" aria-label="完整配置工作台">
  {error && <p className="legacy-workbench-error" role="alert">工作台载入失败：{error}</p>}
  {closeError && <p className="legacy-workbench-error" role="alert">退出未完成：{closeError} 当前窗口与输入已保留，请处理后重新关闭。</p>}
  {closing && <p className="legacy-workbench-error" role="status">正在保存当前修改，请稍候…</p>}
  <iframe ref={frame} className="legacy-workbench-frame" src="/workbench/index.html" title="DIY 配置工作台" />
 </section>;
}
