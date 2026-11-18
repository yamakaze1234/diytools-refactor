-- 每个新店仅接入该店的组分配。两个视图均不能供服务账号授予或变更角色。
CREATE SCHEMA __ACCESS__;
REVOKE ALL ON SCHEMA __ACCESS__ FROM PUBLIC;
CREATE VIEW __ACCESS__.shop_roles WITH (security_barrier=true) AS
 SELECT workspace_id,uid,shop_id,role FROM nas_business.group_shop_roles WHERE shop_id='__SHOP__';
CREATE VIEW __ACCESS__.members WITH (security_barrier=true) AS
 SELECT workspace_id,uid,true AS enabled FROM __ACCESS__.shop_roles;
REVOKE ALL ON ALL TABLES IN SCHEMA __ACCESS__ FROM PUBLIC;
