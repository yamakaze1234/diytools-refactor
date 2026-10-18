/** 价格变动报表：完整批次/每日快照，不受界面筛选和分页影响。 */
import {priceMovement,trackedProfit,linkKey} from './price-changes.js';
import {makeZip} from './zip.js';
const amount=v=>v==null?'待补齐':v/100;
const delta=(a,b)=>a==null||b==null?'不可比较':(b-a)/100;
const kinds={high:'上涨 ≥5% / 从零上涨',up:'上涨 <5%',down:'降价',first:'首次采集',missing:'价格缺失',same:'未变化'};
export function priceReportSheets(batch,{configs=[],shopName=id=>id,at=new Date().toISOString()}={}){
 if(batch.daily&&!batch.baselineKnown)throw Error('缺少可核验的昨日基线，无法导出昨日对比报表');
 const live=new Map(configs.filter(c=>!c.deletedAt).map(c=>[c.id,c]));
 const movement=(row,key)=>{const m=priceMovement(row,key);return [kinds[m.kind],m.delta==null?'不可比较':m.delta/100,m.percent==null?'不可比较':Number(m.percent.toFixed(4))];};
 return [
  {name:'报表说明',rows:[['项目','内容'],['对比方式',batch.daily?'昨日最后保存价 → 今日最新保存价':'本批次保存前 → 保存后'],['日期/批次',batch.daily?batch.day:String(batch.revision)],['记录时间',batch.at],['导出时间',at],['导出范围','当前完整对比，包含全部配件和受影响配置，不受筛选、分页影响'],['变动配件数',new Set(batch.items.map(r=>r.goodsId)).size],['影响链接数',new Set(batch.configs.map(r=>linkKey(r.after))).size],['影响配置数',batch.configs.length],['金额单位','人民币元；幅度为百分数，5 表示 5%'],['利润口径','实际 BOM，扣分期费；ERP 成本缺失时使用核算成本代入并标注'],['当前利润','导出时已保存配置；不包含未保存草稿'],['链接明细','每套配置一行，同链接多套配置分别列出'],['处理状态','每日对比请到逐批次查看处理标记']]},
  {name:'配件价格变化',rows:[['ERP编码','配件名称','配件类型','成本价-前','成本价-后','成本分类','成本变动金额','成本幅度(%)','ERP价-前','ERP价-后','ERP分类','ERP变动金额','ERP幅度(%)','影响链接数','影响配置数'],...batch.items.map(r=>[String(r.goodsId),r.name,r.slots.join(' / '),amount(r.before.tax),amount(r.after.tax),...movement(r,'tax'),amount(r.before.erp),amount(r.after.erp),...movement(r,'erp'),new Set(batch.configs.filter(c=>r.configIds.includes(c.after.id)).map(c=>linkKey(c.after))).size,r.configIds.length])]},
  {name:'受影响链接与利润',rows:[['店铺','商品ID','链接名称','商品网址','配置ID','配置名称','到手价-前','到手价-后','核算利润-前','核算利润-后','核算利润变化','ERP利润-前','ERP利润-后','ERP利润变化','当前已保存到手价','当前核算利润','当前ERP利润','ERP成本代入说明','处理状态','变价配件'],...batch.configs.map(r=>{
   const c=r.after,now=live.get(c.id),before=trackedProfit(r.before),after=trackedProfit(c),current=trackedProfit(now);
   return [shopName(c.shopId),String(c.productId??''),c.product,c.productUrl||'',c.id,c.name,r.before.price??'待补齐',c.price??'待补齐',amount(before?.tax),amount(after?.tax),delta(before?.tax,after?.tax),amount(before?.erp),amount(after?.erp),delta(before?.erp,after?.erp),now?.price??'配置不存在',amount(current?.tax),amount(current?.erp),[before?.fallback?'对比前':null,after?.fallback?'对比后':null,current?.fallback?'当前':null].filter(Boolean).join('、')||'无',batch.daily?'请查看逐批次':batch.handled.includes(c.id)?'已处理':'待处理',batch.items.filter(i=>i.configIds.includes(c.id)).map(i=>`${i.name} [${i.goodsId}]`).join('\n')];
  })]}
 ];
}
const xml=v=>String(v??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const col=i=>{let s='';for(i++;i;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;};
export function priceReportWorkbook(sheets){
 const ns='http://schemas.openxmlformats.org',files=[];
 const add=(name,body)=>files.push({name,bytes:new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+body)});
 add('[Content_Types].xml',`<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
 add('_rels/.rels',`<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
 add('xl/workbook.xml',`<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
 add('xl/_rels/workbook.xml.rels',`<Relationships xmlns="${ns}/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`);
 sheets.forEach((s,i)=>{
  if(s.rows.length>1048576||s.rows.some(r=>r.some(v=>String(v??'').length>32767)))throw Error('报表超出 Excel 行数或单格文字上限');
  const end=`${col(s.rows[0].length-1)}${s.rows.length}`;
  add(`xl/worksheets/sheet${i+1}.xml`,`<worksheet xmlns="${ns}/spreadsheetml/2006/main"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${s.rows[0].length}" width="24" customWidth="1"/></cols><sheetData>${s.rows.map((r,n)=>`<row r="${n+1}">${r.map((v,j)=>`<c r="${col(j)}${n+1}"${typeof v==='number'&&Number.isFinite(v)?`><v>${v}</v>`:` t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${end}"/></worksheet>`);
 });
 return new Blob([makeZip(files)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
