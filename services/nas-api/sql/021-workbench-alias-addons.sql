-- 三店加购文本候选：同一共用事务中保留每条历史来源自己的商品、数量和选配规则。
-- 先安装共用输出源 017；只增加受限函数，不改已有业务数据。
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench' OR to_regprocedure('workbench_sources.save(text,text,text,text,bigint,jsonb,text)') IS NULL
 THEN RAISE EXCEPTION '需要已安装共用输出源的三店正式结构'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
END $guard$;

-- 普通单店加购编辑明确建立单店文案；全局统一文案仍跟随共用顶层文本。
CREATE OR REPLACE FUNCTION workbench_sources.track_alias_addon_text() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $track$
BEGIN
 IF NEW.fields->'addonTextFollowShared'='true'::jsonb AND NEW.fields->'addon' IS DISTINCT FROM OLD.fields->'addon'
  AND coalesce(current_setting('workbench_sources.global_addon_text',true),'')<>'on'
 THEN NEW.fields:=NEW.fields-'addonTextFollowShared'; END IF;
 RETURN NEW;
END $track$;
DROP TRIGGER IF EXISTS track_alias_addon_text ON workbench_sources.aliases;
CREATE TRIGGER track_alias_addon_text BEFORE UPDATE ON workbench_sources.aliases
 FOR EACH ROW EXECUTE FUNCTION workbench_sources.track_alias_addon_text();
REVOKE ALL ON FUNCTION workbench_sources.track_alias_addon_text() FROM PUBLIC;

CREATE OR REPLACE FUNCTION workbench_sources.list(request_shop text, workspace text, actor text, only_id text)
 RETURNS TABLE(id text, version text, document jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $list$
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 RETURN QUERY
 WITH visible AS (
  SELECT e.entry_id, e.shop_id, jsonb_agg(jsonb_build_object(
   'sourceId',e.source_id,'fields',CASE WHEN e.fields->'addonTextFollowShared'='true'::jsonb THEN
      e.fields||jsonb_build_object('addon',coalesce(e.fields->'addon',entry.fields->'addon','{}'::jsonb)||
       jsonb_build_object('addonText',coalesce(entry.fields->'addon'->'addonText','""'::jsonb))) ELSE e.fields END,'legacy',e.legacy) ORDER BY e.source_id) AS aliases
  FROM workbench_sources.aliases e JOIN workbench_sources.entries entry ON entry.id=e.entry_id JOIN workbench_sources.operators o ON o.shop_id=e.shop_id
  WHERE o.workspace_id=workspace AND o.uid=actor AND (only_id IS NULL OR e.entry_id=only_id)
  GROUP BY e.entry_id,e.shop_id
 ), stores AS (
  SELECT v.entry_id,jsonb_object_agg(v.shop_id,v.aliases) AS aliases FROM visible v GROUP BY v.entry_id
 )
 SELECT e.id,e.version::text,jsonb_build_object('id',e.id,'common',e.fields,'stores',s.aliases)
 FROM workbench_sources.entries e JOIN stores s ON s.entry_id=e.id ORDER BY e.id;
END $list$;

CREATE OR REPLACE FUNCTION workbench_sources.project(entry_key text, target_shops text[], edited_at timestamptz, erp_name text DEFAULT NULL)
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
  FOR item IN SELECT a.source_id,e.fields||(CASE WHEN a.fields->'addonTextFollowShared'='true'::jsonb THEN
    a.fields||jsonb_build_object('addon',coalesce(a.fields->'addon',e.fields->'addon','{}'::jsonb)||
      jsonb_build_object('addonText',coalesce(e.fields->'addon'->'addonText','""'::jsonb))) ELSE a.fields END) AS fields FROM workbench_sources.aliases a
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

CREATE OR REPLACE FUNCTION workbench_sources.save_aliases(request_shop text, workspace text, actor text, entry_key text,
 expected bigint, edits jsonb, alias_edits jsonb) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $aliases$
DECLARE scope record; alias record; result text; prior_setting text:=current_setting('workbench_sources.global_addon_text',true);
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) OR
  (SELECT count(DISTINCT shop_id) FROM workbench_sources.operators WHERE workspace_id=workspace AND uid=actor)<>3
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 IF expected IS NULL OR NOT edits?'shared' OR jsonb_typeof(alias_edits) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 -- 原函数继续核验条目版本与授权，变更和别名修正仍在本事务一次提交。
 result:=workbench_sources.save(request_shop,workspace,actor,entry_key,expected,edits,NULL);
 PERFORM set_config('workbench_sources.global_addon_text','on',true);
 FOR scope IN SELECT key,value FROM jsonb_each(alias_edits) LOOP
  IF scope.key NOT IN ('intel','gigabyte','jonsbo') OR jsonb_typeof(scope.value) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
  FOR alias IN SELECT key,value FROM jsonb_each(scope.value) LOOP
   IF jsonb_typeof(alias.value) IS DISTINCT FROM 'object' OR jsonb_typeof(alias.value->'addon') IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(alias.value))<>1
   THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
   -- 原来没有单店加购覆盖的来源继续继承共用商品、数量和规则，不能因统一文案创建新的财务覆盖。
   UPDATE workbench_sources.aliases a SET fields=a.fields||CASE WHEN a.fields?'addon'
     THEN jsonb_build_object('addon',alias.value->'addon','addonTextFollowShared',true)
     ELSE jsonb_build_object('addonTextFollowShared',true) END,legacy=a.legacy-'addon'
    FROM workbench_sources.entries e WHERE a.entry_id=entry_key AND e.id=a.entry_id AND a.shop_id=scope.key AND a.source_id=alias.key
    AND ((alias.value->'addon')-'addonText') IS NOT DISTINCT FROM (coalesce(a.fields->'addon',e.fields->'addon','{}'::jsonb)-'addonText');
   IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
  END LOOP;
 END LOOP;
 PERFORM workbench_sources.project(entry_key,ARRAY['intel','gigabyte','jonsbo'],now());
 PERFORM set_config('workbench_sources.global_addon_text',coalesce(prior_setting,''),true);
 RETURN result;
END $aliases$;

CREATE OR REPLACE FUNCTION workbench_sources.source_versions(request_shop text, workspace text, actor text, entry_key text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $versions$
DECLARE shop text; rows jsonb; result jsonb:='{}';
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) OR
  (SELECT count(DISTINCT shop_id) FROM workbench_sources.operators WHERE workspace_id=workspace AND uid=actor)<>3
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_object_agg(s.source_id,s.version::text),''{}'') FROM %I.sources s
   JOIN workbench_sources.aliases a ON a.shop_id=$1 AND a.source_id=s.source_id WHERE a.entry_id=$2',shop||'_live')
   INTO rows USING shop,entry_key;
  result:=result||jsonb_build_object(shop,rows);
 END LOOP;
 RETURN result;
END $versions$;
REVOKE ALL ON FUNCTION workbench_sources.save_aliases(text,text,text,text,bigint,jsonb,jsonb),
 workbench_sources.source_versions(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.save_aliases(text,text,text,text,bigint,jsonb,jsonb),
 workbench_sources.source_versions(text,text,text,text)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
COMMIT;
