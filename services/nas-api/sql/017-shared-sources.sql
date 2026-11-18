-- 与 install-shared-sources.mjs 在同一事务中运行。原来源主键仍用于配置、加购和模板。
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench' THEN RAISE EXCEPTION '需要三店工作台数据库'; END IF;
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 IF to_regclass('workbench_sources.entries') IS NOT NULL THEN RAISE EXCEPTION '共用输出源已安装'; END IF;
END $guard$;

CREATE SCHEMA workbench_sources;
REVOKE ALL ON SCHEMA workbench_sources FROM PUBLIC;
CREATE TABLE workbench_sources.entries(
 id text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{0,19}$|^special:[0-9a-f-]{32,36}$'),
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'),
 version bigint NOT NULL DEFAULT 1 CHECK (version>0)
);
CREATE TABLE workbench_sources.aliases(
 entry_id text NOT NULL REFERENCES workbench_sources.entries,
 shop_id text NOT NULL CHECK(shop_id IN ('intel','gigabyte','jonsbo')),
 source_id text NOT NULL,
 fields jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(fields)='object'),
 legacy jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(legacy)='array'),
 PRIMARY KEY(shop_id,source_id)
);
CREATE INDEX shared_sources_aliases_entry ON workbench_sources.aliases(entry_id,shop_id,source_id);

CREATE VIEW workbench_sources.operators AS
 SELECT workspace_id,uid,shop_id FROM intel_access.shop_roles WHERE role='operations'
 UNION ALL SELECT workspace_id,uid,shop_id FROM gigabyte_access.shop_roles WHERE role='operations'
 UNION ALL SELECT workspace_id,uid,shop_id FROM jonsbo_access.shop_roles WHERE role='operations';

-- 管理员迁移读取活动来源及其实际核算价。成本源存在时，NULL 是原值。
CREATE FUNCTION workbench_sources.snapshot() RETURNS TABLE(shop_id text, source_id text, source_version text,
 cost_edited boolean, document jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $snap$
DECLARE shop text;
BEGIN
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  RETURN QUERY EXECUTE format($query$
   SELECT $1, s.source_id, s.version::text, o.goodsid IS NOT NULL,
    s.attrs||jsonb_build_object('sourceId',s.source_id,'goodsId',s.goodsid,'name',s.name,
     'tax',CASE WHEN o.goodsid IS NOT NULL THEN o.document->'tax'
                WHEN c.goodsid IS NOT NULL THEN to_jsonb(c.tax) ELSE s.attrs->'tax' END)
   FROM %1$I.sources s LEFT JOIN %1$I.costs c USING(goodsid)
    LEFT JOIN %1$I.intel_cost_overrides o USING(goodsid)
   WHERE (s.owner_shop=$1 OR s.owner_shop='shared' OR s.shared) AND s.attrs->>'deletedAt' IS NULL
   ORDER BY s.source_id
  $query$,shop||'_live') USING shop;
 END LOOP;
END $snap$;

CREATE FUNCTION workbench_sources.allowed(request_shop text, workspace text, actor text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $allow$
 SELECT coalesce(nullif(current_setting('role',true),'none'),session_user::text) =
   'diy_api_'||request_shop||'_production'
  AND EXISTS (SELECT 1 FROM workbench_sources.operators o WHERE (o.workspace_id,o.uid,o.shop_id)=($2,$3,$1))
$allow$;

CREATE FUNCTION workbench_sources.list(request_shop text, workspace text, actor text, only_id text)
 RETURNS TABLE(id text, version text, document jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $list$
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 RETURN QUERY
 WITH visible AS (
  SELECT e.entry_id, e.shop_id, jsonb_agg(jsonb_build_object(
   'sourceId',e.source_id,'fields',e.fields,'legacy',e.legacy) ORDER BY e.source_id) AS aliases
  FROM workbench_sources.aliases e JOIN workbench_sources.operators o ON o.shop_id=e.shop_id
  WHERE o.workspace_id=workspace AND o.uid=actor AND (only_id IS NULL OR e.entry_id=only_id)
  GROUP BY e.entry_id,e.shop_id
 ), stores AS (
  SELECT v.entry_id,jsonb_object_agg(v.shop_id,v.aliases) AS aliases FROM visible v GROUP BY v.entry_id
 )
 SELECT e.id,e.version::text,jsonb_build_object('id',e.id,'common',e.fields,'stores',s.aliases)
 FROM workbench_sources.entries e JOIN stores s ON s.entry_id=e.id ORDER BY e.id;
END $list$;

-- 仅内部调用。每家店继续使用自己的源行和成本覆盖，投影只写本次范围的有效值。
CREATE FUNCTION workbench_sources.project(entry_key text, target_shops text[], edited_at timestamptz, erp_name text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $project$
DECLARE
 shop text; schema_name text; item record; special boolean := entry_key LIKE 'special:%';
 effective_fields jsonb; current_name text; attrs jsonb; next_attrs jsonb; addon jsonb;
 caps jsonb; hardware jsonb; override_tax jsonb; tax_count integer; cost_doc jsonb; cost_version bigint;
 addon_keys text[] := ARRAY['addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems',
  'addonOriginalQty','addonVariants','addonShowTogether','addonChoices','addonMode'];
BEGIN
 FOREACH shop IN ARRAY target_shops LOOP
  schema_name := shop||'_live';
  FOR item IN SELECT a.source_id,e.fields||a.fields AS fields FROM workbench_sources.aliases a
   JOIN workbench_sources.entries e ON e.id=a.entry_id WHERE a.entry_id=entry_key AND a.shop_id=shop
  LOOP
   effective_fields := item.fields;
   EXECUTE format('SELECT name,attrs FROM %I.sources WHERE source_id=$1',schema_name)
    INTO current_name,attrs USING item.source_id;
   current_name := coalesce(effective_fields->>'name',current_name,'展示名称待确认');
   next_attrs := coalesce(attrs,'{}')-addon_keys-ARRAY['capacityOverrides','hardwareOverrides'];
   SELECT jsonb_object_agg(key,value) INTO addon FROM jsonb_each(coalesce(effective_fields->'addon','{}')) WHERE key=ANY(addon_keys);
   next_attrs := next_attrs||coalesce(addon,'{}')||jsonb_build_object('shopId',shop,'sharedSourceId',entry_key);
   IF special THEN
    next_attrs := next_attrs||jsonb_build_object('specialComponent',true,'erp',0,'tax',0);
   ELSE
    IF effective_fields ? 'tax' THEN
     next_attrs := next_attrs||jsonb_build_object('tax',effective_fields->'tax');
    END IF;
    SELECT jsonb_object_agg(split_part(key,'.',2),value) INTO caps
     FROM jsonb_each(effective_fields) WHERE key LIKE 'capacityOverrides.%' AND value<>'null'::jsonb;
    SELECT jsonb_object_agg(split_part(key,'.',2),value) INTO hardware
     FROM jsonb_each(effective_fields) WHERE key LIKE 'hardwareOverrides.%' AND value<>'null'::jsonb;
    caps:=(coalesce(nullif(attrs->'capacityOverrides','null'::jsonb),'{}')-ARRAY['memoryGb','vramGb','storageGb'])||coalesce(caps,'{}');
    hardware:=(coalesce(nullif(attrs->'hardwareOverrides','null'::jsonb),'{}')-ARRAY['cpuName','gpuName','boardType','caseBoards'])||coalesce(hardware,'{}');
    IF caps<>'{}' THEN next_attrs:=next_attrs||jsonb_build_object('capacityOverrides',caps); END IF;
    IF hardware<>'{}' THEN next_attrs:=next_attrs||jsonb_build_object('hardwareOverrides',hardware); END IF;
    IF attrs IS NULL AND erp_name IS NOT NULL THEN next_attrs:=next_attrs||jsonb_build_object('erpName',erp_name); END IF;
   END IF;
   IF attrs IS NULL THEN
    EXECUTE format('INSERT INTO %I.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES($1,$2,false,$3,$4,$5)',schema_name)
     USING item.source_id,shop,CASE WHEN special THEN '' ELSE entry_key END,current_name,next_attrs;
   ELSE
    EXECUTE format($update$UPDATE %I.sources SET name=$2,
     attrs=$3||CASE WHEN $4::timestamptz IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updatedAt',$4) END,
     version=version+1 WHERE source_id=$1 AND (name IS DISTINCT FROM $2 OR attrs IS DISTINCT FROM $3)$update$,schema_name)
     USING item.source_id,current_name,next_attrs,edited_at;
   END IF;
  END LOOP;
  IF special THEN CONTINUE; END IF;
  -- 同店若有多个不同历史值，保留在旧来源行。等维护人员选择店铺核算价后再设置唯一成本。
  SELECT count(DISTINCT (e.fields||a.fields)->'tax'), (jsonb_agg(DISTINCT (e.fields||a.fields)->'tax')->0)
   INTO tax_count,override_tax FROM workbench_sources.aliases a JOIN workbench_sources.entries e ON e.id=a.entry_id
   WHERE a.entry_id=entry_key AND a.shop_id=shop AND (e.fields||a.fields) ? 'tax';
  IF tax_count<>1 THEN CONTINUE; END IF;
  EXECUTE format($cost$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)),
    coalesce(o.version,c.version) FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
    WHERE goodsid=$1$cost$,schema_name) INTO cost_doc,cost_version USING entry_key;
  IF cost_doc->'tax' IS NOT DISTINCT FROM override_tax OR cost_doc IS NULL AND override_tax='null'::jsonb THEN CONTINUE; END IF;
  cost_doc:=coalesce(cost_doc,jsonb_build_object('goodsId',entry_key,'name',current_name,'erp',null))||
   jsonb_build_object('tax',override_tax,'nasTaxOverride',true,'taxUpdatedAt',coalesce(edited_at,now()));
  EXECUTE format($upsert$INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
   ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version$upsert$,schema_name)
   USING entry_key,cost_doc,coalesce(cost_version,0)+1;
 END LOOP;
END $project$;

CREATE FUNCTION workbench_sources.save(request_shop text, workspace text, actor text, entry_key text,
 expected bigint, edits jsonb, erp_name text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $save$
DECLARE entry workbench_sources.entries%ROWTYPE; change record; restored text[]; changed text[]; allowed_shops text[];
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 SELECT array_agg(o.shop_id ORDER BY o.shop_id) INTO allowed_shops FROM workbench_sources.operators o
  WHERE o.workspace_id=workspace AND o.uid=actor;
 FOR change IN SELECT key,value FROM jsonb_each(edits) LOOP
  IF change.key='shared' AND cardinality(allowed_shops)<>3
   OR change.key<>'shared' AND NOT (change.key=ANY(allowed_shops))
  THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 END LOOP;
 SELECT * INTO entry FROM workbench_sources.entries e WHERE e.id=entry_key FOR UPDATE;
 IF expected IS NULL THEN
  IF FOUND OR entry_key LIKE 'special:%' AND EXISTS (
    SELECT 1 FROM workbench_sources.entries e WHERE e.id LIKE 'special:%' AND e.fields->'name'=edits->'shared'->'values'->'name')
  THEN RAISE EXCEPTION USING MESSAGE='CATALOG_EXISTS'; END IF;
  IF cardinality(allowed_shops)<>3 OR NOT (edits ? 'shared') THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
  INSERT INTO workbench_sources.entries(id,fields) VALUES(entry_key,'{}') RETURNING * INTO entry;
  INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id)
   SELECT entry_key,shop,'shared-src:'||entry_key FROM unnest(allowed_shops) shop;
 ELSIF entry.version IS DISTINCT FROM expected THEN
  RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT';
 END IF;
 entry.fields:=entry.fields||coalesce(edits->'shared'->'values','{}');
 UPDATE workbench_sources.entries SET fields=entry.fields, version=entry.version+CASE WHEN expected IS NULL THEN 0 ELSE 1 END
  WHERE id=entry_key RETURNING version INTO entry.version;
 FOR change IN SELECT key,value FROM jsonb_each(edits) WHERE key<>'shared' LOOP
  restored:=ARRAY(SELECT jsonb_array_elements_text(coalesce(change.value->'restore','[]')));
  IF NOT (entry.fields ?& restored) THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
  changed:=restored||ARRAY(SELECT jsonb_object_keys(change.value->'values'));
  UPDATE workbench_sources.aliases a SET fields=(a.fields-restored)||change.value->'values', legacy=a.legacy-changed
   WHERE a.entry_id=entry_key AND a.shop_id=change.key;
 END LOOP;
 PERFORM workbench_sources.project(entry_key,CASE WHEN edits ? 'shared' THEN ARRAY['intel','gigabyte','jonsbo']
  ELSE ARRAY(SELECT jsonb_object_keys(edits)) END,now(),erp_name);
 RETURN entry.version::text;
END $save$;

-- 其他成本维护入口按原先的单店范围更新；共用价仍可通过“恢复共用”重新继承。
CREATE FUNCTION workbench_sources.note_tax(request_shop text, workspace text, actor text, entry_key text, tax jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $tax$
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 UPDATE workbench_sources.entries SET version=version+1 WHERE id=entry_key;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE workbench_sources.aliases SET fields=fields||jsonb_build_object('tax',tax),legacy=legacy-'tax'
  WHERE entry_id=entry_key AND shop_id=request_shop;
 PERFORM workbench_sources.project(entry_key,ARRAY[request_shop],now());
END $tax$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA workbench_sources FROM PUBLIC;
GRANT USAGE ON SCHEMA workbench_sources TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
GRANT EXECUTE ON FUNCTION workbench_sources.list(text,text,text,text),
 workbench_sources.save(text,text,text,text,bigint,jsonb,text),workbench_sources.note_tax(text,text,text,text,jsonb)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;

DO $receipts$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['intel_live','gigabyte_live','jonsbo_live'] LOOP
  EXECUTE format('ALTER TABLE %I.catalog_receipts DROP CONSTRAINT catalog_receipts_kind_check,
   ADD CONSTRAINT catalog_receipts_kind_check CHECK(kind IN (''sources'',''addons'',''gallery'',''templates'',''assets'',''shared-sources''))',target);
 END LOOP;
END $receipts$;
