// 所有业务查询固定字段且使用参数绑定；销售查询从源头排除成本与原始JSON。
import {Fault,requireValue} from './config.mjs';
export class Store {
 constructor(pool){this.pool=pool;}
 async roles(member){return (await this.pool.query(`SELECT r.shop_id,r.role FROM nas_business.members m JOIN nas_business.shop_roles r USING(workspace_id,uid) WHERE m.workspace_id=$1 AND m.uid=$2 AND m.enabled ORDER BY r.shop_id`,[member.workspaceId,member.uid])).rows;}
 async configurations(shop,{id=null,sales=false,limit=50,offset=0,search=''}={}){
  const rows=(await this.pool.query(`SELECT c.configuration_id,c.name,c.sku_id,p.spu,p.shop_id,c.version::text,
    pr.amount_cents::text AS final_price_cents,sp.published,
    CASE WHEN sp.configuration_id IS NULL THEN 'not_selected' WHEN pr.amount_cents IS NULL THEN 'unavailable' ELSE 'available' END AS quotation_status
    FROM intel_v2.configurations c JOIN intel_v2.products p USING(product_id)
    LEFT JOIN nas_business.sales_publications sp USING(configuration_id)
    LEFT JOIN intel_v2.configuration_prices pr ON pr.configuration_id=c.configuration_id AND pr.price_source=sp.price_source AND pr.batch_id=sp.price_batch_id
    WHERE p.shop_id=$1 AND NOT c.is_example AND c.deleted_at IS NULL
    AND ($2::text IS NULL OR c.configuration_id=$2) AND (NOT $3::boolean OR sp.published=true)
    AND ($4='' OR strpos(lower(c.name),lower($4))>0 OR strpos(p.spu,$4)>0 OR strpos(COALESCE(c.sku_id,''),$4)>0)
    ORDER BY c.configuration_id LIMIT $5 OFFSET $6`,[shop,id,sales,search,limit,offset])).rows;
  return rows.map(r=>({configuration_id:r.configuration_id,name:r.name,sku_id:r.sku_id,spu:r.spu,shop_id:r.shop_id,version:r.version,final_price_cents:r.final_price_cents,quotation_status:r.quotation_status,...(!sales?{published:r.published===true}:{})}));
 }
 async detail(shop,id,sales){
  const rows=await this.configurations(shop,{id,sales});if(!rows.length)throw new Fault('NOT_FOUND',404);
  // 运营可读取展示与实际BOM；销售只读取展示行，不获取成本列。
  const columns=sales?'':',part_kind,erp_unit_cents::text,tax_unit_cents::text,cost_policy';
  const parts=(await this.pool.query(`SELECT line_id,position,slot,name,qty${columns} FROM intel_v2.configuration_parts WHERE configuration_id=$1 AND ($2=false OR part_kind='display') ORDER BY part_kind,position`,[id,sales])).rows;
  return {...rows[0],parts};
 }
 async addons(shop,id,sales){
  if(!(await this.configurations(shop,{id,sales})).length)throw new Fault('NOT_FOUND',404);
  // 显式覆盖优先，其次使用已迁移的快照字段；不可把缺失快照补成共享值。
  const rows=(await this.pool.query(`SELECT a.addon_id,a.addon_type,r.relation_kind,r.follow_policy,
    CASE WHEN r.description_overridden THEN r.description_override WHEN r.follow_policy='snapshot' THEN r.snapshot_description ELSE a.description END AS description,
    (CASE WHEN r.price_overridden THEN r.price_override_cents WHEN r.follow_policy='snapshot' THEN r.snapshot_price_cents ELSE a.additional_price_cents END)::text AS additional_price_cents,
    a.original_qty,
    CASE WHEN a.addon_type='text_only' THEN 'text_only_unconfirmed' WHEN (CASE WHEN r.price_overridden THEN r.price_override_cents WHEN r.follow_policy='snapshot' THEN r.snapshot_price_cents ELSE a.additional_price_cents END) IS NULL THEN 'unavailable' ELSE 'available' END AS quotation_status
    FROM intel_v2.configuration_addons r JOIN intel_v2.addon_options a USING(addon_id)
    WHERE r.configuration_id=$1 AND a.enabled AND NOT a.is_example ORDER BY a.addon_id,r.relation_kind`,[id])).rows;
  const items=(await this.pool.query(`SELECT i.addon_id,i.position,c.goodsid,c.name,i.qty FROM intel_v2.addon_items i JOIN intel_v2.components c USING(component_id)
    WHERE NOT c.is_example AND EXISTS(SELECT 1 FROM intel_v2.configuration_addons r JOIN intel_v2.addon_options a USING(addon_id) WHERE r.configuration_id=$1 AND r.addon_id=i.addon_id AND a.enabled AND NOT a.is_example) ORDER BY i.addon_id,i.position`,[id])).rows;
  return rows.filter(r=>!sales||r.addon_type!=='text_only').map(r=>{const {follow_policy,relation_kind,...publicFields}=r;return {...(sales?publicFields:r),items:items.filter(i=>i.addon_id===r.addon_id).map(({addon_id,...i})=>i)};});
 }
}
export function authorize(roles,shop,sales){requireValue(roles.some(r=>r.shop_id===shop&&(sales||r.role==='operations')),'FORBIDDEN',403);}
