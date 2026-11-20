-- 从原有单店核算价操作记录补回手改标记，不更新价格或配置正文。
DO $shop_manual_tax$
DECLARE scope text;
BEGIN
 IF current_database() <> 'diy_workbench' THEN RAISE EXCEPTION '只允许三店工作台库'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 FOREACH scope IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  EXECUTE format($mark$
   WITH last_change AS (
    SELECT DISTINCT ON (a.resource_id) a.resource_id,a.action
    FROM %1$I.workspace_audit a
    JOIN %1$I.workspace_receipts r USING(workspace_id,actor_uid,operation_id)
    JOIN %1$I.intel_cost_overrides o ON o.goodsid=a.resource_id
    WHERE r.shop_id=$1 AND r.kind='costs' AND a.next_version<=o.version
     AND a.action IN ('tax_edit','tax_file','tax_resume')
     AND o.document @> '{"nasTaxOverride":true}' AND NOT (o.document ? 'nasManualTax')
    ORDER BY a.resource_id,a.next_version DESC,a.created_at DESC
   )
   UPDATE %1$I.intel_cost_overrides o
   SET document=o.document||jsonb_build_object('nasManualTax',a.action='tax_edit')
   FROM last_change a WHERE o.goodsid=a.resource_id
  $mark$,scope||'_live') USING scope;
 END LOOP;
END $shop_manual_tax$;
