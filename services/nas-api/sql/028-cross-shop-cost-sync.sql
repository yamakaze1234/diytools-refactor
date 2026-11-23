-- 三店成本同步只接受已登录发起店的运营身份。跨店读写通过固定范围函数完成。
BEGIN;

CREATE OR REPLACE FUNCTION workbench_sources.check_cost_sync_actor(request_shop text, workspace text, actor text)
 RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $check$
DECLARE enabled boolean;
BEGIN
 IF request_shop NOT IN ('intel','gigabyte','jonsbo') OR
    NOT coalesce(workbench_sources.allowed(request_shop,workspace,actor),false)
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 EXECUTE format('SELECT EXISTS(SELECT FROM %I.members WHERE workspace_id=$1 AND uid=$2 AND enabled)',request_shop||'_access')
  INTO enabled USING workspace,actor;
 IF NOT enabled THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
END $check$;

-- 复用单店成本的生效规则，成本表和 ERP 预览只取需要的字段。
CREATE OR REPLACE FUNCTION workbench_sources.sync_cost_rows(shop text, goods text[] DEFAULT NULL)
 RETURNS TABLE(id text, version text, document jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $rows$
BEGIN
 RETURN QUERY EXECUTE format($query$SELECT coalesce(c.goodsid,o.goodsid),coalesce(o.version,c.version)::text,
  coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax))
  FROM (SELECT * FROM %1$I.costs WHERE (owner_shop=$1 OR owner_shop='shared' OR shared)
   AND ($2::text[] IS NULL OR goodsid=ANY($2))) c
  FULL JOIN (SELECT * FROM %1$I.intel_cost_overrides WHERE $2::text[] IS NULL OR goodsid=ANY($2)) o USING(goodsid)
  WHERE coalesce(c.goodsid,o.goodsid) ~ '^[0-9]{1,20}$'$query$,shop||'_live') USING shop,goods;
END $rows$;

CREATE OR REPLACE FUNCTION workbench_sources.cost_sync_snapshot(request_shop text, workspace text, actor text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $snapshot$
DECLARE shop text; stores jsonb:='{}'; costs jsonb; common jsonb;
BEGIN
 PERFORM workbench_sources.check_cost_sync_actor(request_shop,workspace,actor);
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  SELECT coalesce(jsonb_object_agg(r.id,jsonb_strip_nulls(jsonb_build_object('version',r.version,
    'tax',r.document->'tax','manual',nullif(r.document->'nasManualTax','false'::jsonb),
    'taxOverride',nullif(r.document->'nasTaxOverride','false'::jsonb),'provisional',nullif(r.document->'nasProvisionalTax','false'::jsonb),
    'erp',r.document->'erp','erpOverride',nullif(r.document->'nasErpOverride','false'::jsonb),
    'erpUnknown',nullif(r.document->'erpUnknown','false'::jsonb),
    'erpMissing',nullif(r.document->'erpMissing','false'::jsonb),'stockMissing',nullif(r.document->'stockMissing','false'::jsonb),
    'stockAvailable',r.document->'stockAvailable','name',r.document->'name','sku',r.document->'sku'))),'{}')
  INTO costs FROM workbench_sources.sync_cost_rows(shop) r;
  stores:=stores||jsonb_build_object(shop,costs);
 END LOOP;
 SELECT coalesce(jsonb_object_agg(e.id,jsonb_build_object('version',e.version::text,'tax',e.fields->'tax',
  'overrideShops',coalesce(a.shops,'[]'::jsonb))),'{}')
 INTO common FROM workbench_sources.entries e
 LEFT JOIN (SELECT entry_id,jsonb_agg(DISTINCT shop_id) AS shops FROM workbench_sources.aliases
  WHERE fields?'tax' OR legacy?'tax' GROUP BY entry_id) a ON a.entry_id=e.id
 WHERE e.id ~ '^[0-9]{1,20}$';
 RETURN jsonb_build_object('stores',stores,'common',common);
END $snapshot$;

CREATE OR REPLACE FUNCTION workbench_sources.apply_cost_sync(request_shop text, workspace text, actor text,
 action text, changes jsonb, operation uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $apply$
DECLARE shop text; schema_name text; item jsonb; incoming jsonb; goods text; ids text[]; snapshots jsonb:='{}';
 snapshot jsonb; previous jsonb; next_doc jsonb; current_version text; next_version text; shared_version text;
 store_changes jsonb:='{"intel":[],"gigabyte":[],"jonsbo":[]}'; project_shops text[];
 context jsonb:='{}'; cost_data jsonb; affected text[]; at_time timestamptz:=clock_timestamp(); manual boolean; exists_op boolean;
BEGIN
 PERFORM workbench_sources.check_cost_sync_actor(request_shop,workspace,actor);
 IF action IS NULL OR action NOT IN ('tax_sync','erp_sync') OR jsonb_typeof(changes) IS DISTINCT FROM 'array' OR
    jsonb_array_length(changes) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION USING MESSAGE='COST_SYNC_INVALID'; END IF;
 SELECT array_agg(r->>'id') INTO ids FROM jsonb_array_elements(changes) r;
 IF EXISTS(SELECT FROM unnest(ids) g WHERE g IS NULL OR g!~'^[0-9]{1,20}$') OR
    cardinality(ids)<>(SELECT count(DISTINCT g) FROM unnest(ids) g)
 THEN RAISE EXCEPTION USING MESSAGE='COST_SYNC_INVALID'; END IF;
 -- 按其他三店写入使用的固定顺序加锁，版本校验到提交期间禁止跨店穿插写入。
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live';
  EXECUTE format('SELECT EXISTS(SELECT FROM %1$I.workspace_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3)',schema_name)
   INTO exists_op USING workspace,actor,operation;
  IF exists_op THEN RAISE EXCEPTION USING MESSAGE='OPERATION_REUSED'; END IF;
  SELECT coalesce(jsonb_object_agg(r.id,jsonb_build_object('version',r.version,'document',r.document)),'{}')
   INTO snapshot FROM workbench_sources.sync_cost_rows(shop,ids) r;
  snapshots:=snapshots||jsonb_build_object(shop,snapshot);
 END LOOP;

 FOR item IN SELECT r FROM jsonb_array_elements(changes) r LOOP
  goods:=item->>'id'; incoming:=item->'fields';
  IF jsonb_typeof(item->'expected_versions') IS DISTINCT FROM 'object' OR
     NOT (item->'expected_versions' ?& ARRAY['intel','gigabyte','jonsbo']) OR
     NOT coalesce(CASE WHEN action='tax_sync' THEN
      jsonb_typeof(incoming->'tax')='number' AND (incoming->>'tax')::numeric BETWEEN 0 AND 100000000
      ELSE incoming ?& ARRAY['erp','stockAvailable','name','sku'] AND
       (incoming->'erp'='null'::jsonb OR jsonb_typeof(incoming->'erp')='number' AND (incoming->>'erp')::numeric BETWEEN 0 AND 100000000000) AND
       (incoming->'stockAvailable'='null'::jsonb OR jsonb_typeof(incoming->'stockAvailable')='number' AND abs((incoming->>'stockAvailable')::numeric)<=9007199254740991) AND
       jsonb_typeof(incoming->'name')='string' AND length(incoming->>'name')<=512 AND
       jsonb_typeof(incoming->'sku')='string' AND length(incoming->>'sku')<=512 END,false)
  THEN RAISE EXCEPTION USING MESSAGE='COST_SYNC_INVALID'; END IF;
  SELECT version::text INTO shared_version FROM workbench_sources.entries WHERE id=goods FOR UPDATE;
  IF shared_version IS NULL AND NOT (snapshots->'intel'?goods OR snapshots->'gigabyte'?goods OR snapshots->'jonsbo'?goods)
  THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT',DETAIL=goods; END IF;
  IF action='tax_sync' AND NOT (item ? 'expected_shared_version') THEN RAISE EXCEPTION USING MESSAGE='COST_SYNC_INVALID'; END IF;
  IF action='tax_sync' AND shared_version IS DISTINCT FROM item->>'expected_shared_version'
  THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT',DETAIL=goods; END IF;
  project_shops:=ARRAY[]::text[];
  FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
   schema_name:=shop||'_live'; snapshot:=snapshots->shop->goods;
   previous:=snapshot->'document'; current_version:=snapshot->>'version';
   IF current_version IS DISTINCT FROM item->'expected_versions'->>shop
   THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT',DETAIL=goods; END IF;
   manual:=action='tax_sync' AND coalesce(previous->'nasManualTax'='true'::jsonb,false);
   next_doc:=coalesce(previous,jsonb_build_object('goodsId',goods,'erp',null,'tax',null));
   IF action='tax_sync' THEN
    IF manual THEN
     -- 先锁定手动店的覆盖，再发布共用价，避免以后重投影时覆盖手动价。
     UPDATE workbench_sources.aliases SET fields=aliases.fields||jsonb_build_object('tax',previous->'tax'),legacy=legacy-'tax'
     WHERE entry_id=goods AND shop_id=shop AND
      (aliases.fields->'tax' IS DISTINCT FROM previous->'tax' OR legacy?'tax');
    ELSE
     UPDATE workbench_sources.aliases SET fields=aliases.fields-'tax',legacy=legacy-'tax'
      WHERE entry_id=goods AND shop_id=shop AND (aliases.fields?'tax' OR legacy?'tax');
     project_shops:=array_append(project_shops,shop);
     IF next_doc->'tax' IS DISTINCT FROM incoming->'tax' OR next_doc->'nasTaxOverride' IS DISTINCT FROM 'true'::jsonb OR next_doc @> '{"nasProvisionalTax":true}' THEN
      next_doc:=(next_doc-ARRAY['globalTax','nasProvisionalTax'])||jsonb_build_object(
       'tax',incoming->'tax','nasTaxOverride',true,'nasManualTax',false,'taxUpdatedAt',at_time);
     END IF;
    END IF;
   ELSE
    -- ERP 同步只改库存和 ERP 成本字段，沿用各店核算价与手动价。
    cost_data:=jsonb_build_object('erp',incoming->'erp','name',incoming->'name','sku',incoming->'sku','stockAvailable',incoming->'stockAvailable',
     'erpMissing',false,'erpUnknown',incoming->'erp'='null'::jsonb,'stockMissing',false,'nasErpOverride',true);
    IF NOT next_doc @> cost_data THEN next_doc:=next_doc||cost_data||jsonb_build_object('stockUpdatedAt',at_time); END IF;
   END IF;
   next_version:=current_version;
   IF NOT manual AND next_doc IS DISTINCT FROM previous THEN
    next_version:=(coalesce(current_version::bigint,0)+1)::text;
    EXECUTE format('INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
     ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version',schema_name)
     USING goods,next_doc,next_version::bigint;
   END IF;
   store_changes:=jsonb_set(store_changes,ARRAY[shop],(store_changes->shop)||jsonb_build_array(jsonb_build_object(
    'id',goods,'version',next_version,'previous_version',current_version,'before',previous,'after',next_doc,'manual',manual)));
  END LOOP;
  IF action='tax_sync' AND shared_version IS NOT NULL THEN
   -- 共用条目版本也承载覆盖差异；即使金额相同，原预览也应在本轮整理后失效。
   UPDATE workbench_sources.entries e SET fields=e.fields||jsonb_build_object('tax',incoming->'tax'),version=version+1 WHERE id=goods;
   PERFORM workbench_sources.project(goods,project_shops,at_time);
  END IF;
 END LOOP;

 -- 每店每批仅取一次历史上下文；ERP 库存单独变化时不会生成虚假的价格历史。
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live';
  SELECT coalesce(array_agg(r->>'id'),ARRAY[]::text[]) INTO affected FROM jsonb_array_elements(store_changes->shop) r
   WHERE r->'before'->'tax' IS DISTINCT FROM r->'after'->'tax' OR r->'before'->'erp' IS DISTINCT FROM r->'after'->'erp'
     OR r->'before'->'erpMissing' IS DISTINCT FROM r->'after'->'erpMissing' OR r->'before'->'erpUnknown' IS DISTINCT FROM r->'after'->'erpUnknown';
  EXECUTE format($context$WITH relevant AS (
   SELECT c.configuration_id,c.product_id FROM %1$I.configurations c
   WHERE c.shop_id=$1 AND c.archived_at IS NULL AND c.fields->'emptyLinkDraft' IS DISTINCT FROM 'true'::jsonb
    AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板'
    AND EXISTS(SELECT FROM %1$I.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='actual' AND p.goodsid=ANY($2)))
   SELECT jsonb_build_object(
    'configs',coalesce((SELECT jsonb_agg(d.document ORDER BY r.configuration_id) FROM relevant r JOIN %1$I.configuration_documents d USING(configuration_id)),'[]'),
    'linkConfigs',coalesce((SELECT jsonb_agg(jsonb_build_object('productId',c.product_id)||
      CASE WHEN c.fields?'installment' THEN jsonb_build_object('installment',c.fields->'installment') ELSE '{}'::jsonb END)
     FROM %1$I.configurations c WHERE c.shop_id=$1 AND c.archived_at IS NULL AND c.product_id IN(SELECT product_id FROM relevant)),'[]'),
    'settings',(SELECT coalesce(o.settings,s.settings) FROM %1$I.shops s LEFT JOIN %1$I.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1),
    'costs',(SELECT coalesce(jsonb_agg(r.document),'[]') FROM workbench_sources.sync_cost_rows($1,ARRAY(
      SELECT DISTINCT p.goodsid FROM %1$I.parts p JOIN relevant c USING(configuration_id) WHERE p.part_kind='actual' AND coalesce(p.goodsid,'')<>'')) r)
   )$context$,schema_name) INTO cost_data USING shop,affected;
  context:=context||jsonb_build_object(shop,cost_data||jsonb_build_object('changes',store_changes->shop));
 END LOOP;
 RETURN context;
END $apply$;

CREATE OR REPLACE FUNCTION workbench_sources.finish_cost_sync(request_shop text, workspace text, actor text,
 operation uuid, request_hash text, action text, receipts jsonb, audits jsonb, history jsonb, request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $finish$
DECLARE shop text; schema_name text; snapshot jsonb; message text;
BEGIN
 PERFORM workbench_sources.check_cost_sync_actor(request_shop,workspace,actor);
 IF action IS NULL OR action NOT IN ('tax_sync','erp_sync') THEN RAISE EXCEPTION USING MESSAGE='COST_SYNC_INVALID'; END IF;
 message:=CASE WHEN action='tax_sync' THEN '三店含税成本表同步' ELSE '三店 ERP 库存与成本同步' END;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live'; snapshot:=history->shop;
  IF shop<>request_shop THEN
   EXECUTE format('INSERT INTO %I.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
    VALUES($1,$2,$3,$4,''costs'',$5,$6)',schema_name) USING workspace,actor,operation,shop,request_hash,receipts->shop;
   EXECUTE format($audit$INSERT INTO %I.workspace_audit(workspace_id,actor_uid,operation_id,position,resource_id,action,previous_version,next_version,request_id)
    SELECT $1,$2,$3,a.pos::integer,a.row->>'id',CASE WHEN a.row->'manual'='true'::jsonb THEN 'tax_file_skipped' ELSE $4 END,
     (a.row->>'previous_version')::bigint,(a.row->>'version')::bigint,$5
    FROM jsonb_array_elements($6) WITH ORDINALITY a(row,pos)$audit$,schema_name) USING workspace,actor,operation,action,request,audits->shop;
  END IF;
  IF jsonb_array_length(snapshot->'items')>0 THEN
   EXECUTE format('INSERT INTO %I.price_history(workspace_id,operation_id,message,items,configs) VALUES($1,$2,$3,$4,$5)',schema_name)
    USING workspace,operation,message,snapshot->'items',snapshot->'configs';
  END IF;
 END LOOP;
END $finish$;

REVOKE ALL ON FUNCTION workbench_sources.check_cost_sync_actor(text,text,text),workbench_sources.sync_cost_rows(text,text[]),
 workbench_sources.cost_sync_snapshot(text,text,text),workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid),
 workbench_sources.finish_cost_sync(text,text,text,uuid,text,text,jsonb,jsonb,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.cost_sync_snapshot(text,text,text),workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid),
 workbench_sources.finish_cost_sync(text,text,text,uuid,text,text,jsonb,jsonb,jsonb,uuid)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
COMMIT;
