/** 实际隔离 Tauri 的视觉、动效与重复交互内存检查；不提交业务修改。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const output=new URL('../../../../',import.meta.url);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url()==='http://127.0.0.1:5201/');
assert.ok(page,'只允许连接 UI 设计隔离入口 5201');
await page.emulateMedia({reducedMotion:'no-preference'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.locator('iframe').waitFor();
const frame=await (await page.locator('iframe').elementHandle()).contentFrame();
await frame.waitForFunction(()=>window.workbenchReady);
const state=()=>frame.evaluate(async()=>{const s=await(await fetch('/api/state')).json();return {configs:s.configs,templates:s.templates};});
const before=await state();
if(await frame.locator('#dialog[open]').count())await frame.locator('#dialog .close').click();await frame.locator('#dialog[open]').waitFor({state:'hidden'});
if(!await frame.locator('.config-item').first().isVisible())await frame.locator('[data-product-toggle]').first().click();
await frame.locator('.config-item').first().click();
await frame.locator('[data-row-slot]').first().waitFor();
await frame.locator('#workbench-theme-toggle').evaluate(el=>{if(document.documentElement.dataset.workbenchTheme==='dark')el.click();});
const cycles=async count=>{for(let i=0;i<count;i++){
 await frame.locator('#link-parts').click();
 await frame.locator('#dialog[open]').waitFor();
 await frame.locator('#dialog .close').click();await frame.locator('#dialog[open]').waitFor({state:'hidden'});
 await frame.locator('#dialog[open]').waitFor({state:'hidden'});
 await frame.locator('.tabs [data-tab="actual"]').click();
 await frame.locator('.tabs [data-tab="parts"]').click();
}};
await cycles(4);
const cdp=await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
async function measure(){
 await frame.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
 await cdp.send('HeapProfiler.collectGarbage');
 const metrics=await cdp.send('Performance.getMetrics');
 const dom=await cdp.send('Memory.getDOMCounters');
 return {heapMiB:metrics.metrics.find(m=>m.name==='JSHeapUsedSize').value/1048576,...dom};
}
const baseline=await measure();
console.log(JSON.stringify({baseline}));
await cycles(6);const middle=await measure();console.log(JSON.stringify({middle}));
await cycles(6);const after=await measure();console.log(JSON.stringify({after}));
assert.ok(after.heapMiB-baseline.heapMiB<12,JSON.stringify({baseline,middle,after}));
assert.ok(after.nodes-baseline.nodes<200,JSON.stringify({baseline,middle,after}));
assert.ok(after.jsEventListeners-baseline.jsEventListeners<30,JSON.stringify({baseline,middle,after}));
// 动效真实触发；不是只声明未使用的 CSS。
const motion=await frame.locator('#link-parts').evaluate(el=>new Promise((resolve,reject)=>{
 const dialog=document.querySelector('#dialog');
 const done=event=>{if(event.animationName!=='workbench-panel-open')return;clearTimeout(timer);dialog.removeEventListener('animationstart',done);resolve({animations:[event.animationName],wipe:getComputedStyle(el,'::before').transitionDuration});};
 const timer=setTimeout(()=>{dialog.removeEventListener('animationstart',done);reject(Error('对话框动效未触发'));},5000);
 dialog.addEventListener('animationstart',done);el.click();
}));
assert.ok(motion.animations.includes('workbench-panel-open'),JSON.stringify(motion));
assert.equal(motion.wipe,'0.28s');
await frame.locator('#dialog .close').click();await frame.locator('#dialog[open]').waitFor({state:'hidden'});
const panelMotion=await frame.locator('.tabs [data-tab="actual"]').evaluate(el=>{el.click();return document.querySelector('#editor').getAnimations().length;});
assert.ok(panelMotion>0);
await frame.locator('.tabs [data-tab="parts"]').click();
await frame.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
await page.screenshot({path:new URL('native-endfield-light.png',output).pathname.replace(/^\/(\w:)/,'$1')});
await frame.locator('#workbench-theme-toggle').click();
await frame.waitForFunction(()=>document.documentElement.dataset.workbenchTheme==='dark');
await page.screenshot({path:new URL('native-endfield-dark.png',output).pathname.replace(/^\/(\w:)/,'$1')});
await page.emulateMedia({reducedMotion:'reduce'});
await frame.locator('#link-parts').click();
assert.equal(await frame.locator('#dialog').evaluate(n=>n.getAnimations().filter(a=>a.playState==='running').length),0);
await frame.locator('#dialog .close').click();await frame.locator('#dialog[open]').waitFor({state:'hidden'});
await frame.locator('.tabs [data-tab="actual"]').click();
assert.equal(await frame.locator('#editor').evaluate(n=>n.getAnimations().length),0);
await frame.locator('.tabs [data-tab="parts"]').click();
await page.emulateMedia({reducedMotion:'no-preference'});
await frame.locator('#workbench-theme-toggle').click();
assert.deepEqual(await state(),before);
assert.deepEqual(errors,[]);
const result={passed:true,scope:'native-tauri-isolated-sample-data',repeatCycles:12,baseline,middle,after,heapGrowthMiB:after.heapMiB-baseline.heapMiB,idleRunningAnimations:0,motion,reducedMotion:true,businessStateUnchanged:true,errors};
await fs.writeFile(new URL('native-motion-result.json',output),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
// 断开检查连接，保留测试窗口；不向原生 WebView 发送 Browser.close。
await cdp.detach();process.exit(0);
