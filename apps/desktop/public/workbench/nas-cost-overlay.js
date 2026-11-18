/** NAS 只在显示和计算时叠加英特尔观察值，保留实际 BOM、人工作价和历史快照。 */
export function visibleNasCosts(config,byId){
 for(const part of [...config.parts,...config.actualParts]){
  const row=byId.get(part.goodsId);
  if(!row)continue;
  if(row.nasErpOverride){
   part.erp=row.erp;part.erpMissing=false;part.erpUnknown=row.erp===null;
  }
  if(row.nasTaxOverride&&!(part.taxOverride?.goodsId===part.goodsId&&Number.isFinite(part.taxOverride.value)))
   part.tax=row.tax;
 }
 return config;
}
/** ERP 快照只能应用当前店明确请求且存在的 ID；缺行保留原样，真实零与 null 分开。 */
export function planNasErpRows(rows,before,kind,at){
 if(!Array.isArray(rows))throw Error('查询结果无效。');
 const seen=new Set(),changes=[];
 for(const row of rows){
  const id=kind==='erp'?row?.goodsId:row?.goods_id;
  if(!before.has(id)||!/^\d{1,20}$/.test(id)||seen.has(id))throw Error('结果含非预期或重复的商品 ID。');
  seen.add(id);
  const old=before.get(id);
  const amount=v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const stock=v=>v===null||typeof v==='number'&&Number.isFinite(v);
  let fields;
  if(kind==='erp'){
   if(!amount(row.erp)||!stock(row.stockAvailable)||typeof row.name!=='string'||typeof row.sku!=='string')
    throw Error('ERP 结果缺少完整成本或库存字段。');
   if(old.document.nasErpOverride&&row.erp===old.document.erp&&row.stockAvailable===old.document.stockAvailable&&
    row.name===old.document.name&&row.sku===old.document.sku)continue;
   fields={erp:row.erp,stockAvailable:row.stockAvailable,name:row.name,sku:row.sku,stockUpdatedAt:at};
  }else{
   if(!amount(row.tax))throw Error('成本表金额无效。');
   if(old.document.nasTaxOverride&&row.tax===old.document.tax)continue;
   fields={tax:row.tax,taxUpdatedAt:at};
  }
  changes.push({id,action:kind==='erp'?'erp_snapshot':'tax_file',expected_version:old.version,fields});
 }
 return {changes,missing:before.size-seen.size};
}
