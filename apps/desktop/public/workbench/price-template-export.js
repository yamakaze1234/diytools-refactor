import {pricing} from './pricing.js';
import {makeZip} from './zip.js';

const notice=`“价格”导入注意事项：请参考以下格式模板，修改商品价格信息
1. 系统以商品ID+SkuId确定信息唯一性,同一个商品ID需要连续出现，不能分散出现
2. 黄色填充字段信息表示“必填”，其余为选项或有默认值字段
3. 表头规定：以下字段表头为固定位置不允许调换，需按模板表头顺序完成商品信息编辑`;
const headers=['商品id(必填)','商品名称','规格ID[SkuId](必填)','商家编码','商品规格','价格(必填)'];
const widths=[24,18,24,16,18,14];
const requiredColumns=new Set([0,2,5]);
const validId=id=>/^\d{1,30}$/.test(id)&&!/^0+$/.test(id);
const unsafeId=id=>typeof id==='number'&&Math.abs(id)>Number.MAX_SAFE_INTEGER;
// 与侧栏分组一致，兼容没有 productId 的旧配置。
const productKey=c=>c.productId||'legacy:'+String(c.spu||c.product||c.id);

export function planPriceTemplateExport(configs,{shopId,settings,links=configs}){
 const inShop=c=>(c.shopId||'intel')===shopId&&!c.deletedAt;
 // 空链接占位不计入导出统计，但仍能标记同链接的普通配置属于草稿区。
 const draftLinks=new Set(links.filter(c=>inShop(c)&&c.productDraft===true).map(productKey));
 const candidates=configs.filter(c=>inShop(c)&&!c.emptyLinkDraft);
 const bySpu=new Map(),skipped=[];
 for(const c of candidates){
  const spu=String(c.spu??'').trim(),skuId=String(c.skuId??'').trim();
  const {product,name}=c;
  let reason,listPrice;
  if(draftLinks.has(productKey(c)))reason='草稿区链接';
  else if(unsafeId(c.spu)||unsafeId(c.skuId))reason='SPU 或 SKU 存在数字精度风险，请重新填写文本编号';
  else if(!validId(spu))reason='缺少有效 SPU';
  else if(!validId(skuId))reason='缺少有效 SKU';
  else{
   ({listPrice}=pricing(c,settings));
   if(listPrice==null||!Number.isFinite(listPrice)||listPrice<=0){
    reason=c.price==null||String(c.price).trim()===''?'未填写到手价':'售价须大于 0';
   }else if(bySpu.get(spu)?.has(skuId))reason='同店存在重复的 SPU + SKU';
  }
  if(reason){skipped.push({id:c.id,product,name,spu,skuId,reason});continue;}
  // 两层 Map 保留 SPU 首次出现顺序和组内 SKU 顺序，同时去除重复组合。
  if(!bySpu.has(spu))bySpu.set(spu,new Map());
  bySpu.get(spu).set(skuId,{spu,skuId,listPrice:Number(listPrice.toFixed(2)),configId:c.id,product,name});
 }
 const rows=Array.from(bySpu.values()).flatMap(group=>Array.from(group.values()));
 return {rows,skipped,spuCount:bySpu.size,totalCount:candidates.length};
}

const ns='http://schemas.openxmlformats.org';
const spreadsheetNs=`${ns}/spreadsheetml/2006/main`;
const officeRels=`${ns}/officeDocument/2006/relationships`;
const packageRels=`${ns}/package/2006/relationships`;
const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.';
const entities={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'};
const styles={normal:0,notice:1,required:2,text:3};

function textCell(ref,value,style=styles.normal){
 const text=String(value??'');
 if(text.length>32767)throw Error(`单元格 ${ref} 超出 Excel 的 32767 字符上限`);
 // 保留说明中的换行；文本按 inlineStr 写入，编号不会作为公式或数值解析。
 const xml=text.replace(/[^\u0009\u000a\u000d\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,'').replace(/[&<>"']/g,c=>entities[c]);
 return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml}</t></is></c>`;
}

const styleSheet=`<styleSheet xmlns="${spreadsheetNs}">
 <fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FF222222"/><name val="Microsoft YaHei"/></font></fonts>
 <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>
 <borders count="1"><border/></borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 </cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** 生成固定六列的抖店模板，ID 保持文本，售价写成 Excel 数值。 */
export function priceTemplateWorkbook(rows){
 if(!rows.length)throw Error('当前店铺没有可导出的有效价格配置');
 if(rows.length+2>1048576)throw Error('价格模板超出 Excel 的 1048576 行上限');
 const headerCells=headers.map((value,i)=>textCell('ABCDEF'[i]+2,value,requiredColumns.has(i)?styles.required:styles.normal)).join('');
 const dataRows=rows.map(({spu,skuId,listPrice},i)=>{
  const n=i+3;
  if(!Number.isFinite(listPrice)||listPrice<=0)throw Error(`第 ${n} 行售价须大于 0`);
  return `<row r="${n}">${textCell('A'+n,spu,styles.text)}${textCell('B'+n,'')}${textCell('C'+n,skuId,styles.text)}${textCell('D'+n,'')}${textCell('E'+n,'')}<c r="F${n}"><v>${listPrice}</v></c></row>`;
 }).join('');
 const cols=widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join('');
 const files={
  '[Content_Types].xml':`<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mime}sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${mime}worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${mime}styles+xml"/></Types>`,
  '_rels/.rels':`<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${officeRels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml':`<workbook xmlns="${spreadsheetNs}" xmlns:r="${officeRels}"><bookViews><workbookView/></bookViews><sheets><sheet name="价格模板" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${officeRels}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeRels}/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml':styleSheet,
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${spreadsheetNs}"><dimension ref="A1:F${rows.length+2}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews><cols>${cols}</cols><sheetData><row r="1" ht="76" customHeight="1">${textCell('A1',notice,styles.notice)}</row><row r="2">${headerCells}</row>${dataRows}</sheetData><mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells></worksheet>`
 };
 const encoder=new TextEncoder();
 const archive=makeZip(Object.entries(files).map(([name,body])=>({name,bytes:encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+body)})));
 return new Blob([archive],{type:`${mime}sheet`});
}
