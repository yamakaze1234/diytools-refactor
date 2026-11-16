import {totals} from './core.js';
import {pricing,moneyCents,chargeCents,DEFAULT_PROFIT_ALERT,PROFIT_ALERT_BASES,normalizeProfitAlerts} from './pricing.js';

export const linkKey=config=>JSON.stringify([config.shopId,config.productId]);
export const MAX_ARRIVAL=1000000;

export function parseArrival(value){
 const text=String(value??'').trim();
 if(text==='')return null;
 if(!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)||Number(text)>MAX_ARRIVAL)throw Error('请输入 0–1,000,000 元的有效到手价，最多两位小数；留空可清除。');
 return Number(text);
}
function parseId(value,field,allowBlank=false){
 const text=String(value??'').trim().replace(/^'/,'');
 if(!text&&allowBlank)return '';
 if(!/^\d{1,30}$/.test(text))throw Error(field.toUpperCase()+' 须为 1–30 位完整数字，不能有空行或科学计数法。');
 return text;
}
/** Excel 的前导单引号是文本标记；不能用 Number 解析编号。 */
export function parseIdPaste(text,field){
 const lines=String(text).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');
 while(lines.length&&!lines.at(-1).trim())lines.pop();
 if(lines[0]&&new RegExp('^'+field+'(?:\\s*(?:id|编码))?$','i').test(lines[0].trim()))lines.shift();
 if(!lines.length||lines.some(line=>line.includes('\t')))throw Error('请复制单独一列完整编号。');
 return lines.map(line=>parseId(line,field));
}

/** 对照粘贴后的完整身份再应用，允许同批交换编号，任何无效目标都不产生修改。 */
export function planIdEdit(configs,field,ids,values,{allowBlank=false}={}){
 if(!['spu','sku'].includes(field)||!values.length||values.length>ids.length)throw Error('粘贴内容超过当前单元格后可见行数。');
 const rows=configs.filter(c=>!c.deletedAt),indexed=new Map(rows.map(c=>[c.id,c])),updates=new Map();
 values.forEach((raw,i)=>{
  const c=indexed.get(ids[i]);if(!c)throw Error('当前行已改变，请重新选择单元格。');
  const key=field==='sku'?c.id:linkKey(c),value=parseId(raw,field,allowBlank);
  if(updates.has(key)&&updates.get(key)!==value)throw Error('同一链接的 SPU 必须一致。');
  updates.set(key,value);
 });
 const keysById=new Map(),reserved=new Set();
 for(const c of rows){
  const key=field==='sku'?c.id:linkKey(c),value=String(c[field==='sku'?'skuId':'spu']??'');
  if(!updates.has(key)){if(value)reserved.add(JSON.stringify([c.shopId,value]));continue;}
  keysById.set(key,c.shopId);
 }
 for(const [key,value] of updates){
  if(!value)continue;
  const identity=JSON.stringify([keysById.get(key),value]);
  if(reserved.has(identity))throw Error('同一店铺已有其他'+(field==='sku'?'配置使用此 SKU。':'链接使用此 SPU。'));
  reserved.add(identity);
 }
 const attr=field==='sku'?'skuId':'spu';
 return rows.flatMap(c=>{
  const key=field==='sku'?c.id:linkKey(c),value=updates.get(key);
  return value===undefined||c[attr]===value?[]:[{id:c.id,fields:{[attr]:value}}];
 });
}

export function priceProfitRow(config,settings){
 const quote=pricing(config,settings),metrics=totals(config,settings,quote);
 return {config,quote,metrics,alerts:normalizeProfitAlerts(settings.profitAlert)};
}
export function flagsFor(row){
 const {quote,metrics,alerts}=row;
 const hits={loss:[],target:[]};
 // 各检测项独立判断；任一触发即计入该配置，不因两项触发而重复计数。
 for(const basis of alerts?.bases??PROFIT_ALERT_BASES){
  const rule=alerts?.[basis+'Profit']??DEFAULT_PROFIT_ALERT;
  const value=metrics[basis+(rule.mode==='rate'?'Margin':'ProfitAfter')];
  if(value==null)continue;
  if(value<rule.loss)hits.loss.push(basis);
  if(value<rule.target)hits.target.push(basis);
 }
 return {loss:!!hits.loss.length,target:!!hits.target.length,hits,missing:quote.arrival==null||quote.term==null||metrics.tax==null||metrics.erp==null,fallback:metrics.erpFallback>0};
}

/** 用实际舍入后的利润验算目标。至少有 1 分净额浮动空间的保守候选覆盖双重手续费舍入。 */
function targetPrice(row,basis,mode,amount){
 const {quote,metrics}=row,cost=metrics[basis],term=quote.percent;
 if(cost==null||term==null)return {reason:'缺少成本或分期设置'};
 const rate=quote.rule[basis+'Rate'],fixed=quote.rule[basis+'Fixed'],margin=mode==='margin'?amount/100:0;
 const net=1-(rate+term)/100-margin,target=mode==='target'?amount:0,base=cost+fixed+target;
 if(!(net>0))return {reason:'目标利润率过高'};
 const step=1,first=Math.max(step,Math.ceil(base/net-1e-8));
 const satisfies=price=>{
  const cents=moneyCents(price),after=cents-moneyCents(cost)-moneyCents(fixed)-chargeCents(cents,rate)-chargeCents(cents,term);
  return mode==='margin'?after*100>=amount*cents:after>=moneyCents(amount);
 };
 if(first>MAX_ARRIVAL)return {reason:'结果超出价格范围'};
 if(satisfies(first))return {price:first};
 if(first+step<=MAX_ARRIVAL&&satisfies(first+step))return {price:first+step};
 const guarded=Math.ceil((base+.010001)/net);
 if(guarded<=MAX_ARRIVAL&&satisfies(guarded))return {price:guarded};
 if(satisfies(MAX_ARRIVAL))return {price:MAX_ARRIVAL};
 return {reason:'结果超出价格范围'};
}

export function planPriceBatch(rows,{basis,mode,input}){
 const raw=String(input??'').trim(),amount=Number(raw);
 if(!['erp','tax'].includes(basis)||!['delta','ratio','target','margin'].includes(mode)||!raw||!Number.isFinite(amount)||Math.abs(amount)>MAX_ARRIVAL||(['target','margin'].includes(mode)&&amount<0)||mode==='margin'&&amount>=100||mode==='target'&&moneyCents(amount)/100!==amount)throw Error('请输入有效调整值；目标金额最多两位小数，目标利润率应低于 100%。');
 return rows.map(row=>{
  const {config,quote}=row;
  let result;
  if(mode==='target'||mode==='margin')result=targetPrice(row,basis,mode,amount);
  else if(quote.arrival==null)result={reason:'缺少到手价'};
  else{
   const value=mode==='delta'?quote.arrival+amount:quote.arrival*(1+amount/100);
   result=value<0||value>MAX_ARRIVAL?{reason:'结果超出价格范围'}:{price:moneyCents(value)/100};
  }
  return {id:config.id,name:config.name,from:quote.arrival,...result};
 });
}
