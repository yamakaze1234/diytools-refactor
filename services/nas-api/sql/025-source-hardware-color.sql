-- 配件颜色随共用来源投影。先移除旧人工颜色，再按本次有效字段写入；空值恢复自动识别。
-- 沿用 021 对独立加购和单店核算价的投影规则，不改既有来源正文。
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench' OR
  to_regprocedure('workbench_sources.project(text,text[],timestamp with time zone,text)') IS NULL
 THEN RAISE EXCEPTION '需要已安装的共用输出源结构'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
END $guard$;

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
    hardware:=(coalesce(nullif(attrs->'hardwareOverrides','null'::jsonb),'{}')-ARRAY['cpuName','gpuName','boardType','caseBoards','color'])||coalesce(hardware,'{}');
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

COMMIT;
