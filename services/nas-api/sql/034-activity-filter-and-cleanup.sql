-- 三店操作记录查询与保留期独立安装；保留旧分页函数及其执行权限。
BEGIN;
DO $migration$
DECLARE shop text; ns text; runtime text;
BEGIN
 IF current_database() NOT IN ('diy_workbench','diy_workbench_trial') THEN
  RAISE EXCEPTION '操作记录迁移只允许工作台正式库或试验库';
 END IF;
 IF to_regnamespace('intel_live') IS NULL THEN RAISE EXCEPTION '缺少工作台运行库'; END IF;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  ns:=shop||'_live';
  IF to_regnamespace(ns) IS NULL THEN CONTINUE; END IF;
  runtime:=CASE WHEN current_database()='diy_workbench_trial' AND shop='intel' THEN 'diy_api_operations'
                ELSE 'diy_api_'||shop||'_production' END;
  IF to_regrole(runtime) IS NULL OR to_regprocedure(ns||'.catalog_is_operator()') IS NULL THEN
   RAISE EXCEPTION '缺少 % 的运营权限基线',shop;
  END IF;

  EXECUTE format($functions$
   -- 目录与批量审计通过回执确认店铺，再从同一工作区读取操作。
   CREATE OR REPLACE FUNCTION %1$I.activity_audit_rows(p_workspace text,p_actor text,p_kind text)
    RETURNS TABLE(bucket integer,workspace_id text,actor_uid text,operation_id uuid,audit_position integer,
     kind text,resource_id text,action text,next_version bigint,created_at timestamptz)
    LANGUAGE sql STABLE SET search_path=pg_catalog AS $rows$
    SELECT 1,e.workspace_id,e.actor_uid,e.operation_id,0,'configurations',e.configuration_id,e.action,e.next_version,e.created_at
    FROM %1$I.audit_events e
    WHERE e.shop_id=%2$L AND ($1 IS NULL OR e.workspace_id=$1) AND ($2 IS NULL OR e.actor_uid=$2)
     AND ($3 IS NULL OR $3='configurations')
    UNION ALL
    SELECT 2,e.workspace_id,e.actor_uid,e.operation_id,0,r.kind,r.resource_id,e.action,e.next_version,e.created_at
    FROM %1$I.catalog_receipts r JOIN %1$I.catalog_audit e USING(workspace_id,actor_uid,operation_id)
    WHERE r.shop_id=%2$L AND ($1 IS NULL OR r.workspace_id=$1) AND ($2 IS NULL OR r.actor_uid=$2)
     AND ($3 IS NULL OR r.kind=$3 OR ($3='sources' AND r.kind='shared-sources'))
    UNION ALL
    SELECT 3,e.workspace_id,e.actor_uid,e.operation_id,e.position,r.kind,e.resource_id,e.action,e.next_version,e.created_at
    FROM %1$I.workspace_receipts r JOIN %1$I.workspace_audit e USING(workspace_id,actor_uid,operation_id)
    WHERE r.shop_id=%2$L AND ($1 IS NULL OR r.workspace_id=$1) AND ($2 IS NULL OR r.actor_uid=$2)
     AND ($3 IS NULL OR r.kind=$3)
   $rows$;

   -- 共用输出源的审计键是跨店条目 ID，通过原目录权限和本店覆盖解析。
   CREATE OR REPLACE FUNCTION %1$I.activity_shared_source(p_workspace text,p_actor text,p_id text)
    RETURNS TABLE(name text) LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $source$
   BEGIN
    IF p_id IS NOT NULL AND to_regprocedure('workbench_sources.list(text,text,text,text)') IS NOT NULL THEN
     RETURN QUERY EXECUTE
      'SELECT coalesce(nullif(document->''stores''->$1->0->''fields''->>''name'',''''),document->''common''->>''name'')
       FROM workbench_sources.list($1,$2,$3,$4)' USING %2$L,p_workspace,p_actor,p_id;
    END IF;
   END $source$;

   CREATE OR REPLACE FUNCTION %1$I.operations_activity_query(from_day date,to_day date,page_index integer,page_size integer,
     p_actor_uid text DEFAULT NULL,p_kind text DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $query$
   DECLARE ws text:=nullif(current_setting('%1$s.catalog_workspace',true),'');
    uid text:=current_setting('%1$s.catalog_uid',true); names jsonb:='{}'; result jsonb;
   BEGIN
    IF ws IS NULL OR NOT %1$I.catalog_is_operator() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN'; END IF;
    -- 仅取本工作区展示名，认证表未安装的试验库仍可查询。
    IF to_regclass('nas_auth.accounts') IS NOT NULL THEN
     EXECUTE 'SELECT coalesce(jsonb_object_agg(uid,display_name),''{}'') FROM nas_auth.accounts WHERE workspace_id=$1'
      INTO names USING ws;
    END IF;
    WITH actors AS (
     SELECT DISTINCT a.actor_uid AS id FROM %1$I.activity_audit_rows(ws,NULL,NULL) a
    ), matched AS MATERIALIZED (
     SELECT a.* FROM %1$I.activity_audit_rows(ws,p_actor_uid,p_kind) a
     WHERE a.kind<>'costs'
      AND (from_day IS NULL OR a.created_at>=from_day::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND (to_day IS NULL OR a.created_at<(to_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
    ), cost_groups AS MATERIALIZED (
     SELECT a.actor_uid,a.operation_id,max(a.created_at) created_at,count(*) item_count,
      count(*) FILTER (WHERE a.action='tax_file_skipped') skipped_count,
      (array_agg(a.action ORDER BY array_position(ARRAY['erp_sync','tax_sync','erp_snapshot','tax_file','global_tax','tax_resume','tax_edit'],a.action)
       NULLS LAST,a.audit_position))[1] action,
      min(a.resource_id) resource_id,min(a.next_version) next_version
     FROM %1$I.activity_audit_rows(ws,p_actor_uid,'costs') a
     WHERE p_kind IS NULL OR p_kind='costs'
     GROUP BY a.workspace_id,a.actor_uid,a.operation_id
     HAVING (from_day IS NULL OR max(a.created_at)>=from_day::timestamp AT TIME ZONE 'Asia/Shanghai')
       AND (to_day IS NULL OR max(a.created_at)<(to_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
    ), merged AS MATERIALIZED (
     SELECT m.bucket,m.actor_uid,m.operation_id,m.audit_position,m.kind,m.resource_id,m.action,m.next_version,
      m.created_at,1::bigint item_count,0::bigint skipped_count,false batch FROM matched m
     UNION ALL
     SELECT 3,c.actor_uid,c.operation_id,0,'costs',
      CASE WHEN c.item_count=1 AND c.action NOT IN ('erp_sync','tax_sync','erp_snapshot','tax_file','tax_file_skipped') THEN c.resource_id ELSE c.operation_id::text END,
      c.action,CASE WHEN c.item_count=1 THEN c.next_version END,c.created_at,c.item_count,c.skipped_count,
      c.item_count>1 OR c.action IN ('erp_sync','tax_sync','erp_snapshot','tax_file','tax_file_skipped')
     FROM cost_groups c
    ), totals AS (
     SELECT count(*) total,least(100,greatest(1,coalesce(page_size,30))) size FROM merged
    ), bounds AS (
     SELECT total,size,least(greatest(0,coalesce(page_index,0)),greatest(0,(total-1)/size)) page FROM totals
    ), visible AS MATERIALIZED (
     SELECT m.* FROM merged m ORDER BY m.created_at DESC,m.kind,m.resource_id,m.actor_uid,m.operation_id,m.bucket,m.audit_position
     LIMIT (SELECT size FROM bounds) OFFSET (SELECT page*size FROM bounds)
    )
    SELECT jsonb_build_object('total',total,'page',page,'pageSize',size,'supportsPurge',true,
     'operators',coalesce((SELECT jsonb_agg(jsonb_build_object('uid',a.id,'name',
      CASE WHEN a.id='system:retention' THEN '系统定时清理' ELSE coalesce(nullif(names->>a.id,''),a.id) END,'own',a.id=uid)
      ORDER BY (a.id=uid) DESC,a.id) FROM actors a),'[]'::jsonb),
     'rows',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind',v.kind,'resource_id',v.resource_id,'action',v.action,'next_version',v.next_version::text,
      'created_at',v.created_at,'actor_uid',v.actor_uid,'own_operation',v.actor_uid=uid,'operator',
      CASE WHEN v.actor_uid='system:retention' THEN '系统定时清理' ELSE coalesce(nullif(names->>v.actor_uid,''),v.actor_uid) END,
      'product_name',c.fields->>'product','resource_name',
      coalesce(c.name,s.name,t.name,shared_source.name,nullif(g.attrs->>'name',''),nullif(concat_ws(' ',nullif(g.brand,''),nullif(g.model,''),nullif(g.color,''),nullif(g.edition,'')),''),
       samples.items->0->>'name'),
      'object_exists',CASE
       WHEN v.action='purge' THEN false
       WHEN v.kind IN ('configurations','quotations') THEN c.configuration_id IS NOT NULL
       WHEN v.kind IN ('sources','addons') THEN s.source_id IS NOT NULL
       WHEN v.kind='shared-sources' THEN shared_source.name IS NOT NULL
       WHEN v.kind='gallery' THEN g.gallery_id IS NOT NULL
       WHEN v.kind='templates' THEN t.template_id IS NOT NULL
       WHEN v.kind='assets' THEN EXISTS(SELECT FROM %1$I.assets x WHERE x.legacy_uri=v.resource_id)
       WHEN v.kind='costs' THEN v.batch OR EXISTS(SELECT FROM %1$I.costs x WHERE x.goodsid=v.resource_id AND (x.owner_shop IN (%2$L,'shared') OR x.shared))
        OR EXISTS(SELECT FROM %1$I.intel_cost_overrides x WHERE x.goodsid=v.resource_id)
        OR samples.items->0->>'name' IS NOT NULL
       ELSE true END,
      'batch',v.batch,'item_count',v.item_count,'skipped_count',v.skipped_count,
      'updated_count',v.item_count-v.skipped_count,'samples',coalesce(samples.items,'[]'::jsonb))
      ORDER BY v.created_at DESC,v.kind,v.resource_id,v.actor_uid,v.operation_id,v.bucket,v.audit_position)
      FROM visible v
      LEFT JOIN %1$I.configurations c ON v.kind IN ('configurations','quotations') AND c.shop_id=%2$L AND c.configuration_id=v.resource_id
      LEFT JOIN %1$I.sources s ON v.kind IN ('sources','addons') AND s.source_id=v.resource_id AND (s.owner_shop IN (%2$L,'shared') OR s.shared)
      LEFT JOIN LATERAL %1$I.activity_shared_source(ws,uid,CASE WHEN v.kind='shared-sources' THEN v.resource_id END) shared_source ON true
      LEFT JOIN %1$I.gallery g ON v.kind='gallery' AND g.gallery_id=v.resource_id AND (g.owner_shop IN (%2$L,'shared') OR g.shared)
      LEFT JOIN %1$I.templates t ON v.kind='templates' AND t.template_id=v.resource_id AND t.shop_id=%2$L
      LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id',a.resource_id,'name',coalesce(src.name,co.attrs->>'name',ov.document->>'name'))
        ORDER BY (a.action='tax_file_skipped'),a.position) items
       FROM (SELECT a.* FROM %1$I.workspace_audit a
        WHERE v.kind='costs' AND a.workspace_id=ws AND a.actor_uid=v.actor_uid AND a.operation_id=v.operation_id
        ORDER BY (a.action='tax_file_skipped'),a.position LIMIT 3) a
       LEFT JOIN %1$I.costs co ON co.goodsid=a.resource_id AND (co.owner_shop IN (%2$L,'shared') OR co.shared)
       LEFT JOIN %1$I.intel_cost_overrides ov ON ov.goodsid=a.resource_id
       LEFT JOIN LATERAL (SELECT x.name FROM %1$I.sources x WHERE x.goodsid=a.resource_id
        AND (x.owner_shop IN (%2$L,'shared') OR x.shared)
        ORDER BY (x.attrs->>'deletedAt' IS NULL) DESC,(x.owner_shop=%2$L) DESC,x.source_id LIMIT 1) src ON true
      ) samples ON v.kind='costs'),'[]'::jsonb))
    INTO result FROM bounds;
    RETURN result;
   END $query$;

   -- 手动筛选以整次成本操作为单位；定时清理按审计行时间执行保留期。
   CREATE OR REPLACE FUNCTION %1$I.activity_purge_targets(p_workspace text,p_after timestamptz,p_before timestamptz,
     p_actor text,p_kind text,p_group_costs boolean)
    RETURNS TABLE(bucket integer,workspace_id text,actor_uid text,operation_id uuid,audit_position integer)
    LANGUAGE sql STABLE SET search_path=pg_catalog AS $targets$
    WITH scoped AS MATERIALIZED (
     SELECT a.*,CASE WHEN $6 AND a.kind='costs' THEN max(a.created_at) OVER
      (PARTITION BY a.bucket,a.workspace_id,a.actor_uid,a.operation_id) ELSE a.created_at END activity_at
     FROM %1$I.activity_audit_rows($1,$4,$5) a
    ), chosen AS MATERIALIZED (
     SELECT * FROM scoped WHERE ($2 IS NULL OR activity_at>=$2) AND ($3 IS NULL OR activity_at<$3)
    ), remaining AS (
     SELECT DISTINCT a.bucket,a.workspace_id,a.actor_uid,a.operation_id FROM scoped a
     WHERE ($2 IS NOT NULL AND activity_at<$2) OR ($3 IS NOT NULL AND activity_at>=$3)
    ), old_receipts AS (
     SELECT 1 bucket,r.workspace_id,r.actor_uid,r.operation_id FROM %1$I.save_receipts r
     WHERE r.shop_id=%2$L AND ($5 IS NULL OR $5='configurations') AND r.created_at<=now()-interval '24 hours'
     UNION ALL
     SELECT 2,r.workspace_id,r.actor_uid,r.operation_id FROM %1$I.catalog_receipts r
     WHERE r.shop_id=%2$L AND ($5 IS NULL OR r.kind=$5 OR ($5='sources' AND r.kind='shared-sources')) AND r.created_at<=now()-interval '24 hours'
     UNION ALL
     SELECT 3,r.workspace_id,r.actor_uid,r.operation_id FROM %1$I.workspace_receipts r
     WHERE r.shop_id=%2$L AND ($5 IS NULL OR r.kind=$5) AND r.created_at<=now()-interval '24 hours'
    )
    SELECT s.bucket,s.workspace_id,s.actor_uid,s.operation_id,s.audit_position FROM chosen s
    UNION ALL
    SELECT r.bucket,r.workspace_id,r.actor_uid,r.operation_id,NULL FROM old_receipts r
    WHERE ($1 IS NULL OR r.workspace_id=$1) AND ($4 IS NULL OR r.actor_uid=$4)
     AND NOT EXISTS (SELECT FROM remaining a WHERE (a.bucket,a.workspace_id,a.actor_uid,a.operation_id)
      =(r.bucket,r.workspace_id,r.actor_uid,r.operation_id))
   $targets$;

   CREATE OR REPLACE FUNCTION %1$I.activity_purge(p_workspace text,p_after timestamptz,p_before timestamptz,
     p_actor text,p_kind text,p_preview boolean,p_group_costs boolean)
    RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $purge$
   DECLARE result jsonb;
   BEGIN
    IF p_preview THEN
     SELECT jsonb_build_object('audit_count',count(audit_position),
      'batch_count',count(DISTINCT (workspace_id,actor_uid,operation_id)) FILTER (WHERE audit_position IS NOT NULL),
      'receipt_count',count(*) FILTER (WHERE audit_position IS NULL)) INTO result
     FROM %1$I.activity_purge_targets(p_workspace,p_after,p_before,p_actor,p_kind,p_group_costs);
     RETURN result;
    END IF;
    -- 同一条语句固定候选范围，外键保证有剩余引用或并发新增的审计时不能删除回执。
    WITH targets AS MATERIALIZED (
     SELECT * FROM %1$I.activity_purge_targets(p_workspace,p_after,p_before,p_actor,p_kind,p_group_costs)
    ), da AS (
     DELETE FROM %1$I.audit_events e USING targets s WHERE s.bucket=1 AND s.audit_position IS NOT NULL AND e.shop_id=%2$L
      AND (e.workspace_id,e.actor_uid,e.operation_id)=(s.workspace_id,s.actor_uid,s.operation_id)
      RETURNING e.workspace_id,e.actor_uid,e.operation_id
    ), dc AS (
     DELETE FROM %1$I.catalog_audit e USING targets s WHERE s.bucket=2 AND s.audit_position IS NOT NULL
      AND (e.workspace_id,e.actor_uid,e.operation_id)=(s.workspace_id,s.actor_uid,s.operation_id)
      RETURNING e.workspace_id,e.actor_uid,e.operation_id
    ), dw AS (
     DELETE FROM %1$I.workspace_audit e USING targets s WHERE s.bucket=3 AND s.audit_position IS NOT NULL
      AND (e.workspace_id,e.actor_uid,e.operation_id,e.position)=(s.workspace_id,s.actor_uid,s.operation_id,s.audit_position)
      RETURNING e.workspace_id,e.actor_uid,e.operation_id
    ), removed AS (
     SELECT * FROM da UNION ALL SELECT * FROM dc UNION ALL SELECT * FROM dw
    ), ra AS (
     DELETE FROM %1$I.save_receipts r USING targets s WHERE s.bucket=1 AND s.audit_position IS NULL AND r.shop_id=%2$L
      AND (r.workspace_id,r.actor_uid,r.operation_id)=(s.workspace_id,s.actor_uid,s.operation_id) RETURNING 1
    ), rc AS (
     DELETE FROM %1$I.catalog_receipts r USING targets s WHERE s.bucket=2 AND s.audit_position IS NULL AND r.shop_id=%2$L
      AND (r.workspace_id,r.actor_uid,r.operation_id)=(s.workspace_id,s.actor_uid,s.operation_id) RETURNING 1
    ), rw AS (
     DELETE FROM %1$I.workspace_receipts r USING targets s WHERE s.bucket=3 AND s.audit_position IS NULL AND r.shop_id=%2$L
      AND (r.workspace_id,r.actor_uid,r.operation_id)=(s.workspace_id,s.actor_uid,s.operation_id) RETURNING 1
    )
    SELECT jsonb_build_object('audit_count',count(*),'batch_count',count(DISTINCT (workspace_id,actor_uid,operation_id)),
     'receipt_count',(SELECT count(*) FROM ra)+(SELECT count(*) FROM rc)+(SELECT count(*) FROM rw))
    INTO result FROM removed;
    RETURN result;
   END $purge$;

   CREATE OR REPLACE FUNCTION %1$I.purge_operations_activity(p_shop text,p_from_day date DEFAULT NULL,p_to_day date DEFAULT NULL,
     p_actor_uid text DEFAULT NULL,p_kind text DEFAULT NULL,p_dry_run boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $manual$
   DECLARE ws text:=nullif(current_setting('%1$s.catalog_workspace',true),'');
   BEGIN
    IF p_shop IS DISTINCT FROM %2$L OR ws IS NULL OR NOT %1$I.catalog_is_operator() THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN';
    END IF;
    IF p_from_day>p_to_day OR p_dry_run IS NULL OR p_kind NOT IN
     ('configurations','sources','shared-sources','costs','addons','gallery','templates','settings','quotations','assets') THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_ACTIVITY_FILTER';
    END IF;
    IF NOT p_dry_run THEN PERFORM pg_advisory_xact_lock(814521,%3$s); END IF;
    RETURN %1$I.activity_purge(ws,p_from_day::timestamp AT TIME ZONE 'Asia/Shanghai',
     (p_to_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai',p_actor_uid,p_kind,p_dry_run,true);
   END $manual$;

   CREATE OR REPLACE FUNCTION %1$I.purge_expired_activity(p_shop text,p_days integer DEFAULT 30)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='75ms' AS $auto$
   DECLARE ws text:=nullif(current_setting('%1$s.catalog_workspace',true),''); result jsonb;
   BEGIN
    IF p_shop IS DISTINCT FROM %2$L THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN'; END IF;
    IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 36500 THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_RETENTION';
    END IF;
    IF pg_try_advisory_xact_lock(814521,%3$s) THEN
     result:=%1$I.activity_purge(ws,NULL,now()-make_interval(days=>p_days),NULL,NULL,false,false);
     RETURN jsonb_build_object('purged_audits',result->'audit_count','purged_receipts',result->'receipt_count');
    END IF;
    RETURN jsonb_build_object('purged_audits',0,'purged_receipts',0);
   END $auto$;
  $functions$,ns,shop,CASE shop WHEN 'intel' THEN 76 WHEN 'gigabyte' THEN 77 ELSE 78 END);

  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.activity_audit_rows(text,text,text),%1$I.activity_shared_source(text,text,text),
   %1$I.activity_purge_targets(text,timestamptz,timestamptz,text,text,boolean),
   %1$I.activity_purge(text,timestamptz,timestamptz,text,text,boolean,boolean) FROM PUBLIC,%2$I',ns,runtime);
  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.operations_activity_query(date,date,integer,integer,text,text),
   %1$I.purge_operations_activity(text,date,date,text,text,boolean),%1$I.purge_expired_activity(text,integer) FROM PUBLIC',ns);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.operations_activity_query(date,date,integer,integer,text,text),
   %1$I.purge_operations_activity(text,date,date,text,text,boolean),%1$I.purge_expired_activity(text,integer) TO %2$I',ns,runtime);
 END LOOP;
END $migration$;
COMMIT;
