import {chargeCents,moneyCents,pricing,readInstallment} from './pricing.js';
import {overviewFeeRate,overviewTableTotals,PROFIT_FORMULA_VERSION} from './overview-table-model.js';
import {isSpecialComponent,normalizeSpecialComponent} from './special-components.js';

const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const bounded=value=>value>=-MAX&&value<=MAX?Number(value):null;
const identity=value=>typeof value==='string'?value:typeof value==='number'&&value!==0?String(value):'';
const qty=value=>{
 const number=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
 return Number.isSafeInteger(number)&&number>=1&&number<=1000?number:null;
};
const text=value=>typeof value==='string'?value:'';
const linkKey=row=>JSON.stringify([row.shopId,identity(row.productId)]);

/** 对选定的 NAS 正文按原工作台手动检测口径核算；此处不写利润历史或业务记录。 */
export function buildNasProfitReport({shopId,configIds,configs,settings,linkConfigs=configs}){
 if(!Array.isArray(configIds)||!configIds.length||configIds.length>5000||new Set(configIds).size!==configIds.length||
    !Array.isArray(configs)||!Array.isArray(linkConfigs)||!settings||typeof settings!=='object'||Array.isArray(settings))
  throw Error('检测范围或店铺费用设置未完整载入。');
 const eligible=row=>row?.shopId===shopId&&!row.deletedAt&&!row.emptyLinkDraft&&row.productCategory!=='主机模板';
 const byId=new Map();
 for(const row of configs){
  if(!row||row.shopId!==shopId||typeof row.id!=='string'||byId.has(row.id))throw Error('检测资料不属于当前店铺或配置重复。');
  byId.set(row.id,row);
 }
 if(configIds.some(id=>!eligible(byId.get(id))))throw Error('选中配置已变化，请重新打开检测。');
 // 使用同链接全部有效配置的分期信息，不能只因选中的一套有分期就计算。
 const terms=new Map(),seen=new Set();
 for(const summary of linkConfigs){
  if(!summary||summary.shopId!==shopId||summary.deletedAt)continue;
  const row=byId.get(summary.id)||summary, key=linkKey(row);
  if(!terms.has(key))terms.set(key,new Set());
  terms.get(key).add(readInstallment(row));seen.add(row.id);
 }
 for(const row of configs){
  if(seen.has(row.id)||row.deletedAt)continue;
  const key=linkKey(row);if(!terms.has(key))terms.set(key,new Set());
  terms.get(key).add(readInstallment(row));
 }

 const results=[];
 for(const id of configIds){
  const c=byId.get(id),rawParts=c.actualParts??c.parts;
  if(!Array.isArray(rawParts)||rawParts.some(part=>!part||typeof part!=='object'||Array.isArray(part)))
   throw Error('实际成本配件格式无效，请刷新配置再试。');
  const parts=rawParts.flatMap(raw=>{
   const part=normalizeSpecialComponent(raw);
   const goodsId=identity(part.goodsId),name=text(part.name),slot=text(part.slot);
   if(!name&&!goodsId&&!isSpecialComponent(part))return [];
   // 独立核算价只在同一商品行生效，真实零价与缺失严格分开。
   const override=!isSpecialComponent(part)&&part.taxOverride?.goodsId===goodsId&&typeof part.taxOverride.value==='number'?moneyCents(part.taxOverride.value):null;
   const quantity=isSpecialComponent(part)?1:qty(part.qty),taxCents=override??moneyCents(part.tax);
   const costCents=quantity===null||taxCents===null?null:bounded(BigInt(quantity)*BigInt(taxCents));
   return [{slot,name,goodsId,qty:quantity,taxCents,costCents}];
  });
  const termSet=terms.get(linkKey(c)),term=readInstallment(c);
  const quote=pricing(c,{...settings,linkInstallment:termSet?.size===1&&term!==null?term:null});
  const rate=overviewFeeRate(c),taxFixedCents=10000;
  const snapshot={product:text(c.product),name:text(c.name)||id,spu:identity(c.spu),parts,priceCents:quote.priceCents,
   installment:quote.term,feeCents:quote.feeCents,overviewFeeRate:rate,formulaVersion:PROFIT_FORMULA_VERSION,taxFixedCents};
  let reason='',costCents=null,profitCents=null;
  if(quote.priceCents===null||quote.feeCents===null)reason='到手价或分期无效';
  else if(!parts.length)reason='没有实际成本配件';
  else{
   const issues=parts.flatMap(part=>part.qty===null?[`${part.slot||part.name}数量无效`]:
    part.taxCents===null?[`${part.slot||part.name}含税价缺失`]:[]);
   if(parts.some(part=>part.taxCents!==null&&part.qty!==null&&part.costCents===null))reason='成本金额超过核算范围';
   else if(issues.length)reason=issues.join('；');
   else{
    const sum=parts.reduce((total,part)=>total+BigInt(part.costCents),0n);
    costCents=bounded(sum);
    if(costCents===null)reason='成本金额超过核算范围';
    else{
     // 与价格页及配置总表共用公式，快照冻结费率和口径版本，旧基准自然产生不同指纹。
     const summary=overviewTableTotals(c,{tax:costCents/100,erp:null},quote);
     snapshot.commissionCents=chargeCents(costCents,rate);
     snapshot.rateCostCents=moneyCents(summary.fee);
     profitCents=bounded(BigInt(quote.priceCents)-sum-BigInt(snapshot.commissionCents)-BigInt(taxFixedCents)-BigInt(quote.feeCents));
     if(profitCents===null)reason='利润金额超过核算范围';
    }
   }
  }
  results.push({shop_id:shopId,config_id:id,metric:'accounting',snapshot,valid:profitCents!==null,
   cost_cents:costCents,profit_cents:profitCents,loss:profitCents!==null&&profitCents< -30000,changed:false,reason});
 }
 return {run:{status:'completed',erpCollected:false},results};
}
