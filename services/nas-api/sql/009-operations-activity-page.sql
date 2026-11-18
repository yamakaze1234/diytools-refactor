-- 仅安装英特尔运营的只读审计分页函数；业务行、旧活动查询和角色登录不变。
DO $nas_activity_page$
DECLARE runtime_role text;
BEGIN
 runtime_role:=CASE current_database()
  WHEN 'diy_workbench' THEN 'diy_api_intel_production'
  WHEN 'diy_workbench_trial' THEN 'diy_api_operations'
  ELSE NULL END;
 IF runtime_role IS NULL THEN RAISE EXCEPTION '只允许英特尔正式库或试验库'; END IF;
 IF to_regrole(runtime_role) IS NULL OR to_regprocedure('intel_live.operations_activity(integer)') IS NULL OR
    NOT has_schema_privilege(runtime_role,'intel_live','USAGE') OR
    NOT has_function_privilege(runtime_role,'intel_live.operations_activity(integer)','EXECUTE') OR
    NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel')
 THEN RAISE EXCEPTION '请先核对英特尔运行库与已有运营权限'; END IF;
 PERFORM pg_advisory_xact_lock(814517,5);

 CREATE OR REPLACE FUNCTION intel_live.operations_activity_page(from_day date,to_day date,page_index integer,page_size integer)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $activity$
 WITH actor AS MATERIALIZED (
  SELECT current_setting('intel_live.catalog_workspace',true) workspace_id,
         current_setting('intel_live.catalog_uid',true) uid
  WHERE intel_live.catalog_is_operator()
 ), matched AS MATERIALIZED (
  SELECT a.kind,a.resource_id,a.action,a.next_version,a.created_at,a.actor_uid,a.operation_id,a.position,actor.uid
  FROM actor JOIN LATERAL (
   SELECT 'configurations'::text kind,e.configuration_id resource_id,e.action,e.next_version,e.created_at,e.actor_uid,e.operation_id,0 position
   FROM intel_live.audit_events e WHERE e.shop_id='intel' AND e.workspace_id=actor.workspace_id
   UNION ALL
   SELECT r.kind,r.resource_id,e.action,e.next_version,e.created_at,e.actor_uid,e.operation_id,0
   FROM intel_live.catalog_audit e JOIN intel_live.catalog_receipts r USING(workspace_id,actor_uid,operation_id)
   WHERE r.shop_id='intel' AND r.workspace_id=actor.workspace_id
   UNION ALL
   SELECT r.kind,e.resource_id,e.action,e.next_version,e.created_at,e.actor_uid,e.operation_id,e.position
   FROM intel_live.workspace_audit e JOIN intel_live.workspace_receipts r USING(workspace_id,actor_uid,operation_id)
   WHERE r.shop_id='intel' AND r.workspace_id=actor.workspace_id
  ) a ON true
  WHERE ($1 IS NULL OR a.created_at>=$1::timestamp AT TIME ZONE 'Asia/Shanghai')
    AND ($2 IS NULL OR a.created_at<($2+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 ), totals AS (
  SELECT count(*) total,least(100,greatest(1,coalesce($4,30))) size FROM matched
 ), bounds AS (
  SELECT total,size,least(greatest(0,coalesce($3,0)),greatest(0,(total-1)/size)) page FROM totals
 ), visible AS (
  SELECT m.* FROM matched m
  ORDER BY created_at DESC,kind,resource_id,actor_uid,operation_id,position
  LIMIT (SELECT size FROM bounds) OFFSET (SELECT page*size FROM bounds)
 )
 SELECT jsonb_build_object('total',total,'page',page,'pageSize',size,'rows',coalesce((
  SELECT jsonb_agg(jsonb_build_object('kind',v.kind,'resource_id',v.resource_id,'action',v.action,
   'next_version',v.next_version::text,'created_at',v.created_at,'resource_name',c.name,'own_operation',v.actor_uid=v.uid)
   ORDER BY v.created_at DESC,v.kind,v.resource_id,v.actor_uid,v.operation_id,v.position)
  FROM visible v LEFT JOIN intel_live.configurations c
   ON v.kind IN ('configurations','quotations') AND c.shop_id='intel' AND c.configuration_id=v.resource_id
 ),'[]'::jsonb)) FROM bounds
 $activity$;
 REVOKE ALL ON FUNCTION intel_live.operations_activity_page(date,date,integer,integer) FROM PUBLIC;
 EXECUTE format('GRANT EXECUTE ON FUNCTION intel_live.operations_activity_page(date,date,integer,integer) TO %I',runtime_role);
END $nas_activity_page$;
