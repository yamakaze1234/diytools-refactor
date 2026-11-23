import {nasShopIds} from './nas-api-client.js';
import {shopById} from './shops.js';

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
 let protectedCount=0;
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
   // 手动价只有逐项恢复后才重新进入成本表同步。
   if(old.document.nasManualTax===true){protectedCount++;continue;}
   if(old.document.nasTaxOverride&&old.document.nasProvisionalTax!==true&&row.tax===old.document.tax)continue;
   fields={tax:row.tax,taxUpdatedAt:at};
  }
  changes.push({id,action:kind==='erp'?'erp_snapshot':'tax_file',expected_version:old.version,fields});
 }
 return {changes,missing:before.size-seen.size,protectedCount};
}

// NAS 每次从服务端读取三店基线，再用同一份 Excel 或 ERP 快照生成计划。
export function sharedCostGoods(snapshot){
 if(!snapshot?.common||!nasShopIds.every(shop=>snapshot.stores?.[shop]))throw Error('三店成本版本读取不完整，请重新读取。');
 return [...new Set([Object.keys(snapshot.common),...nasShopIds.map(shop=>Object.keys(snapshot.stores[shop]))].flat())];
}

export function planSharedCostSync(snapshot,rows,kind,shop){
 const goods=new Set(sharedCostGoods(snapshot)),seen=new Set();
 const changes=[],examples=[],protectedRows=[];
 const erp=kind==='erp';
 for(const row of rows){
  const id=erp?row.goodsId:row.goods_id;
  if(!goods.has(id)||!/^\d{1,20}$/.test(id)||seen.has(id))throw Error('读取结果包含非预期或重复的货号。');
  seen.add(id);
  const amount=value=>value===null||Number.isFinite(value)&&value>=0;
  if(erp?(!amount(row.erp)||row.stockAvailable!==null&&!Number.isFinite(row.stockAvailable)||typeof row.name!=='string'||typeof row.sku!=='string'):
   !Number.isFinite(row.tax)||row.tax<0)throw Error('读取结果包含无效成本或库存。');
  const common=snapshot.common[id];
  const expected_versions={};
  const differences=[];
  if(!erp&&common&&(common.tax??null)!==row.tax)
   differences.push({goodsId:id,shop:'三店共用',before:common.tax??null,after:row.tax});
  for(const store of nasShopIds){
   const before=snapshot.stores[store][id]||{};
   expected_versions[store]=before.version??null;
   const label=shopById(store).shortName;
   if(erp){
    if(!before.erpOverride||before.erpMissing||before.stockMissing||Boolean(before.erpUnknown)!==(row.erp===null)||(before.erp??null)!==row.erp||
     (before.stockAvailable??null)!==row.stockAvailable||before.name!==row.name||before.sku!==row.sku)
     differences.push({area:label,goodsId:id,name:row.name,before:before.stockAvailable??null,after:row.stockAvailable,
      erpBefore:before.erp??null,erpAfter:row.erp});
   }else if(before.manual===true){
    protectedRows.push({goodsId:id,shop:label,before:before.tax??null,after:row.tax});
   }else if(before.tax!==row.tax||before.taxOverride!==true||before.provisional===true||common?.overrideShops?.includes(store)){
    differences.push({goodsId:id,shop:label,before:before.tax??null,after:row.tax});
   }
  }
  if(!differences.length)continue;
  changes.push({id,action:erp?'erp_sync':'tax_sync',expected_version:expected_versions[shop],expected_versions,
   ...(erp?{}:{expected_shared_version:common?.version??null}),
   fields:erp?{erp:row.erp,stockAvailable:row.stockAvailable,name:row.name,sku:row.sku}:{tax:row.tax}});
  examples.push(...differences);
 }
 return {changes,examples,protectedRows,missing:goods.size-seen.size};
}
