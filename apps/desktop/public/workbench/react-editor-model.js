/** 将既有业务计算转成只读展示模型；React 不重复实现核算、来源与升级规则。 */
import {isSpecialComponent} from './special-components.js';
import {componentStockView} from './component-stock-view.js';
import {doubleMemoryUpgrade,displayUpgrade} from './memory-upgrade.js';
import {addonCheck,addonChecks,addonItems} from './addon-data.js';
import {hasConfigCost} from './config-cost.js';
import {erpUnitCost} from './core.js';
import {profitTone} from './profit-tone.js';
import {posterFontFamily} from './poster-fonts.js';
export function addonStatusModel(a,costs,originals=[]){
 const cents=v=>v==null?'待补充':'¥'+(v/100).toFixed(2);
 if(a.choices!==undefined)return {children:addonChecks(a).map(v=>({...addonStatusModel(v,costs,originals),text:v.text}))};
 if(!addonItems(a).length)return {textOnly:true};
 const r=addonCheck(a,costs,originals),quoted=/^[+＋]\s*(\d+(?:\.\d{1,2})?)\s*元/.exec(a.text||'');
 return {...r,name:(r.name||r.reason)+(a.goodsId?' · ID '+a.goodsId:''),mismatch:(a.qty??1)===1&&a.priceCents!=null&&!!quoted&&Math.round(Number(quoted[1])*100)!==a.priceCents,fields:[...r.fields].sort((a,b)=>Number(b.key==='tax')-Number(a.key==='tax')).map(f=>({...f,text:`${f.label}：原配件 ${cents(f.originalPriceCents)} ＋ 加购价 ${cents(a.priceCents)} − 新配件成本 ${cents(f.costCents)} ＝ 差价 ${cents(f.diffCents)}`}))};
}
export function editorModel(tab,c,{parts=c.parts,catalog=[],costs=[],copiedPart,palette,fonts,selectedModule,t,p,money}={}){
 const model={tab,config:c,selectedModule};
 if(tab==='parts'||tab==='actual')return {...model,canPaste:copiedPart?.shopId===c.shopId,parts:parts.map(part=>({...part,special:isSpecialComponent(part),searchName:tab==='actual'?part.name:catalog.find(row=>row.sourceId===part.sourceId&&row.goodsId===part.goodsId)?.name||part.name,stock:tab==='actual'?componentStockView(part,costs):undefined}))};
 if(tab==='addons')return {...model,parts:c.parts.map(part=>({...part,displayUpgrade:displayUpgrade(part),doubleMemoryUpgrade:doubleMemoryUpgrade(part)})),rows:c.addons.map(a=>({...a,status:addonStatusModel(a,costs,c.parts),owner:a.sourceId?'随配件切换：'+(c.parts.find(x=>x.sourceId===a.sourceId)?.name||'原关联配件'):'独立加购'}))};
 if(tab==='modules')return {...model,palette,fonts,config:{...c,resolvedFont:posterFontFamily(c.fontFamily),modules:c.modules.map(m=>({...m,resolvedFont:m.fontFamily?posterFontFamily(m.fontFamily):''}))}};
 return {...model,warning:!!(t.erpFallback||t.erpUnresolved),rows:parts.map(part=>{const unit=erpUnitCost(part);return {...part,special:isSpecialComponent(part),override:hasConfigCost(part),erpLabel:unit.cents===null?'待补成本':'¥'+money(unit.cents/100),fallback:unit.fallback,taxLabel:part.tax==null?'待填':'¥'+money(part.tax),totalLabel:part.tax==null?'待填':'¥'+money(part.tax*part.qty)};}),summaries:[{label:'含税总成本 + 到手价 × 4% + 100',value:'¥'+money(t.basis)},{label:'EXCEL 利润（扣分期费）',value:'¥'+money(t.taxProfit-p.fee),profitTone:profitTone(t.taxProfit-p.fee)},{label:'ERP 利润',value:t.erpProfit===null?'待补成本':'¥'+money(t.erpProfit),profitTone:profitTone(t.erpProfit),afterInstallment:t.erpProfit!==null&&p.term>0?'分期后实际 ¥'+money(t.erpProfit-p.fee):'',afterTone:profitTone(t.erpProfit===null?null:t.erpProfit-p.fee)},{label:'ERP 未识别 / 待核算行',value:t.missing}]};
}
