/** 隔离无窗口浏览器验收，不读取业务库或启动原生应用。先启动 Vite，再显式运行本文件。 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/react-fixture',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
 await page.goto('http://127.0.0.1:5194/react-fixture');
 const result=await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');
  document.body.innerHTML='<div id="list"></div><label>名称<input data-config="name"></label>';
  const renderer=createWorkbenchReactRenderer();let changes=[],checkpoints=0;
  const config={id:'a',name:'原名'},edit=(field,value)=>{config[field]=value;changes.push(value);};
  renderer.fields(document,config,()=>checkpoints++,edit);
  const input=document.querySelector('input');input.focus();input.value='中文未完成';input.setSelectionRange(2,4);
  input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'文'}));
  renderer.fields(document,{...config,name:'后台旧值'},()=>checkpoints++,edit);
  const preserved=input===document.querySelector('input')&&input.value==='中文未完成'&&document.activeElement===input&&input.selectionStart===2&&input.selectionEnd===4;
  input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));input.blur();
  renderer.fields(document,{id:'b',name:'另一配置'},()=>checkpoints++,edit);
  const switched=document.querySelector('input')!==input&&document.querySelector('input').value==='另一配置';
  const list=document.querySelector('#list');
  const markup=checked=>`<section class="product-group expanded" data-list-product="p"><div class="product-select-row">链接</div><div><div class="config-item active" data-id="a" aria-current="true" aria-label="打开"><input type="checkbox" ${checked?'checked':''}><div><strong>名称</strong><small>CPU</small></div></div></div></section>`;
  renderer.list(list,markup(false));const row=list.querySelector('[data-id]');row.focus();
  list.insertAdjacentHTML('beforeend','<section class="template-library-section">旧模板</section>');renderer.list(list,markup(true));
  const stable=row===list.querySelector('[data-id]')&&document.activeElement===row&&row.querySelector('input').checked&&!list.querySelector('.template-library-section');
  renderer.dispose();
  const {mountProductSearch,destroyProductSearch}=await import('/workbench/product-search.js');
  const search=document.createElement('div');search.innerHTML='<input>';document.body.append(search);const searchInput=search.querySelector('input');let selections=0;
  const options={getRows:()=>[],inputElement:searchInput,onChange:()=>selections++};
  mountProductSearch(search,options);mountProductSearch(search,options);
  const oneSearch=search.querySelectorAll('[data-product-results]').length===1;
  searchInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));destroyProductSearch(search);
  searchInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
  return {preserved,switched,stable,changes,checkpoints,empty:!list.querySelector('[data-id]'),oneSearch,selections,destroyed:!search.querySelector('[data-product-results]')};
 });
 assert.equal(result.preserved,true);assert.equal(result.switched,true);assert.equal(result.stable,true);assert.equal(result.empty,true);assert.deepEqual(result.changes,['中文未完成']);assert.equal(result.checkpoints,1);assert.deepEqual(errors,[]);assert.equal(result.oneSearch,true);assert.equal(result.selections,1);assert.equal(result.destroyed,true);
 console.log(JSON.stringify({status:'passed',...result},null,2));
}finally{await browser.close();}
