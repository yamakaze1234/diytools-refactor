import {applyConfigRenumber,planConfigRenumber} from '../../../apps/desktop/public/workbench/config-order.js';
import {suggestedName} from '../../../apps/desktop/public/workbench/legacy-names.js';

// 仅这四个叶值随编号变更。路径由服务端固定，缺失值与显式空串在 JSON 回执中可区分。
const properties=[
 {key:'shortName',column:'fields',path:['shortName']},
 {key:'posterSubtitle',column:'fields',path:['posterSubtitle']},
 {key:'textSubtitle',column:'design',path:['textStyles','header.subtitle','text']},
 {key:'skuTextSubtitle',column:'design',path:['skuTextStyles','header.subtitle','text']},
];

export function renumberFields(document){
 const fields={};
 for(const {key,path} of properties){
  const value=path.reduce((node,part)=>node?.[part],document);
  if(value!==undefined)fields[key]=value;
 }
 return fields;
}

// 沿用店铺写事务。先锁定当前链接次序，再一次读齐确实要生成自动简称的配置及展示配件。
export async function renumberProduct(db,shop,productId){
 const {rows}=await db.query(`SELECT configuration_id AS id,name,version::text,fields,design FROM intel_live.configurations
  WHERE shop_id=$1 AND product_id=$2 AND archived_at IS NULL ORDER BY workspace_order,configuration_id FOR UPDATE`,[shop,productId]);
 const byId=new Map(rows.map(row=>[row.id,row]));
 const changes=planConfigRenumber(rows).filter(row=>row.before!==row.after);
 const autoIds=changes.filter(row=>byId.get(row.id).fields.shortNameAuto===true).map(row=>row.id);
 const autoDocs=new Map();
 if(autoIds.length){
  const {rows:documents}=await db.query(`SELECT configuration_id,document FROM intel_live.configuration_documents
   WHERE shop_id=$1 AND configuration_id=ANY($2::text[])`,[shop,autoIds]);
  for(const {configuration_id,document} of documents)autoDocs.set(configuration_id,document);
 }
 const reordered=[];
 for(const row of changes){
  const previous=byId.get(row.id);
  const doc=previous.fields.shortNameAuto===true?autoDocs.get(row.id):{...previous.fields,...previous.design};
  if(!doc)throw Error('重新编号时无法读取已锁定配置的完整文档');
  const before_fields=renumberFields(doc);
  applyConfigRenumber(doc,row,suggestedName);
  const after_fields=renumberFields(doc);
  // 在数据库原 JSONB 上只更新实际变化的叶值，保留相邻样式、自定义字段和高精度数值。
  const columns={fields:'fields',design:'design'},args=[shop,row.id,doc.name];
  for(const {key,column,path} of properties){
   if(before_fields[key]===after_fields[key])continue;
   const jsonPath=`'{${path.join(',')}}'`;
   if(!Object.hasOwn(after_fields,key))columns[column]=`(${columns[column]} #- ${jsonPath})`;
   else{
    args.push(JSON.stringify(after_fields[key]));
    columns[column]=`jsonb_set(${columns[column]},${jsonPath},$${args.length}::jsonb,true)`;
   }
  }
  const {rows:[saved]}=await db.query(`UPDATE intel_live.configurations SET name=$3,fields=${columns.fields},
   design=${columns.design},version=version+1 WHERE shop_id=$1 AND configuration_id=$2 RETURNING version::text`,args);
  reordered.push({configuration_id:row.id,before:row.before,name:doc.name,previous_version:previous.version,version:saved.version,before_fields,after_fields});
 }
 return reordered;
}
