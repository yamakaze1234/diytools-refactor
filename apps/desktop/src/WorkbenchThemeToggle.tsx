import {useEffect, useState} from 'react';
import {Sun} from 'lucide-react';
import {Button} from '@/components/ui/button';

/** 只修改界面主题，配置图片的配色仍由原工作台控制。 */
export default function WorkbenchThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.dataset.workbenchTheme || 'light');
  useEffect(() => {
    const update = () => setTheme(document.documentElement.dataset.workbenchTheme || 'light');
    window.addEventListener('workbench-ui-theme-applied', update);
    return () => window.removeEventListener('workbench-ui-theme-applied', update);
  }, []);
  return <Button type="button" variant="outline" id="workbench-theme-toggle"
    data-target-theme={theme === 'dark' ? 'light' : 'dark'}
    aria-label={theme === 'dark' ? '切换为浅色界面' : '切换为深色界面'}
    title="仅切换工作台界面，不改变配置图片"
    onClick={() => window.dispatchEvent(new CustomEvent('workbench-ui-theme-change', {detail: theme === 'dark' ? 'light' : 'dark'}))}>
    {theme === 'dark' ? <Sun size={13} aria-hidden="true"/> : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M8 2a6 6 0 0 0 0 12Z" fill="currentColor"/></svg>}
    <span>{theme === 'dark' ? '浅色界面' : '深色界面'}</span>
  </Button>;
}
