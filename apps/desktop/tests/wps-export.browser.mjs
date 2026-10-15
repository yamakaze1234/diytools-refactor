import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://wps.test/**',async route=>{
  const name=new URL(route.request().url()).pathname;
  await route.fulfill({contentType:name==='/'?'text/html':name.endsWith('.css')?'text/css':'text/javascript',body:name==='/'?'<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><dialog id="dialog"><h3>导出回 WPS</h3><div id="dialog-body"></div></dialog>':await fs.readFile(path.join(path.resolve('apps/desktop/public/workbench'),name))});
 });
 await page.goto('https://wps.test/');
 await page.evaluate(async()=>{
  const {openWpsExport}=await import('/wps-export.js');
  openWpsExport(Array.from({length:3},(_,i)=>({name:`配置${i+1}`,price:8899,parts:[{slot:'CPU',name:'原始名',displayName:'展示 CPU',qty:1},{slot:'内存',name:'测试内存',qty:2}]})),{openDialog:(_,html)=>{document.querySelector('#dialog-body').innerHTML=html;document.querySelector('#dialog').showModal();}});
 });
 assert.equal(await page.locator('#wps-export-preview tr').count(),57);
 assert.match(await page.locator('#wps-export-hint').innerText(),/F1.*H57/);
 await page.locator('#wps-export-layout').selectOption('EH');
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.startsWith('已复制'));
 const clip=await page.evaluate(async()=>{const items=await navigator.clipboard.read();return{text:await(await items[0].getType('text/plain')).text(),html:await(await items[0].getType('text/html')).text()};});
 assert.match(clip.text,/=G2\*0.98-A2/);assert.match(clip.text,/=G21\*0.98-A21/);assert.match(clip.text,/=G40\*0.98-A40/);
 assert.match(clip.html,/background:\s*rgb\(255, 255, 204\)|background:#ffffcc/);
 assert.match(clip.text,/展示 CPU/);assert.ok(!clip.text.includes('原始名'));
 await page.locator('#wps-export-row').fill('20');assert.match(await page.locator('#wps-export-preview').innerText(),/=G21\*0.98-A21/);
 await page.locator('#wps-export-row').fill('0');assert.equal(await page.locator('#wps-export-copy').isDisabled(),true);
 // WebView 剪贴板 API 不可用时，通过原生 copy 事件保留两种格式。
 await page.locator('#wps-export-row').fill('1');
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});});
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.startsWith('已复制'));
 assert.deepEqual(errors,[]);
 console.log('PASS: 3 blocks, layout switch, formula offsets, styled system clipboard, invalid row, copy-event fallback');
}finally{await browser.close();}
