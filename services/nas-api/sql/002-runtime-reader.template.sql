-- 独立只读运行身份；部署准备工具替换密码占位符，源码不保存实际密码。
DO $runtime$
DECLARE runtime_password text := '__SET_RANDOM_PASSWORD__';
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '请先选择试验库'; END IF;
 IF runtime_password='__SET_RANDOM_PASSWORD__' THEN RAISE EXCEPTION '请使用已生成随机密码的部署文件'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_reader') THEN RAISE EXCEPTION '角色已存在，先回读核对，不自动覆盖密码'; END IF;
 EXECUTE format('CREATE ROLE diy_api_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',runtime_password);
 GRANT CONNECT ON DATABASE diy_workbench_trial TO diy_api_reader;
 GRANT USAGE ON SCHEMA intel_v2,nas_business TO diy_api_reader;
 GRANT SELECT ON nas_business.members,nas_business.shop_roles,nas_business.sales_publications TO diy_api_reader;
 GRANT SELECT ON intel_v2.configurations,intel_v2.products,intel_v2.configuration_prices,
 intel_v2.configuration_parts,intel_v2.configuration_addons,intel_v2.addon_options,
 intel_v2.addon_items,intel_v2.components TO diy_api_reader;
 ALTER ROLE diy_api_reader IN DATABASE diy_workbench_trial SET default_transaction_read_only=on;
 RAISE NOTICE '只读运行账号创建成功；未授予业务写入或建表权限';
END $runtime$;
