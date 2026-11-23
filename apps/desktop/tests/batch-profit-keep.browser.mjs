/** 自包含浏览器检查：真实定价弹窗和应用回调只操作内存样本，不使用共享 Vite 或业务接口。 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const app=await readFile(new URL('../public/workbench/app.js',import.meta.url),'utf8');
const start=app.indexOf('apply:(plan,message)=>{',app.indexOf("$('#batch-profit-price').onclick="))+'apply:(plan,message)=>{'.length;
const end=app.indexOf('\n   }});',start);
assert.ok(start>0&&end>start,'应定位实际工作台的批量应用回调');
const applyBody=app.slice(start,end);
const extraVisibilityBinding=app.split('\n').find(line=>line.includes("'[data-extra-visible]'")&&line.includes('input.onchange'));
assert.ok(extraVisibilityBinding,'应定位实际工作台的文字模块显示开关');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();
 await page.route('http://ui-review.local/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/'){await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><dialog id="dialog" open></dialog></body></html>'});return;}
  assert.match(path,/^\/workbench\/[a-z0-9-]+\.js$/i,'仅提供当前工作台的只读模块');
  await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../public'+path,import.meta.url),'utf8')});
 });
 await page.goto('http://ui-review.local/');
 await page.evaluate(async()=>{window.pricingUi=await import('/workbench/batch-profit-price.js');});
 const open=async(selected,installment='keep',price99='keep')=>{
  await page.evaluate(({selected,applyBody})=>{
   const make=(id,productId,installment,price,overviewPrice99)=>({id,name:id,product:productId,productId,shopId:'intel',price,installment,
    ...(overviewPrice99===undefined?{}:{overviewPrice99}),parts:[{slot:'CPU',goodsId:'1',qty:1,erp:1000,tax:1100}],actualParts:[{slot:'CPU',goodsId:'1',qty:1,erp:1000,tax:1100}],addons:[]});
   const rows=[make('a','p',0,1999,true),make('b','p',24,2000,false),make('other','other-link',0,3333)];
   window.priceFixture={configs:rows,before:structuredClone(rows),plan:null};
   const ids=new Set(selected),chosen=()=>rows.filter(c=>ids.has(c.id));
   const apply=new Function('state','activeShopId','nasMain','checkpointConfig','changed','closeDialog','renderAll','plan','message',applyBody);
   window.pricingUi.openBatchProfitPrice({openDialog:(_title,html)=>{document.querySelector('#dialog').innerHTML=html;},
    esc:value=>String(value),toast:()=>{},settings:()=>({}),scopes:[{key:'chosen',label:'指定范围',count:ids.size,links:1,preferred:true,configs:chosen,related:()=>rows}],
    apply:(plan,message)=>{window.priceFixture.plan=structuredClone(plan);apply(window.priceFixture,'intel',false,()=>{},()=>{},()=>{},()=>{},plan,message);}});
  },{selected,applyBody});
  await page.locator('input[name="bpp-kind"][value="erp"]').check();
  await page.locator('#bpp-target').fill('100');
  await page.locator('#bpp-installment').selectOption(installment);
  await page.locator('#bpp-99').selectOption(price99);
  await page.waitForFunction(()=>!document.querySelector('#bpp-apply').disabled);
 };
 const apply=async()=>{await page.locator('#bpp-apply').click();return page.evaluate(()=>structuredClone(window.priceFixture));};

 await open(['a','b']);assert.equal(await page.locator('#bpp-rows tr').count(),2);
 let result=await apply();assert.deepEqual(result.configs.map(c=>c.installment),[0,24,0]);
 assert.deepEqual(result.configs.map(c=>c.overviewPrice99),[true,false,undefined]);
 assert.deepEqual(result.configs[2],result.before[2]);assert.deepEqual(result.plan.map(p=>p.installmentMode),['keep','keep']);

 await open(['a']);assert.equal(await page.locator('#bpp-rows tr').count(),1);
 result=await apply();assert.deepEqual(result.configs.slice(1),result.before.slice(1));

 await open(['a'],'on','on');assert.equal(await page.locator('#bpp-rows tr').count(),2);
 assert.match(await page.locator('#bpp-rows').textContent(),/整链设置/);
 result=await apply();assert.deepEqual(result.configs.slice(0,2).map(c=>c.installment),[24,24]);
 assert.deepEqual(result.configs.slice(0,2).map(c=>c.overviewPrice99),[true,true]);assert.equal(result.configs[1].price,1999);
 assert.deepEqual(result.configs[2],result.before[2]);

 await open(['a'],'off','off');result=await apply();assert.deepEqual(result.configs.slice(0,2).map(c=>c.installment),[0,0]);
 assert.deepEqual(result.configs.slice(0,2).map(c=>c.overviewPrice99),[false,false]);assert.equal(result.configs[1].price,2000);
 assert.deepEqual(result.configs[2],result.before[2]);

 await open(['a'],'keep','on');result=await apply();assert.deepEqual(result.configs.slice(0,2).map(c=>c.installment),[0,24]);
 assert.deepEqual(result.configs.slice(0,2).map(c=>c.overviewPrice99),[true,true]);

 await open(['a'],'on','keep');result=await apply();assert.deepEqual(result.configs.slice(0,2).map(c=>c.installment),[24,24]);
 assert.deepEqual(result.configs.slice(0,2).map(c=>c.overviewPrice99),[true,false]);
 assert.deepEqual(result.configs[2],result.before[2]);
 // 实际显示开关绑定需能创建缺失模块，不能只有数据函数通过而表单入口失效。
 await page.evaluate(async binding=>{
  const {setPosterExtraVisible}=await import('/workbench/config-extras.js');
  const c={id:'legacy',shopId:'intel',theme:'dark',modules:[{id:'custom',type:'custom',text:'保留原模块',unknown:7}],benefits:[{id:'old',text:'已有福利',qty:2,priceCents:9900}]};
  window.extraFixture=c;document.querySelector('#dialog').innerHTML='<label><input type="checkbox" data-extra-visible="benefits">显示在配置图中</label>';
  new Function('c','$$','checkpointConfig','setPosterExtraVisible','changed',binding)(c,selector=>[...document.querySelectorAll(selector)],()=>{},setPosterExtraVisible,()=>{});
 },extraVisibilityBinding);
 await page.locator('[data-extra-visible="benefits"]').check();
 let extras=await page.evaluate(()=>structuredClone(window.extraFixture));
 assert.equal(extras.modules.find(module=>module.type==='benefits').visible,true);
 assert.deepEqual(extras.modules.find(module=>module.type==='custom'),{id:'custom',type:'custom',text:'保留原模块',unknown:7});
 assert.deepEqual(extras.benefits,[{id:'old',text:'已有福利',qty:2,priceCents:9900}]);
 await page.locator('[data-extra-visible="benefits"]').uncheck();extras=await page.evaluate(()=>structuredClone(window.extraFixture));
 assert.equal(extras.modules.find(module=>module.type==='benefits').visible,false);
 console.log('通过：保持分期/取99不广播、部分范围无额外改动、明确开关整链生效、六组预览与应用一致、实际福利开关创建缺失模块。');
}finally{await browser.close();}
