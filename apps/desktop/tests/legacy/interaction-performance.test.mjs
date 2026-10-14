import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPosterEditor} from '../../public/workbench/poster-editor.js';
import {mountWorkspaceResize} from '../../public/workbench/workspace-resize.js';
import {observeEmptyErrors} from '../../public/workbench/ui-feedback.js';
import {installColorPicker} from '../../public/workbench/color-picker.js';

// Execute the production modules against an instrumented DOM. Operation counts
// are deterministic regression evidence, not browser layout/GPU timing claims.
function dom(t) {
 const counts={rectReads:0,dimensionReads:0,styleWrites:0,scrollWrites:0,gridWrites:0,queries:[]};
 const observers=[],resizes=[],frames=new Map(),storage=new Map(),windowEvents=new Map();let frameId=0;
 class Element {
  constructor(tag='div') {
   this.tagName=tag.toUpperCase();this.nodeType=1;this.parentElement=null;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.value='';this.textContent='';this.width=1000;this.height=2000;this.capture=null;this.open=false;
   const classes=new Set();this.classList={contains:name=>classes.has(name),add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),toggle:(name,force)=>{const next=force??!classes.has(name);next?classes.add(name):classes.delete(name);return next;}};
   Object.defineProperty(this,'className',{get:()=>[...classes].join(' '),set:value=>{classes.clear();String(value).split(/\s+/).filter(Boolean).forEach(name=>classes.add(name));}});
   this.style=new Proxy({removeProperty:property=>{if(property==='grid-template-columns')delete this.style.gridTemplateColumns;else delete this.style[property];}}, {set:(target,key,value)=>{counts.styleWrites++;if(key==='gridTemplateColumns')counts.gridWrites++;target[key]=value;return true;}});
   for(const [name,value] of [['clientWidth',1600],['clientHeight',800],['clientTop',0]])Object.defineProperty(this,name,{configurable:true,get:()=>{counts.dimensionReads++;return this[name+'Value']??value;}});
   for(const name of ['scrollTop','scrollLeft']){let value=0;Object.defineProperty(this,name,{get:()=>value,set:next=>{counts.scrollWrites++;value=next;}});}
  }
  get isConnected(){return document.body.contains(this);}
  get childNodes(){return this.children;}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();if(part.startsWith('#'))return this.attributes.id===part.slice(1);if(part.startsWith('.'))return this.classList.contains(part.slice(1));if(part.startsWith('input[type="color"]'))return this.tagName==='INPUT'&&this.attributes.type==='color'&&!('data-native-color' in this.attributes);return this.tagName===part.toUpperCase();});}
  contains(node){return this===node||this.children.some(child=>child.contains?.(node));}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){counts.queries.push({root:this,selector});const found=[];const walk=node=>{for(const child of node.children){if(child.matches(selector))found.push(child);walk(child);}};walk(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  append(...nodes){for(const node of nodes){if(node.parentElement){const old=node.parentElement.children;old.splice(old.indexOf(node),1);}node.parentElement=this;this.children.push(node);}}
  before(node){const parent=this.parentElement;node.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,node);}
  replaceChildren(...nodes){this.children.forEach(node=>node.parentElement=null);this.children=[];this.append(...nodes);}
  set innerHTML(value){this.replaceChildren();for(const match of value.matchAll(/<([a-z]+)\b([^>]*)>/gi)){const child=new Element(match[1]);for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))child.setAttribute(attr[1],attr[2]);if(/\bdata-native-color\b/.test(match[2]))child.setAttribute('data-native-color','');this.append(child);}}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='class')this.className=value;}
  getAttribute(name){return this.attributes[name]??null;}
  addEventListener(name,callback){this.listeners.set(name,callback);}
  dispatchEvent(event){this.listeners.get(event.type)?.(event);this['on'+event.type]?.(event);return true;}
  getBoundingClientRect(){counts.rectReads++;let width=this.clientWidthValue??240,left=0,top=0;if(this===sidebar)width=columnWidths().left;if(this===preview){width=columnWidths().right;left=1600-width;}if(this===stage)top=30-scroll.scrollTop;return{top,left,right:left+width,width,height:800};}
  setPointerCapture(pointer){this.capture=pointer;}
  hasPointerCapture(pointer){return this.capture===pointer;}
  releasePointerCapture(){this.capture=null;}
  showModal(){this.open=true;}
  close(){this.open=false;}
 }
 const body=new Element('body');const document={body,activeElement:null,createElement:tag=>new Element(tag),querySelector:selector=>body.matches(selector)?body:body.querySelector(selector),querySelectorAll:selector=>body.querySelectorAll(selector),addEventListener(name,callback){document[name]=callback;}};
 const add=(parent,tag,attributes={})=>{const node=new Element(tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);parent.append(node);return node;};
 const workspace=add(body,'div',{class:'workspace'}),sidebar=add(workspace,'aside',{class:'sidebar'}),preview=add(workspace,'aside',{class:'preview-side'}),scroll=add(preview,'div',{id:'preview-scroll'}),stage=add(scroll,'div',{id:'poster-stage'});
 add(scroll,'div',{class:'canvas-tools'});add(stage,'canvas',{id:'poster'});add(stage,'div',{id:'poster-selection'});add(stage,'span',{id:'poster-selection-label'});add(preview,'div',{id:'poster-inspector'});
 for(const id of ['poster-format-copy','poster-format-paste','poster-add-image','poster-image-file','poster-image-select','poster-undo','poster-redo','poster-auto-layout','poster-zoom','poster-pick-mode','poster-object-select','poster-layer-control'])add(preview,'input',{id});
 document.querySelector('#poster-zoom').value='fit';
 const columnWidths=()=>{const match=/^(\d+)px .* (\d+)px$/.exec(workspace.style.gridTemplateColumns??'');return match?{left:Number(match[1]),right:Number(match[2])}:{left:248,right:400};};
 const globals={document,window:{innerWidth:1600,addEventListener:(name,callback)=>windowEvents.set(name,callback)},innerWidth:1600,innerHeight:900,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(root,options){this.root=root;this.options=options;}disconnect(){this.disconnected=true;}},ResizeObserver:class{constructor(callback){this.callback=callback;resizes.push(this);}observe(){}},requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>frames.delete(id),getComputedStyle:()=>({paddingLeft:'12',paddingRight:'12',paddingBottom:'12'})};
 const previous=new Map();for(const [key,value]of Object.entries(globals)){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 t.after(()=>{for(const [key,descriptor]of previous)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
 const reset=()=>{for(const key of Object.keys(counts))counts[key]=key==='queries'?[]:0;};
 const flush=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(callback=>callback());};
 return{counts,observers,resizes,frames,storage,windowEvents,document,body,workspace,sidebar,preview,scroll,stage,add,columnWidths,reset,flush};
}
const poster=(height=1336)=>({base:668,height,textRegions:[],regions:[],addedImageRegions:[]});
const pointer=(clientX=200,pointerId=1)=>({button:0,pointerId,clientX,preventDefault(){}});

test('same-size poster redraws do not read layout, write stage size, or reset scroll',t=>{
 const env=dom(t),editor=bindPosterEditor({current:()=>({id:'a',posterImages:[]})});editor.render(poster());env.scroll.scrollTop=100;env.scroll.scrollLeft=20;env.reset();
 for(let i=0;i<120;i++)editor.render(poster());
 assert.deepEqual([env.counts.rectReads,env.counts.dimensionReads,env.counts.styleWrites,env.counts.scrollWrites],[0,0,0,0]);assert.equal(env.scroll.scrollTop,100);assert.equal(env.scroll.scrollLeft,20);
 t.diagnostic('120 renders: before rect=240/client=360/style=240/scroll=240; after all=0 (instrumented DOM).');
});
test('poster geometry and container changes still fit while retaining scroll',t=>{
 const env=dom(t);let configId='a';const editor=bindPosterEditor({current:()=>({id:configId,posterImages:[]})});editor.render(poster());const oldWidth=parseFloat(env.stage.style.width);env.scroll.scrollTop=100;env.scroll.scrollLeft=20;env.reset();
 editor.render(poster(2672));assert.ok(parseFloat(env.stage.style.width)<oldWidth);assert.equal(env.counts.rectReads,2);assert.equal(env.scroll.scrollTop,100);assert.equal(env.scroll.scrollLeft,20);
 env.scroll.clientHeightValue=600;const width=parseFloat(env.stage.style.width);env.resizes[0].callback();assert.ok(parseFloat(env.stage.style.width)<width);
 configId='b';env.reset();editor.render(poster(2672));assert.equal(env.counts.rectReads,2);assert.equal(env.counts.scrollWrites,0);
 env.document.querySelector('#poster-zoom').value='150';env.document.querySelector('#poster-zoom').onchange();assert.equal(env.stage.style.width,'1050px');env.reset();editor.render(poster(3000));assert.equal(env.counts.rectReads,0);assert.equal(env.stage.style.width,'1050px');
});
test('preview resolution notifications follow zoom and fit without a render loop',t=>{
 const env=dom(t);let requests=0;const editor=bindPosterEditor({current:()=>({id:'a',layout:'long',posterImages:[]}),previewResolutionChanged:()=>requests++});
 const fitWidth=Math.floor((800-30-12-2)/2);editor.render({...poster(),canvas:{width:fitWidth},exportWidth:1000});assert.equal(requests,0);env.resizes[0].callback();assert.equal(requests,0);
 const zoom=env.document.querySelector('#poster-zoom');zoom.value='150';zoom.onchange();assert.equal(requests,1);assert.equal(editor.previewWidth(),1050);editor.render({...poster(),canvas:{width:1000},exportWidth:1000});
 zoom.value='200';zoom.onchange();assert.equal(requests,1,'same capped raster width does not rerender');zoom.value='fit';zoom.onchange();assert.equal(requests,2);editor.render({...poster(),canvas:{width:fitWidth},exportWidth:1000});env.resizes[0].callback();assert.equal(requests,2);
 editor.render({...poster(2672),canvas:{width:fitWidth},exportWidth:1000});assert.equal(requests,3);editor.render({...poster(2672),canvas:{width:Math.floor(fitWidth/2)},exportWidth:1000});env.resizes[0].callback();assert.equal(requests,3);
});
test('column pointer events apply only the latest width once per animation frame',t=>{
 const env=dom(t);mountWorkspaceResize(env.workspace);const handle=env.workspace.children.find(node=>node.dataset.resizeColumn==='left');handle.onpointerdown(pointer());env.reset();
 for(let i=0;i<240;i++)handle.onpointermove(pointer(200+i));
 assert.equal(env.frames.size,1);assert.equal(env.counts.gridWrites,0);assert.equal(env.counts.dimensionReads,0);env.flush();assert.equal(env.counts.gridWrites,1);assert.equal(env.columnWidths().left,487);
 t.diagnostic('240 pointermoves before rAF: before client=480/grid=240; after client=0/grid=0; frame applies grid once.');
});
test('column release flushes the final move and persists it before a queued frame',t=>{
 const env=dom(t);mountWorkspaceResize(env.workspace);const handle=env.workspace.children.find(node=>node.dataset.resizeColumn==='right');handle.onpointerdown(pointer());handle.onpointermove(pointer(140));handle.onpointerup();
 assert.equal(env.frames.size,0);assert.deepEqual(JSON.parse(env.storage.get('diy-workspace-widths-v1')),{left:248,right:460});assert.equal(handle.capture,null);assert.equal(env.columnWidths().right,460);
});
test('column cancel restores the previous saved widths and discards pending moves',t=>{
 const env=dom(t);env.storage.set('diy-workspace-widths-v1',JSON.stringify({left:280,right:420}));mountWorkspaceResize(env.workspace);const handle=env.workspace.children.find(node=>node.dataset.resizeColumn==='left');handle.onpointerdown(pointer());handle.onpointermove(pointer(300));env.flush();assert.equal(env.columnWidths().left,380);handle.onpointermove(pointer(400));handle.onpointercancel();
 assert.equal(env.frames.size,0);assert.deepEqual(env.columnWidths(),{left:280,right:420});assert.deepEqual(JSON.parse(env.storage.get('diy-workspace-widths-v1')),{left:280,right:420});assert.equal(handle.capture,null);
 handle.onpointerdown(pointer());handle.onpointermove(pointer(500));env.windowEvents.get('blur')();assert.deepEqual(env.columnWidths(),{left:280,right:420});
});
test('canceling an unsaved column resize restores CSS defaults without persisting',t=>{
 const env=dom(t);mountWorkspaceResize(env.workspace);const handle=env.workspace.children.find(node=>node.dataset.resizeColumn==='left');handle.onpointerdown(pointer());handle.onpointermove(pointer(500,2));assert.equal(env.frames.size,0);handle.onpointermove(pointer(300));env.flush();assert.equal(env.columnWidths().left,348);handle.onpointermove(pointer(400));handle.onlostpointercapture();
 assert.equal(env.frames.size,0);assert.deepEqual(env.columnWidths(),{left:248,right:400});assert.equal(env.workspace.style.gridTemplateColumns,undefined);assert.equal(env.storage.has('diy-workspace-widths-v1'),false);
});
test('error observer scans added subtrees and updates enclosing errors without root rescans',t=>{
 const env=dom(t),existing=env.add(env.workspace,'div',{class:'error'});const disconnect=observeEmptyErrors(env.body),observer=env.observers[0];assert.ok(existing.classList.contains('is-empty-error'));env.reset();
 const status=env.add(env.workspace,'span');observer.callback([{type:'characterData',target:{nodeType:3,parentElement:status}}]);assert.equal(env.counts.queries.length,0);
 const subtree=env.add(env.workspace,'section'),added=env.add(subtree,'div',{class:'error'});observer.callback([{type:'childList',target:env.workspace,addedNodes:[subtree]}]);assert.ok(added.classList.contains('is-empty-error'));assert.ok(env.counts.queries.every(query=>query.root!==env.body));
 added.textContent='保存失败';observer.callback([{type:'characterData',target:{nodeType:3,parentElement:added}}]);assert.ok(!added.classList.contains('is-empty-error'));
 added.textContent='';const retry=env.add(added,'button');observer.callback([{type:'childList',target:added,addedNodes:[retry]}]);assert.ok(!added.classList.contains('is-empty-error'));disconnect();assert.ok(observer.disconnected);
});
test('error text changes refresh enclosing nested errors and ignore detached additions',t=>{
 const env=dom(t),outer=env.add(env.workspace,'div',{class:'error'}),inner=env.add(outer,'div',{class:'error'});observeEmptyErrors(env.body);const observer=env.observers[0];assert.ok(outer.classList.contains('is-empty-error'));assert.ok(inner.classList.contains('is-empty-error'));
 outer.textContent='失败';inner.textContent='失败';env.reset();observer.callback([{type:'characterData',target:{nodeType:3,parentElement:inner}}]);assert.ok(!inner.classList.contains('is-empty-error'));assert.ok(!outer.classList.contains('is-empty-error'));assert.ok(env.counts.queries.every(query=>query.root!==env.body));
 const detached=env.add(env.workspace,'div',{class:'error'});env.workspace.children.splice(env.workspace.children.indexOf(detached),1);detached.parentElement=null;observer.callback([{type:'childList',target:env.workspace,addedNodes:[detached]}]);assert.ok(!detached.classList.contains('is-empty-error'));
});
test('color observer enhances new roots and descendants, retains working input updates',t=>{
 const env=dom(t);installColorPicker({checkpoint(){},current:()=>({theme:'light'})});const observer=env.observers[0];env.reset();
 observer.callback([{type:'childList',target:env.workspace,addedNodes:[{nodeType:3}]}]);assert.equal(env.counts.queries.length,0);
 const subtree=env.add(env.workspace,'section'),input=env.add(subtree,'input',{type:'color'});input.value='#123456';observer.callback([{type:'childList',target:env.workspace,addedNodes:[subtree]}]);assert.ok(input.closest('.color-field-trigger'));assert.ok(env.counts.queries.every(query=>query.root!==env.body));
 const value=input.parentElement.querySelector('.color-field-value');assert.equal(value.textContent,'#123456');input.value='#abcdef';input.dispatchEvent(new Event('input'));assert.equal(value.textContent,'#ABCDEF');
 const wrapper=input.parentElement;observer.callback([{type:'childList',target:subtree,addedNodes:[wrapper,input]}]);assert.equal(input.parentElement,wrapper);assert.equal(wrapper.querySelectorAll('.color-field-trigger').length,0);
 const direct=env.add(env.workspace,'input',{type:'color'});direct.value='#654321';observer.callback([{type:'childList',target:env.workspace,addedNodes:[direct]}]);assert.ok(direct.closest('.color-field-trigger'));
 const native=env.add(env.workspace,'input',{type:'color','data-native-color':''});observer.callback([{type:'childList',target:env.workspace,addedNodes:[native]}]);assert.equal(native.parentElement,env.workspace);
 env.document.click({target:input,preventDefault(){},stopPropagation(){}});assert.ok(env.body.querySelector('.color-picker-dialog').open);
});
