/** 在真实工作台页面和隔离 Rust 存储上复跑价格表，不连接云或 ERP。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5236';
const root=fileURLToPath(new URL('../../../sandbox/',import.meta.url));
const directory=await fs.mkdtemp(root+'price-profit-browser-');
await fs.mkdir(directory+'/workbench-assets');
const configs=[
 ['a','合成配置甲','intel','p','合成链接甲','010','001',1000,500,600],
 ['b','合成配置乙','intel','p','合成链接甲','010','002',1200,500,600],
 ['c','合成配置丙','intel','q','合成链接乙','020','003',900,500,600],
 ['d','合成配置丁','jonsbo','p','合成链接丙','030','001',null,null,null]
].map(([id,name,shopId,productId,product,spu,skuId,price,erp,tax])=>{
 const c=blankConfig(null,{id:productId,shopId,name:product,spu,installment:6},name);
 const part={slot:'CPU',name:'合成成本零件',goodsId:'41',qty:1,erp,tax};
 Object.assign(c,{id,name,skuId,price,parts:[part],actualParts:[part]});
 return c;
});
await fs.writeFile(directory+'/source.json',JSON.stringify({dataVersion:3,revision:0,configs,templates:[],shopSettings:{intel:{coupon:100}},sourceCatalog:[
 {sourceId:'intel-wps',shopId:'intel',goodsId:'99',slot:'CPU',name:'英特尔合成输出',upgrade:'英特尔专用'},
 {sourceId:'jonsbo-wps',shopId:'jonsbo',goodsId:'99',slot:'CPU',name:'乔思伯合成输出',upgrade:'乔思伯专用'}
],costSource:[],caseGallery:[],logs:[]}));
const host=spawn(fileURLToPath(new URL('../src-tauri/target/debug/workbench-review-host.exe',import.meta.url)),[],{windowsHide:true,env:{...process.env,DIYTOOLS_REVIEW_DIRECTORY:directory},stdio:['pipe','pipe','inherit']});
const pending=[];
createInterface({input:host.stdout}).on('line',line=>{const item=pending.shift();if(item)item.resolve(JSON.parse(line));});
for(const event of ['error','exit'])host.on(event,error=>{while(pending.length)pending.shift().reject(Error('隔离验收宿主退出 '+error));});
const store=(method,path,body)=>new Promise((resolve,reject)=>{pending.push({resolve,reject});host.stdin.write(JSON.stringify({method,path,body:body==null?null:JSON.stringify(body)})+'\n');});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const errors=[],page=await browser.newPage({viewport:{width:1480,height:950},bypassCSP:true,permissions:['clipboard-read','clipboard-write']});
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.stack);});
 const source=await fs.readFile(new URL('../public/workbench/index.html',import.meta.url),'utf8');
 const bootstrap="<script type=\"module\">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;const {createWorkbenchReactRenderer}=await import('/src/legacy/react-workbench.tsx');window.createWorkbenchReactRenderer=createWorkbenchReactRenderer;await import('/workbench/app.js');document.body.classList.remove('login-required');</script>";
 await page.route('**/workbench/price-profit-fixture',r=>r.fulfill({contentType:'text/html',body:source.replace('<script type="module" src="./bootstrap.js"></script>',bootstrap)}));
 await page.route('**/catalog.json',r=>r.fulfill({json:[]}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(path==='/api/session')return route.fulfill({json:{defaultOperator:'合成验收'}});
  if(path==='/api/native-cloud/status')return route.fulfill({json:{configured:false,checkpoint:{initialized:false}}});
  if(!/^\/api\/(?:workspace\/index|configs\/(?:load|patch|batch)|state|profit\/)/.test(path))return route.fulfill({json:{}});
  const result=await store(request.method(),path+url.search,request.method()==='POST'?request.postDataJSON():null);
  await route.fulfill({status:result.status,contentType:'application/json',body:result.body});
 });
 const state=async()=>{const result=await store('GET','/api/state');assert.equal(result.status,200,result.body);return JSON.parse(result.body);};
 const open=async()=>{
  await page.goto(base+'/workbench/price-profit-fixture');
  await page.waitForFunction(()=>window.workbenchReady);
  await page.getByRole('button',{name:'价格',exact:true}).click();
  await page.locator('#price-profit-title').waitFor();
 };
 const cell=(id,key)=>page.locator('[data-row-id="'+id+'"][data-pp-cell="'+key+'"]');
 const value=(id,key)=>cell(id,key).inputValue();
 const paste=async(id,key,text)=>{
  await cell(id,key).click();
  await page.evaluate(t=>navigator.clipboard.writeText(t),text);
  await page.keyboard.press('Control+v');
 };
 const metric=async(id,child)=>page.locator('[data-pp-row="'+id+'"] > :nth-child('+child+')').innerText();
 const saved=async()=>{await page.locator('#pp-save').click();await page.waitForFunction(()=>/已保存|无需保存|已载入/.test(document.querySelector('#save-status').textContent));};
 await open();
 assert.equal(await page.locator('[data-pp-row]').count(),3);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：3 套配置');
 assert.equal(await metric('a',8),'¥600.00');
 assert.equal(await metric('a',10),'¥222.00');
 assert.equal(await metric('a',15),'¥38.00');
 await page.locator('#pp-shop').selectOption('all');
 assert.equal(await page.locator('[data-pp-row]').count(),4);
 assert.equal(await metric('d',10),'—');
 await page.locator('#pp-shop').selectOption('intel');
 await page.locator('#pp-flat').click();
 await page.locator('#pp-sort').selectOption('desc');
 assert.deepEqual(await page.locator('[data-pp-row]').evaluateAll(els=>els.map(el=>el.dataset.ppRow)),['b','a','c']);
 await paste('b','sku',"SKU\r\n'00090071992547409931234\r\n'00090071992547409931235\r\n");
 assert.equal(await value('b','sku'),'00090071992547409931234');assert.equal(await value('a','sku'),'00090071992547409931235');
 await paste('b','sku','555\n003');
 assert.equal(await value('b','sku'),'00090071992547409931234');assert.equal(await value('a','sku'),'00090071992547409931235');
 await page.locator('#pp-undo').click();
 assert.equal(await value('b','sku'),'002');assert.equal(await value('a','sku'),'001');
 await page.locator('#pp-redo').click();
 assert.equal(await value('a','sku'),'00090071992547409931235');
 await page.locator('#pp-grouped').click();
 await page.getByRole('button',{name:'▾ 合成链接甲',exact:true}).click();
 assert.deepEqual(await page.locator('[data-pp-row]').evaluateAll(els=>els.map(el=>el.dataset.ppRow)),['c']);
 await paste('c','sku','555\n556');
 assert.equal(await value('c','sku'),'003');
 await page.getByRole('button',{name:'▸ 合成链接甲',exact:true}).click();
 await cell('b','spu').fill('000080071992547409931235');
 await cell('b','spu').press('Tab');
 assert.equal(await value('a','spu'),'000080071992547409931235');
 assert.equal(await cell('b','sku').evaluate(el=>el===document.activeElement),true);
 await cell('a','price').fill('1100.25');
 await cell('a','price').press('Enter');
 assert.equal(await value('a','price'),'1100.25');
 await page.locator('#pp-shop-settings').click();
 await page.locator('#shop-price-taxRate').fill('10');
 await page.locator('#shop-price-taxFixed').fill('20');
 await page.locator('#shop-price-fee6').fill('4.5');
 await page.locator('#shop-price-save').click();
 assert.equal(await metric('b',10),'¥406.00');
 await page.locator('[data-pp-edit-link]').filter({hasText:'跟随店铺'}).first().click();
 await page.locator('#product-pricing-mode').selectOption('custom');
 await page.locator('#product-price-taxRate').fill('3');
 await page.locator('#product-apply').click();
 assert.equal(await metric('b',10),'¥490.00');
 await page.locator('#pp-alert').click();
 const erpAlert=page.locator('[name="pp-alert-basis"][value="erp"]');
 const taxAlert=page.locator('[name="pp-alert-basis"][value="tax"]');
 await taxAlert.uncheck();
 await erpAlert.uncheck();
 await page.locator('#pp-alert-apply').click();
 assert.match(await page.locator('#pp-alert-error').innerText(),/至少选择/);
 await erpAlert.check();
 await page.locator('#pp-alert-erp-target').fill('1');
 await page.locator('#pp-alert-apply').click();
 await page.locator('[data-pp-filter="target"]').click();
 assert.equal(await page.locator('[data-pp-row]').count(),0);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：0 套配置');
 await page.locator('#pp-alert').click();
 assert.equal(await erpAlert.isChecked(),true);
 assert.equal(await taxAlert.isChecked(),false);
 await taxAlert.check();
 await page.locator('#pp-alert-tax-mode').selectOption('rate');
 await page.locator('#pp-alert-tax-target').fill('50');
 await taxAlert.uncheck();
 assert.equal(await page.locator('#pp-alert-tax-target').isVisible(),false);
 await taxAlert.check();
 assert.equal(await page.locator('#pp-alert-tax-target').inputValue(),'50');
 assert.equal(await page.locator('#pp-alert-erp-target').inputValue(),'1');
 await page.locator('#pp-alert-apply').click();
 assert.equal(await page.locator('[data-pp-row]').count(),3);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：3 套配置');
 await page.locator('#pp-basis').selectOption('tax');
 assert.equal(await page.locator('[data-pp-row]').count(),3);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：3 套配置');
 // 状态筛选与行标签一致，多选取并集，清除后恢复可见集合。
 assert.equal(await page.locator('.pp-toolbar #pp-status-filter').count(),1);
 await page.locator('#pp-status-filter').click();
 await page.locator('[data-pp-status-choice="normal"]').check();
 await page.locator('#pp-status-apply').click();
 assert.equal(await page.locator('[data-pp-row]').count(),0);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：0 套配置');
 await page.locator('#pp-status-filter').click();
 await page.locator('[data-pp-status-choice="tax-target"]').check();
 await page.locator('#pp-status-apply').click();
 assert.equal(await page.locator('[data-pp-row]').count(),3);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：3 套配置');
 await page.locator('#pp-status-filter').click();
 await page.locator('#pp-status-clear').click();
 assert.equal(await page.locator('[data-pp-row]').count(),3);
 assert.equal(await page.locator('#pp-result-count').innerText(),'筛选结果：3 套配置');
 await page.locator('[data-pp-pick="a"]').check();
 await page.locator('[data-pp-pick="b"]').check();
 await page.locator('#pp-batch').click();
 await page.locator('#pp-batch-mode').selectOption('target');
 await page.locator('#pp-batch-value').fill('500');
 await page.locator('#pp-batch-apply').click();
 assert.equal(await metric('a',10),'¥500.17');
 assert.equal(await metric('b',10),'¥500.17');
 await page.locator('#pp-new-link').click();
 await page.locator('#product-name').fill('合成新链接');
 await page.locator('#product-installment').selectOption('6');
 await page.locator('#product-pricing-mode').selectOption('custom');
 await page.locator('#product-price-erpRate').fill('3');
 await page.locator('#product-apply').click();
 await saved();
 const before=await state();
 assert.deepEqual(before.shopSettings.intel.profitAlert,{
  bases:['erp','tax'],erpProfit:{mode:'amount',loss:0,target:1},taxProfit:{mode:'rate',loss:0,target:50},
 });
 assert.equal(before.shopSettings.intel.pricingRule.fee6,4.5);
 assert.equal(before.configs.find(c=>c.id==='a').pricingRule.taxRate,3);
 assert.equal(before.configs.find(c=>c.id==='a').skuId,'00090071992547409931235');
 assert.equal(before.configs.find(c=>c.id==='b').spu,'000080071992547409931235');
 assert.equal(before.configs.find(c=>c.product==='合成新链接').pricingRule.erpRate,3);
 assert.equal(before.configs.find(c=>c.product==='合成新链接').price,null);
 assert.equal(before.configs.find(c=>c.id==='d').price,null);
 await open();
 assert.equal(await metric('a',10),'¥500.17');
 assert.equal(await value('a','sku'),'00090071992547409931235');
 assert.equal(await value('b','spu'),'000080071992547409931235');
 // 跨店发起新建应使用目标店的 WPS 输出源，连一样的 ERP ID 也不能串店。
 await page.locator('#pp-shop').selectOption('jonsbo');
 await page.locator('#pp-new-link').click();
 await page.locator('#product-name').fill('跨店 WPS 合成链接');
 await page.locator('.wps-import > summary').click();
 await page.locator('[data-wps-text]').fill('99\t1\t合成 CPU');
 await page.locator('[data-wps-check]').click();
 assert.equal(await page.locator('[data-wps-preview]').getByText('乔思伯合成输出',{exact:false}).count(),1);
 await page.locator('#product-apply').click();
 await saved();
 const wps=(await state()).configs.find(c=>c.product==='跨店 WPS 合成链接');
 assert.equal(wps.shopId,'jonsbo');
 assert.equal(wps.parts[0].sourceId,'jonsbo-wps');
 await page.locator('#pp-back').click();
 assert.equal(await page.locator('#price-profit-page').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,isolatedRustStore:directory,verified:'真实页面、系统剪贴板、批量原子性、撤销重做、店铺和链接规则、预警、调价、新建、保存重开'}));
}finally{await browser.close();host.stdin.end();}
