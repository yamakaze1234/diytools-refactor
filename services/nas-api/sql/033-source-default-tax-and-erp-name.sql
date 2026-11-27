-- 保留既有调用签名。新建价格来源与 ERP 原名由写入事务维护，不回填现有业务数据。
BEGIN;
DO $migration$
DECLARE patch record; definition text;
BEGIN
 IF current_database()<>'diy_workbench' THEN RAISE EXCEPTION '需要三店工作台数据库'; END IF;
 -- 复用已安装的 029/031 投影，增加显式 ERP 暂代范围；旧入口没有暂代范围。
 IF to_regprocedure('workbench_sources.project_with_tax_mode(text,text[],timestamp with time zone,text,text[],text[],text[])') IS NULL THEN
  definition:=replace(pg_get_functiondef('workbench_sources.project_with_tax_mode(text,text[],timestamp with time zone,text,text[],text[])'::regprocedure),E'\r\n',E'\n');
  FOR patch IN SELECT * FROM (VALUES
   ($q$follow_shops text[] DEFAULT ARRAY[]::text[])$q$,
    $q$follow_shops text[], provisional_shops text[])$q$),
   ($q$edited_at timestamp with time zone, erp_name text DEFAULT NULL::text, manual_shops text[] DEFAULT ARRAY[]::text[],$q$,
    $q$edited_at timestamp with time zone, erp_name text, manual_shops text[],$q$),
   ($q$want_manual boolean; current_manual boolean;$q$,
    $q$want_manual boolean; current_manual boolean; want_provisional boolean;$q$),
   ($q$   IF cost_doc IS NULL AND override_tax='null'::jsonb THEN CONTINUE; END IF;
   current_manual$q$,
    $q$   want_provisional:=shop=ANY(provisional_shops) AND jsonb_typeof(override_tax)='number';
   current_manual$q$),
   ($q$    AND NOT (cost_doc ? 'nasProvisionalTax')$q$,
    $q$    AND (CASE WHEN want_provisional THEN cost_doc @> '{"nasProvisionalTax":true}'
         ELSE NOT (cost_doc ? 'nasProvisionalTax') END)$q$),
   ($q$'nasManualTax',want_manual,'taxUpdatedAt',coalesce(edited_at,now()));$q$,
    $q$'nasManualTax',want_manual,'taxUpdatedAt',coalesce(edited_at,now()));
   IF want_provisional THEN cost_doc:=cost_doc||'{"nasProvisionalTax":true}'::jsonb; END IF;$q$)
  ) AS patches(original,replacement) LOOP
   patch.original:=replace(patch.original,E'\r\n',E'\n');
   patch.replacement:=replace(patch.replacement,E'\r\n',E'\n');
   IF cardinality(string_to_array(definition,patch.original))<>2 THEN
    RAISE EXCEPTION '033 迁移与已安装的价格投影不匹配，请先核对 029/031';
   END IF;
   definition:=replace(definition,patch.original,patch.replacement);
  END LOOP;
  EXECUTE definition;
  EXECUTE $wrapper$
   CREATE OR REPLACE FUNCTION workbench_sources.project_with_tax_mode(
    entry_key text,target_shops text[],edited_at timestamptz,erp_name text DEFAULT NULL,
    manual_shops text[] DEFAULT ARRAY[]::text[],follow_shops text[] DEFAULT ARRAY[]::text[])
   RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $project$
   BEGIN
    PERFORM workbench_sources.project_with_tax_mode(entry_key,target_shops,edited_at,erp_name,manual_shops,follow_shops,ARRAY[]::text[]);
   END $project$
  $wrapper$;
 END IF;
 FOR patch IN SELECT * FROM (VALUES
  -- 已在隔离库安装过初版 033 时，也要升级七参数函数。旧成本可能没有手改标记。
  ('workbench_sources.project_with_tax_mode(text,text[],timestamptz,text,text[],text[],text[])',
   $q$current_manual := coalesce(cost_doc->'nasManualTax'='true'::jsonb,false);$q$,
   $q$current_manual := CASE WHEN jsonb_typeof(cost_doc->'nasManualTax')='boolean'
     THEN (cost_doc->>'nasManualTax')::boolean END;$q$),
  ('workbench_sources.project_with_tax_mode(text,text[],timestamptz,text,text[],text[],text[])',
   $q$   cost_doc:=(coalesce(cost_doc,$q$,
   $q$   -- 来源清理后可能留下旧暂代成本。重新观察 ERP 时先撤销旧暂代标记，
   -- 使 024 手改保护只拦截真正的人工改价。最终写入仍只递增一次版本。
   IF want_provisional AND cost_doc @> '{"nasProvisionalTax":true}' THEN
    EXECUTE format('UPDATE %I.intel_cost_overrides SET document=document-''nasProvisionalTax'' WHERE goodsid=$1',schema_name)
     USING entry_key;
   END IF;
   cost_doc:=(coalesce(cost_doc,$q$),
  ('workbench_sources.save(text,text,text,text,bigint,jsonb,text)',
   $q$ peer_doc jsonb; shared_manual_count integer;$q$,
   $q$ creation_tax_mode text; provisional_shops text[]:=ARRAY[]::text[];
 peer_doc jsonb; shared_manual_count integer;$q$),
  ('workbench_sources.save(text,text,text,text,bigint,jsonb,text)',
   $q$ entry.fields:=entry.fields||coalesce(edits->'shared'->'values','{}');$q$,
   $q$ -- 内部初价标记只用于本次创建，不属于目录字段。
 IF expected IS NULL THEN creation_tax_mode:=edits#>>'{shared,values,__creationTaxMode}'; END IF;
 edits:=edits#-'{shared,values,__creationTaxMode}';
 -- 同一店可能有多个历史别名，只去掉与旧共用名相同的覆盖。
 IF (edits->'shared'->'values') ? 'name' AND entry.fields->'name' IS DISTINCT FROM edits#>'{shared,values,name}' THEN
  UPDATE workbench_sources.aliases a SET fields=a.fields-'name',legacy=a.legacy-'name'
   WHERE a.entry_id=entry_key AND a.fields->'name'=entry.fields->'name';
 END IF;
 entry.fields:=entry.fields||coalesce(edits->'shared'->'values','{}');$q$),
  ('workbench_sources.save(text,text,text,text,bigint,jsonb,text)',
   $q$     IF jsonb_typeof(edits->'shared'->'values'->'tax')='number' THEN manual_shops:=array_append(manual_shops,target_shop);
     ELSE follow_shops:=array_append(follow_shops,target_shop); END IF;$q$,
   $q$     IF creation_tax_mode='default_erp' AND jsonb_typeof(common_tax)='number' THEN
      provisional_shops:=array_append(provisional_shops,target_shop);
      follow_shops:=array_append(follow_shops,target_shop);
     ELSIF jsonb_typeof(common_tax)='number' AND creation_tax_mode IS DISTINCT FROM 'default_table' THEN
      manual_shops:=array_append(manual_shops,target_shop);
     ELSE follow_shops:=array_append(follow_shops,target_shop); END IF;$q$),
  ('workbench_sources.save(text,text,text,text,bigint,jsonb,text)',
   $q$now(),erp_name,manual_shops,follow_shops);$q$,
   $q$now(),erp_name,manual_shops,follow_shops,provisional_shops);$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$  OR observation ? 'tableTax' AND$q$,
   $q$  OR observation ? 'taxOverride' AND (observation ? 'tableTax'
   OR jsonb_typeof(observation->'taxOverride') NOT IN ('null','number')
   OR (observation->>'taxOverride')::numeric NOT BETWEEN 0 AND 100000000)
  OR observation ? 'tableTax' AND$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$ IF coalesce(jsonb_typeof(tax_value),'')<>'number' AND coalesce(cost_doc->'nasManualTax','false')<>'true' THEN
  tax_value:=coalesce(observation->'tableTax',erp_value);
  cost_doc:=coalesce(cost_doc,'{}')||jsonb_build_object('goodsId',entry_key,'name',observation->'name',$q$,
   $q$ -- 单店新建在同一事务写入本店价格覆盖。已有来源的复用仍在此前直接返回。
 IF observation ? 'taxOverride' OR coalesce(jsonb_typeof(tax_value),'')<>'number' AND coalesce(cost_doc->'nasManualTax','false')<>'true' THEN
  tax_value:=coalesce(observation->'taxOverride',observation->'tableTax',erp_value);
  cost_doc:=(coalesce(cost_doc,'{}')-ARRAY['nasProvisionalTax','globalTax'])||jsonb_build_object(
   'goodsId',entry_key,'name',observation->'name','erpName',observation->'name',$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$   'nasTaxOverride',true,'nasProvisionalTax',NOT (observation ? 'tableTax') AND erp_value<>'null'::jsonb,'nasManualTax',false,'tax',tax_value);$q$,
   $q$   'nasTaxOverride',true,'nasManualTax',coalesce(jsonb_typeof(observation->'taxOverride')='number',false),'tax',tax_value);
  IF NOT (observation ?| ARRAY['tableTax','taxOverride']) AND erp_value<>'null'::jsonb THEN
   cost_doc:=cost_doc||'{"nasProvisionalTax":true}'::jsonb;
  END IF;
  IF observation ? 'taxOverride' THEN cost_doc:=cost_doc||jsonb_build_object('taxUpdatedAt',now()); END IF;$q$),
  ('workbench_sources.cost_sync_snapshot(text,text,text)',
   $q$CASE WHEN r.document ? 'erpCategory' THEN$q$,
   $q$jsonb_build_object('erpName',r.document->'erpName') ||
      CASE WHEN r.document ? 'erpCategory' THEN$q$),
  ('workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid)',
   $q$cost_data:=jsonb_build_object('erp',incoming->'erp','name',incoming->'name','sku',incoming->'sku'$q$,
   $q$cost_data:=jsonb_build_object('erp',incoming->'erp','name',incoming->'name','erpName',incoming->'name','sku',incoming->'sku'$q$)
 ) AS patches(signature,original,replacement) LOOP
  patch.original:=replace(patch.original,E'\r\n',E'\n');
  patch.replacement:=replace(patch.replacement,E'\r\n',E'\n');
  definition:=replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
  IF strpos(definition,patch.replacement)>0 THEN CONTINUE; END IF;
  IF cardinality(string_to_array(definition,patch.original))<>2 THEN
   RAISE EXCEPTION '033 迁移与已安装的 % 不匹配，请先核对 029/031',patch.signature;
  END IF;
  EXECUTE replace(definition,patch.original,patch.replacement);
 END LOOP;
END $migration$;
-- 同事务仅回读一个新商品在三店的价格及标志，沿用三店成本快照的权限与可见范围。
CREATE OR REPLACE FUNCTION workbench_sources.created_tax_modes(request_shop text, workspace text, actor text, goods text)
RETURNS TABLE(shop_id text,document jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $check$
BEGIN
 PERFORM workbench_sources.check_cost_sync_actor(request_shop,workspace,actor);
 RETURN QUERY SELECT s.shop,(SELECT jsonb_object_agg(k,v) FROM jsonb_each(r.document) AS field(k,v)
   WHERE k IN ('tax','nasManualTax','nasProvisionalTax'))
  FROM unnest(ARRAY['intel','gigabyte','jonsbo']) AS s(shop)
  CROSS JOIN LATERAL workbench_sources.sync_cost_rows(s.shop,ARRAY[goods]) r;
END $check$;
REVOKE ALL ON FUNCTION workbench_sources.created_tax_modes(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.created_tax_modes(text,text,text,text)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
REVOKE ALL ON FUNCTION workbench_sources.project_with_tax_mode(text,text[],timestamptz,text,text[],text[],text[]) FROM PUBLIC;
COMMIT;
