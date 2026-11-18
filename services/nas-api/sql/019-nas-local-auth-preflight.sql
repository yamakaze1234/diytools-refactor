-- 单条只读查询可在 DBX 独立执行。结果只包含人数和三店授权数量。
WITH enrollment AS (
 SELECT count(*) FILTER(WHERE m.enabled) AS enabled_members,
  count(a.uid) FILTER(WHERE m.enabled) AS enrolled_members,
  count(*) FILTER(WHERE m.enabled AND a.uid IS NULL) AS missing_members
 FROM nas_business.members m LEFT JOIN nas_auth.accounts a USING(workspace_id,uid)
 WHERE m.workspace_id='workbench-main'
), effective_roles AS (
 SELECT workspace_id,shop_id,role FROM intel_access.shop_roles
 UNION ALL SELECT workspace_id,shop_id,role FROM gigabyte_access.shop_roles
 UNION ALL SELECT workspace_id,shop_id,role FROM jonsbo_access.shop_roles
), role_counts AS (
 SELECT shop_id,role,count(*) AS enabled_grants
 FROM effective_roles
 WHERE workspace_id='workbench-main'
 GROUP BY shop_id,role
)
SELECT current_database() AS database_name, enrollment.*,
 coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.shop_id,g.role) FROM role_counts g),'[]'::jsonb) AS shop_roles
FROM enrollment
WHERE current_database()='diy_workbench';
