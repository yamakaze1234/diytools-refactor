-- 先在 DBX 明确选择现有正式 diy_workbench。此语句只有读取，用于核对安装目标与角色边界。
-- 两家新店尚未入库时 targets 中各项应为 false；若以前做过部分工作，先按批次专用回读查证。
WITH intel_bootstrap AS (
 SELECT b.shop_id,b.batch_id,b.payload_sha256,i.manifest->>'source_revision' AS source_revision
 FROM intel_live.bootstrap b JOIN nas_import.batches i USING(batch_id)
 WHERE b.shop_id='intel' AND b.payload_sha256=i.payload_sha256
), targets AS (
 SELECT shop,
  to_regnamespace(shop||'_import') IS NOT NULL AS receiving_exists,
  to_regnamespace(shop||'_live') IS NOT NULL AS runtime_exists,
  to_regnamespace(shop||'_access') IS NOT NULL AS access_exists,
  to_regrole('diy_api_'||shop||'_production') IS NOT NULL AS service_role_exists
 FROM (VALUES ('gigabyte'),('jonsbo')) t(shop)
), intel_functions AS (
 SELECT p.oid::regprocedure::text AS signature,
  r.rolname=current_user AS installer_is_owner,r.rolsuper AS owner_is_superuser,
  p.prosecdef AS security_definer, p.proconfig=ARRAY['search_path=pg_catalog'] AS pinned_path
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
 WHERE n.nspname='intel_live' AND p.proname IN ('catalog_is_operator','set_quotation_publication',
    'operations_activity','operations_activity_page','profit_observe','operations_price_history')
)
SELECT current_database() AS target_database,current_setting('standard_conforming_strings') AS standard_strings,
 (SELECT jsonb_agg(to_jsonb(b)) FROM intel_bootstrap b) AS intel_bootstrap,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY shop) FROM targets t) AS targets,
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY signature) FROM intel_functions f) AS intel_functions,
 to_regnamespace('intel_access') IS NOT NULL AS expanded_intel_access,
 to_regclass('nas_business.operation_groups') IS NOT NULL AS expanded_groups,
 (SELECT count(*) FROM nas_business.members WHERE enabled) AS enabled_legacy_members,
 (SELECT count(*) FROM nas_business.shop_roles WHERE shop_id='intel' AND role='operations') AS intel_direct_operator_rows,
 (SELECT count(*) FROM intel_live.catalog_shared_editors) AS intel_shared_delegates,
 (SELECT count(*) FROM intel_live.publications WHERE published) AS intel_published;
