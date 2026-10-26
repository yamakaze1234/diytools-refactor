import './endfield-motion.js';
// 同源宿主和 iframe 通过 storage 同步主题，不调用业务保存或图片配色接口。
const key = 'diytools.workbench.endfield.theme.v1';
let themeFrame = 0;
function apply(theme) {
  theme = theme === 'dark' ? 'dark' : 'light';
  if (document.documentElement.dataset.workbenchTheme === theme && document.documentElement.classList.contains('dark') === (theme === 'dark')) return;
  cancelAnimationFrame(themeFrame);
  document.documentElement.setAttribute('data-workbench-theme-changing','');
  document.documentElement.dataset.workbenchTheme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  window.dispatchEvent(new CustomEvent('workbench-ui-theme-applied', {detail: theme}));
  // 等新配色完成一次绘制再恢复控件动效；连续切换时取消前一轮回调。
  themeFrame = requestAnimationFrame(() => {themeFrame = requestAnimationFrame(() => {
    document.documentElement.removeAttribute('data-workbench-theme-changing');themeFrame = 0;
  });});
}
window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
window.addEventListener('workbench-ui-theme-change', event => {
  const theme = event.detail;
  if (!['light', 'dark'].includes(theme)) return;
  apply(theme);
  try { localStorage.setItem(key, theme); } catch { /* 禁止持久存储时仍允许当前会话切换。 */ }
  // 同一 WebView 内即时刷新；storage 事件覆盖其他独立窗口。
  for (const frame of document.querySelectorAll('iframe')) {
    try { frame.contentWindow?.dispatchEvent(new CustomEvent('workbench-ui-theme-local', {detail: theme})); } catch {}
  }
});
window.addEventListener('workbench-ui-theme-local', event => apply(event.detail));
apply(document.documentElement.dataset.workbenchTheme);
