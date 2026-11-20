-- 三店共用核算价候选。由管理员在已安装 017 的正式库单独执行；客户端不会自动安装。
-- 全部函数固定三店和 search_path，不授予运行角色直接跨店读写权限。
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench' OR to_regprocedure('workbench_sources.allowed(text,text,text)') IS NULL
 THEN RAISE EXCEPTION '需要已安装共用输出源的三店正式结构'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
END $guard$;

-- 其他维护入口改变核算价后，不能保留能够覆盖新价格的旧全局恢复标记。
CREATE OR REPLACE FUNCTION workbench_sources.expire_global_tax() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $expire$
BEGIN
 IF NEW.document ? 'globalTax' AND (NEW.document->'globalTax'->'value' IS DISTINCT FROM NEW.document->'tax') THEN
  NEW.document:=NEW.document-'globalTax';
 END IF;
 RETURN NEW;
END $expire$;
DO $triggers$
DECLARE shop text;
BEGIN
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS expire_global_tax ON %I.intel_cost_overrides',shop||'_live');
  EXECUTE format('CREATE TRIGGER expire_global_tax BEFORE INSERT OR UPDATE ON %I.intel_cost_overrides
   FOR EACH ROW EXECUTE FUNCTION workbench_sources.expire_global_tax()',shop||'_live');
 END LOOP;
END $triggers$;

CREATE OR REPLACE FUNCTION workbench_sources.global_tax(request_shop text, workspace text, actor text, goods text,
 expected jsonb, fields jsonb, operation uuid, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $global$
DECLARE
 shop text; schema_name text; previous jsonb; current_version text; next_doc jsonb; next_version bigint;
 tax jsonb; base jsonb; marker jsonb; at_time timestamptz:=clock_timestamp(); context jsonb; result jsonb:='{}';
 restoring boolean:=fields->'restore'='true'::jsonb; exists_op boolean; common_tax jsonb;
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) OR
  (SELECT count(DISTINCT shop_id) FROM workbench_sources.operators WHERE workspace_id=workspace AND uid=actor)<>3
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 IF goods!~'^[0-9]{1,20}$' OR jsonb_typeof(expected) IS DISTINCT FROM 'object' OR
  NOT expected ?& ARRAY['intel','gigabyte','jonsbo'] OR (SELECT count(*) FROM jsonb_object_keys(expected))<>3 OR
  jsonb_typeof(fields) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(fields))<>1 OR
  NOT coalesce((restoring OR jsonb_typeof(fields->'tax')='number' AND
   (fields->>'tax')::numeric BETWEEN 0 AND 100000000 AND trunc((fields->>'tax')::numeric*100)=(fields->>'tax')::numeric*100),false)
 THEN RAISE EXCEPTION USING MESSAGE='GLOBAL_TAX_INVALID'; END IF;
 -- 与原配置、目录和成本入口按相同顺序争用三店事务锁。
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 -- 原输出源条目也核锁，防止与人工共用维护交错投影。
 PERFORM 1 FROM workbench_sources.entries WHERE id=goods FOR UPDATE;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live';
  EXECUTE format('SELECT EXISTS(SELECT FROM %1$I.workspace_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3)',schema_name)
   INTO exists_op USING workspace,actor,operation;
  IF exists_op THEN RAISE EXCEPTION USING MESSAGE='OPERATION_REUSED'; END IF;
  previous:=NULL; current_version:=NULL;
  EXECUTE format($old$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)),
   coalesce(o.version,c.version)::text FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
   WHERE goodsid=$1 AND (c.goodsid IS NULL OR c.owner_shop=$2 OR c.owner_shop='shared' OR c.shared)$old$,schema_name)
   INTO previous,current_version USING goods,shop;
  IF (expected->>shop) IS DISTINCT FROM current_version THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT'; END IF;
  marker:=previous->'globalTax';
  IF restoring THEN
   IF marker IS NULL OR NOT marker ? 'base' OR marker->'value' IS DISTINCT FROM previous->'tax'
   THEN RAISE EXCEPTION USING MESSAGE='GLOBAL_TAX_RESTORE_CONFLICT'; END IF;
   tax:=marker->'base';
  ELSE tax:=fields->'tax'; END IF;
  -- 历史在清除相同独立价之前取配置，确保修改前快照仍反映原配置。
  EXECUTE format($context$SELECT jsonb_build_object(
   'configs',coalesce((SELECT jsonb_agg(d.document ORDER BY c.configuration_id) FROM %1$I.configuration_documents d
    JOIN %1$I.configurations c USING(configuration_id) WHERE c.shop_id=$1 AND c.archived_at IS NULL
    AND c.fields->'emptyLinkDraft' IS DISTINCT FROM 'true'::jsonb AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板'
    AND EXISTS(SELECT FROM %1$I.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='actual' AND p.goodsid=$2)),'[]'),
   'linkConfigs',coalesce((SELECT jsonb_agg(jsonb_build_object('productId',product_id)||
    CASE WHEN fields?'installment' THEN jsonb_build_object('installment',fields->'installment') ELSE '{}'::jsonb END)
    FROM %1$I.configurations WHERE shop_id=$1 AND archived_at IS NULL),'[]'),
   'settings',(SELECT coalesce(o.settings,s.settings) FROM %1$I.shops s LEFT JOIN %1$I.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1),
   'costs',coalesce((SELECT jsonb_agg(coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)))
    FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
    WHERE c.goodsid IS NULL OR c.owner_shop=$1 OR c.owner_shop='shared' OR c.shared),'[]'))$context$,schema_name)
   INTO context USING shop,goods;
  base:=CASE WHEN marker IS NOT NULL AND marker->'value' IS NOT DISTINCT FROM previous->'tax' AND marker?'base'
   THEN marker->'base' ELSE coalesce(previous->'tax','null'::jsonb) END;
  next_doc:=(coalesce(previous,jsonb_build_object('goodsId',goods,'erp',null))-'globalTax')||
   jsonb_build_object('tax',tax,'nasTaxOverride',true,'taxUpdatedAt',at_time);
  IF NOT coalesce(restoring,false) THEN next_doc:=next_doc||jsonb_build_object('globalTax',
   jsonb_build_object('base',base,'value',tax,'at',at_time,'by',actor)); END IF;
  next_version:=coalesce(current_version::bigint,0)+1;
  EXECUTE format($upsert$INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
   ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version$upsert$,schema_name)
   USING goods,next_doc,next_version;
  -- 等于新共用价的独立覆盖可取消，其他人工价保留；受影响配置递增版本使旧草稿冲突。
  EXECUTE format($parts$WITH changed AS (
   UPDATE %1$I.parts p SET attrs=(p.attrs-'taxOverride')||jsonb_build_object('tax',$2)
   FROM %1$I.configurations c WHERE c.configuration_id=p.configuration_id AND c.archived_at IS NULL
    AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板' AND p.part_kind='actual' AND p.goodsid=$1
    AND p.attrs->'taxOverride'->>'goodsId'=$1 AND p.attrs->'taxOverride'->'value'=$2
   RETURNING p.configuration_id)
   UPDATE %1$I.configurations SET version=version+1 WHERE configuration_id IN (SELECT configuration_id FROM changed)$parts$,schema_name)
   USING goods,tax;
  UPDATE workbench_sources.aliases a SET fields=a.fields||jsonb_build_object('tax',tax),legacy=a.legacy-'tax'
   WHERE a.entry_id=goods AND a.shop_id=shop;
  IF shop=request_shop THEN common_tax:=tax; END IF;
  result:=result||jsonb_build_object(shop,context||jsonb_build_object('before',previous,'after',next_doc,
   'previous_version',current_version,'version',next_version::text));
 END LOOP;
 -- 保持受管输出源与成本一致；恢复时各店保留各自第一次改价前的原值。
 UPDATE workbench_sources.entries e SET fields=e.fields||jsonb_build_object('tax',common_tax),version=e.version+1 WHERE e.id=goods;
 PERFORM workbench_sources.project(goods,ARRAY['intel','gigabyte','jonsbo'],at_time);
 RETURN result;
END $global$;

CREATE OR REPLACE FUNCTION workbench_sources.finish_global_tax(request_shop text, workspace text, actor text,
 operation uuid, request_hash text, receipt jsonb, history jsonb, request uuid, goods text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $finish$
DECLARE shop text; schema_name text; snapshot jsonb; own_receipt jsonb;
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) OR
  (SELECT count(DISTINCT shop_id) FROM workbench_sources.operators WHERE workspace_id=workspace AND uid=actor)<>3
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live'; snapshot:=history->shop;
  -- 发起店的原队列在函数返回后写回执和审计；其他店使用同一操作编号记录完整联动。
  IF shop<>request_shop THEN
   own_receipt:=jsonb_set(receipt,'{shop_id}',to_jsonb(shop));
   own_receipt:=jsonb_set(own_receipt,'{changes,0,version}',snapshot->'version');
   EXECUTE format('INSERT INTO %I.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
    VALUES($1,$2,$3,$4,''costs'',$5,$6)',schema_name) USING workspace,actor,operation,shop,request_hash,own_receipt;
   EXECUTE format('INSERT INTO %I.workspace_audit(workspace_id,actor_uid,operation_id,position,resource_id,action,previous_version,next_version,request_id)
    VALUES($1,$2,$3,1,$4,''global_tax'',$5,$6,$7)',schema_name)
    USING workspace,actor,operation,goods,(snapshot->>'previousVersion')::bigint,(snapshot->>'version')::bigint,request;
  END IF;
  IF jsonb_array_length(snapshot->'items')>0 THEN
   EXECUTE format('INSERT INTO %I.price_history(workspace_id,operation_id,message,items,configs) VALUES($1,$2,$3,$4,$5)',schema_name)
    USING workspace,operation,'三店共用核算价维护',snapshot->'items',snapshot->'configs';
  END IF;
 END LOOP;
END $finish$;

REVOKE ALL ON FUNCTION workbench_sources.expire_global_tax(),
 workbench_sources.global_tax(text,text,text,text,jsonb,jsonb,uuid,uuid),
 workbench_sources.finish_global_tax(text,text,text,uuid,text,jsonb,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.global_tax(text,text,text,text,jsonb,jsonb,uuid,uuid),
 workbench_sources.finish_global_tax(text,text,text,uuid,text,jsonb,jsonb,uuid,text)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
COMMIT;
