/** 11-19：界面字体选项——工具自带字体（默认）或系统字体（Windows 微软雅黑 / Mac 苹方）。选择记在本机。 */
const KEY='diy-ui-font';
const SYSTEM='"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",-apple-system,"Segoe UI",sans-serif';
// 主题样式在 CSS 层里用 !important 定义字体变量，只有写在根元素行内的 !important 才盖得住。
const VARS=['--ef-font-text','--ef-font-ui','--ef-font-mono','--font-sans','--font-heading','--font-mono','--default-font-family','--default-mono-font-family','--ov-numbers'];
export function applyUiFont(choice){
 const root=document.documentElement,system=choice==='system';
 // 有的变量定义在 body 上（总表模式），根和 body 都要写。
 for(const el of [root,document.body])for(const name of VARS)system?el.style.setProperty(name,SYSTEM,'important'):el.style.removeProperty(name);
 root.classList.toggle('ui-font-system',system);
}
export function mountFontChoice(){
 const saved=localStorage.getItem(KEY)==='system'?'system':'tool';applyUiFont(saved);
 const host=document.querySelector('.topbar .top-right');if(!host||document.getElementById('ui-font-choice'))return;
 const label=document.createElement('label');label.className='ui-font-choice';label.title='切换界面字体，只影响本机显示';
 label.innerHTML='字体 <select id="ui-font-choice" aria-label="界面字体"><option value="tool">工具自带字体</option><option value="system">系统字体（微软雅黑 / 苹方）</option></select>';
 host.prepend(label);
 const select=label.querySelector('select');select.value=saved;
 select.onchange=()=>{localStorage.setItem(KEY,select.value);applyUiFont(select.value);};
}
mountFontChoice();
