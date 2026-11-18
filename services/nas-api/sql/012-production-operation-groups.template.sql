-- 正式三店候选：仅新增可撤销的运营组与店铺授权视图。
-- 接入前验证当前英特尔授权函数的所有者；既有成员、店铺权限和共享委托保留。
CREATE TABLE nas_business.operation_groups(
 workspace_id text NOT NULL, group_code text NOT NULL, display_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,group_code)
);
CREATE TABLE nas_business.operation_group_members(
 workspace_id text NOT NULL, group_code text NOT NULL, uid text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,group_code,uid),
 FOREIGN KEY(workspace_id,group_code) REFERENCES nas_business.operation_groups,
 FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members
);
CREATE TABLE nas_business.operation_group_shops(
 workspace_id text NOT NULL, group_code text NOT NULL,
 shop_id text NOT NULL CHECK(shop_id IN ('intel','gigabyte','jonsbo')),
 role text NOT NULL CHECK(role='operations'),
 PRIMARY KEY(workspace_id,group_code,shop_id),
 FOREIGN KEY(workspace_id,group_code) REFERENCES nas_business.operation_groups
);
REVOKE ALL ON nas_business.operation_groups,nas_business.operation_group_members,nas_business.operation_group_shops FROM PUBLIC;
INSERT INTO nas_business.operation_groups(workspace_id,group_code,display_name)
 VALUES('workbench-main','dou-intel-operations','抖英特运营组');
INSERT INTO nas_business.operation_group_shops VALUES
 ('workbench-main','dou-intel-operations','intel','operations'),
 ('workbench-main','dou-intel-operations','gigabyte','operations'),
 ('workbench-main','dou-intel-operations','jonsbo','operations');

-- 停用保留在原成员表；任何停用成员均不再由组获得角色。
CREATE VIEW nas_business.group_shop_roles WITH (security_barrier=true) AS
 SELECT g.workspace_id,g.uid,s.shop_id,s.role
 FROM nas_business.operation_group_members g
 JOIN nas_business.operation_group_shops s USING(workspace_id,group_code)
 JOIN nas_business.members m USING(workspace_id,uid)
 WHERE m.enabled;
REVOKE ALL ON nas_business.group_shop_roles FROM PUBLIC;

CREATE SCHEMA intel_access;
REVOKE ALL ON SCHEMA intel_access FROM PUBLIC;
CREATE VIEW intel_access.shop_roles WITH (security_barrier=true) AS
 SELECT workspace_id,uid,shop_id,
  CASE WHEN bool_or(role='operations') THEN 'operations' ELSE 'sales' END AS role
 FROM (
  SELECT r.workspace_id,r.uid,r.shop_id,r.role FROM nas_business.shop_roles r
   JOIN nas_business.members m USING (workspace_id,uid) WHERE m.enabled AND r.shop_id='intel'
  UNION ALL
  SELECT workspace_id,uid,shop_id,role FROM nas_business.group_shop_roles WHERE shop_id='intel'
 ) roles
 GROUP BY workspace_id,uid,shop_id;
CREATE VIEW intel_access.members WITH (security_barrier=true) AS
 SELECT workspace_id,uid,true AS enabled FROM intel_access.shop_roles;
REVOKE ALL ON ALL TABLES IN SCHEMA intel_access FROM PUBLIC;
GRANT USAGE ON SCHEMA intel_access TO diy_api_intel_production;
GRANT SELECT ON intel_access.members,intel_access.shop_roles TO diy_api_intel_production;

-- 保留函数签名、所有者、执行 ACL 与既有 GUC；权限视图仍区分运营和销售。
CREATE OR REPLACE FUNCTION intel_live.catalog_is_operator() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $check$
 SELECT EXISTS(SELECT 1 FROM intel_access.shop_roles r
  WHERE r.workspace_id=current_setting('intel_live.catalog_workspace',true)
  AND r.uid=current_setting('intel_live.catalog_uid',true) AND r.role='operations' AND r.shop_id='intel')
 $check$;

-- 新增的组权限仅用于运营维护；已启用的旧英特尔运营成员继续保有原发布功能。
-- 保持原函数签名、所有者及 ACL，原发布资料与当前可见状态不变。
CREATE OR REPLACE FUNCTION intel_live.set_quotation_publication(config_id text, visible boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $publication$
 BEGIN
  IF NOT intel_live.catalog_is_operator() THEN RETURN false; END IF;
  IF visible IS TRUE AND NOT EXISTS(
   SELECT FROM nas_business.members m JOIN nas_business.shop_roles r USING(workspace_id,uid)
   WHERE m.workspace_id=current_setting('intel_live.catalog_workspace',true)
    AND m.uid=current_setting('intel_live.catalog_uid',true) AND m.enabled AND r.role='operations' AND r.shop_id='intel')
  THEN RETURN false; END IF;
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
