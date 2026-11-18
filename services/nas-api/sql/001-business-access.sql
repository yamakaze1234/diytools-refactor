-- 仅在试验库新增接口授权及销售发布选择；不修改既有业务表。
BEGIN;
DO $$ BEGIN IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '仅允许试验库'; END IF; END $$;
CREATE SCHEMA nas_business;
REVOKE ALL ON SCHEMA nas_business FROM PUBLIC;
CREATE TABLE nas_business.members(
 workspace_id text NOT NULL, uid text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,uid)
);
CREATE TABLE nas_business.shop_roles(
 workspace_id text NOT NULL,uid text NOT NULL,shop_id text NOT NULL REFERENCES intel_v2.shops,
 role text NOT NULL CHECK(role IN ('operations','sales')),
 PRIMARY KEY(workspace_id,uid,shop_id),
 FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members
);
-- 只有管理员确认发布并选定价格批次后，销售才看到配置；默认无发布记录。
CREATE TABLE nas_business.sales_publications(
 configuration_id text PRIMARY KEY REFERENCES intel_v2.configurations,
 published boolean NOT NULL DEFAULT false,
 price_source text NOT NULL DEFAULT 'workbook' CHECK(price_source='workbook'),
 price_batch_id text NOT NULL,
 FOREIGN KEY(configuration_id,price_source,price_batch_id)
 REFERENCES intel_v2.configuration_prices(configuration_id,price_source,batch_id)
);
COMMENT ON TABLE nas_business.members IS '原认证服务可信UID映射；停用逐请求生效';
COMMENT ON TABLE nas_business.shop_roles IS '原工作区成员的店铺运营或销售权限；请求不能自报角色';
COMMENT ON TABLE nas_business.sales_publications IS '销售发布与维护表价格批次选择；不按SPU存在推断发布';
COMMIT;
