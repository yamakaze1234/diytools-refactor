-- 试验库已有写角色需要读取本店档案及设置；不扩大任何写权限。
DO $nas_editor_grant$
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '只允许试验库'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_operations') OR to_regclass('intel_live.shops') IS NULL
  THEN RAISE EXCEPTION '请先核对英特尔运行区与操作角色'; END IF;
 GRANT SELECT ON intel_live.shops TO diy_api_operations;
END $nas_editor_grant$;
