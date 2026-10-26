// 仅设置界面偏好；在 React、旧页面及字体绘制前完成，避免主题闪烁。
(() => {
  let theme = 'light';
  try { if (localStorage.getItem('diytools.workbench.endfield.theme.v1') === 'dark') theme = 'dark'; } catch {}
  const root = document.documentElement;
  root.dataset.workbenchDesign = 'endfield';
  root.dataset.workbenchTheme = theme;
  root.dataset.efAccent = 'yellow'; root.dataset.efPaper = 'neutral';
  root.dataset.efCut = 'tight'; root.dataset.efGround = 'plain';
  root.dataset.efDensity = 'standard'; root.dataset.efMotion = 'calm';
  root.classList.toggle('dark', theme === 'dark');
})();
