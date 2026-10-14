/** 配件复制粘贴与概览利润：封装剪贴内容，粘贴时重新关联合法来源。 */
import {markSourceFieldManual} from './source-follow.js';
import {actualParts} from './actual-parts.js';
import {isSpecialComponent} from './special-components.js';
import {totals} from './core.js';
import {pricing} from './pricing.js';
import {replaceSourcePart} from './source.js';

/** 从指定配置配件生成可传递的复制数据。 */
export function copyPartPayload(config,index){
 const part=config.parts[index];if(!part)throw Error('配件不存在');
 return structuredClone({shopId:config.shopId,part,addons:(config.addons||[]).filter(a=>part.sourceId&&a.sourceId===part.sourceId)});
}
/** 校验并应用复制内容，同时结合当前输出源恢复绑定。 */
export function pastePartPayload(config,index,payload,catalog){
 if(!payload||payload.shopId!==config.shopId)throw Error('请先复制当前店铺的配件');
 const old=config.parts[index],part=payload.part;if(!old)throw Error('目标配件不存在');
 if(old.slot!==part.slot)throw Error(`请粘贴到“${part.slot}”槽位，避免放错配件`);
 const row=catalog.find(r=>r.sourceId===part.sourceId&&r.goodsId===part.goodsId&&r.shopId===config.shopId&&!r.deletedAt);
 if(!row)throw Error('复制的配件尚未绑定有效输出源或已删除，请重新选择配件');
 replaceSourcePart(config,index,row);
 Object.assign(config.parts[index],{upgrade:part.upgrade,qty:part.qty});
 if(part.displayName)config.parts[index].displayName=part.displayName;
 if(part.sourceFollow)config.parts[index].sourceFollow=structuredClone(part.sourceFollow);
 else{markSourceFieldManual(config.parts[index],'name');markSourceFieldManual(config.parts[index],'upgrade');}
 delete config.parts[index].memoryUpgradeConfirmed;
 if(part.memoryUpgradeConfirmed)config.parts[index].memoryUpgradeConfirmed=part.memoryUpgradeConfirmed;
 config.addons=config.addons.filter(a=>a.sourceId!==row.sourceId);
 config.addons.push(...structuredClone(payload.addons));
}
/** 按店铺定价设置计算配置概览所需利润值。 */
export function overviewProfits(config,settings){
 const t=totals(config),fee=pricing(config,settings).fee;
 const parts=actualParts(config).filter(p=>p.name||p.goodsId);
 return [['tax',t.taxProfit],['erp',t.erpProfit]].map(([field,value])=>parts.length&&value!==null&&(field==='erp'||parts.every(p=>isSpecialComponent(p)||p.tax!=null&&Number.isFinite(Number(p.tax))))?Math.round((value-fee)*100)/100:null);
}
