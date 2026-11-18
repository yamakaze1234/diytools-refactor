-- 只在试验库单独安装运行账号；部署工具替换密码占位符，不将实际密码留在源码。
DO $role$
DECLARE runtime_password text := '__SET_RANDOM_PASSWORD__';
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '只允许试验库'; END IF;
 IF NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel') THEN RAISE EXCEPTION '请先核验独立运行区'; END IF;
 IF runtime_password='__SET_RANDOM_PASSWORD__' OR length(runtime_password)<32 THEN RAISE EXCEPTION '请通过私有部署配置设置随机密码'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_operations') THEN RAISE EXCEPTION '角色已存在，不覆盖凭据'; END IF;
 EXECUTE format('CREATE ROLE diy_api_operations LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',runtime_password);
 GRANT CONNECT ON DATABASE diy_workbench_trial TO diy_api_operations;
 GRANT USAGE ON SCHEMA intel_live,nas_business TO diy_api_operations;
 GRANT SELECT ON nas_business.members,nas_business.shop_roles TO diy_api_operations;
 GRANT SELECT ON intel_live.bootstrap,intel_live.configurations,intel_live.configuration_documents,intel_live.quotations,
  intel_live.parts,intel_live.addons,intel_live.sources,intel_live.costs,intel_live.gallery,intel_live.templates,
  intel_live.assets,intel_live.publications,intel_live.save_receipts TO diy_api_operations;
 GRANT INSERT ON intel_live.products,intel_live.configurations,intel_live.parts,intel_live.addons,
  intel_live.save_receipts,intel_live.audit_events TO diy_api_operations;
 GRANT UPDATE (product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design,version,archived_at)
  ON intel_live.configurations TO diy_api_operations;
 GRANT DELETE ON intel_live.parts,intel_live.addons TO diy_api_operations;
 -- 后台角色只允许撤下销售发布；不授予可以反向发布的 UPDATE 或 INSERT。
 CREATE OR REPLACE FUNCTION intel_live.withdraw_publication(config_id text) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 UPDATE intel_live.publications SET published=false WHERE configuration_id=config_id
 $fn$;
 REVOKE ALL ON FUNCTION intel_live.withdraw_publication(text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION intel_live.withdraw_publication(text) TO diy_api_operations;
END $role$;
