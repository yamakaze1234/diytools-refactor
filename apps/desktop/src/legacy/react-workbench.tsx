/** 渐进迁移只接管展示节点，业务状态与操作仍由工作台闭包维护。 */
import { useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {EditorPanel,AddonStatus,type EditorModel} from './editor-panels';
import {TemplateArea,TemplatePicker,TemplateSave} from './template-panels';
import {AddonShell,AddonFields,AddonItems,AddonChoices,CostDialog,CostSummary} from './addon-panels';
import type {Row} from './editor-controls';

type FieldProps = { field: string; value: string; configId: string; attributes: Record<string, string>; checkpoint: () => void; edit: (field: string, value: string) => void };
function ConfigField({field,value,attributes,checkpoint,edit}: FieldProps) {
 const input = useRef<HTMLInputElement>(null);
 // 同配置重绘不触碰正在输入的值、中文组合串和光标；配置切换由 key 隔离。
 useLayoutEffect(() => { const node=input.current; if(node && node.ownerDocument.activeElement!==node && node.value!==value) node.value=value; }, [value]);
 return <input ref={input} {...attributes} data-config={field} data-react-config="true" defaultValue={value} onFocus={checkpoint} onInput={event=>edit(field,event.currentTarget.value)} />;
}
function ConfigList({markup,document}: {markup: string; document: Document}) {
 const template=document.createElement('template');template.innerHTML=markup;
 return <>{Array.from(template.content.children).map((group,index)=> {
  if(!group.matches('[data-list-product]')) return <p key={`empty-${index}`} className="hint">{group.textContent}</p>;
  const rows=Array.from(group.querySelectorAll<HTMLElement>('.config-item'));
  const heading=group.firstElementChild!;
  const style=group.getAttribute('style');
  return <section key={group.getAttribute('data-list-product')} className={group.className} data-list-product={group.getAttribute('data-list-product')} data-link-colored={group.hasAttribute('data-link-colored')?'':undefined} ref={node=>{if(node){if(style)node.setAttribute('style',style);else node.removeAttribute('style');}}}>
   <div className={heading.className} dangerouslySetInnerHTML={{__html:heading.innerHTML}} />
   <div hidden={!group.classList.contains('expanded')}>{rows.map(row=><div key={row.dataset.id} className={row.className} data-id={row.dataset.id} tabIndex={0} role="button" aria-current={row.getAttribute('aria-current')==='true'} aria-label={row.getAttribute('aria-label')||undefined}>
    <input type="checkbox" defaultChecked={row.querySelector('input')!.checked} ref={node=>{if(node)node.checked=row.querySelector('input')!.checked;}} aria-label={row.querySelector('input')!.getAttribute('aria-label')||undefined}/>
    <div><strong>{row.querySelector('strong')?.textContent}</strong><small>{row.querySelector('small')?.textContent}</small></div>
   </div>)}</div>
  </section>;
 })}</>;
}
/** 每个 iframe 独立登记 React root，卸载和导航时全部释放。 */
export function createWorkbenchReactRenderer() {
 const roots=new Map<Element,Root>();
 const rootFor=(element:Element)=>{let root=roots.get(element);if(!root){root=createRoot(element);roots.set(element,root);}return root;};
 // 先释放内部孤岛再释放外层，避免对话框关闭后残留 detached React roots。
 const release=(container:Element)=>{for(const [element,root] of [...roots].reverse())if(element===container||container.contains(element)){flushSync(()=>root.unmount());roots.delete(element);}};
 const regions={templates:TemplatePicker,'template-save':TemplateSave,'addon-shell':AddonShell,'addon-fields':AddonFields,'addon-items':AddonItems,'addon-choices':AddonChoices,'config-cost':CostDialog,'cost-summary':CostSummary};
 return {
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
    for(const attribute of node.attributes)if(!['data-config','data-react-config','value'].includes(attribute.name))attributes[attribute.name==='inputmode'?'inputMode':attribute.name]=attribute.value;
    if(!surface.hasAttribute('data-react-field')){surface=document.createElement('span');surface.dataset.reactField=field;surface.style.display='contents';node.replaceWith(surface);}
    flushSync(()=>rootFor(surface).render(<ConfigField key={String(config.id)} field={field} configId={String(config.id)} value={String(config[field]??'')} attributes={attributes} checkpoint={checkpoint} edit={edit}/>));
   }
  },
  dispose(){for(const [,root] of [...roots].reverse())root.unmount();roots.clear();},
 };
}
