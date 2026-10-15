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
  openWpsExport(Array.from({length:3},(_,i)=>({id:String(i),name:`配置${i+1}`,price:8899+i,parts:[{slot:'CPU',name:'原始名',displayName:'展示 CPU',qty:1},{slot:'内存',name:'测试内存',qty:2}]})),{selectedIds:new Set(['1']),openDialog:(_,html)=>{document.querySelector('#dialog-body').innerHTML=html;document.querySelector('#dialog').showModal();}});
 });
 assert.equal(await page.locator('#wps-export-preview tr').count(),19);
 assert.equal(await page.locator('[data-wps-export-index="1"]').isChecked(),true);
 assert.match(await page.locator('#wps-export-preview').innerText(),/定价/);
 assert.match(await page.locator('#wps-export-preview').innerText(),/8890|8900/);
 await page.locator('#wps-export-none').click();
 assert.equal(await page.locator('#wps-export-copy').isDisabled(),true);
 assert.equal(await page.locator('#wps-export-preview tr').count(),0);
 await page.locator('#wps-export-all').click();
 assert.equal(await page.locator('#wps-export-preview tr').count(),57);
 assert.match(await page.locator('#wps-export-hint').innerText(),/F1.*H57/);
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.startsWith('已复制'));
 const plain=await page.evaluate(async()=>{const [item]=await navigator.clipboard.read();return{types:item.types,text:await(await item.getType('text/plain')).text()};});
 assert.deepEqual(plain.types,['text/plain']);assert.match(plain.text,/展示 CPU/);
 assert.equal(await page.locator('#wps-export-layout').count(),0);
 assert.equal(await page.locator('#wps-export-cost-repair').count(),0);
 assert.ok(!plain.text.includes('XLOOKUP'));assert.ok(plain.text.split('\r\n').every(row=>row.split('\t').length===3));
 await page.locator('[data-wps-export-index="1"]').uncheck();
 assert.equal(await page.locator('#wps-export-preview tr').count(),38);
 const selectedText=await page.locator('#wps-export-preview').innerText();
 assert.match(selectedText,/8899/);assert.match(selectedText,/8901/);assert.ok(!selectedText.includes('8900'));
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.startsWith('已复制 2 套'));
 await page.locator('#wps-export-row').fill('20');
 assert.match(await page.locator('#wps-export-hint').innerText(),/F20.*H57/);
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.includes('F20'));
 const selectedCopy=await page.evaluate(()=>navigator.clipboard.readText());
 assert.match(selectedCopy,/8899/);assert.match(selectedCopy,/8901/);assert.ok(!selectedCopy.includes('8900'));
 await page.locator('#wps-export-row').fill('0');assert.equal(await page.locator('#wps-export-copy').isDisabled(),true);
 // WebView 剪贴板 API 不可用时，通过原生 copy 事件仍只写纯文本。
 await page.locator('#wps-export-row').fill('1');
 await page.evaluate(()=>{globalThis.originalClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});});
 await page.locator('#wps-export-copy').click();
 await page.waitForFunction(()=>document.querySelector('#wps-export-status').textContent.startsWith('已复制'));
 await page.locator('#wps-export-copy').click();
 assert.deepEqual(await page.evaluate(async()=>(await globalThis.originalClipboard.read())[0].types),['text/plain']);
 assert.deepEqual(errors,[]);
 console.log('PASS: FH only, selected defaults, all/none, nonadjacent selection, prices, target row, plain clipboard, invalid row, copy-event fallback');
}finally{await browser.close();}
