/** 工作台共用业务规则：实际 BOM 成本、ERP 文本、配置模板、链接分组与海报基础样式。 */
import {productInstallment,INSTALLMENT_TERMS,moneyCents,chargeCents,pricing} from './pricing.js';
import {DEFAULT_SERVICE_TEXT} from './service-promises.js';
import {actualParts} from './actual-parts.js';
import {shopServiceColor,shopServiceTextColor} from './poster-theme.js';
import {isSpecialComponent} from './special-components.js';
import {restoreConfigOrder} from './config-order.js';
import {REPAIRED_HOST_COST} from './maintenance-workbook.js';
export const slots=['CPU','散热','主板','内存','硬盘','显卡','电源','机箱','风扇','配件1','配件2','配件3','配件4','配件5','配件6','配件7'];
export const clone=x=>structuredClone(x);
export const cents=x=>x===''||x==null?null:Math.round(Number(x)*100);
// 单独改价优先；ERP 缺价时明确标记使用核算价的回退。
function taxUnitCost(part){
 const override=part.taxOverride;
 return (override&&override.goodsId===String(part.goodsId??'')&&typeof override.value==='number'?moneyCents(override.value):null)??moneyCents(part.tax);
}
export function erpUnitCost(part){
 if(isSpecialComponent(part))return {cents:0,fallback:false};
 const real=moneyCents(part.erp);
 if(part.erpMissing!==true&&part.erpUnknown!==true&&real!=null)return {cents:real,fallback:false};
 const manual=taxUnitCost(part);
 return {cents:manual,fallback:manual!=null};
}
/** 实际 BOM 缺行、缺价或数量无效时保留未知；明确的零成本仍按零参与计算。 */
export function totals(config,settings={},quote=pricing(config,settings)){
 let erp=0,tax=0,lineCount=0,missing=0,erpFallback=0,erpUnresolved=0,taxUnresolved=0;
 for(const p of actualParts(config)){
  if(isSpecialComponent(p)||!p.name&&!p.goodsId)continue;
  const a=erpUnitCost(p),b=taxUnitCost(p),qty=Number(p.qty),knownQty=(typeof p.qty==='number'||typeof p.qty==='string'&&/^\d+$/.test(p.qty))&&Number.isInteger(qty)&&qty>=1&&qty<=1000;
  lineCount++;
  if(a.fallback)erpFallback++;
  if(!knownQty||a.cents==null)erpUnresolved++;else erp+=a.cents*qty;
  if(!knownQty||b==null)taxUnresolved++;else tax+=b*qty;
  if(a.fallback||a.cents==null||b==null||!knownQty)missing++;
 }
 const erpCost=lineCount&&!erpUnresolved&&Number.isSafeInteger(erp)?erp:null,taxCost=lineCount&&!taxUnresolved&&Number.isSafeInteger(tax)?tax:null;
 const {priceCents,feeCents,rule}=quote,erpDeduction=chargeCents(priceCents,rule.erpRate),taxDeduction=chargeCents(priceCents,rule.taxRate);
 const basis=taxCost==null||taxDeduction==null?null:taxCost+taxDeduction+moneyCents(rule.taxFixed);
 const erpProfit=erpCost==null||erpDeduction==null?null:priceCents-erpDeduction-erpCost-moneyCents(rule.erpFixed),taxProfit=basis==null?null:priceCents-basis;
 const toMoney=n=>n==null?null:n/100,after=n=>n==null||feeCents==null?null:n-feeCents;
 const termErp=after(erpProfit),termTax=after(taxProfit);
 return {erp:toMoney(erpCost),tax:toMoney(taxCost),basis:toMoney(basis),erpDeduction:toMoney(erpDeduction),taxDeduction:toMoney(taxDeduction),erpProfit:toMoney(erpProfit),taxProfit:toMoney(taxProfit),erpProfitAfter:toMoney(termErp),taxProfitAfter:toMoney(termTax),erpMargin:priceCents>0&&termErp!=null?termErp/priceCents*100:null,taxMargin:priceCents>0&&termTax!=null?termTax/priceCents*100:null,missing,erpFallback,erpUnresolved,taxUnresolved};
}
export const maintenanceUsesLocator=(shopId,template)=>shopId==='intel'&&template!=='legacy';
/** 英特尔新版复用已有定位列，其他表沿用修复版成本表的商品编号与名称列。 */
export function erpFormula(label,short=false){
 const id=`[@[${label}_id]]`,empty=`OR(${id}="",${id}=0,${id}="0")`;
 if(short){
  const row=`[@定位${label}]`;
  return `=IF(${empty},"",IF(IFERROR(AND(ISNUMBER(${row}),${row}>0),FALSE),INDEX(参名称,${row}),"未匹配"))`;
 }
 const {file,sheet,goods,name}=REPAIRED_HOST_COST,source=`'[${file}]${sheet}'`;
 return `=IF(${empty},"",INDEX(${source}!$${name}:$${name},MATCH(${id},${source}!$${goods}:$${goods},0)))`;
}
const clean=x=>{const v=String(x??'').trim();return ['0','/','good id','数量'].includes(v.toLowerCase())?'':v;};
/** 导出前检查 ERP 槽位、商品 ID 与正整数数量，再生成成本表可粘贴的数据行。 */
export function erpRow(config,template,formulas={}){const short=maintenanceUsesLocator(config.shopId,template);const seen=new Set();for(const p of actualParts(config)){if(p.name&&!isSpecialComponent(p)&&!clean(p.goodsId)&&!(p.slot==='显卡'&&/不含|无卡|核显|不配/.test(p.name)))throw Error(`${p.slot} 尚未绑定 ERP ID，请先选择配件`);if(clean(p.goodsId)){if(!slots.includes(p.slot))throw Error(`未分配 ERP 槽位：${p.name}`);if(seen.has(p.slot))throw Error(`ERP 槽位重复：${p.slot}`);seen.add(p.slot);if(!Number.isInteger(Number(p.qty))||Number(p.qty)<=0)throw Error(`${p.slot} 数量必须为正整数`);}}
const exportSlots=actualParts(config).some(p=>slots.slice(14).includes(p.slot)&&(clean(p.goodsId)||isSpecialComponent(p)))?slots:slots.slice(0,14);
if(short&&exportSlots.length>14)throw Error('英特尔新版维护表只到配件5；含配件6/7 的配置请在复制窗口选择旧版，并粘贴到支持这些列的表。');
return exportSlots.flatMap(slot=>{const p=actualParts(config).find(x=>x.slot===slot)||{},id=clean(p.goodsId),qty=id?clean(p.qty):'';if(isSpecialComponent(p))return ['0',p.name||'0',Number.isInteger(Number(p.qty))&&Number(p.qty)>0?String(p.qty):'1',''];const handwritten=short&&!id&&slot==='显卡'&&p.name&&/不含|无卡|核显|不配/.test(p.name);return[id||'0',handwritten?p.name:(formulas[slot]??erpFormula(slot,short)),qty||'1',''];});}
/** 按复制类型生成制表符或换行文本，缺少必要身份字段时拒绝导出。 */
export function copyText(configs,kind,template,formulasForShop=()=>({})){
 if(!configs.length)throw Error('请先勾选配置');
 if(kind==='parts'){
  const rows=configs.map(config=>{
   const formulas=formulasForShop(config.shopId);
   return {cells:erpRow(config,template,formulas),formulas};
  });
  const width=Math.max(...rows.map(row=>row.cells.length));
  return rows.map(({cells,formulas})=>{
   while(cells.length<width){
    const slot=slots[cells.length/4];
    cells.push('0',formulas[slot]??erpFormula(slot),'1','');
   }
   return cells.join('\t');
  }).join('\r\n');
 }
 const key={spu:'spu',sku:'skuId',name:'shortName'}[kind];if(!key)throw Error('未知复制类型');for(const c of configs){if(!String(c[key]||'').trim())throw Error(`${c.name} 尚未填写${kind==='sku'?' SKU ID':kind==='spu'?' SPU':'简称'}`);if(kind!=='name'&&!/^\d+$/.test(c[key]))throw Error(`${c.name} 的 ID 只能包含数字`);if(/[\t\r\n]/.test(c[key]))throw Error('字段包含换行或制表符，请先清理');}return configs.map(c=>c[key]).join('\r\n');}
export const serviceModule=(shopId,theme)=>({id:'service',type:'service',title:'服务承诺',text:DEFAULT_SERVICE_TEXT,visible:true,size:18,weight:700,color:shopServiceTextColor(shopId,theme),background:shopServiceColor(shopId,theme),fontFamily:'',gap:8});
export const modulesDefault=(shopId,theme)=>[
 {id:'header',type:'header',title:'标题与机箱',visible:true,size:29,weight:700,color:'',gap:18},
 {id:'parts',type:'parts',title:'配件清单',visible:true,size:19,weight:600,color:'',gap:16},
 {id:'addons',type:'addons',title:'加购与选配',visible:true,size:17,weight:500,color:'',gap:16},
 {id:'benefits',type:'benefits',title:'专属福利',visible:true,size:17,weight:500,color:'',gap:16},
 serviceModule(shopId,theme),
 {id:'footer',type:'footer',title:'页脚说明',visible:true,size:12,weight:400,color:'',gap:8}
];
// Add the new module without replacing existing text, styling, visibility or order.
/** 兼容旧模块列表补入服务承诺，保留原有内容、样式和顺序。 */
export function posterModules(config){const modules=config.modules||modulesDefault(config.shopId,config.theme);if(modules.some(m=>m.type==='service'))return modules;const next=[...modules],footer=next.findIndex(m=>m.type==='footer');let service=serviceModule(config.shopId,config.theme);while(next.some(m=>m.id===service.id))service.id+='-new';next.splice(footer<0?next.length:footer,0,service);return next;}
export const posterPalette=theme=>theme==='dark'?{bg:'#07172e',text:'#eef5ff',accent:'#57bdff',line:'#213a59',muted:'#a3b7d0',panel:'#0e2643'}:{bg:'#ffffff',text:'#132b50',accent:'#0070dc',line:'#deebf7',muted:'#6b85a3',panel:'#eff6fd'};
export const posterParts=config=>config.parts.filter(p=>(p.displayName||p.name||(config.keepCorePartPlaceholders&&slots.slice(0,8).includes(p.slot)))&&p.posterVisible!==false).map(p=>p.displayName?{...p,name:p.displayName}:p);
// Copy presentation only. Content and per-component visibility belong to each configuration.
/** 按颜色、格式和图片选项复制外观，配置业务内容保持目标自身的值。 */
export function applyPosterStyle(source,target,{colors=true,format=true,images=false}={}){
 const src=clone(source),copyKeys=(from,to,keys)=>{for(const key of keys){if(from[key]===undefined)delete to[key];else to[key]=clone(from[key]);}};
 if(colors)copyKeys(src,target,['theme','palette','upgradeColor']);
 if(format)copyKeys(src,target,['layout','skuMode','skuExportMode','posterDesignVersion','autoWidth','fontFamily','upgradeSize','upgradeWeight','showUpgrades','showWarranty','freeCanvasLayouts']);
 if(format||images)copyKeys(src,target,['caseTransforms','caseVisible']);
 const sourceModules=posterModules(src),targetModules=posterModules(target),used=new Set(),pairs=[];
 for(const m of sourceModules){const match=targetModules.find(t=>!used.has(t)&&t.type===m.type&&t.id===m.id)||targetModules.find(t=>!used.has(t)&&t.type===m.type);if(match){used.add(match);pairs.push([m,match]);}}
 for(const [from,to] of pairs){if(colors)copyKeys(from,to,['color','background']);if(format)copyKeys(from,to,['size','weight','gap','fontFamily','visible']);}
 target.modules=format?[...pairs.map(([,to])=>to),...targetModules.filter(t=>!used.has(t))]:targetModules;
 const mapText=key=>{
  if(key.startsWith('part.'))return (target.parts||[]).some(p=>key.startsWith(`part.${p.slot}.`))?key:null;
  const pair=pairs.find(([m])=>key.startsWith(m.id+'.'));return pair?pair[1].id+key.slice(pair[0].id.length):null;
 };
 const covered=key=>key.startsWith('part.')?(src.parts||[]).some(p=>key.startsWith(`part.${p.slot}.`)):pairs.some(([,m])=>key.startsWith(m.id+'.'));
 const keys=[...(colors?['color']:[]),...(format?['size','weight','fontFamily','italic','strikethrough','x','y','width','height','hidden']:[])];
 for(const styleField of ['textStyles','skuTextStyles']){
 const styles=clone(target[styleField]||{});
 for(const [key,style] of Object.entries(styles))if(covered(key)){
  for(const field of keys)delete style[field];
  if(style.ranges){style.ranges=style.ranges.map(r=>({...r,style:Object.fromEntries(Object.entries(r.style||{}).filter(([k])=>!keys.includes(k)))})).filter(r=>Object.keys(r.style).length);if(!style.ranges.length)delete style.ranges;}
 }
 for(const [key,style] of Object.entries(src[styleField]||{})){
  const dest=mapText(key);if(!dest)continue;styles[dest]??={};
  for(const field of keys)if(style[field]!==undefined)styles[dest][field]=clone(style[field]);
  const ranges=(style.ranges||[]).map(r=>({...clone(r),style:Object.fromEntries(Object.entries(r.style||{}).filter(([k])=>keys.includes(k)))})).filter(r=>Object.keys(r.style).length);
  if(ranges.length)styles[dest].ranges=[...(styles[dest].ranges||[]),...ranges];
 }
 if(styleField==='textStyles'||src[styleField]||target[styleField])target[styleField]=Object.fromEntries(Object.entries(styles).filter(([,s])=>Object.keys(s).length));
 }
 if(format){
  // Match semantic module/part keys; never replace a target's text or image asset.
  for(const field of ['textTransforms','moduleTransforms']){
   const result=clone(target[field]||{});
   for(const layout of new Set([...Object.keys(result),...Object.keys(src[field]||{})])){
    result[layout]??={};for(const key of Object.keys(result[layout]))if(field==='textTransforms'?covered(key):pairs.some(([,m])=>m.id===key))delete result[layout][key];
    for(const [key,value] of Object.entries(src[field]?.[layout]||{})){const dest=field==='textTransforms'?mapText(key):pairs.find(([m])=>m.id===key)?.[1].id;if(dest)result[layout][dest]=clone(value);}
    if(!Object.keys(result[layout]).length)delete result[layout];
   }
   if(Object.keys(result).length)target[field]=result;else delete target[field];
  }
  const targetLayers=target.posterImages||[],matched=new Set(),synced=[];
  for(const layer of src.posterImages||[]){
   const dest=targetLayers.find(t=>!matched.has(t)&&t.id===layer.id)||targetLayers.find(t=>!matched.has(t)&&t.url===layer.url);
   if(dest)matched.add(dest);
   synced.push({...clone(layer),id:dest?.id||layer.id});
  }
  if(synced.length)target.posterImages=[...targetLayers.filter(t=>!matched.has(t)),...synced];
 }
 return target;
}
export function templateOf(c,name){return{id:crypto.randomUUID(),name,createdAt:new Date().toISOString(),config:clone(c)};}
export function fromTemplate(t){const c=clone(t.config);c.id=crypto.randomUUID();c.skuId='';c.name=t.name+' · 副本';c.spu='';c.updatedAt=null;return c;}
// Assign a stable product identity once; later SPU edits must not split a link.
/** 只为尚无稳定链接身份的旧配置补 productId，后续 SPU 编辑不重新分组。 */
export function normalizeProducts(configs){for(const c of configs)c.productId??='legacy:'+String(c.spu||c.product||c.id);return configs;}
/** 按稳定链接 ID 聚合配置，并汇总链接级展示信息。 */
export function productGroups(configs){const groups=new Map();for(const c of configs){const id=c.productId||'legacy:'+String(c.spu||c.product||c.id);if(!groups.has(id))groups.set(id,{id,shopId:c.shopId||'intel',name:c.product||'未命名商品链接',url:c.productUrl||'',spu:c.spu||'',pricingRule:c.pricingRule??null,category:c.productCategory||'',cardColor:/^#[0-9a-f]{6}$/i.test(c.productCardColor||'')?c.productCardColor:'',configs:[]});groups.get(id).configs.push(c);}return [...groups.values()].map(p=>({...p,installment:productInstallment(p.configs)}));}
export function templateConfigs(template){return restoreConfigOrder(Array.isArray(template.configs)?[...template.configs]:template.config?[template.config]:[]);}
export function productTemplate(configs,name){if(!configs.length)throw Error('链接中没有配置');return{id:crypto.randomUUID(),shopId:configs[0].shopId||'intel',name,createdAt:new Date().toISOString(),configs:clone(configs)};}
export function fillCorePartPlaceholders(config){
 const fill=rows=>{
  const existing=rows||[],core=slots.slice(0,8);
  return [...core.flatMap(slot=>{const matches=existing.filter(p=>p.slot===slot);return matches.length?matches:[{slot,name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''}];}),...existing.filter(p=>!core.includes(p.slot))];
 };
 config.actualParts=fill(actualParts(config));config.parts=fill(config.parts);config.keepCorePartPlaceholders=true;
 return config;
}
/** 将模板配置实例化到指定链接，处理分期、顺序及空链接占位项。 */
export function importTemplateConfigs(configs,product){
 const term=product.installment===undefined?productInstallment(product.configs):product.installment;
 if(!INSTALLMENT_TERMS.includes(term))throw Error('请先在编辑链接中统一分期设置');
 const existing=(product.configs||[]).filter(c=>!c.deletedAt);
 // The template picker removes this unused new-link placeholder after importing.
 const placeholder=existing.find(c=>c.emptyLinkDraft&&(c.price==null||c.price===0)&&c.parts.every(p=>!p.name&&!p.goodsId)&&!c.addons.length&&!c.benefits.length&&!c.skuId);
 const offset=existing.length-(placeholder?1:0);
 const nextOrder=Math.max(-1,...(product.configs||[]).map((item,i)=>item.workspaceOrder??i))+1;
 return configs.map((source,index)=>{
  const c=clone(source);
  Object.assign(c,{id:crypto.randomUUID(),name:`配置${offset+index+1}`,shopId:product.shopId||c.shopId||'intel',productId:product.id,product:product.name,productCategory:product.category||'',productCardColor:product.cardColor||'',productUrl:product.url||'',spu:product.spu||'',installment:term,pricingRule:clone(product.pricingRule??null),skuId:'',updatedAt:null,shortNameAuto:true,workspaceOrder:nextOrder+index});
  delete c.productTheme;const linkTheme=existing.find(row=>['light','dark'].includes(row.productTheme))?.productTheme;if(linkTheme)c.productTheme=linkTheme;delete c.sampleNote;delete c.emptyLinkDraft;delete c.deletedAt;delete c.deletionSessionId;return fillCorePartPlaceholders(c);
 });
}
/** 按当前链接和参考样式生成新配置，初始化必要的业务字段。 */
export function blankConfig(reference,product,name='配置1',serviceText=DEFAULT_SERVICE_TEXT){const term=product.installment===undefined?productInstallment(product.configs):product.installment;if(!INSTALLMENT_TERMS.includes(term))throw Error('请先在编辑链接中统一分期设置');const c=clone(reference??product.configs?.find(c=>!c.deletedAt)??{theme:'light',layout:'long',fontFamily:'Microsoft YaHei',upgradeColor:'',upgradeSize:16,upgradeWeight:400,showUpgrades:true,showWarranty:false,caseImage:'',footer:'配置以所选方案为准',modules:modulesDefault(product.shopId,'light')});Object.assign(c,{showWarranty:false,id:crypto.randomUUID(),shopId:product.shopId||reference?.shopId||'intel',productId:product.id,product:product.name,productCategory:product.category||'',productCardColor:product.cardColor||'',productUrl:product.url||'',spu:product.spu||'',skuId:'',name,version:'进阶版',shortName:'',shortNameAuto:true,installment:term,pricingRule:clone(product.pricingRule??null),price:null,updatedAt:null,taxUpdatedAt:null,erpImportedAt:null,addons:[],benefits:[],parts:slots.slice(0,8).map(slot=>({slot,name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''}))});c.actualParts=clone(c.parts);c.modules=posterModules(c).map(m=>m.type==='service'?{...m,text:serviceText}:m);c.productDraft=!!product.configs?.some(row=>row.productDraft);c.overviewPrice99=!!product.configs?.length&&product.configs.every(row=>row.overviewPrice99===true);c.overviewAccessoryLimit=0;delete c.workspaceOrder;delete c.sampleNote;delete c.emptyLinkDraft;delete c.deletedAt;delete c.deletionSessionId;return c;}
export function wrapText(ctx,text,maxWidth){const lines=[];for(const para of String(text||'').split('\n')){let line='';const tokens=para.match(/[A-Za-z0-9][A-Za-z0-9._/+*-]*|[^A-Za-z0-9]/gu)||[];for(const token of tokens){if(ctx.measureText(token).width>maxWidth){for(const ch of token){if(line&&ctx.measureText(line+ch).width>maxWidth){lines.push(line.trimEnd());line='';}line+=ch;}}else{if(line&&ctx.measureText(line+token).width>maxWidth){lines.push(line.trimEnd());line='';}line+=!line?token.trimStart():token;}}lines.push(line);}return lines;}

export const liveConfigs=configs=>configs.filter(c=>!c.deletedAt);
/** 对指定配置写入删除标记，保留恢复所需的数据。 */
export function deleteConfigs(configs,ids,at=new Date().toISOString()){const selectedIds=new Set(ids);let count=0;for(const c of configs)if(!c.deletedAt&&selectedIds.has(c.id)){c.deletedAt=at;count++;}return count;}
/** 清除目标配置的删除状态，使其重新进入可用列表。 */
export function restoreConfigs(configs,ids){const selectedIds=new Set(ids);for(const c of configs)if(selectedIds.has(c.id)){delete c.deletedAt;delete c.deletionSessionId;}}
