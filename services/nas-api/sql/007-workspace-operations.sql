-- 试验库的整批保存、英特尔成本覆盖和当前报价；原导入表仍只读。
DO $nas_workspace$
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '只允许试验库'; END IF;
 IF to_regprocedure('intel_live.catalog_is_operator()') IS NULL OR
    NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel')
 THEN RAISE EXCEPTION '请先核对独立运行区和目录权限'; END IF;
 PERFORM pg_advisory_xact_lock(814517,4);
 -- 新增空白配置时保留尚未输入的工作台金额；正式报价表不改写。
 ALTER TABLE intel_live.configurations ALTER COLUMN workbench_price_cents DROP NOT NULL;

 CREATE TABLE IF NOT EXISTS intel_live.workspace_receipts(
  workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
  shop_id text NOT NULL CHECK(shop_id='intel'), kind text NOT NULL CHECK(kind IN ('configurations','costs','settings','quotations')),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_uid,operation_id)
 );
 CREATE TABLE IF NOT EXISTS intel_live.workspace_audit(
  workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
  position integer NOT NULL CHECK(position>0), resource_id text NOT NULL, action text NOT NULL,
  previous_version bigint, next_version bigint NOT NULL CHECK(next_version>0),
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_uid,operation_id,position),
  FOREIGN KEY(workspace_id,actor_uid,operation_id) REFERENCES intel_live.workspace_receipts
 );
 CREATE TABLE IF NOT EXISTS intel_live.intel_cost_overrides(
  goodsid text PRIMARY KEY CHECK(goodsid ~ '^[0-9]{1,20}$'), document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
  version bigint NOT NULL CHECK(version>0)
 );
 CREATE TABLE IF NOT EXISTS intel_live.intel_settings_overrides(
  shop_id text PRIMARY KEY CHECK(shop_id='intel') REFERENCES intel_live.shops, settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
  version bigint NOT NULL CHECK(version>0)
 );
 CREATE TABLE IF NOT EXISTS intel_live.intel_quotation_overrides(
  configuration_id text PRIMARY KEY REFERENCES intel_live.configurations,
  sku text NOT NULL CHECK(sku ~ '^[0-9]{1,24}$'), spu text NOT NULL CHECK(spu ~ '^[0-9]{1,24}$'),
  amount_cents bigint NOT NULL CHECK(amount_cents>=0), workbook_sha256 text NOT NULL CHECK(workbook_sha256 ~ '^[0-9a-f]{64}$'),
  workbook_row integer NOT NULL CHECK(workbook_row>0),
  version bigint NOT NULL CHECK(version>0)
 );

 -- 只有经事务内绑定的英特尔运营成员能改变专属覆盖或增加回执。
 ALTER TABLE intel_live.workspace_receipts ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.workspace_audit ENABLE ROW LEVEL SECURITY;
 DROP POLICY IF EXISTS workspace_receipts_read ON intel_live.workspace_receipts;
 CREATE POLICY workspace_receipts_read ON intel_live.workspace_receipts FOR SELECT TO diy_api_operations USING(
  workspace_id=current_setting('intel_live.catalog_workspace',true) AND actor_uid=current_setting('intel_live.catalog_uid',true)
  AND intel_live.catalog_is_operator()
 );
 DROP POLICY IF EXISTS workspace_receipts_write ON intel_live.workspace_receipts;
 CREATE POLICY workspace_receipts_write ON intel_live.workspace_receipts FOR INSERT TO diy_api_operations WITH CHECK(
  workspace_id=current_setting('intel_live.catalog_workspace',true) AND actor_uid=current_setting('intel_live.catalog_uid',true)
  AND intel_live.catalog_is_operator()
 );
 DROP POLICY IF EXISTS workspace_audit_write ON intel_live.workspace_audit;
 CREATE POLICY workspace_audit_write ON intel_live.workspace_audit FOR INSERT TO diy_api_operations WITH CHECK(
  workspace_id=current_setting('intel_live.catalog_workspace',true) AND actor_uid=current_setting('intel_live.catalog_uid',true)
  AND intel_live.catalog_is_operator()
 );
 ALTER TABLE intel_live.intel_cost_overrides ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.intel_settings_overrides ENABLE ROW LEVEL SECURITY;
 ALTER TABLE intel_live.intel_quotation_overrides ENABLE ROW LEVEL SECURITY;
 DROP POLICY IF EXISTS intel_cost_read ON intel_live.intel_cost_overrides;
 CREATE POLICY intel_cost_read ON intel_live.intel_cost_overrides FOR SELECT TO diy_api_operations USING(true);
 DROP POLICY IF EXISTS intel_cost_write ON intel_live.intel_cost_overrides;
 CREATE POLICY intel_cost_write ON intel_live.intel_cost_overrides FOR ALL TO diy_api_operations USING(intel_live.catalog_is_operator())
  WITH CHECK(intel_live.catalog_is_operator());
 DROP POLICY IF EXISTS intel_settings_read ON intel_live.intel_settings_overrides;
 CREATE POLICY intel_settings_read ON intel_live.intel_settings_overrides FOR SELECT TO diy_api_operations USING(true);
 DROP POLICY IF EXISTS intel_settings_write ON intel_live.intel_settings_overrides;
 CREATE POLICY intel_settings_write ON intel_live.intel_settings_overrides FOR ALL TO diy_api_operations USING(intel_live.catalog_is_operator())
  WITH CHECK(intel_live.catalog_is_operator());
 DROP POLICY IF EXISTS intel_quotes_read ON intel_live.intel_quotation_overrides;
 CREATE POLICY intel_quotes_read ON intel_live.intel_quotation_overrides FOR SELECT TO diy_api_operations USING(true);
 DROP POLICY IF EXISTS intel_quotes_write ON intel_live.intel_quotation_overrides;
 CREATE POLICY intel_quotes_write ON intel_live.intel_quotation_overrides FOR ALL TO diy_api_operations USING(intel_live.catalog_is_operator())
  WITH CHECK(intel_live.catalog_is_operator());
 GRANT SELECT,INSERT ON intel_live.workspace_receipts TO diy_api_operations;
 GRANT INSERT ON intel_live.workspace_audit TO diy_api_operations;
 GRANT SELECT,INSERT ON intel_live.intel_cost_overrides,intel_live.intel_settings_overrides,
  intel_live.intel_quotation_overrides TO diy_api_operations;
 GRANT UPDATE(document,version) ON intel_live.intel_cost_overrides TO diy_api_operations;
 GRANT UPDATE(settings,version) ON intel_live.intel_settings_overrides TO diy_api_operations;
 GRANT UPDATE(sku,spu,amount_cents,workbook_sha256,workbook_row,version) ON intel_live.intel_quotation_overrides TO diy_api_operations;

 -- 存在已确认的维护表价且平台身份匹配才可发布；原价格表与发布表无直接写权限。
 CREATE OR REPLACE FUNCTION intel_live.set_quotation_publication(config_id text, visible boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $publication$
 BEGIN
  IF NOT intel_live.catalog_is_operator() THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM intel_live.configurations c
   LEFT JOIN intel_live.quotations q USING(configuration_id)
   LEFT JOIN intel_live.intel_quotation_overrides o ON o.configuration_id=c.configuration_id AND o.sku=c.sku AND o.spu=c.spu
   WHERE c.configuration_id=config_id AND c.shop_id='intel' AND c.archived_at IS NULL
    AND (NOT visible OR (c.spu<>'' AND c.sku<>'' AND coalesce(o.amount_cents,q.amount_cents) IS NOT NULL))
  ) THEN RETURN false; END IF;
  INSERT INTO intel_live.publications(configuration_id,published) VALUES(config_id,visible)
   ON CONFLICT(configuration_id) DO UPDATE SET published=excluded.published;
  RETURN true;
 END $publication$;
 REVOKE ALL ON FUNCTION intel_live.set_quotation_publication(text,boolean) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION intel_live.set_quotation_publication(text,boolean) TO diy_api_operations;

 -- 活动页只取本工作区英特尔操作元数据，不授予直接读取审计表的权限。
 CREATE OR REPLACE FUNCTION intel_live.operations_activity(max_rows integer DEFAULT 100)
 RETURNS TABLE(kind text,resource_id text,action text,next_version bigint,created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $activity$
 SELECT a.kind,a.resource_id,a.action,a.next_version,a.created_at FROM (
  SELECT 'configurations'::text AS kind,e.configuration_id AS resource_id,e.action,e.next_version,e.created_at,e.workspace_id
    FROM intel_live.audit_events e WHERE e.shop_id='intel'
  UNION ALL
  SELECT r.kind,r.resource_id,e.action,e.next_version,e.created_at,e.workspace_id
    FROM intel_live.catalog_audit e JOIN intel_live.catalog_receipts r USING(workspace_id,actor_uid,operation_id) WHERE r.shop_id='intel'
  UNION ALL
  SELECT r.kind,e.resource_id,e.action,e.next_version,e.created_at,e.workspace_id
    FROM intel_live.workspace_audit e JOIN intel_live.workspace_receipts r USING(workspace_id,actor_uid,operation_id) WHERE r.shop_id='intel'
 ) a WHERE intel_live.catalog_is_operator() AND a.workspace_id=current_setting('intel_live.catalog_workspace',true)
 ORDER BY a.created_at DESC,a.kind,a.resource_id LIMIT least(200,greatest(0,coalesce(max_rows,100)))
 $activity$;
 REVOKE ALL ON FUNCTION intel_live.operations_activity(integer) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION intel_live.operations_activity(integer) TO diy_api_operations;
END $nas_workspace$;
