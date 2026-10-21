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
  // Agent 解锁会给原生控件留下 style=""；下一次输入触发重绘仍须保留五个字段。
  document.body.insertAdjacentHTML('beforeend','<section id="styled-fields">'+['name','version','spu','skuId','shortName'].map(field=>`<label>${field}<input data-config="${field}" id="field-${field}" class="config-field" inputmode="text" placeholder="请输入" aria-label="${field}" style=""></label>`).join('')+'</section>');
  const styledRenderer=createWorkbenchReactRenderer(),styledConfig={id:'styled-a',name:'名称',version:'原版本',spu:'100',skuId:'200',shortName:'简称'};
  const repaint=()=>styledRenderer.fields(document,styledConfig,()=>{},(field,value)=>{styledConfig[field]=value;repaint();});
  repaint();
  const styledVersion=document.querySelector('[data-config="version"]');
  styledVersion.style.setProperty('--field-marker','7');styledVersion.style.color='rgb(1, 2, 3)';
  styledVersion.focus();styledVersion.value='A不同字段';styledVersion.dispatchEvent(new InputEvent('input',{bubbles:true}));
  const styledFieldsSurvive=document.querySelectorAll('#styled-fields [data-config]').length===5&&document.querySelector('[data-config="version"]')===styledVersion&&styledVersion.value==='A不同字段'&&styledConfig.version==='A不同字段';
  const styledAttributesPreserved=styledVersion.id==='field-version'&&styledVersion.className==='config-field'&&styledVersion.inputMode==='text'&&styledVersion.placeholder==='请输入'&&styledVersion.getAttribute('aria-label')==='version'&&styledVersion.style.getPropertyValue('--field-marker')==='7'&&styledVersion.style.color==='rgb(1, 2, 3)';
  styledVersion.style.color='';styledVersion.style.removeProperty('--field-marker');
  repaint();repaint();
  const unlockedFieldsSurvive=document.querySelectorAll('#styled-fields [data-config]').length===5&&styledVersion.getAttribute('style')==='';
  styledVersion.blur();styledConfig.id='styled-b';styledConfig.version='另一配置版本';repaint();
  const styledSwitch=document.querySelector('[data-config="version"]')!==styledVersion&&document.querySelector('[data-config="version"]').value==='另一配置版本';
  styledRenderer.dispose();
  const {mountProductSearch,destroyProductSearch}=await import('/workbench/product-search.js');
  const search=document.createElement('div');search.innerHTML='<input>';document.body.append(search);const searchInput=search.querySelector('input');let selections=0;
  const options={getRows:()=>[],inputElement:searchInput,onChange:()=>selections++};
  mountProductSearch(search,options);mountProductSearch(search,options);
  const oneSearch=search.querySelectorAll('[data-product-results]').length===1;
  searchInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));destroyProductSearch(search);
  searchInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
  return {preserved,switched,stable,styledFieldsSurvive,styledAttributesPreserved,unlockedFieldsSurvive,styledSwitch,changes,checkpoints,empty:!list.querySelector('[data-id]'),oneSearch,selections,destroyed:!search.querySelector('[data-product-results]')};
 });
 assert.equal(result.preserved,true);assert.equal(result.switched,true);assert.equal(result.stable,true);assert.equal(result.empty,true);assert.deepEqual(result.changes,['中文未完成']);assert.equal(result.checkpoints,1);assert.deepEqual(errors,[]);assert.equal(result.oneSearch,true);assert.equal(result.selections,1);assert.equal(result.destroyed,true);
 assert.equal(result.styledFieldsSurvive,true);assert.equal(result.styledAttributesPreserved,true);assert.equal(result.unlockedFieldsSurvive,true);assert.equal(result.styledSwitch,true);
 console.log(JSON.stringify({status:'passed',...result},null,2));
}finally{await browser.close();}
