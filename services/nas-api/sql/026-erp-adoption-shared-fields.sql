-- 在已安装的 ERP 建源流程中继承共用属性，保留历史来源及各店核算价。
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench' OR
  to_regprocedure('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)') IS NULL
 THEN RAISE EXCEPTION '需要已安装 024 ERP 建源函数'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION workbench_sources.adopt_erp(request_shop text, workspace text, actor text,
 entry_key text, shown_name text, observation jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $adopt$
DECLARE
 schema_name text; source_key text; existing_key text; entry_version bigint;
 common_fields jsonb; caps jsonb; hardware jsonb; addon jsonb;
 addon_keys text[] := ARRAY['addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems',
  'addonOriginalQty','addonVariants','addonShowTogether','addonChoices','addonMode'];
 cost_doc jsonb; cost_version bigint; erp_value jsonb; tax_value jsonb;
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 IF request_shop NOT IN ('intel','gigabyte','jonsbo') OR entry_key !~ '^[1-9][0-9]{0,19}$'
  OR shown_name IS NULL OR btrim(shown_name)='' OR length(shown_name)>512 OR shown_name ~ '[*＊]'
  OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
  OR coalesce(observation->>'name','')='' OR length(observation->>'name')>512 OR observation->>'name' ~ '[*＊]'
  OR coalesce(jsonb_typeof(observation->'erp'),'') NOT IN ('null','number')
  OR coalesce(jsonb_typeof(observation->'stockAvailable'),'') NOT IN ('null','number')
  OR (observation->>'erp')::numeric<0 OR (observation->>'erp')::numeric>100000000
  OR observation ? 'tableTax' AND (jsonb_typeof(observation->'tableTax') IS DISTINCT FROM 'number'
   OR (observation->>'tableTax')::numeric<0 OR (observation->>'tableTax')::numeric>100000000)
 THEN RAISE EXCEPTION USING MESSAGE='VALIDATION_FAILED'; END IF;
 schema_name:=request_shop||'_live';
 -- 已有源只回读，不碰名称、成本与手工定价。
 EXECUTE format('SELECT source_id FROM %I.sources WHERE owner_shop=$1 AND NOT shared AND goodsid=$2
  AND attrs->>''deletedAt'' IS NULL ORDER BY source_id LIMIT 1',schema_name)
  INTO existing_key USING request_shop,entry_key;
 IF existing_key IS NOT NULL THEN
  SELECT version INTO entry_version FROM workbench_sources.entries WHERE id=entry_key;
  RETURN jsonb_build_object('id',entry_key,'sourceId',existing_key,'version',coalesce(entry_version,1)::text,'reused',true);
 END IF;
 source_key:='erp:'||request_shop||':'||entry_key;
 EXECUTE format('SELECT source_id FROM %I.sources WHERE source_id=$1',schema_name) INTO existing_key USING source_key;
 IF existing_key IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='ERP_SOURCE_ARCHIVED'; END IF;
 -- 共用身份只有一条，新增的别名及配件只属于当前店，已有共用字段继续有效。
 INSERT INTO workbench_sources.entries(id,fields) VALUES(entry_key,jsonb_build_object('name',shown_name)) ON CONFLICT DO NOTHING;
 SELECT fields INTO common_fields FROM workbench_sources.entries WHERE id=entry_key FOR UPDATE;
 EXECUTE format($cost$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)),
    coalesce(o.version,c.version) FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
    WHERE goodsid=$1$cost$,schema_name) INTO cost_doc,cost_version USING entry_key;
 erp_value:=observation->'erp';
 tax_value:=cost_doc->'tax';
 IF coalesce(jsonb_typeof(tax_value),'')<>'number' AND coalesce(cost_doc->'nasManualTax','false')<>'true' THEN
  tax_value:=coalesce(observation->'tableTax',erp_value);
  cost_doc:=coalesce(cost_doc,'{}')||jsonb_build_object('goodsId',entry_key,'name',observation->'name',
   'erp',erp_value,'sku',coalesce(observation->>'sku',''),'stockAvailable',observation->'stockAvailable',
   'stockUpdatedAt',now(),'erpMissing',false,'erpUnknown',erp_value='null'::jsonb,'nasErpOverride',true,
   'nasTaxOverride',true,'nasProvisionalTax',NOT (observation ? 'tableTax') AND erp_value<>'null'::jsonb,'nasManualTax',false,'tax',tax_value);
  EXECUTE format($upsert$INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
   ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version$upsert$,schema_name)
   USING entry_key,cost_doc,coalesce(cost_version,0)+1;
 END IF;
 INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id,fields)
  VALUES(entry_key,request_shop,source_key,jsonb_build_object('name',shown_name,'tax',tax_value));
 -- 首次写入只继承共用配件属性，沿用当前店的 ERP 观察与核算价，避免二次写入成本。
 SELECT jsonb_object_agg(key,value) INTO addon
  FROM jsonb_each(coalesce(nullif(common_fields->'addon','null'::jsonb),'{}')) WHERE key=ANY(addon_keys);
 SELECT jsonb_object_agg(split_part(key,'.',2),value) FILTER (WHERE key LIKE 'capacityOverrides.%'),
        jsonb_object_agg(split_part(key,'.',2),value) FILTER (WHERE key LIKE 'hardwareOverrides.%')
  INTO caps,hardware FROM jsonb_each(common_fields) WHERE value<>'null'::jsonb;
 EXECUTE format('INSERT INTO %I.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES($1,$2,false,$3,$4,$5)',schema_name)
  USING source_key,request_shop,entry_key,shown_name,jsonb_build_object('shopId',request_shop,'sharedSourceId',entry_key,
   'name',shown_name,'erpName',observation->'name','erp',erp_value,'tax',tax_value,'createdFrom','erp','createdAt',now())
   ||coalesce(addon,'{}')||jsonb_strip_nulls(jsonb_build_object('capacityOverrides',caps,'hardwareOverrides',hardware));
 UPDATE workbench_sources.entries SET version=version+1 WHERE id=entry_key RETURNING version INTO entry_version;
 RETURN jsonb_build_object('id',entry_key,'sourceId',source_key,'version',entry_version::text,'reused',false);
END $adopt$;
COMMIT;
