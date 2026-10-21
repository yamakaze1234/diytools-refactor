/** Agent 导出只消费固定保存快照；图片逐张原生写盘，不修改工作台状态。 */
import {renderPoster,defaultPosterWidth} from './poster.js';
import {sourceImageEntries} from './source-sync-data.js';
import {actualParts} from './actual-parts.js';
import {shops} from './shops.js';
import {hasConfigCost} from './config-cost.js';
import {isSpecialComponent} from './special-components.js';
import {normalizeProducts} from './core.js';

const copy=value=>structuredClone(value);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const label=value=>value===undefined||value===null||value===''?'未填写':esc(value);
const imageUrl=name=>name.split('/').map(encodeURIComponent).join('/');
function link(value){
 try{const url=new URL(String(value));if(['https:','http:'].includes(url.protocol))return `<a href="${esc(url.href)}" rel="noreferrer">${esc(value)}</a>`;}catch{/* 无效或不安全的链接仅作为文本显示。 */}
 return label(value);
}
function partsTable(parts){
 // 列出保存的真实单价；不从旧 cost 字段猜测，也不把核算价回填成 ERP 报价。
 const amount=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):undefined;
 return `<table><thead><tr><th>部位</th><th>名称</th><th>ERP ID</th><th>数量</th><th>已保存 ERP 单价（元）</th><th>核算含税单价（元）</th><th>升级描述</th></tr></thead><tbody>${parts.map(p=>{
  const erp=isSpecialComponent(p)?0:p.erpMissing===true||p.erpUnknown===true?undefined:amount(p.erp);
  const tax=isSpecialComponent(p)?0:amount(hasConfigCost(p)?p.taxOverride.value:p.tax);
  return `<tr><td>${label(p.slot)}</td><td>${label(p.displayName??p.name)}</td><td>${label(p.goodsId)}</td><td>${label(p.qty)}</td><td>${label(erp)}</td><td>${label(tax)}</td><td>${label(p.upgrade)}</td></tr>`;
 }).join('')}</tbody></table>${parts.length?'':'<p>无配件</p>'}`;
}
function reportHtml(configs,revision,files){
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>配置详情报告</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:1100px;margin:auto;padding:24px;color:#172b4d}article{border-top:2px solid #ccd7e3;margin-top:24px;padding-top:16px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccd7e3;padding:8px;text-align:left;overflow-wrap:anywhere}img{max-width:100%;height:auto}dd{overflow-wrap:anywhere}figure{display:inline-block;vertical-align:top;width:45%;margin:2%}h1,h2,h3{line-height:1.3}</style><h1>配置详情报告</h1><p>已保存快照版本：${esc(revision)} · ${configs.length} 套配置。展示配件与实际 BOM 分别列出；缺少 SKU 时保留未填写。</p>${configs.map(c=>`<article><h2>${label(c.name)}</h2><dl><dt>店铺</dt><dd>${label(shops.find(s=>s.id===c.shopId)?.name)}（${label(c.shopId)}）</dd><dt>链接</dt><dd>${label(c.product)} · ${link(c.productUrl)}</dd><dt>SPU / SKU</dt><dd>${label(c.spu)} / ${label(c.skuId)}</dd><dt>配置 ID</dt><dd>${label(c.id)}</dd><dt>配置版本 / 售价</dt><dd>${label(c.version)} / ${label(c.price)}</dd></dl><h3>展示配件</h3>${partsTable(c.parts||[])}<h3>实际 BOM</h3>${partsTable(actualParts(c).map(({displayName,...p})=>p))}${files.filter(f=>f.configId===c.id).map(f=>`<figure><a href="${esc(imageUrl(f.name))}"><img loading="lazy" src="${esc(imageUrl(f.name))}" alt="${esc(c.name)} ${f.layout==='long'?'配置图':'SKU 图'}"></a><figcaption>${esc(f.name)}</figcaption></figure>`).join('')}</article>`).join('')}</html>`;
}
async function canvasBase64(canvas){
 const blob=await new Promise((resolve,reject)=>{try{canvas.toBlob(resolve,'image/png');}catch(error){reject(error);}});
 if(!blob)throw Error('图片 PNG 编码失败');
 const bytes=new Uint8Array(await blob.arrayBuffer());
 let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
 return btoa(binary);
}
const receiptError=(receipt,fallback)=>Error(receipt?.error?.message||receipt?.error||fallback);

export async function exportAgentSnapshot({configs,revision,params={},writeFile,finish,progress=()=>{},render=renderPoster}){
 if(!Array.isArray(configs)||!configs.length)throw Error('没有可导出的保存快照配置');
 if(!Number.isSafeInteger(revision)||revision<0)throw Error('保存快照版本无效');
 if(typeof writeFile!=='function'||typeof finish!=='function'||typeof render!=='function')throw Error('缺少原生导出会话或渲染器');
 // 克隆在首次 await 前完成，任何后续 UI 修改和渲染器修改都不能污染任务快照。
 const snapshot=copy(configs).filter(c=>!c.deletedAt),options=copy(params);
 if(!snapshot.length)throw Error('没有可导出的保存快照配置');
 const images=options.images??'both';
 if(!['both','long','square'].includes(images))throw Error('images 必须是 both、long 或 square');
 if(options.report!==undefined&&typeof options.report!=='boolean')throw Error('report 必须是布尔值');
 const ids=new Set(snapshot.map(c=>c.id));
 if(ids.size!==snapshot.length||snapshot.some(c=>typeof c.id!=='string'||!c.id))throw Error('快照配置 ID 必须为非空且唯一');
 if(options.configIds!==undefined&&(!Array.isArray(options.configIds)||!options.configIds.length||options.configIds.some(id=>!ids.has(id))))throw Error('configIds 必须选择快照中的配置');
 const selected=options.configIds===undefined?snapshot:snapshot.filter(c=>options.configIds.includes(c.id));
 const entries=sourceImageEntries(normalizeProducts(copy(snapshot)),options.configIds??null).filter(e=>images==='both'||e.config.layout===images),files=[];
 for(const [index,entry] of entries.entries()){
  await progress({phase:'rendering',completed:index,total:entries.length,name:entry.name});
  let result;
  try{
   result=await render(copy(entry.config),defaultPosterWidth(entry.config));
   if(result?.overflow)throw Error(`图片内容超出画布：${entry.name}`);
   if(!result?.canvas)throw Error('渲染器未返回画布');
   const base64=await canvasBase64(result.canvas);
   const receipt=await writeFile({name:entry.name,base64});
   if(receipt?.ok!==true||receipt.name!==entry.name)throw receiptError(receipt,'未收到对应图片保存确认');
   files.push({name:entry.name,configId:entry.config.id,layout:entry.config.layout,...(receipt.bytes===undefined?{}:{bytes:receipt.bytes}),...(receipt.sha256===undefined?{}:{sha256:receipt.sha256})});
  }finally{
   // 每张图编码及写入结束立即释放独立画布，不保留整批 base64 或位图。
   if(result?.canvas){result.canvas.width=0;result.canvas.height=0;}
   result=null;
  }
  await progress({phase:'writing',completed:index+1,total:entries.length,name:entry.name});
 }
 const manifest={protocolVersion:1,revision,snapshot:'localSaved',localSave:'unchanged',images,report:options.report===true,files,configs:selected.map(c=>({id:c.id,shopId:c.shopId,productId:c.productId,spu:c.spu??null,skuId:c.skuId??null,name:c.name}))};
 const receipt=await finish({reportHtml:options.report===true?reportHtml(selected,revision,files):null,manifest:copy(manifest)});
 if(receipt?.ok!==true)throw receiptError(receipt,'未收到 ZIP 与清单保存确认');
 if(typeof receipt.zipPath!=='string'||!receipt.zipPath||typeof receipt.manifestPath!=='string'||!receipt.manifestPath)throw Error('原生导出未返回实际 ZIP 与清单路径');
 if(options.report===true&&(typeof receipt.reportPath!=='string'||!receipt.reportPath))throw Error('原生导出未返回实际报告路径');
 return {...receipt,localSave:'unchanged',export:'completed',revision,manifest};
}
