import {sourceComparisonHtml} from '../public/workbench/source-sync-data.js';
import {slots} from '../public/workbench/core.js';
import {capacityFieldsHtml,readCapacityFields,updateCapacityHints} from '../public/workbench/source-capacity-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/workbench/source-editor.js',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').replace('export function openSourceEditor','function openSourceEditor');

// A small DOM fixture: replacing dialog-body detaches its descendants just as
// innerHTML does in the browser, while retained node references keep input values.
class Element {
 constructor(tag='div',attributes={}){this.tag=tag;this.attributes=attributes;this.childNodes=[];this.parentNode=null;this.value=attributes.value||'';this.checked='checked' in attributes;this.disabled='disabled' in attributes;this.listeners=new Map();this.classList={add(){},remove(){},toggle(){}};this.dataset=Object.fromEntries(Object.entries(attributes).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));}
 remove(){if(this.parentNode)this.parentNode.childNodes=this.parentNode.childNodes.filter(n=>n!==this);this.parentNode=null;}
 close(){if(this.open){this.open=false;this.dispatch('close');}}
 showModal(){this.open=true;}
 get isConnected(){return this.tag==='document'||!!this.parentNode?.isConnected;}
 append(...nodes){for(const node of nodes){if(node.parentNode)node.parentNode.childNodes=node.parentNode.childNodes.filter(n=>n!==node);node.parentNode=this;this.childNodes.push(node);}}
 set innerHTML(html){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];const stack=[this];for(const match of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)){const text=match[0];if(text.startsWith('</')){if(stack.length>1)stack.pop();continue;}if(!text.startsWith('<')){const node=stack.at(-1);if(node.tag==='textarea')node.value+=text;continue;}const tag=text.match(/^<(\w+)/)[1];const attributes={};for(const m of text.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:="([^"]*)")?/g))attributes[m[1]]=m[2]??'';const node=new Element(tag,attributes);stack.at(-1).append(node);if(!['input','br','hr','img'].includes(tag))stack.push(node);}}
 matches(selector){if(selector.includes(' ')){const parts=selector.split(/\s+/);return this.matches(parts.pop())&&!!this.parentNode?.closest(parts.join(' '));}if(selector.endsWith(':checked'))return this.checked&&this.matches(selector.slice(0,-8));if(selector.startsWith('#'))return this.attributes.id===selector.slice(1);if(selector.startsWith('.'))return (this.className||this.attributes.class||'').split(/\s+/).includes(selector.slice(1));const attr=selector.match(/^(\w*)\[([^=\]]+)(?:="?([^"\]]*)"?)?\]$/);if(attr)return(!attr[1]||this.tag===attr[1])&&attr[2] in this.attributes&&(attr[3]===undefined||this.attributes[attr[2]]===attr[3]);return this.tag===selector;}
 closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)||null;}
 setAttribute(name,value){this.attributes[name]=value;}
 querySelectorAll(selector){const result=[];const walk=node=>{for(const child of node.childNodes){if(selector.split(',').some(s=>child.matches(s)))result.push(child);walk(child);}};walk(this);return result;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 addEventListener(name,fn,options={}){const entry={fn,options};if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(entry);options.signal?.addEventListener('abort',()=>{this.listeners.set(name,this.listeners.get(name).filter(e=>e!==entry));});}
 removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(entry=>entry.fn!==fn));}
 dispatch(name){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};for(const entry of [...this.listeners.get(name)||[]]){entry.fn(event);if(entry.options.once)this.listeners.set(name,this.listeners.get(name).filter(e=>e!==entry));}return event;}
}

function harness({apply,realSync=false}={}){
 const document=new Element('document');document.createElement=tag=>new Element(tag);document.body=document;
 const dialog=new Element('dialog',{id:'dialog'}),form=new Element('form'),body=new Element('div',{id:'dialog-body'});
 document.append(dialog);dialog.append(form,body);dialog.open=true;
 const rows=[{sourceId:'s',shopId:'intel',name:'原名称',goodsId:'',specialComponent:true,tax:0,upgrade:'',addonText:'',addonNote:''}],writes=[];
 const api={shopId:()=> 'intel',getRows:()=>rows,getAllRows:()=>rows,getCosts:()=>[],getConfigs:()=>[],openDialog:(_title,html)=>{body.innerHTML=html;dialog.open=true;},async applyBatch(entries){writes.push(structuredClone(entries));await apply?.(entries,api);for(const entry of entries)Object.assign(rows.find(r=>r.sourceId===entry.row.sourceId),entry.row);return{count:entries.length,configIds:[]};}};
 const context=vm.createContext({sourceComparisonHtml,slots,capacityFieldsHtml,readCapacityFields,updateCapacityHints,document,window:{},AbortController,structuredClone,clone:value=>structuredClone(value),requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),confirm:()=>true,configCostLinksHtml:()=>'',componentStockHtml:()=>'',mountSourceSync:()=>({invalidate(){},async refresh(){},dispose(){},isBusy:()=>false,showAutomaticChanges(){}}),isSpecialComponent:r=>!!r.specialComponent,normalizeSpecialComponent:r=>r,erpUnitCost:()=>({cents:0}),sourceAddon:r=>({text:r.addonText||'',note:r.addonNote||''}),sourceAddonFields:a=>({addonText:a.text,addonNote:a.note}),excludedComponent:()=>false,shops:[{id:'intel'}]});
 if(realSync){
  context.queueMicrotask=()=>{};context.sourceFollowPlan=()=>({changes:[]});api.flush=async()=>{};
  const syncSource=readFileSync(new URL('../public/workbench/source-sync-ui.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function mountSourceSync','function mountSourceSync');
  context.mountSourceSync=vm.runInContext('(function(){'+syncSource+';return mountSourceSync;})()',context);
 }
 vm.runInContext(source,context);context.openSourceEditor(api);
 return{document,dialog,body,api,rows,writes,context,editor:context.window.workbenchSourceEditor};
}

test('unmodified source editor replaced by conflict panel does not invent unsaved changes or fail on quit',async()=>{
 const env=harness();assert.equal(env.editor.hasPending(),false);
 env.api.openDialog('保存版本需要比较','<p id="save-conflict">需要重新比较</p>');
 assert.equal(env.document.querySelector('#source-message'),null);
 assert.equal(env.editor.hasPending(),false);await env.editor.save();assert.equal(env.writes.length,0);
 env.dialog.dispatch('close');assert.equal(env.context.window.workbenchSourceEditor,undefined);
});

test('detached edited source inputs remain saveable and do not read same-id fields from replacement dialog',async()=>{
 const env=harness();env.document.querySelector('#source-name').value='本次未保存名称';
 env.api.openDialog('保存版本需要比较','<textarea id="source-name">其他弹窗内容</textarea>');
 assert.equal(env.editor.hasPending(),true);await env.editor.save();
 assert.equal(env.writes.length,1);assert.equal(env.writes[0][0].row.name,'本次未保存名称');
 assert.equal(env.rows[0].name,'本次未保存名称');assert.equal(env.editor.hasPending(),false);
 assert.equal(env.document.querySelector('#source-name').value,'其他弹窗内容');
});

test('save conflict retains pending entries, closing conflict panel allows dismissal, reopening restores same draft and retry',async()=>{
 let fail=true;const env=harness({apply:async(_entries,api)=>{if(fail){api.openDialog('保存版本需要比较','<p>请比较</p>');throw Error('版本发生变化');}}});
 const input=env.document.querySelector('#source-name');input.value='仍需保存的输入';
 await assert.rejects(env.editor.save(),/版本发生变化/);assert.equal(env.editor.hasPending(),true);
 assert.equal(env.dialog.dispatch('cancel').defaultPrevented,false);
 env.dialog.dispatch('close');assert.equal(env.context.window.workbenchSourceEditor,env.editor);
 env.context.openSourceEditor(env.api);
 assert.equal(env.context.window.workbenchSourceEditor,env.editor);assert.equal(env.document.querySelector('#source-name'),input);
 assert.equal(input.value,'仍需保存的输入');assert.equal(env.dialog.dispatch('cancel').defaultPrevented,true);
 fail=false;await env.editor.save();assert.equal(env.rows[0].name,'仍需保存的输入');assert.equal(env.editor.hasPending(),false);
 env.dialog.dispatch('close');assert.equal(env.context.window.workbenchSourceEditor,undefined);
});

test('invalid detached draft blocks quitting with validation error and remains available for correction',async()=>{
 const env=harness();env.document.querySelector('#source-name').value='';
 env.api.openDialog('保存版本需要比较','<p>请比较</p>');
 await assert.rejects(env.editor.save(),/尚未通过校验/);assert.equal(env.writes.length,0);
 env.dialog.dispatch('close');assert.equal(env.context.window.workbenchSourceEditor,env.editor);
 env.editor.restore();assert.equal(env.document.querySelector('#source-name').value,'');
 assert.match(env.document.querySelector('#source-message').textContent,/请填写产品显示名称/);
});

test('saved editor close removes child-panel listeners while a conflict retains the unsaved editor and its guards',async()=>{
 const env=harness({realSync:true}),cancelCount=()=>env.dialog.listeners.get('cancel').length;
 assert.equal(cancelCount(),1);
 const children=env.document.querySelectorAll('.source-changes-dialog');assert.equal(children.length,2);for(const child of children)assert.equal(child.listeners.get('cancel').length,1);
 env.document.querySelector('#source-name').value='保留的草稿';
 env.api.openDialog('保存版本需要比较','<p>请比较</p>');env.dialog.dispatch('close');
 assert.equal(cancelCount(),1);assert.equal(env.context.window.workbenchSourceEditor,env.editor);
 env.editor.restore();await env.editor.save();env.dialog.dispatch('close');
 assert.equal(cancelCount(),0);assert.equal(env.context.window.workbenchSourceEditor,undefined);
 for(const child of children){assert.equal(child.isConnected,false);assert.equal(child.listeners.get('cancel').length,0);}
 env.context.openSourceEditor(env.api);assert.equal(cancelCount(),1);
 env.dialog.dispatch('close');assert.equal(cancelCount(),0);
});

test('source sync releases its retained controls and does not block cancelling a replacement conflict dialog',async()=>{
 const document=new Element('document'),dialog=new Element('dialog'),body=new Element(),root=new Element();document.append(dialog);dialog.append(body);body.append(root);
 const before={id:'c',productId:'link'},detail={key:'c:name',field:'name',before:'旧名',after:'新名'};
 let rejectApply;const applied=new Promise((_resolve,reject)=>{rejectApply=reject;});
 const context=vm.createContext({sourceComparisonHtml,slots,capacityFieldsHtml,readCapacityFields,updateCapacityHints,structuredClone,queueMicrotask(){},sourceFollowPlan:(_configs,_rows,_fields,_shop,options)=>({changes:options&&!options.keys.length?[]:[{id:'c',before,product:'链接',name:'配置',details:[detail]}],sources:[],fields:['name'],shopId:'intel'})});
 const syncSource=readFileSync(new URL('../public/workbench/source-sync-ui.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function mountSourceSync','function mountSourceSync');
 vm.runInContext(syncSource,context);
 const panel=context.mountSourceSync(root,{message(){},isEdited:()=>false,flush:async()=>{},getRows:()=>[],getConfigs:()=>[before],shopId:()=> 'intel',apply:()=>applied});
 await panel.refresh();const event={stopPropagation(){}};
 const choice=root.querySelector('[data-source-select]');choice.checked=true;choice.onchange(event);
 const refresh=root.querySelector('#source-check');assert.equal(refresh.disabled,false);
 const flight=root.querySelector('#source-apply').onclick(event);assert.equal(refresh.disabled,true);assert.equal(dialog.dispatch('cancel').defaultPrevented,true);
 body.innerHTML='<p>保存版本需要比较</p>';assert.equal(root.isConnected,false);assert.equal(dialog.dispatch('cancel').defaultPrevented,false);
 rejectApply(Error('版本发生变化'));await flight;assert.equal(refresh.disabled,false);
 body.append(root);assert.equal(root.isConnected,true);assert.equal(refresh.disabled,false);
 assert.match(root.querySelector('[data-source-sync-message]').textContent,/版本发生变化/);
});

test('discarding source edits with no remaining rows leaves a closable empty editor',()=>{
 const env=harness();env.document.querySelector('#source-name').value='未保存修改';env.rows.length=0;
 assert.doesNotThrow(()=>env.document.querySelector('#source-discard-all').onclick());
 assert.equal(env.document.querySelector('#source-name'),null);assert.equal(env.editor.hasPending(),false);
 assert.equal(env.dialog.dispatch('cancel').defaultPrevented,false);
});
