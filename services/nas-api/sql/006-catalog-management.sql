-- 仅在试验库整条执行。默认不授任何人共享维护权；只增加目录事务、审计和最小运行权限。
DO $nas_catalog$
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '只允许试验库'; END IF;
 IF NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel') OR
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_operations')
 THEN RAISE EXCEPTION '请先核对独立运行区及现有服务角色'; END IF;
 PERFORM pg_advisory_xact_lock(814517,3);

 CREATE TABLE IF NOT EXISTS intel_live.catalog_shared_editors(
  workspace_id text NOT NULL, uid text NOT NULL,
  resource_kind text NOT NULL CHECK(resource_kind IN ('sources','gallery')),
  PRIMARY KEY(workspace_id,uid,resource_kind),
  FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members
 );
 CREATE TABLE IF NOT EXISTS intel_live.catalog_receipts(
  workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
  shop_id text NOT NULL REFERENCES intel_live.shops,
  kind text NOT NULL CHECK(kind IN ('sources','addons','gallery','templates','assets')),
  resource_id text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_uid,operation_id)
 );
 CREATE TABLE IF NOT EXISTS intel_live.catalog_audit(
  workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('create','replace','archive','restore','copy','upload')),
  previous_version bigint, next_version bigint NOT NULL CHECK(next_version>0),
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_uid,operation_id),
  FOREIGN KEY(workspace_id,actor_uid,operation_id) REFERENCES intel_live.catalog_receipts
 );
 COMMENT ON TABLE intel_live.catalog_shared_editors IS 'DBA显式核准的共享目录维护范围，不能由运营接口自授';
 COMMENT ON TABLE intel_live.catalog_receipts IS '仅同成员同请求重用的目录保存回执；原库和配置回执不改';
 COMMENT ON TABLE intel_live.catalog_audit IS '目录调用人、动作及版本审计；服务账号不可修改或删除';

 -- 固定查询路径；服务事务内登记原认证身份，直接连接时没有该身份便不允许改目录。
 CREATE OR REPLACE FUNCTION intel_live.catalog_is_operator() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $check$
 SELECT EXISTS(SELECT 1 FROM nas_business.members m JOIN nas_business.shop_roles r USING(workspace_id,uid)
  WHERE m.workspace_id=current_setting('intel_live.catalog_workspace',true)
  AND m.uid=current_setting('intel_live.catalog_uid',true) AND m.enabled AND r.role='operations' AND r.shop_id='intel')
 $check$;
 CREATE OR REPLACE FUNCTION intel_live.catalog_can_write(owner text, shared_flag boolean, kind text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $check$
 SELECT intel_live.catalog_is_operator() AND
  ((owner='intel' AND NOT shared_flag) OR
   ((owner='intel' OR owner='shared') AND EXISTS(SELECT 1 FROM intel_live.catalog_shared_editors g
    WHERE g.workspace_id=current_setting('intel_live.catalog_workspace',true)
    AND g.uid=current_setting('intel_live.catalog_uid',true) AND g.resource_kind=kind)))
 $check$;
 REVOKE ALL ON FUNCTION intel_live.catalog_is_operator(),intel_live.catalog_can_write(text,boolean,text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION intel_live.catalog_is_operator(),intel_live.catalog_can_write(text,boolean,text) TO diy_api_operations;

 ALTER TABLE intel_live.sources ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.gallery ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.templates ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.assets ENABLE ROW LEVEL SECURITY;

 DROP POLICY IF EXISTS catalog_sources_select ON intel_live.sources;
 CREATE POLICY catalog_sources_select ON intel_live.sources FOR SELECT TO diy_api_operations USING (true);
 DROP POLICY IF EXISTS catalog_sources_insert ON intel_live.sources;
 CREATE POLICY catalog_sources_insert ON intel_live.sources FOR INSERT TO diy_api_operations
 WITH CHECK (owner_shop='intel' AND NOT shared AND intel_live.catalog_is_operator());
 DROP POLICY IF EXISTS catalog_sources_update ON intel_live.sources;
 CREATE POLICY catalog_sources_update ON intel_live.sources FOR UPDATE TO diy_api_operations
 USING (intel_live.catalog_can_write(owner_shop,shared,'sources')) WITH CHECK (intel_live.catalog_can_write(owner_shop,shared,'sources'));

 DROP POLICY IF EXISTS catalog_gallery_select ON intel_live.gallery;
 CREATE POLICY catalog_gallery_select ON intel_live.gallery FOR SELECT TO diy_api_operations USING (true);
 DROP POLICY IF EXISTS catalog_gallery_insert ON intel_live.gallery;
 CREATE POLICY catalog_gallery_insert ON intel_live.gallery FOR INSERT TO diy_api_operations
 WITH CHECK (owner_shop='intel' AND NOT shared AND intel_live.catalog_is_operator());
 DROP POLICY IF EXISTS catalog_gallery_update ON intel_live.gallery;
 CREATE POLICY catalog_gallery_update ON intel_live.gallery FOR UPDATE TO diy_api_operations
 USING (intel_live.catalog_can_write(owner_shop,shared,'gallery')) WITH CHECK (intel_live.catalog_can_write(owner_shop,shared,'gallery'));

 DROP POLICY IF EXISTS catalog_templates_select ON intel_live.templates;
 CREATE POLICY catalog_templates_select ON intel_live.templates FOR SELECT TO diy_api_operations USING (shop_id='intel');
 DROP POLICY IF EXISTS catalog_templates_insert ON intel_live.templates;
 CREATE POLICY catalog_templates_insert ON intel_live.templates FOR INSERT TO diy_api_operations
 WITH CHECK (shop_id='intel' AND intel_live.catalog_is_operator());
 DROP POLICY IF EXISTS catalog_templates_update ON intel_live.templates;
 CREATE POLICY catalog_templates_update ON intel_live.templates FOR UPDATE TO diy_api_operations
 USING (shop_id='intel' AND intel_live.catalog_is_operator()) WITH CHECK (shop_id='intel' AND intel_live.catalog_is_operator());

 DROP POLICY IF EXISTS catalog_assets_select ON intel_live.assets;
 CREATE POLICY catalog_assets_select ON intel_live.assets FOR SELECT TO diy_api_operations USING (true);
 DROP POLICY IF EXISTS catalog_assets_insert ON intel_live.assets;
 CREATE POLICY catalog_assets_insert ON intel_live.assets FOR INSERT TO diy_api_operations WITH CHECK (intel_live.catalog_is_operator());

 GRANT SELECT ON intel_live.catalog_shared_editors,intel_live.catalog_receipts TO diy_api_operations;
 GRANT INSERT ON intel_live.catalog_receipts,intel_live.catalog_audit TO diy_api_operations;
 GRANT INSERT ON intel_live.sources,intel_live.gallery,intel_live.templates,intel_live.assets TO diy_api_operations;
 GRANT UPDATE(goodsid,name,attrs,version) ON intel_live.sources TO diy_api_operations;
 GRANT UPDATE(legacy_uri,brand,model,color,edition,attrs,version) ON intel_live.gallery TO diy_api_operations;
 GRANT UPDATE(name,configurations,attrs,version) ON intel_live.templates TO diy_api_operations;
END $nas_catalog$;
