/** 配件查询索引：按店铺、来源和 ERP 商品身份建立映射，避免重复全表扫描。 */
// 输出源和配置配件的只读查询索引。只引用传入对象，不保存到全局状态，也不访问数据库或网络。
// 调用者在一次绑定、预览或同步开始时创建；增删、恢复、换店、改 goodsId/sourceId 或替换配置数组后必须重建。
const shopOf=row=>row.shopId||'intel';
const append=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value);};
const scoped=(map,shopId,key)=>map.get(shopId)?.get(key)||[];

/** 一次遍历输出源生成可复用索引，调用方可在同批绑定与名称对齐中共享。 */
export function createSourceIndex(rows){
 const bySourceId=new Map(),byGoodsId=new Map();
 for(const row of rows){
  const shopId=shopOf(row);
  if(!bySourceId.has(shopId)){bySourceId.set(shopId,new Map());byGoodsId.set(shopId,new Map());}
  append(bySourceId.get(shopId),row.sourceId,row);
  if(row.goodsId)append(byGoodsId.get(shopId),row.goodsId,row);
 }
 // 桶中保留原始顺序和重复 ID；名称消歧、唯一候选与“最后一条”由调用处按旧规则判断。
 return {bySourceId:(shopId,id)=>scoped(bySourceId,shopId,id),byGoodsId:(shopId,id)=>scoped(byGoodsId,shopId,id)};
}

// includeGoods/includeSources 允许调用方只建本次要查的键，includeActual 控制是否收录实际清单。
// 跨店 ERP 刷新用 byGoodsIdAny；店铺展示资料用 bySourceId，不能误用全店范围。
/** 按所需身份维度建立配置配件反向索引，用于查找批量修改范围。 */
export function createConfigPartIndex(configs,{includeGoods=true,includeActual=true,includeSources=true}={}){
 const sources=new Map(),goods=new Map(),allSources=new Map(),allGoods=new Map();
 for(const config of configs){
  const shopId=shopOf(config);
  if(!sources.has(shopId)){sources.set(shopId,new Map());goods.set(shopId,new Map());}
  // parts 是展示清单，actualParts 是独立的核算清单；调用处必须明确选择范围。
  for(const [scope,parts] of [['display',config.parts||[]],...(includeActual?[['actual',config.actualParts||[]]]:[])])for(const part of parts){
   const ref={config,part,scope};
   if(includeSources&&part.sourceId){append(sources.get(shopId),part.sourceId,ref);append(allSources,part.sourceId,ref);}
   if(includeGoods&&part.goodsId){append(goods.get(shopId),part.goodsId,ref);append(allGoods,part.goodsId,ref);}
  }
 }
 const select=(rows,scope)=>rows.filter(ref=>scope==='all'||ref.scope===scope);
 // 返回的是当前对象引用；仅修改 name/tax/upgrade 等非关联字段时可在一次操作内复用。
 return {bySourceId:(shopId,id,scope='display')=>select(scoped(sources,shopId,id),scope),bySourceIdAny:(id,scope='display')=>select(allSources.get(id)||[],scope),byGoodsId:(shopId,id,scope='all')=>select(scoped(goods,shopId,id),scope),byGoodsIdAny:(id,scope='all')=>select(allGoods.get(id)||[],scope)};
}
