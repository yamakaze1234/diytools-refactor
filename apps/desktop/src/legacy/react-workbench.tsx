import {SourceEditorPanel,SourceEditorDetail} from './source-editor-panel';
import {CaseGalleryPanel,CaseGalleryGrid,CaseGalleryDetail,CaseGalleryDelete} from './case-gallery-panel';
import {WorkspaceSyncPanel} from './workspace-sync-panel';
import {LinkPartsPanel,LinkPartsRule,LinkPartsOverview} from './link-parts-panel';
import reuiStyles from '../reui.css?inline';
import {Input} from '@/components/ui/input';
import {LayoutGrid,Boxes,Images,History,PackageSearch,X} from 'lucide-react';
import {ContinuousWorkbench} from './continuous-workbench';
import {BatchIds,BatchAppearance,BatchDescription} from './batch-panels';
/** 渐进迁移只接管展示节点，业务状态与操作仍由工作台闭包维护。 */
import { startTransition, useLayoutEffect, useRef, useState, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {EditorPanel,AddonStatus,type EditorModel} from './editor-panels';
import {TemplateArea,TemplatePicker,TemplateSave} from './template-panels';
import {AddonShell,AddonFields,AddonItems,AddonChoices,CostDialog,CostSummary} from './addon-panels';
import type {Row} from './editor-controls';

type FieldProps = { field: string; value: string; configId: string; attributes: Record<string, string>; inlineStyle: string|null; checkpoint: () => void; edit: (field: string, value: string) => void };
function ConfigField({field,value,attributes,inlineStyle,checkpoint,edit}: FieldProps) {
 const input = useRef<HTMLInputElement>(null);
 // 外部锁定/解锁可能留下 style=""；保留原始 CSS，不能把 DOM 字符串传给 React style。
 useLayoutEffect(() => {const node=input.current;if(node){if(inlineStyle===null)node.removeAttribute('style');else node.setAttribute('style',inlineStyle);}}, [inlineStyle]);
 // 同配置重绘不触碰正在输入的值、中文组合串和光标；配置切换由 key 隔离。
 useLayoutEffect(() => { const node=input.current; if(node && node.ownerDocument.activeElement!==node && node.value!==value) node.value=value; }, [value]);
 return <Input ref={input} {...attributes} data-config={field} data-react-config="true" defaultValue={value} onFocus={checkpoint} onInput={event=>edit(field,event.currentTarget.value)} />;
}
function ConfigList({markup,document}: {markup: string; document: Document}) {
 const template=document.createElement('template');template.innerHTML=markup;
 return <>{Array.from(template.content.children).map((group,index)=> {
  if(!group.matches('[data-list-product]')) return <p key={`empty-${index}`} className="hint">{group.textContent}</p>;
  const expanded=group.classList.contains('expanded');
  // 折叠即释放配置行及其 React 节点；勾选、当前项由业务状态在展开时重建。
  const rows=expanded?Array.from(group.querySelectorAll<HTMLElement>('.config-item')):[];
  const heading=group.firstElementChild!;
  const style=group.getAttribute('style');
  return <section key={group.getAttribute('data-list-product')} className={group.className} data-list-product={group.getAttribute('data-list-product')} data-link-colored={group.hasAttribute('data-link-colored')?'':undefined} ref={node=>{if(node){if(style)node.setAttribute('style',style);else node.removeAttribute('style');}}}>
   <div className={heading.className} dangerouslySetInnerHTML={{__html:heading.innerHTML}} />
   {expanded&&<div>{rows.map(row=><div key={row.dataset.id} className={row.className} data-id={row.dataset.id} tabIndex={0} role="button" aria-current={row.getAttribute('aria-current')==='true'} aria-label={row.getAttribute('aria-label')||undefined}>
    <input type="checkbox" defaultChecked={row.querySelector('input')!.checked} ref={node=>{if(node)node.checked=row.querySelector('input')!.checked;}} aria-label={row.querySelector('input')!.getAttribute('aria-label')||undefined}/>
    <div><strong>{row.querySelector('strong')?.textContent}</strong><small className={row.querySelector('small')?.className} title={row.querySelector('small')?.title} aria-label={row.querySelector('small')?.getAttribute('aria-label')||undefined}>{row.querySelector('small')?.textContent}</small></div>
   </div>)}</div>}
  </section>;
 })}</>;
}
/** 分类入口沿用已有按钮控制器；弹层不占用商品链接列表高度。 */
function WorkbenchNavigation({doc}:{doc:Document}) {
 const [open,setOpen]=useState<string|null>(null),[shown,setShown]=useState<string|null>(null);const nav=useRef<HTMLDivElement>(null);const panel=useRef<HTMLElement>(null);const motion=useRef<Animation|null>(null);
 const changeMenu=(next:string|null)=>{setOpen(next);if(next)setShown(next);};
 const groups=[
  {label:'图片',title:'配置与图片',Icon:Images,items:[['配置模板','[data-nav="templates"]'],['机箱图库','#case-gallery-open']]},
  {label:'维护',title:'批量维护',Icon:Boxes,items:[['批量修改配件 / 加购 / 导图','#global-batch-open'],['输出源维护','[data-nav="source"]'],['三店共用成本价','[data-nav="cost-source"]']]},
  {label:'库存',title:'库存与核算',Icon:PackageSearch,items:[['检查商品库存','#inventory-check-open'],['一键检测利润','#profit-check-open'],['检查价格变化','#price-changes-open'],['导出库存监控清单','#inventory-export-open']]},
 ];
 useEffect(()=>{const outside=(e:Event)=>{if(!nav.current?.contains(e.target as Node))setOpen(null);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(null);nav.current?.querySelector<HTMLButtonElement>('[aria-expanded=true]')?.focus();}};doc.addEventListener('pointerdown',outside);doc.addEventListener('keydown',escape);return()=>{motion.current?.cancel();doc.removeEventListener('pointerdown',outside);doc.removeEventListener('keydown',escape);};},[doc]);
 // 只在分类展开期间定位，跟随图标并限制在可视窗口内。
 useLayoutEffect(()=>{
  const win=doc.defaultView,popup=panel.current;if(!win||!popup){motion.current?.cancel();motion.current=null;return;}
  const previous=popup.hasAttribute('data-positioned'),before=popup.getBoundingClientRect(),style=win.getComputedStyle(popup),opacity=style.opacity,transform=style.transform;
  motion.current?.cancel();motion.current=null;
  const place=()=>{const popup=panel.current,anchor=nav.current?.querySelector<HTMLElement>('[aria-expanded=true]'),rail=nav.current?.closest('.reui-rail');if(!popup||!anchor||!rail)return;
   popup.style.maxHeight=`${Math.max(0,win.innerHeight-16)}px`;
   popup.style.maxWidth=`${Math.max(0,win.innerWidth-16)}px`;
   const top=Math.max(8,Math.min(anchor.getBoundingClientRect().top,win.innerHeight-popup.offsetHeight-8));
   const left=Math.max(8,Math.min(rail.getBoundingClientRect().right+8,win.innerWidth-popup.offsetWidth-8));
   popup.style.top=`${top}px`;popup.style.left=`${left}px`;
  };if(open){place();popup.setAttribute('data-positioned','');}
  // 关闭保留节点直到淡出结束；切换分类从当前视觉位置接续，避免闪回或残留计时器。
  if(win.matchMedia('(prefers-reduced-motion: reduce)').matches){if(!open)setShown(null);}
  else {const start=open?{opacity:previous?opacity:0,transform:`translate(${previous?0:-8}px,${previous?before.top-parseFloat(popup.style.top):0}px)`}:{opacity,transform};
   const animation=popup.animate([start,open?{opacity:1,transform:'translate(0,0)'}:{opacity:0,transform:'translate(-6px,0)'}],{duration:open?260:180,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});motion.current=animation;
   animation.onfinish=()=>{if(motion.current!==animation)return;if(!open){setShown(null);return;}motion.current=null;animation.cancel();};
  }
  if(open)win.addEventListener('resize',place);return()=>win.removeEventListener('resize',place);
 },[open,shown,doc]);
 const run=(selector:string)=>{setOpen(null);doc.querySelector<HTMLButtonElement>(selector)?.click();};
 const group=groups.find(g=>g.label===shown);
 return <div ref={nav} className="rail-navigation"><strong>D·</strong><button className="rail-nav-button" title="返回当前配置" onClick={()=>run('[data-nav="configs"]')}><LayoutGrid/>配置</button>{groups.map(({label,Icon})=><button key={label} className="rail-nav-button" aria-expanded={open===label} aria-controls="rail-tool-panel" onClick={()=>changeMenu(open===label?null:label)}><Icon/>{label}</button>)}<button className="rail-nav-button" onClick={()=>run('#logs-open')}><History/>记录</button>{group&&<section ref={panel} id="rail-tool-panel" className="rail-tool-panel" aria-label={group.title} inert={!open} aria-hidden={!open||undefined}><header><strong>{group.title}</strong><button aria-label="关闭工具分类" onClick={()=>setOpen(null)}><X/></button></header>{group.items.map(([label,selector])=><button key={selector} onClick={()=>run(selector)}>{label}</button>)}</section>}</div>;
}
/** 每个 iframe 独立登记 React root，卸载和导航时全部释放。 */
export function createWorkbenchReactRenderer() {
 const styleDocuments=new WeakSet<Document>();
 const installStyle=(doc:Document)=>{if(styleDocuments.has(doc))return;const style=doc.createElement("style");style.dataset.reui="true";style.textContent=reuiStyles;doc.head.append(style);styleDocuments.add(doc);
 const nav=doc.createElement('nav');nav.className='reui-rail';nav.setAttribute('aria-label','工作台功能');doc.body.prepend(nav);doc.body.classList.add('has-reui-rail');
 const navRoot=createRoot(nav);roots.set(nav,navRoot);navRoot.render(<WorkbenchNavigation doc={doc}/>);
 };
 const roots=new Map<Element,Root>();
 const rootFor=(element:Element)=>{installStyle(element.ownerDocument);let root=roots.get(element);if(!root){root=createRoot(element);roots.set(element,root);}return root;};
 // 先释放内部孤岛再释放外层，避免对话框关闭后残留 detached React roots。
 const release=(container:Element)=>{for(const [element,root] of [...roots].reverse())if(element===container||container.contains(element)){flushSync(()=>root.unmount());roots.delete(element);}};
 const regions={'source-editor':SourceEditorPanel,'source-editor-detail':SourceEditorDetail,'workspace-sync':WorkspaceSyncPanel,'case-gallery':CaseGalleryPanel,'case-gallery-grid':CaseGalleryGrid,'case-gallery-detail':CaseGalleryDetail,'case-gallery-delete':CaseGalleryDelete,'link-parts':LinkPartsPanel,'link-parts-rule':LinkPartsRule,'link-parts-overview':LinkPartsOverview,templates:TemplatePicker,'template-save':TemplateSave,'addon-shell':AddonShell,'addon-fields':AddonFields,'addon-items':AddonItems,'addon-choices':AddonChoices,'config-cost':CostDialog,'cost-summary':CostSummary,'batch-ids':BatchIds,'batch-style':BatchAppearance,'batch-description':BatchDescription};
 return {
  // 输入值和业务写入即时完成，整表投影允许让出主线程，保留当前输入节点与光标。
  continuous(container:HTMLElement,model:Row){installStyle(container.ownerDocument);startTransition(()=>rootFor(container).render(<ContinuousWorkbench model={model}/>));},
  editor(container:HTMLElement,model:EditorModel){flushSync(()=>rootFor(container).render(<EditorPanel key={String(model.config.id)+':'+model.tab} model={model}/>));},
  templates(container:HTMLElement,model:Row){let surface=container.querySelector<HTMLElement>(':scope > [data-react-templates]');if(!surface){surface=container.ownerDocument.createElement('div');surface.dataset.reactTemplates='true';surface.style.display='contents';container.append(surface);}flushSync(()=>rootFor(surface!).render(<TemplateArea model={model}/>));},
  dialog(container:HTMLElement,kind:string,model:Row){const Panel=regions[kind as keyof typeof regions];if(!Panel)throw Error('未知 React 编辑区 '+kind);flushSync(()=>rootFor(container).render(<Panel model={model}/>));},
  status(container:HTMLElement,model:Row){flushSync(()=>rootFor(container).render(<AddonStatus status={model}/>));},
  release,
  list(container:HTMLElement,markup:string) {
   let surface=container.querySelector<HTMLElement>(':scope > [data-react-list]');
   if(!surface){container.replaceChildren();surface=container.ownerDocument.createElement('div');surface.dataset.reactList='true';surface.style.display='contents';container.append(surface);}
   // 模板区仍复用旧交互，放在 React 根之外，防止双重拥有节点。
   container.querySelector(':scope > .template-library-section')?.remove();
   flushSync(()=>rootFor(surface!).render(<ConfigList markup={markup} document={container.ownerDocument}/>));
  },
  fields(document:Document,config:Record<string,unknown>,checkpoint:()=>void,edit:FieldProps['edit']) {
   for(const node of document.querySelectorAll<HTMLInputElement>('[data-config]')) {
    const field=node.dataset.config!;let surface=node.parentElement!;
    const attributes:Record<string,string>={};
    const inlineStyle=node.getAttribute('style');
    for(const attribute of node.attributes)if(!['data-config','data-react-config','value','style'].includes(attribute.name))attributes[attribute.name==='inputmode'?'inputMode':attribute.name==='class'?'className':attribute.name]=attribute.value;
    if(!surface.hasAttribute('data-react-field')){surface=document.createElement('span');surface.dataset.reactField=field;surface.style.display='contents';node.replaceWith(surface);}
    flushSync(()=>rootFor(surface).render(<ConfigField key={String(config.id)} field={field} configId={String(config.id)} value={String(config[field]??'')} attributes={attributes} inlineStyle={inlineStyle} checkpoint={checkpoint} edit={edit}/>));
   }
  },
  dispose(){for(const [,root] of [...roots].reverse())root.unmount();roots.clear();},
 };
}
