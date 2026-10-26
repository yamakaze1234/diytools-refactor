/** Real ReUI and gallery controller, synthetic gallery persistence only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)('playwright');
const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5199';
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==new URL(base).origin)return route.abort();return route.continue();});
 await page.route('**/workbench/gallery-reui-fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8">${['style','workbench-ui','workbench-simple','desktop-layout','ui-polish','reui-layout'].map(s=>'<link rel="stylesheet" href="/workbench/'+s+'.css">').join('')}</head><body><dialog id="dialog"><form method="dialog"><div class="dialog-title"><h2 id="dialog-title"></h2><button class="close">×</button></div></form><div id="dialog-body"></div></dialog><script type="module">
 import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');const {openCaseGallery}=await import('/workbench/case-gallery.js');
 const renderer=createWorkbenchReactRenderer(),body=document.querySelector('#dialog-body'),dialog=document.querySelector('#dialog');
 const img='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect x="45" y="12" width="90" height="150" rx="12" fill="#24292f"/><circle cx="90" cy="55" r="25" fill="#1f883d"/><circle cx="90" cy="117" r="25" fill="#656d76"/></svg>');
 let rows=Array.from({length:40},(_,i)=>({id:'g'+i,name:'隔离机箱'+i,brand:i<20?'乔思伯':'测试品牌',model:'S'+i,color:i%2?'白色':'黑色',edition:'标准版',url:img+'#'+i})),saved=[],picked=[];
 const api={openDialog:(title,html)=>{renderer.release(body);body.innerHTML=html;document.querySelector('#dialog-title').textContent=title;if(!dialog.open)dialog.showModal();},closeDialog:()=>dialog.close(),esc:s=>String(s).replace(/[&<>\"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[s])),toast:()=>{},getRows:()=>rows,getConfigs:()=>[{id:'c0',name:'合成配置',shopId:'intel',caseImage:img+'#0'}],saveRows:async(next,label)=>{rows=next;saved.push(label);},uploadImage:async()=>{throw Error('This test must not upload');},useImage:async row=>picked.push(row.id),operator:()=> '隔离验收',render:model=>renderer.dialog(body,'case-gallery',model),renderRegion:(container,kind,model)=>renderer.dialog(container,kind,model),release:container=>renderer.release(container)};
 dialog.addEventListener('close',()=>{if(dialog.open)return;renderer.release(body);body.replaceChildren();});
 window.galleryProbe={open:options=>openCaseGallery(api,options),snapshot:()=>structuredClone({rows,saved,picked})};window.galleryProbe.open({pick:true});
 </script></body></html>`}));
 await page.goto(base+'/workbench/gallery-reui-fixture');await page.locator('[data-reui-gallery]').waitFor();
 assert.equal(await page.locator('.gallery-card').count(),36);
 assert.equal(await page.locator('#gallery-prev').isDisabled(),true);
 await page.locator('#gallery-next').click();assert.equal(await page.locator('.gallery-card').count(),4);assert.equal(await page.locator('#gallery-next').isDisabled(),true);
 await page.locator('#gallery-prev').click();await page.locator('#gallery-search').fill('隔离机箱0');await page.waitForFunction(()=>document.querySelectorAll('.gallery-card').length===1);assert.equal(await page.locator('.gallery-card').count(),1);
 await page.locator('[data-gallery-open="g0"]').click();await page.locator('#gallery-edit').click();await page.locator('#gallery-name').fill('不应保存');await page.locator('#gallery-cancel').click();
 assert.equal((await page.evaluate(()=>galleryProbe.snapshot())).rows[0].name,'隔离机箱0');
 await page.locator('#gallery-edit').click();await page.locator('#gallery-name').fill('已编辑机箱');await page.locator('#gallery-save').click();await page.waitForFunction(()=>galleryProbe.snapshot().saved.length===1);await page.locator('#gallery-edit').waitFor();
 assert.equal((await page.evaluate(()=>galleryProbe.snapshot())).rows[0].name,'已编辑机箱');
 await page.locator('#gallery-delete').click();await page.locator('#gallery-delete-no').click();assert.equal(await page.locator('#gallery-delete-yes').count(),0);
 await page.locator('#gallery-delete').click();await page.locator('#gallery-delete-yes').click();await page.waitForFunction(()=>!!galleryProbe.snapshot().rows[0].deletedAt);
 await page.locator('#gallery-trash').click();await page.locator('[data-gallery-open="g0"]').click();await page.locator('#gallery-restore').click();await page.waitForFunction(()=>!galleryProbe.snapshot().rows[0].deletedAt);
 await page.locator('#gallery-trash').click();await page.locator('#gallery-search').fill('已编辑机箱');await page.locator('[data-gallery-use="g0"]').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);
 assert.deepEqual((await page.evaluate(()=>galleryProbe.snapshot())).picked,['g0']);
 await page.evaluate(()=>galleryProbe.open({}));await page.locator('#gallery-new').click();await page.locator('#gallery-name').fill('未上传新图');await page.locator('#gallery-cancel').click();assert.equal((await page.evaluate(()=>galleryProbe.snapshot())).rows.length,40);
 for(const width of [1024,1440]){await page.setViewportSize({width,height:900});const geometry=await page.locator('#dialog').evaluate(d=>({left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,width:innerWidth,body:document.querySelector('#dialog-body').getBoundingClientRect().height,grid:document.querySelector('#gallery-grid').getBoundingClientRect().height,overflow:d.scrollWidth-d.clientWidth}));assert.ok(Math.abs(geometry.left-(width-geometry.right))<2,JSON.stringify(geometry));assert.ok(geometry.grid>250,JSON.stringify(geometry));assert.ok(geometry.overflow<2,JSON.stringify(geometry));}
 await page.screenshot({path:fileURLToPath(new URL('../../../../gallery-reui.png',import.meta.url))});
 await page.locator('#dialog .close').click();await page.evaluate(()=>galleryProbe.open({pick:true}));assert.equal(await page.locator('[data-reui-gallery]').count(),1);
 assert.deepEqual(errors,[]);
 const result={passed:true,storage:'synthetic-gallery-callbacks',realController:true,realReUI:true,pagination:true,search:true,editSaveCancel:true,softDeleteRestore:true,pick:true,reopen:true,errors};await fs.writeFile(new URL('../../../../gallery-reui-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
