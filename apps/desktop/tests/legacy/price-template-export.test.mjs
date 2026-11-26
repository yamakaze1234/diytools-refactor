import test from 'node:test';
import assert from 'node:assert/strict';
import {planPriceTemplateExport,priceTemplateWorkbook} from '../../public/workbench/price-template-export.js';

const spu='1234567890123456789',skuId='9876543210987654321';
const config=(id,fields={})=>({id,shopId:'intel',productId:'link-'+id,product:'测试链接',name:'配置 '+id,spu,skuId,price:100,...fields});
const options={shopId:'intel',settings:{coupon:0}};

// 按现有 ZIP 的无压缩文件头提取 XML，避免把归档目录当成工作表内容。
async function readWorkbook(rows){
 const buffer=await priceTemplateWorkbook(rows).arrayBuffer(),view=new DataView(buffer),decoder=new TextDecoder(),files=new Map();
 for(let offset=0;view.getUint32(offset,true)===0x04034b50;){
  assert.equal(view.getUint16(offset+8,true),0);
  const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true);
  const name=decoder.decode(new Uint8Array(buffer,offset+30,nameLength));
  const start=offset+30+nameLength+extraLength;
  files.set(name,decoder.decode(new Uint8Array(buffer,start,size)));
  offset=start+size;
 }
 return files;
}
const cell=(sheet,ref)=>sheet.match(new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?</c>`))?.[0];
const cellText=xml=>xml.match(/<t xml:space="preserve">([\s\S]*?)<\/t>/)?.[1];
const attr=(xml,key)=>xml.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
const styleOf=(xml,styles)=>styles[Number(attr(xml,'s')??0)];

test('模板逐字保留导入说明、冻结前两行，仅必填表头使用黄色和深色粗体',async()=>{
 const plan=planPriceTemplateExport([config('base')],options);
 const blob=priceTemplateWorkbook(plan.rows);
 assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const files=await readWorkbook(plan.rows),sheet=files.get('xl/worksheets/sheet1.xml'),style=files.get('xl/styles.xml');
 assert.match(files.get('xl/workbook.xml'),/<sheet name="价格模板"/);
 assert.match(files.get('xl/_rels/workbook.xml.rels'),/relationships\/styles[^>]+Target="styles.xml"/);
 assert.match(sheet,/<row r="1" ht="76" customHeight="1">/);
 assert.equal(cellText(cell(sheet,'A1')),`“价格”导入注意事项：请参考以下格式模板，修改商品价格信息
1. 系统以商品ID+SkuId确定信息唯一性,同一个商品ID需要连续出现，不能分散出现
2. 黄色填充字段信息表示“必填”，其余为选项或有默认值字段
3. 表头规定：以下字段表头为固定位置不允许调换，需按模板表头顺序完成商品信息编辑`);
 assert.match(sheet,/<mergeCell ref="A1:F1"\/>/);
 assert.match(sheet,/<pane ySplit="2" topLeftCell="A3"[^>]+state="frozen"/);
 const styles=style.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].match(/<xf[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
 assert.match(styleOf(cell(sheet,'A1'),styles),/wrapText="1"/);
 const headerRow=sheet.match(/<row r="2">(.*?)<\/row>/)[1];
 const headerCells=headerRow.match(/<c\b.*?<\/c>/g);
 assert.deepEqual(headerCells.map(xml=>attr(xml,'r')),['A2','B2','C2','D2','E2','F2']);
 assert.deepEqual(headerCells.map(cellText),['商品id(必填)','商品名称','规格ID[SkuId](必填)','商家编码','商品规格','价格(必填)']);
 const fills=style.match(/<fill>.*?<\/fill>/g),fonts=style.match(/<font>.*?<\/font>/g);
 for(const [i,header] of headerCells.entries()){
  const xf=styleOf(header,styles),fill=fills[Number(attr(xf,'fillId'))];
  if([0,2,5].includes(i)){
   assert.match(fill,/<patternFill patternType="solid"><fgColor rgb="FFFFFF00"\/>/);
   assert.match(fonts[Number(attr(xf,'fontId'))],/<b\/>.*<color rgb="FF222222"\/>/);
   assert.equal(attr(xf,'applyFill'),'1');
  }else assert.match(fill,/patternType="none"/);
 }
 for(const ref of ['A3','C3'])assert.equal(attr(styleOf(cell(sheet,ref),styles),'numFmtId'),'49');
});

test('19 位编号和前导零保留为文本，三列留空，售价包含店铺券且写为数值',async()=>{
 const plan=planPriceTemplateExport([config('integer',{spu:` ${spu} `,price:'99.8'}),config('decimal',{skuId:'0123456789012345678',price:123.25})],{...options,settings:{coupon:0.2}});
 assert.deepEqual(plan.rows,[
  {spu,skuId,listPrice:100,configId:'integer',product:'测试链接',name:'配置 integer'},
  {spu,skuId:'0123456789012345678',listPrice:123.45,configId:'decimal',product:'测试链接',name:'配置 decimal'}
 ]);
 const sheet=(await readWorkbook(plan.rows)).get('xl/worksheets/sheet1.xml');
 for(const [i,row] of plan.rows.entries()){
  const n=i+3,xml=sheet.match(new RegExp(`<row r="${n}">(.*?)</row>`))[1];
  assert.deepEqual([...xml.matchAll(/<c r="([A-F])\d+"/g)].map(match=>match[1]),['A','B','C','D','E','F']);
  for(const [column,value] of Object.entries({A:row.spu,B:'',C:row.skuId,D:'',E:''})){
   const text=cell(sheet,column+n);
   assert.equal(attr(text,'t'),'inlineStr');
   assert.equal(cellText(text),value);
  }
  assert.equal(cell(sheet,'F'+n),`<c r="F${n}"><v>${row.listPrice}</v></c>`);
 }
});

test('相同 SPU 聚拢，保持 SPU 和组内 SKU 首次出现顺序',()=>{
 const source=[['c1','30','1'],['c2','20','1'],['c3','30','2'],['c4','10','42'],['c5','20','2'],['c6','30','3']];
 const plan=planPriceTemplateExport(source.map(([id,spu,skuId])=>config(id,{spu,skuId})),options);
 assert.deepEqual(plan.rows.map(row=>[row.configId,row.spu,row.skuId]),[source[0],source[2],source[5],source[1],source[4],source[3]]);
 assert.equal(plan.spuCount,3);
 assert.equal(plan.totalCount,6);
 assert.deepEqual(plan.skipped,[]);
});

test('仅核验本店普通配置，按顺序记录无效原因，重复组合保留首条',()=>{
 const plan=planPriceTemplateExport([
  config('other',{shopId:'jonsbo',productId:'live',productDraft:true}),
  config('deleted',{deletedAt:'2026-11-26',productId:'live',productDraft:true}),
  config('placeholder',{emptyLinkDraft:true,productId:'placeholder-link',productDraft:true}),
  config('placeholder-neighbor',{productId:'placeholder-link'}),
  config('draft',{productId:'draft-link',productDraft:true}),config('draft-neighbor',{productId:'draft-link'}),
  config('missing-spu',{spu:'   '}),config('zero-spu',{spu:' 000 '}),config('long-spu',{spu:'7'.repeat(31)}),
  config('missing-sku',{skuId:''}),config('zero-sku',{skuId:'000'}),config('invalid-sku',{skuId:'1e18'}),
  config('unsafe-spu',{spu:Number(spu),skuId:''}),config('unsafe-sku',{skuId:Number(skuId)}),
  config('no-price',{price:undefined}),config('blank-price',{price:' '}),config('zero-price',{price:0}),config('invalid-price',{price:-1}),
  config('live',{shopId:undefined,productId:'live'}),config('duplicate',{spu:` ${spu} `,price:222}),
  config('safe-number',{spu:25,skuId:2})
 ],options);
 const risky='SPU 或 SKU 存在数字精度风险，请重新填写文本编号';
 assert.deepEqual(plan.skipped.map(({id,reason})=>[id,reason]),[
  ['placeholder-neighbor','草稿区链接'],['draft','草稿区链接'],['draft-neighbor','草稿区链接'],
  ['missing-spu','缺少有效 SPU'],['zero-spu','缺少有效 SPU'],['long-spu','缺少有效 SPU'],
  ['missing-sku','缺少有效 SKU'],['zero-sku','缺少有效 SKU'],['invalid-sku','缺少有效 SKU'],
  ['unsafe-spu',risky],['unsafe-sku',risky],['no-price','未填写到手价'],['blank-price','未填写到手价'],
  ['zero-price','售价须大于 0'],['invalid-price','售价须大于 0'],['duplicate','同店存在重复的 SPU + SKU']
 ]);
 assert.deepEqual(plan.skipped.at(-1),{id:'duplicate',product:'测试链接',name:'配置 duplicate',spu,skuId,reason:'同店存在重复的 SPU + SKU'});
 assert.deepEqual(plan.rows.map(row=>[row.configId,row.spu,row.skuId,row.listPrice]),[['live',spu,skuId,100],['safe-number','25','2',100]]);
 assert.equal(plan.spuCount,2);
 assert.equal(plan.totalCount,18);
});

test('独立链接数据也能标记草稿，店铺券正值允许零元到手价',()=>{
 const configs=[config('draft-row',{productId:undefined}),config('zero-arrival',{spu:'1',price:0})];
 const links=[...configs,config('draft-marker',{productId:undefined,emptyLinkDraft:true,productDraft:true})];
 const plan=planPriceTemplateExport(configs,{...options,settings:{coupon:3},links});
 assert.deepEqual(plan.skipped.map(row=>[row.id,row.reason]),[['draft-row','草稿区链接']]);
 assert.equal(plan.totalCount,2);
 assert.deepEqual(plan.rows.map(row=>[row.configId,row.listPrice]),[['zero-arrival',3]]);
});

test('空模板与 Excel 超限报错，特殊字符作为安全的内联文本写入',async()=>{
 assert.throws(()=>priceTemplateWorkbook([]),/当前店铺没有可导出的有效价格配置/);
 assert.throws(()=>priceTemplateWorkbook(new Array(1048575)),/1048576 行上限/);
 assert.throws(()=>priceTemplateWorkbook([{spu:'7'.repeat(32768),skuId,listPrice:1}]),/A3.*32767 字符上限/);
 const files=await readWorkbook([{spu:`=SUM(<1>&"2"'3')\u0000\u000B\uD800\uFFFE\n下一行`,skuId,listPrice:1}]);
 const xml=cell(files.get('xl/worksheets/sheet1.xml'),'A3');
 assert.equal(attr(xml,'t'),'inlineStr');
 assert.equal(cellText(xml),'=SUM(&lt;1&gt;&amp;&quot;2&quot;&apos;3&apos;)\n下一行');
 for(const content of files.values())assert.doesNotMatch(content,/<f(?:\s|>|\/)/);
});
